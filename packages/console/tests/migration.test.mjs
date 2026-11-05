import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {openStore} from '../store.mjs';
import {DatabaseSync} from 'node:sqlite';

test('Legacy add-on state imports only hashed keys, local upstream and enabled models',()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'m365-legacy-'));
 const rawKey='m365_'+crypto.randomBytes(32).toString('hex');
 const digest=crypto.createHash('sha256').update(rawKey).digest('hex');
 try{
  writeFileSync(path.join(dir,'state.json'),JSON.stringify({upstream:'http://127.0.0.1:4111',enabledModels:['legacy-model'],keys:[{id:crypto.randomUUID(),name:'existing',prefix:'m365_',digest}],logs:[{model:'legacy-model',prompt:'do not import'}]}));
  const x=openStore(dir,'FirstTimeStrongPassword!');
  assert.equal(x.one('SELECT upstream FROM channels').upstream,'http://127.0.0.1:4111');
  assert.equal(x.one('SELECT secret_hash FROM api_keys').secret_hash,digest);
  assert.equal(x.one('SELECT COUNT(*) n FROM usage').n,0);
  assert.equal(x.one('SELECT enabled FROM models WHERE id=?','legacy-model').enabled,1);
  x.db.close();
 } finally{rmSync(dir,{recursive:true,force:true});}
});

test('v1.1 SQLite keys migrate to a legacy account and retain owner permissions',()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'m365-v11-upgrade-'));
 try{
  const old=new DatabaseSync(path.join(dir,'console.db'));
  old.exec(`
   CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role TEXT NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,quota_units INTEGER,used_units INTEGER NOT NULL DEFAULT 0,daily_limit INTEGER,concurrency_limit INTEGER NOT NULL DEFAULT 2,created_at TEXT,last_login TEXT);
   CREATE TABLE accounts(id TEXT PRIMARY KEY,label TEXT NOT NULL,email_hint TEXT NOT NULL DEFAULT '',tenant_hint TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',enabled INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
   CREATE TABLE channels(id TEXT PRIMARY KEY,name TEXT NOT NULL,account_id TEXT NOT NULL REFERENCES accounts(id),upstream TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,priority INTEGER NOT NULL DEFAULT 10,weight INTEGER NOT NULL DEFAULT 1,models_json TEXT,concurrency_limit INTEGER NOT NULL DEFAULT 2,timeout_ms INTEGER NOT NULL DEFAULT 180000,created_at TEXT NOT NULL);
   CREATE TABLE api_keys(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,prefix TEXT NOT NULL,secret_hash TEXT NOT NULL UNIQUE,enabled INTEGER NOT NULL DEFAULT 1,quota_units INTEGER,used_units INTEGER NOT NULL DEFAULT 0,models_json TEXT,expires_at TEXT,created_at TEXT NOT NULL,last_used TEXT);
  `);
  old.prepare('INSERT INTO users(id,email,name,role,salt,password_hash,created_at) VALUES(?,?,?,?,?,?,?)').run('oldadmin','admin@local','Admin','admin','a','b','2026-01-01');
  old.prepare('INSERT INTO users(id,email,name,role,salt,password_hash,created_at) VALUES(?,?,?,?,?,?,?)').run('olduser','student@test.edu','Student','user','a','b','2026-01-01');
  old.prepare('INSERT INTO accounts(id,label,created_at) VALUES(?,?,?)').run('legacy-account','Existing','2026-01-01');
  old.prepare('INSERT INTO channels(id,name,account_id,upstream,created_at) VALUES(?,?,?,?,?)').run('legacy-channel','Original','legacy-account','embedded://default','2026-01-01');
  old.prepare('INSERT INTO api_keys(id,owner_id,name,prefix,secret_hash,created_at) VALUES(?,?,?,?,?,?)').run('oldkey','olduser','Old key','m365_','0'.repeat(64),'2026-01-01');
  old.close();
  const db=openStore(dir,'NotUsedButStrongPass12345!');
  assert.equal(db.one('SELECT runtime_type FROM accounts WHERE id=?','legacy-account').runtime_type,'legacy');
  assert.equal(db.one('SELECT account_id FROM api_keys WHERE id=?','oldkey').account_id,'legacy-account');
  assert.equal(db.one('SELECT COUNT(*) n FROM user_accounts WHERE user_id=? AND account_id=?','olduser','legacy-account').n,1);
  db.db.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
