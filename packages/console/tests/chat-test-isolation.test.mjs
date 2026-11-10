import {test} from 'node:test';
import assert from 'node:assert/strict';
import {poolKeyForRequest,updateManualChatStatus} from '../chat-test-isolation.mjs';
const body=model=>Buffer.from(JSON.stringify({model,messages:[{role:'user',content:'hello'}]}));

test('different model choices do not share upstream chat application',()=>{
  const a=poolKeyForRequest('internal-chat-test','/v1/chat/completions',body('gpt-5.5-think-deeper'));
  const b=poolKeyForRequest('internal-chat-test','/v1/chat/completions',body('gpt-6.1-sol'));
  assert.notEqual(a,b);
  assert.equal(a,poolKeyForRequest('internal-chat-test','/v1/chat/completions',body('gpt-5.5-think-deeper')));
  assert.notEqual(a,poolKeyForRequest('other-client','/v1/chat/completions',body('gpt-5.5-think-deeper')));
});

test('models API retains its own shared scope; malformed chat body does not crash',()=>{
  assert.equal(poolKeyForRequest('scope','/v1/models',undefined),'scope');
  assert.equal(poolKeyForRequest('scope','/v1/chat/completions',Buffer.from('{')),'scope');
  assert.equal(poolKeyForRequest('scope','/v1/chat/completions',body('')),'scope');
});

test('upstream 502 does not revoke a previously successful account authorization',()=>{
  const entry={verified:true,authError:null};
  updateManualChatStatus(entry,{type:'manual-chat-status',ok:false,error:'模型调用未返回正常回答（HTTP 502）'});
  assert.equal(entry.verified,true);
  assert.equal(entry.authError,null);
  assert.match(entry.lastChatError,/502/);
});

test('first unsuccessful chat leaves manual-token account retryable',()=>{
  const entry={verified:false,authError:null};
  updateManualChatStatus(entry,{type:'manual-chat-status',ok:false,error:'HTTP 502'});
  assert.equal(entry.verified,false);
  assert.equal(entry.authError,null);
});

test('success clears previous request error and verifies the account',()=>{
  const entry={verified:false,authError:null,lastChatError:'HTTP 502'};
  updateManualChatStatus(entry,{type:'manual-chat-status',ok:true});
  assert.equal(entry.verified,true);
  assert.equal(entry.authError,null);
  assert.equal(entry.lastChatError,null);
});

test('unrelated events leave state unchanged',()=>{
  const entry={verified:true,authError:null};
  updateManualChatStatus(entry,{type:'ready',ok:false,error:'unknown'});
  assert.deepEqual(entry,{verified:true,authError:null});
});
