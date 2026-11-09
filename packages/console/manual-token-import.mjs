/**
 * Manual AT + RT import. A signed three-part JWT may expose account and expiry
 * claims. A five-part JWE is encrypted: its payload (aud/exp/oid/tid) cannot
 * be read by the client. Never manufacture those claims from a JWE header.
 *
 * The MSAL cache created here is a compatibility bridge, not a proof that the
 * remote resource accepts either credential. The worker must verify it with
 * Microsoft's token acquisition flow.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {saveImportedCache} from './msal-cache-import.mjs';
import {accountDir} from './account-paths.mjs';

export const SYDNEY_CLIENT_ID='c0ab8ce9-e9a0-42e7-b064-33d422df41f1';
const AUDIENCE='https://substrate.office.com/sydney';
const ENVIRONMENT='login.microsoftonline.com';
const TARGET=[AUDIENCE+'/M365Chat.Read',AUDIENCE+'/sydney.readwrite'].map(v=>v.toLowerCase()).sort().join(' ');
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reject=msg=>{throw Object.assign(new Error(msg),{status:400});};
const normalize=v=>String(v||'').trim().toLowerCase();
const entryKey=(...parts)=>parts.join('-').toLowerCase();
const bareObject=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const nowSeconds=()=>Math.floor(Date.now()/1000);

function parseJsonSegment(value){
  if(!/^[a-zA-Z0-9_-]+$/.test(value))reject('AT 的编码格式无效');
  try{return JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}
  catch{reject('无法解析 AT 头部或声明');}
}
export function inspectAccessToken(accessToken){
  if(typeof accessToken!=='string'||accessToken.length<100||accessToken.length>64000||/\s/.test(accessToken))
    reject('Access Token 格式或长度无效');
  const segments=accessToken.split('.');
  if(segments.length!==3&&segments.length!==5)reject('AT 应为 JWT（三段）或 JWE（五段）');
  if(segments.some(p=>!p))
    reject('AT 存在空白或缺失的编码段');
  const header=parseJsonSegment(segments[0]);
  if(!bareObject(header)||typeof header.alg!=='string'||header.alg==='none')reject('AT 头部无效');
  if(segments.length===5){
    if(typeof header.enc!=='string'||!header.enc||!segments[2]||!segments[3]||!segments[4])
      reject('AT 的 JWE 加密头部或结构无效');
    // Protected header metadata is not a validated resource claim.
    return {format:'jwe',claims:null,expiresAt:null};
  }
  const claims=parseJsonSegment(segments[1]);
  if(!bareObject(claims))reject('AT JWT 声明无效');
  return {format:'jwt',claims,expiresAt:Number.isSafeInteger(claims.exp)&&claims.exp>0?claims.exp:null};
}
function validateRefreshToken(rt){
  if(typeof rt!=='string'||rt.length<20||rt.length>64000||/\s/.test(rt))reject('Refresh Token 格式或长度无效');
}
function identityFromClaims(c,expectedEmail,expectedTenant){
  const email=normalize(expectedEmail),tid=normalize(c.tid),oid=normalize(c.oid);
  if(!GUID.test(tid)||!GUID.test(oid))reject('认证记录缺少有效的租户 tid 或账号 oid');
  if(GUID.test(expectedTenant)&&normalize(expectedTenant)!==tid)reject('租户 ID 与后台账号不一致');
  const tokenEmail=normalize(c.preferred_username||c.upn||c.unique_name||c.email);
  if(tokenEmail!==email)reject('认证记录的邮箱与后台账号不一致');
  return {email,tid,oid,name:String(c.name||'').slice(0,180)};
}
function identityFromCache(serialized,expectedEmail,expectedTenant){
  let cache;
  try{cache=typeof serialized==='string'?JSON.parse(serialized):serialized;}catch{reject('已有账号缓存无法解析');}
  const accounts=Object.values(cache?.Account||{});
  if(accounts.length!==1)reject('JWE 需要已关联的账号身份缓存，或使用 RT 自动获取身份信息');
  const a=accounts[0],home=String(a.homeAccountId||'').split('.');
  const oid=normalize(a.localAccountId||home[0]);
  const tid=normalize(a.realm||home[1]);
  return identityFromClaims({oid,tid,preferred_username:a.username,name:a.name},expectedEmail,expectedTenant);
}
/**
 * A JWE cannot prove its audience/expiry locally. With a known identity, place
 * it in an *already expired* MSAL AT entry: acquireTokenSilent MUST get a fresh
 * token using the RT, rather than accepting a fabricated JWE expiration time.
 */
export function buildMsalCacheFromTokens(accessToken,refreshToken,expectedEmail,expectedTenant='',options={}){
  const parsed=inspectAccessToken(accessToken);
  validateRefreshToken(refreshToken);
  const email=normalize(expectedEmail);
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))reject('账号档案的邮箱无效');
  let identity;
  if(parsed.format==='jwt'){
    const c=parsed.claims;
    const audience=Array.isArray(c.aud)?c.aud:[c.aud];
    if(!audience.includes(AUDIENCE))reject('AT 的 aud 不是 Sydney 服务');
    identity=identityFromClaims(c,email,expectedTenant);
    const clientId=normalize(c.azp||c.appid);
    if(clientId&&clientId!==SYDNEY_CLIENT_ID)reject('AT 的 OAuth 客户端与现有项目不匹配');
    if(!parsed.expiresAt)reject('AT 缺少有效 exp');
    if(Number.isSafeInteger(c.nbf)&&c.nbf>nowSeconds()+300)reject('AT 尚未生效');
    const scopes=String(c.scp||'').toLowerCase().split(/\s+/);
    if(!scopes.some(s=>s==='m365chat.read'||s==='sydney.readwrite'||s.endsWith('/m365chat.read')||s.endsWith('/sydney.readwrite')))
      reject('AT 未包含可识别的 Sydney 委托权限');
  }else{
    if(options.identity)identity=identityFromClaims(options.identity,email,expectedTenant);
    else if(options.existingCache)identity=identityFromCache(options.existingCache,email,expectedTenant);
    else reject('JWE 是加密 AT，无法从 AT/RT 两段字符串读出 oid/tid；需要先由 RT 获取身份信息');
  }
  const {tid,oid,name}=identity;
  const accountId=oid+'.'+tid,realm=tid,environment=ENVIRONMENT;
  const accountKey=entryKey(accountId,environment,realm);
  const atKey=entryKey(accountId,environment,'accesstoken',SYDNEY_CLIENT_ID,realm,TARGET);
  const rtKey=entryKey(accountId,environment,'refreshtoken',SYDNEY_CLIENT_ID,'','');
  // JWE expiry/audience are unknown: force MSAL to obtain a new AT via RT.
  const exp=parsed.format==='jwt'?parsed.expiresAt:1;
  const cachedAt=parsed.format==='jwt'&&Number.isSafeInteger(parsed.claims.iat)&&parsed.claims.iat>0?
    parsed.claims.iat:Math.max(1,exp-3600);
  const access={homeAccountId:accountId,environment,credentialType:'AccessToken',clientId:SYDNEY_CLIENT_ID,
    secret:accessToken,realm,target:TARGET,cachedAt:String(cachedAt),expiresOn:String(exp),extendedExpiresOn:String(exp),tokenType:'Bearer'};
  const refresh={homeAccountId:accountId,environment,credentialType:'RefreshToken',clientId:SYDNEY_CLIENT_ID,secret:refreshToken};
  const cache={Account:{[accountKey]:{homeAccountId:accountId,environment,realm,localAccountId:oid,
    username:email,authorityType:'MSSTS',name}},IdToken:{},AccessToken:{[atKey]:access},RefreshToken:{[rtKey]:refresh},AppMetadata:{}};
  return {cache:JSON.stringify(cache),email,tenant:tid,accessExpiresAt:parsed.expiresAt,tokenFormat:parsed.format};
}

/**
 * If the account has no previous identity, ask the real Microsoft OAuth
 * service for an OIDC identity token using the provided RT. No extra form field.
 * This is *not* proof of access to the Sydney ChatHub resource.
 */
export async function identityFromRefreshToken(refreshToken,expectedEmail,expectedTenant='',options={}){
  validateRefreshToken(refreshToken);
  const fetcher=options.fetcher||fetch;
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),Math.min(30000,Math.max(1000,options.timeoutMs||12000)));
  try{
    const response=await fetcher('https://login.microsoftonline.com/common/oauth2/v2.0/token',{
      method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},signal:controller.signal,
      body:new URLSearchParams({client_id:SYDNEY_CLIENT_ID,grant_type:'refresh_token',refresh_token:refreshToken,scope:'openid profile offline_access'})
    });
    if(!response.ok)reject('RT 无法获取账号身份信息：请核对它与 OAuth 客户端的授权关系');
    const body=await response.json();
    const idToken=body?.id_token;
    if(typeof idToken!=='string'||idToken.split('.').length!==3)reject('RT 刷新响应没有可解析的 ID Token');
    const claims=parseJsonSegment(idToken.split('.')[1]);
    if(normalize(claims.aud)!==SYDNEY_CLIENT_ID)reject('ID Token 的客户端不匹配');
    const identity=identityFromClaims(claims,expectedEmail,expectedTenant);
    // MSAL refreshes may rotate the RT. Prefer the latest returned one.
    return {identity,refreshToken:typeof body.refresh_token==='string'&&body.refresh_token.length>20?body.refresh_token:refreshToken};
  }catch(e){if(e?.name==='AbortError')reject('RT 账号身份请求超时');throw e;}
  finally{clearTimeout(timeout);}
}
export function readExistingAccountCache(root,id){
  try{return readFileSync(join(accountDir(root,id),'msal-cache.json'),'utf8');}
  catch{return null;}
}
export function saveManualTokens(root,id,expectedEmail,expectedTenant,at,rt){
  const previous=readExistingAccountCache(root,id);
  const built=buildMsalCacheFromTokens(at,rt,expectedEmail,expectedTenant,previous?{existingCache:previous}:{});
  saveImportedCache(root,id,expectedEmail,expectedTenant,built.cache);
  return {email:built.email,tenant:built.tenant,accessExpiresAt:built.accessExpiresAt,tokenFormat:built.tokenFormat};
}
