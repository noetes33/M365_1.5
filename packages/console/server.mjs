import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { openStore,uuid,hash,scrypt,safeJSON,now,audit,publicUser,publicKey,publicAccount,publicChannel } from './store.mjs';
import { requestUpstream, isEmbedded, embeddedState, configureAccounts } from './embedded.mjs';
import { accountStatus, accountReady, beginAuthorizedLogin, beginAutomatedLogin, hasAutoSecrets, importExternalMsalCache, importExternalAtRt, retryImportedCacheVerification, unlinkAccount, shutdownWorkers } from './account-manager.mjs';
import {saveCredentials,eraseCredentials} from './credential-vault.mjs';
import {updateOverview,queueUpdate} from './update-control.mjs';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const HOST=process.env.M365_ADMIN_HOST||'127.0.0.1';
const PORT=Number(process.env.M365_ADMIN_PORT||4142);
const DATA=process.env.M365_ADMIN_DATA||path.join(os.homedir(),'.config','m365-copilot-console');
if (!['127.0.0.1','::1','localhost'].includes(HOST)) throw new Error('Admin console must bind to localhost; use a secure HTTPS reverse proxy for remote access.');
if (!Number.isInteger(PORT)||PORT<1||PORT>65535) throw new Error('Invalid port');
const db=openStore(DATA,process.env.M365_ADMIN_PASSWORD||'');
configureAccounts(DATA,db);
const pendingUsers=new Map(),pendingKeys=new Map(),pendingChannels=new Map(),minuteHits=new Map();
let sequence=0;
const fail=(res,status,message)=>json(res,status,{error:{type:'gateway_error',message}});
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
function headers(res){res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");}
const numeric=(v,def,min,max)=>v===undefined?def:(v===null?null:(Number.isSafeInteger(Number(v))&&Number(v)>=min&&Number(v)<=max?Number(v):NaN));
const isNumValid=(n)=>n===null||Number.isSafeInteger(n);
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
const message=(s,max=160)=>String(s??'').trim().slice(0,max);
const passwordHash=pass=>{const salt=crypto.randomBytes(16).toString('hex');return {salt,password_hash:scrypt(pass,salt)}};
function isLocalUpstream(value){if(/^account:\/\/[a-f0-9-]{36}$/i.test(value))return true;if(isEmbedded(value))return true;try{const u=new URL(value);return u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)&&(!u.pathname||u.pathname==='/')&&!u.username&&!u.password&&!u.search&&!u.hash&&Number(u.port)>0;}catch{return false;}}
async function body(req,max=8*1024*1024){let size=0;const bufs=[];for await(const c of req){size+=c.length;if(size>max)throw Object.assign(new Error('请求体过大'),{status:413});bufs.push(c);}return Buffer.concat(bufs);}
async function input(req,max=160*1024){const raw=await body(req,max);let value;try{value=JSON.parse(raw.toString('utf8'));}catch{throw Object.assign(new Error('JSON 格式错误'),{status:400});}if(!value||Array.isArray(value)||typeof value!=='object')throw Object.assign(new Error('JSON 对象无效'),{status:400});return value;}
function cookie(req,name){return (req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1);}
function session(req){const token=cookie(req,'m365_console_session');if(!token)return null;const s=db.one('SELECT s.*,u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.enabled=1',hash(token),Date.now());return s?{csrf:s.csrf,user:s}:null;}
function originOK(req){const o=req.headers.origin;if(!o)return true;try{return new URL(o).host===req.headers.host;}catch{return false;}}
function requireSession(req,res,unsafe=false){const s=session(req);if(!s){fail(res,401,'请先登录管理后台');return null;}if(unsafe&&(req.headers['x-csrf-token']!==s.csrf||!originOK(req))){fail(res,403,'CSRF 校验失败');return null;}return s;}
function secureCredentialTransport(req){
  if(req.socket.encrypted)return true;
  // Only a trusted HTTPS reverse proxy on the loopback interface may forward
  // these credential requests. NEVER expose the Node listener publicly.
  const addr=req.socket.remoteAddress||'';
  return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(addr)&&req.headers['x-forwarded-proto']==='https';
}
function requireRole(res,user,roles){if(roles.includes(user.role))return true;fail(res,403,'当前用户无此管理权限');return false;}
function authKey(req){const m=/^Bearer (m365_[a-f0-9]{64})$/i.exec(req.headers.authorization||'');if(!m)return null;const k=db.one('SELECT * FROM api_keys WHERE secret_hash=? AND enabled=1',hash(m[1]));if(!k)return null;const u=db.one('SELECT * FROM users WHERE id=? AND enabled=1',k.owner_id);if(!u)return null;if(k.expires_at&&k.expires_at<now())return null;
  if(!k.account_id||!db.one('SELECT 1 FROM user_accounts ua JOIN accounts a ON a.id=ua.account_id WHERE ua.user_id=? AND ua.account_id=? AND a.enabled=1',u.id,k.account_id))return null;
  return {k,u};}
function visibleModels(user,key){const enabled=db.all('SELECT id,cost_units FROM models WHERE enabled=1');const scope=safeJSON(key?.models_json,null);return enabled.filter(m=>scope===null||scope.includes(m.id));}
function matchingChannels(model,accountId=null){return db.all('SELECT c.*,a.enabled AS account_enabled,a.runtime_type AS account_type,a.email_hint,a.tenant_hint FROM channels c JOIN accounts a ON a.id=c.account_id WHERE c.enabled=1 AND a.enabled=1 ORDER BY c.priority ASC,c.weight DESC').filter(c=>(accountId?c.account_id===accountId:c.account_type==='legacy') && (c.account_type!=='isolated'||accountReady(DATA,{id:c.account_id,runtime_type:c.account_type,email_hint:c.email_hint,tenant_hint:c.tenant_hint,enabled:c.account_enabled})) && (safeJSON(c.models_json,null)===null||safeJSON(c.models_json,[]).includes(model)));}
function chooseChannel(model,accountId=null){const channels=matchingChannels(model,accountId);if(!channels.length)return null;const ready=channels.filter(c=>(pendingChannels.get(c.id)||0)<c.concurrency_limit);if(!ready.length)return null;const bestPriority=ready[0].priority;const pool=ready.filter(c=>c.priority===bestPriority);const total=pool.reduce((n,c)=>n+c.weight,0);let step=(sequence++)%total;for(const c of pool){if(step<c.weight)return c;step-=c.weight;}return pool[0];}
function reserve(map,id,delta){const num=(map.get(id)||0)+delta;if(num>0)map.set(id,num);else map.delete(id);}
function checkMinute(id,max=60){const time=Date.now();const hits=(minuteHits.get(id)||[]).filter(x=>x>time-60000);if(hits.length>=max){minuteHits.set(id,hits);return false;}hits.push(time);minuteHits.set(id,hits);return true;}
async function probe(channel){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),1800);try{const res=await requestUpstream(channel,'/v1/models',{signal:controller.signal},'internal-health');return {id:channel.id,online:res.ok,status:res.status};}catch{return {id:channel.id,online:false,status:null};}finally{clearTimeout(timer);}}
function usageSummary(rows){const total=rows.length,ok=rows.filter(x=>x.status>=200&&x.status<300),lat=rows.reduce((a,x)=>a+x.latency_ms,0);return {total,ok:ok.length,successRate:total?Math.round(ok.length/total*100):100,avgLatency:total?Math.round(lat/total):0,units:rows.reduce((a,x)=>a+x.units,0)};}
function logUsage({u,k,c,model,status,started,units,usage,requestId}){
  const inputTokens=usage?.prompt_tokens>0?Math.round(usage.prompt_tokens):null,outputTokens=usage?.completion_tokens>0?Math.round(usage.completion_tokens):null;
  const source=inputTokens!==null||outputTokens!==null?'upstream':'unavailable';
  db.run('INSERT INTO usage(id,created_at,user_id,key_id,channel_id,model,status,latency_ms,units,input_tokens,output_tokens,usage_source,request_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',uuid(),now(),u.id,k.id,c?.id||null,model,status,Date.now()-started,units,inputTokens,outputTokens,source,requestId);
  if(units>0){db.run('UPDATE users SET used_units=used_units+? WHERE id=?',units,u.id);db.run('UPDATE api_keys SET used_units=used_units+? WHERE id=?',units,k.id);}
  db.run('UPDATE api_keys SET last_used=? WHERE id=?',now(),k.id);
}
function validChannelAccount(account,upstream){return account?.runtime_type==='isolated' ? upstream==='account://'+account.id : !upstream.startsWith('account://');}
function validKeyAccount(owner,accountId,actor){if(!accountId)return false;const a=db.one('SELECT id FROM accounts WHERE id=? AND enabled=1',accountId);if(!a)return false;return !!db.one('SELECT account_id FROM user_accounts WHERE user_id=? AND account_id=?',owner,accountId);}
const adminRoutes = async(req,res,route,parts)=>{
 const method=req.method,unsafe=!['GET','HEAD'].includes(method);
 if(route==='/auth/login'&&method==='POST'){
   if(!originOK(req))return fail(res,403,'Origin 不合法');
   const ip=req.socket.remoteAddress||'local';if(!checkMinute('login:'+ip,8))return fail(res,429,'登录尝试过于频繁');
   const b=await input(req,10*1024),email=message(b.email||'admin@local',190).toLowerCase(),u=db.one('SELECT * FROM users WHERE email=? AND enabled=1',email);
   const dummySalt='00000000000000000000000000000000';const result=scrypt(message(b.password,1024),u?.salt||dummySalt);
   const good=!!u&&crypto.timingSafeEqual(Buffer.from(result,'hex'),Buffer.from(u.password_hash,'hex'));
   if(!good)return fail(res,401,'账号或密码不正确');
   const token=crypto.randomBytes(32).toString('hex'),csrf=crypto.randomBytes(24).toString('hex');
   db.run('INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)',hash(token),u.id,csrf,Date.now()+12*3600_000);
   db.run('UPDATE users SET last_login=? WHERE id=?',now(),u.id);
   audit(db,u.id,'auth.login','user:'+u.id,'管理后台登录');
   res.setHeader('Set-Cookie',`m365_console_session=${token}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=43200${secureCredentialTransport(req)?'; Secure':''}`);
   return json(res,200,{csrf,user:publicUser(u)});
 }
 const s=requireSession(req,res,unsafe);if(!s)return;
 const user=db.one('SELECT * FROM users WHERE id=?',s.user.id);
 if(route==='/auth/me'&&method==='GET')return json(res,200,{csrf:s.csrf,user:publicUser(user)});
 if(route==='/system/update'&&method==='GET'){
   if(!requireRole(res,user,['admin']))return;
   return json(res,200,updateOverview(DATA));
 }
 if(route==='/system/update/check'&&method==='POST'){
   if(!requireRole(res,user,['admin']))return;
   return json(res,202,queueUpdate(DATA,'check'));
 }
 if(route==='/system/update/apply'&&method==='POST'){
   if(!requireRole(res,user,['admin']))return;
   return json(res,202,queueUpdate(DATA,'update'));
 }

 if(route==='/auth/logout'&&method==='POST'){
   db.run('DELETE FROM sessions WHERE token_hash=?',hash(cookie(req,'m365_console_session')));
   res.setHeader('Set-Cookie','m365_console_session=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0');return json(res,200,{ok:true});
 }
 if(route==='/auth/password'&&method==='POST'){
   const b=await input(req),old=scrypt(String(b.current||''),user.salt);
   if(!crypto.timingSafeEqual(Buffer.from(old,'hex'),Buffer.from(user.password_hash,'hex')))return fail(res,403,'原密码不正确');
   if(typeof b.next!=='string'||b.next.length<12||b.next.length>256)return fail(res,400,'新密码长度必须为 12~256 位');
   const p=passwordHash(b.next);db.run('UPDATE users SET salt=?,password_hash=? WHERE id=?',p.salt,p.password_hash,user.id);
   db.run('DELETE FROM sessions WHERE user_id=? AND token_hash<>?',user.id,hash(cookie(req,'m365_console_session')));
   audit(db,user.id,'auth.password','user:'+user.id,'用户主动修改密码');return json(res,200,{ok:true});
 }
 if(route==='/dashboard'&&method==='GET'){
   const admin=user.role!=='user';const where=admin?'':'WHERE user_id=?';const args=admin?[]:[user.id];
   const rows=db.all(`SELECT * FROM usage ${where} ORDER BY created_at DESC LIMIT 10`,...args),today=now().slice(0,10),last7={};for(let i=6;i>=0;i--){const d=new Date(Date.now()-i*864e5).toISOString().slice(0,10);last7[d]=0;}
   const summary=db.one(`SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN status BETWEEN 200 AND 299 THEN 1 ELSE 0 END),0) AS ok,COALESCE(ROUND(AVG(latency_ms)),0) AS avgLatency,COALESCE(SUM(units),0) AS units FROM usage ${where}`,...args);
   summary.successRate=summary.total?Math.round(summary.ok/summary.total*100):100;
   const daily=db.one('SELECT COUNT(*) AS n FROM usage WHERE created_at>=?'+(admin?'':' AND user_id=?'),...([today,...args]));
   const groupDays=db.all('SELECT substr(created_at,1,10) AS day,COUNT(*) AS n FROM usage WHERE created_at>=?'+(admin?'':' AND user_id=?')+' GROUP BY substr(created_at,1,10)',...([Object.keys(last7)[0],...args]));
   for(const r of groupDays)if(r.day in last7)last7[r.day]=r.n;
   const modelStats=db.all('SELECT model,COUNT(*) requests,COALESCE(SUM(units),0) units FROM usage '+where+' GROUP BY model ORDER BY requests DESC LIMIT 6',...args);
   const userTop=admin?db.all('SELECT u.name,COUNT(*) requests,COALESCE(SUM(x.units),0) units FROM usage x JOIN users u ON u.id=x.user_id GROUP BY x.user_id ORDER BY requests DESC LIMIT 5'):[];
   return json(res,200,{stats:summary,today:daily.n,trend:last7,modelStats,userTop,count:{users:admin?db.one('SELECT COUNT(*) n FROM users').n:1,accounts:admin?db.one('SELECT COUNT(*) n FROM accounts').n:0,channels:admin?db.one('SELECT COUNT(*) n FROM channels').n:0,keys:db.one('SELECT COUNT(*) n FROM api_keys '+(admin?'':'WHERE owner_id=?'),...args).n},recent:rows,me:publicUser(user)});
 }
 if(route==='/users'&&method==='GET'){
   if(!requireRole(res,user,['admin','operator']))return;
   return json(res,200,{data:db.all('SELECT * FROM users ORDER BY created_at DESC').map(publicUser)});
 }
 if(route==='/users'&&method==='POST'){
   if(!requireRole(res,user,['admin']))return;
   const b=await input(req),email=message(b.email,190).toLowerCase(),name=message(b.name,80),role=b.role||'user';
   if(!/^\S+@\S+\.\S+$/.test(email)||!name||!['admin','operator','user'].includes(role)||typeof b.password!=='string'||b.password.length<12)return fail(res,400,'邮箱、名称、角色或密码不合法（密码至少12位）');
   const quota=numeric(b.quota_units,null,0,1e9),daily=numeric(b.daily_limit,null,0,1e6),concurrency=numeric(b.concurrency_limit,2,1,20);
   if(![quota,daily,concurrency].every(isNumValid))return fail(res,400,'额度参数不合法');
   if(db.one('SELECT id FROM users WHERE email=?',email))return fail(res,409,'邮箱已存在');
   const p=passwordHash(b.password),id=uuid();db.run('INSERT INTO users(id,email,name,role,salt,password_hash,quota_units,daily_limit,concurrency_limit,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',id,email,name,role,p.salt,p.password_hash,quota,daily,concurrency,now());audit(db,user.id,'users.create',id,email);
   return json(res,201,{data:publicUser(db.one('SELECT * FROM users WHERE id=?',id))});
 }
 if(parts[1]==='users'&&parts.length===3&&method==='PATCH'){
   if(!requireRole(res,user,['admin']))return;
   const target=db.one('SELECT * FROM users WHERE id=?',parts[2]);if(!target)return fail(res,404,'用户不存在');
   const b=await input(req),name=message(b.name??target.name,80),role=b.role??target.role,enabled=b.enabled===undefined?target.enabled:(b.enabled?1:0),quota=numeric(b.quota_units,target.quota_units,0,1e9),daily=numeric(b.daily_limit,target.daily_limit,0,1e6),concurrency=numeric(b.concurrency_limit,target.concurrency_limit,1,20);
   if(!name||!['admin','operator','user'].includes(role)||![quota,daily,concurrency].every(isNumValid))return fail(res,400,'参数不合法');
   if(user.id===target.id&&(role!=='admin'||!enabled))return fail(res,400,'不能撤销自己的管理员权限');
   if(target.role==='admin'&&(!enabled||role!=='admin')&&db.one('SELECT COUNT(*) n FROM users WHERE role=? AND enabled=1','admin').n===1)return fail(res,400,'系统必须保留至少一个管理员');
   db.run('UPDATE users SET name=?,role=?,enabled=?,quota_units=?,daily_limit=?,concurrency_limit=? WHERE id=?',name,role,enabled,quota,daily,concurrency,target.id);
   if(!enabled)db.run('DELETE FROM sessions WHERE user_id=?',target.id);
   audit(db,user.id,'users.update',target.id,'更新用户及权限');return json(res,200,{data:publicUser(db.one('SELECT * FROM users WHERE id=?',target.id))});
 }
 if(parts[1]==='users'&&parts[3]==='password'&&method==='POST'){
   if(!requireRole(res,user,['admin']))return;
   const target=db.one('SELECT * FROM users WHERE id=?',parts[2]);if(!target)return fail(res,404,'用户不存在');
   const b=await input(req);if(typeof b.password!=='string'||b.password.length<12||b.password.length>256)return fail(res,400,'密码长度必须为 12~256 位');
   const p=passwordHash(b.password);db.run('UPDATE users SET salt=?,password_hash=? WHERE id=?',p.salt,p.password_hash,target.id);
   db.run('DELETE FROM sessions WHERE user_id=?',target.id);
   audit(db,user.id,'users.password',target.id,'管理员重置密码；明文未入审计日志');return json(res,200,{ok:true});
 }
 if(parts[1]==='users'&&parts[3]==='reset'&&method==='POST'){
   if(!requireRole(res,user,['admin']))return;const target=db.one('SELECT * FROM users WHERE id=?',parts[2]);if(!target)return fail(res,404,'用户不存在');
   db.run('UPDATE users SET used_units=0 WHERE id=?',target.id);audit(db,user.id,'users.reset',target.id,'用户额度计数已重置；历史用量保留');return json(res,200,{ok:true});
 }
 if(parts[1]==='users'&&parts.length===4&&parts[3]==='accounts'&&method==='GET'){
   if(!requireRole(res,user,['admin']))return;
   if(!db.one('SELECT id FROM users WHERE id=?',parts[2]))return fail(res,404,'用户不存在');
   return json(res,200,{data:db.all('SELECT account_id FROM user_accounts WHERE user_id=?',parts[2]).map(x=>x.account_id)});
 }
 if(parts[1]==='users'&&parts.length===4&&parts[3]==='accounts'&&method==='PUT'){
   if(!requireRole(res,user,['admin']))return;
   if(!db.one('SELECT id FROM users WHERE id=?',parts[2]))return fail(res,404,'用户不存在');
   const b=await input(req),ids=b.accounts;
   if(!Array.isArray(ids)||ids.length>100||new Set(ids).size!==ids.length||ids.some(id=>!db.one('SELECT id FROM accounts WHERE id=?',id)))return fail(res,400,'账号权限列表无效');
   db.db.exec('BEGIN IMMEDIATE');
   try{db.run('DELETE FROM user_accounts WHERE user_id=?',parts[2]);for(const id of ids)db.run('INSERT INTO user_accounts(user_id,account_id) VALUES(?,?)',parts[2],id);db.db.exec('COMMIT');}
   catch(e){db.db.exec('ROLLBACK');throw e;}
   audit(db,user.id,'users.accounts',parts[2],`分配 ${ids.length} 个账号访问权限`);return json(res,200,{data:ids});
 }
 if(route==='/available-accounts'&&method==='GET'){
   const rows=user.role==='admin'?db.all('SELECT * FROM accounts WHERE enabled=1'):db.all('SELECT a.* FROM accounts a JOIN user_accounts ua ON ua.account_id=a.id WHERE ua.user_id=? AND a.enabled=1',user.id);
   return json(res,200,{data:rows.map(a=>({id:a.id,label:a.label,runtime_type:a.runtime_type}))});
 }
 if(route==='/accounts'&&method==='GET'){
   if(!requireRole(res,user,['admin','operator']))return;
   return json(res,200,{data:db.all('SELECT * FROM accounts ORDER BY created_at DESC').map(a=>({...publicAccount(a),auth:accountStatus(DATA,a)}))});
 }
 if(route==='/accounts'&&method==='POST'){
   if(!requireRole(res,user,['admin']))return;
   const b=await input(req),label=message(b.label,90),type=b.runtime_type==='isolated'?'isolated':'legacy',email=message(b.email_hint,190).toLowerCase();
   if(!label)return fail(res,400,'账号名称不能为空');
   if(type==='isolated'&&!/^\S+@\S+\.\S+$/.test(email))return fail(res,400,'独立账号必须填写准确的微软登录邮箱');
   const id=uuid();db.run('INSERT INTO accounts(id,label,email_hint,tenant_hint,notes,runtime_type,created_at) VALUES(?,?,?,?,?,?,?)',id,label,email,message(b.tenant_hint,120),message(b.notes,1000),type,now());
   db.run('INSERT OR IGNORE INTO user_accounts(user_id,account_id) VALUES(?,?)',user.id,id);
   if(type==='isolated')db.run('INSERT INTO channels(id,name,account_id,upstream,enabled,created_at) VALUES(?,?,?,?,?,?)',uuid(),label+' - 专属渠道',id,'account://'+id,1,now());
   audit(db,user.id,'accounts.create',id,`创建 ${type} 账号档案`);return json(res,201,{data:publicAccount(db.one('SELECT * FROM accounts WHERE id=?',id))});
 }
 if(parts[1]==='accounts'&&parts.length===3&&method==='PATCH'){
   if(!requireRole(res,user,['admin']))return;
   const a=db.one('SELECT * FROM accounts WHERE id=?',parts[2]);if(!a)return fail(res,404,'账号不存在');const b=await input(req),label=message(b.label??a.label,90);
   if(!label)return fail(res,400,'名称不能为空');if(a.runtime_type==='isolated'&&message(b.email_hint??a.email_hint,190).toLowerCase()!==a.email_hint.toLowerCase())return fail(res,409,'已绑定的身份邮箱不可更改；请解除关联后新建账号');db.run('UPDATE accounts SET label=?,email_hint=?,tenant_hint=?,notes=?,enabled=? WHERE id=?',label,message(b.email_hint??a.email_hint,190),message(b.tenant_hint??a.tenant_hint,120),message(b.notes??a.notes,1000),b.enabled===undefined?a.enabled:(b.enabled?1:0),a.id);
   audit(db,user.id,'accounts.update',a.id,'更新账号档案与启用状态');return json(res,200,{data:publicAccount(db.one('SELECT * FROM accounts WHERE id=?',a.id))});
 }
 if(parts[1]==='accounts'&&parts.length===3&&method==='DELETE'){
   if(!requireRole(res,user,['admin']))return;const linked=db.one('SELECT COUNT(*) n FROM channels WHERE account_id=?',parts[2]).n;
   if(linked)return fail(res,409,'请先删除该账号关联的渠道');const target=db.one('SELECT * FROM accounts WHERE id=?',parts[2]);if(target?.runtime_type==='isolated')await unlinkAccount(DATA,target);const r=db.run('DELETE FROM accounts WHERE id=?',parts[2]);if(!r.changes)return fail(res,404,'账号不存在');audit(db,user.id,'accounts.delete',parts[2],'删除账号档案');return json(res,200,{ok:true});
 }
 // Console-only chat test: use the selected Microsoft account's existing
 // channel and OpenAI-compatible upstream. No external API Key is needed.
 if(parts[1]==='accounts'&&parts.length===4&&parts[3]==='test-chat'&&method==='POST'){
   if(!requireRole(res,user,['admin','operator']))return;
   const account=db.one('SELECT * FROM accounts WHERE id=?',parts[2]);
   if(!account)return fail(res,404,'微软账号不存在');
   if(!account.enabled)return fail(res,409,'微软账号未启用');
   const b=await input(req);
   const model=typeof b.model==='string'?b.model.trim():'';
   if(!model||!db.one('SELECT 1 FROM models WHERE id=? AND enabled=1',model))
     return fail(res,400,'请选择「模型与额度」中已启用的模型');
   const messages=b.messages;
   if(!Array.isArray(messages)||messages.length===0||messages.length>40||
      messages.some(m=>!m||!['user','assistant','system'].includes(m.role)||typeof m.content!=='string'||!m.content.trim()||m.content.length>12000)||
      messages[messages.length-1].role!=='user')
     return fail(res,400,'请填写有效的对话内容');
   const state=accountStatus(DATA,account);
   const available=matchingChannels(model,account.id);
   if(!available.length)return fail(res,409,`账号当前不可调用该模型（认证状态：${state.state}${state.error?'；'+state.error:''}；或渠道未启用/不支持该模型）`);
   const channel=chooseChannel(model,account.id);
   if(!channel)return fail(res,429,'对应渠道正在处理其他请求');
   const started=Date.now();
   const controller=new AbortController();
   const timer=setTimeout(()=>controller.abort(),channel.timeout_ms);
   req.on('aborted',()=>controller.abort());
   reserve(pendingChannels,channel.id,1);
   try{
     const upstream=await requestUpstream(channel,'/v1/chat/completions',{
       method:'POST',body:JSON.stringify({model,messages,stream:false}),signal:controller.signal
     },'internal-chat-test');
     const raw=await upstream.text();
     if(Buffer.byteLength(raw,'utf8')>1024*1024)return fail(res,502,'模型测试返回内容过大');
     const result=safeJSON(raw,{});
     const content=result?.choices?.[0]?.message?.content;
     const reply=typeof content==='string'?content:Array.isArray(content)?content.map(p=>p?.text||'').join(''):'';
     const latencyMs=Date.now()-started;
     if(!upstream.ok)return json(res,200,{ok:false,httpStatus:upstream.status,latencyMs,
       message:message(result?.error?.message||raw||'上游返回错误',600)});
     if(!reply)return json(res,200,{ok:false,httpStatus:upstream.status,latencyMs,
       message:'上游返回成功，但没有解析到标准聊天回复'});
     return json(res,200,{ok:true,httpStatus:upstream.status,latencyMs,model,reply});
   }catch(e){
     return json(res,200,{ok:false,httpStatus:controller.signal.aborted?504:502,
       latencyMs:Date.now()-started,message:controller.signal.aborted?'模型请求超过渠道设置的超时时间':'模型调用失败：'+message(e?.message,240)});
   }finally{clearTimeout(timer);reserve(pendingChannels,channel.id,-1);}
 }
 if(parts[1]==='accounts'&&parts.length===4&&parts[3]==='status'&&method==='GET'){
   if(!requireRole(res,user,['admin','operator']))return;
   const a=db.one('SELECT * FROM accounts WHERE id=?',parts[2]);if(!a)return fail(res,404,'账号不存在');
   return json(res,200,{data:accountStatus(DATA,a)});
 }
 if(parts[1]==='accounts'&&parts.length===4&&parts[3]==='authorize'&&method==='POST'){
   if(!requireRole(res,user,['admin']))return;
   const a=db.one('SELECT * FROM accounts WHERE id=?',parts[2]);if(!a)return fail(res,404,'账号不存在');
   if(a.runtime_type!=='isolated')return fail(res,400,'该账号是旧版档案，请创建独立授权账号');
   try{const result=await beginAuthorizedLogin(DATA,a);audit(db,user.id,'accounts.authorize',a.id,'管理员启动本机交互式登录');return json(res,202,result);}catch(e){return fail(res,409,e.message);}
 }
 // Direct AT / RT form: accept the active admin console transport (HTTP or HTTPS).
 if(parts[1]==='accounts'&&parts.length===4&&parts[3]==='import-at-rt'&&method==='POST'){
   if(!requireRole(res,user,['admin']))return;
   const a=db.one('SELECT * FROM accounts WHERE id=?',parts[2]);
   if(!a||a.runtime_type!=='isolated')return fail(res,404,'独立微软账号不存在');
   if(!checkMinute('at-rt-import:'+user.id,5))return fail(res,429,'Token 保存操作过于频繁');
   const b=await input(req,140*1024);
   if(typeof b.admin_password!=='string'||b.admin_password.length>1024)return fail(res,403,'请重新输入管理后台密码');
   const checked=scrypt(b.admin_password,user.salt);
   if(!crypto.timingSafeEqual(Buffer.from(checked,'hex'),Buffer.from(user.password_hash,'hex')))
     return fail(res,403,'管理员密码不正确');
   try{
     const result=await importExternalAtRt(DATA,a,b.access_token,b.refresh_token);
     audit(db,user.id,'accounts.at_rt_import',a.id,'管理员导入 AT 与 RT；未记录任何 Token');
     return json(res,202,result);
   }catch(e){return fail(res,e.status===400?400:409,e.status===400?e.message:'AT / RT 保存或认证失败，请检查账号及 Token 对应的客户端');}
 }
 if(parts[1]==='accounts'&&parts.length===4&&parts[3]==='import-msal-cache'&&method==='POST'){
   if(!requireRole(res,user,['admin']))return;
   const a=db.one('SELECT * FROM accounts WHERE id=?',parts[2]);
   if(!a||a.runtime_type!=='isolated')return fail(res,404,'独立微软账号不存在');
   // Deliberately NOT bypassed by M365_HTTP_TEST_MODE: the entire serialized
   // cache includes long-lived credentials, so cleartext transport is unsafe.
   if(!secureCredentialTransport(req))return fail(res,403,'外部授权缓存只能通过 HTTPS 导入；当前 HTTP 测试入口不支持');
   if(!checkMinute('msal-import:'+user.id,5))return fail(res,429,'外部缓存导入操作过于频繁');
   const b=await input(req,1200*1024);
   if(typeof b.admin_password!=='string'||b.admin_password.length>1024)return fail(res,403,'请重新输入管理后台密码');
   const checked=scrypt(b.admin_password,user.salt);
   if(!crypto.timingSafeEqual(Buffer.from(checked,'hex'),Buffer.from(user.password_hash,'hex')))return fail(res,403,'管理员密码不正确');
   try{
     const result=await importExternalMsalCache(DATA,a,b.msal_cache);
     audit(db,user.id,'accounts.msal_cache_import',a.id,'管理员通过 HTTPS 导入已有 MSAL 会话缓存；未记录 Token');
     return json(res,202,result);
   }catch(e){return fail(res,e.status===400?400:409,e.status===400?e.message:'导入缓存失败：'+(e.message==='Account authorization in progress'?'账号当前正在授权':'请确认缓存格式及账户配置'));}
 }
 if(parts[1]==='accounts'&&parts.length===4&&parts[3]==='verify-msal-cache'&&method==='POST'){
   if(!requireRole(res,user,['admin']))return;
   const a=db.one('SELECT * FROM accounts WHERE id=?',parts[2]);
   if(!a||a.runtime_type!=='isolated')return fail(res,404,'独立微软账号不存在');
   try{return json(res,202,await retryImportedCacheVerification(DATA,a));}
   catch{return fail(res,409,'当前没有可验证的导入缓存，或正在执行授权');}
 }
 if(parts[1]==='accounts'&&parts.length===4&&parts[3]==='credentials'&&['PUT','DELETE'].includes(method)){
   if(!requireRole(res,user,['admin']))return;
   const a=db.one('SELECT * FROM accounts WHERE id=?',parts[2]);
   if(!a||a.runtime_type!=='isolated')return fail(res,404,'独立微软账号不存在');
   if(!secureCredentialTransport(req))return fail(res,403,'只能通过 HTTPS 管理后台保存敏感凭证');
   if(!checkMinute('credentials:'+user.id,10))return fail(res,429,'敏感配置操作过于频繁');
   const b=await input(req,4096);
   if(typeof b.admin_password!=='string'||b.admin_password.length>1024)return fail(res,403,'请重新输入管理后台密码');
   const checked=scrypt(b.admin_password,user.salt);
   if(!crypto.timingSafeEqual(Buffer.from(checked,'hex'),Buffer.from(user.password_hash,'hex')))return fail(res,403,'管理员密码不正确');
   if(method==='PUT'){
     try{saveCredentials(DATA,a.id,a.email_hint,b.password,b.mfaSecret);}
     catch(e){return fail(res,400,e.message==='Credential vault unavailable'?'加密凭证库不可用':e.message);}
     audit(db,user.id,'accounts.credentials.set',a.id,'管理员通过 HTTPS 网页配置加密自动登录凭证');
     return json(res,200,{ok:true,configured:true});
   }
   eraseCredentials(DATA,a.id);
   audit(db,user.id,'accounts.credentials.remove',a.id,'管理员通过 HTTPS 网页关闭自动登录凭证');
   return json(res,200,{ok:true,configured:false});
 }
 if(parts[1]==='accounts'&&parts.length===4&&parts[3]==='auto-login'&&method==='POST'){
   if(!requireRole(res,user,['admin']))return;
   const a=db.one('SELECT * FROM accounts WHERE id=?',parts[2]);if(!a)return fail(res,404,'账号不存在');
   if(a.runtime_type!=='isolated')return fail(res,400,'只支持独立授权账号');
   if(!hasAutoSecrets(DATA,a.id))return fail(res,409,'请先在网页「配置自动登录」中填写凭证');
   try{const result=await beginAutomatedLogin(DATA,a);audit(db,user.id,'accounts.auto_login',a.id,'启动已授权账号的自动登录');return json(res,202,result);}catch(e){return fail(res,409,'账号正在授权或工作进程不可用');}
 }
 if(parts[1]==='accounts'&&parts.length===4&&parts[3]==='unlink'&&method==='POST'){
   if(!requireRole(res,user,['admin']))return;
   const a=db.one('SELECT * FROM accounts WHERE id=?',parts[2]);if(!a)return fail(res,404,'账号不存在');
   if(a.runtime_type!=='isolated')return fail(res,400,'旧版账号不支持解绑');
   db.run('UPDATE channels SET enabled=0 WHERE account_id=?',a.id);
   await unlinkAccount(DATA,a);audit(db,user.id,'accounts.unlink',a.id,'移除独立 MSAL 缓存与浏览器档案，停用关联渠道');return json(res,200,{ok:true});
 }
 if(route==='/channels'&&method==='GET'){
   if(!requireRole(res,user,['admin','operator']))return;
   return json(res,200,{data:db.all('SELECT c.* FROM channels c ORDER BY c.priority,c.created_at').map(publicChannel)});
 }
 if(route==='/channels'&&method==='POST'){
   if(!requireRole(res,user,['admin']))return;
   const b=await input(req),name=message(b.name,90),upstream=message(b.upstream,200),account=db.one('SELECT * FROM accounts WHERE id=?',b.account_id);
   const priority=numeric(b.priority,10,0,1000),weight=numeric(b.weight,1,1,100),concurrency=numeric(b.concurrency_limit,2,1,40),timeout=numeric(b.timeout_ms,180000,1000,600000);
   if(!name||!account||!isLocalUpstream(upstream)||!validChannelAccount(account,upstream)||![priority,weight,concurrency,timeout].every(isNumValid))return fail(res,400,'请使用已授权账号和内置通道 embedded://default 或本机 HTTP 地址');
   const models=b.models??null;if(models!==null&&(!Array.isArray(models)||models.length>100||models.some(m=>typeof m!=='string'||m.length>120)))return fail(res,400,'模型范围无效');
   const id=uuid();db.run('INSERT INTO channels(id,name,account_id,upstream,priority,weight,models_json,concurrency_limit,timeout_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',id,name,b.account_id,upstream,priority,weight,models?JSON.stringify(models):null,concurrency,timeout,now());audit(db,user.id,'channels.create',id,name);return json(res,201,{data:publicChannel(db.one('SELECT * FROM channels WHERE id=?',id))});
 }
 if(parts[1]==='channels'&&parts.length===3&&method==='PATCH'){
   if(!requireRole(res,user,['admin']))return;
   const c=db.one('SELECT * FROM channels WHERE id=?',parts[2]);if(!c)return fail(res,404,'渠道不存在');const b=await input(req);
   const name=message(b.name??c.name,90),upstream=message(b.upstream??c.upstream,200),account_id=b.account_id??c.account_id,priority=numeric(b.priority,c.priority,0,1000),weight=numeric(b.weight,c.weight,1,100),concurrency=numeric(b.concurrency_limit,c.concurrency_limit,1,40),timeout=numeric(b.timeout_ms,c.timeout_ms,1000,600000),models=b.models===undefined?safeJSON(c.models_json,null):b.models;
   if(!name||!isLocalUpstream(upstream)||!db.one('SELECT id FROM accounts WHERE id=?',account_id)||!validChannelAccount(db.one('SELECT * FROM accounts WHERE id=?',account_id),upstream)||![priority,weight,concurrency,timeout].every(isNumValid)||models!==null&&(!Array.isArray(models)||models.some(x=>typeof x!=='string')))return fail(res,400,'渠道参数不合法');
   db.run('UPDATE channels SET name=?,upstream=?,account_id=?,priority=?,weight=?,models_json=?,concurrency_limit=?,timeout_ms=?,enabled=? WHERE id=?',name,upstream,account_id,priority,weight,models?JSON.stringify(models):null,concurrency,timeout,b.enabled===undefined?c.enabled:(b.enabled?1:0),c.id);
   audit(db,user.id,'channels.update',c.id,name);return json(res,200,{data:publicChannel(db.one('SELECT * FROM channels WHERE id=?',c.id))});
 }
 if(parts[1]==='channels'&&parts.length===3&&method==='DELETE'){
   if(!requireRole(res,user,['admin']))return;const r=db.run('DELETE FROM channels WHERE id=?',parts[2]);if(!r.changes)return fail(res,404,'渠道不存在');audit(db,user.id,'channels.delete',parts[2],'移除渠道配置');return json(res,200,{ok:true});
 }
 if(route==='/channels/health'&&method==='GET'){
   if(!requireRole(res,user,['admin','operator']))return;
   return json(res,200,{data:await Promise.all(db.all('SELECT * FROM channels').map(probe))});
 }
 if(route==='/models'&&method==='GET')return json(res,200,{data:db.all('SELECT * FROM models ORDER BY id').map(m=>({...m,enabled:!!m.enabled}))});
 if(route==='/models'&&method==='POST'){
   if(!requireRole(res,user,['admin']))return;const b=await input(req),id=message(b.id,120),label=message(b.label||id,120),cost=numeric(b.cost_units,1,0,1000000);
   if(!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(id)||!label||!isNumValid(cost))return fail(res,400,'模型名称或单次额度不合法');
   db.run('INSERT INTO models(id,label,enabled,cost_units,created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,enabled=excluded.enabled,cost_units=excluded.cost_units',id,label,b.enabled===false?0:1,cost,now());audit(db,user.id,'models.upsert',id,`模型额度: ${cost}`);return json(res,200,{ok:true});
 }
 if(route==='/models/sync'&&method==='POST'){
   if(!requireRole(res,user,['admin']))return;let count=0;
   for(const c of db.all('SELECT * FROM channels WHERE enabled=1')){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),3000);try{const r=await requestUpstream(c,'/v1/models',{signal:controller.signal},'internal-models');if(!r.ok)continue;for(const m of (await r.json()).data||[]){if(typeof m.id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(m.id))continue;if(!db.one('SELECT id FROM models WHERE id=?',m.id)){db.run('INSERT INTO models(id,label,enabled,cost_units,created_at) VALUES(?,?,0,1,?)',m.id,m.id,now());count++;}}}catch{}finally{clearTimeout(timer);}}
   audit(db,user.id,'models.sync','models',`新发现 ${count} 个模型（默认禁用）`);return json(res,200,{created:count});
 }
 if(route==='/keys'&&method==='GET'){
   const keys=user.role==='user'?db.all('SELECT * FROM api_keys WHERE owner_id=? ORDER BY created_at DESC',user.id):db.all('SELECT * FROM api_keys ORDER BY created_at DESC');return json(res,200,{data:keys.map(publicKey)});
 }
 if(route==='/keys'&&method==='POST'){
   const b=await input(req),owner_id=user.role==='admin'&&b.owner_id?b.owner_id:user.id,owner=db.one('SELECT * FROM users WHERE id=?',owner_id),name=message(b.name,90),quota=numeric(b.quota_units,null,0,1e9),models=b.models??null,account_id=b.account_id||null;
   if(!owner||!owner.enabled||!name||!validKeyAccount(owner_id,account_id,user)||!isNumValid(quota)||models!==null&&(!Array.isArray(models)||models.length>100||models.some(x=>typeof x!=='string'||x.length>120)))return fail(res,400,'密钥参数不合法');
   if(b.expires_at && (Number.isNaN(Date.parse(b.expires_at))||new Date(b.expires_at).toISOString()<=now()))return fail(res,400,'过期时间不合法');
   const token='m365_'+crypto.randomBytes(32).toString('hex'),id=uuid();
   db.run('INSERT INTO api_keys(id,owner_id,name,prefix,secret_hash,quota_units,models_json,expires_at,created_at,account_id) VALUES(?,?,?,?,?,?,?,?,?,?)',id,owner_id,name,token.slice(0,15),hash(token),quota,models?JSON.stringify(models):null,b.expires_at?new Date(b.expires_at).toISOString():null,now(),account_id);audit(db,user.id,'keys.create',id,`创建 ${name}，所属用户 ${owner.email}`);return json(res,201,{data:publicKey(db.one('SELECT * FROM api_keys WHERE id=?',id)),token});
 }
 if(parts[1]==='keys'&&parts.length===3&&method==='PATCH'){
   const k=db.one('SELECT * FROM api_keys WHERE id=?',parts[2]);if(!k)return fail(res,404,'密钥不存在');if(user.role!=='admin'&&k.owner_id!==user.id)return fail(res,403,'没有管理该密钥的权限');
   const b=await input(req),name=message(b.name??k.name,90),quota=numeric(b.quota_units,k.quota_units,0,1e9),models=b.models===undefined?safeJSON(k.models_json,null):b.models,expiry=b.expires_at===undefined?k.expires_at:(b.expires_at?String(b.expires_at):null),account_id=b.account_id===undefined?k.account_id:(b.account_id||null);
   if(!name||!validKeyAccount(k.owner_id,account_id,user)||!isNumValid(quota)||models!==null&&(!Array.isArray(models)||models.some(x=>typeof x!=='string'))||expiry!==null&&Number.isNaN(Date.parse(expiry)))return fail(res,400,'密钥参数不合法');
   db.run('UPDATE api_keys SET name=?,enabled=?,quota_units=?,models_json=?,expires_at=?,account_id=? WHERE id=?',name,b.enabled===undefined?k.enabled:(b.enabled?1:0),quota,models?JSON.stringify(models):null,expiry?new Date(expiry).toISOString():null,account_id,k.id);audit(db,user.id,'keys.update',k.id,'密钥状态或限制变更');return json(res,200,{data:publicKey(db.one('SELECT * FROM api_keys WHERE id=?',k.id))});
 }
 if(parts[1]==='keys'&&parts.length===3&&method==='DELETE'){
   const k=db.one('SELECT * FROM api_keys WHERE id=?',parts[2]);if(!k)return fail(res,404,'密钥不存在');if(user.role!=='admin'&&k.owner_id!==user.id)return fail(res,403,'无权限');
   db.run('DELETE FROM api_keys WHERE id=?',k.id);audit(db,user.id,'keys.delete',k.id,'永久撤销密钥');return json(res,200,{ok:true});
 }
 if(parts[1]==='keys'&&parts[3]==='reset'&&method==='POST'){
   if(!requireRole(res,user,['admin']))return;
   const k=db.one('SELECT * FROM api_keys WHERE id=?',parts[2]);if(!k)return fail(res,404,'密钥不存在');db.run('UPDATE api_keys SET used_units=0 WHERE id=?',k.id);audit(db,user.id,'keys.reset',k.id,'密钥额度计数清零');return json(res,200,{ok:true});
 }
 if(route==='/usage'&&method==='GET'){
   const limit=clamp(Number(new URL(req.url,'http://local').searchParams.get('limit'))||200,1,1000);
   const rows=user.role==='user'?db.all('SELECT * FROM usage WHERE user_id=? ORDER BY created_at DESC LIMIT ?',user.id,limit):db.all('SELECT * FROM usage ORDER BY created_at DESC LIMIT ?',limit);
   return json(res,200,{data:rows,summary:usageSummary(rows)});
 }
 if(route==='/audit'&&method==='GET'){
   if(!requireRole(res,user,['admin','operator']))return;return json(res,200,{data:db.all('SELECT * FROM audit ORDER BY created_at DESC LIMIT 300')});
 }
 if(route==='/settings'&&method==='GET'){
   if(!requireRole(res,user,['admin','operator']))return;return json(res,200,{host:HOST,port:PORT,data_dir:DATA,node:process.version,mode:'request-unit quota (no payment)',embedded:embeddedState(),retention:'usage/audit persist in SQLite',upstream:'in-process or localhost-only',feature_flags:{billing:false,interactive_account_authorization:true,local_credential_autologin:true,remote_oauth_callback:false,token_exact:false}});
 }
 return fail(res,404,'管理接口不存在');
};

async function gateway(req,res,route){
 const auth=authKey(req);if(!auth)return fail(res,401,'无效、禁用或过期的 API Key');
 const {k,u}=auth;
 if(route==='/v1/models'&&req.method==='GET'){
   const visible=visibleModels(u,k).filter(m=>matchingChannels(m.id,k.account_id).length);
   // Preserve upstream model metadata such as context_window and input hints,
   // which OpenAI-compatible agent clients use for prompt packing.
   const allowedIds=new Set(visible.map(m=>m.id));
   const channels=db.all('SELECT * FROM channels WHERE enabled=1');
   const metadata=new Map();
   for(const c of channels){
     if(!visible.some(m=>matchingChannels(m.id,k.account_id).some(x=>x.id===c.id)))continue;
     const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),2500);
     try{
       const r=await requestUpstream(c,'/v1/models',{signal:controller.signal},'internal-models');
       if(r.ok){const parsed=await r.json();for(const item of parsed.data||[]){
         if(item&&typeof item.id==='string'&&allowedIds.has(item.id)&&!metadata.has(item.id))metadata.set(item.id,item);
       }}
     }catch{}finally{clearTimeout(timer);}
   }
   return json(res,200,{object:'list',data:visible.map(m=>metadata.has(m.id)?metadata.get(m.id):{id:m.id,object:'model',owned_by:'m365-copilot-console'})});
 }
 if(route!=='/v1/chat/completions'||req.method!=='POST')return fail(res,404,'不支持的 API 路径');
 const started=Date.now(),requestId=uuid();let buf,b;
 try{buf=await body(req);b=JSON.parse(buf.toString('utf8'));}catch(e){return fail(res,e.status||400,'JSON 格式错误或请求体过大');}
 if(!b||typeof b.model!=='string'||!Array.isArray(b.messages)||b.messages.length<1)return fail(res,400,'需要 model 和非空 messages 数组');
 const model=db.one('SELECT * FROM models WHERE id=? AND enabled=1',b.model);if(!model||!visibleModels(u,k).some(m=>m.id===model.id))return fail(res,403,'模型未启用或超出 Key 权限');
 const possible=matchingChannels(b.model,k.account_id);if(!possible.length)return fail(res,503,'没有启用且支持该模型的渠道');
 const userReserved=pendingUsers.get(u.id)||0,keyReserved=pendingKeys.get(k.id)||0;
 if((u.quota_units!==null&&u.used_units+userReserved+model.cost_units>u.quota_units)||(k.quota_units!==null&&k.used_units+keyReserved+model.cost_units>k.quota_units))return fail(res,429,'额度已用尽');
 const daily=db.one('SELECT COUNT(*) n FROM usage WHERE user_id=? AND created_at>=?',u.id,now().slice(0,10)).n;
 if(u.daily_limit!==null&&daily+(pendingUsers.get('count:'+u.id)||0)>=u.daily_limit)return fail(res,429,'今日请求次数已达限制');
 if((pendingUsers.get('concurrent:'+u.id)||0)>=u.concurrency_limit)return fail(res,429,'用户并发已达上限');
 if(!checkMinute('api:'+k.id,60))return fail(res,429,'API Key 每分钟最多 60 次请求');
 const c=chooseChannel(b.model,k.account_id);if(!c)return fail(res,429,'所有可用渠道均达到并发上限');
 reserve(pendingUsers,u.id,model.cost_units);reserve(pendingKeys,k.id,model.cost_units);reserve(pendingUsers,'count:'+u.id,1);reserve(pendingUsers,'concurrent:'+u.id,1);reserve(pendingChannels,c.id,1);
 let status=502,usage=null;let bytes=0;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),c.timeout_ms);
 req.on('aborted',()=>controller.abort());
 try{
   const r=await requestUpstream(c,'/v1/chat/completions',{method:'POST',body:buf,signal:controller.signal},k.id);
   status=r.status;
   if(b.stream){
     res.writeHead(r.status,{'Content-Type':r.headers.get('content-type')||'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'});
     const decoder=new TextDecoder();let pending='';
     if(r.body)for await(const chunk of r.body){bytes+=chunk.length;if(bytes>24*1024*1024)throw new Error('Stream too large');pending+=decoder.decode(chunk,{stream:true});const lines=pending.split('\n');pending=lines.pop()||'';for(const line of lines){if(!line.startsWith('data:'))continue;const msg=line.slice(5).trim();if(msg==='[DONE]')continue;const data=safeJSON(msg,{});if(data.usage&&data.usage.prompt_tokens>0)usage=data.usage;}
       if(!res.write(chunk))await new Promise(resolve=>res.once('drain',resolve));}
     res.end();
   }else{
     const raw=await r.text();bytes=Buffer.byteLength(raw);if(bytes>24*1024*1024)throw new Error('Response too large');const data=safeJSON(raw,{});usage=data.usage||null;
     res.writeHead(status,{'Content-Type':r.headers.get('content-type')||'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(raw);
   }
 }catch(e){status=controller.signal.aborted?504:502;if(!res.headersSent)fail(res,status,'上游请求失败或超时');else res.destroy();}
 finally{
   clearTimeout(timer);const charged=status>=200&&status<300?model.cost_units:0;
   try{logUsage({u,k,c,model:b.model,status,started,units:charged,usage,requestId});}catch(e){console.error('Usage logging error:',e.message);}
   reserve(pendingUsers,u.id,-model.cost_units);reserve(pendingKeys,k.id,-model.cost_units);reserve(pendingUsers,'count:'+u.id,-1);reserve(pendingUsers,'concurrent:'+u.id,-1);reserve(pendingChannels,c.id,-1);
 }
}
const files={'/admin/':['index.html','text/html; charset=utf-8'],'/admin':['index.html','text/html; charset=utf-8'],'/admin/app.js':['app.js','text/javascript; charset=utf-8'],'/admin/style.css':['style.css','text/css; charset=utf-8']};
export const server=http.createServer(async(req,res)=>{
 headers(res);
 const route=new URL(req.url||'/','http://local').pathname,parts=route.split('/').filter(Boolean);
 try{
   if(route==='/'){res.writeHead(302,{Location:'/admin/'});return res.end();}
   if(route==='/health'&&req.method==='GET')return json(res,200,{status:'ok',service:'m365-copilot-console',upstream:'in-process-or-local'});
   if(files[route]&&req.method==='GET'){const [filename,type]=files[route];res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});return res.end(readFileSync(path.join(ROOT,'public',filename)));}
   if(route.startsWith('/admin/api/'))return await adminRoutes(req,res,route.slice('/admin/api'.length),parts.slice(1));
   if(route.startsWith('/v1/'))return await gateway(req,res,route);
   return fail(res,404,'页面不存在');
 }catch(e){if(!res.headersSent)fail(res,e.status||500,e.status?e.message:'内部服务器错误');else res.destroy();if(!e.status)console.error('Unhandled:',e.stack);}
});
process.on('SIGTERM',()=>{shutdownWorkers();server.close();});
process.on('SIGINT',()=>{shutdownWorkers();server.close();});
async function restoreConfiguredAccountsOnce(){
  if(process.env.M365_CONSOLE_AUTOLOGIN_ON_BOOT==='0')return;
  const candidates=db.all("SELECT * FROM accounts WHERE runtime_type='isolated' AND enabled=1");
  for(const a of candidates){
    if(!hasAutoSecrets(DATA,a.id))continue;
    try{
      await beginAutomatedLogin(DATA,a);
      // Only one browser login at a time on startup. Do not retry failures.
      for(let i=0;i<360;i++){
        if(accountStatus(DATA,a).state!=='authorizing')break;
        await new Promise(resolve=>setTimeout(resolve,500));
      }
    }catch{ /* Errors are shown in account status; never retry in a loop. */ }
  }
}
if(process.env.M365_ADMIN_NO_LISTEN!=='1')server.listen(PORT,HOST,()=>{
  console.log(`M365 Copilot integrated console at http://${HOST}:${PORT}/admin/ (API /v1; embedded core loaded on first request)`);
  // Start only one queued login per account, no quota-bypass retry schedule.
  void restoreConfiguredAccountsOnce();
});
