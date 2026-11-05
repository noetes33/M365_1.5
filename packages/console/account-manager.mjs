/** Isolated account workers. Each Microsoft identity runs in its own process and MSAL cache.
 * No access tokens, passwords, or MFA material are exposed to the management API.
 */
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdirSync, readFileSync, existsSync, rmSync, chmodSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {accountDir,autoSecretPath} from './account-paths.mjs';
import {vaultPresent,readCredentials} from './credential-vault.mjs';
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
  const base=identityStatus(a,cachedIdentity(dataRoot,a.id));
  const running=runtimes.get(a.id);
  if(!running)return {...base,worker:'stopped',autoLoginConfigured:a.runtime_type==='isolated'&&hasAutoSecrets(dataRoot,a.id)};
  return {...base,worker:running.child.exitCode===null?'running':'stopped',
    state:running.authError? 'error':running.loginPending?'authorizing':running.verified && base.state==='cached'?'authorized':base.state,
    error:running.authError||null,autoLoginConfigured:a.runtime_type==='isolated'&&hasAutoSecrets(dataRoot,a.id)};
}
export function accountReady(dataRoot,a){
  const s=accountStatus(dataRoot,a);
  return (s.state==='cached'||s.state==='authorized') && !!a.enabled;
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
    M365_LOG_FILE:join(dir,'worker.log'),M365_FRAME_DIR:join(dir,'frames')
  };
  delete env.M365_ADMIN_PASSWORD;delete env.M365_ADMIN_DATA;
  const child=spawn(process.execPath,[WORKER],{cwd:ROOT,env,stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
  const entry={child,secret,port:null,loginPending:false,verified:false,authError:null,readyPromise:null};
  runtimes.set(a.id,entry);
  // Upstream can be noisy and include sensitive error text. Never relay logs to the browser.
  child.stderr.on('data',()=>{});
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
export async function beginAuthorizedLogin(dataRoot,a){
  if(!a.enabled)throw new Error('Account is disabled');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email_hint||''))throw new Error('An expected Microsoft email is required');
  const entry=await startWorker(dataRoot,a);
  if(entry.loginPending)throw new Error('An authorization is already in progress');
  entry.loginPending=true;entry.authError=null;
  // Deliberately no login URL or OAuth code returned to the web page. The upstream
  // opens a local visible browser and the user completes Microsoft authentication.
  entry.child.once('message',function onAuth(m){
    if(m?.type!=='auth-result'){
      entry.child.once('message',onAuth);return;
    }
    entry.loginPending=false;entry.verified=!!m.ok;
    if(!m.ok)entry.authError=String(m.error||'Authorization failed').slice(0,160);
  });
  entry.child.send({type:'authorize'});
  return {state:'authorizing',message:'请在运行本服务的电脑上完成微软授权窗口中的登录和 MFA 验证。'};
}
export async function beginAutomatedLogin(dataRoot,a){
  if(a.runtime_type!=='isolated'||!a.enabled)throw new Error('Account is not an enabled isolated profile');
  if(!hasAutoSecrets(dataRoot,a.id))throw new Error('No local password/TOTP credentials have been configured for this account');
  const entry=await startWorker(dataRoot,a);
  if(entry.loginPending)throw new Error('An authorization is already in progress');
  entry.loginPending=true;entry.authError=null;
  entry.child.once('message',function onAuth(m){
    if(m?.type!=='auth-result'){entry.child.once('message',onAuth);return;}
    entry.loginPending=false;entry.verified=!!m.ok;
    if(!m.ok)entry.authError=String(m.error||'Authorization failed').slice(0,160);
  });
  // Encrypted records are decrypted only in memory; the isolated worker creates
  // a temporary file for the upstream module while login is in progress.
  const credentials=readCredentials(dataRoot,a.id)||JSON.parse(readFileSync(autoSecretPath(dataRoot,a.id),'utf8'));
  if(credentials.email?.toLowerCase()!==a.email_hint?.toLowerCase())throw Error('Credential identity mismatch');
  entry.child.send({type:'auto-authorize',credentials});
  return {state:'authorizing',message:'已开始使用服务器本机配置的账号凭证尝试登录。若需要额外 MFA，请改用本机授权。'};
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
