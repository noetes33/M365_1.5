// Fixed-source deployment queue. No shell or Docker access inside the web container.
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync,unlinkSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export const RELEASE_VERSION='2.2.3';
const readJson=(file)=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch{return null;}};
export function updateOverview(dataRoot){
  const root=join(dataRoot,'updates');
  const state=readJson(join(root,'status.json'))||{};
  const release=readJson(join(root,'release.json'))||{};
  const ready=existsSync(join(root,'ready'));
  const phase=String(state.phase||'idle');
  return {
    version:RELEASE_VERSION,
    commit:typeof release.commit==='string'?release.commit.slice(0,12):null,
    remoteCommit:typeof state.remoteCommit==='string'?state.remoteCommit.slice(0,12):null,
    updateAvailable:state.updateAvailable===true,
    enabled:ready,
    phase,
    step:String(state.step||''),
    message:String(state.message||'').slice(0,300),
    updatedAt:typeof state.updatedAt==='string'?state.updatedAt:null,
    pending:existsSync(join(root,'request.json')),
  };
}
export function queueUpdate(dataRoot,action){
  if(!['check','update'].includes(action))throw Object.assign(new Error('不支持的更新操作'),{status:400});
  const root=join(dataRoot,'updates');
  if(!existsSync(join(root,'ready')))throw Object.assign(new Error('尚未安装主机更新服务。请先执行一次安装脚本'),{status:409});
  const current=updateOverview(dataRoot);
  if(current.pending||['checking','backing-up','pulling','building','restarting','verifying'].includes(current.phase))
    throw Object.assign(new Error('已有更新任务正在执行'),{status:409});
  // Create request atomically so simultaneous clicks cannot replace an existing job.
  const request=join(root,'request.json'),id=randomUUID();
  let fd;
  try{
    fd=openSync(request,'wx',0o600);
    writeFileSync(fd,JSON.stringify({id,action,createdAt:new Date().toISOString()}),'utf8');
  }catch(e){
    if(e?.code==='EEXIST')throw Object.assign(new Error('已有更新任务排队'),{status:409});
    throw e;
  }finally{if(fd!==undefined)closeSync(fd);}
  return {queued:true,id,action};
}
