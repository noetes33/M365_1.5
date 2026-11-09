import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
 inspectAccessToken,buildMsalCacheFromTokens,identityFromRefreshToken,saveManualTokens,
 SYDNEY_CLIENT_ID
} from '../manual-token-import.mjs';
const oid='22222222-2222-2222-2222-222222222222';
const tid='33333333-3333-3333-3333-333333333333';
const email='student@example.edu';
const rt='TEST_REFRESH_TOKEN_abcdefghijklmnopqrstuvwxyz1234567890';
const b64=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
const jwt=`${b64({alg:'RS256',typ:'JWT'})}.${b64({aud:'https://substrate.office.com/sydney',oid,tid,preferred_username:email,exp:Math.floor(Date.now()/1000)+3500,appid:SYDNEY_CLIENT_ID,scp:'M365Chat.Read'})}.${'x'.repeat(80)}`;
const jwe=`${b64({alg:'RSA-OAEP',enc:'A128CBC-HS256',zip:'DEF'})}.${'a'.repeat(80)}.${'b'.repeat(20)}.${'c'.repeat(200)}.${'d'.repeat(25)}`;
const account={Account:{one:{homeAccountId:oid+'.'+tid,environment:'login.microsoftonline.com',localAccountId:oid,username:email,realm:tid}}};

test('JWE format inspection never invents audience or expiry',()=>{
  assert.equal(inspectAccessToken(jwe).format,'jwe');
  assert.equal(inspectAccessToken(jwe).claims,null);
  assert.equal(inspectAccessToken(jwe).expiresAt,null);
  assert.equal(inspectAccessToken(jwt).format,'jwt');
  assert.ok(inspectAccessToken(jwt).expiresAt>Date.now()/1000);
  assert.throws(()=>inspectAccessToken('invalid'),/格式|JWT|JWE/);
});
test('JWE and RT import reuses locally linked identity, not JWE claim guesses',()=>{
 const result=buildMsalCacheFromTokens(jwe,rt,email,tid,{existingCache:JSON.stringify(account)});
 assert.equal(result.tokenFormat,'jwe');
 assert.equal(result.accessExpiresAt,null);
 const cache=JSON.parse(result.cache);
 assert.equal(Object.values(cache.Account)[0].username,email);
 assert.equal(Object.values(cache.AccessToken)[0].secret,jwe);
 assert.equal(Object.values(cache.AccessToken)[0].expiresOn,'1');
 assert.equal(Object.values(cache.RefreshToken)[0].secret,rt);
 assert.doesNotMatch(JSON.stringify({...result,cache:''}),/TEST_REFRESH_TOKEN/);
 assert.throws(()=>buildMsalCacheFromTokens(jwe,rt,email,tid),/JWE.*oid\/tid/);
 assert.throws(()=>buildMsalCacheFromTokens(jwe,rt,'other@example.edu',tid,{existingCache:JSON.stringify(account)}),/邮箱/);
});
test('JWE can replace a cache previously linked by JWT with two fields only',()=>{
 const dir=mkdtempSync(join(tmpdir(),'m365-jwe-'));
 try{
  const id='11111111-1111-1111-1111-111111111111';
  saveManualTokens(dir,id,email,tid,jwt,rt);
  const result=saveManualTokens(dir,id,email,tid,jwe,rt);
  assert.equal(result.accessExpiresAt,null);
  assert.equal(result.tokenFormat,'jwe');
  const path=join(dir,'identity-profiles',id,'msal-cache.json');
  const cache=JSON.parse(readFileSync(path,'utf8'));
  assert.equal(Object.values(cache.AccessToken)[0].secret,jwe);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('RT identity metadata can be obtained via OAuth ID token without extra form fields (mock HTTP)',async()=>{
 const idJwt=`${b64({alg:'RS256'})}.${b64({aud:SYDNEY_CLIENT_ID,oid,tid,preferred_username:email})}.sig`;
 let called=0;
 const result=await identityFromRefreshToken(rt,email,tid,{fetcher:async(url,req)=>{
  called++;
  assert.match(url,/login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/token/);
  assert.equal(req.body.get('grant_type'),'refresh_token');
  assert.equal(req.body.get('client_id'),SYDNEY_CLIENT_ID);
  assert.equal(req.body.get('refresh_token'),rt);
  return {ok:true,async json(){return {id_token:idJwt,refresh_token:'ROTATED_REFRESH_TOKEN_abcdefghijklmnopqrstuvwxyz'};}};
 }});
 assert.equal(called,1);
 assert.equal(result.identity.oid,oid);
 assert.equal(result.identity.tid,tid);
 assert.equal(result.refreshToken,'ROTATED_REFRESH_TOKEN_abcdefghijklmnopqrstuvwxyz');
});
test('RT identity exchange rejects mismatched user, not silently authorizing',async()=>{
 const idJwt=`${b64({alg:'RS256'})}.${b64({aud:SYDNEY_CLIENT_ID,oid,tid,preferred_username:'wrong@example.edu'})}.sig`;
 await assert.rejects(identityFromRefreshToken(rt,email,tid,{fetcher:async()=>({ok:true,json:async()=>({id_token:idJwt})})}),/邮箱/);
});
