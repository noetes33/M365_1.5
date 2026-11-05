import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync,rmSync,readFileSync,readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=mkdtempSync(path.join(os.tmpdir(),'m365-full-test-'));
let app,appPort,upstreamPort,base,adminCookie='',csrf='',adminId='',normalUser='',testKey='',keyId='',channelId='',accountId='';
const pass='ExampleStrongPassword123!';
const upstream=http.createServer(async(req,res)=>{
 if(req.url==='/v1/models'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({object:'list',data:[{id:'gpt-test',object:'model'}]}));}
 if(req.url==='/v1/chat/completions'){
   let raw='';for await(const chunk of req)raw+=chunk;
   const b=JSON.parse(raw);
   assert.equal(req.headers.authorization,undefined);
   if(b.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n');res.write('data: {"usage":{"prompt_tokens":15,"completion_tokens":6},"choices":[]}\n\n');return res.end('data: [DONE]\n\n');}
   res.writeHead(200,{'Content-Type':'application/json'});
   return res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'Mock '+b.model}}],usage:{prompt_tokens:11,completion_tokens:5}}));
 }
 res.writeHead(404);res.end('Not found');
});
async function listen(s){return new Promise(resolve=>s.listen(0,'127.0.0.1',()=>resolve(s.address().port)));}
async function freePort(){const s=http.createServer();const port=await listen(s);await new Promise(resolve=>s.close(resolve));return port;}
async function fetchReq(endpoint,method='GET',data,headers={}){
 const r=await fetch(base+endpoint,{method,headers:{...headers,...(data!==undefined?{'Content-Type':'application/json'}:{})},body:data===undefined?undefined:JSON.stringify(data)});
 const txt=await r.text();let out;try{out=JSON.parse(txt);}catch{out=txt;}
 return {status:r.status,r,data:out,text:txt};
}
const admin=(route,method='GET',data,cookie=adminCookie,csrfValue=csrf)=>fetchReq('/admin/api'+route,method,data,{Cookie:cookie,...(method==='GET'?{}:{'X-CSRF-Token':csrfValue})});
const auth=(token)=>({Authorization:'Bearer '+token});
before(async()=>{
  upstreamPort=await listen(upstream);
  appPort=await freePort();base=`http://127.0.0.1:${appPort}`;
  app=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env:{...process.env,M365_ADMIN_DATA:dir,M365_ADMIN_PASSWORD:pass,M365_ADMIN_PORT:String(appPort)},stdio:['ignore','pipe','pipe']});
  let stderr='';app.stderr.on('data',x=>stderr+=x);
  for(let i=0;i<150;i++){
   try{const r=await fetch(base+'/admin/');if(r.ok)return;}catch{}
   if(app.exitCode!==null)throw Error('App exited: '+stderr);
   await new Promise(resolve=>setTimeout(resolve,40));
  }
  throw Error('Timeout starting app: '+stderr);
});
after(async()=>{app?.kill();await new Promise(resolve=>upstream.close(resolve));rmSync(dir,{recursive:true,force:true});});

test('Web UI is served; admin and API routes require authentication',async()=>{
 assert.match((await fetchReq('/admin/')).text,/M365 Console/);
 assert.equal((await fetchReq('/admin/api/dashboard')).status,401);
 assert.equal((await fetchReq('/v1/models')).status,401);
});
test('Admin signs in and CSRF protection works',async()=>{
 assert.equal((await fetchReq('/admin/api/auth/login','POST',{email:'admin@local',password:'wrong'})).status,401);
 const x=await fetchReq('/admin/api/auth/login','POST',{email:'admin@local',password:pass});
 assert.equal(x.status,200);csrf=x.data.csrf;adminCookie=x.r.headers.get('set-cookie').split(';')[0];adminId=x.data.user.id;
 assert.equal((await fetchReq('/admin/api/accounts','POST',{label:'Bad'}, {Cookie:adminCookie})).status,403);
 assert.equal((await admin('/auth/me')).data.user.role,'admin');
});
test('Account/channel management and local-only upstream validation',async()=>{
 const account=await admin('/accounts','POST',{label:'授权测试账号',email_hint:'tester@example.edu',tenant_hint:'school',notes:'Do not store tokens'});
 assert.equal(account.status,201);
 accountId=account.data.data.id;
 const rejected=await admin('/channels','POST',{name:'Bad',account_id:accountId,upstream:'https://example.com'});
 assert.equal(rejected.status,400);
 const channel=await admin('/channels','POST',{name:'Local mock',account_id:accountId,upstream:`http://127.0.0.1:${upstreamPort}`,priority:0,weight:3,concurrency_limit:3,models:['gpt-test']});
 assert.equal(channel.status,201);channelId=channel.data.data.id;
 const health=await admin('/channels/health');assert.equal(health.data.data.find(h=>h.id===channelId).online,true);
 const model=await admin('/models','POST',{id:'gpt-test',label:'Mock model',cost_units:1,enabled:true});assert.equal(model.status,200);
});
test('User roles, safe registration, key issuance and strict API isolation',async()=>{
 const user=await admin('/users','POST',{email:'student@example.edu',name:'Test student',password:'StudentStrongPassword123!',role:'user',quota_units:2,daily_limit:4,concurrency_limit:1});
 assert.equal(user.status,201);normalUser=user.data.data.id;
 const login=await fetchReq('/admin/api/auth/login','POST',{email:'student@example.edu',password:'StudentStrongPassword123!'});
 assert.equal(login.status,200);
 const userCookie=login.r.headers.get('set-cookie').split(';')[0],userCSRF=login.data.csrf;
 assert.equal((await admin('/accounts','GET',undefined,userCookie,userCSRF)).status,403);
 assert.equal((await admin('/users','GET',undefined,userCookie,userCSRF)).status,403);
 assert.equal((await admin('/users/'+normalUser+'/accounts','PUT',{accounts:[accountId]})).status,200);
 const key=await admin('/keys','POST',{owner_id:normalUser,name:'Student API key',account_id:accountId,models:['gpt-test'],quota_units:2});
 assert.equal(key.status,201);testKey=key.data.token;keyId=key.data.data.id;assert.match(testKey,/^m365_[a-f0-9]{64}$/);
 const mine=await admin('/keys','GET',undefined,userCookie,userCSRF);assert.equal(mine.data.data.length,1);
 assert.equal(mine.data.data[0].id,keyId);
 assert.equal((await fetchReq('/v1/models','GET',undefined,auth(testKey))).status,200);
});
test('Two requests charge quota, third is blocked; streaming and token tracking work',async()=>{
 let x=await fetchReq('/v1/chat/completions','POST',{model:'gpt-test',messages:[{role:'user',content:'Sensitive classroom notes'}],stream:false},auth(testKey));
 assert.equal(x.status,200);assert.equal(x.data.choices[0].message.content,'Mock gpt-test');
 x=await fetchReq('/v1/chat/completions','POST',{model:'gpt-test',messages:[{role:'user',content:'Stream test'}],stream:true},auth(testKey));
 assert.equal(x.status,200);assert.match(x.text,/data: \[DONE\]/);
 x=await fetchReq('/v1/chat/completions','POST',{model:'gpt-test',messages:[{role:'user',content:'Blocked'}]},auth(testKey));assert.equal(x.status,429);
 x=await admin('/usage');assert.equal(x.data.data.length,2);assert.equal(x.data.summary.units,2);
 assert.equal(x.data.data[0].input_tokens,15);assert.equal(x.data.data[1].input_tokens,11);
 x=await admin('/dashboard');assert.equal(x.data.stats.total,2);assert.equal(x.data.stats.units,2);
 const blob=readFileSync(path.join(dir,'console.db'));assert.equal(blob.includes(Buffer.from('Sensitive classroom notes')),false);assert.equal(blob.includes(Buffer.from(testKey)),false);
});
test('Admin quota reset and key revocation; audit cannot contain secrets',async()=>{
 assert.equal((await admin('/users/'+normalUser+'/reset','POST')).status,200);
 assert.equal((await admin('/keys/'+keyId+'/reset','POST')).status,200);
 assert.equal((await fetchReq('/v1/chat/completions','POST',{model:'gpt-test',messages:[{role:'user',content:'Again'}]},auth(testKey))).status,200);
 const auditList=(await admin('/audit')).data.data;assert.ok(auditList.some(a=>a.action==='users.reset'));assert.equal(JSON.stringify(auditList).includes(testKey),false);
 assert.equal((await admin('/keys/'+keyId,'DELETE')).status,200);
 assert.equal((await fetchReq('/v1/models','GET',undefined,auth(testKey))).status,401);
});
test('Admin can reset user password and old sessions are invalidated',async()=>{
 const x=await admin('/users/'+normalUser+'/password','POST',{password:'NewStudentStrongPass123!'});assert.equal(x.status,200);
 const login=await fetchReq('/admin/api/auth/login','POST',{email:'student@example.edu',password:'NewStudentStrongPass123!'});assert.equal(login.status,200);
 const old=await fetchReq('/admin/api/auth/login','POST',{email:'student@example.edu',password:'StudentStrongPassword123!'});assert.equal(old.status,401);
});
