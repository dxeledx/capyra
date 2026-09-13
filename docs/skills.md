# Skills 发现与使用

`skills` 插件提供规则发现、适用规则读取、技能目录和技能附属资源读取。所有 MCP 调用继续经过本机逐请求确认。

## 模型与本机目录

`skills__discover` 返回当前工作区的规则和可供模型调用的技能。`disable-model-invocation: true` 的技能不会出现在模型目录中，按猜测的 ID 调用 `skills__read` 也会拒绝。读取之前会重新核对当前配置；先发现、后禁用的技能不会因为旧 ID 继续可读。

从本机控制台执行同样的 discover / read 工具时，可信 `local-console` 调用者可以看到禁用和被同名条目覆盖的技能，并明确读取所选技能及其资源。目录用 `disableModelInvocation` 和 `shadowedBy` 标记状态。工具参数没有 audience 或 owner 开关，客户端不能自行声明本机身份。

插件作者的服务契约保留原有参数，追加可选选项：

```ts
skills.discover(workspace, signal, { audience: 'local' });
skills.read(workspace, id, signal, resource, { audience: 'local' });
```

省略选项默认 `model`，包括客户端工作卡中的目录。`local` 选项供可信本机插件使用，不能直接映射远程请求参数。禁用模型调用是 Skills 发现和使用策略；它不替代工作区文件工具的路径保护和本机审批，也不承诺使文件对电脑主人不可见。

## 发现与同名规则

按顺序搜索项目 `.agents/skills`、`.claude/skills`、`.codex/skills`、`skills`，再搜索本机配置 `skills.paths`；默认全局根为 `~/.agents/skills`。相同物理根和文件去重。同名有效技能使用先发现者，保持当前 Capyra 的项目优先顺序；本机目录保留其他条目并报告 winner / shadowed ID，模型只得到未禁用的优先条目。

目录存在 `SKILL.md` 时，它就是技能根，不再从其附属资源目录发现新技能；没有 `SKILL.md` 的入口根也支持直接 `.md` 文件，子目录按顺序寻找 `SKILL.md`。发现时按目录读取 `.gitignore`、`.ignore`、`.fdignore`，支持常用 glob、根路径、目录规则和 `!` 否定规则；已排除的目录不会为了匹配子项而重新进入。资源读取始终限于所选技能目录，拒绝父级穿越、软链接和保护路径。

归档、trash 和名称包含“归档”的目录在遍历进入前跳过。显式配置归档根也会拒绝；没有自动恢复或搜索归档技能。扫描深度由 `discoveryDepth` 控制（默认 8，最多 20），单次根目录遍历最多 20000 条目，技能目录最多检查 200 个候选文件；继承的 ignore 规则最多 2000 条、每条最多 1024 字符。

## Frontmatter

支持技能所需的顶层标量、单/双引号字符串、注释、普通续行及 `|` / `>` 块文本。`metadata` 等扩展字段可保留嵌套内容，但不参与技能调用策略；不解释 YAML 标签、锚点或合并键，也没有引入 YAML 运行依赖。

```yaml
---
name: careful-review
description: >-
  Review changed code and explain
  the evidence for each finding.
disable-model-invocation: true
metadata:
  short-description: Manual review workflow
---
```

`description` 必须为非空文本。缺少 name 时采用所在目录名；名称格式与 64 字符规范不符时保留技能并给出诊断，与固定参考的警告语义一致。目录中的描述最多展示 1024 字符，超过时会提示截断。布尔值必须写成不加引号的 `true` 或 `false`；空值、字符串布尔值、重复字段、错误缩进、未闭合引号/头部或不支持的关键字段形式会使候选技能失效。完整 YAML 的高级写法应改成上述可移植形式。

无效条目的具体路径和原因保留在本机诊断中。模型收到简短的省略提示；禁用技能的名称、描述和同名冲突详情不会通过诊断间接曝光。

## 验证与参考

`tests/skills.test.ts` 共 7 项通过，覆盖规则作用域和资源边界、禁用/本机人工使用、身份参数伪造、十类无效 frontmatter、引号和多行文本、确定性同名处理、物理去重、禁用优先条目对同名候选的约束、运行时策略变化、技能根停止递归、目录 ignore 和归档目录不可读陷阱。测试只使用临时目录，未读取用户归档技能。

源码对照固定 DevSpace `cd84cb23bd6947910e1606f135e230ee5a1a68e7` 的 `src/skills.ts`、`src/skills.test.ts`、`server.ts` 模型目录过滤，以及其已锁定 `@earendil-works/pi-coding-agent@0.80.3` 的 `dist/core/skills.js` 与 frontmatter 解析器。Capyra 使用范围明确的本机实现；其目录优先级、软链接限制和 YAML 支持范围以上述交付契约为准。
