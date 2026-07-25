# 设计依据

本文档解释 Co-Engram 关键设计选择背后的*原因*。如果你打算 fork 或贡献,请先阅读本文。

## 1. 为什么一个 engram 对应一个文件?

每个 engram 都是位于 `<domainTags>/<slug>.md` 的单个 Markdown 文件,带 YAML frontmatter 和 Markdown 正文。engram 拥有一个与文件路径解耦的 ULID。

**其他记忆系统的替代方案:** 将每条记忆拆分到独立的 content / metadata / edges 文件中。

**我们为什么不这样做:**

- **内容和元数据在实践中共同演进。** 当队友改写一条记忆时,他们几乎总是同时更新正文和 title/summary。强迫他们在 content、metadata、edges 之间分别编辑会打断流程。YAML frontmatter 让结构化字段紧邻正文,一次编辑就能覆盖两者。
- **稳定 ID 解决了重命名问题。** 当初分离文件的历史原因是:重命名一条记忆会导致引用孤立。一个与文件路径解耦的 ULID 在身份层就解决了这个问题 — 重命名、移动、改写都能保留所有 synapse 引用,无需任何文件层面的操作。
- **每条边一个 synapse 文件解决了关系问题。** 记忆之间的连接以独立文件形式存放在 `synapses/<kind>/syn-<hash>.yaml`,以确定性 hash 为键。没有重复的边,去重非常简单,剪枝只需删除一个文件。
- **分层读取依然可行。** `engram_get` 在 `tier=digest` 时只返回 frontmatter 字段;正文只在 `tier=content` 时才会懒加载。I/O 节省与分离文件布局相同,却没有多文件开销。
- **Git 中的干净 diff。** YAML frontmatter 的变更显示为文件顶部的一个紧凑块;正文的变更显示在下方的 Markdown diff 中。评审者每次提交每个 engram 都能看到统一的视图。

**权衡:** 单文件意味着 frontmatter 和正文共享 mtime。我们接受这一点 — ULID 才是规范身份,不是文件,而 `engram_doctor` 会自动愈合路径漂移。

## 2. 为什么 core 与宿主无关?

`@co-engram/core` 零宿主依赖。它不 import `@modelcontextprotocol/sdk`,不 import `openclaw`,不知道 Claude Code 或任何特定 agent 运行时的存在。

**原因:**

- **面向未来。** 今天的宿主是 Claude Code 和 OpenClaw。明天可能是 Cursor、Continue.dev、Aider,或尚未被发明的东西。host-agnostic 的 core 意味着我们只需新增一个 adapter(小,约 400 LOC),而不是重写引擎。
- **可测试性。** core 测试不需要启动 MCP server 或 OpenClaw 网关。它们只调用 `engramCreate(...)` 然后断言。结果是:core 中有远超一千个单元测试的测试套件,几秒内跑完。
- **可嵌入。** 你可以在任何 TypeScript 项目中把 Co-Engram 当作库来用,不需要 agent。适合批量维护脚本、自定义 UI、数据迁移工具。
- **清晰的归属。** 当一个 bug 属于"记忆逻辑",它就在 core。当它属于"Claude Code 如何格式化工具调用",它就在 adapter。没有模糊的归属。

**权衡:** 会多一些样板代码。每个 adapter 都必须构造 `ToolContext` 并分派。值得。

## 3. 为什么要从神经科学汲取灵感?

engram、synapse、LTP、LTD、RPE、dreaming、REM 这些术语都借自神经科学 — 不是作为隐喻,而是作为**结构化模型**。

**原因:**

- **大脑是唯一可用的实例。** 我们只有一个被证明能做好长期记忆的系统:人类大脑。任何新颖的记忆架构都只是假设;大脑是参考实现。
- **这套词汇强制严谨。** 把某样东西命名为 `reinforcementScore` 会引发"什么是 reinforcement"的讨论。把它命名为 `LTP_trace` 则迫使你真正建模 long-term potentiation — spike-timing 依赖、衰减曲线、饱和。
- **它能映射到可测试的预测。** "RPE 更新 reinforcementScore" 预测:出乎意料的成功比意料之中的更能强化记忆。我们可以写一个测试来验证。"engram 被使用时会变强" 太模糊,无法测试。

**权衡:** 这套词汇对新手不熟悉。我们通过在 [concepts](./concepts.zh-CN.md) 中为每个术语编写文档,以及保持工具名直白(`engram_create`,而不是 `engram potentiator`)来缓解。

## 4. 为什么要自维护(而不是手动标注)?

大多数记忆系统要求 agent(或人)在使用后手动给记忆打分 — "这个有用吗?点赞/点踩"。Co-Engram 的维护引擎从事件流中提取行为信号,并自动应用 RPE。

**原因:**

- **agent 不会可靠地自我报告。** Claude、GPT、Gemini — 没有谁会在使用一条记忆后可靠地调用 `engram_reinforce(effectiveness=0.7)`。它们会忘记,会把值舍入到 0 或 1,会虚构。任何依赖 agent 自律的系统从一开始就失败了。
- **行为比自我报告更诚实。** 如果一个 agent 检索了一条 engram 然后立刻又去搜别的东西,那这条 engram 就是错的 — 不管 agent 自己怎么说。如果一个 agent 检索了一条 engram 然后基于它编辑了文件,那这条 engram 就是有用的。行动胜于言辞。
- **人也不会做。** 要求人给记忆打标签,等于让他们做无报酬的数据录入。他们不会做。系统必须能在没有他们的情况下工作。

**权衡:** 行为信号是有噪声的。一次"错误检索"可能是偶然。我们用滚动窗口和较低的学习率来缓解(默认 0.1 — 大约需要 10 个信号才能显著改变分数)。

## 5. 为什么数据用独立的 Git 仓库?

数据仓库(`~/team-memory/`)刻意与任何代码仓库(包括本仓库)分离。

**原因:**

- **记忆是跨项目的。** 你在项目 A 中学到的一个 pattern 也适用于项目 B。如果记忆存放在项目 A 的仓库里,项目 B 就看不到它。独立仓库服务于所有项目。
- **记忆比项目长寿。** 项目会被归档、重写、废弃。记忆应该留存。独立仓库有自己的生命周期。
- **Git 历史是神圣的。** 把记忆的频繁变更(每周数百次提交)和代码历史混在一起,会让代码的 `git log` 失去价值。分离仓库让两者都保持干净。
- **访问控制。** 一个团队可能通过私有 Git 远端共享一个记忆仓库,同时保持代码仓库分离。反之亦然。

**权衡:** 用户必须记得对数据仓库执行 `git init`。我们通过快速入门和第 2 步中的 `mkdir + git init` 来缓解。

## 6. 为什么要在 manifest 中声明 `contracts.tools`?

OpenClaw 要求 plugin 在 `openclaw.plugin.json` 的 `contracts.tools` 数组中预先声明每一个工具名。如果某个工具未被声明,加载器会静默丢弃它。

**原因:**

- **没有隐藏工具。** 一个悄悄注册了 `delete_everything` 的 plugin 是安全风险。manifest 声明强制每个工具在安装时就可见。
- **确定性的控制平面。** 发现、校验、安装规划都只依赖元数据就能完成 — 无需执行 plugin 代码。这让 `openclaw plugins list` 又快又安全。
- **审计追踪。** 如果某个工具行为异常,manifest 会告诉你本应注册什么。你可以把它与实际运行时注册的内容做 diff。

**权衡:** 新增一个工具需要编辑两处(工具定义 + manifest)。未来 IDE 工具可以自动化这一步。

## 7. 为什么 Claude Code 用 MCP(而不是自定义 hook)?

Claude Code 支持多种集成机制:MCP server、slash command、hook、CLAUDE.md 文件。我们选择了 MCP。

**原因:**

- **MCP 是官方标准。** Anthropic 发布并维护 MCP。基于它构建的工具能在 Claude Code 版本升级中存活。自定义 hook 没有这种保证。
- **MCP 是跨宿主的。** 同一个 MCP server 能配合 Cursor、Continue.dev、Codex 使用 — 不只是 Claude Code。我们的 `@co-engram/claude-code` 包实际上是一个通用 MCP server,尽管名字如此。
- **MCP 工具自带 schema 校验。** 输入/输出都按 JSON Schema 校验。我们内部已经用 Zod 校验;MCP 在协议边界又加了一层。
- **MCP 是可发现的。** Claude Code 中的 `/mcp` 会列出所有工具。用户能准确看到 Co-Engram 暴露了什么,无需查阅文档。

**权衡:** MCP 比直接函数调用开销更大。对于 session 范围的 server 中的 30 个工具来说可以忽略 — 但并非免费。

## 相关文档

- [架构](./architecture.zh-CN.md) — 这些决策产生的分层结构
- [概念](./concepts.zh-CN.md) — 这些决策所需的词汇
