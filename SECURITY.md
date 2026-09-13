# Security Policy

## Supported versions

Capyra 仍处于 0.x 阶段。安全修复只保证进入最新发布版本，请先在当前 `main` 或最新版本确认问题仍然存在。

## Reporting a vulnerability

请使用 GitHub 仓库的 **Security → Report a vulnerability** 私密报告入口。不要为尚未修复的安全问题创建公开 Issue。

报告中请提供受影响的版本、平台和连接方式，最小复现步骤与预期/实际结果，可能泄露或越权的数据范围，以及已知的缓解方式。

请删除令牌、私钥、OAuth code、真实设备 URL、用户文件内容和其他凭据。若必须提供敏感样本，请先说明，等待维护者给出安全传输方式。

## Security boundaries

- Capyra 以当前操作系统用户权限运行，不是系统级沙箱。
- MCP/OAuth 连接、Capyra 身份、设备绑定和具体请求批准分别生效。
- 本机批准入口不会通过 MCP 暴露。
- 自动批准适合只有可信操作者的客户端；共享账号应使用逐次确认。
- 原生插件与编码代理属于本机受信代码，安装前应检查来源和声明权限。
- 已发送到外部客户端的内容无法由 Capyra 再次收回或隐藏。

更多实现细节见 [`docs/security-review.md`](docs/security-review.md)。
