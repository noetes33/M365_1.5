/** Manual AT + RT entry for an account that the administrator owns or is authorized to use.
 * The form accepts exactly two OAuth token strings. We transform them into an
 * isolated MSAL cache so the existing core can handle acquireTokenSilent().
 * Decoding JWT claims is NOT signature verification; the first real upstream
 * request must still validate the access token with Microsoft.
 */
import {saveImportedCache} from './msal-cache-import.mjs';

export const SYDNEY_CLIENT_ID='c0ab8ce9-e9a0-42e7-b064-33d422df41f1';
const AUDIENCE='https://substrate.office.com/sydney';
const ENVIRONMENT='login.microsoftonline.com';
const TARGET=[AUDIENCE+'/M365Chat.Read',AUDIENCE+'/sydney.readwrite']
  .map(v=>v.toLowerCase()).sort().join(' ');
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reject=msg=>{throw Object.assign(new Error(msg),{status:400});};
const normalize=v=>String(v||'').trim().toLowerCase();
const entryKey=(...parts)=>parts.join('-').toLowerCase();

function claimsFromJwt(token){
  if(typeof token!=='string'||token.length<100||token.length>64000||/\s/.test(token))
    reject('Access Token 格式或长度无效');
  const parts=token.split('.');
  if(parts.length!==3||!parts.every(Boolean))reject('Access Token 不是三段式 JWT');
  let header,claims;
  try{
    header=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));
    claims=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));
  }catch{reject('无法解析 Access Token 的 JWT 信息');}
  if(!header||typeof header!=='object'||header.alg==='none'||!claims||typeof claims!=='object'||Array.isArray(claims))
    reject('Access Token JWT 信息无效');
  return claims;
}

/** Return a MSAL-format cache, containing ONLY the two supplied tokens. */
export function buildMsalCacheFromTokens(accessToken,refreshToken,expectedEmail,expectedTenant=''){
  const c=claimsFromJwt(accessToken);
  if(typeof refreshToken!=='string'||refreshToken.length<20||refreshToken.length>64000||/\s/.test(refreshToken))
    reject('Refresh Token 格式或长度无效');
  const email=normalize(expectedEmail);
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))reject('账号档案的邮箱无效');
  // A Sydney access token must be scoped to Microsoft's Sydney resource.
  const audience=Array.isArray(c.aud)?c.aud:[c.aud];
  if(!audience.includes(AUDIENCE))reject('AT 的 aud 不是 Sydney 服务，请填写 Sydney Access Token');
  const tid=normalize(c.tid),oid=normalize(c.oid);
  if(!GUID.test(tid)||!GUID.test(oid))reject('AT 中缺少有效的微软租户 tid 或账号 oid');
  if(GUID.test(expectedTenant)&&normalize(expectedTenant)!==tid)reject('AT 租户与当前账号档案不一致');
  const tokenEmail=normalize(c.preferred_username||c.upn||c.unique_name||c.email);
  if(!tokenEmail||tokenEmail!==email)reject('AT 的账号邮箱与后台账号不一致，或 AT 缺少可核对的邮箱');
  const clientId=normalize(c.azp||c.appid);
  if(clientId&&clientId!==SYDNEY_CLIENT_ID)reject('AT 来自不同的 OAuth 客户端，无法与当前核心的续期配置匹配');
  if(!Number.isSafeInteger(c.exp)||c.exp<=0)reject('AT 缺少有效的 exp 到期信息');
  if(Number.isSafeInteger(c.nbf)&&c.nbf>Math.floor(Date.now()/1000)+300)reject('AT 尚未生效');
  const scopes=String(c.scp||'').toLowerCase().split(/\s+/);
  if(!scopes.some(s=>s==='m365chat.read'||s==='sydney.readwrite'||s.endsWith('/m365chat.read')||s.endsWith('/sydney.readwrite')))
    reject('AT 未包含可识别的 Sydney 委托权限');
  const accountId=oid+'.'+tid,realm=tid,environment=ENVIRONMENT;
  const accountKey=entryKey(accountId,environment,realm);
  const atKey=entryKey(accountId,environment,'accesstoken',SYDNEY_CLIENT_ID,realm,TARGET);
  const rtKey=entryKey(accountId,environment,'refreshtoken',SYDNEY_CLIENT_ID,'','');
  const cachedAt=String(Number.isSafeInteger(c.iat)&&c.iat>0?c.iat:Math.max(1,c.exp-3600));
  const access={homeAccountId:accountId,environment,credentialType:'AccessToken',clientId:SYDNEY_CLIENT_ID,
    secret:accessToken,realm,target:TARGET,cachedAt,expiresOn:String(c.exp),extendedExpiresOn:String(c.exp),tokenType:'Bearer'};
  const refresh={homeAccountId:accountId,environment,credentialType:'RefreshToken',clientId:SYDNEY_CLIENT_ID,
    secret:refreshToken};
  const cache={Account:{[accountKey]:{homeAccountId:accountId,environment,realm,localAccountId:oid,
    username:email,authorityType:'MSSTS',name:String(c.name||'').slice(0,180)}},
    IdToken:{},AccessToken:{[atKey]:access},RefreshToken:{[rtKey]:refresh},AppMetadata:{}};
  return {cache:JSON.stringify(cache),email,tenant:tid,accessExpiresAt:c.exp};
}

export function saveManualTokens(root,id,expectedEmail,expectedTenant,at,rt){
  const built=buildMsalCacheFromTokens(at,rt,expectedEmail,expectedTenant);
  saveImportedCache(root,id,expectedEmail,expectedTenant,built.cache);
  return {email:built.email,tenant:built.tenant,accessExpiresAt:built.accessExpiresAt};
}
