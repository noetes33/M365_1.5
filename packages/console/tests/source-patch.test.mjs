import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const here=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const integration=join(here,'scripts','enable-console.mjs');
test('upstream auth privacy patch is minimal, re-runnable, and retains original getToken',()=>{
 const dir=mkdtempSync(join(tmpdir(),'m365-patch-test-'));
 try{
  for(const d of ['packages/console','packages/proxy-lib','packages/core/src'])mkdirSync(join(dir,d),{recursive:true});
  writeFileSync(join(dir,'package.json'),JSON.stringify({name:'m365-copilot-proxy',scripts:{build:'tsc'}}));
  for(const d of ['packages/console','packages/proxy-lib'])writeFileSync(join(dir,d,'package.json'),JSON.stringify({name:d}));
  const upstream='import {join} from "node:path";\nimport {homedir} from "node:os";\nconst CONFIG_DIR = join(homedir(), ".config", "opencode-m365");\nasync function capture(page: any, label: string): Promise<void> {\n try {} catch {}\n}\nexport function getToken() { return "upstream-logic"; }\n';
  const auth=join(dir,'packages/core/src/auth.ts');writeFileSync(auth,upstream);
  for(let i=0;i<2;i++){
   const run=spawnSync(process.execPath,[integration],{cwd:dir,encoding:'utf8'});
   assert.equal(run.status,0,run.stderr);
  }
  const result=readFileSync(auth,'utf8');
  assert.match(result,/M365_CONSOLE_CONFIG_DIR/);assert.match(result,/M365_CONSOLE_DISABLE_LOGIN_CAPTURE/);
  assert.match(result,/upstream-logic/);
  assert.equal((result.match(/M365_CONSOLE_DISABLE_LOGIN_CAPTURE/g)||[]).length,1);
  const original=join(dir,'packages/core/auth.console-backup.ts.txt');
  assert.equal(existsSync(original),true);assert.equal(readFileSync(original,'utf8'),upstream);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
