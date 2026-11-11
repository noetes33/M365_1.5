import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {responsesToChat,runResponses} from '../responses-compat.mjs';
import {streamResponses,readUpstreamSSE} from '../responses-stream.mjs';

const model='gpt-5.6-think-deeper';
const tinyPNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEklEQVQI12P4z8AARMAgAAGfAQEGhMUYAAAAAElFTkSuQmCC';
const wrap=json=>`data: ${JSON.stringify(json)}\n\n`;
const chatOk=(text='ok')=>new Response(JSON.stringify({model,choices:[{message:{role:'assistant',content:text}}]}),{status:200});
const textSSE=[
 wrap({id:'chat_a',object:'chat.completion.chunk',model,choices:[{index:0,delta:{role:'assistant',content:'Hello '},finish_reason:null}]}),
 wrap({id:'chat_a',object:'chat.completion.chunk',model,choices:[{index:0,delta:{content:'world'},finish_reason:null}]}),
 wrap({id:'chat_a',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}}),
 'data: [DONE]\n\n',
];
function streaming(parts=textSSE){return new Response(Readable.toWeb(Readable.from(parts.map(v=>Buffer.from(v)))),{status:200,headers:{'content-type':'text/event-stream'}});}

// Images are forwarded to the core's established image-upload flow; not text placeholders.
test('Responses inline image becomes Chat Completions image_url payload',()=>{
 const request=responsesToChat({model,input:[{type:'message',role:'user',content:[{type:'input_text',text:'what is it?'},{type:'input_image',image_url:tinyPNG}]}]},'i1');
 assert.equal(request.chat.messages[0].content[0].text,'what is it?');
 assert.equal(request.chat.messages[0].content[1].type,'image_url');
 assert.equal(request.chat.messages[0].content[1].image_url.url,tinyPNG);
});
test('Responses https image reference stays an image, not plain text',()=>{
 const r=responsesToChat({model,input:[{role:'user',content:[{type:'input_image',image_url:'https://images.example.org/demo.png'}]}]},'i2');
 assert.equal(r.chat.messages[0].content[0].image_url.url,'https://images.example.org/demo.png');
});
test('Unsupported file_id and audio fail explicitly',()=>{
 assert.throws(()=>responsesToChat({model,input:[{role:'user',content:[{type:'input_image',file_id:'file_x'}]}]},'i3'),/image_file_id_not_supported/);
 assert.throws(()=>responsesToChat({model,input:[{role:'user',content:[{type:'input_audio',audio_url:'data:audio/abc'}]}]},'i4'),/media_type_not_supported/);
});
test('Tool outputs can carry an image without dropping it',()=>{
 const r=responsesToChat({model,input:[{type:'message',role:'user',content:'hello'},{type:'function_call',name:'take_screenshot',call_id:'call_A',arguments:'{}'},{type:'function_call_output',call_id:'call_A',output:[{type:'input_text',text:'done'},{type:'input_image',image_url:tinyPNG}]}]},'tool-image');
 assert.equal(r.chat.messages.at(-1).role,'user');
 assert.equal(r.chat.messages.at(-1).content.at(-1).type,'image_url');
 assert.equal(r.chat.messages.at(-2).role,'tool');
});
test('web_search built-in no longer prevents unrelated Codex local tool calls',async()=>{
 const r=responsesToChat({model,input:'read README',tools:[{type:'web_search'},{type:'function',name:'read_file',parameters:{type:'object',properties:{path:{type:'string'}}}}]},'search');
 assert.equal(r.chat.tools.length,1);
 assert.equal(r.chat.tools[0].function.name,'read_file');
 assert.ok(r.chat.messages.some(m=>m.role==='system'&&m.content.includes('Microsoft')));
});
test('SSE parser handles split chunks and trailing CRLF',async()=>{
 const frames=[];const text='data: {"value":1}\r\n\r\ndata: [DONE]\n\n';
 for await(const v of readUpstreamSSE(Readable.from([Buffer.from(text.slice(0,14)),Buffer.from(text.slice(14,19)),Buffer.from(text.slice(19))])))frames.push(v);
 assert.deepEqual(frames,['{"value":1}','[DONE]']);
});
test('Native upstream streaming emits deltas before completed, records history',async()=>{
 const events=[];
 for await(const e of streamResponses({model,input:'hello',stream:true},'stream1',async chat=>{
  assert.equal(chat.stream,true);return streaming();
 }))events.push(e);
 assert.equal(events.at(-1).type,'response.completed');
 assert.equal(events.filter(e=>e.type==='response.output_text.delta').map(e=>e.delta).join(''),'Hello world');
 const result=events.at(-1).response;
 assert.equal(result.output[0].content[0].text,'Hello world');
 assert.equal(result.usage.total_tokens,5);
 const next=responsesToChat({model,previous_response_id:result.id,input:'again'},'stream1');
 assert.equal(next.chat.messages[1].content,'Hello world');
});
test('Native SSE converts structured function calls and maintains call IDs',async()=>{
 const parts=[
  wrap({choices:[{delta:{tool_calls:[{index:0,id:'call_run',type:'function',function:{name:'shell_command',arguments:'{"command":'}}]},finish_reason:null}]}),
  wrap({choices:[{delta:{tool_calls:[{index:0,function:{arguments:'"pwd"}'}}]},finish_reason:null}]}),
  'data: [DONE]\n\n'
 ];
 const events=[];
 for await(const e of streamResponses({model,input:'run pwd',stream:true,tools:[{type:'function',name:'shell_command',parameters:{type:'object',properties:{command:{type:'string'}}}}]},'stream2',async()=>streaming(parts)))events.push(e);
 assert.ok(events.some(e=>e.type==='response.function_call_arguments.delta'));
 const done=events.at(-1).response;
 assert.equal(done.output[0].call_id,'call_run');
 assert.equal(done.output[0].arguments,'{"command":"pwd"}');
 const next=responsesToChat({model,previous_response_id:done.id,input:[{type:'function_call_output',call_id:'call_run',output:'/tmp'}]},'stream2');
 assert.equal(next.chat.messages.at(-1).tool_call_id,'call_run');
});
test('Custom tool arguments are converted into custom_tool_call response events',async()=>{
 const parts=[wrap({choices:[{delta:{tool_calls:[{index:0,id:'call_apply',function:{name:'apply_patch',arguments:'{"input":"*** Begin Patch"}'}}]},finish_reason:null}]}),'data: [DONE]\n\n'];
 const events=[];
 for await(const e of streamResponses({model,input:'edit',stream:true,tools:[{type:'custom',name:'apply_patch'}]},'custom1',async()=>streaming(parts)))events.push(e);
 assert.equal(events.at(-1).response.output[0].input,'*** Begin Patch');
 assert.ok(events.some(e=>e.type==='response.custom_tool_call_input.done'));
});
test('Absent DONE does not invent completed event',async()=>{
 const gen=streamResponses({model,input:'hello',stream:true},'fail-stream',async()=>streaming(textSSE.slice(0,-1)));
 const events=[];await assert.rejects(async()=>{for await(const e of gen)events.push(e);},/closed_without_done/);
 assert.ok(!events.some(e=>e.type==='response.completed'));
});
test('Tool required is enforced in stream too',async()=>{
 const g=streamResponses({model,input:'must tool',stream:true,tools:[{type:'function',name:'a',parameters:{type:'object'}}],tool_choice:'required'},'required',async()=>streaming());
 await assert.rejects(async()=>{for await(const e of g){}},e=>e.status===422);
});

test('WebSocket Responses bridge streams a model reply to response.completed',async(t)=>{
 const {default: http}=await import('node:http');
 const {once}=await import('node:events');
 const {acceptResponsesWebSocket}=await import('../responses-socket.mjs');
 const server=http.createServer();
 server.on('upgrade',(req,socket,head)=>acceptResponsesWebSocket(req,socket,head,{owner:'ws-test',postChat:async chat=>{
  assert.equal(chat.stream,true);
  return streaming();
 }}));
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const ws=new WebSocket(`ws://127.0.0.1:${server.address().port}/v1/responses`);
 t.after(()=>{try{ws.close();}catch{}server.close();});
 await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
 const result=await Promise.race([
  new Promise((resolve,reject)=>{
   ws.addEventListener('message',e=>{
    try{const data=JSON.parse(e.data);if(data.type==='response.completed')resolve(data.response);else if(data.type==='error')reject(Error(data.error?.message));}catch(e){reject(e);}
   });
   ws.send(JSON.stringify({type:'response.create',model,input:'hi',stream:true}));
  }),new Promise((_,reject)=>setTimeout(()=>reject(Error('WS timeout')),5000)),
 ]);
 assert.equal(result.output[0].content[0].text,'Hello world');
});
