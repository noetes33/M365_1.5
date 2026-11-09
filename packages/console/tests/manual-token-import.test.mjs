import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildMsalCacheFromTokens,saveManualTokens,SYDNEY_CLIENT_ID} from '../manual-token-import.mjs';
const tid='22222222-2222-2222-2222-222222222222';
const oid='33333333-3333-3333-3333-333333333333';
const email='owner@example.edu';
const rt='TEST_ONLY_REFRESH_TOKEN_AAAAAAAAAAAAAAAA';
function token(overrides={}){
 const h=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url');
 const p=Buffer.from(JSON.stringify({aud:'https://substrate.office.com/sydney',tid,oid,
  preferred_username:email,scp:'M365Chat.Read sydney.readwrite',appid:SYDNEY_CLIENT_ID,
  exp:Math.floor(Date.now()/1000)+3600,iat:Math.floor(Date.now()/1000),...overrides})).toString('base64url');
 return `${h}.${p}.${'z'.repeat(80)}`;
}
test('direct AT RT import creates complete isolated MSAL cache without needing JSON input',()=>{
 const at=token();const x=buildMsalCacheFromTokens(at,rt,email,tid);
 const cache=JSON.parse(x.cache);
 assert.equal(Object.values(cache.Account)[0].username,email);
 assert.equal(Object.values(cache.Account)[0].homeAccountId,oid+'.'+tid);
 assert.equal(Object.values(cache.AccessToken)[0].secret,at);
 assert.equal(Object.values(cache.RefreshToken)[0].secret,rt);
 assert.equal(Object.values(cache.RefreshToken)[0].clientId,SYDNEY_CLIENT_ID);
 assert.ok(Object.values(cache.AccessToken)[0].target.includes('m365chat.read'));
 assert.ok(!JSON.stringify({email:x.email,tenant:x.tenant}).includes(rt));
});
test('rejects wrong audience, user identity, tenant, client and missing token',()=>{
 for(const claims of [{aud:'https://graph.microsoft.com'},{preferred_username:'someone-else@example.edu'},
  {tid:'44444444-4444-4444-4444-444444444444'},
  {appid:'55555555-5555-5555-5555-555555555555'},{scp:'User.Read'}]){
  assert.throws(()=>buildMsalCacheFromTokens(token(claims),rt,email,tid));
 }
 assert.throws(()=>buildMsalCacheFromTokens(token(),'short',email,tid));
 assert.throws(()=>buildMsalCacheFromTokens('not-a-jwt',rt,email,tid));
});
test('writes restrictive cache file and never exposes tokens in return value',()=>{
 const dir=mkdtempSync(join(tmpdir(),'m365-atrt-'));
 try{
  const id='11111111-1111-1111-1111-111111111111';
  const out=saveManualTokens(dir,id,email,tid,token(),rt);
  const path=join(dir,'identity-profiles',id,'msal-cache.json');
  assert.ok(JSON.stringify(readFileSync(path,'utf8')).includes(rt));
  assert.ok(!JSON.stringify(out).includes(rt));
  if(process.platform!=='win32')assert.equal(statSync(path).mode&0o777,0o600);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
