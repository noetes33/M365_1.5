/** OpenAI Responses API compatibility over the existing Chat Completions route.
 * Tokens, accounting and Microsoft account routing stay in the existing gateway.
 * This module never executes a client tool; it relays tool calls/results only.
 */
import {randomUUID} from 'node:crypto';

const responseHistory = new Map();
const MAX_HISTORY = 256;
const TTL = 30 * 60 * 1000;
const bad = (text,status=400)=>Object.assign(new Error(text),{status});
const now = ()=>Math.floor(Date.now()/1000);

function textContent(content){
  if(typeof content==='string')return content;
  if(!Array.isArray(content))throw bad('Unsupported response input content');
  return content.map(part=>{
    if(typeof part==='string')return part;
    if(part?.type==='input_text'||part?.type==='output_text'||part?.type==='text')return String(part.text||'');
    if(part?.type==='input_image'||part?.type==='input_audio'||part?.type==='input_file')throw bad('This gateway currently supports text input only');
    return '';
  }).join('\n');
}
function getHistory(key,previous){
  if(!previous)return {messages:[],tools:[],customNames:[]};
  const record=responseHistory.get(previous);
  if(!record||record.owner!==key||record.at+TTL<Date.now())throw bad('previous_response_not_found',404);
  return structuredClone({messages:record.messages,tools:record.tools||[],customNames:record.customNames||[]});
}
function cacheHistory(key,id,messages,tools=[],customNames=[]){
  const time=Date.now();
  for(const [k,v] of responseHistory)if(v.at+TTL<time)responseHistory.delete(k);
  while(responseHistory.size>=MAX_HISTORY)responseHistory.delete(responseHistory.keys().next().value);
  responseHistory.set(id,{owner:key,messages:structuredClone(messages),tools:structuredClone(tools),customNames:[...customNames],at:time});
}
/** Unpack Responses-Lite tools into names accepted by Chat Completions.
 * The namespace is kept separately so tool calls can be restored verbatim.
 */
function normalizeTools(definitions){
  if(!Array.isArray(definitions))throw bad('tools must be an array');
  const expanded=[];
  function add(t,namespace=''){
    if(!t||typeof t!=='object')throw bad('Malformed tool definition');
    if(t.type==='namespace'){
      if(namespace)throw bad('Nested tool namespace is not supported');
      if(typeof t.name!=='string'||!t.name||!Array.isArray(t.tools))throw bad('Invalid tool namespace');
      for(const nested of t.tools)add(nested,t.name);
      return;
    }
    if(t.type!=='function'&&t.type!=='custom'){
      throw bad('Unsupported tool type '+String(t.type));
    }
    if(typeof t.name!=='string'||!t.name||!/^[-a-zA-Z0-9_.]{1,128}$/.test(t.name))
      throw bad('Invalid tool name');
    const fullName=namespace ? namespace+'__'+t.name : t.name;
    if(fullName.length>128)throw bad('Namespaced tool name is too long');
    expanded.push({type:t.type,name:fullName,originalName:t.name,namespace,description:t.description||'',parameters:t.parameters||{type:'object',properties:{}}});
  }
  for(const t of definitions)add(t);
  if(expanded.length>256)throw bad('Too many tools (max 256)');
  // Codex may repeat the same namespace definitions on successive Responses-Lite turns.
  // The latest declaration wins, while still preserving the original input order.
  const named=new Map();
  for(const t of expanded)named.set(t.name,t);
  return [...named.values()];
}
function formatUpstreamName(item){
  const namespace=typeof item.namespace==='string'&&item.namespace?item.namespace+'__':'';
  return namespace ? namespace+String(item.name||'') : String(item.name||'');
}
export function responsesToChat(req,owner='local'){
  if(!req||typeof req!=='object'||typeof req.model!=='string'||!req.model.trim())throw bad('model is required');
  const prev=getHistory(owner,req.previous_response_id);
  let messages=prev.messages;
  let activeTools=req.tools===undefined?prev.tools:(Array.isArray(req.tools)?req.tools:null);
  if(activeTools===null)throw bad('tools must be an array');
  if(req.instructions)messages.push({role:'system',content:String(req.instructions)});
  const input=typeof req.input==='string'?[{type:'message',role:'user',content:req.input}]:req.input;
  if(!Array.isArray(input))throw bad('input must be a string or array');
  for(const item of input){
    if(!item||typeof item!=='object')continue;
    const type=item.type||'message';
    if(type==='additional_tools'){
      if(item.role && item.role!=='developer')throw bad('additional_tools role must be developer');
      if(!Array.isArray(item.tools))throw bad('additional_tools.tools must be an array');
      // Responses-Lite places its executable tools in input rather than the top-level tools field.
      // Keep them for the next turn instead of silently dropping these definitions.
      activeTools=[...activeTools,...item.tools];
      continue;
    }
    if(type==='message'){
      const role=String(item.role||'user');
      if(!['user','assistant','system','developer','tool'].includes(role))throw bad('Unsupported role '+role);
      messages.push({role:role==='developer'?'system':role,content:textContent(item.content)});
    }else if(type==='function_call'||type==='custom_tool_call'){
      const callId=String(item.call_id||item.id||'');
      if(!callId)throw bad('Function call lacks call_id');
      const args=type==='custom_tool_call' ? JSON.stringify({input:String(item.input??'')}) : String(item.arguments??'{}');
      messages.push({role:'assistant',content:null,tool_calls:[{id:callId,type:'function',function:{name:formatUpstreamName(item),arguments:args}}]});
    }else if(type==='function_call_output'||type==='custom_tool_call_output'){
      if(!item.call_id)throw bad('Tool result lacks call_id');
      messages.push({role:'tool',tool_call_id:String(item.call_id),content:textContent(item.output)});
    }else if(type==='reasoning'){
      // Reasoning summaries are not a substitute for a user-visible assistant message.
    }else throw bad('Unsupported input item type '+type);
  }
  if(!messages.length)throw bad('Nonempty input is required');
  const tools=[];const customNames=new Set(),namespaceMap=new Map();
  // A Responses-Lite turn may contain both req.tools and input additional_tools.
  // Convert the merged list once and preserve the original structure for continuations.
  const normalized=normalizeTools(activeTools);
  for(const t of normalized){
    if(t.namespace)namespaceMap.set(t.name,{name:t.originalName,namespace:t.namespace});
    if(t.type==='function')tools.push({type:'function',function:{name:t.name,description:t.description,parameters:t.parameters}});
    else{
      customNames.add(t.name);
      tools.push({type:'function',function:{name:t.name,description:t.description,parameters:{type:'object',properties:{input:{type:'string'}},required:['input']}}});
    }
  }
  const submittedTools=activeTools;
  const chat={model:req.model,messages,stream:false};
  if(tools.length)chat.tools=tools;
  if(req.tool_choice==='required'||req.tool_choice==='none'||req.tool_choice==='auto')chat.tool_choice=req.tool_choice;
  else if(req.tool_choice && typeof req.tool_choice==='object'){
    if(req.tool_choice.type==='function'||req.tool_choice.type==='custom'){
      const name=(req.tool_choice.namespace ? String(req.tool_choice.namespace)+'__' : '')+String(req.tool_choice.name||'');
      if(!name||!tools.some(t=>t.function.name===name))throw bad('tool_choice refers to an unknown function');
      chat.tool_choice={type:'function',function:{name}};
    }else throw bad('Unsupported tool_choice type '+String(req.tool_choice.type));
  }
  if(chat.tool_choice==='required'&&!tools.length)throw bad('tool_choice required but no tools were supplied');
  return {chat,customNames,submittedTools,namespaceMap};
}
export function chatToResponses(payload,request,owner='local'){
  if(!payload?.choices?.length)throw bad('Chat upstream returned no choices',502);
  const message=payload.choices[0]?.message;
  if(!message)throw bad('Chat upstream returned no message',502);
  const id='resp_'+randomUUID().replaceAll('-','');const created_at=now();
  const output=[];let assistant={role:'assistant',content:typeof message.content==='string'?message.content:''};
  if(message.tool_calls?.length){
    assistant={role:'assistant',content:message.content||null,tool_calls:message.tool_calls};
    for(const t of message.tool_calls){
      if(t.type!=='function')continue;
      const name=String(t.function?.name||'');
      const args=String(t.function?.arguments||'{}');
      const ns=request.namespaceMap?.get(name);
      if(request.customNames?.has(name)){
        let input=args;try{input=JSON.parse(args)?.input??args;}catch{}
        output.push({id:'ctc_'+randomUUID().replaceAll('-',''),type:'custom_tool_call',status:'completed',call_id:String(t.id),name:ns?.name||name,...(ns?{namespace:ns.namespace}:{}),input:String(input)});
      }else output.push({id:'fc_'+randomUUID().replaceAll('-',''),type:'function_call',status:'completed',call_id:String(t.id),name:ns?.name||name,...(ns?{namespace:ns.namespace}:{}),arguments:args});
    }
  }
  const text=typeof message.content==='string'?message.content:Array.isArray(message.content)?message.content.map(p=>p?.text||'').join(''):'';
  if(text)output.push({id:'msg_'+randomUUID().replaceAll('-',''),type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text,annotations:[]}]});
  if(!output.length)throw bad('Chat upstream returned neither text nor tool calls',502);
  const choice=request.chat.tool_choice;
  const required=choice==='required'||(choice&&typeof choice==='object'&&choice.function);
  if(required && !output.some(x=>x.type==='function_call'||x.type==='custom_tool_call'))
    throw bad('tool_call_required_but_missing: upstream returned text instead of a tool call',422);
  if(choice&&typeof choice==='object'&&choice.function && !output.some(x=>(x.type==='function_call'||x.type==='custom_tool_call')&&((x.namespace?x.namespace+'__':'')+x.name)===choice.function.name))
    throw bad('tool_choice_function_mismatch: upstream called a different function',422);
  cacheHistory(owner,id,[...request.chat.messages,assistant],request.submittedTools,[...request.customNames]);
  return {id,object:'response',created_at,status:'completed',model:payload.model||request.chat.model,output,
    previous_response_id:request.previous_response_id||null,
    usage:payload.usage?{input_tokens:payload.usage.prompt_tokens||0,output_tokens:payload.usage.completion_tokens||0,total_tokens:payload.usage.total_tokens||0}:null,
    error:null,incomplete_details:null,parallel_tool_calls:true,metadata:{}};
}
export function* responsesEvents(response){
  let seq=0;const e=(type,data)=>({type,sequence_number:++seq,...data});
  yield e('response.created',{response:{...response,status:'in_progress',output:[]}});
  yield e('response.in_progress',{response:{...response,status:'in_progress',output:[]}});
  for(let i=0;i<response.output.length;i++){
    const item=response.output[i];
    yield e('response.output_item.added',{output_index:i,item:{...item,status:'in_progress',...(item.type==='message'?{content:[]}:{}),...(item.type==='function_call'?{arguments:''}:{})}});
    if(item.type==='message'){
      const part=item.content[0];
      yield e('response.content_part.added',{item_id:item.id,output_index:i,content_index:0,part:{...part,text:''}});
      yield e('response.output_text.delta',{item_id:item.id,output_index:i,content_index:0,delta:part.text});
      yield e('response.output_text.done',{item_id:item.id,output_index:i,content_index:0,text:part.text});
      yield e('response.content_part.done',{item_id:item.id,output_index:i,content_index:0,part});
    }else if(item.type==='custom_tool_call'){
      yield e('response.custom_tool_call_input.delta',{item_id:item.id,output_index:i,delta:item.input});
      yield e('response.custom_tool_call_input.done',{item_id:item.id,output_index:i,input:item.input});
    }else if(item.type==='function_call'){
      yield e('response.function_call_arguments.delta',{item_id:item.id,output_index:i,delta:item.arguments});
      yield e('response.function_call_arguments.done',{item_id:item.id,output_index:i,arguments:item.arguments});
    }
    yield e('response.output_item.done',{output_index:i,item});
  }
  yield e('response.completed',{response});
}
export async function runResponses(payload,owner,postChat){
  const req=responsesToChat(payload,owner);
  const answer=await postChat(req.chat);
  if(!answer.ok){
    let upstream=null;try{upstream=await answer.json();}catch{}
    throw bad(upstream?.error?.message||'Chat upstream rejected the request',answer.status);
  }
  const result=await answer.json();
  return chatToResponses(result,{...req,previous_response_id:payload.previous_response_id},owner);
}
export function warmupResponses(payload,owner){
  const previous=getHistory(owner,payload.previous_response_id);
  const messages=previous.messages;
  if(payload.instructions)messages.push({role:'system',content:String(payload.instructions)});
  if(payload.input && (!Array.isArray(payload.input)||payload.input.length)){
    const fake=responsesToChat({...payload,input:payload.input},owner);
    messages.splice(0,messages.length,...fake.chat.messages);
  }
  const id='resp_'+randomUUID().replaceAll('-','');
  const definitions=payload.tools===undefined?previous.tools:payload.tools;
  const extra=Array.isArray(payload.input)?payload.input.filter(x=>x?.type==='additional_tools').flatMap(x=>x.tools||[]):[];
  const allTools=[...definitions,...extra];
  normalizeTools(allTools);
  cacheHistory(owner,id,messages,allTools,payload.tools===undefined?previous.customNames:[]);
  return {id,object:'response',created_at:now(),status:'completed',model:payload.model,output:[],previous_response_id:payload.previous_response_id||null,usage:null,error:null,incomplete_details:null};
}
