import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const data=mkdtempSync(path.join(os.tmpdir(),'m365-embedded-console-'));
const pass='VeryStrongTestPassword2026!';
let server,base,cookie,csrf,token1,token2;
async function port(){return await new Promise(resolve=>{const s=http.createServer();s.listen(0,'127.0.0.1',()=>{const n=s.address().port;s.close(()=>resolve(n));});});}
async function api(route,method='GET',body,headers={}){
 const r=await fetch(base+route,{method,headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 const txt=await r.text();let value;try{value=JSON.parse(txt);}catch{value=txt;}
 return {r,status:r.status,data:value,text:txt};
}
function admin(route,method='GET',body){return api('/admin/api'+route,method,body,{Cookie:cookie,...(method==='GET'?{}:{'X-CSRF-Token':csrf})});}
function bearer(token){return {Authorization:'Bearer '+token};}
before(async()=>{
 const p=await port();base='http://127.0.0.1:'+p;
 server=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env:{...process.env,M365_ADMIN_PASSWORD:pass,M365_ADMIN_PORT:String(p),M365_ADMIN_DATA:data,M365_CONSOLE_TEST_PROVIDER:path.join(ROOT,'tests/mock-embedded.mjs')},stdio:['ignore','pipe','pipe']});
 let err='';server.stderr.on('data',x=>err+=String(x));
 for(let i=0;i<150;i++){
  if(server.exitCode!==null)throw new Error('Server failed: '+err);
  try{if((await fetch(base+'/admin/')).ok)break;}catch{}
  await new Promise(resolve=>setTimeout(resolve,40));
  if(i===149)throw new Error('Server startup timeout: '+err);
 }
 const login=await api('/admin/api/auth/login','POST',{email:'admin@local',password:pass});
 assert.equal(login.status,200);cookie=login.r.headers.get('set-cookie').split(';')[0];csrf=login.data.csrf;
 const accounts=(await admin('/accounts')).data.data;
 const accountId=accounts.find(a=>a.runtime_type==='legacy').id;
 const key1=await admin('/keys','POST',{name:'Embedded test #1',account_id:accountId});
 const key2=await admin('/keys','POST',{name:'Embedded test #2',account_id:accountId});
 assert.equal(key1.status,201);assert.equal(key2.status,201);
 token1=key1.data.token;token2=key2.data.token;
});
after(()=>{server?.kill();rmSync(data,{recursive:true,force:true});});
test('default channel uses the in-process adapter, without a separate port',async()=>{
 const channels=await admin('/channels');
 assert.equal(channels.status,200);
 assert.equal(channels.data.data[0].upstream,'embedded://default');
 const health=await admin('/channels/health');
 assert.equal(health.status,200);assert.equal(health.data.data[0].online,true);
 const sync=await admin('/models/sync','POST');assert.equal(sync.status,200);
 const enable=await admin('/models','POST',{id:'embedded-test',label:'Mock embedded',enabled:true,cost_units:1});
 assert.equal(enable.status,200);
 const models=await api('/v1/models','GET',undefined,bearer(token1));
 assert.equal(models.status,200);assert.ok(models.data.data.some(x=>x.id==='embedded-test'));
 assert.equal(models.data.data.find(x=>x.id==='embedded-test').context_window,1000000);
});
test('in-process SessionPool instances are isolated per API key and reused within a key',async()=>{
 const b={model:'embedded-test',messages:[{role:'user',content:'intro'}],stream:false};
 const a1=await api('/v1/chat/completions','POST',b,bearer(token1));
 const a2=await api('/v1/chat/completions','POST',b,bearer(token1));
 const b1=await api('/v1/chat/completions','POST',b,bearer(token2));
 assert.equal(a1.status,200);assert.equal(a2.status,200);assert.equal(b1.status,200);
 const x=a1.data.choices[0].message.content,y=a2.data.choices[0].message.content,z=b1.data.choices[0].message.content;
 assert.match(x,/embedded-pool-\d+-turn-1/);
 assert.equal(y,x.replace('turn-1','turn-2'));
 assert.notEqual(z.replace(/turn-\d+/,''),x.replace(/turn-\d+/,''));
});
test('embedded stream is passed through and usage is recorded as request units only',async()=>{
 const s=await api('/v1/chat/completions','POST',{model:'embedded-test',messages:[{role:'user',content:'hello'}],stream:true},bearer(token1));
 assert.equal(s.status,200);assert.match(s.text,/data: \[DONE\]/);
 const usage=await admin('/usage');assert.equal(usage.status,200);
 const row=usage.data.data.find(u=>u.model==='embedded-test');assert.ok(row);
 assert.equal(row.usage_source,'unavailable');assert.equal(row.units,1);
});
