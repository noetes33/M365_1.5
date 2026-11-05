import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import {readCredentials} from '../credential-vault.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const data=mkdtempSync(join(tmpdir(),'m365-web-credentials-'));
const adminPassword='StrongAdminPasswordForWeb123!';
let server,base,cookie,csrf,id;
async function freePort(){const s=http.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function api(route,method='GET',payload,auth=true,https=false){const r=await fetch(base+'/admin/api'+route,{method,headers:{...(auth?{Cookie:cookie,...(method==='GET'?{}:{'X-CSRF-Token':csrf})}:{}),...(payload!==undefined?{'Content-Type':'application/json'}:{}),...(https?{'X-Forwarded-Proto':'https'}:{})},body:payload===undefined?undefined:JSON.stringify(payload)});const data=await r.json();return {status:r.status,data};}
before(async()=>{
 const port=await freePort();base='http://127.0.0.1:'+port;
 server=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,M365_ADMIN_PORT:String(port),M365_ADMIN_DATA:data,M365_ADMIN_PASSWORD:adminPassword,M365_CONSOLE_TEST_PROVIDER:join(root,'tests','mock-account-provider.mjs'),M365_CONSOLE_REQUIRE_AUTOCREDS:'1'},stdio:['ignore','pipe','pipe']});
 let error='';server.stderr.on('data',c=>error+=c);
 for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}if(server.exitCode!==null)throw Error(error);await new Promise(r=>setTimeout(r,40));}
 const login=await fetch(base+'/admin/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@local',password:adminPassword})});
 assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];csrf=(await login.json()).csrf;
 const r=await api('/accounts','POST',{label:'My School Test Account',runtime_type:'isolated',email_hint:'owner@example.edu'});
 assert.equal(r.status,201);id=r.data.data.id;
});
after(async()=>{server?.kill();await new Promise(r=>setTimeout(r,100));rmSync(data,{recursive:true,force:true});});
test('credential writes require HTTPS, session, CSRF, and administrator password',async()=>{
 const payload={password:'ThisIsNotARealMicrosoftPassword!',mfaSecret:'JBSWY3DPEHPK3PXP',admin_password:adminPassword};
 assert.equal((await api('/accounts/'+id+'/credentials','PUT',payload,true,false)).status,403);
 assert.equal((await api('/accounts/'+id+'/credentials','PUT',payload,false,true)).status,401);
 const wrong=await api('/accounts/'+id+'/credentials','PUT',{...payload,admin_password:'incorrect'},true,true);
 assert.equal(wrong.status,403);
 const invalid=await api('/accounts/'+id+'/credentials','PUT',{...payload,mfaSecret:'123456'},true,true);
 assert.equal(invalid.status,400);
});
test('web credentials are encrypted at rest, never listed in admin responses or audit',async()=>{
 const password='TEST-Secret-NotARealMicrosoftPassword9876!';
 const seed='JBSWY3DPEHPK3PXP';
 const r=await api('/accounts/'+id+'/credentials','PUT',{password,mfaSecret:seed,admin_password:adminPassword},true,true);
 assert.equal(r.status,200,JSON.stringify(r.data));
 const f=join(data,'identity-profiles',id,'credentials.enc');
 assert.equal(existsSync(f),true);
 const stored=readFileSync(f,'utf8');assert.doesNotMatch(stored,/TEST-Secret|JBSWY3DPEHPK3PXP/);
 assert.equal(existsSync(join(data,'identity-profiles',id,'secrets.json')),false);
 assert.equal(readCredentials(data,id).password,password);
 if(process.platform!=='win32')assert.equal(statSync(f).mode&0o777,0o600);
 for(const endpoint of ['/accounts','/accounts/'+id+'/status','/audit']){
   const response=await api(endpoint);
   assert.equal(response.status,200);
   assert.doesNotMatch(JSON.stringify(response.data),/TEST-Secret|JBSWY3DPEHPK3PXP/);
 }
 assert.equal((await api('/accounts/'+id+'/status')).data.data.autoLoginConfigured,true);
});
test('web-configured account can trigger its isolated upstream login and recover',async()=>{
 const started=await api('/accounts/'+id+'/auto-login','POST',{});assert.equal(started.status,202);
 for(let i=0;i<100;i++){
  const s=(await api('/accounts/'+id+'/status')).data.data;
  if(s.state==='authorized')return;
  if(i===99)assert.fail('Simulated authorization timed out');
  await new Promise(r=>setTimeout(r,40));
 }
});
test('removing web credentials retains cached login but disables future automatic login',async()=>{
 const r=await api('/accounts/'+id+'/credentials','DELETE',{admin_password:adminPassword},true,true);
 assert.equal(r.status,200);
 assert.equal(existsSync(join(data,'identity-profiles',id,'credentials.enc')),false);
 assert.equal((await api('/accounts/'+id+'/status')).data.data.autoLoginConfigured,false);
 assert.equal(existsSync(join(data,'identity-profiles',id,'msal-cache.json')),true);
});
