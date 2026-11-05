/** A single Microsoft account's isolated worker. Never listens outside loopback. */
import http from 'node:http';
import {readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';

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
    const app=getApp(scope,createApp),controller=new AbortController();
    req.on('aborted',()=>controller.abort());
    const response=await app.fetch(new Request('http://worker.local'+pathname,{method:req.method,
      headers:{'Content-Type':'application/json'},body:req.method==='POST'?await readBody(req):undefined,signal:controller.signal}));
    res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')||'application/json','Cache-Control':'no-store'});
    if(response.body){for await(const chunk of response.body){if(!res.write(chunk))await new Promise(resolve=>res.once('drain',resolve));}}
    res.end();
  }catch(err){if(!res.headersSent){res.writeHead(502);res.end('Account upstream failed');}else res.destroy();}
});
process.on('message',async m=>{
  if(m?.type==='bootstrap'&&typeof m.secret==='string'&&m.secret.length>=64&&!secret){
    secret=m.secret;api.listen(0,'127.0.0.1',()=>process.send?.({type:'ready',port:api.address().port}));
  }
  if(['authorize','auto-authorize'].includes(m?.type)&&secret&&!authorizing){
    authorizing=true;
    try{
      const automated=m.type==='auto-authorize';
      // Never request an invisible interactive window during headless login.
      process.env.M365_NO_INTERACTIVE=automated?'1':'0';process.env.M365_ENABLE_INTERACTIVE_APPROVAL=automated?'0':'1';
      try{
        if(automated){
          if(m.credentials?.email!==email||typeof m.credentials?.password!=='string'||typeof m.credentials?.mfaSecret!=='string')throw Error('Credential identity mismatch');
          writeFileSync(runtimeSecretPath,JSON.stringify(m.credentials),{mode:0o600,flag:'wx'});
        }
        const {getToken}=await mod();if(typeof getToken!=='function')throw Error('Missing core getToken');
        await getToken();
      }finally{rmSync(runtimeSecretPath,{force:true});}
      const verified=identity();if(!verified.ok)throw Error(verified.reason);
      process.send?.({type:'auth-result',ok:true,email:verified.email});
    }catch(e){
      const msg=String(e?.message||'');
      const label=msg.includes('identity')||msg.includes('Tenant ID')||msg.includes('email')?'账号邮箱或租户与后台配置不一致':msg.includes('Timed out')?'登录超时':m.type==='auto-authorize'?'自动登录失败，请检查本机凭证以及组织认证要求':'登录未完成，请在本机检查 Microsoft 登录窗口和组织认证要求';
      process.send?.({type:'auth-result',ok:false,error:label});
    }
    finally{process.env.M365_NO_INTERACTIVE='1';process.env.M365_ENABLE_INTERACTIVE_APPROVAL='0';authorizing=false;}
  }
});
process.on('disconnect',()=>{rmSync(runtimeSecretPath,{force:true});process.exit(0);});
