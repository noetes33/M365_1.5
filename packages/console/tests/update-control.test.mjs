import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {updateOverview,queueUpdate,RELEASE_VERSION} from '../update-control.mjs';
const sandbox=()=>{const root=mkdtempSync(join(tmpdir(),'m365-update-'));mkdirSync(join(root,'updates'));return root;};
test('dashboard shows the version without the host updater',()=>{
 const root=sandbox();try{const s=updateOverview(root);assert.equal(s.version,RELEASE_VERSION);assert.equal(s.enabled,false);assert.equal(s.pending,false);}finally{rmSync(root,{recursive:true,force:true});}
});
test('update tasks require host install and accept only fixed actions',()=>{
 const root=sandbox();try{
  assert.throws(()=>queueUpdate(root,'shell'),/不支持/);
  assert.throws(()=>queueUpdate(root,'update'),/尚未安装/);
  writeFileSync(join(root,'updates','ready'),'ready');
  const queued=queueUpdate(root,'check');assert.equal(queued.action,'check');
  const req=JSON.parse(readFileSync(join(root,'updates','request.json'),'utf8'));
  assert.equal(req.action,'check');assert.equal(req.id,queued.id);
  assert.throws(()=>queueUpdate(root,'update'),/已有/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('update state and deployed commit are read without leaking filesystem paths',()=>{
 const root=sandbox();try{
  const dir=join(root,'updates');writeFileSync(join(dir,'ready'),'ready');
  writeFileSync(join(dir,'release.json'),JSON.stringify({commit:'abcdef1234567890'}));
  writeFileSync(join(dir,'status.json'),JSON.stringify({phase:'done',remoteCommit:'feedcafe12345678',updateAvailable:false,message:'update complete'}));
  const v=updateOverview(root);
  assert.equal(v.commit,'abcdef123456');assert.equal(v.remoteCommit,'feedcafe1234');assert.equal(v.enabled,true);assert.equal(v.phase,'done');
 }finally{rmSync(root,{recursive:true,force:true});}
});
