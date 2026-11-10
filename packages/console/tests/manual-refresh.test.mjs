import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {saveManualTokens,manualTokenPath,refreshManualToken,statusManualTokens} from '../manual-token-store.mjs';
const jwt=(value)=>['eyJhbGciOiJSUzI1NiJ9',Buffer.from(JSON.stringify(value)).toString('base64url'),'a'.repeat(50)].join('.');
test('manual RT refresh persists rotated AT, rotated RT and expires_in',async()=>{
 const root=mkdtempSync(join(tmpdir(),'m365-rt-test-'));
 const id='12345678-1234-1234-1234-123456789abc';
 try{
  saveManualTokens(root,id,'owner@example.org','',jwt({exp:Math.floor(Date.now()/1000)+10}), 'R'.repeat(60));
  const file=manualTokenPath(root,id);
  let requests=0;
  const fetcher=async(_url,options)=>{
    requests++;
    assert.equal(options.body.get('grant_type'),'refresh_token');
    assert.equal(options.body.get('refresh_token'),'R'.repeat(60));
    return new Response(JSON.stringify({access_token:jwt({exp:Math.floor(Date.now()/1000)+2400}),refresh_token:'N'.repeat(60),expires_in:2400}),{status:200});
  };
  const at=await refreshManualToken(file,fetcher);
  assert.ok(at.startsWith('eyJ'));
  const saved=JSON.parse(readFileSync(file,'utf8'));
  assert.equal(saved.refreshToken,'N'.repeat(60));
  assert.ok(saved.expiresAt>Math.floor(Date.now()/1000)+2300);
  assert.equal(requests,1);
  assert.equal(statusManualTokens(root,id).hasRefreshToken,true);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('failed RT refresh does not replace existing tokens',async()=>{
 const root=mkdtempSync(join(tmpdir(),'m365-rt-fail-'));
 const id='12345678-1234-1234-1234-123456789abd';
 try{
   saveManualTokens(root,id,'owner@example.org','',jwt({exp:Math.floor(Date.now()/1000)+10}), 'R'.repeat(60));
   const file=manualTokenPath(root,id);
   await assert.rejects(refreshManualToken(file,async()=>new Response(JSON.stringify({error:'invalid_grant'}),{status:400})),/invalid_grant/);
   const saved=JSON.parse(readFileSync(file,'utf8'));
   assert.equal(saved.refreshToken,'R'.repeat(60));
 }finally{rmSync(root,{recursive:true,force:true});}
});
