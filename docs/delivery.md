# Capyra 0.5.1 使用说明

Capyra 在本机管理工作区、文件、命令、Git 和编码代理。ChatGPT 默认通过 Sites 固定入口连接本机 MCP，OAuth 和任务批准也在本机完成；Quick Tunnel 可作为临时备用。默认无需 Capyra 账号或自建服务器。

## 安装与启动

需要 Node.js 22.16 或更新版本。安装交付包：

```sh
npm install -g /完整路径/capyra-0.5.1.tgz
cd /你的工作区
capyra init
capyra start --open
```

已有配置不要重新 init。升级后先停止旧实例，在配置目录执行：

```sh
capyra local
capyra start --open
```

指定配置时使用 `capyra local --config /完整路径/capyra.json`。迁移保存原配置和旧连接凭据的私有备份，保留工作区、任务和身份历史数据；不请求云端服务。

本机工作台默认地址 `http://127.0.0.1:4318`，`4317` 是 MCP 接口端口。打开已经运行的工作台用 `capyra open`，不用重复 start。直接输入管理地址而出现“需要验证当前浏览器”时，点击页面上的“打开已认证工作台”；如果系统没有自动打开，再在配置文件所在目录运行 `capyra open`。

注册工作区时，从顶部工作区菜单打开“管理工作区”，点击“选择文件夹”，在系统目录面板中选定文件夹，再点击“注册工作区”。选择器会填入真实绝对路径；也可以直接粘贴路径。macOS 使用 Finder 选择面板，Windows 使用系统文件夹对话框，Linux 使用 Zenity 或 KDialog。

ChatGPT 对话在第一次使用 Capyra 时绑定当时的工作区。本机顶部菜单切换工作区后，已经存在的对话继续使用原工作区，新对话使用新的默认工作区；需要改变旧对话时，直接让它使用 `capyra_workspace` 选择，无需 reconnect 或新开对话。

在“更多功能 → 安全与授权”可以管理每条 OAuth 连接：填写个人/工作等本机备注，查看客户端名称、创建时间、最后访问、请求数和到期时间，并单独暂停、恢复或撤销。暂停立即拒绝该连接的新请求并中断其活跃任务；恢复沿用未过期的原授权；撤销后必须重新 OAuth。ChatGPT 不向 MCP 服务提供登录邮箱或 OpenAI 账号 ID，因此备注是区分连接的可靠本机方式，不是平台验证的账号身份。

## 连接 ChatGPT

1. 打开“连接 ChatGPT”，选择工作区与开放能力。
2. 点击“准备并启动连接”，等待页面生成 HTTPS MCP 地址。
3. 在 ChatGPT 添加一个名为 Capyra 的连接，复制该地址，选择 OAuth。
4. 在本机批准首次 OAuth 连接。个人模式下，之后的正常任务自动执行。

默认的 Sites 设备地址固定保存，断开和重启后继续使用原 MCP 地址，不需要重新配置 ChatGPT。Quick Tunnel 仍可作为临时连接，重建后地址可能变化。文件、命令和任务记录都在本机；保持 Capyra 进程运行。

Sites 模式的“连接状态”只显示本机 Capyra、Sites 设备通道、ChatGPT 连接授权和本次启动后的 ChatGPT 工具调用。Cloudflare、公网回访、DNS 与独立 MCP 初始化属于 Quick/Named 的诊断，不再混入 Sites 状态。若前三项正常但 ChatGPT 显示 `disabled`，说明请求没有到达 Capyra；刷新当前对话并重新选择现有 Capyra 连接，无需新开对话或更换 MCP 地址。

工作区和审阅工具默认返回文本与结构化结果，不再要求 ChatGPT 加载 HTML 模板，因此正常使用不会出现 `Failed to fetch template` 卡片。交互卡片实现仍保留为可选能力；只有在 `client-ui` 插件配置中设置 `cards: true` 才关联模板。连接地址与 OAuth 无需重配；升级后在 ChatGPT 的 Capyra 插件详情点击一次 Refresh 更新应用定义。

默认是个人模式：首次 OAuth 连接授权后，正常请求自动执行并将结果返回 ChatGPT。在连接页打开“共享账号保护”后，每次本机访问都需要确认；“更多功能 → 安全与授权”仍可选择结果仅留本机。切换模式会取消尚未开始的旧请求，首次连接授权、暂停和撤销始终有效。账号与设备认证是可选高级插件，默认关闭。

固定入口的 DCR `client_id` 会跨重启长期保留，授权有效期为 30 天；授权到期后 ChatGPT 可以用原客户端身份重新授权，不需要删除并重新添加 Capyra。0.5.1 还会把本机历史 Quick Tunnel 状态中严格匹配 ChatGPT 回调的 DCR 客户端元数据迁移到当前固定 issuer；不会迁移旧 grant、token 或请求。这样可兼容 ChatGPT 自定义应用仍缓存较早 `client_id` 的情况。

Computer Use 的截图与键鼠操作默认跟随这里的批准设置。在“桌面控制 → 配置权限与批准”中可改成每次桌面调用都单独确认；首次准备原生组件无论哪种模式都需要本机确认。0.4.8 曾把当前电脑迁移成强制逐次确认，0.4.9 已恢复为跟随全局设置，避免 ChatGPT 的截图请求在 50 秒审批窗口后被取消。

## 用 ChatGPT 开发插件

连接 Capyra 后，可在当前 ChatGPT 对话中直接提出插件需求。ChatGPT 会读取 `plugin-dev__spec`、创建标准目录、编辑实现并运行隔离预检；编码代理仅在用户选择时使用。预检通过后，安装仍保持禁用，插件权限和启用由用户决定。

也可以在“插件组合”点击“用 AI 创建插件”，或使用：

```sh
capyra plugin create my-plugin --prompt "描述插件需求"
capyra plugin validate ./capyra-plugins/my-plugin --json
capyra plugin install ./capyra-plugins/my-plugin
```

本轮按用户要求只完成改动、构建、打包和配置更新，不运行测试套件或 ChatGPT 联调。
