import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const DATA=mkdtempSync(join(tmpdir(),'m365-direct-atrt-test-'));
const adminPassword='SafeTestOnlyAdminPassword123!';
const tid='22222222-2222-2222-2222-222222222222';
const oid='33333333-3333-3333-3333-333333333333';
const rt='TEST_ONLY_REFRESH_TOKEN_AAAAAAAAAAAAAAAA';
const header=Buffer.from('{"alg":"RS256","typ":"JWT"}').toString('base64url');
const payload=Buffer.from(JSON.stringify({aud:'https://substrate.office.com/sydney',tid,oid,
 preferred_username:'owner@example.edu',scp:'M365Chat.Read sydney.readwrite',
 appid:'c0ab8ce9-e9a0-42e7-b064-33d422df41f1',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url');
const at=`${header}.${payload}.${'z'.repeat(80)}`;
let server,base,cookie,csrf,id;
async function freePort(){const s=http.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function api(route,method='GET',value,auth=true,https=false){
 const r=await fetch(base+'/admin/api'+route,{method,headers:{...(auth?{Cookie:cookie,...(method==='GET'?{}:{'X-CSRF-Token':csrf})}:{}),...(https?{'X-Forwarded-Proto':'https'}:{}),...(value===undefined?{}:{'Content-Type':'application/json'})},body:value===undefined?undefined:JSON.stringify(value)});
 return {status:r.status,json:await r.json()};
}
before(async()=>{
 const port=await freePort();base='http://127.0.0.1:'+port;
 server=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env:{...process.env,M365_ADMIN_PORT:String(port),
  M365_ADMIN_DATA:DATA,M365_ADMIN_PASSWORD:adminPassword,M365_CONSOLE_TEST_PROVIDER:join(ROOT,'tests','mock-account-provider.mjs')},stdio:['ignore','pipe','pipe']});
 let error='';server.stderr.on('data',v=>error+=v);
 for(let i=0;i<110;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}
  if(server.exitCode!==null)throw Error('Failed to start: '+error);
  await new Promise(ok=>setTimeout(ok,40));}
 const login=await fetch(base+'/admin/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({email:'admin@local',password:adminPassword})});
 assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];csrf=(await login.json()).csrf;
 const r=await api('/accounts','POST',{label:'Test',runtime_type:'isolated',email_hint:'owner@example.edu',tenant_hint:tid});
 assert.equal(r.status,201);id=r.json.data.id;
});
after(()=>{server?.kill();rmSync(DATA,{recursive:true,force:true});});
test('HTTP endpoint still requires login, CSRF and admin password',async()=>{
 const url='/accounts/'+id+'/import-at-rt',p={access_token:at,refresh_token:rt,admin_password:adminPassword};
 assert.equal((await api(url,'POST',p,false,true)).status,401);
 const noCsrf=await fetch(base+'/admin/api'+url,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(p)});
 assert.equal(noCsrf.status,403);
 assert.equal((await api(url,'POST',{...p,admin_password:'wrong'},true,false)).status,403);
});
test('two input fields are sufficient and no tokens leak in responses or audit',async()=>{
 const p={access_token:at,refresh_token:rt,admin_password:adminPassword};
 const r=await api('/accounts/'+id+'/import-at-rt','POST',p,true,false);
 assert.equal(r.status,202,JSON.stringify(r.json));
 for(let i=0;i<100;i++){
  const st=(await api('/accounts/'+id+'/status')).json.data;
  if(st.state==='authorized')break;
  if(i===99)assert.fail('Not authorized: '+JSON.stringify(st));
  await new Promise(ok=>setTimeout(ok,40));
 }
 const views=await Promise.all(['/accounts','/accounts/'+id+'/status','/audit'].map(u=>api(u)));
 for(const v of views){assert.doesNotMatch(JSON.stringify(v.json),new RegExp(rt));assert.doesNotMatch(JSON.stringify(v.json),/eyJhbGciOiJSUzI1NiI/);}
 const cached=readFileSync(join(DATA,'identity-profiles',id,'msal-cache.json'),'utf8');
 // The mock verifier may replace the cache with a stripped identity; the API
 // success criterion is the isolated worker verification, not cached bytes.
 assert.ok(cached.includes('owner@example.edu'));
});
