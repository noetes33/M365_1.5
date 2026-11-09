const $=q=>document.querySelector(q);
const esc=x=>String(x??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const short=x=>String(x??'').slice(0,9);
const when=x=>x?new Date(x).toLocaleString('zh-CN',{hour12:false}):'—';
const int=x=>Number(x||0).toLocaleString('zh-CN');
let csrf='',who=null,tab='overview',data={},toastTimeout=null,modalSubmit=null;
const admin=()=>who?.role==='admin',manager=()=>['admin','operator'].includes(who?.role);
function notice(text){const el=$('#toast');el.textContent=text;el.classList.remove('hidden');clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>el.classList.add('hidden'),3600);}
async function api(endpoint,method='GET',payload){const res=await fetch('/admin/api'+endpoint,{method,credentials:'same-origin',headers:{...(payload!==undefined?{'Content-Type':'application/json'}:{}),...(['GET','HEAD'].includes(method)?{}:{'X-CSRF-Token':csrf})},body:payload===undefined?undefined:JSON.stringify(payload)});const out=await res.json().catch(()=>({}));if(!res.ok){if(res.status===401&&endpoint!=='/auth/login')logoutView();throw Error(out.error?.message||`HTTP ${res.status}`);}return out;}
function logoutView(){$('#dashboard-app').classList.add('hidden');$('#auth-screen').classList.remove('hidden');csrf='';who=null;}
function welcome(){ $('#auth-screen').classList.add('hidden');$('#dashboard-app').classList.remove('hidden');$('#user-name').textContent=who.name;$('#user-avatar').textContent=(who.name||'A')[0];document.querySelectorAll('.manage-only').forEach(el=>el.classList.toggle('hidden',!manager())); document.querySelector('.side-updater')?.classList.toggle('hidden',!admin());void refreshUpdateInfo(); }
let updatePolling=null;
let initiallyLoadedCommit=null;
const busyPhases=new Set(['checking','backing-up','pulling','building','restarting','verifying']);
async function refreshUpdateInfo(){
 if(!admin())return;
 try{
   const st=await api('/system/update');
   if(st.commit&&initiallyLoadedCommit&&st.commit!==initiallyLoadedCommit&&st.phase==='done'){location.reload();return;}
   if(st.commit&&!initiallyLoadedCommit)initiallyLoadedCommit=st.commit;
   const version=$('#update-version');
   if(version)version.textContent='v'+st.version+(st.commit?' · '+st.commit.slice(0,7):'');
   const footer=$('#footer-version');if(footer)footer.textContent='v'+st.version;
   const label=$('#update-status');
   let summary=st.message||'尚未检查更新';
   if(!st.enabled)summary='请先安装一次主机更新服务';
   else if(st.pending)summary='更新任务已排队';
   else if(st.phase==='done'&&st.updateAvailable)summary='检测到新提交：'+(st.remoteCommit||'');
   else if(st.phase==='done'&&!st.updateAvailable)summary='已是最新版本';
   if(label){label.textContent=summary;label.title=summary;}
   const check=$('#check-update'),apply=$('#apply-update');
   const busy=st.pending||busyPhases.has(st.phase);
   if(check)check.disabled=!st.enabled||busy;
   if(apply)apply.disabled=!st.enabled||busy;
   if(!busy&&updatePolling){clearInterval(updatePolling);updatePolling=null;}
   if(busy&&!updatePolling)updatePolling=setInterval(refreshUpdateInfo,2500);
 }catch(e){
   const label=$('#update-status');if(label)label.textContent='更新期间连接暂不可用，正在重新连接…';
   if(!updatePolling)updatePolling=setInterval(refreshUpdateInfo,2500);
 }
}
async function triggerUpdate(action){
 if(!admin())return;
 if(action==='apply'&&!confirm('确定更新 M365 Console 吗？将自动备份、拉取 GitHub main、构建并重启 M365 服务；网页可能短暂断开。'))return;
 try{
   await api('/system/update/'+action,'POST',{});
   const label=$('#update-status');if(label)label.textContent=action==='check'?'正在检查 GitHub 更新…':'更新任务已提交，正在处理…';
   if(!updatePolling)updatePolling=setInterval(refreshUpdateInfo,2500);
   await refreshUpdateInfo();
 }catch(e){notice('更新操作失败：'+e.message);}
}

function head(title,description,actions=''){return `<div class="page-head"><div><div class="eyebrow">M365 COPILOT / MANAGEMENT</div><h1>${title}</h1><p>${description}</p></div><div class="head-actions">${actions}</div></div>`;}
function btn(name,action,id='',cls='btn-secondary'){return `<button type="button" class="btn ${cls}" data-action="${action}" data-id="${esc(id)}">${name}</button>`;}
function tiny(name,action,id='',danger=false){return `<button type="button" class="tiny-btn ${danger?'danger':''}" data-action="${action}" data-id="${esc(id)}">${name}</button>`;}
function section(title,body,small=''){return `<section class="section-card"><div class="section-card-head"><h3>${title}</h3><small>${small}</small></div>${body}</section>`;}
function table(headers,rows){if(!rows.length)return '<div class="empty"><span class="empty-symbol">◎</span>暂无记录</div>';return `<div class="table-scroll"><table class="data-table"><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;}
const cell=(main,sub='')=>`<span class="primary-cell">${esc(main)}</span>${sub?`<span class="sub-cell">${esc(sub)}</span>`:''}`;
function badge(on,yes='已启用',no='已停用'){return `<span class="status-pill ${on?'':'off'}">${on?'●':'○'} ${on?yes:no}</span>`;}
function nquota(n){return n===null||n===undefined?'无限制':int(n);}
function field(name,label,value='',type='text',extra=''){return `<label class="field">${label}<input name="${name}" type="${type}" value="${esc(value??'')}" ${extra}></label>`;}
function textarea(name,label,value=''){return `<label class="field">${label}<textarea name="${name}">${esc(value)}</textarea></label>`;}
function select(name,label,options,selected){return `<label class="field">${label}<select name="${name}">${options.map(o=>`<option value="${esc(o.value)}" ${o.value===selected?'selected':''}>${esc(o.label)}</option>`).join('')}</select></label>`;}
function boxcheck(name,label,checked=true){return `<label class="checkline"><input name="${name}" type="checkbox" ${checked?'checked':''}> ${label}</label>`;}
function formFields(f,submitLabel='保存更改'){return `<form id="dialog-form" autocomplete="off">${f}<div class="modal-actions"><button class="btn btn-secondary" type="button" id="cancel-modal">取消</button><button class="btn btn-primary" type="submit">${esc(submitLabel)}</button></div></form>`;}
function popup(title,content,submit=null){$('#modal-title').textContent=title;$('#modal-body').innerHTML=content;modalSubmit=submit;$('#modal').classList.remove('hidden');$('#cancel-modal')?.addEventListener('click',hideModal);$('#dialog-form')?.addEventListener('submit',async e=>{e.preventDefault();if(!modalSubmit)return;const form=e.currentTarget;const p=Object.fromEntries(new FormData(form));for(const check of form.querySelectorAll('input[type=checkbox]'))p[check.name]=check.checked;form.querySelector('button[type=submit]').disabled=true;try{const result=await modalSubmit(p);if(result?.keepOpen){form.querySelector('button[type=submit]').disabled=false;return;}hideModal();await showTab(tab);if(result?.token){popup('密钥创建成功',`<div class="help-box warning-box">请立即复制并安全保存，关闭后无法再次查看明文密钥。</div><div class="token-display" id="new-token">${esc(result.token)}</div><div class="modal-actions"><button class="btn btn-primary" data-action="copy-token">复制密钥</button><button class="btn btn-secondary" id="cancel-modal">关闭</button></div>`);$('#cancel-modal').onclick=hideModal;}notice('已保存');}catch(err){notice('失败：'+err.message);form.querySelector('button[type=submit]').disabled=false;}});}
function hideModal(){for(const input of document.querySelectorAll('#modal-body input[type=password]'))input.value='';$('#modal-body').replaceChildren();$('#modal').classList.add('hidden');modalSubmit=null;}
async function showTab(name){if(!manager()&&['accounts','channels','users','audit','settings'].includes(name))name='overview';tab=name;document.querySelectorAll('.nav-item').forEach(el=>el.classList.toggle('active',el.dataset.tab===tab));$('#crumb').textContent=({overview:'仪表盘',accounts:'微软账号',channels:'渠道管理',models:'模型与额度',users:'用户管理',keys:'API 密钥',usage:'用量记录',audit:'审计日志',settings:'系统设置'})[tab];$('.sidebar').classList.remove('show');$('#page').innerHTML='<div class="empty">数据加载中…</div>';
 try{
   if(tab==='overview'){data.overview=await api('/dashboard');renderOverview();}
   else if(tab==='accounts'){data.accounts=(await api('/accounts')).data;data.channels=(await api('/channels')).data;data.models=(await api('/models')).data;renderAccounts();}
   else if(tab==='channels'){[data.accounts,data.channels,data.models]=await Promise.all([api('/accounts').then(x=>x.data),api('/channels').then(x=>x.data),api('/models').then(x=>x.data)]);renderChannels();}
   else if(tab==='models'){data.models=(await api('/models')).data;renderModels();}
   else if(tab==='users'){data.users=(await api('/users')).data;renderUsers();}
   else if(tab==='keys'){[data.keys,data.users,data.models,data.availableAccounts]=await Promise.all([api('/keys').then(x=>x.data),manager()?api('/users').then(x=>x.data):Promise.resolve([who]),api('/models').then(x=>x.data),api('/available-accounts').then(x=>x.data)]);renderKeys();}
   else if(tab==='usage'){data.usage=(await api('/usage?limit=500')).data;renderUsage();}
   else if(tab==='audit'){data.audit=(await api('/audit')).data;renderAudit();}
   else if(tab==='settings'){data.settings=await api('/settings');renderSettings();}
 }catch(err){$('#page').innerHTML=head('加载失败','请检查服务是否可用。')+`<div class="help-box warning-box">${esc(err.message)}</div>`;}}
function renderOverview(){const {stats,today,count,trend,recent,me,modelStats=[],userTop=[]}=data.overview;
 const tiles=[['请求总量',int(stats.total),'▥','已记录请求'],['今日请求',int(today),'◷','UTC 自然日'],['成功率',`${stats.successRate}%`,'◈','基于 HTTP 2xx'],['消耗积分',int(stats.units),'◇','按成功请求计费']];
 const statsHTML=`<div class="grid-stats">${tiles.map(([label,val,icon,hint],i)=>`<div class="stat"><div class="stat-top"><span class="stat-label">${label}</span><span class="stat-icon ${['','blue','amber','purple'][i]}">${icon}</span></div><div class="stat-value">${val}</div><div class="stat-foot">${hint}</div></div>`).join('')}</div>`;
 const days=Object.entries(trend);const max=Math.max(1,...days.map(x=>x[1]));const chart=`<div class="bar-chart">${days.map(([day,count],i)=>`<div class="bar-column"><div class="bar ${i===days.length-1?'final':''}" style="height:${Math.max(3,count/max*94)}%"><span class="bar-count">${count}</span></div><span class="bar-day">${day.slice(5)}</span></div>`).join('')}</div>`;
 const recentRows=recent.slice(0,6).map(r=>`<tr><td>${when(r.created_at)}</td><td class="mono">${esc(r.model)}</td><td>${badge(r.status>=200&&r.status<300,r.status,'HTTP '+r.status)}</td><td>${r.latency_ms} ms</td></tr>`);
 const capabilities=manager()?`<div class="health-line"><span>微软账号档案</span><strong>${count.accounts}</strong></div><div class="health-line"><span>上游渠道</span><strong>${count.channels}</strong></div><div class="health-line"><span>平台用户</span><strong>${count.users}</strong></div>`:'';
 $('#page').innerHTML=head('仪表盘',`欢迎回来，${esc(me.name)}。查看平台用量和各项资源状态。`,btn('↻ 刷新数据','refresh'))+statsHTML+`<div class="two-columns"><div class="panel-card"><div class="card-head"><h3>请求趋势</h3><span class="summary-label">最近 7 天</span></div><p class="card-subtitle">按实际请求条数统计，不代表 Token 消耗</p>${chart}</div><div class="panel-card"><div class="card-head"><h3>平台概况</h3><span class="status-pill">● 正常运行</span></div><p class="card-subtitle">多用户访问控制与额度核算</p>${capabilities}<div class="health-line"><span>有效密钥记录</span><strong>${count.keys}</strong></div><div class="health-line"><span>平均响应耗时</span><strong>${stats.avgLatency} ms</strong></div><div class="health-line"><span>我的额度</span><strong>${nquota(me.quota_units)} / 已用 ${int(me.used_units)}</strong></div></div></div>`+section('最近请求',table(['时间','模型','结果','耗时'],recentRows),'最近 6 条')+`<div class="two-columns"><div class="panel-card"><h3>模型使用分布</h3><p class="card-subtitle">按请求次数排名</p>${modelStats.length?modelStats.map(m=>`<div class="health-line"><span class="mono">${esc(m.model)}</span><strong>${int(m.requests)} 次 · ${int(m.units)} 积分</strong></div>`).join(''):'<p class="empty">暂无用量</p>'}</div><div class="panel-card"><h3>用户请求排行</h3><p class="card-subtitle">管理端可见全部用户的请求汇总</p>${userTop.length?userTop.map(u=>`<div class="health-line"><span>${esc(u.name)}</span><strong>${int(u.requests)} 次 · ${int(u.units)} 积分</strong></div>`).join(''):'<p class="empty">暂无统计</p>'}</div></div>`;
}
function renderAccounts(){const counts={};for(const c of data.channels)counts[c.account_id]=(counts[c.account_id]||0)+1;
 const statusText={legacy:'旧版共享核心', 'not-linked':'未授权',cached:'已缓存（未验证）',authorized:'授权成功',authorizing:'授权进行中', 'identity-mismatch':'登录邮箱不匹配','tenant-mismatch':'租户不匹配','verification-required':'外部缓存待验证','manual-ready-to-test':'AT/RT 已保存·待对话测试',ambiguous:'缓存包含多种身份',error:'认证失败'};
 const tokenHint=a=>a.auth?.token?('AT 类型：'+a.auth.token.format.toUpperCase()+'；到期信息：'+(a.auth.token.expiresAt?new Date(a.auth.token.expiresAt*1000).toLocaleString():'未知（加密令牌）')):'';
 const rows=data.accounts.map(a=>{const state=a.auth?.state||'not-linked',valid=['cached','authorized'].includes(state),isolated=a.runtime_type==='isolated';
   const controls=admin()?(isolated?tiny('配置自动登录','configure-auto',a.id)+(a.auth?.autoLoginConfigured?tiny('自动登录','auto-login-account',a.id)+tiny('清除凭证','remove-auto',a.id,true):'')+tiny('填写 AT / RT','import-at-rt',a.id)+tiny('测试对话','test-chat',a.id)+(a.auth?.state==='verification-required'?tiny('重试缓存验证','verify-msal-cache',a.id):'')+tiny('本机授权（仅桌面）','authorize-account',a.id)+tiny('刷新状态','refresh-account',a.id)+tiny('解除关联','unlink-account',a.id,true):'')+tiny('编辑','edit-account',a.id)+tiny('删除','delete-account',a.id,true):'—';
   return `<tr><td>${cell(a.label,a.email_hint||'未绑定账号')}${isolated?`<span class="sub-cell">自动登录：${a.auth?.autoLoginConfigured?'已配置':'未配置'}</span>`:''}</td><td class="mono">${esc(a.tenant_hint||'—')}</td><td>${counts[a.id]||0} 个</td><td>${badge(a.enabled)}</td><td><span class="status-pill ${valid?'':'off'}" title="${esc([a.auth?.error,tokenHint(a)].filter(Boolean).join('；'))}">${esc(statusText[state]||state)}</span></td><td><div class="action-cell">${controls}</div></td></tr>`;});
 $('#page').innerHTML=head('微软账号管理','每个独立账号采用专属凭证缓存和工作进程。验证登录邮箱后才能供已授权用户使用。',admin()?btn('＋ 添加微软账号','add-account','','btn-primary'):'')+`<div class="help-box"><strong>如何使用：</strong>点击「添加微软账号」填写信息，再点「配置自动登录」在 HTTPS 管理网页中提交密码和软件 TOTP Base32 种子，最后点「自动登录」。凭证由服务端加密保存，不写入 SQLite、不会再次显示。请只添加你拥有或获得明确授权的账号。微软仍可能要求推送 MFA、FIDO2 或组织验证；遇到这种情况自动登录不能取代官方验证。</div>`+section('账号列表',table(['账号','租户别名','渠道','启用','认证状态','操作'],rows),`${data.accounts.length} 个账号`);
}
function renderChannels(){const accounts=Object.fromEntries(data.accounts.map(x=>[x.id,x.label]));const rows=data.channels.map(c=>`<tr><td>${cell(c.name,accounts[c.account_id]||'未绑定')}</td><td class="mono">${esc(c.upstream)}</td><td>${badge(c.enabled)}</td><td>${c.priority} / ${c.weight}</td><td>${c.concurrency_limit}</td><td><span id="health-${esc(c.id)}" class="status-pill pending">未检测</span></td><td><div class="action-cell">${tiny('检查','probe-channel',c.id)}${admin()?tiny('编辑','edit-channel',c.id)+tiny('删除','delete-channel',c.id,true):''}</div></td></tr>`);
 $('#page').innerHTML=head('渠道管理','内置核心直接调用，其他已授权账号也可通过独立的本地代理通道接入。',`${btn('↻ 检查连通性','probe-all')}${admin()?btn('＋ 新建渠道','add-channel','','btn-primary'):''}`)+`<div class="help-box warning-box"><strong>安全限制：</strong>默认使用 embedded://default 内置核心；额外通道只允许本地代理。账号仍需按微软要求正常完成授权。</div>`+section('上游渠道',table(['渠道','本地地址','状态','优先级 / 权重','并发','健康','操作'],rows),`${data.channels.length} 条渠道`);
}
function renderModels(){const rows=data.models.map(m=>`<tr><td>${cell(m.label,m.id)}</td><td>${badge(m.enabled)}</td><td><span class="mono-tag">${m.cost_units} 积分 / 成功请求</span></td><td><div class="action-cell">${admin()?tiny('配置','edit-model',m.id):'—'}</div></td></tr>`);
 $('#page').innerHTML=head('模型与额度','启停可见模型并设置每次成功请求扣除的积分，不将积分冒充微软官方 Token 或货币账单。',admin()?`${btn('同步上游模型','sync-models')}${btn('＋ 新增模型','add-model','','btn-primary')}`:'')+`<div class="help-box"><strong>关于额度：</strong>原代理一般返回 0 或不提供 Token 用量，所以当前按请求积分结算。同步发现的新模型默认禁用，须管理员审核后开启。</div>`+section('模型配置',table(['模型名称','可用状态','计费规则','操作'],rows),`${data.models.length} 个模型`);
}
function renderUsers(){const rows=data.users.map(u=>`<tr><td>${cell(u.name,u.email)}</td><td>${esc({admin:'管理员',operator:'运营人员',user:'普通用户'}[u.role])}</td><td>${badge(u.enabled)}</td><td><div class="metric-usage">${int(u.used_units)} / ${nquota(u.quota_units)}</div>${u.quota_units!==null?`<div class="progress-track"><div class="progress-fill" style="width:${Math.min(100,u.used_units/Math.max(1,u.quota_units)*100)}%"></div></div>`:''}</td><td>${nquota(u.daily_limit)}</td><td>${u.concurrency_limit}</td><td><div class="action-cell">${admin()?tiny('编辑','edit-user',u.id)+tiny('清零','reset-user',u.id)+tiny('改密','reset-user-password',u.id)+tiny('授权账号','grant-user-accounts',u.id):'—'}</div></td></tr>`);
 $('#page').innerHTML=head('用户管理','独立账号、角色与额度。普通用户只能管理自己的 API Key 和查看自己的用量。',admin()?btn('＋ 创建用户','add-user','','btn-primary'):'')+section('用户列表',table(['用户','角色','状态','积分用量','每日限次','并发','操作'],rows),`${data.users.length} 位用户`);
}
function renderKeys(){const owner=Object.fromEntries(data.users.map(x=>[x.id,x.name]));const acc=Object.fromEntries((data.availableAccounts||[]).map(a=>[a.id,a.label]));const rows=data.keys.map(k=>`<tr><td>${cell(k.name,k.prefix+'…')}</td><td>${esc(owner[k.owner_id]||'—')}</td><td>${badge(k.enabled)}</td><td><div class="metric-usage">${int(k.used_units)} / ${nquota(k.quota_units)}</div></td><td>${esc(k.account_id?(acc[k.account_id]||'无权限访问'):'旧版核心')}</td><td>${k.models?`${k.models.length} 个指定模型`:'全部模型'}</td><td>${when(k.last_used)}</td><td><div class="action-cell">${tiny('编辑','edit-key',k.id)}${admin()?tiny('清零','reset-key',k.id):''}${tiny('撤销','delete-key',k.id,true)}</div></td></tr>`);
 $('#page').innerHTML=head('API 密钥','管理客户端访问密钥、模型权限和独立额度，明文密钥仅在创建时显示一次。',btn('＋ 生成 API Key','add-key','','btn-primary'))+`<div class="help-box">客户端 Base URL：<code>http://127.0.0.1:4142/v1</code>。每个 Key 绑定一位用户，用量会同时记录在用户与 Key 下。</div>`+section('密钥列表',table(['名称 / 前缀','所属用户','状态','已用 / 额度','微软账号','模型范围','最近使用','操作'],rows),`${data.keys.length} 个密钥`);
}
function renderUsage(){const rows=data.usage.map(r=>`<tr><td>${when(r.created_at)}</td><td class="mono">${esc(r.model)}</td><td>${badge(r.status>=200&&r.status<300,r.status,'HTTP '+r.status)}</td><td>${r.units}</td><td>${r.input_tokens??'—'} / ${r.output_tokens??'—'}</td><td>${r.latency_ms} ms</td><td class="mono">${esc(short(r.channel_id))}</td></tr>`);
 $('#page').innerHTML=head('用量记录','审计实际请求状态、响应耗时和扣费积分；不储存提问正文、响应内容或访问 Token。',btn('↓ 导出 CSV','export-usage'))+`<div class="help-box"><strong>Token 统计说明：</strong>“—”表示上游没有返回可验证的 Token 用量，不会使用伪造的精确数值。积分按启用模型的成功请求费用结算。</div>`+section('请求记录',table(['请求时间','模型','状态','扣除积分','输入 / 输出 Token','延迟','渠道'],rows),`最近 ${data.usage.length} 条`);
}
function renderAudit(){const rows=data.audit.map(r=>`<tr><td>${when(r.created_at)}</td><td class="mono">${esc(r.action)}</td><td class="mono">${esc(short(r.actor_id))}</td><td>${esc(r.target)}</td><td>${esc(r.summary)}</td></tr>`);
 $('#page').innerHTML=head('审计日志','记录管理员和用户对账号、渠道、密钥、额度及角色的重要变更。')+section('管理操作记录',table(['时间','动作','操作者','对象','摘要'],rows),`最近 ${data.audit.length} 条`);
}
function renderSettings(){const d=data.settings;$('#page').innerHTML=head('系统设置','查看当前网关配置、修改自己的登录密码，并了解生产部署边界。')+`<div class="two-columns"><div class="panel-card"><h3>系统信息</h3><p class="card-subtitle">配置由环境变量和本地 SQLite 管理</p><div class="settings-grid">${[['绑定地址',d.host],['管理端口',d.port],['数据库目录',d.data_dir],['Node.js 版本',d.node],['额度模式','成功请求积分'],['微软凭证','通过 HTTPS 网页配置，AES-256-GCM 加密保存，登录时短暂解密']].map(x=>`<div class="setting-item"><strong>${x[0]}</strong><span>${esc(x[1])}</span></div>`).join('')}</div></div><div class="panel-card"><h3>账号安全</h3><p class="card-subtitle">维护后台登录密码及本机访问控制</p><div class="health-line"><span>网页会话</span><strong>12 小时有效 · HttpOnly / SameSite</strong></div><div class="health-line"><span>管理操作</span><strong>CSRF + 角色校验</strong></div><div class="health-line"><span>客户端授权</span><strong>API Key 哈希验证</strong></div><p style="margin-top:19px">${btn('修改我的登录密码','change-password','','btn-primary')}</p></div></div><div class="help-box warning-box"><strong>部署提示：</strong>本程序默认只监听本机。若需跨设备访问，应通过 HTTPS、反向代理和网络访问控制提供入口。内置核心不另开端口；其他手动添加的本地代理端口必须限制访问。支持在 HTTPS 后台配置自动登录凭证，无需再登录 VPS 终端输入。微软官方远程 OAuth 回调尚未支持；若组织要求推送 MFA 或 FIDO2，自动登录仍可能失败。不支持支付、充值。</div>`;
}
function accountForm(existing){return formFields(field('label','账号显示名称',existing?.label||'')+(existing?'':select('runtime_type','账号类型',[{value:'isolated',label:'独立授权账号（推荐）'},{value:'legacy',label:'旧版手动代理档案'}],'isolated'))+`<div class="field-grid">${field('email_hint','微软登录邮箱（独立账号必填）',existing?.email_hint||'','email',existing?.runtime_type==='isolated'?'readonly':'')}${field('tenant_hint','租户 ID（可选，GUID 格式启用校验）',existing?.tenant_hint||'')}</div>`+textarea('notes','备注（禁止放 Token 或密码）',existing?.notes||'')+boxcheck('enabled','启用账号',existing?.enabled??true));}
function channelForm(c){const accounts=(data.accounts||[]).map(x=>({value:x.id,label:x.label}));return formFields(field('name','渠道名称',c?.name||'')+select('account_id','关联微软账号档案',accounts,c?.account_id||accounts[0]?.value)+field('upstream','上游类型或本机地址',c?.upstream||'embedded://default','url')+`<div class="field-grid">${field('priority','优先级（小值优先）',c?.priority??10,'number','min="0" max="1000"')}${field('weight','权重',c?.weight??1,'number','min="1" max="100"')}${field('concurrency_limit','最大并发',c?.concurrency_limit??2,'number','min="1" max="40"')}${field('timeout_ms','超时毫秒',c?.timeout_ms??180000,'number','min="1000" max="600000"')}</div>`+field('models','支持的模型（逗号分隔，留空表示全部）',c?.models?.join(',')||'')+boxcheck('enabled','启用该渠道',c?.enabled??true));}
function userForm(u){return formFields(`<div class="field-grid">${field('name','用户名称',u?.name||'')}${u?'':field('email','登录邮箱','','email')}</div>`+(u?'':field('password','初始密码（至少 12 位）','','password','minlength="12"'))+select('role','角色',[{value:'user',label:'普通用户'},{value:'operator',label:'运营人员'},{value:'admin',label:'管理员'}],u?.role||'user')+`<div class="field-grid">${field('quota_units','总积分额度（留空无限）',u?.quota_units??'','number','min="0"')}${field('daily_limit','每日请求上限（留空无限）',u?.daily_limit??'','number','min="0"')}${field('concurrency_limit','最大并发请求',u?.concurrency_limit??2,'number','min="1" max="20"')}</div>`+boxcheck('enabled','启用用户',u?.enabled??true));}
function keyForm(k){const userOpts=(data.users||[who]).map(u=>({value:u.id,label:`${u.name} (${u.email})`}));const accts=(data.availableAccounts||[]).map(a=>({value:a.id,label:a.label+'（'+(a.runtime_type==='isolated'?'独立身份':'旧版核心')+'）'}));return formFields(field('name','密钥名称',k?.name||'')+(admin()&&!k?select('owner_id','所属用户',userOpts,who.id):'')+select('account_id','绑定微软账号（须先分配权限）',accts,k?.account_id||accts[0]?.value)+field('quota_units','密钥积分额度（留空无限）',k?.quota_units??'','number','min="0"')+field('models','允许的模型（逗号分隔，留空全部）',k?.models?.join(',')||'')+field('expires_at','失效时间（可留空）',k?.expires_at?k.expires_at.slice(0,16):'','datetime-local')+boxcheck('enabled','启用该密钥',k?.enabled??true));}
function modelForm(m){return formFields(field('id','模型标识',m?.id||'','text',m?'readonly':'required')+field('label','显示名称',m?.label||'')+field('cost_units','每次成功请求扣除的积分',m?.cost_units??1,'number','min="0"')+boxcheck('enabled','启用模型',m?.enabled??true));}
const emptyNull=v=>v===''||v===undefined?null:Number(v);
const csvCells=v=>`"${String(v??'').replaceAll('"','""')}"`;
function csvExport(){const rows=[['时间','用户ID','Key ID','渠道 ID','模型','HTTP 状态','积分','输入 Token','输出 Token','Token 来源','耗时毫秒','Request ID'],...data.usage.map(x=>[x.created_at,x.user_id,x.key_id,x.channel_id,x.model,x.status,x.units,x.input_tokens,x.output_tokens,x.usage_source,x.latency_ms,x.request_id])];const blob=new Blob(['\uFEFF'+rows.map(r=>r.map(csvCells).join(',')).join('\n')],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='m365-usage-'+new Date().toISOString().slice(0,10)+'.csv';a.click();URL.revokeObjectURL(url);}
async function action(name,id){if(name==='refresh')return showTab(tab);
 if(name==='add-account'){popup('添加微软账号档案',accountForm(),async p=>{await api('/accounts','POST',{...p});});return;}
 if(name==='edit-account'){const a=data.accounts.find(x=>x.id===id);popup('编辑微软账号档案',accountForm(a),async p=>api('/accounts/'+id,'PATCH',p));return;}
 if(name==='copy-account-id'){await navigator.clipboard.writeText(id);notice('账号 ID 已复制');return;}
 if(name==='test-chat'){
   const a=data.accounts.find(x=>x.id===id);if(!a)return;
   const models=(data.models||[]).filter(m=>m.enabled).map(m=>({value:m.id,label:m.label===m.id?m.id:`${m.label} (${m.id})`}));
   if(!models.length){notice('请先在「模型与额度」启用一个模型');return;}
   let history=[];let selectedModel='';
   popup('测试模型对话：'+a.label,
     `<div class="help-box">直接使用此账号已保存的 AT 发起真实模型请求；Token 认证失败时再尝试 RT 续期。不会在后台表单显示令牌。</div>`+
     formFields(select('model','测试模型',models,models[0].value)+textarea('prompt','输入测试问题','你好，请回复：连接测试成功。'),'发送测试')+
     `<div id="chat-test-output" role="status" aria-live="polite"></div>`,
     async p=>{
       const output=$('#chat-test-output'),prompt=String(p.prompt||'').trim();
       if(!prompt){output.innerHTML='<div class="help-box warning-box">请输入测试问题。</div>';return {keepOpen:true};}
       if(selectedModel!==p.model){history=[];selectedModel=p.model;}
       output.innerHTML='<div class="help-box">正在向模型发送测试消息…</div>';
       try{
         const result=await api('/accounts/'+id+'/test-chat','POST',{
           model:p.model,messages:[...history,{role:'user',content:prompt}]
         });
         const meta=`HTTP ${result.httpStatus||'?'} · ${result.latencyMs??'?'} ms`;
         if(result.ok){
           history.push({role:'user',content:prompt},{role:'assistant',content:result.reply});
           output.innerHTML=`<div class="help-box"><strong>测试成功</strong> · ${esc(meta)}</div>`+
             history.map(m=>`<div class="help-box"><strong>${m.role==='user'?'提问':'模型回答'}</strong><div>${esc(m.content).replace(/\n/g,'<br>')}</div></div>`).join('');
           $('#dialog-form textarea[name=prompt]').value='';
         }else{
           output.innerHTML=`<div class="help-box warning-box"><strong>调用失败</strong> · ${esc(meta)}<div>${esc(result.message||'未知错误')}</div></div>`;
         }
       }catch(err){output.innerHTML=`<div class="help-box warning-box"><strong>调用失败</strong><div>${esc(err.message)}</div></div>`;}
       return {keepOpen:true};
     });return;
 }
 if(name==='import-at-rt'){
   const a=data.accounts.find(x=>x.id===id);if(!a)return;
   popup('直接填写 AT 和 RT：'+a.label,formFields(
     `<div class="help-box warning-box">直接保存 AT 和 RT，点击「测试对话」后才会调用微软服务；只有明确 Token 认证失败时才尝试 RT 续期。</div>`+
     textarea('access_token','Access Token (AT)')+
     textarea('refresh_token','Refresh Token (RT)')+
     field('admin_password','再次输入管理后台登录密码','','password','required autocomplete="current-password"')
   ),async p=>{
     const result=await api('/accounts/'+id+'/import-at-rt','POST',p);
     notice(result.message||'AT / RT 已保存，请点击测试对话验证');return result;
   });return;
 }
 if(name==='import-msal-cache'){
   const a=data.accounts.find(x=>x.id===id);if(!a)return;
   popup('导入外部 MSAL 授权缓存：'+a.label,formFields(`<div class="help-box warning-box">这里不是粘贴 AT / RT 的单独字符串，而是同一 OAuth 客户端已合法登录生成的完整 MSAL JSON 缓存（Account、AccessToken、RefreshToken 等）。仅限本人账号，必须使用 HTTPS；公共 HTTP 测试入口会拒绝导入。缓存含有长期凭证，请勿发到 GitHub 或聊天窗口。导入后后台将尝试静默获取 Token，失败时需重新完成微软官方授权。</div>`+textarea('msal_cache','完整 MSAL JSON 缓存')+field('admin_password','再次输入管理后台登录密码','','password','required autocomplete="current-password"')),async p=>{
     const result=await api('/accounts/'+id+'/import-msal-cache','POST',p);
     notice(result.message||'已开始验证导入缓存');return result;
   });return;
 }
 if(name==='verify-msal-cache'){
   const r=await api('/accounts/'+id+'/verify-msal-cache','POST',{});notice(r.message||'正在验证缓存');await showTab('accounts');return;
 }
 if(name==='configure-auto'){
   const a=data.accounts.find(x=>x.id===id);
   if(!a)return;
   popup('配置自动登录：'+a.label,formFields(`<div class="help-box warning-box">仅供管理本人或组织明确授权的账号。账号：<strong>${esc(a.email_hint)}</strong>。需要 HTTPS 访问后台。以下密码与 TOTP Base32 种子经加密保存，不会回显；不是填写六位动态码。</div>`+field('password','微软账号密码','','password','required autocomplete="new-password"')+field('mfaSecret','TOTP Base32 种子（不是六位验证码）','','password','required autocomplete="off"')+field('admin_password','再次输入管理后台登录密码','','password','required autocomplete="current-password"')),async p=>{await api('/accounts/'+id+'/credentials','PUT',p);notice('已保存加密凭证，请点击自动登录');});return;
 }
 if(name==='remove-auto'){
   const a=data.accounts.find(x=>x.id===id);
   popup('关闭自动登录：'+(a?.label||''),formFields(`<div class="help-box warning-box">清除这条账号的自动登录凭证，已有 MSAL 登录缓存不会被删除。</div>`+field('admin_password','再次输入管理后台登录密码','','password','required')),async p=>api('/accounts/'+id+'/credentials','DELETE',p));return;
 }
 if(name==='auto-login-account'){if(!confirm('将使用已加密保存的密码与 TOTP 种子尝试微软登录。请确保账号属于你且组织允许自动登录。继续吗？'))return;const r=await api('/accounts/'+id+'/auto-login','POST');notice(r.message||'自动登录已启动');await showTab('accounts');return;}
 if(name==='authorize-account'){if(!confirm('将在运行此服务的电脑上打开 Microsoft 登录浏览器，请亲自完成 MFA 验证。继续吗？'))return;const r=await api('/accounts/'+id+'/authorize','POST');notice(r.message||'请在本机完成微软登录');await showTab('accounts');return;}
 if(name==='refresh-account'){const r=await api('/accounts/'+id+'/status');notice('账号状态：'+r.data.state);await showTab('accounts');return;}
 if(name==='unlink-account'){if(confirm('解除关联将删除此账号的本地 MSAL 缓存与浏览器登录档案，关联渠道也将停用。确认吗？')){await api('/accounts/'+id+'/unlink','POST');await showTab('accounts');notice('已解除账号关联');}return;}
 if(name==='delete-account'){if(confirm('确定删除账号档案？必须先删除关联渠道。')){await api('/accounts/'+id,'DELETE');await showTab(tab);notice('账号已移除');}return;}
 if(name==='add-channel'||name==='edit-channel'){const c=name==='edit-channel'?data.channels.find(x=>x.id===id):null;popup(c?'编辑渠道':'新增渠道',channelForm(c),async p=>{p.models=p.models?p.models.split(',').map(x=>x.trim()).filter(Boolean):null;for(const x of ['priority','weight','concurrency_limit','timeout_ms'])p[x]=Number(p[x]);await api(c?'/channels/'+id:'/channels',c?'PATCH':'POST',p);});return;}
 if(name==='delete-channel'){if(confirm('确定删除该渠道？')){await api('/channels/'+id,'DELETE');await showTab(tab);}return;}
 if(name==='probe-channel'||name==='probe-all'){notice('正在检查所有渠道…');const health=(await api('/channels/health')).data;for(const h of health){const el=document.getElementById('health-'+h.id);if(el)el.outerHTML=`<span id="health-${esc(h.id)}" class="status-pill ${h.online?'':'off'}">${h.online?'连接正常':'连接失败'}</span>`;}return;}
 if(name==='add-user'||name==='edit-user'){const u=name==='edit-user'?data.users.find(x=>x.id===id):null;popup(u?'编辑用户':'创建用户',userForm(u),async p=>{p.quota_units=emptyNull(p.quota_units);p.daily_limit=emptyNull(p.daily_limit);p.concurrency_limit=Number(p.concurrency_limit);if(!u)await api('/users','POST',p);else await api('/users/'+id,'PATCH',p);});return;}
 if(name==='reset-user'){if(confirm('确定清零该用户累计积分计数吗？历史记录不会删除。')){await api('/users/'+id+'/reset','POST');await showTab(tab);}return;}
 if(name==='grant-user-accounts'){const assigned=(await api('/users/'+id+'/accounts')).data;const accounts=(await api('/accounts')).data;const html=accounts.map(a=>`<label class="checkline"><input type="checkbox" name="a_${esc(a.id)}" ${assigned.includes(a.id)?'checked':''}> ${esc(a.label)} (${esc(a.email_hint||'旧版核心')})</label>`).join('');popup('分配用户可访问的微软账号',formFields(html||'<p>请先创建账号</p>'),async form=>api('/users/'+id+'/accounts','PUT',{accounts:Object.entries(form).filter(([k,v])=>k.startsWith('a_')&&v).map(([k])=>k.slice(2))}));return;}
 if(name==='reset-user-password'){popup('设置用户新密码',formFields(field('password','新密码（至少 12 位）','','password','minlength="12" required')),async p=>api('/users/'+id+'/password','POST',p));return;}
 if(name==='add-key'||name==='edit-key'){const k=name==='edit-key'?data.keys.find(x=>x.id===id):null;popup(k?'编辑 API Key':'创建 API Key',keyForm(k),async p=>{p.account_id=p.account_id||null;p.quota_units=emptyNull(p.quota_units);p.models=p.models?p.models.split(',').map(x=>x.trim()).filter(Boolean):null;return api(k?'/keys/'+id:'/keys',k?'PATCH':'POST',p);});return;}
 if(name==='delete-key'){if(confirm('确定永久撤销密钥？使用中的客户端将立即失效。')){await api('/keys/'+id,'DELETE');await showTab(tab);}return;}
 if(name==='reset-key'){if(confirm('确定重置此 Key 的积分用量？')){await api('/keys/'+id+'/reset','POST');await showTab(tab);}return;}
 if(name==='copy-token'){const token=$('#new-token')?.textContent;if(token){await navigator.clipboard.writeText(token);notice('已复制到剪贴板');}return;}
 if(name==='edit-model'||name==='add-model'){const m=name==='edit-model'?data.models.find(x=>x.id===id):null;popup(m?'编辑模型':'新增模型',modelForm(m),async p=>api('/models','POST',{...p,cost_units:Number(p.cost_units)}));return;}
 if(name==='sync-models'){const r=await api('/models/sync','POST');await showTab(tab);notice(`同步完成，发现 ${r.created} 个新模型（默认禁用）`);return;}
 if(name==='export-usage')return csvExport();
 if(name==='change-password'){popup('修改我的登录密码',formFields(field('current','当前密码','','password','required')+field('next','新密码（至少 12 位）','','password','minlength="12" required')),async p=>api('/auth/password','POST',p));return;}
}
async function init(){try{const r=await api('/auth/me');csrf=r.csrf;who=r.user;welcome();await showTab('overview');}catch{logoutView();}}
$('#login-form').addEventListener('submit',async e=>{e.preventDefault();$('#login-error').textContent='';const p=Object.fromEntries(new FormData(e.currentTarget));try{const r=await api('/auth/login','POST',p);csrf=r.csrf;who=r.user;welcome();await showTab('overview');e.currentTarget.querySelector('[name=password]').value='';}catch(err){ $('#login-error').textContent=err.message;}});
$('#logout').addEventListener('click',async()=>{try{await api('/auth/logout','POST');}catch{}logoutView();});
$('#sidebar-nav').addEventListener('click',e=>{const el=e.target.closest('[data-tab]');if(el)showTab(el.dataset.tab);});
$('#page').addEventListener('click',async e=>{const el=e.target.closest('[data-action]');if(el)try{await action(el.dataset.action,el.dataset.id);}catch(err){notice('操作失败：'+err.message);}});
$('#modal').addEventListener('click',async e=>{const el=e.target.closest('[data-action]');if(el)try{await action(el.dataset.action,el.dataset.id);}catch(err){notice(err.message);}});
$('#close-modal').onclick=hideModal;
$('#modal').addEventListener('click',e=>{if(e.target.id==='modal')hideModal();});
$('#top-refresh').onclick=()=>showTab(tab);
$('#check-update').onclick=()=>triggerUpdate('check');
$('#apply-update').onclick=()=>triggerUpdate('apply');
$('#menu-toggle').onclick=()=>$('.sidebar').classList.toggle('show');
init();
