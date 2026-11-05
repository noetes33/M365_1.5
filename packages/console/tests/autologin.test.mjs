import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,existsSync,statSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const data=mkdtempSync(join(tmpdir(),'m365-auto-login-'));
const cli=join(ROOT,'scripts','account-credentials.mjs');
const pw='AnotherStrongAdminPassword123!';
let server,base,cookie,csrf,idA,idB,port;
const cliRun=(action,id,payload)=>spawnSync(process.execPath,[cli,action,id],{encoding:'utf8',input:payload===undefined?'':JSON.stringify(payload),env:{...process.env,M365_ADMIN_DATA:data}});
async function freePort(){const s=http.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const n=s.address().port;await new Promise(r=>s.close(r));return n;}
async function api(route,method='GET',payload,auth=true){const r=await fetch(base+'/admin/api'+route,{method,headers:{...(auth?{Cookie:cookie,...(method==='GET'?{}:{'X-CSRF-Token':csrf})}:{}),...(payload!==undefined?{'Content-Type':'application/json'}:{})},body:payload===undefined?undefined:JSON.stringify(payload)});const body=await r.json();return {code:r.status,body};}
before(async()=>{
  port=await freePort();base='http://127.0.0.1:'+port;
  server=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env:{...process.env,M365_ADMIN_PORT:String(port),M365_ADMIN_DATA:data,M365_ADMIN_PASSWORD:pw,M365_CONSOLE_TEST_PROVIDER:join(ROOT,'tests','mock-account-provider.mjs')},stdio:['ignore','pipe','pipe']});
  let errors='';server.stderr.on('data',c=>errors+=c);
  for(let i=0;i<150;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}if(server.exitCode!==null)throw Error(errors);await new Promise(r=>setTimeout(r,40));}
  const r=await fetch(base+'/admin/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@local',password:pw})});
  assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];csrf=(await r.json()).csrf;
  const a=await api('/accounts','POST',{label:'Automated A',runtime_type:'isolated',email_hint:'alice@example.edu'});assert.equal(a.code,201);idA=a.body.data.id;
  const b=await api('/accounts','POST',{label:'Automated B',runtime_type:'isolated',email_hint:'bob@example.edu'});assert.equal(b.code,201);idB=b.body.data.id;
});
after(()=>{server?.kill();rmSync(data,{recursive:true,force:true});});
test('does not permit automated login without locally installed credentials',async()=>{
  const response=await api('/accounts/'+idA+'/auto-login','POST',{});
  assert.equal(response.code,409);
  assert.equal((await api('/accounts/'+idA+'/auto-login','POST',{},false)).code,401);
  assert.equal((await api('/accounts/'+idA+'/status')).body.data.autoLoginConfigured,false);
});
test('local CLI rejects a six digit code, wrong IDs and invalid input',()=>{
  assert.notEqual(cliRun('set',idA,{password:'Password1!',mfaSecret:'123456'}).status,0);
  assert.notEqual(cliRun('set','../../invalid',{password:'Password1!',mfaSecret:'JBSWY3DPEHPK3PXP'}).status,0);
  assert.equal(cliRun('status',idA).status,0);
});
test('local CLI isolates the configured credentials and never displays them',async()=>{
  const a=cliRun('set',idA,{password:'TEST_PW_A_does_not_leave_server',mfaSecret:'JBSWY3DPEHPK3PXP'});
  const b=cliRun('set',idB,{password:'TEST_PW_B_does_not_leave_server',mfaSecret:'JBSWY3DPEHPK3PXP'});
  assert.equal(a.status,0,a.stderr);assert.equal(b.status,0,b.stderr);
  for(const result of [a,b]){assert.equal(result.stdout.includes('TEST_PW_'),false);assert.equal(result.stderr.includes('JBSWY'),false);}
  const aPath=join(data,'identity-profiles',idA,'secrets.json');
  const bPath=join(data,'identity-profiles',idB,'secrets.json');
  assert.equal(existsSync(aPath),true);assert.equal(existsSync(bPath),true);
  const aa=JSON.parse(readFileSync(aPath,'utf8')),bb=JSON.parse(readFileSync(bPath,'utf8'));
  assert.equal(aa.email,'alice@example.edu');assert.equal(bb.email,'bob@example.edu');
  assert.equal(aa.password.includes('B_'),false);assert.equal(bb.password.includes('A_'),false);
  if(process.platform!=='win32')assert.equal(statSync(aPath).mode&0o777,0o600);
  const list=await api('/accounts');
  assert.equal(list.code,200);
  assert.equal(list.body.data.find(x=>x.id===idA).auth.autoLoginConfigured,true);
  assert.equal(JSON.stringify(list.body).includes('TEST_PW_'),false);
});
test('admin can trigger headless authentication using existing isolated account worker',async()=>{
  const r=await api('/accounts/'+idA+'/auto-login','POST',{});
  assert.equal(r.code,202);
  for(let t=0;t<100;t++){
    const s=(await api('/accounts/'+idA+'/status')).body.data;
    if(s.state==='authorized')break;
    if(t===99)assert.fail('Worker did not authorize mock identity');
    await new Promise(r=>setTimeout(r,40));
  }
  const audit=await api('/audit');
  assert.equal(JSON.stringify(audit.body).includes('TEST_PW_'),false);
  assert.equal(audit.body.data.some(x=>x.action==='accounts.auto_login'),true);
});
test('removing stored credentials disables unattended relogin but retains existing authorization cache',async()=>{
  const r=cliRun('remove',idA);assert.equal(r.status,0);
  const s=(await api('/accounts/'+idA+'/status')).body.data;
  assert.equal(s.autoLoginConfigured,false);
  assert.equal(existsSync(join(data,'identity-profiles',idA,'msal-cache.json')),true);
  assert.equal(existsSync(join(data,'identity-profiles',idB,'secrets.json')),true);
});
test('after service restart, configured account attempts automatic login once (mock provider)',async()=>{
  // Only Bob retains an auto-login secret after Alice was disabled.
  assert.equal(existsSync(join(data,'identity-profiles',idB,'secrets.json')),true);
  const s0=(await api('/accounts/'+idB+'/status')).body.data;
  assert.notEqual(s0.state,'authorized');
  await new Promise(resolve=>{server.once('exit',resolve);server.kill();});
  server=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env:{...process.env,M365_ADMIN_PORT:String(port),M365_ADMIN_DATA:data,M365_ADMIN_PASSWORD:pw,M365_CONSOLE_TEST_PROVIDER:join(ROOT,'tests','mock-account-provider.mjs')},stdio:['ignore','pipe','pipe']});
  let err='';server.stderr.on('data',c=>err+=c);
  for(let t=0;t<150;t++){
    try{const s=await api('/accounts/'+idB+'/status');if(s.code===200&&s.body.data.state==='authorized')return;}catch{}
    if(server.exitCode!==null)assert.fail('Restart exited unexpectedly: '+err);
    await new Promise(r=>setTimeout(r,40));
  }
  assert.fail('configured account did not re-authorize on restart');
});
