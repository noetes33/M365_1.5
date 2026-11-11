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
test('images are forwarded to the M365 image path instead of dropped',async()=>{
 const assert=(await import('node:assert/strict')).default;
 const {responsesToChat}=await import('../responses-compat.mjs');
 const tiny='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEklEQVQI12P4z8AARMAgAAGfAQEGhMUYAAAAAElFTkSuQmCC';
 const input={model:'gpt-5.6-think-deeper',input:[{role:'user',content:[{type:'input_text',text:'what is it?'},{type:'input_image',image_url:tiny}]}]};
 const result=responsesToChat(input,'legacy-image-regression');
 assert.equal(result.chat.messages[0].role,'user');
 assert.equal(result.chat.messages[0].content[0].text,'what is it?');
 assert.equal(result.chat.messages[0].content[1].type,'image_url');
 assert.equal(result.chat.messages[0].content[1].image_url.url,tiny);
});
test('WebSocket responses stream to completion with a valid upstream SSE stream',async t=>{
 const assert=(await import('node:assert/strict')).default;
 const {Readable}=await import('node:stream');
 const http=await import('node:http');
 const {once}=await import('node:events');
 const {acceptResponsesWebSocket}=await import('../responses-socket.mjs');
 const model='gpt-5.6-think-deeper';
 const frames=[
  'data: '+JSON.stringify({id:'chat_mock',object:'chat.completion.chunk',model,choices:[{index:0,delta:{role:'assistant',content:'Hello '},finish_reason:null}]})+'\n\n',
  'data: '+JSON.stringify({id:'chat_mock',object:'chat.completion.chunk',model,choices:[{index:0,delta:{content:'world'},finish_reason:null}]})+'\n\n',
  'data: '+JSON.stringify({id:'chat_mock',object:'chat.completion.chunk',model,choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\n',
  'data: [DONE]\n\n',
 ];
 const server=http.createServer();
 server.on('upgrade',(req,socket,head)=>acceptResponsesWebSocket(req,socket,head,{
  owner:'legacy-ws-regression',postChat:async chat=>{
   assert.equal(chat.stream,true);
   return new Response(Readable.toWeb(Readable.from(frames.map(x=>Buffer.from(x)))),{status:200,headers:{'content-type':'text/event-stream'}});
  }
 }));
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const ws=new WebSocket('ws://127.0.0.1:'+server.address().port+'/v1/responses');
 t.after(()=>{try{ws.close();}catch{}server.close();});
 await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
 const result=await Promise.race([
  new Promise((resolve,reject)=>{
   ws.addEventListener('message',event=>{
    try{
     const value=JSON.parse(event.data);
     if(value.type==='response.completed')resolve(value.response);
     else if(value.type==='error')reject(Error(value.error?.message||'Unknown WebSocket error'));
    }catch(error){reject(error);}
   });
   ws.send(JSON.stringify({type:'response.create',model,input:'hi',stream:true}));
  }),
  new Promise((_,reject)=>setTimeout(()=>reject(Error('WebSocket test timed out')),6000)),
 ]);
 assert.equal(result.status,'completed');
 assert.equal(result.output[0].content[0].text,'Hello world');
});
test('custom tool calls are returned as custom_tool_call events',async()=>{
 const tools=[{id:'call_abc',type:'function',function:{name:'apply_patch',arguments:'{"input":"*** Begin Patch"}'}}];
 const result=await runResponses({model:'m365-copilot',input:'edit a file',tools:[{type:'custom',name:'apply_patch'}]},'custom-tool',async()=>new Response(JSON.stringify(chatPayload(null,tools)),{status:200}));
 assert.equal(result.output[0].type,'custom_tool_call');
 assert.equal(result.output[0].input,'*** Begin Patch');
 assert.ok([...responsesEvents(result)].some(e=>e.type==='response.custom_tool_call_input.done'));
});
