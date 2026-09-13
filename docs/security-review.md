# 安全与恢复独立复核

日期：2026-09-11。范围：Runtime 准入与插件生命周期、MCP/OAuth/本机控制面、独立账号与设备绑定、工作区归属及相关回归测试。检查使用内存存储、临时目录和本机 HTTP；没有访问真实用户数据、付费模型或真实账号凭据。

## 已验证的保护

- MCP 中同一 OAuth owner 的并发请求各自取得独立审批，不能重复消费另一请求的决定。读取目录、指令、历史结果、资源和提示词需要独立确认。
- 默认只在本机保留结果；即使随后批准一次历史查询，也不会把原先标为本机可见的内容返回客户端。未经授权的错误使用统一消息。
- 历史、目录、资源及结果返回前校验设备和工作区范围；暂停、撤销、请求取消会使等待中的授权代次失效。
- 云端设备管理按账号归属检查；设备运行凭据需证明本机私钥持有权，管理会话不取得其他设备的运行 token。配对及挑战不能重放。
- 设备范围变更和撤销先关闭本机关闸状态；旧网络响应不能跨越变更代次恢复旧范围或已撤销状态。
- 本机控制台独立监听回环端口，检查完整 Host、同源 Origin、自定义请求头和 Fetch Metadata；公开 MCP 路由没有批准管理入口。界面结果通过 DOM 文本节点展示。
- 未完成任务重启后标为中断，不会自动重放；插件依赖按实际激活顺序逆序回收；记录保存失败时暂停执行。

## 本轮发现与修复复核

| 级别 | 具体问题与隔离复现 | 当前状态 |
| --- | --- | --- |
| P1 | 审批前执行文件 preview，使 `workspace__write(expectedMissing:true)` 对存在文件返回 `failed`，不存在文件返回 `cancelled`。真实 SDK MCP、0 次审批复现；同一机制也可判断候选文件哈希是否匹配。 | 已修复。原 SDK 探针复测：0 次审批下，存在与不存在路径均返回 `cancelled`；远程请求先记录输入，仅由本机查看/批准触发敏感预览。 |
| P1 | 配置启用的 identity 加载失败后，缺少 service 被当成无需身份检查；metadata/history/extensions 未校验设备范围。 | Runtime 与 MCP 加入配置失败关闭及访问前后范围校验；相关 transport 回归通过。 |
| P1 | 撤销后旧的异步资源响应、旧设备刷新结果仍可能回写/外发。 | MCP 授权代次与本机 binding generation 已补齐；延迟真实 HTTP 设备响应及资源回调回归通过。 |
| P2 | `await checkAccess` 期间关闭 Runtime，随后继续创建待批任务并调用已释放插件的 preview。 | 已修复。原探针复测：关闭后准入被拒绝，任务数为 0，preview 未在资源释放后调用。 |
| P2 | `preparePreview` 在登记 Promise 之前启动回调；preview 的 progress 事件可重入，造成同一 preview 调用两次。停用插件也曾早于 preview 完成释放资源。 | 已修复。重入探针仅调用一次 preview，停用等待 preview 结束，未访问已释放资源。 |
| P2 | `maxTasks=10` 时并发提交 30 个请求，因容量检查只在异步准入之前，30 个全部进入队列。 | 已修复。原 30 请求探针只接纳 10 个。 |
| P2 | `projects__list` 曾返回当前授权工作区以外所有已注册路径。 | 远程工具已限制为任务捕获的工作区；本机项目管理保留完整目录。 |
| P2 | OAuth 撤销写盘失败会跳过中断回调；在飞行 HTTP 请求没有自身令牌到期截止时间。 | 已修复。撤销中断移至 `finally`，HTTP 请求加入 `expiresAt` 取消计时；最终独立回环到期及写盘失败回归通过。 |
| P2 | MCP 插件未追踪 stdio Server；MCP/console provider 的启动与停用竞态、停用后旧 service 引用仍可创建入口。 | wrapper 已加入启动与 Server 跟踪、关闭标记；Server 清理独立于 transport 连接状态且幂等。未连接、已连接、并发与重复关闭的独立探针均归还全部事件订阅，旧 provider 不能再次启动。 |

## 验证记录

以下现有正式套件在允许回环监听的环境中最终独立执行，39 项全部通过：

```sh
node --import tsx --test tests/access.test.ts tests/transport.test.ts tests/oauth.test.ts tests/identity.test.ts tests/runtime.test.ts tests/lifecycle.test.ts tests/projects.test.ts
```

首次在禁止本机监听的沙箱内运行时，HTTP 与 stdio 启动相关测试报 `listen EPERM 127.0.0.1`；改用允许本机监听的执行环境后全通过。该环境限制不记作产品缺陷。

原始复现脚本通过 Node 标准输入运行，临时目录均在 `finally` 中删除。仅保留本报告及实现 owner 增加的正式回归测试。

## 验收边界

本报告证明源码路径、隔离协议测试和本机 HTTP 的结果。真实 ChatGPT 连接、两台电脑共享同一 ChatGPT 账号、香港公网部署及 VPN/TUN 影响仍需各自的实际验收记录；这些结果不能由 SDK 测试替代。

本机命令和编码代理以用户权限运行。批准任意代码执行意味着该代码具备对应的本机用户能力；回环控制面的浏览器防跨站措施不等同于操作系统沙箱。部署和产品说明应保留这一权限边界。

## 追加：Git 滚动审阅

追加范围仅限 `src/client-ui/review-baseline.ts` 与 Git 的 capture、compare、open、changes、read 路径。修复后新路径的 7 项正式测试独立通过（约 20 秒），未重复运行完整套件：

```sh
node --import tsx --test tests/client-ui-review-baseline.test.ts
```

确认安全读取和内容上限、受保护名称排除、普通软链接与硬链接拒绝、临时独立 index、禁用 Git filters/hooks、旧审阅 owner/workspace 检查及同 owner/workspace 串行化。测试证明原 index 字节、HEAD 和工作区状态不变，临时 index 目录被回收。

本轮发现的三项边界已由实现 owner 修复，并完成独立复核：

| 级别 | 具体复现 | 状态 |
| --- | --- | --- |
| P1 | Alice 的未跟踪文件被首次 open 快照保存；无变化 changes 返回空 diff 和 base tree ID。文件删除后，Bob 使用普通 `git.show(commit=base, path=...)` 得到 Alice 快照内容，绕过历史审阅 owner 校验。同一私有快照还会随源仓库普通 `git push --mirror` 传到目标：在两个临时仓库中已验证目标能读取原未跟踪内容。 | 已修复。快照对象及 refs 位于按 owner/workspace 分开的私有 bare 库；普通历史接口限制 commit 对象。原探针确认 Bob 读取失败、源对象库和 mirror 目标均没有私有快照。旧版已验证归属的精确 refs 可迁入私有库并保留历史。 |
| P2 | ref 已更新后，取消或 manifest 持久化失败会留下旧 manifest 与新 last ref；故障消失后，后续审阅仍永久报告 inconsistent。注入“ref 已提交后失败”的 backend 已复现。 | 已修复。持久 manifest 是提交依据，验证其原始 tree 仍存在后恢复 refs；初始 manifest 先落盘。原故障探针再次调用成功，仍从原基线比较；缺失实际对象时继续拒绝猜测历史。 |
| P2 | 首次 open 捕获未跟踪文件后，用户通过新 `.gitignore` 忽略该文件；文件仍存在，changes 却报告 deleted 并把旧内容放进删除 patch。 | 已修复。仍存在但不再纳入枚举的路径标记 `contentOmitted: excluded`；原探针不再报告删除，也不输出此前内容。 |

上述附加探针全部使用合成内容和临时本机 Git 仓库；mirror 目标也是本机临时目录，没有外网推送。探针结束后所有临时内容已删除。

## 主任务补充回归

明确配置过 `identity` 的实例在该插件停用或不可用后，继续拒绝远程执行、目录与历史披露；本机工具仍可用，恢复身份服务后仍逐请求批准。此增量由主任务修改并通过 core-integration 与 transport 合计 17 项定向回归，未记为独立代理复核。

插件实时配置替换进入单一变更队列，新一代启动成功后才持久化。启动失败会恢复旧配置、grants 和服务；回归实际重启后仍得到原配置。替换不重放已取消动作，也不撤销动作已经产生的文件或命令效果。
