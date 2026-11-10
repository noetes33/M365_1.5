/** A single Microsoft account's isolated worker. Never listens outside loopback. */
import http from 'node:http';
import {readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {poolKeyForRequest} from './chat-test-isolation.mjs';
import {pathToFileURL} from 'node:url';
import {refreshManualToken,markManualVerified,manualIdentity} from './manual-token-store.mjs';

const email=String(process.env.M365_EXPECTED_EMAIL||'').trim().toLowerCase();
const tenant=String(process.env.M365_EXPECTED_TENANT||'').trim().toLowerCase();
// Fixed before the first import of upstream auth.ts, which may capture the path
// at module initialization. Contents exist only while an authorization runs.
const runtimeSecretPath=join(process.platform==='linux'&&existsSync('/dev/shm')?'/dev/shm':tmpdir(),'m365-runtime-'+randomBytes(16).toString('hex')+'.json');
process.env.M365_SECRETS_FILE=runtimeSecretPath;
let secret='',authorizing=false;
const pools=new Map();
let modPromise;
async function mod(){
  if(!modPromise)modPromise=process.env.M365_CONSOLE_TEST_PROVIDER
    ? import(process.env.M365_CONSOLE_TEST_PROVIDER.startsWith('file:')?process.env.M365_CONSOLE_TEST_PROVIDER:pathToFileURL(resolve(process.env.M365_CONSOLE_TEST_PROVIDER)).href)
    : Promise.all([import('@m365-copilot/core'),import('@m365-copilot/proxy-lib')]).then(([core,proxy])=>({...core,...proxy}));
  return modPromise;
}
function identity(){
  const manual=process.env.M365_MANUAL_TOKEN_FILE&&manualIdentity(process.env.M365_MANUAL_TOKEN_FILE);
  if(manual){
    if(manual.email!==email)return {ok:false,reason:'Microsoft identity does not match configured email'};
    if(/^[a-f0-9-]{36}$/i.test(tenant)&&manual.tenant&&manual.tenant!==tenant)return {ok:false,reason:'Tenant ID mismatch'};
    return {ok:true,email,tenant:manual.tenant||''};
  }
  try{const data=JSON.parse(readFileSync(process.env.M365_CACHE_FILE,'utf8'));
    const accounts=Object.values(data.Account||data.account||{});
    if(accounts.length!==1)return {ok:false,reason:'Multiple or missing identities in account cache'};
    const a=accounts[0],actual=String(a.username||'').toLowerCase(),tid=String(a.realm||a.tenantId||'').toLowerCase();
    if(!email||actual!==email)return {ok:false,reason:'Microsoft identity does not match configured email'};
    if(/^[a-f0-9-]{36}$/i.test(tenant)&&tid!==tenant)return {ok:false,reason:'Tenant ID mismatch'};
    return {ok:true,email:actual,tenant:tid};
  }catch{return {ok:false,reason:'Account has not been authorized'};}
}
function getApp(scope,createApp){
  const now=Date.now();for(const [k,v] of pools)if(v.last<now-1800000)pools.delete(k);
  const old=pools.get(scope);if(old){old.last=now;return old.app;}
  if(pools.size>=128){const first=pools.keys().next().value;pools.delete(first);}
  const app=createApp();pools.set(scope,{app,last:now});return app;
}
async function readBody(req,max=9*1024*1024){let size=0,buffers=[];for await(const chunk of req){size+=chunk.length;if(size>max)throw new Error('Request too large');buffers.push(chunk);}return Buffer.concat(buffers);}
const api=http.createServer(async(req,res)=>{
  if(req.headers['x-m365-worker-secret']!==secret||!secret){res.writeHead(403);return res.end();}
  if(authorizing){res.writeHead(503);return res.end('Interactive authorization in progress');}
  if(!identity().ok){res.writeHead(403);return res.end('Microsoft identity not linked');}
  const {pathname}=new URL(req.url,'http://localhost');
  if(!(['/v1/models','/v1/chat/completions'].includes(pathname))) {res.writeHead(404);return res.end();}
  if((pathname==='/v1/models'&&req.method!=='GET')||(pathname==='/v1/chat/completions'&&req.method!=='POST')){res.writeHead(405);return res.end();}
  try{
    const {createApp}=await mod();
    if(typeof createApp!=='function')throw new Error('Missing proxy-lib createApp');
    const scope=String(req.headers['x-m365-worker-scope']||'').slice(0,128);
    if(!/^([a-f0-9-]{36}|internal-[a-z-]+)$/.test(scope)){res.writeHead(403);return res.end();}
    const controller=new AbortController();
    req.on('aborted',()=>controller.abort());
    const payload=req.method==='POST'?await readBody(req):undefined;
    // Scope the upstream session pool by the requested model, not just by the
    // calling API user/test slot. This avoids sharing a failed 6.1 session with 5.x.
    const poolScope=poolKeyForRequest(scope,pathname,payload);
    let app=getApp(poolScope,createApp);
    const doFetch=()=>app.fetch(new Request('http://worker.local'+pathname,{method:req.method,
      headers:{'Content-Type':'application/json'},body:payload,signal:controller.signal}));
    let response=await doFetch();
    let refreshError=null;
    const manual=process.env.M365_MANUAL_TOKEN_FILE&&manualIdentity(process.env.M365_MANUAL_TOKEN_FILE);
    if(manual&&response.status===401){
      // Only an explicit token-authentication failure triggers RT rotation.
      try{await refreshManualToken(process.env.M365_MANUAL_TOKEN_FILE);pools.delete(poolScope);app=getApp(poolScope,createApp);response=await doFetch();}
      catch(e){refreshError=String(e.message||'RT 续期失败').slice(0,120);}
    }
    if(manual&&pathname==='/v1/chat/completions'){
      let chatOk=false;
      if(response.ok){
        try{
          // Do not equate an HTTP 200 with a successful model response.
          const copy=await response.clone().json();
          const content=copy?.choices?.[0]?.message?.content;
          chatOk=typeof content==='string'&&content.length>0;
        }catch{chatOk=false;}
      }
      if(chatOk){markManualVerified(process.env.M365_MANUAL_TOKEN_FILE);process.send?.({type:'manual-chat-status',ok:true});}
      else process.send?.({type:'manual-chat-status',ok:false,error:refreshError||`模型调用未返回正常回答（HTTP ${response.status}）`});
    }
    res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')||'application/json','Cache-Control':'no-store'});
    if(response.body){for await(const chunk of response.body){if(!res.write(chunk))await new Promise(resolve=>res.once('drain',resolve));}}
    res.end();
  }catch(err){if(!res.headersSent){res.writeHead(502);res.end('Account upstream failed');}else res.destroy();}
});
process.on('message',async m=>{
  if(m?.type==='bootstrap'&&typeof m.secret==='string'&&m.secret.length>=64&&!secret){
    secret=m.secret;api.listen(0,'127.0.0.1',()=>process.send?.({type:'ready',port:api.address().port}));
  }
  if(['authorize','auto-authorize','verify-cache'].includes(m?.type)&&secret&&!authorizing){
    authorizing=true;
    try{
      const automated=m.type==='auto-authorize',cacheOnly=m.type==='verify-cache';
      // Never request an invisible interactive window during headless login.
      process.env.M365_NO_INTERACTIVE=(automated||cacheOnly)?'1':'0';process.env.M365_ENABLE_INTERACTIVE_APPROVAL=(automated||cacheOnly)?'0':'1';
      try{
        if(automated){
          if(String(m.credentials?.email||'').trim().toLowerCase()!==email)throw Error('Credential identity mismatch');
          if(typeof m.credentials?.password!=='string'||!m.credentials.password)throw Error('Password is missing');
          if(typeof m.credentials?.mfaSecret!=='string'||!m.credentials.mfaSecret)throw Error('TOTP seed is missing');
          writeFileSync(runtimeSecretPath,JSON.stringify(m.credentials),{mode:0o600,flag:'wx'});
        }
        const {getToken}=await mod();if(typeof getToken!=='function')throw Error('Missing core getToken');
        const accessToken=await getToken();
        if(cacheOnly&&(!accessToken||typeof accessToken!=='string'))throw Error('Silent token validation returned no access token');
      }finally{rmSync(runtimeSecretPath,{force:true});}
      const verified=identity();if(!verified.ok)throw Error(verified.reason);
      process.send?.({type:'auth-result',ok:true,email:verified.email});
    }catch(e){
      const msg=String(e?.message||'');
      const label=msg.includes('Credential identity')?'自动登录凭证的邮箱与当前档案不匹配':msg.includes('Microsoft identity')?'微软登录身份与当前档案邮箱不匹配':msg.includes('Tenant ID')?'微软账号租户 ID 不匹配':msg.includes('Password is missing')?'未配置微软账号密码':msg.includes('TOTP seed is missing')?'未配置 TOTP 种子':msg.includes('Account has not been authorized')?'授权失败：未生成有效 MSAL 身份缓存':msg.includes('Multiple or missing identities')?'MSAL 缓存缺少身份或包含多个账号':msg.includes('Timed out')?'微软认证超时':cacheOnly?'导入缓存的静默取 Token 失败；可能过期、权限不符或需再次 MFA':automated?'自动登录失败；请检查凭证与组织 MFA 要求':'登录未完成，请在微软官方登录窗口完成授权';
      process.send?.({type:'auth-result',ok:false,error:label});
    }
    finally{process.env.M365_NO_INTERACTIVE='1';process.env.M365_ENABLE_INTERACTIVE_APPROVAL='0';authorizing=false;}
  }
});
process.on('disconnect',()=>{rmSync(runtimeSecretPath,{force:true});process.exit(0);});
