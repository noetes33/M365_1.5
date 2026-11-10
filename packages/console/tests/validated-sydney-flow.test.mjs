import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {saveManualTokens,manualTokenPath,refreshManualToken,getManualAccessToken,manualIdentity} from '../manual-token-store.mjs';
const client='4765445b-32c6-49b0-83e6-1d93765276ca';
const tenant='d67e5453-732f-4adc-94a4-4888f2d97d5d';
const oid='468a628d-c8fc-4b9d-9fbb-ba559f09311b';
const email='e5197797@student.dcccd.edu';
const id='12345678-1234-1234-1234-123456789abc';
const rt='TEST_REFRESH_TOKEN_NOT_A_REAL_CREDENTIAL';
const scope='https://substrate.office.com/sydney/M365Chat.Read https://substrate.office.com/sydney/sydney.readwrite openid profile offline_access';
const jwt=c=>['eyJhbGciOiJSUzI1NiJ9',Buffer.from(JSON.stringify(c)).toString('base64url'),'a'.repeat(50)].join('.');
const at=(exp,other={})=>jwt({exp,oid,tid:tenant,upn:email,aud:'https://substrate.office.com/sydney',appid:client,...other});
function setup(){const root=mkdtempSync(join(tmpdir(),'m365-test-'));return {root,file:manualTokenPath(root,id),cleanup:()=>rmSync(root,{recursive:true,force:true})};}

test('reads identity and matching appid from imported Sydney AT',()=>{
 const t=setup();try{
  saveManualTokens(t.root,id,email,'',at(Math.floor(Date.now()/1000)+5000),rt);
  const stored=JSON.parse(readFileSync(t.file,'utf8'));
  assert.equal(stored.tenant,tenant);assert.equal(stored.oid,oid);assert.equal(stored.oauthClientId,client);
  assert.equal(manualIdentity(t.file).tenant,tenant);
 }finally{t.cleanup();}
});

test('uses the validated client, Origin and scope; persists rotated AT and RT',async()=>{
 const t=setup();try{
  const before=at(Math.floor(Date.now()/1000)+10),after=at(Math.floor(Date.now()/1000)+5200);
  saveManualTokens(t.root,id,email,'',before,rt);
  let count=0;
  const mock=async(url,request)=>{
   count++;
   assert.equal(url,`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`);
   assert.equal(request.method,'POST');
   assert.equal(request.headers.Origin,'https://m365.cloud.microsoft');
   assert.equal(request.headers['Content-Type'],'application/x-www-form-urlencoded');
   assert.equal(request.body.get('client_id'),client);
   assert.equal(request.body.get('scope'),scope);
   assert.equal(request.body.get('refresh_token'),rt);
   assert.equal(request.body.get('grant_type'),'refresh_token');
   return new Response(JSON.stringify({access_token:after,refresh_token:'NEW_ROTATED_TEST_RT_VALUE_123456789',expires_in:5180}),{status:200});
  };
  assert.equal(await refreshManualToken(t.file,mock),after);
  const saved=JSON.parse(readFileSync(t.file,'utf8'));
  assert.equal(saved.accessToken,after);assert.equal(saved.refreshToken,'NEW_ROTATED_TEST_RT_VALUE_123456789');
  assert.equal(saved.oid,oid);assert.equal(saved.tenant,tenant);assert.equal(saved.oauthClientId,client);
  assert.ok(saved.expiresAt>=Math.floor(Date.now()/1000)+5170);
  assert.equal(await getManualAccessToken(t.file),after);
  assert.equal(count,1);
 }finally{t.cleanup();}
});

test('legacy JWE still gets the proven default client on refresh',async()=>{
 const t=setup();try{
  const jwe=['eyJhbGciOiJSU0EtT0FFUCIsImVuYyI6IkExMjhDQkMtSFMyNTYifQ','a'.repeat(80),'b'.repeat(22),'c'.repeat(90),'d'.repeat(22)].join('.');
  saveManualTokens(t.root,id,email,tenant,jwe,rt);
  assert.equal(JSON.parse(readFileSync(t.file,'utf8')).oauthClientId,client);
  await refreshManualToken(t.file,async(_url,request)=>{
   assert.equal(request.body.get('client_id'),client);
   return new Response(JSON.stringify({access_token:at(Math.floor(Date.now()/1000)+5180),refresh_token:'ROTATED_RT_TEST_VALUE_123456789',expires_in:5180}),{status:200});
  });
  assert.equal(JSON.parse(readFileSync(t.file,'utf8')).oid,oid);
 }finally{t.cleanup();}
});

test('invalid_grant error shows AADSTS detail without overwriting tokens',async()=>{
 const t=setup();try{
  saveManualTokens(t.root,id,email,'',at(Math.floor(Date.now()/1000)+10),rt);
  const before=readFileSync(t.file,'utf8');
  await assert.rejects(refreshManualToken(t.file,async()=>new Response(JSON.stringify({error:'invalid_grant',error_codes:[700084],error_description:'AADSTS700084: test expiry'}),{status:400})),/AADSTS700084|700084/);
  assert.equal(readFileSync(t.file,'utf8'),before);
 }finally{t.cleanup();}
});

test('wrong token audience or appid never replaces existing credentials',async()=>{
 const t=setup();try{
  saveManualTokens(t.root,id,email,'',at(Math.floor(Date.now()/1000)+3500),rt);
  const before=readFileSync(t.file,'utf8');
  await assert.rejects(refreshManualToken(t.file,async()=>new Response(JSON.stringify({access_token:at(Math.floor(Date.now()/1000)+5000,{aud:'https://graph.microsoft.com'}),expires_in:5000}),{status:200})),/Sydney/);
  assert.equal(readFileSync(t.file,'utf8'),before);
  await assert.rejects(refreshManualToken(t.file,async()=>new Response(JSON.stringify({access_token:at(Math.floor(Date.now()/1000)+5000,{appid:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}),expires_in:5000}),{status:200})),/客户端/);
  assert.equal(readFileSync(t.file,'utf8'),before);
 }finally{t.cleanup();}
});
