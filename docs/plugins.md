# Capyra 插件开发

Capyra 的原生插件是可信的本机 ESM 模块，默认导出一个 `apiVersion: 1` 的插件对象。文件、终端、Git、代理、访问策略、存储、MCP、连接和界面都使用这个契约。宿主负责工具注册、权限、任务状态和生命周期；插件提供具体能力。

## 让 ChatGPT 直接开发插件

连接 Capyra 后，可以在当前 ChatGPT 对话中直接提出需求，例如：

> 为 Capyra 创建一个论文整理插件：扫描当前工作区的 PDF，按年份和主题生成 Markdown 索引。先创建草稿并实现，预检通过后告诉我需要哪些权限；暂时不要启用。

内置 `plugin-dev` 向 ChatGPT 提供四个工具：读取机器契约、创建项目、隔离预检、安装已验证项目。ChatGPT 可以继续调用工作区读取、写入和编辑工具完成代码，不需要另开编码代理；代理只在用户主动选择或任务明显适合并行时使用。

标准流程是：

1. `plugin-dev__spec` 读取当前宿主实际支持的契约。
2. `plugin-dev__create` 在当前工作区生成 manifest、零依赖入口、`AGENTS.md`、说明和开发任务。
3. ChatGPT 直接编辑草稿，并用 `plugin-dev__validate` 反复修正结构化诊断。
4. 用户要求安装后，ChatGPT 调用 `plugin-dev__install`。安装项初始禁用，权限只保存用户明确选择的最小集合。
5. 用户检查配置和权限后启用插件。修改已加载模块源码后重启 Capyra。

控制台“插件组合 → 用 AI 创建插件”提供相同流程，并允许把开发任务交给可选编码代理。CLI 等价命令：

```sh
capyra plugin create paper-organizer \
  --title "论文整理助手" \
  --prompt "扫描当前工作区的 PDF，按年份和主题生成 Markdown 索引"
capyra plugin spec --json
capyra plugin validate ./capyra-plugins/paper-organizer --json
capyra plugin install ./capyra-plugins/paper-organizer
capyra plugin inspect paper-organizer --json
```

`capyra.plugin.json` 是项目的机器清单。`id`、版本、标题、说明、权限和依赖必须与入口默认导出一致；`configSchema` 描述本机配置；可选的 `ai.brief` 保存需求说明。清单不保存 grants 或凭据。公开 JSON Schema 位于包内 `schemas/capyra-plugin.schema.json`，开发工具也可从 `capyra/plugin-devkit` 导入脚手架、规范和校验器。

预检先验证目录、manifest、入口边界和配置 schema，再在有时间与输出上限的子进程中导入模块，但不会调用 `setup`。诊断包含稳定的 `code`、文件与 JSON Pointer，方便 ChatGPT 精确修复。启用时宿主会重新校验 manifest 和实际配置，避免预检后被替换的无效项目进入宿主进程。

## 先运行一个外部插件

仓库随附四个可直接加载的实现：

| 模块 | 能力 | 额外 npm 依赖 |
|---|---|---|
| [word-count.mjs](../examples/word-count.mjs) | 注册可调用的文字统计工具 | 无 |
| [sqlite-storage.mjs](../examples/sqlite-storage.mjs) | 用 Node 内置 SQLite 替换任务存储，迁入旧 JSON 任务 | 无 |
| [alternate-ui/plugin.mjs](../examples/alternate-ui/plugin.mjs) | 用独立只读任务/指标页面替换默认 UI | 无 |
| [strict-policy.mjs](../examples/strict-policy.mjs) | 用 effect 和工具白名单进一步限制执行 | 无 |

将模块放进自己维护的目录。添加插件可用本机工作台的插件入口，或执行：

```sh
capyra plugin add /absolute/path/word-count.mjs --id word-count
capyra plugin enable word-count
capyra start --open
```

CLI 修改下次启动使用的配置；运行期间的启停和配置修改使用本机工作台。添加的插件初始禁用，启用前确认模块来源、配置和 grants。模块不需要发布到 npm，也不需要修改 Capyra 源码。

## 模块与工具契约

```js
export default {
  apiVersion: 1,
  id: 'greeting',
  version: '1.0.0',
  title: '问候',
  description: '按输入生成一句问候语。',
  permissions: [],
  setup(ctx) {
    ctx.registerTool({
      name: 'hello',
      title: '生成问候',
      description: 'Greet the supplied name.',
      effect: 'read',
      permissions: [],
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', maxLength: 120 } },
        required: ['name'],
        additionalProperties: false,
      },
      async execute({ name }, execution) {
        execution.signal.throwIfAborted();
        return { content: [{ type: 'text', text: `你好，${name}！` }] };
      },
    });
  },
};
```

配置条目：

```json
{
  "id": "greeting",
  "module": "./plugins/greeting.mjs",
  "enabled": true,
  "grants": [],
  "config": {}
}
```

公开工具名为 `greeting__hello`。配置中的模块路径相对配置文件解析；本机安装接口接收绝对路径。`id` 必须与模块导出一致，内置模块可写成 `module: "builtin:workspace"`。

TypeScript 可从 `capyra` 导入 `CapyraPlugin`、`PluginContext`、`ToolDefinition`、`ToolContext`、`TaskRecord`、`RuntimeEvent`、`TaskStore`、`ExecutionPolicy` 等类型，以及 `definePlugin`、`textResult` 两个辅助函数。纯 JavaScript 插件可直接使用对象契约。

| PluginContext API | 用途 |
|---|---|
| `registerTool(definition)` | 注册工具并返回注销函数；注销函数只回收该次注册 |
| `provide(name, service)` | 提供全局唯一的服务；同名冲突使加载失败 |
| `service(name)` | 获取已启用服务；不存在或 context 已撤销时抛错 |
| `guard(check)` | 返回拒绝原因或 `undefined`，只能进一步限制调用 |
| `onEvent(listener)` | 监听运行事件；宿主在停用时注销监听器 |
| `onDispose(fn)` | 注册同步或异步资源释放函数 |
| `workspace` | 启动配置的工作区，用于初始化 |
| `stateDir` | 宿主私有状态目录，用于插件记录 |
| `config` | 当前插件的配置快照 |

工具的 `execution` 包含 `workspace`、`owner`、`taskId`、`signal`、`progress(message)`。`execution.workspace` 固定在请求创建时，后续切换项目不会改变待批准任务的目标目录。文件与项目操作应使用它，不要把初始化时的 `ctx.workspace` 当成所有后续任务的目录。

工具所需权限必须同时出现在插件 `permissions` 和配置 `grants` 中。缺少 grant 的工具不暴露，允许同一插件配置为只读模式。JSON Schema 默认使用 2020-12；显式 draft-07 也支持；不接受异步 schema 校验。

`preview(args, execution)` 可返回 `{ title, description, before?, after? }`。预览必须只读并传播取消信号。远程请求创建时不会读取敏感预览，本机打开详情或批准时才准备预览。输入校验后冻结；旧任务不能在插件重新加载后调用新一代工具实现。

返回标准 MCP `CallToolResult`。`isError: true` 会记为失败。输入和结果各限制为 **2,000,000 字节的编码后 JSON**；二进制 base64 开销也计入。较大的结果应分页或提供本机工件引用。审批有效期 10 分钟；读取任务可并行，写入与执行任务形成执行屏障。

远程读取、搜索、历史和结果查询同样需要本机批准。外部策略允许某项操作，只代表没有新增拒绝理由；身份范围、本机逐请求批准、暂停状态仍然分别生效。结果可选择仅本机可见。

## 依赖、配置和资源释放

`requires: ['provider-id']` 声明插件 ID 依赖。依赖必须已配置且启用，宿主会先加载提供者。停用提供者前需先停用消费者；关机按实际激活顺序逆序释放。

普通业务插件的配置更改会先停止该插件，再用新配置调用 `setup`；激活成功后才持久化，新配置失败则恢复旧配置、grants 和服务。更改通过同一队列串行执行。通过本机控制台完成的安装、grants、启停和配置更改会原子写回配置文件，并保留未知的用户配置字段。启停只重建生命周期；Node ESM 会缓存已导入代码，修改模块源码后应重启宿主，或使用新的版本路径。

实际 CLI 的 MCP、控制台及本次选定的入口服务提供插件会标记 `restartRequired`，在线启停或配置在产生副作用前拒绝。界面显示 `restartReason` 中针对当前配置和启动参数的离线修改与重启命令，避免状态显示已启用但端口没有重新监听。未绑定 CLI 入口的 SDK Runtime 仍可热卸载这些插件，普通业务插件也继续支持热配置。

宿主会取消该插件的未完成任务，等待执行和预览退出，然后撤销工具、服务、guard 和事件监听。撤销后的旧 context 不能再次注册工具、提供服务或查找宿主服务。**已交给其他代码的普通 JavaScript 对象不会自动变成不可用**：有进程、连接或定时器的服务，应在自己的 `onDispose` 中关闭它们，并让旧方法检查已关闭状态。

```js
setup(ctx) {
  const lifetime = new AbortController();
  let closed = false;
  ctx.provide('example.worker', {
    async run(input) {
      if (closed) throw new Error('Worker has stopped');
      return performWork(input, { signal: lifetime.signal });
    },
  });
  ctx.onDispose(async () => {
    closed = true;
    lifetime.abort();
    await stopAndJoinAllOwnedProcesses();
  });
}
```

释放函数按注册顺序逆序执行。宿主继续回收其他资源，即使某个释放函数抛错；插件应记录能够定位自身退出故障的状态。协作式取消无法强杀同进程中不合作的 JavaScript，工具 Promise 必须在所拥有的工作实际结束后才完成。

## 可替换的服务

| 服务 | 提供者与用途 |
|---|---|
| `host.runtime` | 宿主 Runtime，供可信基础设施插件读取状态、调用宿主接口 |
| `host.store` | 本次运行选定的 TaskStore；所有任务恢复和记录使用它 |
| `storage` | 默认存储插件或替代存储插件提供的存储服务 |
| `execution.policy` | `check(tool, args, { owner, workspace })` 返回拒绝原因或 `undefined`，支持 Promise |
| `ui` | `{ assetsRoot: URL \| string }`，为现有本机 console transport 提供页面 |
| `console.transport` | 本机管理 HTTP transport；默认 UI 与替代 UI 共用它 |
| `mcp.transport` | MCP HTTP/stdio 入口及其连接生命周期 |
| `mcp.extensions` | 客户端资源、卡片等 MCP 扩展注册 |
| `presentation` | `render(task)` 生成本机结果视图 |
| `projects` | 本机项目注册、选择及查询 |
| `process.sessions` | 持久终端和进程会话 |
| `agents.manager` | 编码代理目录、会话与派发 |
| `git` / `skills` | Git 审阅快照、工作区规则和技能读取 |

业务服务属于各提供者的公开 TypeScript 契约。消费必需服务时声明对提供者的依赖；可选服务可捕获 `ctx.service()` 的缺失错误并降低功能。替代提供者可以沿用相同服务名，必须先停用原提供者，避免出现两个同名服务。

## 用 SQLite 替换默认存储

存储要在恢复任务之前装配，因此插件额外提供同步工厂：

```ts
createStore(stateDir: string, config: Record<string, unknown>): TaskStore
```

`TaskStore` 实现 `load(): TaskRecord[]`、`save(task): void`、`remove(id): void`、`event(event): void` 和可选的 `close(): void | Promise<void>`。宿主先调用工厂并恢复记录，再调用普通 `setup`。关机顺序为取消和等待任务、释放插件、记录停止事件、关闭 TaskStore。构造或恢复失败时，工厂创建的 store 也会关闭。

将 SQLite 示例复制到 `plugins/sqlite-storage.mjs`，把以下更改合入现有配置，保留其他插件条目：

```json
{
  "storagePlugin": "sqlite-storage",
  "plugins": [
    { "id": "storage", "enabled": false, "grants": [] },
    {
      "id": "sqlite-storage",
      "module": "./plugins/sqlite-storage.mjs",
      "enabled": true,
      "grants": [],
      "config": {
        "filename": "tasks.sqlite",
        "auditLimit": 5000,
        "importJsonTasks": true
      }
    }
  ]
}
```

选定的存储不能在运行期间停用或热替换；先停止服务、调整配置，再启动。示例使用 Node ≥22.16 的内置 `node:sqlite`，没有独立守护进程或 npm 数据库依赖；只有启用并选择它时才加载模块、打开数据库。

`filename` 是私有状态目录中的普通 `.sqlite` 文件名。`auditLimit` 限制审计行数，范围 100–100000，默认 5000。`importJsonTasks` 默认 `true`：首次发现原生 JSON task 目录时，以一次事务迁入有效记录，保留原 JSON 文件；以后不会用旧 JSON 覆盖 SQLite 的新记录。原 JSON 审计日志也保留。单条任务记录最多 5 MB，与默认存储一致。

重启会恢复历史结果，并将上次未完成的任务标为 `interrupted`；不会自动重放操作。恢复到 JSON 存储时，旧 JSON 文件仍可使用，但 SQLite 阶段产生的新任务不会自动反向写入 JSON。切换前应先保留当前数据库与原记录的备份。

## 用独立页面替换 UI

复制整个 [alternate-ui](../examples/alternate-ui/) 目录，合入配置：

```json
{
  "plugins": [
    { "id": "ui", "enabled": false, "grants": [] },
    { "id": "console", "enabled": true, "grants": [] },
    {
      "id": "alternate-ui",
      "module": "./plugins/alternate-ui/plugin.mjs",
      "enabled": true,
      "grants": []
    }
  ]
}
```

示例实际提供自己的 HTML、CSS 和 JavaScript，展示运行指标、任务状态与按需详情。现有 console transport 继续运行，HTTP 地址和本机登录会话不变。当前静态契约提供 `/`、`/app.js`、`/style.css` 三个资源；将其他前端代码打包进这三个资源。

界面必须遵守控制台认证流程：

1. 读取启动链接 fragment 中的 `bootstrap` 随机数，并立即从浏览器地址中移除。
2. 同源 `POST /api/bootstrap`，请求头带 `X-Capyra-Local: 1` 和 JSON Content-Type。
3. 浏览器保存宿主设置的 HttpOnly、SameSite=Strict cookie；后续请求使用同源 credentials 和 `X-Capyra-Local`。
4. 使用 `GET /api/state` 读取摘要，`GET /api/tasks/:id` 按需读取详情。失效时提示用户从 Capyra 启动器重新打开。

随机数只使用一次，不应保存进 localStorage、日志或页面正文。示例只调用认证和读取接口；不会批准、取消、执行或改配置。工作区路径、错误及任务内容使用 `textContent` 渲染，避免将模型或文件内容作为 HTML 执行。CSP 禁止远程脚本和第三方连接。

## 用外部策略进一步收紧能力

停用内置 `policy`，启用严格策略示例：

```json
{
  "plugins": [
    { "id": "policy", "enabled": false, "grants": [] },
    {
      "id": "strict-policy",
      "module": "./plugins/strict-policy.mjs",
      "enabled": true,
      "grants": [],
      "config": {
        "deniedEffects": ["write", "execute"],
        "allowedTools": ["workspace__list", "workspace__read"]
      }
    }
  ]
}
```

默认拒绝 `write`、`execute`。`allowedTools` 省略时不额外限制工具名，空数组表示拒绝全部工具。配置中的工具名使用 `插件ID__工具名`。策略不添加工具上下文或常驻进程。

策略会在请求准入和执行前检查，配置收紧后，已经等待批准的操作也不能绕过新规则。把 `deniedEffects` 调整为空数组只会移除这个示例增加的 effect 限制；写操作仍需宿主本机批准，远程请求仍受设备身份和逐请求同意约束。

## 接入外部 MCP

每个上游配置为独立插件 ID，`module: "mcp"`，grant 为 `mcp:call`。适配器支持 stdio、Streamable HTTP 和 SSE，配置工具白名单、显式只读工具、超时及重连次数。stdio 仅继承基础运行环境，其他变量必须显式配置；HTTP/SSE 禁止重定向带走凭据。上游状态可通过该实例的 `<id>.status` 服务查看。

只有 `readOnlyTools` 中显式声明的工具才归类为 read；其余上游调用需要执行批准。MCP annotations 作为元数据保留，不构成授权证据。目录分页和 tools/list_changed 通知经过验证后更新；坏目录不会替换上一代。连接可以恢复，但失败的调用不自动重放。

成功结果保留上游 content、structuredContent、isError 及元信息。任务可能先返回“待确认”，因此直接曝光时不把上游 output schema 误报为每次调用的返回形状；精简发现目录提供 `sourceOutputSchema`。

## 验收与信任边界

[plugin-composition.test.ts](../tests/plugin-composition.test.ts) 通过实际 ESM 模块加载验证：

- 从 JSON 存储产生真实任务，再切换 SQLite，迁入旧任务、执行新任务、重启读取结果并关闭句柄。
- 在同一个实际 HTTP listener 上替换 UI 的 HTML/JS/CSS，完成一次性 bootstrap 和带 cookie 的任务/指标读取。
- 停用 console transport 后，HTTP listener 关闭，旧 transport 引用不能再启动服务。
- 替代策略确实阻止原本可提交的请求；配置更改持久化，重启后继续生效。
- 插件重载会释放监听和服务；旧 context 无法再次注册资源。
- Runtime 构造失败会关闭已经打开的外部数据库。

运行：

```sh
npm run build
node --import tsx --test tests/plugin-composition.test.ts
```

HTTP 测试需要允许绑定临时 `127.0.0.1` 端口；测试结束会停止 listener、关闭数据库并删除临时目录。

原生插件能导入 Node 文件、进程和网络 API；grants 是宿主管理调用的约束，不是第三方 JavaScript 沙箱。`host.runtime` 与 `host.store` 是给可信基础设施插件的高权限服务。请加载经过审阅的模块，并为插件的子进程、远端服务和配置凭据保留相应信任边界。
