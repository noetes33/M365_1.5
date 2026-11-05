#!/usr/bin/env node
// Run in an official m365-copilot-proxy checkout after placing the overlay.
// Adds a console command and a narrowly scoped auth privacy patch; runtime auth logic is retained.
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';

const repo = process.cwd();
const rootFile = path.join(repo,'package.json');
const consolePackage = path.join(repo,'packages/console/package.json');
const proxyLibPackage = path.join(repo,'packages/proxy-lib/package.json');
const authFile = path.join(repo,'packages/core/src/auth.ts');
for (const filename of [rootFile, consolePackage, proxyLibPackage, authFile]) {
  if (!existsSync(filename)) throw new Error(`Missing ${filename}. Run in the cloned m365-copilot-proxy repository after copying overlay files.`);
}
const original = readFileSync(rootFile,'utf8');
const pkg = JSON.parse(original);
if (pkg.name!=='m365-copilot-proxy') throw new Error('This is not the expected original m365-copilot-proxy repository');
if (!pkg.scripts || typeof pkg.scripts!=='object') throw new Error('Expected package.json scripts');
const additions = {
 'console': 'node packages/console/server.mjs',
 'console:test': 'node --test packages/console/tests/*.test.mjs',
};
let dirty=false;
for (const [key,val] of Object.entries(additions)) {
 if (pkg.scripts[key] && pkg.scripts[key]!==val) throw new Error(`Refusing to overwrite existing script ${key}`);
 if (pkg.scripts[key]!==val){pkg.scripts[key]=val;dirty=true;}
}
if(dirty) {
 const backup = path.join(repo,'package.console-backup.json');
 if(!existsSync(backup))copyFileSync(rootFile,backup);
 writeFileSync(rootFile,JSON.stringify(pkg,null,2)+'\n');
}
// Scope login-debug HTML/screenshot captures per isolated account, with an
// explicit opt-out so automated MFA/password input is not recorded as HTML.
// The default upstream paths/behavior remain unchanged outside console workers.
let auth=readFileSync(authFile,'utf8');
if(!auth.includes('M365_CONSOLE_DISABLE_LOGIN_CAPTURE')){
 const marker='async function capture(page: any, label: string): Promise<void> {';
 if(!auth.includes(marker))throw Error('Upstream auth.ts capture() changed; review privacy patch before using stored login credentials');
 const defaultDir='const CONFIG_DIR = join(homedir(), ".config", "opencode-m365");';
 if(!auth.includes(defaultDir))throw Error('Upstream auth.ts CONFIG_DIR changed; review isolated account paths');
 const backup=path.join(repo,'packages/core/auth.console-backup.ts.txt');
 if(!existsSync(backup))copyFileSync(authFile,backup);
 auth=auth.replace(defaultDir,'const CONFIG_DIR = process.env.M365_CONSOLE_CONFIG_DIR || join(homedir(), ".config", "opencode-m365");');
 auth=auth.replace(marker,marker+'\n  if (process.env.M365_CONSOLE_DISABLE_LOGIN_CAPTURE === "1") return;');
 writeFileSync(authFile,auth);
 console.log('Installed isolated auth config directory and disabled credential-page debug captures in console workers.');
}
console.log('M365 console workspace enabled. Upstream auth flow retained; console privacy patch applied.');
console.log('Next: pnpm install && pnpm build && pnpm console');
