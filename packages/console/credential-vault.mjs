/** Admin-only credential vault for accounts the operator is authorized to manage.
 * This is NOT an OAuth authorization server. Credentials are encrypted at rest
 * using a local AES-256-GCM master key, and never returned by HTTP endpoints.
 */
import crypto from 'node:crypto';
import {join} from 'node:path';
import {existsSync,readFileSync,writeFileSync,mkdirSync,chmodSync,renameSync,rmSync,lstatSync,openSync,closeSync} from 'node:fs';
import {accountDir,autoSecretPath} from './account-paths.mjs';
const KEY_NAME='identity-vault.key';
const bad=()=>new Error('Credential vault unavailable');
function master(root){
  mkdirSync(root,{recursive:true,mode:0o700});
  const p=join(root,KEY_NAME);
  if(existsSync(p)){
    if(lstatSync(p).isSymbolicLink())throw bad();
    const key=readFileSync(p);if(key.length!==32)throw bad();return key;
  }
  const key=crypto.randomBytes(32);
  try{const fd=openSync(p,'wx',0o600);try{writeFileSync(fd,key);}finally{closeSync(fd);}return key;}
  catch(e){if(e.code==='EEXIST'){const read=readFileSync(p);if(read.length===32)return read;}throw bad();}
}
export function vaultPath(root,id){return join(accountDir(root,id),'credentials.enc');}
export function vaultPresent(root,id){try{return existsSync(vaultPath(root,id));}catch{return false;}}
export function saveCredentials(root,id,expectedEmail,password,rawSeed){
  if(typeof password!=='string'||password.length<1||password.length>512)throw Error('密码长度无效');
  if(typeof rawSeed!=='string')throw Error('TOTP 种子无效');
  const mfaSecret=rawSeed.replace(/[\s-]/g,'').toUpperCase();
  if(!/^[A-Z2-7]{16,128}$/.test(mfaSecret))throw Error('请填写 TOTP Base32 种子，不是六位动态码');
  const email=String(expectedEmail||'').trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw Error('账号邮箱无效');
  const key=master(root), iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from(id));
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify({email,password,mfaSecret}),'utf8'),cipher.final()]);
  const tag=cipher.getAuthTag(),data=JSON.stringify({v:1,iv:iv.toString('base64'),tag:tag.toString('base64'),ciphertext:ciphertext.toString('base64')});
  const dir=accountDir(root,id);mkdirSync(dir,{recursive:true,mode:0o700});
  try{chmodSync(dir,0o700);}catch{}
  const p=vaultPath(root,id);
  if(existsSync(p)&&lstatSync(p).isSymbolicLink())throw bad();
  const temp=join(dir,'.vault-'+crypto.randomBytes(12).toString('hex'));
  try{const fd=openSync(temp,'wx',0o600);try{writeFileSync(fd,data,'utf8');}finally{closeSync(fd);}renameSync(temp,p);try{chmodSync(p,0o600);}catch{}}
  finally{rmSync(temp,{force:true});}
  // A successful encrypted save supersedes older plaintext CLI provisioning.
  rmSync(autoSecretPath(root,id),{force:true});
}
export function readCredentials(root,id){
  if(!vaultPresent(root,id))return null;
  const encoded=JSON.parse(readFileSync(vaultPath(root,id),'utf8'));
  if(encoded.v!==1)throw bad();
  try{
    const cipher=crypto.createDecipheriv('aes-256-gcm',master(root),Buffer.from(encoded.iv,'base64'));
    cipher.setAAD(Buffer.from(id));cipher.setAuthTag(Buffer.from(encoded.tag,'base64'));
    const plain=Buffer.concat([cipher.update(Buffer.from(encoded.ciphertext,'base64')),cipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  }catch{throw bad();}
}
export function eraseCredentials(root,id){
  rmSync(vaultPath(root,id),{force:true});
  rmSync(autoSecretPath(root,id),{force:true});
}
