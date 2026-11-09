import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {saveManualTokens,manualTokenPath,hasManualTokens,statusManualTokens,
  getManualAccessToken,refreshManualToken,inspectAccessToken} from '../manual-token-store.mjs';

const id='11111111-1111-1111-1111-111111111111';
const tid='22222222-2222-2222-2222-222222222222';
const oid='33333333-3333-3333-3333-333333333333';
const email='owner@example.edu';
const rt='TEST_REFRESH_TOKEN_DO_NOT_USE_123456789';
const jwe=['eyJhbGciOiJSU0EtT0FFUCIsImVuYyI6IkExMjhDQkMtSFMyNTYifQ',
  'a'.repeat(90),'b'.repeat(24),'c'.repeat(100),'d'.repeat(24)].join('.');
function jwt(claims){return [Buffer.from('{"alg":"RS256"}').toString('base64url'),
  Buffer.from(JSON.stringify(claims)).toString('base64url'),'x'.repeat(90)].join('.');}
function setup(){const dir=mkdtempSync(join(tmpdir(),'m365-manual-flow-'));return {dir,close:()=>rmSync(dir,{recursive:true,force:true})};}

test('JWE is accepted without assuming an expiry; import is not called authentication',async()=>{
 const {dir,close}=setup();try{
  const info=saveManualTokens(dir,id,email,'',jwe,rt);
  assert.equal(info.tokenFormat,'JWE');assert.equal(info.expiresAt,null);
  assert.equal(statusManualTokens(dir,id).expiresAt,null);
  assert.equal(await getManualAccessToken(manualTokenPath(dir,id)),jwe);
  assert.equal(hasManualTokens(dir,id),true);
  if(process.platform!=='win32')assert.equal(statSync(manualTokenPath(dir,id)).mode&0o777,0o600);
 }finally{close();}
});

test('JWT expiry is read without guessing, and opaque JWE cannot expose claims',()=>{
 const t=jwt({exp:Math.floor(Date.now()/1000)+7200});
 assert.ok(inspectAccessToken(t).expiresAt);
 assert.equal(inspectAccessToken(jwe).expiresAt,null);
 assert.throws(()=>inspectAccessToken('not-a-token'));
});

test('RT refresh only on request, stores new AT and rotated RT, and uses intended Sydney scopes',async()=>{
 const {dir,close}=setup();try{
  saveManualTokens(dir,id,email,tid,jwe,rt);
  const path=manualTokenPath(dir,id);
  const newer=jwt({exp:Math.floor(Date.now()/1000)+4000});
  const idtok=jwt({oid,tid,preferred_username:email});
  let called=0;
  const fakeFetch=async(url,init)=>{
   called++;assert.match(url,new RegExp(tid));
   assert.equal(init.body.get('grant_type'),'refresh_token');
   assert.equal(init.body.get('refresh_token'),rt);
   assert.match(init.body.get('scope'),/substrate\.office\.com\/sydney/);
   return new Response(JSON.stringify({access_token:newer,refresh_token:'ROTATED_REFRESH_TOKEN_1234567890',
     expires_in:3600,id_token:idtok}),{status:200,headers:{'Content-Type':'application/json'}});
  };
  assert.equal(await refreshManualToken(path,fakeFetch),newer);
  assert.equal(called,1);
  const raw=JSON.parse(readFileSync(path,'utf8'));
  assert.equal(raw.refreshToken,'ROTATED_REFRESH_TOKEN_1234567890');
  assert.equal(raw.oid,oid);assert.equal(raw.tenant,tid);
  assert.equal(await getManualAccessToken(path),newer);
 }finally{close();}
});

test('refresh error leaves existing AT and RT untouched',async()=>{
 const {dir,close}=setup();try{
  saveManualTokens(dir,id,email,'',jwe,rt);
  const path=manualTokenPath(dir,id);
  await assert.rejects(refreshManualToken(path,async()=>new Response(JSON.stringify({error:'invalid_grant'}),{status:400})),/invalid_grant/);
  const t=JSON.parse(readFileSync(path,'utf8'));
  assert.equal(t.accessToken,jwe);assert.equal(t.refreshToken,rt);
 }finally{close();}
});

test('parallel refresh requests are coalesced per account file',async()=>{
 const {dir,close}=setup();try{
  saveManualTokens(dir,id,email,'',jwe,rt);
  const path=manualTokenPath(dir,id);let calls=0;
  const fetcher=async()=>{
   calls++;await new Promise(ok=>setTimeout(ok,25));
   return new Response(JSON.stringify({access_token:jwt({exp:Math.floor(Date.now()/1000)+5000}),
     refresh_token:'ROTATED_REFRESH_TOKEN_TEST_234567890',expires_in:3600}),{status:200});
  };
  const [a,b]=await Promise.all([refreshManualToken(path,fetcher),refreshManualToken(path,fetcher)]);
  assert.equal(a,b);assert.equal(calls,1);
 }finally{close();}
});
