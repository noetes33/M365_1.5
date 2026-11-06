import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateCacheImport,saveImportedCache,cacheImportPending,clearCacheImportPending} from '../msal-cache-import.mjs';
const id='11111111-1111-1111-1111-111111111111';
const t='22222222-2222-2222-2222-222222222222';
const account={username:'owner@example.edu',realm:t,homeAccountId:'u1.'+t,environment:'login.microsoftonline.com',localAccountId:'u1'};
function sample(){return JSON.stringify({Account:{one:account},AccessToken:{at:{homeAccountId:account.homeAccountId,environment:account.environment,clientId:'client-1',secret:'fake_access_token_for_tests_only_123456',target:'scope-1',expiresOn:'9999999999'}},RefreshToken:{rt:{homeAccountId:account.homeAccountId,environment:account.environment,clientId:'client-1',secret:'fake_refresh_token_for_tests_only_123456'}}});}
test('rejects isolated AT and RT strings, malformed JSON, and a mismatched email',()=>{
  assert.throws(()=>validateCacheImport('AT: hello; RT: hello','owner@example.edu',t));
  assert.throws(()=>validateCacheImport('not-json','owner@example.edu',t));
  assert.throws(()=>validateCacheImport(sample(),'attacker@example.edu',t),/邮箱/);
  assert.throws(()=>validateCacheImport(sample(),'owner@example.edu','11111111-0000-0000-0000-000000000000'),/租户/);
});
test('rejects disconnected tokens and mixed client IDs',()=>{
  const cache=JSON.parse(sample());cache.RefreshToken.rt.clientId='another-client';
  assert.throws(()=>validateCacheImport(JSON.stringify(cache),'owner@example.edu',t),/OAuth/);
  cache.RefreshToken.rt.clientId='client-1';cache.RefreshToken.rt.homeAccountId='wrong-id';
  assert.throws(()=>validateCacheImport(JSON.stringify(cache),'owner@example.edu',t),/AT、RT/);
});
test('saves isolated cache with a pending validation marker; does not expose tokens in result',()=>{
  const dir=mkdtempSync(join(tmpdir(),'m365-msal-import-'));
  try{
    const result=saveImportedCache(dir,id,'owner@example.edu',t,sample());
    assert.deepEqual(result,{email:'owner@example.edu',tenant:t});
    const file=join(dir,'identity-profiles',id,'msal-cache.json');
    assert.equal(JSON.parse(readFileSync(file,'utf8')).Account.one.username,'owner@example.edu');
    if(process.platform!=='win32')assert.equal(statSync(file).mode&0o777,0o600);
    assert.equal(cacheImportPending(dir,id),true);
    clearCacheImportPending(dir,id);
    assert.equal(cacheImportPending(dir,id),false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
