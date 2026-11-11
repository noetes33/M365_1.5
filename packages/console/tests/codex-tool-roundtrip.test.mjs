import test from 'node:test';
import assert from 'node:assert/strict';
import {
  responsesToChat,chatToResponses,responsesEvents,runResponses,warmupResponses,
} from '../responses-compat.mjs';

const model='gpt-5.6-think-deeper';
function completion({content=null,tool_calls,finish_reason='tool_calls'}={}){
  return {id:'cmpl-test',model,choices:[{finish_reason,message:{role:'assistant',content, ...(tool_calls?{tool_calls}:{})}}]};
}
const shellTool={type:'function',name:'shell_command',description:'Run a command',parameters:{type:'object',properties:{command:{type:'string'}},required:['command']}};
const patchTool={type:'custom',name:'apply_patch',description:'Apply a patch',format:{type:'text'}};
function success(payload){return new Response(JSON.stringify(payload),{status:200,headers:{'Content-Type':'application/json'}});}

test('ordinary chat remains compatible',async()=>{
 const out=await runResponses({model,input:'hello'},'normal',async()=>success(completion({content:'hi',finish_reason:'stop'})));
 assert.equal(out.output[0].type,'message');assert.equal(out.output[0].content[0].text,'hi');
});
test('function tool definition and named tool_choice reach proxy-lib schema',()=>{
 const a=responsesToChat({model,input:'run pwd',tools:[shellTool],tool_choice:{type:'function',name:'shell_command'}},'named');
 assert.equal(a.chat.tools[0].function.name,'shell_command');
 assert.deepEqual(a.chat.tool_choice,{type:'function',function:{name:'shell_command'}});
});
test('required without tools is rejected',()=>{
 assert.throws(()=>responsesToChat({model,input:'hello',tool_choice:'required'},'zero'),/no tools/);
});
test('tool call returned from upstream is a structured Responses function_call',async()=>{
 const body={model,input:'inspect',tools:[shellTool],tool_choice:'required'};
 const out=await runResponses(body,'one',async chat=>{
   assert.equal(chat.tool_choice,'required');
   return success(completion({tool_calls:[{id:'call_123',type:'function',function:{name:'shell_command',arguments:'{"command":"pwd"}'}}]}));
 });
 assert.equal(out.output[0].type,'function_call');
 assert.equal(out.output[0].call_id,'call_123');
 assert.equal(out.output[0].arguments,'{"command":"pwd"}');
 const events=[...responsesEvents(out)].map(x=>x.type);
 assert.ok(events.includes('response.function_call_arguments.done'));
 assert.equal(events.at(-1),'response.completed');
});
test('previous_response_id feeds tool output back with matching call_id even without resending tools',async()=>{
 const call={id:'call_ret',type:'function',function:{name:'shell_command',arguments:'{"command":"pwd"}'}};
 const first=await runResponses({model,input:'inspect',tools:[shellTool]},'roundtrip',async()=>success(completion({tool_calls:[call]})));
 const next=responsesToChat({model,previous_response_id:first.id,input:[{type:'function_call_output',call_id:'call_ret',output:'/mnt/project'}]},'roundtrip');
 assert.deepEqual(next.chat.messages.map(m=>m.role),['user','assistant','tool']);
 assert.equal(next.chat.messages.at(-1).tool_call_id,'call_ret');
 assert.equal(next.chat.tools[0].function.name,'shell_command');
 assert.equal(next.chat.messages[1].tool_calls[0].id,'call_ret');
});
test('custom tool invocation is emitted with raw input and resume preserves its schema',async()=>{
 const first=await runResponses({model,input:'apply patch',tools:[patchTool]},'custom',async chat=>{
   assert.equal(chat.tools[0].function.parameters.properties.input.type,'string');
   return success(completion({tool_calls:[{id:'call_patch',type:'function',function:{name:'apply_patch',arguments:JSON.stringify({input:'*** Begin Patch\n*** End Patch'})}}]}));
 });
 assert.equal(first.output[0].type,'custom_tool_call');
 assert.equal(first.output[0].input,'*** Begin Patch\n*** End Patch');
 assert.ok([...responsesEvents(first)].some(x=>x.type==='response.custom_tool_call_input.done'));
 const second=responsesToChat({model,previous_response_id:first.id,input:[{type:'custom_tool_call_output',call_id:'call_patch',output:'Success'}]},'custom');
 assert.equal(second.chat.messages.at(-1).role,'tool');
 assert.equal(second.chat.messages.at(-1).content,'Success');
 assert.equal(second.chat.tools[0].function.name,'apply_patch');
 assert.ok(second.customNames.has('apply_patch'));
});
test('explicit custom tool call history maps raw input to JSON function arguments',()=>{
 const a=responsesToChat({model,input:[{type:'custom_tool_call',name:'apply_patch',call_id:'call_x',input:'a non-json patch'}],tools:[patchTool]},'explicit');
 assert.equal(JSON.parse(a.chat.messages[0].tool_calls[0].function.arguments).input,'a non-json patch');
});
test('required tool choice never reports text as a successful tool call',async()=>{
 await assert.rejects(runResponses({model,input:'use tool',tools:[shellTool],tool_choice:'required'},'required',async()=>success(completion({content:'I cannot access the tool',finish_reason:'stop'}))),error=>error.status===422&&error.message.includes('tool_call_required_but_missing'));
});
test('owner isolation is enforced for previous response history',async()=>{
 const out=await runResponses({model,input:'hi'},'ownerA',async()=>success(completion({content:'hello'})));
 assert.throws(()=>responsesToChat({model,input:'again',previous_response_id:out.id},'ownerB'),/previous_response_not_found/);
});
test('unknown tool choice name rejected before upstream',()=>{
 assert.throws(()=>responsesToChat({model,input:'hello',tools:[shellTool],tool_choice:{type:'function',name:'no_such_tool'}},'unknown'),/unknown function/);
});
test('response warmup retains tools for follow-up',()=>{
 const r=warmupResponses({model,input:'initial',tools:[shellTool]},'warm');
 assert.equal(responsesToChat({model,previous_response_id:r.id,input:'next'},'warm').chat.tools[0].function.name,'shell_command');
});
test('named tool choice refuses a different upstream tool',async()=>{
 await assert.rejects(runResponses({model,input:'call requested',tools:[shellTool,patchTool],tool_choice:{type:'function',name:'shell_command'}},'wrongname',async()=>success(completion({tool_calls:[{id:'call_wrong',type:'function',function:{name:'apply_patch',arguments:'{"input":"test"}'}}]}))),error=>error.status===422&&error.message.includes('tool_choice_function_mismatch'));
});
