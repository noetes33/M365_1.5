import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const DATA=mkdtempSync(join(tmpdir(),'m365-import-api-test-'));
const adminPassword='SafeTestOnlyAdminPassword123!';
const TENANT='22222222-2222-2222-2222-222222222222';
let server,base,cookie,csrf,accountId;
async function port(){const s=http.createServer();await new Promise(ok=>s.listen(0,'127.0.0.1',ok));const p=s.address().port;await new Promise(ok=>s.close(ok));return p;}
async function req(route,method='GET',payload,{auth=true,https=false}={}){
 const res=await fetch(base+'/admin/api'+route,{method,headers:{...(auth?{Cookie:cookie,...(method==='GET'?{}:{'X-CSRF-Token':csrf})}:{}),...(payload!==undefined?{'Content-Type':'application/json'}:{}),...(https?{'X-Forwarded-Proto':'https'}:{})},body:payload===undefined?undefined:JSON.stringify(payload)});
 return {code:res.status,data:await res.json()};
}
function msalCache(){const home='some-guid.'+TENANT,env='login.microsoftonline.com',client='test-client';
 const cred={homeAccountId:home,environment:env,clientId:client};
 return JSON.stringify({Account:{one:{...cred,username:'owner@example.edu',realm:TENANT}},AccessToken:{one:{...cred,secret:'FAKE_ACCESS_TOKEN_1234567890_TEST_ONLY',target:'fake.scope',expiresOn:'9999999999'}},RefreshToken:{one:{...cred,secret:'FAKE_REFRESH_TOKEN_1234567890_TEST_ONLY'}}});}
before(async()=>{
 base='http://127.0.0.1:'+(await port());
 server=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env:{...process.env,M365_ADMIN_PORT:base.split(':').at(-1),M365_ADMIN_DATA:DATA,M365_ADMIN_PASSWORD:adminPassword,M365_CONSOLE_TEST_PROVIDER:join(ROOT,'tests','mock-account-provider.mjs')},stdio:['ignore','pipe','pipe']});
 let errors='';server.stderr.on('data',c=>errors+=c);
 for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}
   if(server.exitCode!==null)throw Error('Server failed: '+errors);
   await new Promise(r=>setTimeout(r,40));}
 const login=await fetch(base+'/admin/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@local',password:adminPassword})});
 assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];csrf=(await login.json()).csrf;
 const a=await req('/accounts','POST',{label:'Test Owner',runtime_type:'isolated',email_hint:'owner@example.edu',tenant_hint:TENANT});
 assert.equal(a.code,201);accountId=a.data.data.id;
});
after(()=>{server?.kill();rmSync(DATA,{recursive:true,force:true});});
test('MSAL import requires authentication, HTTPS and correct admin password',async()=>{
 const url='/accounts/'+accountId+'/import-msal-cache';const payload={msal_cache:msalCache(),admin_password:adminPassword};
 assert.equal((await req(url,'POST',payload,{auth:false,https:true})).code,401);
 assert.equal((await req(url,'POST',payload)).code,403);
 assert.equal((await req(url,'POST',{...payload,admin_password:'bad'},{https:true})).code,403);
});
test('imported accounts must match assigned email and tenant',async()=>{
 const bad=msalCache().replace('owner@example.edu','other@example.edu');
 const r=await req('/accounts/'+accountId+'/import-msal-cache','POST',{msal_cache:bad,admin_password:adminPassword},{https:true});
 assert.equal(r.code,400);
});
test('valid cache is verified by mock token provider; secrets absent from admin API',async()=>{
 const url='/accounts/'+accountId+'/import-msal-cache';
 const out=await req(url,'POST',{msal_cache:msalCache(),admin_password:adminPassword},{https:true});
 assert.equal(out.code,202,JSON.stringify(out.data));
 for(let i=0;i<120;i++){
   const status=await req('/accounts/'+accountId+'/status');
   if(status.data.data.state==='authorized')break;
   if(i===119)assert.fail('Mock MSAL import not marked authorized: '+JSON.stringify(status.data));
   await new Promise(ok=>setTimeout(ok,30));
 }
 const accounts=await req('/accounts');const logs=await req('/audit');
 assert.doesNotMatch(JSON.stringify(accounts.data)+JSON.stringify(logs.data),/FAKE_(ACCESS|REFRESH)_TOKEN/);
});
