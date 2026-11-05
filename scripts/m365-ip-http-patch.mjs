#!/usr/bin/env node
// Docker-build-only patch: bypass transport HTTPS check in explicit test mode.
// Keeps administrator login, CSRF, role checks, second password, and vault encryption.
import {readFileSync,writeFileSync} from 'node:fs';
const serverPath='packages/console/server.mjs';
const uiPath='packages/console/public/app.js';
let server=readFileSync(serverPath,'utf8');
function once(s,from,to,label){
  if(s.includes(to))return s;
  if(!s.includes(from))throw new Error('Upstream changed; cannot patch '+label);
  return s.replace(from,to);
}
server=once(server,
  "const PORT=Number(process.env.M365_ADMIN_PORT||4142);",
  "const PORT=Number(process.env.M365_ADMIN_PORT||4142);\nconst HTTP_TEST_MODE=process.env.M365_HTTP_TEST_MODE==='1';",
  'test toggle');
server=once(server,
  "if (!['127.0.0.1','::1','localhost'].includes(HOST)) throw new Error('Admin console must bind to localhost; use a secure HTTPS reverse proxy for remote access.');",
  "if (!['127.0.0.1','::1','localhost'].includes(HOST) && !(HTTP_TEST_MODE && HOST==='0.0.0.0')) throw new Error('Non-local bind is permitted only in explicit M365_HTTP_TEST_MODE=1');",
  'host restriction');
server=once(server,
  "if(!secureCredentialTransport(req))return fail(res,403,'只能通过 HTTPS 管理后台保存敏感凭证');",
  "if(!HTTP_TEST_MODE && !secureCredentialTransport(req))return fail(res,403,'只能通过 HTTPS 管理后台保存敏感凭证');",
  'credential transport');
server=server.replace('管理员通过 HTTPS 网页配置加密自动登录凭证','管理员通过网页配置加密自动登录凭证');
server=server.replace('管理员通过 HTTPS 网页关闭自动登录凭证','管理员通过网页关闭自动登录凭证');
writeFileSync(serverPath,server);
let ui=readFileSync(uiPath,'utf8');
ui=ui.replace('在 HTTPS 管理网页中提交密码和软件 TOTP Base32 种子','在管理网页中提交密码和软件 TOTP Base32 种子');
ui=ui.replace('需要 HTTPS 访问后台。','当前为临时 HTTP 测试模式，传输未加密。');
ui=ui.replace('通过 HTTPS 网页配置，AES-256-GCM 加密保存，登录时短暂解密','通过网页配置，AES-256-GCM 加密保存，登录时短暂解密');
ui=ui.replace('支持在 HTTPS 后台配置自动登录凭证，无需再登录 VPS 终端输入。','测试模式支持 HTTP 配置自动登录凭证，无需再登录 VPS 终端输入。');
// Copy button fallback: navigator.clipboard is unavailable on insecure HTTP origins.
const orig='async function action(name,id){';
const replacement=`async function copyTextCompat(value){
 if(navigator.clipboard?.writeText){try{await navigator.clipboard.writeText(value);return;}catch{}}
 const t=document.createElement('textarea');t.value=value;t.style.position='fixed';t.style.opacity='0';document.body.appendChild(t);t.select();
 const ok=document.execCommand('copy');t.remove();if(!ok)throw Error('自动复制失败，请手动复制');
}
async function action(name,id){`;
ui=once(ui,orig,replacement,'clipboard fallback');
ui=ui.replaceAll('await navigator.clipboard.writeText(id)','await copyTextCompat(id)');
ui=ui.replaceAll('await navigator.clipboard.writeText(token)','await copyTextCompat(token)');
writeFileSync(uiPath,ui);
console.log('Explicit IP HTTP TEST mode patch applied (admin auth retained).');
