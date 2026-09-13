# 后台编码代理

编码代理由按需启动的独立进程执行。首次 `agents run` 或 `agents continue` 自动启动后台；MCP 重启、命令行退出、结果查询断开都保留正在运行的代理任务。只查看目标、历史记录或后台状态时，不启动后台，也不启动提供者。

```sh
capyra agents targets
capyra agents run codex "检查当前项目的错误处理"
capyra agents show <agent-id>
capyra agents output <agent-id>
capyra agents wait <agent-id>
capyra agents continue <agent-id> "继续处理发现的问题"
capyra agents ls
capyra agents cancel <agent-id>
```

角色与提供者在 `capyra.json` 的 `agents` 插件配置中维护；本机角色文件也可放入 `~/.capyra/agents` 或工作区的 `.capyra/agents`。运行前通过 `targets` 检查本机可用性。使用既有提供者登录态和额度，Capyra 不在派发时自动下载模型或代理 SDK；这些扩展由本机用户按需安装。Codex、Claude、OpenCode、Pi 和 ACP 提供者的原生协议由执行插件实现；daemon 统一拥有这些运行时。

`run` 和 `continue` 立即返回逻辑任务 ID。`wait` 最多等待 12 秒，可同时查询 20 个 ID，并返回当前结果与 turn 元数据；完整历史正文通过 `show` 读取。`--json` 输出结构化结果。`--model`、`--effort`、`--cwd`、`--write-mode` 用于明确覆盖本次任务参数。MCP 中的派发、继续和取消仍经过本机批准；命令行操作由当前本机用户直接发起。

## 托管 subagents 工作流

代理插件启用时，将当前版本的 `subagents` 技能同步到 `.capyra/agent-workflow/skills/subagents/SKILL.md`。这个目录属于当前项目的私有状态，不修改用户全局 Skills。也可以独立检查、读取或安装：

```sh
capyra agents workflow status
capyra agents workflow show
capyra agents workflow install
```

`status`、`show` 和 `agents targets` 不启动后台；未安装时从应用内置正文读取，不为查询创建文件。`install` 才同步私有副本，重复安装同一版本不重写文件。托管副本失效时不会把其中的任意内容注入模型；符号链接、硬链接、二进制和过大的文件会明确拒绝。

其他编码客户端可以用 `capyra agents workflow show` 导出完整 Markdown 正文，再按该客户端的 Skill 安装方式使用；Capyra 的安装命令只管理上述私有副本。

在 `agents` 插件配置中设置：

```json
{
  "workflow": { "enabled": true, "instructions": "on-demand" }
}
```

默认 `on-demand` 将精简目录和读取指引加入目标清单及实际代理任务。`preload` 会加入完整技能正文。MCP 的 `agents__targets` 返回 `workflow` 状态；`agents__workflow` 使用稳定 ID `subagents` 读取正文；`agents__install_workflow` 经过本机批准后安装。控制台可以直接读取、安装及选择这两个模式。`enabled:false` 关闭工作流注入，保留用户自行组织的角色说明与任务提示词。

每个实际派发的代理收到选中角色的说明、目标提供者与权限模式、工作区/运行目录和本次完整任务。原生提供者不自动继承父任务的 MCP 连接；技能明确区分可用 MCP 工具与授权后的本机 CLI，工具缺失时要求协调者在任务简报中提供所需内容。项目规则和其他技能通过既有 `skills__rules`、`skills__discover`、`skills__read` 发现与读取，托管服务不会再扫描或改写另一份全局技能目录。

## 代理权限模式

与固定参考 DevSpace `cd84cb23bd6947910e1606f135e230ee5a1a68e7` 使用同样的三个值：`read_only`、`allowed`、`full_access`。原生提供者默认 `allowed`。模式通过提供者协议、工具集合或系统沙箱执行，不用角色提示词代替权限控制。

```sh
capyra agents run codex "审阅代码" --write-mode read_only
capyra agents continue <agent-id> "实现修正" --write-mode allowed
```

MCP 的 `agents__run`、`agents__continue` 使用 `writeMode` 字段。配置中的 `providers.<id>.writeMode`、`roles.<id>.writeMode` 或角色 Markdown frontmatter 的 `writeMode` 可设置默认值；当前请求可以明确覆盖。每次批准预览会展示最终模式，`full_access` 会显示无限制访问。MCP 派发还绑定目标与角色行为的指纹，并固定预览时的有效模式；角色文件在批准后变化时拒绝执行，要求重新准备请求，而不使用变化后的提供者、命令或权限。CLI 由当前本机用户直接发起，不自动添加这项审批指纹。每个 turn 保存实际模式；继续时沿用已保存值，修改角色默认值不会扩大旧会话权限。没有保存模式的旧原生记录在继续时采用 `read_only`，历史 turn 保留其原有缺失字段。

| 提供者 | `read_only` | `allowed` | `full_access` |
|---|---|---|---|
| Codex | `read-only` / `readOnly` | `workspace-write` / `workspaceWrite`，写入选定目录，允许网络 | `danger-full-access` / `dangerFullAccess` |
| Claude | 只启用读取工具，拒绝 Bash/Edit/Write；沙箱禁止工作区写入 | 读取、编辑、Bash；沙箱允许选定目录写入，禁止未隔离命令 | 原生 `bypassPermissions`，关闭沙箱 |
| OpenCode | 原生权限拒绝 edit/bash/task，拒绝外部目录 | 允许 edit/bash，拒绝 task 和外部目录 | 允许外部目录，仍拒绝再次派发 task，与参考配置一致 |
| Cursor | 原生 sandbox enabled + plan；ACP 权限请求选择拒绝 | 原生 sandbox enabled；ACP 选择单次允许 | sandbox disabled + force |
| Copilot | 原生 sandbox + plan；拒绝额外权限升级 | 原生 sandbox；拒绝额外权限升级 | no-sandbox + allow-all |
| Grok | ACP 权限请求选择拒绝 | ACP 权限请求选择允许 | ACP 权限请求选择允许 |
| Pi | 仅注册 read/grep/find/ls，并检查文件路径 | 受限文件工具及经系统沙箱包装的 Bash | 使用 Pi 原生工具，不启用宿主沙箱 |

Grok 在固定参考中没有独立的 OS 沙箱切换；其模式依赖提供者实际发出的 ACP permission 请求，不能据此宣称具备操作系统级只读或工作区隔离。OpenCode 的表中约束是提供者工具权限，也不等同于独立 OS 沙箱。对应原生参数依据 [Codex](https://github.com/Waishnav/devspace/blob/cd84cb23bd6947910e1606f135e230ee5a1a68e7/src/local-agent-codex.ts)、[Claude](https://github.com/Waishnav/devspace/blob/cd84cb23bd6947910e1606f135e230ee5a1a68e7/src/local-agent-claude.ts)、[OpenCode](https://github.com/Waishnav/devspace/blob/cd84cb23bd6947910e1606f135e230ee5a1a68e7/src/local-agent-opencode.ts)、[ACP](https://github.com/Waishnav/devspace/blob/cd84cb23bd6947910e1606f135e230ee5a1a68e7/src/local-agent-acp.ts) 和 [Pi 沙箱实现](https://github.com/Waishnav/devspace/blob/cd84cb23bd6947910e1606f135e230ee5a1a68e7/src/local-agent-pi-sandbox.ts)。

Pi 自身没有 OS 沙箱，参考项目也为其增加了独立适配。Capyra 的受限 Pi 模式按需加载 `@anthropic-ai/sandbox-runtime`，只执行其返回的包装 argv；依赖缺失、API 不兼容或初始化失败时拒绝运行，绝不降级为无限制命令。可将 SDK 与该依赖安装在 `.capyra/extensions/pi/`；验证版本为 Pi `0.80.3` 和 sandbox-runtime `0.0.71`。Linux 需要该运行时要求的系统隔离工具；Windows 的进程全局沙箱策略使受限 Pi turn 顺序执行。完整模式不加载该可选依赖。关闭或取消 turn 会释放沙箱资源。

自定义 `command` 提供者只能使用 `full_access`，不会把任意命令上的“只读”提示词视为真实权限约束。原生 ACP 提供者的 `args` 是可选的启动前缀，例如包装程序的脚本路径；Capyra 在其后追加与模式对应的原生子命令和控制参数，避免自定义参数把权限字段直接丢掉。

## 可选依赖与 Windows 命令

Pi 和 OpenCode 的 SDK 使用 ESM `import` 条件导出。扩展从 `.capyra/extensions/<provider>/` 解析；解析器使用 Node 的 ESM 规则，尊重导出子路径和私有入口边界。未安装依赖时只查本机目录，不启动解析进程；首次解析已安装包后按 manifest 元数据缓存，升级、卸载或入口删除后重新检查。SDK 不在清单查询阶段加载。

Windows 上直接执行标准 Node/npm `.cmd`、`.bat` shim 时，Capyra 解析到 `node.exe` 与实际脚本，并将参数保持为 argv；npm/npx 保留原 wrapper 的全局安装版本选择。`&`、`|`、`%`、`!` 和引号不会被偷偷交给第二层 shell 解释。包含额外批处理控制流的未知 wrapper 会明确拒绝；需要运行一般批处理时，使用 `process__execute` 的 `command` 字符串显式选择 shell 执行。非 Windows 的直接执行保持原有行为。

Windows 的转换与 argv 保真已经在非 Windows 的正式协议测试和真实 Node bootstrap 中验证，尚未完成 Windows 实机验收。真实 Pi SDK 注册、路径检查、macOS 系统沙箱工作区写入及越界写入拒绝已在不调用模型的条件下通过。Codex 的真实只读任务与继续回合已通过下述验收；其余六种提供者的真实模型 turn 仍需各自登录、额度与平台条件，协议测试和 SDK 加载不能替代这些外部验收。

## 运维

```sh
capyra agents daemon status
capyra agents daemon logs --lines 100
capyra agents daemon stop
capyra agents daemon stop --force
```

普通 `stop` 在有运行中任务时拒绝停止；`--force` 明确中断任务并等待提供者清理。正常停止保留原生 session ID。进程崩溃后，下一次独占启动把未结束的 turn 标为 `interrupted`，不会重新发送原来的提示词。读取历史时也不会改写磁盘；确认之前任务的实际效果后再显式 `continue`。异常强制杀死后台可能使提供者进程暂时独立存活，恢复时不依据旧 PID 杀进程，以免误伤已经复用该 PID 的其他程序。

任务全部结束且没有查询连接后，后台默认空闲 30 秒退出。可在 `agents` 插件配置设置 `daemonIdleMs`（100–86400000 毫秒）。已有进程启动时的配置与新客户端不同，且仍有任务执行时，会返回 `DAEMON_CONFIG_CHANGED`；任务结束后，下一次派发自动替换空闲后台。更改插件配置不会静默终止正在运行的代理。

MCP 退出只关闭客户端；明确停用代理插件、暂停访问或撤销相关访问范围，由宿主调用 `agents.manager.cancelOwner()` 回收相应任务。CLI 使用 `local-console` 所有者，远程所有者撤销不会顺带取消本机直接发起的任务。

## 本机通信与文件

每个 `stateDir` 只使用一个后台。macOS/Linux 通过私有 Unix socket 通信；路径较长时自动使用系统临时目录中的独立私有短路径。Windows 使用 `\\.\pipe\capyra-agentd-<state-hash>` named pipe；该接口不绑定 TCP，也不经过 HTTP 代理或 VPN 路由。

状态在 `.capyra/agentd/`：

| 文件或目录 | 用途 |
| --- | --- |
| `secret` | 本机 IPC 签名密钥 |
| `lock` | 拥有者 PID 和实例 nonce |
| `socket` | 默认 Unix socket；长路径时自动使用私有短路径 |
| `events.log` | 有界生命周期日志；不记录提示词、用户信息、配置或凭据 |
| `runtime/process-sessions/` | 由后台拥有的提供者进程记录与输出 |

逻辑代理记录保存在 `.capyra/agent-sessions/`，插件扩展仍使用 `.capyra/extensions/`。独立的进程记录目录避免 MCP 重启时误判正在执行的代理进程。临时 bootstrap 文件以独占 0600 文件写入，子进程读取后删除；密钥不放入 argv。

macOS/Linux 的状态目录为 0700，凭据、锁、日志和 socket 为 0600。读取凭据时检查普通文件、所有者、权限和链接，拒绝符号链接或宽松权限。请求签名绑定具体操作、参数、owner、workspace、有效期和后台实例；修改 owner/workspace、重放请求或拿旧实例请求访问新后台均被拒绝。IPC 只信任能读取这些本机私有文件的宿主，不能作为网络接口直接转发给 MCP 调用者。共享同一个操作系统账号不构成不同的安全主体。

Windows named pipe 路径已有平台分支与结构测试，但本次在 macOS 完成实机验收，Windows 原生进程生命周期和 NTFS ACL 尚未实机验证；POSIX 的 0600 数值不等同于 Windows ACL。Windows 部署应使用仅当前 Windows 用户可访问的状态目录，并完成本机 ACL 验收后再开放远程工作流。

## 验收证据

`tests/daemon.test.ts` 使用本机 Node 命令提供者，不调用付费模型。20 项集成测试覆盖：只读查询不启动；并发客户端共享后台；三个独立 CLI 竞争启动；IPC owner/workspace 防伪、过期和重放拒绝；独立 CLI 退出后任务继续；MCP 客户端替换；原生 session 继续；活跃配置变更拒绝；强制停止；空闲回收；实际 SIGKILL 后恢复；深层路径；私有文件和符号链接防护；CLI 全流程；原始进程输出的归属校验与离线读取；权限模式、托管工作流、审批目标指纹和后台发布竞争。

```sh
npm run build
node --import tsx --test tests/daemon.test.ts
```

本机测试需要允许监听 Unix socket 或 Windows named pipe；受限沙箱的 `listen EPERM` 属于运行条件错误。固定测试使用本机 Node fixture，不调用付费模型。正式提供者的登录、额度、模型选择、权限映射和平台可用性应分别检查，不能由协议 fixture 代替。

`tests/agent-real-e2e.test.ts` 与 `tests/agent-real-lifecycle.test.ts` 默认跳过。只有维护者明确设置对应环境变量时，它们才使用已经登录的真实提供者并可能消耗额度。运行前应使用合成工作区、选择当前账号实际可用的模型，并确认读写与网络权限符合测试目标。
