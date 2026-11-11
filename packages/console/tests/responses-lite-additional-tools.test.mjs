import test from 'node:test';
import assert from 'node:assert/strict';
import {responsesToChat,runResponses,responsesEvents} from '../responses-compat.mjs';
const model='gpt-5.6-think-deeper';
const schema={type:'object',properties:{command:{type:'string'}},required:['command']};
const definitions=[{type:'namespace',name:'functions',description:'',tools:[
  {type:'function',name:'exec',description:'Runs a safe local test command',parameters:schema},
  {type:'custom',name:'apply_patch',description:'Edits a local file',format:{type:'text'}}
]}];
const request=(extra={})=>({model,input:[{type:'additional_tools',role:'developer',id:'at_123',tools:definitions},{type:'message',role:'developer',content:[{type:'input_text',text:'You may call tools'}]},{role:'user',content:'read README'}],stream:false,...extra});
const upstream=(name,args)=>new Response(JSON.stringify({model,choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'call_abc',type:'function',function:{name,arguments:args}}]}}]}),{status:200});
test('additional_tools namespace reaches chat model, preserves developer message',()=>{
  const {chat,submittedTools}=responsesToChat(request(),'codex1');
  assert.equal(chat.tools.length,2);
  assert.deepEqual(chat.tools.map(x=>x.function.name),['functions__exec','functions__apply_patch']);
  assert.equal(chat.messages[0].role,'system');
  assert.equal(chat.messages[1].role,'user');
  assert.deepEqual(submittedTools,definitions);
});
test('HTTP responses namespaced function call uses namespace and name',async()=>{
 const out=await runResponses(request(),'codex2',chat=>{
   assert.equal(chat.tools[0].function.name,'functions__exec');
   return upstream('functions__exec','{"command":"pwd"}');
 });
 assert.equal(out.output[0].type,'function_call');
 assert.equal(out.output[0].name,'exec');
 assert.equal(out.output[0].namespace,'functions');
 assert.equal(out.output[0].call_id,'call_abc');
 assert.ok([...responsesEvents(out)].some(x=>x.type==='response.function_call_arguments.done'));
 const next=responsesToChat({model,previous_response_id:out.id,input:[{type:'function_call_output',call_id:'call_abc',output:'README.md'}]},'codex2');
 assert.equal(next.chat.messages.at(-1).role,'tool');
 assert.equal(next.chat.tools[0].function.name,'functions__exec');
});
test('namespaced custom tool with raw input maps back to custom_tool_call',async()=>{
 const out=await runResponses(request(),'codex3',chat=>upstream('functions__apply_patch',JSON.stringify({input:'*** Begin Patch'})));
 assert.equal(out.output[0].type,'custom_tool_call');
 assert.equal(out.output[0].namespace,'functions');
 assert.equal(out.output[0].name,'apply_patch');
 assert.equal(out.output[0].input,'*** Begin Patch');
 const follow=responsesToChat({model,previous_response_id:out.id,input:[{type:'custom_tool_call_output',call_id:'call_abc',output:'ok'}]},'codex3');
 assert.equal(follow.chat.messages.at(-1).tool_call_id,'call_abc');
});
test('repeat additional_tools on continuation does not duplicate namespace functions',async()=>{
 const out=await runResponses(request(),'codex4',()=>upstream('functions__exec','{"command":"pwd"}'));
 const follow=responsesToChat({model,previous_response_id:out.id,input:[{type:'additional_tools',role:'developer',tools:definitions},{type:'function_call_output',call_id:'call_abc',output:'ok'}]},'codex4');
 assert.equal(follow.chat.tools.length,2);
});
test('incorrect additional_tools types fail explicitly',()=>{
 assert.throws(()=>responsesToChat({model,input:[{type:'additional_tools',role:'user',tools:definitions},{role:'user',content:'x'}]},'bad'),/role must be developer/);
 assert.throws(()=>responsesToChat({model,input:[{type:'additional_tools',role:'developer',tools:'bad'},{role:'user',content:'x'}]},'bad'),/must be an array/);
 assert.throws(()=>responsesToChat({model,input:[{type:'additional_tools',role:'developer',tools:[{type:'mystery'}]},{role:'user',content:'x'}]},'bad'),/Unsupported tool type mystery/);
});
test('top-level tools continue to work',()=>{
 const {chat}=responsesToChat({model,input:'test',tools:[{type:'function',name:'test1',parameters:{type:'object',properties:{}}}]},'std');
 assert.equal(chat.tools[0].function.name,'test1');
});
