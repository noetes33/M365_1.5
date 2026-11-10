import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {responsesToChat,runResponses,responsesEvents,warmupResponses} from '../responses-compat.mjs';
import {acceptResponsesWebSocket} from '../responses-socket.mjs';

const chatPayload=(content='OK',calls=null)=>({id:'chat-1',model:'gpt-5.6-think-deeper',choices:[{message:{role:'assistant',content,tool_calls:calls}}],usage:{prompt_tokens:2,completion_tokens:1,total_tokens:3}});
const fakeChat=async body=>new Response(JSON.stringify(chatPayload('OK')),{status:200,headers:{'Content-Type':'application/json'}});

test('single text input converts to chat messages',()=>{
 const r=responsesToChat({model:'m365-copilot',input:'hello'},'one');
 assert.equal(r.chat.messages[0].role,'user');assert.equal(r.chat.messages[0].content,'hello');
});
test('tool choice and input text map to Chat Completions',()=>{
 const r=responsesToChat({model:'m365-copilot',input:[{role:'user',content:[{type:'input_text',text:'do a thing'}]}],tools:[{type:'function',name:'shell_command',parameters:{type:'object',properties:{command:{type:'string'}}}}]},'one');
 assert.equal(r.chat.tools[0].function.name,'shell_command');
 assert.equal(r.chat.messages[0].content,'do a thing');
});
test('text chat response exposes Responses fields and SSE events',async()=>{
 const r=await runResponses({model:'m365-copilot',input:'hello'},'one',fakeChat);
 assert.equal(r.object,'response');assert.equal(r.output[0].content[0].text,'OK');
 const types=[...responsesEvents(r)].map(e=>e.type);
 assert.deepEqual(types.slice(0,2),['response.created','response.in_progress']);
 assert.ok(types.includes('response.output_text.delta'));
 assert.equal(types.at(-1),'response.completed');
});
test('previous_response_id preserves context for same key only',async()=>{
 const first=await runResponses({model:'m365-copilot',input:'hello'},'owner-1',fakeChat);
 const next=responsesToChat({model:'m365-copilot',previous_response_id:first.id,input:'again'},'owner-1');
 assert.deepEqual(next.chat.messages.map(x=>x.role),['user','assistant','user']);
 assert.throws(()=>responsesToChat({model:'m365-copilot',previous_response_id:first.id,input:'again'},'owner-2'),/previous_response_not_found/);
});
test('function calls and tool outputs continue in Responses',async()=>{
 const calls=[{id:'call_1',type:'function',function:{name:'shell_command',arguments:'{"command":"pwd"}'}}];
 const first=await runResponses({model:'m365-copilot',input:'call a tool',tools:[{type:'function',name:'shell_command',parameters:{type:'object',properties:{command:{type:'string'}}}}]},'owner-tools',async()=>new Response(JSON.stringify(chatPayload(null,calls)),{status:200}));
 assert.equal(first.output[0].type,'function_call');
 assert.ok([...responsesEvents(first)].some(x=>x.type==='response.function_call_arguments.done'));
 const next=responsesToChat({model:'m365-copilot',previous_response_id:first.id,input:[{type:'function_call_output',call_id:'call_1',output:'/tmp'}]},'owner-tools');
 assert.equal(next.chat.messages.at(-1).role,'tool');
});
test('warmup stores continuation without generating a model reply',()=>{
 const r=warmupResponses({model:'m365-copilot',generate:false},'warm');
 assert.equal(r.status,'completed');
 assert.equal(responsesToChat({model:'m365-copilot',previous_response_id:r.id,input:'hello'},'warm').chat.messages[0].content,'hello');
});
test('upstream HTTP errors are preserved',async()=>{
 await assert.rejects(()=>runResponses({model:'m365-copilot',input:'test'},'err',async()=>new Response(JSON.stringify({error:{message:'Model not available'}}),{status:502})),e=>e.status===502&&e.message==='Model not available');
});
test('image inputs report unsupported instead of silently dropping images',()=>{
 assert.throws(()=>responsesToChat({model:'m365-copilot',input:[{role:'user',content:[{type:'input_image',image_url:'https://example.org/a.png'}]}]},'image'),/text input only/);
});
test('WebSocket responses deliver response.completed event',async(t)=>{
 if(typeof WebSocket==='undefined'){t.skip('No native WebSocket client');return;}
 const server=http.createServer();
 server.on('upgrade',(req,socket,head)=>acceptResponsesWebSocket(req,socket,head,{owner:'ws-owner',postChat:fakeChat}));
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const url=`ws://127.0.0.1:${server.address().port}/v1/responses`;
 const ws=new WebSocket(url);t.after(()=>{ws.close();server.close();});
 await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
 const result=await Promise.race([
   new Promise((resolve,reject)=>{
     ws.addEventListener('message',ev=>{try{const e=JSON.parse(ev.data);if(e.type==='response.completed')resolve(e.response);else if(e.type==='error')reject(new Error(JSON.stringify(e.error)));}catch(e){reject(e);}});
     ws.send(JSON.stringify({type:'response.create',model:'m365-copilot',input:'hello'}));
   }),
   new Promise((_,reject)=>setTimeout(()=>reject(Error('WebSocket timeout')),3500)),
 ]);
 assert.equal(result.output[0].content[0].text,'OK');
});
test('custom tool calls are returned as custom_tool_call events',async()=>{
 const tools=[{id:'call_abc',type:'function',function:{name:'apply_patch',arguments:'{"input":"*** Begin Patch"}'}}];
 const result=await runResponses({model:'m365-copilot',input:'edit a file',tools:[{type:'custom',name:'apply_patch'}]},'custom-tool',async()=>new Response(JSON.stringify(chatPayload(null,tools)),{status:200}));
 assert.equal(result.output[0].type,'custom_tool_call');
 assert.equal(result.output[0].input,'*** Begin Patch');
 assert.ok([...responsesEvents(result)].some(e=>e.type==='response.custom_tool_call_input.done'));
});
