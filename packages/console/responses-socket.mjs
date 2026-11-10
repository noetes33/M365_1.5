/** Minimal RFC6455 text transport for Responses compatibility.
 * No node_modules dependency; only handles JSON text frames, ping/pong and close.
 * This is independent of Microsoft ChatHub's separate outbound WebSocket.
 */
import {createHash} from 'node:crypto';
import {runResponses,responsesEvents,warmupResponses} from './responses-compat.mjs';
const MAX_MESSAGE=8*1024*1024;
const guid='258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const frame=(opcode,payload)=>{
  const b=Buffer.isBuffer(payload)?payload:Buffer.from(payload||'');
  const n=b.length,head=n<126?Buffer.alloc(2):n<65536?Buffer.alloc(4):Buffer.alloc(10);
  head[0]=0x80|opcode;
  if(n<126)head[1]=n;
  else if(n<65536){head[1]=126;head.writeUInt16BE(n,2);}
  else{head[1]=127;head.writeBigUInt64BE(BigInt(n),2);}
  return Buffer.concat([head,b]);
};
export function acceptResponsesWebSocket(req,socket,head,{owner,postChat}){
  const key=String(req.headers['sec-websocket-key']||'');
  if(req.method!=='GET'||req.headers.upgrade?.toLowerCase()!=='websocket'||req.headers['sec-websocket-version']!=='13'||!/^[A-Za-z0-9+/]{22}==$/.test(key)){
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');return;
  }
  const accept=createHash('sha1').update(key+guid).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  let buffer=Buffer.alloc(0),parts=[],length=0,continuing=false;
  const lanes=new Map();
  const send=obj=>{if(socket.destroyed)return;socket.write(frame(1,JSON.stringify(obj)));};
  const close=(code=1000)=>{if(!socket.destroyed){const b=Buffer.alloc(2);b.writeUInt16BE(code);socket.end(frame(8,b));}};
  const dispatch=raw=>{
    let event;try{event=JSON.parse(raw);}catch{send({type:'error',error:{type:'invalid_request_error',message:'Invalid JSON'}});return;}
    if(event?.type!=='response.create'){send({type:'error',error:{type:'invalid_request_error',message:'Unsupported WebSocket event'}});return;}
    const payload=event.response&&typeof event.response==='object'?event.response:{...event};
    delete payload.type;delete payload.stream;
    const lane=event.stream_id??payload.stream_id??'default';
    if(typeof lane!=='string'||(lane!=='default'&&!/^[a-zA-Z0-9._-]{1,256}$/.test(lane))){send({type:'error',error:{type:'invalid_request_error',message:'Invalid stream_id'}});return;}
    delete payload.stream_id;
    const old=lanes.get(lane)||Promise.resolve();
    const job=old.catch(()=>{}).then(async()=>{
      try{
        const response=payload.generate===false?warmupResponses(payload,owner):await runResponses(payload,owner,postChat);
        for(const item of responsesEvents(response))send(lane==='default'?item:{...item,stream_id:lane});
      }catch(e){send({type:'error',error:{type:'gateway_error',message:String(e.message||'Request failed').slice(0,240)},...(lane==='default'?{}:{stream_id:lane})});}
    });
    lanes.set(lane,job);
    job.finally(()=>{if(lanes.get(lane)===job)lanes.delete(lane);});
  };
  const processBuffer=()=>{
    while(buffer.length>=2){
      const b0=buffer[0],b1=buffer[1],fin=!!(b0&0x80),opcode=b0&15;
      if((b0&0x70)!==0||!(b1&0x80)){close(1002);return;}
      let n=b1&127,offset=2;
      if(n===126){if(buffer.length<4)return;n=buffer.readUInt16BE(2);offset=4;}
      else if(n===127){if(buffer.length<10)return;const bn=buffer.readBigUInt64BE(2);if(bn>BigInt(MAX_MESSAGE)){close(1009);return;}n=Number(bn);offset=10;}
      if(n>MAX_MESSAGE||length+n>MAX_MESSAGE){close(1009);return;}
      if(buffer.length<offset+4+n)return;
      const mask=buffer.subarray(offset,offset+4);offset+=4;
      const data=Buffer.from(buffer.subarray(offset,offset+n));for(let i=0;i<data.length;i++)data[i]^=mask[i%4];
      buffer=buffer.subarray(offset+n);
      if(opcode===8){close();return;}
      if(opcode===9){socket.write(frame(10,data));continue;}
      if(opcode===10)continue;
      if(opcode===1){if(continuing){close(1002);return;}parts=[data];length=data.length;continuing=!fin;}
      else if(opcode===0){if(!continuing){close(1002);return;}parts.push(data);length+=data.length;continuing=!fin;}
      else{close(1003);return;}
      if(fin){const text=Buffer.concat(parts).toString('utf8');parts=[];length=0;dispatch(text);}
    }
  };
  socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);if(buffer.length>MAX_MESSAGE+64){close(1009);return;}processBuffer();});
  socket.on('error',()=>{});
  if(head?.length){buffer=Buffer.concat([buffer,head]);processBuffer();}
}
