/** Isolated account workers. Each Microsoft identity runs in its own process and MSAL cache.
 * No access tokens, passwords, or MFA material are exposed to the management API.
 */
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdirSync, readFileSync, existsSync, rmSync, chmodSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {accountDir,autoSecretPath} from './account-paths.mjs';
import {vaultPresent,readCredentials} from './credential-vault.mjs';
import {cacheImportPending,clearCacheImportPending,saveImportedCache,validateCacheImport} from './msal-cache-import.mjs';
import {hasManualTokens,manualTokenPath,saveManualTokens,statusManualTokens,refreshManualToken} from './manual-token-store.mjs';
import {updateManualChatStatus} from './chat-test-isolation.mjs';
import {fileURLToPath} from 'node:url';

const ROOT=resolve(fileURLToPath(new URL('.', import.meta.url)));
const WORKER=join(ROOT,'account-worker.mjs');
const runtimes=new Map();
const mail=v=>String(v||'').trim().toLowerCase();
const tenant=v=>String(v||'').trim().toLowerCase();
export {accountDir,autoSecretPath} from './account-paths.mjs';
export function hasAutoSecrets(dataRoot,id){
  if(vaultPresent(dataRoot,id))return true;
  try{
    const p=autoSecretPath(dataRoot,id);
    const v=JSON.parse(readFileSync(p,'utf8'));
    return typeof v.email==='string' && typeof v.password==='string' && typeof v.mfaSecret==='string' && v.password.length>0 && v.mfaSecret.length>0;
  }catch{return false;}
}
export function cachedIdentity(dataRoot,id){
  try{
    const p=join(accountDir(dataRoot,id),'msal-cache.json');
    const cache=JSON.parse(readFileSync(p,'utf8'));
    const candidates=Object.values(cache.Account||cache.account||{});
    if(candidates.length!==1)return {state:candidates.length?'ambiguous':'not-linked',email:null,tenant:null};
    const a=candidates[0];
    return {state:'cached',email:mail(a.username),tenant:tenant(a.realm||a.tenantId||'')};
  }catch{return {state:'not-linked',email:null,tenant:null};}
}
function identityStatus(a, cached){
  if(a.runtime_type!=='isolated')return {state:'legacy',email:null,tenant:null};
  if(cached.state!=='cached')return cached;
  if(!a.email_hint||cached.email!==mail(a.email_hint))return {...cached,state:'identity-mismatch'};
  // tenant_hint historically serves as a freeform label. Validate only when a GUID is supplied.
  if(/^[a-f0-9-]{36}$/i.test(a.tenant_hint||'')&&tenant(a.tenant_hint)!==cached.tenant)
    return {...cached,state:'tenant-mismatch'};
  return cached;
}
export function accountStatus(dataRoot,a){
  let base=identityStatus(a,cachedIdentity(dataRoot,a.id));
  const manual=a.runtime_type==='isolated'?statusManualTokens(dataRoot,a.id):null;
  if(manual)base={...base,state:'manual-ready-to-test',manual};
  else if(a.runtime_type==='isolated'&&base.state==='cached'&&cacheImportPending(dataRoot,a.id))base={...base,state:'verification-required'};
  const running=runtimes.get(a.id);
  if(!running)return {...base,worker:'stopped',autoLoginConfigured:a.runtime_type==='isolated'&&hasAutoSecrets(dataRoot,a.id)};
  return {...base,worker:running.child.exitCode===null?'running':'stopped',
    state:running.authError? 'error':running.loginPending?'authorizing':running.verified && (base.state==='cached'||base.state==='manual-ready-to-test')?'authorized':base.state,
    error:running.authError||null,autoLoginConfigured:a.runtime_type==='isolated'&&hasAutoSecrets(dataRoot,a.id)};
}
export function accountReady(dataRoot,a){
  const s=accountStatus(dataRoot,a);
  return (s.state==='cached'||s.state==='authorized'||s.state==='manual-ready-to-test') && !!a.enabled;
}

export async function startWorker(dataRoot,a){
  if(a.runtime_type!=='isolated')throw new Error('Account is not isolated');
  const current=runtimes.get(a.id);
  if(current&&current.child.exitCode===null&&current.port)return current;
  if(current?.readyPromise)return current.readyPromise;
  const dir=accountDir(dataRoot,a.id);
  mkdirSync(dir,{recursive:true,mode:0o700});try{chmodSync(dir,0o700);}catch{}
  const secret=randomBytes(48).toString('hex');
  const env={...process.env,
    M365_CACHE_FILE:join(dir,'msal-cache.json'),
    M365_BROWSER_PROFILE:join(dir,'browser-profile'),
    // Reuse the upstream auth.ts loadSecrets() path; v1.4 web vault is decrypted only for login.
    M365_SECRETS_FILE:autoSecretPath(dataRoot,a.id),
    M365_CONSOLE_CONFIG_DIR:dir,
    M365_CONSOLE_DISABLE_LOGIN_CAPTURE:'1',
    M365_NO_INTERACTIVE:'1',M365_ENABLE_INTERACTIVE_APPROVAL:'0',
    M365_EXPECTED_EMAIL:a.email_hint,
    M365_EXPECTED_TENANT:a.tenant_hint||'',
    M365_CONSOLE_WORKER:'1',
    M365_DEBUG:'',M365_TRACE:'',M365_DUMP_FRAMES:'',M365_LOG_STDOUT:'',
    M365_LOG_FILE:join(dir,'worker.log'),M365_FRAME_DIR:join(dir,'frames'),
    ...(hasManualTokens(dataRoot,a.id)?{M365_MANUAL_TOKEN_FILE:manualTokenPath(dataRoot,a.id),M365_MANUAL_TOKEN_PROVIDER:new URL('./manual-token-store.mjs',import.meta.url).href}:{M365_MANUAL_TOKEN_FILE:'',M365_MANUAL_TOKEN_PROVIDER:''})
  };
  delete env.M365_ADMIN_PASSWORD;delete env.M365_ADMIN_DATA;
  const child=spawn(process.execPath,[WORKER],{cwd:ROOT,env,stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
  const entry={child,secret,port:null,loginPending:false,verified:false,authError:null,readyPromise:null};
  runtimes.set(a.id,entry);
  // Upstream can contain sensitive data; never log raw stderr or forward it.
  child.stderr.on('data',()=>{});
  child.on('message',m=>{
    if(m?.type!=='manual-chat-status')return;
    // A failed model request (502, empty completion, unsupported tone, timeout)
    // is NOT evidence that this Microsoft account's credentials are invalid.
    // Keep previously successful authorization and make other models retryable.
    updateManualChatStatus(entry,m);
  });
  child.on('exit',()=>{entry.port=null;entry.loginPending=false;entry.verified=false;});
  entry.readyPromise=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(new Error('Account worker startup timed out'));},7000);
    const onMessage=m=>{
      if(m?.type==='ready'&&Number.isInteger(m.port)){
        clearTimeout(timer);entry.port=m.port;entry.readyPromise=null;
        child.off('message',onMessage);resolve(entry);
      }
    };
    child.on('message',onMessage);
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('Account worker exited before startup'));});
    child.send({type:'bootstrap',secret});
  }).catch(e=>{if(runtimes.get(a.id)===entry)runtimes.delete(a.id);entry.readyPromise=null;throw e;});
  return entry.readyPromise;
}
function awaitAuthenticationResult(entry, dataRoot, a, imported=false){
  const handler=m=>{
    if(m?.type!=='auth-result')return;
    entry.child.off('message',handler);
    entry.loginPending=false;
    entry.verified=!!m.ok;
    entry.authError=m.ok?null:String(m.error||'Authorization failed').slice(0,160);
    if(m.ok&&imported)clearCacheImportPending(dataRoot,a.id);
  };
  entry.child.on('message',handler);
  entry.child.once('exit',()=>entry.child.off('message',handler));
  return handler;
}
function sendAuthentication(entry,type,options={},dataRoot=null,a=null,imported=false){
  if(entry.loginPending)throw new Error('An authorization is already in progress');
  entry.loginPending=true;
  entry.authError=null;
  entry.verified=false;
  const handler=awaitAuthenticationResult(entry,dataRoot,a,imported);
  try{entry.child.send({type,...options});}
  catch(e){entry.child.off('message',handler);entry.loginPending=false;entry.authError='授权工作进程通信失败';throw e;}
}
export async function beginAuthorizedLogin(dataRoot,a){
  if(!a.enabled)throw new Error('Account is disabled');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email_hint||''))throw new Error('An expected Microsoft email is required');
  const entry=await startWorker(dataRoot,a);
  sendAuthentication(entry,'authorize',{},dataRoot,a);
  return {state:'authorizing',message:'请在运行本服务的电脑上完成微软授权窗口中的登录和 MFA 验证。'};
}
export async function beginAutomatedLogin(dataRoot,a){
  if(a.runtime_type!=='isolated'||!a.enabled)throw new Error('Account is not an enabled isolated profile');
  if(!hasAutoSecrets(dataRoot,a.id))throw new Error('No local password/TOTP credentials have been configured for this account');
  // Decrypt and validate BEFORE setting loginPending. On bad input the account
  // must remain retryable instead of getting stuck in 'authorizing'.
  const credentials=readCredentials(dataRoot,a.id)||JSON.parse(readFileSync(autoSecretPath(dataRoot,a.id),'utf8'));
  if(mail(credentials.email)!==mail(a.email_hint))throw Error('Credential identity mismatch');
  const entry=await startWorker(dataRoot,a);
  sendAuthentication(entry,'auto-authorize',{credentials},dataRoot,a);
  return {state:'authorizing',message:'已开始使用服务器本机配置的账号凭证尝试登录。如微软要求推送验证，须按其官方登录要求操作。'};
}
async function stopWorkerForCacheReload(id,force=false){
  const entry=runtimes.get(id);
  if(!entry)return;
  if(entry.loginPending&&!force)throw new Error('Account authorization in progress');
  runtimes.delete(id);
  if(entry.child.exitCode===null){
    entry.child.kill();
    await Promise.race([new Promise(resolve=>entry.child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,3000))]);
  }
}
export async function importExternalMsalCache(dataRoot,a,raw){
  if(a.runtime_type!=='isolated'||!a.enabled)throw new Error('只支持已经启用的独立微软账号');
  // Reject malformed/mismatched input before stopping a healthy account worker.
  validateCacheImport(raw,a.email_hint,a.tenant_hint||'');
  await stopWorkerForCacheReload(a.id);
  const result=saveImportedCache(dataRoot,a.id,a.email_hint,a.tenant_hint||'',raw);
  const entry=await startWorker(dataRoot,a);
  sendAuthentication(entry,'verify-cache',{},dataRoot,a,true);
  return {state:'authorizing',message:'完整 MSAL 缓存已写入专属账号目录。正在尝试静默获取 Token；请刷新授权状态，验证成功后再测试模型。',identity:result.email};
}
/** Store AT/RT directly; no implicit MSAL verification or refresh on import. */
export async function importExternalAtRt(dataRoot,a,at,rt){
  if(a.runtime_type!=='isolated'||!a.enabled)throw new Error('只支持已启用的独立微软账号');
  // Stop the previous worker so it does not keep an old token in memory.
  await stopWorkerForCacheReload(a.id,true);
  const saved=saveManualTokens(dataRoot,a.id,a.email_hint,a.tenant_hint||'',at,rt);
  const entry=await startWorker(dataRoot,a);
  entry.loginPending=false;
  return {state:'manual-ready-to-test',message:'AT/RT 已保存。点击「测试对话」用当前 AT 实际验证；仅在 Token 认证失败时尝试 RT 续期。',
    tokenFormat:saved.tokenFormat,accessExpiresAt:saved.expiresAt};
}

/** An explicit RT test/rotation, separate from expiry-triggered refresh. */
export async function refreshExternalAtRt(dataRoot,a){
  if(a.runtime_type!=='isolated'||!a.enabled||!hasManualTokens(dataRoot,a.id))
    throw Object.assign(new Error('该账号没有已保存的 AT/RT'),{status:409});
  await refreshManualToken(manualTokenPath(dataRoot,a.id));
  // A previously cached ChatHub app may be holding the old AT in memory.
  await stopWorkerForCacheReload(a.id,true);
  await startWorker(dataRoot,a);
  const token=statusManualTokens(dataRoot,a.id);
  return {ok:true,refreshed:true,tokenFormat:token?.format||'unknown',
    accessExpiresAt:token?.expiresAt||null,
    message:'RT 续期成功。新 AT 已保存，微软若返回轮换 RT 也已同步保存。请用测试对话验证新 AT。'};
}

export async function retryImportedCacheVerification(dataRoot,a){
  if(hasManualTokens(dataRoot,a.id))return {state:'manual-ready-to-test',message:'AT/RT 模式请使用「测试对话」验证，不需要 MSAL 缓存验证'};
  if(!cacheImportPending(dataRoot,a.id))throw new Error('没有等待验证的导入缓存');
  const entry=await startWorker(dataRoot,a);
  sendAuthentication(entry,'verify-cache',{},dataRoot,a,true);
  return {state:'authorizing',message:'正在重试验证已导入的 MSAL 缓存'};
}
export async function accountRequest(dataRoot,a,endpoint,options={},scope='internal'){
  if(!accountReady(dataRoot,a))throw new Error('Microsoft account not authorized or identity mismatch');
  const entry=await startWorker(dataRoot,a);
  const url=`http://127.0.0.1:${entry.port}${endpoint}`;
  return fetch(url,{method:options.method||'GET',headers:{'Content-Type':'application/json',
    'X-M365-Worker-Secret':entry.secret,'X-M365-Worker-Scope':scope},
    body:options.body,signal:options.signal,redirect:'manual'});
}
export async function unlinkAccount(dataRoot,a){
  const entry=runtimes.get(a.id);
  if(entry){
    const child=entry.child;child.kill();runtimes.delete(a.id);
    if(child.exitCode===null && child.signalCode===null)await new Promise(resolve=>{
      const timer=setTimeout(resolve,2000);
      child.once('exit',()=>{clearTimeout(timer);resolve();});
    });
  }
  const dir=accountDir(dataRoot,a.id);
  // Explicit unlink only: this deletes the account's stored MSAL cache and browser profile.
  rmSync(dir,{recursive:true,force:true});
  return true;
}
export function shutdownWorkers(){for(const e of runtimes.values())e.child.kill();runtimes.clear();}
