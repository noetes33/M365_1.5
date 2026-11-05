import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const data=mkdtempSync(join(tmpdir(),'m365-ip-http-'));
const pass='AdminPasswordForLocalMockTest12345!';
let child,port,csrf,cookie;
async function freePort(){const s=http.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function api(route,method='GET',payload,auth=true){const res=await fetch('http://127.0.0.1:'+port+'/admin/api'+route,{method,headers:{...(auth?{Cookie:cookie,...(method==='GET'?{}:{'X-CSRF-Token':csrf})}:{}),...(payload?{'Content-Type':'application/json'}:{})},body:payload?JSON.stringify(payload):undefined});return {status:res.status,body:await res.json()};}
before(async()=>{
 port=await freePort();
 child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,M365_ADMIN_HOST:'0.0.0.0',M365_HTTP_TEST_MODE:'1',M365_ADMIN_PORT:String(port),M365_ADMIN_DATA:data,M365_ADMIN_PASSWORD:pass,M365_CONSOLE_TEST_PROVIDER:join(root,'tests','mock-account-provider.mjs')},stdio:['ignore','pipe','pipe']});
 let errors='';child.stderr.on('data',d=>errors+=d);
 for(let i=0;i<120;i++){try{if((await fetch('http://127.0.0.1:'+port+'/health')).ok)break;}catch{}if(child.exitCode!==null)throw Error(errors);await new Promise(r=>setTimeout(r,40));}
 const auth=await api('/auth/login','POST',{email:'admin@local',password:pass},false);
 assert.equal(auth.status,200,JSON.stringify(auth.body));
 csrf=auth.body.csrf;
 const raw=await fetch('http://127.0.0.1:'+port+'/admin/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@local',password:pass})});
 cookie=raw.headers.get('set-cookie').split(';')[0];csrf=(await raw.json()).csrf;
});
after(async()=>{child?.kill();await new Promise(r=>setTimeout(r,80));rmSync(data,{recursive:true,force:true});});
test('HTTP test mode allows admin credential configuration on HTTP, not unauthenticated clients',async()=>{
 const a=await api('/accounts','POST',{label:'HTTP Test',runtime_type:'isolated',email_hint:'user@example.edu'});
 assert.equal(a.status,201,JSON.stringify(a.body));
 const id=a.body.data.id;
 const creds={password:'DUMMY-TEST-PASSWORD-12345',mfaSecret:'JBSWY3DPEHPK3PXP',admin_password:pass};
 assert.equal((await api('/accounts/'+id+'/credentials','PUT',creds,false)).status,401);
 assert.equal((await api('/accounts/'+id+'/credentials','PUT',creds)).status,200);
 assert.equal((await api('/accounts/'+id+'/status')).body.data.autoLoginConfigured,true);
});
