/**
 * Validate serialized MSAL (Node) caches before a privileged, interactive-only import.
 * An AT/RT pair alone is NOT a complete cache: this preserves the account/client/scope
 * metadata MSAL needs. Never log or return this payload to a browser after import.
 */
import {randomBytes} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,writeFileSync,renameSync,rmSync,chmodSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {accountDir} from './account-paths.mjs';

const email=v=>String(v||'').trim().toLowerCase();
const tenant=v=>String(v||'').trim().toLowerCase();
const tenantGuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bareObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const reject=(msg)=>{throw Object.assign(new Error(msg),{status:400});};

export function cacheImportPending(root,id){return existsSync(join(accountDir(root,id),'cache-import-pending'));}
export function clearCacheImportPending(root,id){rmSync(join(accountDir(root,id),'cache-import-pending'),{force:true});}

export function validateCacheImport(serialized,expectedEmail,expectedTenant=''){
  if(typeof serialized!=='string'||Buffer.byteLength(serialized,'utf8')>1024*1024||serialized.length<20)
    reject('MSAL 缓存不能为空，且不能超过 1 MB');
  let parsed;
  try{parsed=JSON.parse(serialized);}catch{reject('请填写完整且有效的 MSAL JSON 缓存');}
  if(!bareObject(parsed))reject('MSAL 缓存必须是 JSON 对象');
  const accounts=Object.values(parsed.Account||{});
  if(accounts.length!==1||!bareObject(accounts[0]))reject('MSAL 缓存必须恰好包含一个账户');
  const a=accounts[0];
  if(!expectedEmail||email(a.username)!==email(expectedEmail))reject('导入缓存的微软账号与当前档案邮箱不一致');
  const realm=tenant(a.realm||a.tenantId);
  if(!realm)reject('MSAL 账户缺少租户信息');
  if(tenantGuid.test(expectedTenant)&&realm!==tenant(expectedTenant))reject('导入缓存的租户 ID 不匹配');
  const homeId=String(a.homeAccountId||'');
  const environment=String(a.environment||'');
  if(!homeId||!environment||homeId.length>300||environment.length>300)reject('MSAL 账户缺少关联身份信息');
  const access=Object.values(parsed.AccessToken||{}),refresh=Object.values(parsed.RefreshToken||{});
  if(!access.length||!refresh.length)reject('需要包含完整的 MSAL AT、RT 缓存记录，不支持只粘贴两段 Token');
  const linked=v=>bareObject(v)&&v.homeAccountId===homeId&&v.environment===environment&&typeof v.clientId==='string'&&v.clientId.length>0&&typeof v.secret==='string'&&v.secret.length>20;
  const accessLinked=access.filter(linked),refreshLinked=refresh.filter(linked);
  if(!accessLinked.length||!refreshLinked.length)reject('AT、RT 记录与该 MSAL 账号不一致');
  if(!accessLinked.some(at=>refreshLinked.some(rt=>at.clientId===rt.clientId)))reject('AT 与 RT 不属于同一个 OAuth 客户端');
  // Other accounts/tokens must not be smuggled into an isolated account's cache.
  for(const collection of ['IdToken','AccessToken','RefreshToken']){
    for(const entry of Object.values(parsed[collection]||{})){
      if(!bareObject(entry)||entry.homeAccountId!==homeId||entry.environment!==environment)
        reject('缓存包含其他账户或无效凭证记录');
    }
  }
  return {raw:JSON.stringify(parsed),email:email(a.username),tenant:realm};
}

export function saveImportedCache(root,id,expectedEmail,expectedTenant,serialized){
  const cache=validateCacheImport(serialized,expectedEmail,expectedTenant);
  const dir=accountDir(root,id);mkdirSync(dir,{recursive:true,mode:0o700});
  try{chmodSync(dir,0o700);}catch{}
  const target=join(dir,'msal-cache.json'),flag=join(dir,'cache-import-pending');
  if(existsSync(target)&&lstatSync(target).isSymbolicLink())reject('不允许写入符号链接缓存');
  if(existsSync(flag)&&lstatSync(flag).isSymbolicLink())reject('导入标记路径无效');
  const temporary=join(dir,'.msal-import-'+randomBytes(12).toString('hex'));
  try{
    // Flag first: imported credentials cannot be used before getToken() verification.
    writeFileSync(flag,'pending',{mode:0o600,flag:'w'});
    writeFileSync(temporary,cache.raw,{mode:0o600,flag:'wx'});
    renameSync(temporary,target);
    try{chmodSync(target,0o600);}catch{}
  }finally{rmSync(temporary,{force:true});}
  return {email:cache.email,tenant:cache.tenant};
}

export function importedCacheState(root,id){
  if(cacheImportPending(root,id))return 'verification-required';
  try{readFileSync(join(accountDir(root,id),'msal-cache.json'));return 'cached';}
  catch{return 'not-linked';}
}
