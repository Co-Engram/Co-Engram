# 工具参考

Co-Engram 提供 29 个原生工具,全部可通过 MCP(`mcp__co-engram__<name>`)或 OpenClaw 插件 API 访问。在 `@co-engram/openclaw` 下,还会额外注册两个包装工具(`memory_search`、`memory_get`),用于满足 OpenClaw 的 memory 插件契约 —— 它们内部会调用 `engram_search` / `engram_get`。

本页逐一列出每个原生工具及其必填输入。为简洁起见,省略了可选字段 —— 完整字段以源码中的 Zod schema 为准。

## 工具 profile(Tool profiles)

工具按用途分成三档 profile,让 LLM token 占用按需扩展。通过 `CO_ENGRAM_TOOLS_PROFILE` 环境变量(Claude Code MCP)或插件配置(OpenClaw)切换。下表的计数由 `PROFILE_TOOL_COUNTS` 从源码自动计算,并由契约测试断言,不会发生静默漂移。

| Profile   | 计数 | 适用场景                                                                            |
| --------- | ---- | ----------------------------------------------------------------------------------- |
| `minimal` | 12   | 仅核心读写 —— 只做回忆 + 记录的对话 agent。                                          |
| `standard`| 19   | 默认值。加仓库健康(`engram_doctor`、`engram_list_paths`、`engram_audit_query`)+ 提案 + 验证。 |
| `full`    | 29   | 全部,包括矛盾裁决、演化谱系、技能元信息查看。                                          |

`skill_invoke` 在源码里存在,但是**实验性**的——默认不在任何 profile 里,因为 skill body 的执行逻辑目前是 P0 占位实现。如需查看 skill 元信息,使用 `skill_get`(只读,在 `full` profile)。

## Engrams

### `engram_create`

创建一个新的 engram。当 `dedupe: true`(默认值)时,若内容重复,会强化已有的 engram,而不是新建。

**必填输入:**

- `title: string`(1-200 字符)
- `content: string`(Markdown)
- `kind: "observation" | "fact" | "pattern" | "procedure" | "hypothesis"`
- `domainTags: string[]`(至少 1 个)

**可选:**

- `createdBy: string` —— 若省略,回退到 `ToolContext.defaultCreatedBy`。解析链:调用方显式传值 → `CO_ENGRAM_DEFAULT_CREATED_BY` 环境变量(MCP)或插件配置 `defaultCreatedBy`(OpenClaw)→ 持久化的 team-memory 配置 → **本机 git 身份(`user.name` → `user.email`)** → `'unknown'`。

**返回值:**

```ts
{
  id: string,                         // the effective engram id (newly created or the dedup target)
  verdict: "NEW" | "DUPLICATE" | "UPDATE",
  targetId?: string,                  // set when verdict is DUPLICATE / UPDATE (the existing engram)
  reason?: string,                    // why the dedup verdict was chosen
  confidence?: number,                // dedup confidence in [0, 1]
  candidatesConsidered?: number       // how many existing engrams were compared
}
```

### `engram_get`

按 ID 读取一个 engram。支持分层披露 —— 只返回调用方"负担得起"的部分。

**必填输入:**

- `id: string`

**关键可选:**

- `tier: "catalog" | "digest" | "content" | "meta" | "synapses" | "auto"`(默认 `digest`)
- `contextBudget: { totalTokens: number }` —— 当 `tier=auto` 时,挑选能放得下的最深一层

**返回值:** 所请求层级下的 engram

### `engram_update`

更新 engram 的可变字段(title / content / importance 等)。

**必填输入:**

- `id: string`
- `updatedBy: string`

**关键可选:** `title`、`content`、`summary`、`kinds`、`domainTags`、`importance`、`confidence`、`decayHalfLifeDays`、`visibility`

**副作用:** 刷新 `updatedAt`,并递增 engram 的 version。

### `engram_delete`

永久删除一个 engram 及其所有 synapse。不可逆(但 Git 历史仍会保留)。

**必填输入:** `id: string`

### `engram_search`

全文检索,支持可选过滤器。

**必填输入:**

- `query: string`

**关键可选:**

- `filter: { domainTags, kinds, status, freshness, emotionalValence, createdBy, createdAfter, createdBefore, minImportance }`
- `limit: number`(默认 20,最大 100)

**返回值:**

```ts
{
  results: Array<{
    id: string
    score: number
    title: string
    kind: string
    domainTags: string[]
  }>,
  total: number
}
```

每条结果自带 title/kind/domainTags,调用方不必再 `engram_get` 一次就能识别命中。完整正文与其他元数据(summary、importance 等)仍需 `engram_get` 获取。

### `engram_list`

按元数据过滤列出 engram(不进行全文检索),使用 cursor 分页。

**必填:** `limit: number`(1-500)

**可选:** 与 `engram_search` 相同的 `filter`;`cursor: string | null`(上一页返回的 `nextCursor`,原样回传到下一页的 `cursor` 参数即可继续翻页)

**返回值:**

```ts
{
  items: Array<{ id: string, title: string, kind: EngramKind, domainTags: string[] }>,
  nextCursor: string | null  // 没有更多结果时为 null
}
```

排序:`importance DESC, updatedAt DESC, id ASC`(稳定排序,翻页无重复/无遗漏)。

### `engram_reinforce`

上报一次成功使用(LTP —— 长时程增强)。递增 `effectiveRetrievals`,更新 `reinforcementScore` 和 `importance`。通过 `extends`/`consolidates` 连接的邻居会获得 50% 的提升。

**必填输入:**

- `id: string`

**可选:** `effectiveness: number [0, 1]`(默认 1)、`note: string`

### `engram_report_failure`

上报一次失败使用(LTD —— 长时程抑制)。递增 `failedUses`,递减 `importance`。失败达 3 次时触发归档建议,达 5 次时触发遗忘建议。

**必填输入:**

- `id: string`
- `reason: string`

**可选:** `context: string`

### `engram_archive`

将一个 engram 移出默认检索,但仍保留可恢复性。默认不会出现在检索结果中,除非 `filter.status` 包含 `archived`。

**必填输入:** `id: string` | **可选:** `reason: string`

### `engram_restore`

逆转 `archive` 或 `forget`。将 engram 恢复到活跃检索状态。

**必填输入:** `id: string` | **可选:** `reason: string`

### `engram_forget`

主动的检索诱导遗忘(RIF)。文件仍保留在 Git 中,但不会出现在任何默认检索中。

**必填输入:**

- `id: string`
- `reason: string`

### `engram_recompute_importance`

重新计算多维 importance(personal/team/project/network/temporal)。Network 即 synapse 图的度数,temporal 即 Ebbinghaus 衰减。最终将复合值写回 `engram.importance`。

**必填输入:** `id: string`

**可选:** `overrides: { personal, team, project }`、`persist: boolean`(默认 true)、`updatedBy: string`

## Synapses

### `synapse_create`

在两个 engram 之间创建带类型的连接。同时更新双方的 in/out 缓存。

**必填输入:**

- `from: string`(engram ID)
- `to: string`(engram ID)
- `kind: SynapseKind`(见 [concepts.zh-CN.md](./concepts.zh-CN.md))

**可选:**

- `createdBy: string` —— 回退规则与 `engram_create.createdBy` 相同。
- `weight: number [0, 1]`(默认 0.5)
- `direction: "directional" | "bidirectional"`(默认 `directional`)
- `evidence: Evidence[]`
- `sourceSemantic`、`targetSemantic` —— 两端可选的语义角色标签,检索编排器在加权图遍历时会用到

### `synapse_get`

读取单个 synapse。

**必填输入:**

- `from: string`
- `synapseId: string`

### `synapse_list`

列出某个 engram 的所有 synapse。

**必填输入:**

- `engramId: string`

**可选:** `direction: "outgoing" | "incoming" | "both"`(默认 `both`)

### `synapse_delete`

删除一个 synapse。同时更新双方 engram 的缓存。

**必填输入:**

- `from: string`
- `synapseId: string`

## Skills

### `skill_get`

读取 skill 元数据。

**必填输入:** `id: string`

### `skill_invoke`(实验性 —— 不在任何默认 profile 中)

调用一个 skill(程序性记忆)。skill 正文是一个模板;引擎会用 `args` 解析其中的模板变量,并返回渲染后的步骤。

> **⚠️ 实验性:** 本工具的 `execute` 目前返回 `[P0 stub]` 占位字符串 —— 模板解析逻辑尚未实现。为避免 LLM 误调用并把占位字符串当成真实结果,默认从 `minimal` / `standard` / `full` 三个 profile 中排除。如需原型试用,请构造自定义 profile 并显式添加 `skill_invoke`。

**必填输入:**

- `id: string`

**可选:** `args: Record<string, unknown>`

**返回值:**

```ts
{
  skillId: string,
  resolved: boolean,                  // were all template variables satisfied by args?
  steps?: Array<{ description: string }>,  // rendered steps (when resolved)
  missing?: string[]                 // unbound variable names (when not resolved)
}
```

## 学习闭环

### `close_learning_loop`

关闭多巴胺学习闭环 —— 回馈某个 engram 使用后的结果。

**必填输入:**

- `engramId: string`
- `outcome: "success" | "failure" | "partial"`
- `reportedBy: string`

**可选:** `effectiveness: number [0, 1]`、`reason: string`

**副作用:** success → LTP + Hebbian 邻居提升;failure → LTD + 降级阈值检查。

**返回值:**

```ts
{
  engramId: string,
  outcome: "success" | "failure" | "partial",
  importance: number,                 // post-update composite importance
  importanceDelta: number,            // change applied this call
  hebbianTriggered: boolean,          // did the success branch fire neighbor LTP?
  provenanceTriggered: boolean,       // did the failure branch check provenance decay?
  shouldArchive: boolean,             // failure crossed the archive threshold
  shouldForget: boolean               // failure crossed the forget threshold
}
```

### `contradiction_resolve`

人工仲裁一个 `contradicts` synapse。

**必填输入:**

- `fromId: string`
- `synapseId: string`
- `verdict: "keep_new" | "keep_old" | "merge" | "archive"`
- `rationale: string`(1-1000 字符)
- `resolvedBy: string`

### `upgrade_verification`

升级(或降级为 `refuted`)某个 engram 的验证状态。

**必填输入:**

- `engramId: string`
- `newStatus: "unverified" | "plausible" | "probable" | "verified" | "refuted"`
- `evidenceDescription: string`(1-1000 字符)
- `verifiedBy: string`

**可选:** `confidence: number [0, 1]`、`evidenceDomainTags: string[]`、`force: boolean`(跳过状态机守卫)

### `get_evolution_lineage`

追踪某个 engram 的演化 DAG —— 祖先(通过 `derives_from` / `consolidates` / `supersedes`)和后代。

**必填输入:** `engramId: string`

**可选:** `direction: "ancestors" | "descendants" | "both"`(默认 `both`)、`maxDepth: number`(默认 10,最大 20)、`kinds: SynapseKind[]` 过滤器

**返回值:** `{ nodes: Engram[], edges: Synapse[] }`

## Memory Proposals

提案引擎会被动地观察对话。当某个主题被多次提及,但又没有匹配的 engram 时,它会生成一个*候选提案*,等待用户/LLM 决策。

这是一种"主动提示候选"的混合模式:不是全自动(你始终掌控决定权),也不是全手动(引擎会主动浮现你可能会错过的模式)。

### `engram_list_proposals`

列出待处理的记忆候选(被看到 ≥ N 次但尚未记录的主题),使用 cursor 分页。

**必填:** `limit: number`(1-500)

**可选:** `includeAll: boolean`(默认 `false` —— 只返回待处理提案;设为 `true` 可一并包含已接受/已驳回的历史);`cursor: string | null`(分页 token)

**返回值:**

```ts
{
  items: Array<{ entityId: string, occurrences: number, sampleQuotes: string[],
                 centroidExcerpt: string, firstSeenAt: string, lastSeenAt: string,
                 createdAt: string, status: "pending" | "accepted" | "dismissed",
                 source: "conversation" | "auto-memory" | "external-markdown",
                 /* auto-memory 来源还携带 proposedTitle/proposedContent 等 */ }>,
  nextCursor: string | null  // 没有更多结果时为 null
}
```

排序:`createdAt DESC, entityId ASC`(稳定排序)。每个提案都包含样例引用、出现次数以及首次/末次出现的时间戳 —— 足以在不重读原始对话的情况下决定是接受还是驳回。

### `engram_accept_proposal`

把一个提案转为真正的 engram。

**必填输入:**

- `entityId: string`(提案的 cluster id,由 `engram_list_proposals` 返回)
- `title: string`
- `content: string`(Markdown)
- `domainTags: string[]`

**可选:** `kind: EngramKind`(默认 `fact`)、`createdBy: string` —— 若省略,回退到 `ctx.defaultCreatedBy`(MCP env `CO_ENGRAM_DEFAULT_CREATED_BY` / OpenClaw 插件 config / 本机 git 身份)→ `'unknown'`。与 `engram_create` 走相同的解析链。

**副作用:** 创建 engram、移除该 cluster、在审计日志中追加 `accept`。

### `engram_dismiss_proposal`

暂时驳回一个提案(默认 30 天,之后若该主题再次出现,可重新浮现)。

**必填输入:** `entityId: string`

**可选:** `reason: string`、`dismissDays: number`(默认 30)

**副作用:** 将提案标记为 `dismissed`,记录 reason 以供后续元学习使用。

## 仓库健康检查(`standard` profile 下)

这些工具帮助 LLM(或人类)检视 memory 仓库的物理布局,并自愈常见的漂移(文件移动、标题重命名、孤立的 Markdown)。它们基于 `engram-index.json` 缓存做快速增量扫描,属于 `standard` 工具 profile 的一部分 —— 无需切换到 `full` 即可使用。

### `engram_audit_query`

查询审计日志(team-memory 的事件历史,即 `audit.jsonl`),使用 cursor 分页。把 `AuditLog.query` 内部已暴露的数据透出给 agent 或用户,这样无需打开 viewer 或直接读文件就能回答"这个 engram 发生了什么?"。

**必填:** `limit: number`(1-1000)

**可选输入:**

- `engramId: string` —— 过滤某个 engram 的完整历史
- `action: AuditAction` —— 按事件类型过滤(`create`、`update`、`update_lifecycle`、`reinforce`、`report_failure`、`forget`、`restore`、`sweep_to_trash`、`restore_from_trash`、`purge`、`propose`、`accept`、`dismiss`、`retrieve_hit`、`retrieve_effective`、`retrieve_inconclusive`、`contradicted`、`noise_filtered`、`necessity_rejected`、`merge_resolved`、`merge_backup_failed`、`merge_conflict_escalated`、`merge_llm_arbitrated`、`merge_llm_arbitrated_escalated`、`merge_llm_arbitrated_failed`)
- `since: string`(ISO 8601,包含)、`until: string`(ISO 8601,不包含)
- `cursor: string | null` —— 分页 token(编码上一页 oldest entry 的 `ts`;原样回传到下一页的 `cursor` 参数即可继续翻更早的事件)。与 `until` 互斥(同时传时 cursor 优先)。

**返回值:**

```ts
{
  items: Array<{
    ts: string,          // ISO 8601 timestamp
    actor: "user" | "system" | "llm-arbiter",
    action: AuditAction,
    engramId?: string,
    metadata: Record<string, unknown>
  }>,
  nextCursor: string | null  // 没有更多结果时为 null
}
```

事件按时间升序返回(在过滤范围内取最新 N 条,页内升序)。常见用法:"谁在什么时候强化了这个 engram?"、"为什么这个 engram 的 importance 跳变?"、"上次合并冲突的裁决是什么?"。

### `engram_doctor`

对 data root 运行自愈扫描并报告问题。自动修复文件移动(更新索引)、标题变更(重新 slug 化并重命名)、文件缺失(清理索引条目)。对于悬挂的 synapse 引用和孤立的 Markdown,则报告给人工处理。

**可选:** `incremental: boolean`(默认 `false` —— 全量扫描)

**返回值:**

```
{
  startedAt, finishedAt,
  totalEngrams, totalSynapses,
  autoFixesApplied, pendingManualReview,
  issues: [{ kind, stableId?, path?, message, autoFixed }]
}
```

`issues[].kind` 取值如下:

| kind               | autoFixed | 含义                                                                                                                                                                                                                          |
| ------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `moved_file`       | ✅        | 文件路径变更;索引已重新指向。                                                                                                                                                                                                 |
| `title_changed`    | ✅        | 标题变更;通过重新 slug 化对文件进行了重命名。                                                                                                                                                                                 |
| `missing_file`     | ✅        | 索引条目指向了一个已不存在的文件;条目已清理。                                                                                                                                                                                 |
| `slug_conflict`    | ⚠️        | 新 slug 会与另一个文件冲突;保留旧 slug。需人工解决。                                                                                                                                                                          |
| `orphan_markdown`  | ⚠️        | 没有 frontmatter 的 Markdown 文件。仓库约定文档(`README.md` / `LICENSE.md` / `CONTRIBUTING.md` / `CHANGELOG.md` / `CODE_OF_CONDUCT.md` / `SECURITY.md`,大小写不敏感)可豁免。其他文件请删除,或添加带有稳定 id 的 frontmatter。 |
| `dangling_synapse` | ⚠️        | synapse 引用了一个已不存在的 engram;请人工清理或恢复该 engram。                                                                                                                                                               |
| `duplicate_id`     | ⚠️        | 两个 engram 文件共用同一个 ULID。请人工为其中一个分配新的 ULID。                                                                                                                                                              |
| `duplicate_engram` | ⚠️        | 两个 engram 的标题/内容非常相似;可考虑用 `consolidates` synapse 进行整合。                                                                                                                                                    |

所有 `message` 字符串均为英文(便于国际化)。LLM 看到的工具描述则通过 `LLM_TOOL_DESCRIPTIONS` 提供双语版本。

### `engram_list_paths`

列出 data root 的物理目录树,用于渐进式披露。每个节点都带 `engramCount`(该子树的累计数量)。便于 LLM 在决定检索之前先看清工作集中在哪些区域。

**可选:** `maxDepth: number`(1-10,默认 5)

**返回值:** `{ root: { path: '/', engramCount, children: [...] } }`

## 常用模式

### 创建 + 强化(正常路径)

```
engram_create(...) → { id }
# ... use the engram in a real task ...
engram_reinforce({ id, effectiveness: 0.9 })
```

### 检索 → 发现矛盾 → 仲裁

```
engram_search({ query: "X" }) → [a, b]
# notice a and b contradict
synapse_create({ from: a.id, to: b.id, kind: "contradicts", ... })
contradiction_resolve({ fromId: a.id, synapseId: ..., verdict: "keep_new", ... })
```

### 验证一个假设

```
engram_create({ kind: "hypothesis", ... })
# ... gather evidence over time ...
upgrade_verification({ engramId, newStatus: "verified", evidenceDescription: "..." })
```

### 记忆提案分类

```
engram_list_proposals() → [{ entityId, occurrences, sampleQuotes, ... }, ...]
# review the samples
engram_accept_proposal({ entityId, title, content, domainTags, createdBy })
# or
engram_dismiss_proposal({ entityId, reason: "already covered by ..." })
```
