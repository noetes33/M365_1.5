#!/usr/bin/env node
/** Local-only provisioning for the upstream auth.ts password + TOTP flow.
 * Secrets deliberately NEVER transit an admin HTTP endpoint or SQLite database.
 * Usage: pipe JSON {password,mfaSecret} to `set <account UUID>` on the server.
 */
import {DatabaseSync} from 'node:sqlite';
import {existsSync, mkdirSync, chmodSync, openSync, writeFileSync, closeSync, renameSync, rmSync, readFileSync, lstatSync} from 'node:fs';
import crypto from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';
import process from 'node:process';

const [action,id]=process.argv.slice(2);
const root=process.env.M365_ADMIN_DATA||join(homedir(),'.config','m365-copilot-console');
const fail=msg=>{console.error('错误：'+msg);process.exitCode=1;};
if(!['set','remove','status'].includes(action)||!/^[a-f0-9-]{36}$/i.test(id||'')){
  fail('使用：node packages/console/scripts/account-credentials.mjs set|status|remove <账号 UUID>');
}else{
  let db;
  try{
    const dbpath=join(root,'console.db');
    if(!existsSync(dbpath))throw Error('请先启动管理后台并创建独立微软账号');
    db=new DatabaseSync(dbpath,{readOnly:true});
    const a=db.prepare('SELECT id,email_hint,runtime_type FROM accounts WHERE id=?').get(id);
    if(!a||a.runtime_type!=='isolated')throw Error('必须先在管理后台创建独立授权账号');
    const dir=join(root,'identity-profiles',a.id),destination=join(dir,'secrets.json');
    if(action==='status'){
      // Never reveal password or TOTP seed, even to local administrator output.
      console.log(existsSync(destination)?'账号凭证文件已配置（不显示内容）':'账号未配置自动登录凭证');
    }else if(action==='remove'){
      rmSync(destination,{force:true});console.log('已关闭此账号的后续密码/TOTP 自动登录；已有 MSAL 缓存未被撤销。');
    }else{
      if(process.stdin.isTTY)throw Error('请通过标准输入传入 JSON，不要把密码和 TOTP 写在命令行参数中');
      let raw='',size=0;
      for await(const chunk of process.stdin){size+=chunk.length;if(size>8192)throw Error('输入过长');raw+=chunk.toString('utf8');}
      let b;try{b=JSON.parse(raw);}catch{throw Error('输入应是包含 password、mfaSecret 的 JSON');}
      if(!b||typeof b.password!=='string'||b.password.length<1||b.password.length>512)throw Error('password 无效');
      if(typeof b.mfaSecret!=='string')throw Error('mfaSecret 无效');
      const seed=b.mfaSecret.replace(/[\s-]/g,'').toUpperCase();
      if(!/^[A-Z2-7]{16,128}$/.test(seed))throw Error('TOTP 必须是 Base32 种子，而不是 6 位动态验证码');
      mkdirSync(dir,{recursive:true,mode:0o700});try{chmodSync(dir,0o700);}catch{}
      // Reject symbolic links to avoid writing credentials outside the isolated profile.
      if(existsSync(destination)&&lstatSync(destination).isSymbolicLink())throw Error('拒绝写入符号链接');
      const tmp=join(dir,'.secrets-'+crypto.randomBytes(12).toString('hex')+'.tmp');
      const fd=openSync(tmp,'wx',0o600);
      try{writeFileSync(fd,JSON.stringify({email:a.email_hint,password:b.password,mfaSecret:seed})+'\n','utf8');}finally{closeSync(fd);}
      try{chmodSync(tmp,0o600);}catch{}
      try{renameSync(tmp,destination);}catch(e){rmSync(tmp,{force:true});throw e;}
      try{chmodSync(destination,0o600);}catch{}
      console.log('自动登录凭证已保存到独立账号目录；明文不显示在终端或管理网页。请刷新管理后台并点击「自动登录」。');
    }
  }catch(e){fail(e.message||'配置失败');}
  finally{db?.close();}
}
