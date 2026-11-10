/** External AT/RT mode. Credentials are supplied explicitly by the account admin.
 * This is separate from the interactive MSAL cache, so an opaque JWE token
 * does not get discarded just because its claims cannot be decoded locally.
 */
import {readFileSync,writeFileSync,renameSync,mkdirSync,chmodSync,unlinkSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {accountDir} from './account-paths.mjs';

// Validated by the account owner with a real RT -> Sydney AT exchange.
// Individual accounts may use another clientId, inferred from their JWT AT
// and stored on import; do not replace an existing, known account clientId.
const DEFAULT_CLIENT_ID='4765445b-32c6-49b0-83e6-1d93765276ca';
const TOKEN_ORIGIN='https://m365.cloud.microsoft';
const SYDNEY_AUDIENCE='https://substrate.office.com/sydney';
const CHAT_SCOPE='https://substrate.office.com/sydney/M365Chat.Read https://substrate.office.com/sydney/sydney.readwrite openid profile offline_access';
const GUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const inFlight=new Map();
const invalid=(reason)=>Object.assign(new Error(reason),{status:400});
const norm=v=>String(v||'').trim().toLowerCase();
export const manualTokenPath=(root,id)=>join(accountDir(root,id),'manual-at-rt.json');

function claimsFromThreePartJWT(token){
  const p=token.split('.');if(p.length!==3)return null;
  try{
    const claims=JSON.parse(Buffer.from(p[1],'base64url').toString('utf8'));
    return claims&&typeof claims==='object'&&!Array.isArray(claims)?claims:null;
  }catch{return null;}
}
function tokenContext(token){
  const c=claimsFromThreePartJWT(String(token||''));
  return c?{
    oid:GUID.test(String(c.oid||''))?norm(c.oid):'',
    tenant:GUID.test(String(c.tid||''))?norm(c.tid):'',
    email:norm(c.upn||c.preferred_username||c.unique_name||''),
    appid:GUID.test(String(c.appid||c.azp||''))?norm(c.appid||c.azp):'',
    audience:String(c.aud||''),
  }:null;
}
function oauthClientId(info,old){
  return info?.appid||(GUID.test(String(old?.oauthClientId||''))?norm(old.oauthClientId):DEFAULT_CLIENT_ID);
}
function assertTokenIdentity(info,expectedEmail,expectedTenant,expectedOid){
  if(!info)return;
  if(info.email && expectedEmail && info.email!==norm(expectedEmail))throw invalid('AT 所属邮箱与后台账号不一致');
  if(info.tenant && GUID.test(String(expectedTenant||''))&&info.tenant!==norm(expectedTenant))throw invalid('AT 所属租户与后台账号不一致');
  if(info.oid && GUID.test(String(expectedOid||''))&&info.oid!==norm(expectedOid))throw invalid('AT 所属微软身份与后台账号不一致');
}
function oauthErrorDetail(response,status){
  const kind=String(response?.error||'oauth_error').replace(/[^a-z0-9_]/gi,'').slice(0,48);
  const ids=Array.isArray(response?.error_codes)?response.error_codes.filter(x=>Number.isInteger(x)).slice(0,3):[];
  // Never echo any credential or a long token-like string from an upstream error.
  const detail=String(response?.error_description||'').replace(/[a-zA-Z0-9_\-\.]{90,}/g,'[REDACTED]').replace(/[\r\n\t]+/g,' ').slice(0,320);
  return `微软续期失败（HTTP ${status}，${kind}${ids.length?', AADSTS '+ids.join(', '):''}）${detail?'：'+detail:''}`;
}
export function inspectAccessToken(token){
  const parts=typeof token==='string'?token.split('.'):[];
  if(typeof token!=='string'||token.length<40||token.length>90000||/\s/.test(token)||![3,5].includes(parts.length)||parts.some(x=>!x))throw invalid('AT 必须是非空 JWT/JWE 令牌');
  const format=parts.length===5?'JWE':'JWT';
  const claims=format==='JWT'?claimsFromThreePartJWT(token):null;
  const exp=Number(claims?.exp);
  return {format,expiresAt:Number.isSafeInteger(exp)&&exp>0?exp:null};
}
function cachedAccountContext(root,id,email){
  try{
    const cache=JSON.parse(readFileSync(join(accountDir(root,id),'msal-cache.json'),'utf8'));
    const entries=Object.values(cache.Account||{});
    if(entries.length!==1)return null;
    const a=entries[0];
    if(norm(a.username)!==email)return null;
    const home=String(a.homeAccountId||'');
    const oid=home.split('.')[0];
    return {oid:GUID.test(oid)?norm(oid):'',tenant:GUID.test(a.realm)?norm(a.realm):''};
  }catch{return null;}
}
function readToken(file){
  try{const data=JSON.parse(readFileSync(file,'utf8'));
    if(typeof data.accessToken!=='string'||typeof data.refreshToken!=='string'||!data.email)return null;
    return data;
  }catch{return null;}
}
export function hasManualTokens(root,id){return !!readToken(manualTokenPath(root,id));}
export function statusManualTokens(root,id){
  const t=readToken(manualTokenPath(root,id));
  if(!t)return null;
  return {mode:'at-rt',format:t.format||'unknown',expiresAt:t.expiresAt||null,hasRefreshToken:true};
}
function persist(file,data){
  mkdirSync(dirname(file),{recursive:true,mode:0o700});
  const tmp=file+'.'+randomBytes(8).toString('hex')+'.tmp';
  try{writeFileSync(tmp,JSON.stringify(data),{mode:0o600,flag:'wx'});chmodSync(tmp,0o600);renameSync(tmp,file);}catch(e){try{unlinkSync(tmp);}catch{}throw e;}
}
export function saveManualTokens(root,id,expectedEmail,expectedTenant,accessToken,refreshToken){
  const details=inspectAccessToken(accessToken);
  if(typeof refreshToken!=='string'||refreshToken.length<20||refreshToken.length>90000||/\s/.test(refreshToken))throw invalid('RT 格式或长度无效');
  const email=norm(expectedEmail),tenant=norm(expectedTenant);
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw invalid('后台微软账号邮箱无效');
  const file=manualTokenPath(root,id);
  const old=readToken(file);
  const cached=cachedAccountContext(root,id,email);
  const access=tokenContext(accessToken);
  const resolvedTenant=GUID.test(tenant)?tenant:access?.tenant||cached?.tenant||old?.tenant||'';
  const resolvedOid=access?.oid||cached?.oid||old?.oid||'';
  assertTokenIdentity(access,email,resolvedTenant,old?.oid);
  const data={version:1,mode:'at-rt',email,tenant:resolvedTenant,
    accessToken,refreshToken,format:details.format,expiresAt:details.expiresAt,receivedAt:Date.now(),
    oid:resolvedOid,oauthClientId:oauthClientId(access,old),oauthScope:old?.oauthScope||CHAT_SCOPE,
    lastVerifiedAt:null};
  persist(file,data);
  return {mode:'at-rt',tokenFormat:details.format,expiresAt:details.expiresAt};
}
export function manualIdentity(file){const t=readToken(file);return t?{email:t.email,tenant:t.tenant,oid:t.oid}:null;}
function decodeIdToken(token){
  const c=claimsFromThreePartJWT(String(token||''));
  if(!c||!GUID.test(c.oid)||!GUID.test(c.tid))return null;
  return {oid:norm(c.oid),tenant:norm(c.tid),email:norm(c.preferred_username||c.upn||'')};
}
export async function refreshManualToken(file,fetcher=fetch){
  if(inFlight.has(file))return inFlight.get(file);
  const promise=(async()=>{
    const original=readToken(file);if(!original)throw new Error('未找到已保存的 AT/RT');
    // The token endpoint issues a new AT for the resource requested by this app.
    const authority=GUID.test(original.tenant)?original.tenant:'common';
    const url=`https://login.microsoftonline.com/${authority}/oauth2/v2.0/token`;
    const clientId=oauthClientId(tokenContext(original.accessToken),original);
    const body=new URLSearchParams({grant_type:'refresh_token',client_id:clientId,
      refresh_token:original.refreshToken,scope:original.oauthScope||CHAT_SCOPE});
    let r;
    try{r=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:TOKEN_ORIGIN},body,signal:AbortSignal.timeout(25000)});}
    catch(e){throw new Error(e?.name==='TimeoutError'?'微软 Token 接口超时':'无法连接微软 Token 接口');}
    let answer;try{answer=await r.json();}catch{throw new Error(`微软 Token 接口返回非 JSON（HTTP ${r.status}）`);}
    if(!r.ok||typeof answer.access_token!=='string'){
      throw new Error(oauthErrorDetail(answer,r.status));
    }
    const current=readToken(file);
    // Do not overwrite newer credentials that may have been saved meanwhile.
    if(!current||current.refreshToken!==original.refreshToken)throw new Error('RT 已被其他操作更换，请重试');
    const parsed=inspectAccessToken(answer.access_token);
    const expires=Number(answer.expires_in);
    const expiresAt=Number.isFinite(expires)&&expires>0?Math.floor(Date.now()/1000)+Math.floor(expires):parsed.expiresAt;
    const id=decodeIdToken(answer.id_token);
    const access=tokenContext(answer.access_token);
    assertTokenIdentity(access,current.email,current.tenant,current.oid);
    if(access?.audience && access.audience!==SYDNEY_AUDIENCE)throw new Error('续期返回的 AT 不是 Sydney 受众，不覆盖现有 AT/RT');
    if(access?.appid && access.appid!==clientId)throw new Error('续期返回的 AT 客户端不匹配，不覆盖现有 AT/RT');
    if(id&&id.email&&id.email!==current.email)throw new Error('续期所得账号与后台账号不匹配');
    if(id&&current.tenant&&id.tenant!==current.tenant)throw new Error('续期所得租户与后台配置不匹配');
    persist(file,{...current,accessToken:answer.access_token,refreshToken:answer.refresh_token||current.refreshToken,
      format:parsed.format,expiresAt,receivedAt:Date.now(),oid:access?.oid||id?.oid||current.oid,
      tenant:access?.tenant||id?.tenant||current.tenant,
      oauthClientId:clientId,oauthScope:current.oauthScope||CHAT_SCOPE,lastVerifiedAt:null});
    return answer.access_token;
  })();
  inFlight.set(file,promise);try{return await promise;}finally{inFlight.delete(file);}
}
export async function getManualAccessToken(file){
  const t=readToken(file);if(!t)throw new Error('未找到已保存的 AT/RT');
  const now=Math.floor(Date.now()/1000);
  if(t.expiresAt&&t.expiresAt<now+120)return refreshManualToken(file);
  return t.accessToken;
}
export function markManualVerified(file){
  const t=readToken(file);if(t)persist(file,{...t,lastVerifiedAt:Date.now()});
}
