import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const now = () => new Date().toISOString();
export const uuid = () => crypto.randomUUID();
export const hash = s => crypto.createHash('sha256').update(String(s)).digest('hex');
export const scrypt = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex');
export const safeJSON = (value, fallback=null) => { try { return JSON.parse(value); } catch { return fallback; } };
export function openStore(dir, bootstrapPassword) {
  mkdirSync(dir, { recursive:true, mode:0o700 });
  try { chmodSync(dir,0o700); } catch {}
  const db = new DatabaseSync(path.join(dir,'console.db'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','operator','user')),
      salt TEXT NOT NULL, password_hash TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      quota_units INTEGER, used_units INTEGER NOT NULL DEFAULT 0,
      daily_limit INTEGER, concurrency_limit INTEGER NOT NULL DEFAULT 2,
      created_at TEXT NOT NULL, last_login TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, email_hint TEXT NOT NULL DEFAULT '',
      tenant_hint TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1, runtime_type TEXT NOT NULL DEFAULT 'legacy', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_accounts (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      PRIMARY KEY(user_id,account_id)
    );
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id),
      upstream TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 10, weight INTEGER NOT NULL DEFAULT 1,
      models_json TEXT, concurrency_limit INTEGER NOT NULL DEFAULT 2,
      timeout_ms INTEGER NOT NULL DEFAULT 180000,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      cost_units INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
      prefix TEXT NOT NULL, secret_hash TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1, quota_units INTEGER,
      used_units INTEGER NOT NULL DEFAULT 0, models_json TEXT,
      expires_at TEXT, created_at TEXT NOT NULL, last_used TEXT,
      account_id TEXT REFERENCES accounts(id)
    );
    CREATE TABLE IF NOT EXISTS usage (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, user_id TEXT NOT NULL,
      key_id TEXT NOT NULL, channel_id TEXT, model TEXT NOT NULL,
      status INTEGER NOT NULL, latency_ms INTEGER NOT NULL, units INTEGER NOT NULL,
      input_tokens INTEGER, output_tokens INTEGER, usage_source TEXT NOT NULL,
      request_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS usage_by_user_time ON usage(user_id, created_at);
    CREATE INDEX IF NOT EXISTS usage_by_date ON usage(created_at);
    CREATE TABLE IF NOT EXISTS audit (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, actor_id TEXT,
      action TEXT NOT NULL, target TEXT NOT NULL, summary TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_by_time ON audit(created_at);
  `);
  // Migrate pre-v1.2 SQLite databases without discarding user keys or historical usage.
  const columns=table=>new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(x=>x.name));
  if(!columns('accounts').has('runtime_type'))db.exec("ALTER TABLE accounts ADD COLUMN runtime_type TEXT NOT NULL DEFAULT 'legacy'");
  if(!columns('api_keys').has('account_id'))db.exec("ALTER TABLE api_keys ADD COLUMN account_id TEXT REFERENCES accounts(id)");
  const one=(sql,...args)=>db.prepare(sql).get(...args);
  const all=(sql,...args)=>db.prepare(sql).all(...args);
  const run=(sql,...args)=>db.prepare(sql).run(...args);
  if(!one('SELECT id FROM users WHERE role=? LIMIT 1','admin')) {
    if(!bootstrapPassword || bootstrapPassword.length < 12) throw new Error('First run: set M365_ADMIN_PASSWORD (at least 12 characters)');
    const salt=crypto.randomBytes(16).toString('hex');
    run('INSERT INTO users(id,email,name,role,salt,password_hash,created_at) VALUES(?,?,?,?,?,?,?)',uuid(),'admin@local','系统管理员','admin',salt,scrypt(bootstrapPassword,salt),now());
  }
  const original=path.join(dir,'state.json');
  if(existsSync(original) && !one('SELECT id FROM audit WHERE action=?','legacy.import')){
    const old=safeJSON(readFileSync(original,'utf8'),{});
    const admin=one('SELECT * FROM users WHERE role=? LIMIT 1','admin');
    const aId=uuid(), cId=uuid();
    const oldUpstream = old.upstream || 'http://127.0.0.1:4141';
    if (/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/?$/.test(oldUpstream)) {
      run('INSERT INTO accounts(id,label,created_at) VALUES(?,?,?)',aId,'原版单账号',now());
      run('INSERT INTO channels(id,name,account_id,upstream,created_at) VALUES(?,?,?,?,?)',cId,'原版代理',aId,oldUpstream,now());
    }
    for(const k of (old.keys||[])) if (typeof k.digest==='string' && /^[a-f\d]{64}$/i.test(k.digest)){
      run('INSERT OR IGNORE INTO api_keys(id,owner_id,name,prefix,secret_hash,models_json,created_at) VALUES(?,?,?,?,?,?,?)',k.id||uuid(),admin.id,k.name||'导入密钥',k.prefix||'legacy',k.digest,k.models ? JSON.stringify(k.models):null,k.createdAt||now());
    }
    for(const m of old.enabledModels||[]) if(typeof m==='string') run('INSERT OR IGNORE INTO models(id,label,created_at) VALUES(?,?,?)',m,m,now());
    run('INSERT INTO audit(id,created_at,actor_id,action,target,summary) VALUES(?,?,?,?,?,?)',uuid(),now(),admin.id,'legacy.import','state.json','Imported legacy keys and upstream; original file was not deleted.');
  }
  if (!one('SELECT id FROM accounts LIMIT 1')){
    const account=uuid();
    run('INSERT INTO accounts(id,label,notes,created_at) VALUES(?,?,?,?)',account,'默认授权账号','仅保存显示名称，不保存 Microsoft 密码或 Token',now());
    run('INSERT INTO channels(id,name,account_id,upstream,created_at) VALUES(?,?,?,?,?)',uuid(),'内置 Copilot 核心',account,'embedded://default',now());
  }
  // One-time legacy migration: attach existing unbound API keys to the original
  // default legacy account. Preserve only the access existing key owners already had.
  const legacy=one("SELECT a.id FROM accounts a JOIN channels c ON c.account_id=a.id WHERE a.runtime_type='legacy' AND c.upstream='embedded://default' LIMIT 1")
    ||one("SELECT id FROM accounts WHERE runtime_type='legacy' LIMIT 1");
  if(legacy){
    const keys=all('SELECT id,owner_id FROM api_keys WHERE account_id IS NULL');
    for(const k of keys){
      run('UPDATE api_keys SET account_id=? WHERE id=?',legacy.id,k.id);
      run('INSERT OR IGNORE INTO user_accounts(user_id,account_id) VALUES(?,?)',k.owner_id,legacy.id);
    }
    const admin=one("SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 1");
    if(admin)run('INSERT OR IGNORE INTO user_accounts(user_id,account_id) VALUES(?,?)',admin.id,legacy.id);
  }
  if(!one('SELECT id FROM models LIMIT 1')){
    for(const model of ['m365-copilot','gpt-5.5-think-deeper','gpt-5.6','gpt-5.6-think-deeper','gpt-6-sol','gpt-6.1-sol'])
      run('INSERT INTO models(id,label,created_at) VALUES(?,?,?)',model,model,now());
  }
  return {db,one,all,run};
}
export function audit(store,actor,action,target,summary){store.run('INSERT INTO audit(id,created_at,actor_id,action,target,summary) VALUES(?,?,?,?,?,?)',uuid(),now(),actor||null,action,target,String(summary).slice(0,200));}
export const publicUser = u=>u && ({id:u.id,email:u.email,name:u.name,role:u.role,enabled:!!u.enabled,quota_units:u.quota_units,used_units:u.used_units,daily_limit:u.daily_limit,concurrency_limit:u.concurrency_limit,created_at:u.created_at,last_login:u.last_login});
export const publicKey = k=>k && ({id:k.id,owner_id:k.owner_id,name:k.name,prefix:k.prefix,enabled:!!k.enabled,quota_units:k.quota_units,used_units:k.used_units,models:safeJSON(k.models_json,null),expires_at:k.expires_at,account_id:k.account_id||null,created_at:k.created_at,last_used:k.last_used});
export const publicChannel=c=>c && ({id:c.id,name:c.name,account_id:c.account_id,upstream:c.upstream,enabled:!!c.enabled,priority:c.priority,weight:c.weight,models:safeJSON(c.models_json,null),concurrency_limit:c.concurrency_limit,timeout_ms:c.timeout_ms,created_at:c.created_at});
export const publicAccount=a=>a&&({...a,runtime_type:a.runtime_type||'legacy',enabled:!!a.enabled});
