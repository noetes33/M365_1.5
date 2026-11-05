# M365 Copilot Proxy + 中文网页管理后台 v1.4

> **v1.4 重点：部署完成后，添加微软账号、填写账号信息、配置密码与软件 TOTP 种子、开启/关闭自动登录、管理渠道、密钥、用户和额度，全部通过 HTTPS 网页后台操作。无需再用 SSH 运行 `configure-auto-login.sh` 或 PowerShell 凭证录入脚本。**
>
> 本压缩包是对 [cramt/m365-copilot-proxy](https://github.com/cramt/m365-copilot-proxy) 的源码叠加补丁，**不包括原仓库全部源文件**。不能证明已经通过真实微软租户的端到端测试。仅限您本人或组织明确授权管理的 Microsoft 365 账号，不能绕过 Microsoft 条件访问、MFA 和租户许可。

## 1. v1.4 实际改了什么

| 原 v1.3 的操作 | v1.4 的操作 |
|---|---|
| 网页添加账号，但要 SSH 到 VPS 输入密码/TOTP | 网页「微软账号 → 配置自动登录」，全部在 HTTPS 网页表单填写 |
| SSH 执行 configure-auto-login.sh/.ps1 | 不需要（保留旧脚本仅为兼容） |
| 本地明文 `secrets.json` 存储 | 网页配置保存为 AES-256-GCM 加密的 `credentials.enc` |
| VPS 命令删除凭证 | 网页「清除凭证」，要求再次验证管理员密码 |
| 账号状态网页查看 | 保留；显示已配置/未配置，**不返回明文凭证** |
| 登录后原项目的 MSAL 静默刷新 | 保留 |

### 具体使用步骤

1. VPS 完成**一次**安装和 HTTPS 反向代理配置。后续添加账号不需要 SSH。
2. 在电脑浏览器打开 `https://您的后台域名/admin/`，使用管理员账号登录。
3. 「微软账号」→「添加微软账号」，选择「独立授权账号」，填写昵称、真实 Microsoft 工作/学校邮箱及可选租户 ID。
4. 在该账号操作栏点击「**配置自动登录**」，网页表单填写：微软账号密码、**软件 TOTP 的 Base32 种子**（不是当前六位验证码）、**当前管理后台密码**（用于二次验证）。
5. 点击保存后，后台只显示「自动登录已配置」，没有读取/回显原密码的接口。
6. 点击「**自动登录**」，后台启动原项目的 MSAL + Playwright 登录逻辑。状态栏点击「刷新状态」查看结果。
7. 在「用户管理」「渠道管理」「API 密钥」完成分配和调用设置；以后重新配置/删除凭证均在网页完成。

**重要限制：** 这并非 Microsoft 官方网页 OAuth 回调。网页只负责将运营者主动提交的凭证经过 HTTPS 存入本机加密凭证库，服务器复用原项目的自动登录程序。如果该租户要求 Authenticator 推送、FIDO2/Passkey、额外验证码或其他 Conditional Access 验证，**此方案仍不能完成纯自动登录**。这些验证必须按微软要求完成；不会做 MFA 绕过。`本机授权` 仍只适用于带图形桌面的服务器，不是远程授权。

## 2. 安装 / 升级

**运行条件：** Node.js 24+、pnpm 10+、Git、可连接 GitHub 与微软服务；首次部署需要 SSH 及操作系统维护权限。

Linux VPS：解压此补丁，然后执行（命令参数填写你已有整合工程的绝对路径；如果没有则默认克隆新仓库）：

```bash
bash ./build-integrated.sh /opt/m365-copilot-proxy-integrated
```

首次启动前设置管理员密码（至少 12 位），启动命令：

```bash
cd /opt/m365-copilot-proxy-integrated
export M365_ADMIN_PASSWORD='首次初始化时使用的强密码'
pnpm console
```

**请不要把真实密码直接写入 shell history。** 生产环境应使用系统服务管理器保护环境变量，给数据目录配置访问权限，并使用专用服务账号。默认监听 `127.0.0.1:4142`，**不要改成公网监听**。

Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\build-integrated.ps1 -Target 'C:\m365-copilot-proxy-integrated'
cd 'C:\m365-copilot-proxy-integrated'
$pw=Read-Host '首次设置管理员密码（至少12位）' -AsSecureString
$env:M365_ADMIN_PASSWORD=[System.Net.NetworkCredential]::new('', $pw).Password
pnpm console
```

旧版 v1.3 数据使用相同 `M365_ADMIN_DATA`，数据库保留；升级前请备份数据并停掉旧服务。网页第一次重新保存某个账号的自动登录凭证后，会改为加密存储，并删除对应的旧版明文 `secrets.json`。如果尚未重新保存，旧版明文文件仍存在，需要自行清理。

### HTTPS 是必需的

v1.4 的敏感凭证写入/删除接口会拒绝普通 HTTP 请求；只接受 Node 进程自身 HTTPS，或运行在回环地址上的可信 HTTPS 反向代理传递 `X-Forwarded-Proto: https` 的请求。**不能通过 `http://VPS-IP:4142` 在公网填写密码或 TOTP 种子。**

以已安装 Caddy、域名 DNS 已解析到 VPS 为例，Caddyfile 可以包含：

```caddy
admin.example.com {
    reverse_proxy 127.0.0.1:4142
}
```

把 `admin.example.com` 替换为自己的域名，并确保 Caddy 获得有效 TLS 证书；反向代理应覆盖而不是无条件转发客户端自带的 `X-Forwarded-*` 信任信息。强烈建议在 HTTPS 之外再加 VPN/IP 访问白名单，不要允许匿名公共注册。部署 TLS 和 DNS 仍属于**首次服务器部署**，以后账号配置均通过网页进行。

## 3. 凭证安全与工作原理

- 网页表单只能由**管理员**打开。每次保存/删除都要求重新输入**后台管理员密码**，并通过 session、CSRF、SameSite Cookie、HTTPS、操作限流检查。
- 管理后台不向普通用户开放凭证管理接口；`GET /accounts`、状态与审计都不返回密码、TOTP、解密密钥或 MSAL Token。
- `credentials.enc` 使用 AES-256-GCM 加密，主密钥保存在仅供本机服务账号读取的 `M365_ADMIN_DATA/identity-vault.key`。两者被盗仍可能导致解密，因此**文件加密不替代磁盘加密和操作系统权限隔离**。
- 只有启动自动登录时，后台才解密凭证、通过本机父子进程 IPC 发送给对应的**独立账号工作进程**。工作进程短暂创建权限 `0600` 的凭证文件供上游 MSAL/Playwright 使用，登录结束立即删除。Linux 优先使用 `/dev/shm`（内存文件系统），其他系统使用系统临时目录。
- 账号 A 与账号 B 的密码、浏览器 profile、MSAL 缓存相互隔离；不能把凭证写进其他账号。
- 审计记录只包含“配置/清除凭证”操作，不记录明文。关闭弹窗时清除浏览器 DOM 中的密码输入内容。
- **备份时必须安全保管加密主密钥**，丢失后无法解密已有 `credentials.enc`；如果密钥和凭证同时泄露，请重置微软密码并更换 TOTP Enrollment。
- 网页提交密码和 TOTP 种子本身比直接跳转微软官方登录更敏感，请仅在自己控制、经过安全审计的私人 HTTPS 管理后台使用。最佳实践仍是使用组织批准的标准 OAuth/Entra 授权流程。

### 文件结构

| 路径 | 含义 |
|---|---|
| `packages/console/credential-vault.mjs` | 加密凭证库与读取/清除逻辑 |
| `packages/console/account-manager.mjs` | 独立账号进程；自动登录时解密并转发到该进程 |
| `packages/console/account-worker.mjs` | 调用原 `getToken()`；授权期间临时写入凭证，完成后删除 |
| `packages/console/server.mjs` | 管理员二次验证、HTTPS 限制、凭证配置 API |
| `packages/console/public/app.js` | 网页配置/清除凭证表单及状态按钮 |

## 4. 本地测试与已知边界

当前已通过 **29 项本地自动化测试**，新增的测试覆盖 HTTPS 拦截、未登录/无 CSRF/管理员密码错误拒绝、非法 TOTP 种子拦截、AES-GCM 密文检查、管理 API 不泄露凭证、网页配置后通过模拟原项目工作进程自动登录、移除凭证但保留 MSAL 缓存。

```bash
pnpm console:test
```

这些测试使用 mock 上游，**没有用真实微软账号端到端认证**；本环境也未实际克隆上游并运行安装脚本，请在你的 VPS 上进行版本兼容性检查。私有 Sydney/ChatHub 权限、租户 Conditional Access、原仓库更新及服务限流都可能使真实登录失败。

仍没有：通过 Microsoft 官方登录网页在远程浏览器完成所有 MFA 的标准 OAuth 回调、Responses API、准确 Token 计费、支付充值、生产高可用保障。本版实现的是**网页配置原项目已支持的密码 + 软件 TOTP 自动登录方式**，不是对所有租户/所有 MFA 的通用登录解决方案。

## 5. 原项目功能与许可

整合脚本会克隆上游 `cramt/m365-copilot-proxy` 源码，保留其 `@m365-copilot/core` 与 `@m365-copilot/proxy-lib` 的主要 API、模型路由、聊天、工具调用和已有图像能力。此 ZIP 是补丁，不是完整独立的源代码分发包；是否能在将来的上游版本正常构建以兼容性检查和实际联调为准。
