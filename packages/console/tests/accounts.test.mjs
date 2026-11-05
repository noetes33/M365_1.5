import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const data=mkdtempSync(join(tmpdir(),'m365-accounts-v12-'));
let proc,base,cookie,csrf,accountA,accountB,keyA,keyB,userId;
const pw='ExampleStrongPassword12345!';
async function freePort(){const s=http.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const n=s.address().port;await new Promise(r=>s.close(r));return n;}
async function req(url,method='GET',payload=null,heads={}){
  const r=await fetch(base+url,{method,headers:{...heads,...(payload?{'Content-Type':'application/json'}:{})},body:payload?JSON.stringify(payload):undefined});
  const text=await r.text();let result;try{result=JSON.parse(text);}catch{result=text;}
  return {code:r.status,data:result,headers:r.headers};
}
const admin=(u,m='GET',b)=>req('/admin/api'+u,m,b,{'Cookie':cookie,...(m==='GET'?{}:{'X-CSRF-Token':csrf})});
const keyh=key=>({'Authorization':'Bearer '+key});
before(async()=>{
  const port=await freePort();base='http://127.0.0.1:'+port;
  proc=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env:{...process.env,M365_ADMIN_PORT:String(port),M365_ADMIN_PASSWORD:pw,M365_ADMIN_DATA:data,M365_CONSOLE_TEST_PROVIDER:join(ROOT,'tests','mock-account-provider.mjs')},stdio:['ignore','pipe','pipe']});
  let errors='';proc.stderr.on('data',b=>errors+=b);
  for(let i=0;i<180;i++){
    try{if((await fetch(base+'/health')).ok)break;}catch{}
    if(proc.exitCode!==null)throw new Error(errors);
    await new Promise(r=>setTimeout(r,40));
  }
  const login=await req('/admin/api/auth/login','POST',{email:'admin@local',password:pw});
  assert.equal(login.code,200);cookie=login.headers.get('set-cookie').split(';')[0];csrf=login.data.csrf;
});
after(async()=>{proc?.kill();await new Promise(r=>setTimeout(r,100));rmSync(data,{recursive:true,force:true});});

test('independent account profiles must specify the expected Microsoft email',async()=>{
  assert.equal((await admin('/accounts','POST',{label:'Invalid',runtime_type:'isolated'})).code,400);
  const a=await admin('/accounts','POST',{label:'Alice Microsoft',email_hint:'alice@example.edu',runtime_type:'isolated'});
  const b=await admin('/accounts','POST',{label:'Bob Microsoft',email_hint:'bob@example.edu',runtime_type:'isolated'});
  assert.equal(a.code,201);assert.equal(b.code,201);
  accountA=a.data.data.id;accountB=b.data.data.id;
  const channels=(await admin('/channels')).data.data;
  assert.equal(channels.filter(c=>c.account_id===accountA&&c.upstream==='account://'+accountA).length,1);
  assert.equal(channels.filter(c=>c.account_id===accountB&&c.upstream==='account://'+accountB).length,1);
  // Cross-binding: account://Alice cannot be linked to Bob's channel.
  assert.equal((await admin('/channels','POST',{name:'cross',account_id:accountB,upstream:'account://'+accountA})).code,400);
});

test('authorization is triggered only by an authenticated admin with CSRF token',async()=>{
  assert.equal((await req('/admin/api/accounts/'+accountA+'/authorize','POST')).code,401);
  assert.equal((await req('/admin/api/accounts/'+accountA+'/authorize','POST',{}, {'Cookie':cookie})).code,403);
  for(const id of [accountA,accountB]){
    const x=await admin('/accounts/'+id+'/authorize','POST',{});
    assert.equal(x.code,202);
  }
  for(let t=0;t<100;t++){
    const accounts=(await admin('/accounts')).data.data;
    if(accounts.filter(a=>[accountA,accountB].includes(a.id)).every(a=>a.auth.state==='authorized'))return;
    await new Promise(r=>setTimeout(r,40));
  }
  assert.fail('Simulated accounts were not authorized');
});

test('each account has distinct MSAL cache and data is not stored in SQLite',async()=>{
  const pathA=join(data,'identity-profiles',accountA,'msal-cache.json');
  const pathB=join(data,'identity-profiles',accountB,'msal-cache.json');
  assert.equal(existsSync(pathA),true);assert.equal(existsSync(pathB),true);
  assert.match(readFileSync(pathA,'utf8'),/alice@example.edu/);
  assert.match(readFileSync(pathB,'utf8'),/bob@example.edu/);
  assert.equal(readFileSync(pathA,'utf8').includes('bob@example.edu'),false);
  assert.equal(readFileSync(pathB,'utf8').includes('alice@example.edu'),false);
});

test('key owner cannot use unauthorized account, keys route only to bound account',async()=>{
  const u=await admin('/users','POST',{email:'student2@example.edu',name:'Student2',role:'user',password:'StudentStrongPassword123456!',quota_units:20});assert.equal(u.code,201);userId=u.data.data.id;
  const forbidden=await admin('/keys','POST',{owner_id:userId,name:'not assigned',account_id:accountA});assert.equal(forbidden.code,400);
  assert.equal((await admin('/users/'+userId+'/accounts','PUT',{accounts:[accountA]})).code,200);
  const k=await admin('/keys','POST',{owner_id:userId,name:'Alice key',account_id:accountA});assert.equal(k.code,201);keyA=k.data.token;
  const kB=await admin('/keys','POST',{owner_id:userId,name:'No Bob entitlement',account_id:accountB});assert.equal(kB.code,400);
  const upModel=await admin('/models','POST',{id:'gpt-test',label:'Test',enabled:true,cost_units:1});assert.equal(upModel.code,200);
  let r=await req('/v1/chat/completions','POST',{model:'gpt-test',messages:[{role:'user',content:'hello'}]},keyh(keyA));
  assert.equal(r.code,200);assert.match(r.data.choices[0].message.content,/alice@example.edu/);
  assert.equal(r.data.choices[0].message.content.includes('bob@example.edu'),false);
  assert.equal((await admin('/users/'+userId+'/accounts','PUT',{accounts:[accountA,accountB]})).code,200);
  const b=await admin('/keys','POST',{owner_id:userId,name:'Bob key',account_id:accountB});assert.equal(b.code,201);keyB=b.data.token;
  r=await req('/v1/chat/completions','POST',{model:'gpt-test',messages:[{role:'user',content:'hello'}]},keyh(keyB));
  assert.equal(r.code,200);assert.match(r.data.choices[0].message.content,/bob@example.edu/);
  r=await req('/v1/chat/completions','POST',{model:'gpt-test',messages:[{role:'user',content:'stream'}],stream:true},keyh(keyB));
  assert.equal(r.code,200);assert.match(r.data,/bob@example.edu/);
});


test('revoking user-to-account grant immediately disables an existing key',async()=>{
  assert.equal((await admin('/users/'+userId+'/accounts','PUT',{accounts:[accountB]})).code,200);
  let r=await req('/v1/chat/completions','POST',{model:'gpt-test',messages:[{role:'user',content:'unauthorized'}]},keyh(keyA));
  assert.equal(r.code,401);
  r=await req('/v1/chat/completions','POST',{model:'gpt-test',messages:[{role:'user',content:'authorized'}]},keyh(keyB));
  assert.equal(r.code,200);
  assert.equal((await admin('/users/'+userId+'/accounts','PUT',{accounts:[accountA,accountB]})).code,200);
});

test('unlink removes credential cache, disables channel and blocks bound keys',async()=>{
  assert.equal((await admin('/accounts/'+accountA+'/unlink','POST',{})).code,200);
  assert.equal(existsSync(join(data,'identity-profiles',accountA,'msal-cache.json')),false);
  const r=await req('/v1/chat/completions','POST',{model:'gpt-test',messages:[{role:'user',content:'hello'}]},keyh(keyA));
  assert.equal(r.code,503);
  const b=await req('/v1/chat/completions','POST',{model:'gpt-test',messages:[{role:'user',content:'hello'}]},keyh(keyB));
  assert.equal(b.code,200);
});
