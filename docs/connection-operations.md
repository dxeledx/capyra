# 连接与日常运维

默认采用本机 OAuth 与 Sites 固定设备入口。文件、执行、批准和令牌均在本机；Quick Tunnel 与自备 Named Tunnel 收在高级连接选项中。

## 本机使用流程

1. 运行 `capyra start --open`，选择工作区与能力。
2. 在“连接 ChatGPT”点击“准备并启动连接”。
3. 复制生成的 HTTPS MCP 地址到 ChatGPT，认证选择 OAuth。
4. 在本机批准首次 OAuth 连接；个人模式下后续正常任务自动执行。

Quick Tunnel 进程重建后可能生成新地址，届时需要更新 ChatGPT 保存的地址并重新授权。高级用户可自行配置 Named Tunnel。云端账号插件仅用于保留旧配置兼容，不在默认组合中启动；切换现有配置使用 `capyra local`。

Cloudflare Quick Tunnel 不支持 SSE；Capyra HTTP MCP 使用 JSON 响应。默认 IPv4、TCP HTTP/2，网络故障在连接页查看诊断；Capyra 不改变系统 VPN 或路由。

## 状态如何判断

| 状态 | 证据 |
|---|---|
| 本机服务 | 实际请求 `http://127.0.0.1:MCP_PORT/health`，核验 Capyra 标记 |
| 隧道进程 | 子进程创建、退出和重连记录 |
| connector 已注册 | cloudflared 的 loopback `/ready` 返回实际就绪连接数；启动阶段也观察注册日志。它仍不代表公网请求成功 |
| 公网入口 | 从本机实际请求当前 HTTPS 地址的 `/health` |
| OAuth discovery | 同时读取授权服务和受保护资源声明，检查 issuer、MCP resource 和端点来源 |
| MCP 初始化 | 实际发送 `initialize`；401 显示“需要授权”，只有有效初始化响应显示通过 |
| 授权 | OAuth 传输适配器观察到本次运行中的真实授权/撤销事件 |
| 实际工具调用 | 传输适配器收到真实调用；自测事件单独排除 |
| ChatGPT 产品验收 | 需要真实 ChatGPT 页面和调用结果的独立验收记录；自报客户端名称不能证明身份 |

OAuth 与调用观察在插件重启后回到未知，避免把过往授权冒充当前有效状态。`chatgptVerification` 不会由客户端名称、隧道 URL 或诊断初始化自动置为已验证。

## VPN、TUN 与断网恢复

连接诊断分别检查 Cloudflare Tunnel 域名解析、7844/TCP 出站、本机服务、公网入口和 MCP。网络接口检查只能发现可能的 VPN/TUN，不能证明某条连接实际经过哪条路由；TCP 握手成功也不能证明隧道注册成功。

检测到 198.18.0.0/15 的可能 Fake-IP 时，页面明确区分代理路径握手与 Cloudflare connector 就绪。公网 HTTPS 回访失败不会覆盖 connector 的真实就绪状态；例如本机 VPN 可能阻断公网域名的 HTTPS 访问，但隧道出站仍已注册。错误提示包含经过筛选的底层错误码，例如 `ECONNRESET`，不以笼统的 `fetch failed` 代替故障类型。

- DNS 失败：检查 VPN DNS/分流设置，再运行诊断。
- DNS 成功、7844/TCP 失败：在现有 VPN/防火墙设置中允许 cloudflared 或 Cloudflare Tunnel 域名的出站流量；也可切换网络后重试。
- TCP 成功、隧道失败：查看脱敏后的最近错误并重新连接。
- 公网正常、MCP 需要授权：完成 ChatGPT OAuth 和本机批准。
- 代理环境变量仅显示名称，不显示代理 URL、用户名或密码。Capyra 不修改系统代理或路由，也不承诺绕过 TUN。

出站端点来自 Cloudflare 官方防火墙说明：`region1.v2.argotunnel.com`、`region2.v2.argotunnel.com`，HTTP/2 使用 TCP 7844。参数依据 [运行参数](https://developers.cloudflare.com/tunnel/advanced/run-parameters/) 与 [防火墙要求](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/)。高级用户仍可切换 `auto` 或 `quic`；`auto` 的协议回退由 cloudflared 完成。

子进程异常退出后，Capyra 以退避间隔重试，最长 60 秒。主动停止会取消重试。休眠或较长执行间隔后会重新探测；公网检查失败且 connector 未确认就绪时重新创建连接。connector 仍就绪时保留现有入口，提示检查本机回访路径，避免因为 VPN 阻断本机回访而反复更换 Quick 地址。`autoStart` 配合持久化的运行意图控制 Capyra 重启后是否恢复：用户主动停止的连接不会自动启动。该设置不安装系统开机服务。

## 安装与状态文件

`cloudflared` 位于连接插件私有状态目录的 `bin/` 下。安装器从 `cloudflare/cloudflared` 官方 GitHub release 获取当前平台资产，先核验 SHA-256，再写入二进制；macOS `.tgz` 只提取普通文件 `cloudflared`。每次使用受管二进制前再次核验其摘要。系统已有的 cloudflared 会标注 `source: system`，其来源不冒充已由 Capyra 核验。官方发布依据见 [Cloudflare Releases](https://github.com/cloudflare/cloudflared/releases)。

连接目录为 `0700`，配置、设备运行 token、安装元数据为 `0600`，二进制为 `0700`。写入使用同目录临时文件和原子改名，拒绝目标软链接。Windows 的实际访问保护还依赖该用户目录的 ACL；POSIX mode 数值不是 Windows ACL 隔离证明。

状态内容：

- `connection.json`：连接模式、地址、协议、自动恢复设置与运行意图，不含 token。
- `tunnel-token`：仅高级稳定连接使用的设备运行凭据，通过 `--token-file` 传递，避免进入进程参数。
- `cloudflared-config.json`：显式的插件配置，避免加载用户已有的其他隧道设置。
- `bin/installation.json`：官方资产和已安装二进制的摘要、版本。

迁移或备份前主动停止连接，使用加密备份保存私有状态目录并保留访问权限。二进制可以重新下载。不要把 token、云端管理凭据或完整账号状态放进问题反馈、源码仓库或普通日志。连接状态接口仅返回 `hasToken` 和脱敏事件，不提供读回 token 的 API。

## 高级稳定连接与云端管理

`CloudflareApiProvider` 用于产品方管理稳定 Named Tunnel。它只在账号服务中运行，管理 API 凭据采用 JavaScript 私有字段保存。每台设备取得独立的 tunnel token，不能用该 token 管理 Cloudflare 账户或其他设备。`provision({deviceId,mcpPort})` 创建隧道、有限 ingress 与 CNAME；`rotate({tunnelId})` 更新运行凭据并清除旧 connector；`revoke({tunnelId,dnsRecordId})` 关闭 ingress、清除 connector、删除 tunnel 与 DNS。

公开路由仅包含 `/mcp`、`/health`、OAuth discovery、授权/注册/token/撤销端点及授权等待查询。其余 ingress 返回 404。origin 固定为 `127.0.0.1:MCP_PORT`；控制端口禁止作为隧道 origin，批准与管理 API 保留在独立本机控制服务。产品云服务必须先验证账号与设备归属后才能调用 provider。

生产云服务需要产品方 Cloudflare account ID、zone ID、已托管域名，以及限定账户隧道管理和该 zone DNS 写权限的 API token。设备端不应获得这些值。当前实现提供 API 适配和模拟协议测试；真实管理凭据、域名与公网资源变更未在此模块开发中执行。默认免登录连接不依赖此服务。

运行凭据轮换会使旧 token 无法建立新 connector；现有 connector 必须另行清除。接口已执行这一步。轮换后将新设备 token 保存到本机，再重新连接；若部分步骤失败，状态明确提示，重试轮换可完成恢复。撤销遇到已不存在的资源会继续清理 DNS；其余失败保留为可重试错误。依据 [官方 token 轮换流程](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/remote-tunnel-permissions/)。

## 插件接线与验证

内置插件提供 `ctx.provide('connection', service)`，没有可由 MCP 客户端直接启停或批准自身连接的工具。宿主先从设备身份取得固定入口，用它启动 MCP/OAuth，再调用 `configureHost({mcpPort,controlPort,onPublicUrl,onTunnelUrl,bridge,getProbeToken})` 和 `restore()`。`bridge` 提供固定地址、签名发布和删除接口；`onTunnelUrl` 只更新当前 Quick Host，`onPublicUrl` 只有在完整固定 issuer 改变时才撤销旧授权。服务替换者遵循 `src/connection/types.ts` 的接口即可。

`tests/connection.test.ts` 包含官方摘要/篡改验证、私有文件与软链接、真实子进程停止/恢复/重试、Quick URL 变化、休眠恢复、独立本机 HTTP 协议探测、诊断 session 清理、网络失败分类、脱敏以及云资源回滚/幂等撤销测试。运行：

```sh
npm run build
node --import tsx --test tests/connection.test.ts
node --import tsx --test tests/connection-identity.test.ts
```

这组测试需要允许本机 loopback 监听。Cloudflare API、DNS、TCP 和进程故障由测试注入；OAuth 地址检查另通过真实 SDK router 和回环 HTTP 验证。网络恢复后的成功状态不能证明此前失败的唯一原因，排查时应分别检查 DNS、VPN/TUN 路由、TCP、cloudflared readiness、公网 HTTPS、OAuth 和真实工具调用。

## 浏览器授权页受 VPN/TUN 影响时

连接向导提供默认折叠的“授权页面打不开？”：复制 ChatGPT 本次打开失败的完整授权地址，提交后点击本机继续链接。控制台只接受当前 HTTPS 入口的准确 `/authorize` 路径，本机目标端口来自真实 MCP listener；原 query、PKCE、state、回调和公网 resource 保持不变。服务端不代理输入地址、不自动批准，也不修改网络设置。授权页在回环端口轮询本次本机确认，之后仍返回原 ChatGPT 回调。

该入口解决浏览器访问自己公网授权页的路径问题；ChatGPT 云侧仍须能访问公网 MCP，cloudflared 仍依赖系统路由允许的 IPv4 和 7844/TCP。[Cloudflare 参数](https://developers.cloudflare.com/tunnel/advanced/run-parameters/)中的源地址绑定不能替代操作系统 TUN 分流。纯 HTTP/2 可减少 UDP/QUIC 兼容问题，不能保证所有 VPN 规则都可绕过。

OAuth 四个端点分别按设备聚合限流，保留 SDK 原有限额，不使用 X-Forwarded-For 或 CF-Connecting-IP 识别用户。探测成功会清除当前探测错误并保留历史；独立 connector 错误不会被成功 HTTP 回访误清。根 issuer 的合法末尾斜线已兼容，其他域名、路径和 resource 仍严格校验。
安装器会从官方发布源取得当前平台资产，核对发布摘要和解包后二进制摘要，再以私有权限保存。系统已有的 `cloudflared` 不会被覆盖。跨平台发布仍应在目标系统上检查下载、权限、版本输出、停止与恢复行为。
