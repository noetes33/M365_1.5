/** Keep per-model chat failures isolated from account authentication status. */
import {createHash} from 'node:crypto';

export function poolKeyForRequest(scope,pathname,payload){
  if(pathname!=='/v1/chat/completions'||!payload)return scope;
  try{
    const body=JSON.parse(Buffer.isBuffer(payload)?payload.toString('utf8'):String(payload));
    if(typeof body.model!=='string'||!body.model||body.model.length>256)return scope;
    // Do not expose untrusted model strings as map keys or identifiers.
    const modelHash=createHash('sha256').update(body.model).digest('hex');
    return `${scope}:model:${modelHash}`;
  }catch{return scope;}
}

export function updateManualChatStatus(entry,message){
  if(message?.type!=='manual-chat-status')return;
  entry.lastChatAt=Date.now();
  if(message.ok){
    // A real model reply is positive evidence that this account can chat.
    entry.verified=true;
    entry.authError=null;
    entry.lastChatError=null;
  }else{
    // A model failure is request-scoped; leave authorization untouched.
    // In particular, do not assign authError or set verified=false here.
    entry.lastChatError=String(message.error||'模型调用失败').slice(0,160);
  }
}
