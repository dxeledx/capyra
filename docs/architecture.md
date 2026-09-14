# Architecture

Capyra 把本机能力拆成一个小型运行时和一组插件。运行时负责插件生命周期、工具注册、任务状态、批准、取消、持久化与服务依赖；文件、终端、Git、编码代理、连接和界面由插件提供。

## Runtime

`src/core/runtime.ts` 维护工具目录和 JSON Schema 校验器、插件依赖与释放回调、带 owner/workspace 的任务、并发队列、取消信号、批准状态和可替换服务。

任务创建时冻结工具定义、参数与工作区。插件停用、批准策略变化、暂停或调用者撤销不会让已经取得的旧引用继续执行。

## Transport separation

`src/transport/mcp.ts` 提供 stdio 与 Streamable HTTP MCP，支持 OAuth、现代按请求元数据和旧式会话。`src/transport/control.ts` 是独立的本机管理服务：

- MCP 默认监听 `127.0.0.1:4317`。
- 管理工作台默认监听 `127.0.0.1:4318`。
- 公网连接只能指向 MCP 端口。
- 管理变更需要一次性本机入口、HttpOnly 会话、正确 Host、同源 Origin 和本机请求标记。

ChatGPT 的 `openai/session` 只经过 owner 隔离哈希后用于恢复对话工作区，不作为调用者身份或授权证明。

每次 OAuth 连接有独立 grant。连接备注由本机用户填写；客户端名称来自 OAuth 客户端元数据，二者都不冒充 ChatGPT 登录账号。grant 保存创建时间、最近使用、请求计数和暂停状态；单条暂停会使对应 token 验证失败并中断该 owner 的活请求，恢复不会扩大原有范围，撤销则删除 token 与 grant。

## Plugin contract

插件 API v1 包含元数据、权限、依赖和 `setup(context)`。插件可以注册工具、提供或消费命名服务、增加项目指令、注册守卫和释放函数，也可以替换任务存储。

目录插件使用 `capyra.plugin.json` 声明入口、配置 schema、权限与 AI 开发需求。安装先在隔离子进程中导入并检查入口，实际启用仍由本机用户决定。

## Workspace model

项目插件保存注册目录和当前本机默认项目。现代 ChatGPT 对话按哈希后的 `openai/session` 绑定项目，传统 MCP 连接在初始化时冻结项目；同一对话可以显式切换。每个任务再次保存规范化工作区路径，因此后续本机切换不会移动已经创建的任务。

工作区工具使用统一的路径解析边界，拒绝穿越、受保护名称和链接别名。命令、Git 与代理会话也同时绑定 owner 和 workspace。

## Optional services

- `cloud/`：独立账号、设备配对、范围和 Named Tunnel provisioning 服务。
- `sites-relay/`：设备主动轮询的固定 HTTPS Relay；不保存工作区数据。
- `examples/`：外部存储、策略、工具和 UI 插件。

两项云服务均为可选。完全本机的 stdio 使用不需要它们；Quick Tunnel 也不需要账号服务。
