# 客户端工作卡

`client-ui` 插件提供工作区卡和冻结变更审阅卡。支持 MCP Apps 的客户端可以在对话里展开文件差异、按文件名筛选，并请求重新读取历史快照。普通 MCP 客户端可以读取同一份完整 JSON 文本结果。

## 启用与使用

插件需要 `mcp`、`git`、`projects`、`skills`，权限为 `workspace:read`、`git:read`、`projects:read`、`skills:read`。Git、项目注册和规则发现继续由各自服务实现，客户端卡不直接读取审阅目录。

| 工具 | 行为 |
| --- | --- |
| `client-ui__workspace` | 显示此次获准请求所属的项目目录、分支、版本、变化数量、规则和 Skills 目录；首次打开保存审阅基线，重复打开保留它 |
| `client-ui__changes` | 比较打开工作区时或上次展示后的完整工作树变化，保存快照并推进下次比较基线，返回 `workspaceId` 和 `reviewRef` |
| `client-ui__review` | 按工作区标识和审阅引用读取原有冻结快照，不恢复或改写工作区文件 |

默认比较 `since: "last_shown"`；`since: "workspace_open"` 比较最初打开时的状态。快照涵盖暂存、未暂存和未跟踪文件的最终工作树状态，包括新增、删除、重命名与二进制变化。如果未先调用 workspace，第一次 changes 会建立当前基线，并明确返回 `baselineCreated: true`。`staged: true` 保留独立的暂存区审阅入口，不推进工作区基线，也不能与 since 同时使用。

Git 插件同时提供不依赖客户端卡片的 `git__review_open`、`git__review_changes`、`git__review_read` 工具。旧的 `git__review_save` 继续保存单次 staged / unstaged 差异。

## 完整工作区快照

Git 服务列举 tracked 与未被忽略的 untracked 路径，沿用工作区保护规则逐文件读取。读取后的字节写入私有临时副本，再由 `hash-object --no-filters` 批量散列；临时 Git index 只接收这些已验证的对象。每个 owner + workspace 的对象存入 Capyra 状态目录内独立的私有 bare Git 库。新快照不向源仓库写入对象或引用，不修改用户 index、HEAD、文件或暂存选择，也不运行 clean/smudge、diff/textconv、hooks 或 GPG。普通 `git__show` / `git__restore` / 历史 `git__diff` 只接受源仓库的 commit 对象；私有快照不能通过普通历史工具读取，也不会进入源仓库 `git push --mirror`。

每个 owner + workspace 有独立持久化的 open / last 检查点与私有 Git tree refs。每次新审阅保留 before / after refs 和不可变 JSON 记录；只有记录保存后才推进 last。并发审阅按相同 owner + workspace 串行化；私有库初始化也共享同一初始化 Promise。已有 reviewRef 的重读只读取原记录，不调用现时 diff，也不改变检查点。对于早期已有完整 manifest 的版本，仅迁移归属和对象 ID 可核实的精确源引用；确认私有库中对象一致后移除对应源引用，保留历史 JSON。

二进制文件写入私有 Git 对象以比较版本，仅将变化标记返回客户端。超过单文件 1 MiB、不可读或不支持的路径会出现在 `skipped` 中；旧文本变成超限文件时报告内容不可用，不伪装成删除。原基线文件仍存在但后来被忽略或排除时，显示 `excluded` 并抑制旧内容的删除 patch。每次捕获最多 20000 路径、64 MiB 可读字节，审阅最多 5000 个变化条目，文本差异显示上限 128 KiB，检查点元数据限 120 KiB，结构化审阅记录限 240 KiB；达到内容上限会截断或明确拒绝，避免把未交付的过大结果推进为已展示基线。

服务重启复用已有检查点。manifest 是持久化提交点：对象仍存在时，丢失或因中断而超前/滞后的引用会按 manifest 的准确对象 ID 修复，恢复过程不读取现时文件重造历史。初始 manifest 先于引用写入保存，因此初次打开中断也能重试。对象真实丢失、manifest 损坏或旧版仅留引用而丢失 manifest 时，后续变化比较会明确拒绝，保留原始记录供本机排查。已经保存的审阅 JSON 仍可按原 owner + workspace 和新审批读取。

默认 compact MCP 目录的 4 个通用入口、3 个内置展示工具和原生文件入站工具，共 8 个固定定义，在身份有效时即可返回。内置工具以 `publicCatalog: true` 明确声明整个描述符只包含固定产品信息，不能包含工作区、规则、Skills 或配置值。该声明只免去目录确认，实际调用、动态能力发现和历史读取仍逐项确认。外部或替换工具仅有 Apps / `openai/fileParams` 元数据不获得公开性，未声明的原生描述符仍需独立本机确认；direct 完整目录也继续确认。其余普通工具通过能力发现与 `capyra_call` 使用。

客户端支持 Apps 是展示条件。卡片加载失败时，可使用原工具的 `content` / `structuredContent`；不需要从卡片复制数据后再次提供给服务端。

## 资源和桥接

通用模板 URI 为 `ui://capyra/workspace-v2.html`，MIME 为 `text/html;profile=mcp-app`。工具描述使用标准 `_meta.ui.resourceUri`、`ui.visibility`，并提供 `openai/outputTemplate`、`openai/widgetAccessible` 兼容字段。[OpenAI 元数据参考](https://developers.openai.com/plugins/reference)规定了这些字段及结构化结果的作用。

界面通过 `ui/initialize`、`ui/notifications/tool-result` 和 `tools/call` 与宿主交换消息；保留 `window.openai.toolOutput` / `openai:set_globals` 的历史恢复兼容入口。仅接受父窗口的 JSON-RPC 消息，旧读取的延迟回复不会覆盖较新的卡片。关闭卡片会释放监听器和等待中的请求。[OpenAI UI 文档](https://developers.openai.com/plugins/build/chatgpt-ui)将此桥接作为可移植的 MCP Apps 接入方式。

HTML 内联样式和脚本，无字体、图像、网络请求或外部脚本依赖。资源元数据的 `connectDomains`、`resourceDomains`、`frameDomains` 均为空，由宿主构造并执行 CSP；HTML 不再叠加第二层 meta CSP，以免阻断宿主注入的桥接运行时。所有文件名与差异都通过 `textContent` 插入。折叠文件的差异节点按需创建，单文件卡片最多显示 10000 行、列表最多显示 500 个文件，达到上限时提示查看完整工具文本。

v2 是一次受控兼容修订：真实请求已返回 v1 模板与 HTTP 200，但 ChatGPT 仍显示模板加载失败；重复 meta CSP 是待验证的兼容风险，尚未确定为根因。本次只移除该重复策略，保留宿主资源 CSP、MIME、认证和数据审批。依据[官方 URI 缓存规则](https://developers.openai.com/plugins/build/chatgpt-ui#embed-the-component-in-the-server-response)，修订使用新 URI；对比验收需刷新工具目录并发起引用 v2 的新调用，旧消息中的 v1 引用不能证明新版本结果。

模板本身不包含项目名、文件内容、审阅记录或本机控制地址。它只能展示宿主已收到的数据。已经返回共享 ChatGPT 聊天的内容，会受该共享账号的聊天可见性影响；`_meta` 不是账号内部保密边界。

## 历史读取与授权

工作区标识由任务实际绑定的工作区路径计算，不能用于切换工作区。服务从可信 `ToolContext` 取得 `owner`、`workspace`、取消信号；工具参数不接受调用者身份。`review` 先核对当前工作区标识，再使用 Git 服务的 `reviewRead` 检查原始快照的调用者和工作区。

资源目录、动态资源读取和工具调用分别走 MCP transport 的本机逐请求审批。唯一无需再次点击确认的是插件安装时显式注册的不可变公开 UI 外壳：读取精确模板 URI 时，transport 在现有 OAuth、身份、暂停和撤销检查后返回冻结的 HTML/元数据副本，不调用动态 provider，也不读取工作区。它只包含产品静态界面；相同 MIME、URI 前缀或客户端自报字段不会获得此待遇。

卡片上的“重新读取此快照”只发起工具请求，不批准请求。没有后台自动历史读取，也没有本机管理、暂停、授权或批准按钮。工作区数据和历史依然需要各自批准；选择“仅本机”时，MCP transport 不返回卡片数据，图形卡不能绕开该选择。

## 扩展注册表

MCP 插件提供 `mcp.extensions` 服务，业务插件通过 `register(id, provider)` 组合目录，获得独立注销函数。类型和实现位于 `src/client-ui/extensions.ts`。

插件可以在第三个参数的 `publicUiTemplates` 数组中显式提供静态 UI 外壳。每项只接受 `uri`、固定的 `text/html;profile=mcp-app` MIME、HTML `text` 和可选 `_meta`，每个 provider 最多 16 项、每项最多 256 KiB。注册时复制并深冻结全部 JSON 值；之后改写原始对象不会改变公开资源。模板必须属于同一 provider，且与已有静态或动态资源认领没有冲突；失败注册不会留下一部分公开模板。动态 provider 的资源内容不得放入此选项。

```ts
const dispose = ctx.service<McpExtensionRegistry>('mcp.extensions').register('my-plugin', {
  capabilities: { resources: {} },
  owns: (method, params) => method === 'resources/read' && params.uri === 'ui://my-plugin/card.html',
  async handle(method, params, { owner, signal }) {
    signal.throwIfAborted();
    if (method === 'resources/list') return { resources: [descriptor] };
    if (method === 'resources/templates/list') return { resourceTemplates: [] };
    return { contents: [resource] };
  },
}, {
  // 仅含安装时已知的产品 HTML/元数据；不放入项目、文件或历史数据。
  publicUiTemplates: [{ uri: 'ui://my-plugin/card.html', mimeType: 'text/html;profile=mcp-app', text: staticHtml, _meta: staticResourceMeta }],
});
ctx.onDispose(dispose);
```

目录方法聚合所有适用 provider，处理上游分页，并拒绝重复 URI、提示名称、循环游标、超过 100 页或总计 1000 条结果。资源读取和提示获取要求恰好一个 provider 精确认领；未知和冲突目标均拒绝。调用过程中 provider 被卸载则丢弃其结果；公开模板同样在返回前核对原注册仍然有效。卸载客户端卡同时撤回其静态模板、工具和动态资源，不影响其他 provider；所有 provider 卸载后注册表能力为空。

扩展服务是供已审阅的本机插件使用的内部组合接口，不能自行证明远程请求已经获准。外部请求必须从 MCP transport 进入。动态启停后，已初始化客户端可能需要刷新目录或重新连接，才能更新初始化时缓存的能力声明。

## 模板加载诊断

需要区分模板请求没有到达、入口拒绝或已返回给传输层时，可在启动 CLI 时显式设置 `CAPYRA_TEMPLATE_DIAGNOSTICS=1`。默认关闭；启用后向 stderr 写 `type: "capyra.template"` 的模板诊断短 JSON 行。SDK 宿主可直接提供 `McpOptions.onTemplateDiagnostic` 回调。

同一开关也启用 `type: "capyra.mcp"` 的 HTTP 请求阶段记录，供定位工具请求在模板读取前失败的情况；SDK HTTP 宿主对应 `McpOptions.onRequestDiagnostic`。它只记录随机 `requestId`、固定分类 `initialize/tools_list/tools_call/resources_read/other`、阶段、固定拒绝原因与可用的 HTTP 状态，不记录具体工具名、参数、URL、调用者或请求头。无版本/会话的请求可见 `initialize_required`，现代协议不匹配可见 `invalid_metadata/header_mismatch`，无效 JSON 可见 `invalid_json`；这些是定位信息，不改变请求处理结果。

诊断只匹配当时精确注册的公共静态模板 `resources/read`，包含新生成的 `requestId`、`received/auth/protocol/returned/closed` 阶段、固定原因码、可用时的 HTTP 状态，以及 HTML 的 UTF-8 字节数与 SHA-256。它不记录请求头、凭据、调用者、工作区、动态资源 URI、模板正文或原始异常。显式 HTTP 诊断模式在 Host/Origin 检查前使用同样的 1 MiB JSON 上限识别资源，因此可记录资源处理器前的 403 和 OAuth 401；全部权限检查保持有效。默认关闭时中间件顺序保持不变。

`returned/template_returned` 表示服务端已将静态副本交给传输层，`closed/response_finished` 的 HTTP 200 表示本次响应完成，均不能单独证明 ChatGPT 已渲染。若只有 `received` 后紧跟 `auth/unauthorized` 或 `auth/forbidden`，请求尚未进入资源处理器；`protocol/header_mismatch` 等固定码用于定位协议拒绝。排查完成后移除环境开关，下次正常启动不再输出这些诊断。

## 验证记录（2026-09-11）

- `npm run build` 通过。
- 静态模板修正后，`node --import tsx --test tests/client-ui.test.ts tests/transport.test.ts`：**19/19 通过**。真实 MCP SDK + InMemoryTransport 走实际 Runtime、Git 服务、资源读取与本机审批；覆盖 direct/compact、重复静态模板零审批、动态 HTML 拒绝伪造公开性、值冻结、冲突回滚、卸载、身份/暂停/撤销、仅本机、跨调用者、工作区不匹配和冻结历史。
- 补充运行全部 `client-ui*.test.ts` 与 transport，共 **28 项通过**；OAuth 的真实回环 HTTP 专项另 **4/4 通过**，验证现有 OAuth/PKCE、轮换、撤销、前缀代理边界。首次受限环境不允许绑定回环端口，获得本机监听权限后重跑 OAuth 通过。
- `tests/client-ui-review-baseline.test.ts` 用真实临时 Git 仓库验证 first-open / last-shown、多轮与历史读取、暂存与工作树并集、未跟踪文件、目录删除、重命名、二进制和大文件、index 字节保持、owner 隔离、并发、重启和丢失引用。原有 Git 测试同时验证单次审阅和 worktree 操作兼容性。
- Git 与滚动审阅、客户端卡片此前联合运行 **28/28 通过**，包含受管 worktree 登记/归档写盘失败与显式恢复重试；安全回归还涵盖源仓库 mirror、普通历史工具绕读、首次/后续 ref 写入中断、忽略规则改变及旧引用迁移。独立安全复核重复运行原始攻击探针，结果见 [安全复核记录](security-review.md)。
- 桥接自动测试使用受控 DOM 环境检查父窗口消息来源、恶意 HTML 文本、显式点击后的历史请求和过时异步结果；它不是 ChatGPT 宿主测试。
- 独立临时 Chrome 配置中检查桌面卡与展开后的 390px 视口截图。移动视口实测 `innerWidth=390`、`body.scrollWidth=390`、内容宽 362px；长差异在代码区域内横向滚动。临时浏览器进程、配置与截图清理后不进入产品目录。
- 真实 ChatGPT 已显示 8 个工具并成功返回工作区卡数据，但模板曾显示 `Failed to fetch template`；逐次批准模板后仍复现，单一原因尚未确定。本次静态模板修正后的实际渲染仍待重启复验，历史对话恢复与双机共享账号同样未完成。以上 SDK、DOM 与浏览器检查不能记作这些外部验收已完成。

固定参考为 DevSpace `cd84cb23bd6947910e1606f135e230ee5a1a68e7`。已直接检查其 `server.ts` Apps resource 注册、`tool-surfaces/shared.ts` 元数据、`ui/tool-result.ts` 历史引用与 `ui/workspace-app.tsx` 重读桥接；Capyra 使用自身插件服务和内联界面提供同类展示入口。
