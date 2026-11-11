/** Native Chat Completions SSE -> OpenAI Responses SSE adapter.
 * This adapts events as they arrive instead of buffering an entire M365 answer.
 * The upstream remains ChatHub/Chat Completions, not native OpenAI Responses.
 */
import {randomUUID} from 'node:crypto';
import {responsesToChat,saveStreamConversation} from './responses-compat.mjs';
const uid=()=>randomUUID().replaceAll('-','');
const timestamp=()=>Math.floor(Date.now()/1000);
const err=(msg,status=502)=>Object.assign(new Error(msg),{status});

export async function* readUpstreamSSE(body){
  if(!body)throw err('Upstream has no streaming body');
  const decoder=new TextDecoder();
  let buffer='';let lines=[];
  const parseLine=(line)=>{
    if(line.endsWith('\r'))line=line.slice(0,-1);
    if(line===''){
      const result=lines.join('\n');lines=[];return result||null;
    }
    if(line.startsWith('data:'))lines.push(line.slice(5).trimStart());
    return null;
  };
  for await(const chunk of body){
    buffer+=decoder.decode(chunk,{stream:true});
    if(buffer.length>16*1024*1024)throw err('Upstream SSE event exceeded 16 MiB',502);
    let pos;
    while((pos=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,pos);buffer=buffer.slice(pos+1);
      const item=parseLine(line);if(item!==null)yield item;
    }
  }
  buffer+=decoder.decode();
  if(buffer){const item=parseLine(buffer);if(item!==null)yield item;}
  if(lines.length)yield lines.join('\n');
}

export async function* streamResponses(payload,owner,postChat){
  const request=responsesToChat(payload,owner);
  const chat={...request.chat,stream:true,stream_options:{include_usage:true}};
  const upstream=await postChat(chat);
  if(!upstream?.ok){
    let upstreamError='Chat upstream rejected request';
    try{const j=await upstream.json();upstreamError=j?.error?.message||upstreamError;}catch{}
    throw err(upstreamError,upstream.status||502);
  }
  const responseId='resp_'+uid();const created_at=timestamp();
  let sequence=0;
  const ev=(type,fields)=>({type,sequence_number:++sequence,...fields});
  const info={id:responseId,object:'response',created_at,model:payload.model,status:'in_progress',output:[],previous_response_id:payload.previous_response_id||null,error:null,incomplete_details:null};
  yield ev('response.created',{response:info});
  yield ev('response.in_progress',{response:info});

  const entries=[];
  let textEntry=null;
  const toolEntries=new Map();
  let ended=false,usage=null,upstreamModel=payload.model;
  for await(const raw of readUpstreamSSE(upstream.body)){
    if(raw==='[DONE]'){ended=true;break;}
    let chunk;try{chunk=JSON.parse(raw);}catch{throw err('Invalid JSON SSE chunk from Chat upstream');}
    if(chunk?.error)throw err(String(chunk.error.message||'Upstream stream error'),chunk.error.status||502);
    if(chunk.usage)usage=chunk.usage;
    if(typeof chunk.model==='string')upstreamModel=chunk.model;
    for(const choice of chunk.choices||[]){
      const d=choice.delta||{};
      if(typeof d.content==='string' && d.content.length){
        if(!textEntry){
          const i=entries.length;
          textEntry={kind:'message',i,id:'msg_'+uid(),text:''};entries.push(textEntry);
          yield ev('response.output_item.added',{output_index:i,item:{id:textEntry.id,type:'message',role:'assistant',status:'in_progress',content:[]}});
          yield ev('response.content_part.added',{item_id:textEntry.id,output_index:i,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
        }
        textEntry.text+=d.content;
        yield ev('response.output_text.delta',{item_id:textEntry.id,output_index:textEntry.i,content_index:0,delta:d.content});
      }
      for(const tc of d.tool_calls||[]){
        const tindex=Number.isInteger(tc.index)?tc.index:toolEntries.size;
        let e=toolEntries.get(tindex);
        if(!e){
          const index=entries.length;
          const name=String(tc.function?.name||'');
          const custom=request.customNames.has(name);
          const ns=request.namespaceMap.get(name);
          e={kind:custom?'custom_tool_call':'function_call',i:index,id:(custom?'ctc_':'fc_')+uid(),call_id:String(tc.id||'call_'+uid()),rawName:name,name:ns?.name||name,namespace:ns?.namespace||'',args:''};
          toolEntries.set(tindex,e);entries.push(e);
          yield ev('response.output_item.added',{output_index:index,item:{id:e.id,type:e.kind,status:'in_progress',call_id:e.call_id,name:e.name,...(e.namespace?{namespace:e.namespace}:{}),...(custom?{input:''}:{arguments:''})}});
        }
        if(tc.id)e.call_id=String(tc.id);
        if(typeof tc.function?.name==='string'&&tc.function.name){
          e.rawName=tc.function.name;
          const ns=request.namespaceMap.get(e.rawName);
          e.namespace=ns?.namespace||'';e.name=ns?.name||e.rawName;
        }
        if(typeof tc.function?.arguments==='string'&&tc.function.arguments){
          e.args+=tc.function.arguments;
          if(e.kind==='function_call')yield ev('response.function_call_arguments.delta',{item_id:e.id,output_index:e.i,delta:tc.function.arguments});
        }
      }
    }
  }
  if(!ended)throw err('upstream_stream_closed_without_done');
  const output=[];
  const assistant={role:'assistant',content:textEntry?.text||null};
  if(toolEntries.size)assistant.tool_calls=[];
  for(const e of entries){
    if(e.kind==='message'){
      const part={type:'output_text',text:e.text,annotations:[]};
      yield ev('response.output_text.done',{item_id:e.id,output_index:e.i,content_index:0,text:e.text});
      yield ev('response.content_part.done',{item_id:e.id,output_index:e.i,content_index:0,part});
      const item={id:e.id,type:'message',status:'completed',role:'assistant',content:[part]};
      yield ev('response.output_item.done',{output_index:e.i,item});output.push(item);
    }else{
      if(e.kind==='custom_tool_call'){
        let input=e.args;try{input=JSON.parse(e.args)?.input??e.args;}catch{}
        yield ev('response.custom_tool_call_input.delta',{item_id:e.id,output_index:e.i,delta:String(input)});
        yield ev('response.custom_tool_call_input.done',{item_id:e.id,output_index:e.i,input:String(input)});
        const item={id:e.id,type:'custom_tool_call',status:'completed',call_id:e.call_id,name:e.name,...(e.namespace?{namespace:e.namespace}:{}),input:String(input)};
        output.push(item);yield ev('response.output_item.done',{output_index:e.i,item});
      }else{
        yield ev('response.function_call_arguments.done',{item_id:e.id,output_index:e.i,arguments:e.args});
        const item={id:e.id,type:'function_call',status:'completed',call_id:e.call_id,name:e.name,...(e.namespace?{namespace:e.namespace}:{}),arguments:e.args};
        output.push(item);yield ev('response.output_item.done',{output_index:e.i,item});
      }
      assistant.tool_calls.push({id:e.call_id,type:'function',function:{name:e.rawName,arguments:e.args}});
    }
  }
  if(!output.length)throw err('Chat upstream returned neither message nor tool calls');
  const required=request.chat.tool_choice==='required'||typeof request.chat.tool_choice==='object';
  if(required && !output.some(x=>x.type==='function_call'||x.type==='custom_tool_call'))throw err('tool_call_required_but_missing',422);
  if(typeof request.chat.tool_choice==='object'&&request.chat.tool_choice?.function?.name && !assistant.tool_calls.some(t=>t.function.name===request.chat.tool_choice.function.name))throw err('tool_choice_function_mismatch',422);
  saveStreamConversation(owner,responseId,request,assistant);
  const result={...info,status:'completed',model:upstreamModel,output,usage:usage?{input_tokens:usage.prompt_tokens||0,output_tokens:usage.completion_tokens||0,total_tokens:usage.total_tokens||0}:null,parallel_tool_calls:true,metadata:{}};
  yield ev('response.completed',{response:result});
}
