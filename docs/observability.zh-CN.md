# 可观测性

Co-Engram 自带三组件的可观测性栈。三者都是可选的,但默认开启(proposal 引擎除外)—— 可通过宿主配置禁用任意一项。

## 组件

| 组件                   | 用途                                                          | 默认     | 开销                             |
| ---------------------- | ------------------------------------------------------------- | -------- | -------------------------------- |
| `AuditLog`             | 只追加的事件日志(状态变更 + 有效性信号)                       | **开启** | ~200 字节/事件                   |
| `EffectivenessTracker` | 在 `retrieve_hit` 前后开关窗口,衡量该 engram 是否真的起到帮助 | **开启** | 可忽略                           |
| `ProposalEngine`       | 被动观察对话,在话题反复出现时提议 engram                      | **关闭** | 基于哈希的 embedder(无 LLM 调用) |

## 审计日志

记录状态变更 + 必要事件。以 JSONL 形式存储于 `$DATA_ROOT/.co-engram/audit.jsonl`。为了让这个文件聚焦于"改变了记忆的事件",高频的观察类事件不再写入(数据存到 [Effectiveness Tracker](#effectiveness-tracker) 管理的文件)。

### 追踪的动作

**状态变更:** `create`、`update`、`update_lifecycle`、`reinforce`、`report_failure`、`forget`、`restore`、`sweep_to_trash`、`restore_from_trash`、`purge`、`propose`、`accept`、`dismiss`

**必要性拒绝:** `necessity_rejected`(Layer 2 评估拒绝 —— 保留是为了调参规则集)

**冲突标记:** `contradicted`(供 `EffectivenessTracker.effectiveness()` 派生用)

**Git merge driver 事件:** `merge_resolved`(driver 自动解决冲突)、`merge_backup_failed`(输方备份落盘失败)、`merge_conflict_escalated`(driver 留 marker 升级人工)、`merge_llm_arbitrated` / `merge_llm_arbitrated_escalated` / `merge_llm_arbitrated_failed`(Phase 3 LLM 仲裁结果)

**不再写入**(只在 `AuditAction` 枚举里保留以便读旧日志):

- `noise_filtered`(Layer 1 预过滤拒绝 —— 每条对话消息都可能产生)
- `retrieve_hit` / `retrieve_effective` / `retrieve_inconclusive`(effectiveness 已改从 `observation-windows.jsonl` 派生)

### 查询

```typescript
import { AuditLog } from "@co-engram/core";

const audit = new AuditLog("/path/to/data-root");

// Last 100 events
const recent = audit.query({ limit: 100 });

// All reinforce events for a specific engram
const reinforces = audit.query({
  engramId: "01J...A",
  action: "reinforce",
});

// Derive effectiveness report
const report = audit.effectiveness("01J...A");
// → { hits: 5, effective: 4, inconclusive: 1, contradicted: 0, effectiveRate: 0.8 }
```

`effectiveRate` 计算公式:`effective / (effective + inconclusive + contradicted)`。当 `hits < 3` 时返回 `null`(统计噪声下限)。

### 通过 `engram_audit_query` 工具查询

LLM agent 想"查询某个 engram 发生了什么",又不想打开 viewer 或直接读 JSONL,可以调用 **`engram_audit_query`** 工具(`standard` 和 `full` profile 均暴露)。它把 `AuditLog.query()` 的过滤项 —— `engramId`、`action`、`since`、`until`、`limit` —— 透出给 LLM,返回按时间升序的事件。完整签名见 [工具参考](./tool-reference.zh-CN.md)。

### 日志轮转(自动清理)

`audit.jsonl` 默认开启自动清理,**独立后台 `setInterval`**(默认 24h 检查一次),与 [维护引擎](./maintenance-engine.zh-CN.md) 的 light/deep/rem 阶段完全解耦 —— 日志管理与记忆数据维护是不同概念的东西。

清理策略沿两条轴:

**1. 按 action 价值分层保留(时间维度)**

| 层级              | 默认保留 | 包含的 action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **高价值**        | 365 天   | `create`、`update`、`update_lifecycle`、`importance_update`、`forget`、`restore`、`sweep_to_trash`、`restore_from_trash`、`purge`、`accept`、`dismiss`、`contradicted`、`merge_resolved`、`merge_backup_failed`、`merge_conflict_escalated`、`merge_llm_arbitrated`、`merge_llm_arbitrated_escalated`、`merge_llm_arbitrated_failed`、`learning_loop_success`、`learning_loop_partial`、`learning_loop_failure` |
| **低价值(默认)** | 90 天    | `propose`、`reinforce`、`report_failure`、`retrieve_hit`、`retrieve_effective`、`retrieve_inconclusive`、`noise_filtered`、`necessity_rejected`                                                                                                                                                                                                                                                                                                                                                                                                                                         |

分层理由:高价值 = 状态变更 + 用户决策 + 跨进程协同 + 学习回路闭环,这些是审计的核心目的(追溯"为什么这条 engram 被删/合并/接受/驳回")。低价值 = 高频但低追溯价值(每次工具调用、每次检索命中都产生,但单独看一行对复盘几乎无用)。

**2. 文件大小硬上限(空间维度)**

即使时间窗未到,文件超过 `maxSizeMb`(默认 50MB)也会强制截断 —— 从文件尾部向前累加字节直到达到上限,**保留尾部最新**(实际生产 audit.jsonl 的写入顺序:append 总是把新条目写到末尾,所以最新的在底部)。这是 `readFileSync` 的硬保护,避免文件无界增长把 Node 进程 OOM。

**安全保证**:

- **损坏行保留**:JSON parse 失败或 `ts` 字段无法解析的行**不擅自删除**,原样保留,交给 `engram_audit_query` / 人工处理。
- **fail-soft**:任何 IO/JSON 异常返回 `droppedCount: 0`,不抛错,不阻塞业务。
- **不写 audit**:清理动作本身不写 audit(自指会产生新数据,反向激励)。
- **原子写**:`tmp-${pid}-${ts}` 临时文件 + `rename`,杜绝半截写损坏。

### 配置

在 `$DATA_ROOT/.co-engram/config.json` 写:

```json
{
  "audit": {
    "enabled": true,
    "rotation": {
      "enabled": true,
      "retentionDays": 90,
      "highValueRetentionDays": 365,
      "maxSizeMb": 50,
      "intervalMs": 86400000
    }
  }
}
```

字段含义:

| 字段                      | 默认      | 说明                                                                                                       |
| ------------------------- | --------- | ---------------------------------------------------------------------------------------------------------- |
| `audit.enabled`           | `true`    | 总开关。`false` 时既不写 audit 也不启动 rotation                                                           |
| `audit.rotation.enabled`  | `true`    | rotation 总开关。`false` 完全关闭自动清理(audit.jsonl 无限增长,仅适合测试 / 主动运维)                  |
| `retentionDays`           | `90`      | 低价值 action 保留期(天)                                                                                 |
| `highValueRetentionDays`  | `365`     | 高价值 action 保留期(天)                                                                                 |
| `maxSizeMb`               | `50`      | 文件大小硬上限(MB)                                                                                       |
| `intervalMs`              | `86400000`| rotation 检查间隔(毫秒,默认 24 小时)。`≤ 0` 时不启动                                                    |

宿主配置层(host adapter):`@co-engram/claude-code` 的 `CoEngramMcpServerConfig.auditRotationConfig` 和 `@co-engram/openclaw` 的 `CoEngramPluginConfig.auditRotationConfig` 都接受同一形状,缺省时从 persisted config 解析或用默认值。

## 有效性追踪器

当 `engram_search` 命中一个 engram 时,被包装的工具会调用 `effectivenessTracker.openWindow(...)`。窗口长度取决于该 engram 的 kind:

| Kind        | 窗口 |
| ----------- | ---- |
| observation | 6h   |
| fact(默认)  | 24h  |
| pattern     | 48h  |
| procedure   | 48h  |
| hypothesis  | 7d   |

若 `engram_reinforce` 在截止时间前触发 → 窗口以 `closed_by_reinforce` 关闭。若截止时间已过 → 维护浅层阶段会以 `closed_by_timeout` 将其清理。若 `engram_report_failure` 触发 → 窗口以 `closed_by_failure` 关闭(不计入 effectiveness 分母)。

窗口记录是有效性统计的真理来源 —— `EffectivenessTracker.effectiveness(engramId)` 直接读 `observation-windows.jsonl`:

- `hits` = 该 engram 的窗口记录总数
- `effective` = `closed_by_reinforce` 的数量
- `inconclusive` = `closed_by_timeout` 的数量
- `contradicted` = 从 `audit.jsonl` 读取(窗口无此表示)

`audit.jsonl` 不再记录 `retrieve_hit` / `retrieve_effective` / `retrieve_inconclusive`,因为窗口记录已经覆盖这些 —— 再写一份 audit 会让每次搜索都重复落盘,淹没真正值得审计的状态变更。

这为系统提供了一个反馈信号:在大量命中下 `effectiveRate` 较低的 engram,会成为归档/遗忘的候选对象。

## 分数字段格式(Score Field)

工具返回的所有数值字段(importance、reinforcementScore、lastRetrievalScore、FTS score、effectiveness)统一封装为 `ScoreField`,保证呈现一致并保持 host-agnostic:

```ts
interface ScoreField {
  readonly raw: number;                       // 2 位小数(rounded),JSON-safe
  readonly band: "high" | "medium" | "low";   // 语言中立等级
}
```

**等级阈值**(见 [`concepts/dictionary.ts`](../packages/core/src/concepts/dictionary.ts) 中的 `formatScoreField`):

| 等级     | 范围               |
| -------- | ------------------ |
| `high`   | `raw ≥ 0.70`       |
| `medium` | `0.30 ≤ raw < 0.70`|
| `low`    | `raw < 0.30`       |

**为什么用两个字段而不是单个浮点:**

- `raw` 固定 2 位小数,杜绝浮点噪声泄漏到 UI(例如 `0.018000000000000002` 会变成 `0.02`)。
- `band` 是语言中立的枚举,保持 core 层 host-agnostic —— 由 viewer 或 host adapter 通过 i18n 字典本地化(`高/中/低` 或 `high/medium/low`),而不是由 core 层硬编码。

**出现位置:** `engram_get`、`engram_search`、`engram_reinforce`、`engram_report_failure`,以及 viewer 的 effectiveness 报告,所有面向用户的数值字段都返回 `ScoreField`。

若需在 core 内部把分数嵌入字符串(例如审计 reason),`formatScore(score, lang)` 直接返回 `"高(0.84)"` / `"high(0.84)"`。

## Proposal 引擎

通过 `proposalEngine.observe({ role, content })` 观察对话消息。基于哈希的 embedder 生成一个 128 维 L2 归一化向量。向量通过余弦相似度进行聚类(默认 `DEFAULT_HASHER_SIMILARITY_THRESHOLD = 0.35`,适用于 hash embedder)。当一个聚类的出现次数达到阈值(默认 `3`),引擎会执行**双层过滤**判断是否晋升为提案。

### 双层过滤机制

为了挡住机械重复对话被错误地提交为提案,proposal engine 在 `observe()` 入口和 `maybePromoteToProposal()` 各设一层过滤。

```
对话流 → observe()
            │
            ▼
   ┌─────────────────────────────────┐
   │ Layer 1: 规则预过滤(零成本)    │  prefilterMessage() 纯函数
   │   system_role / empty           │
   │   too_short(user≥30, assistant≥15)
   │   trivial_pattern(>60%)        │  → 静默丢弃(不写 audit
   │   only_punct                   │     —— Layer 1 是高频路径)
   │   low_density(<4 tokens)       │
   └────────┬────────────────────────┘
            │ accepted
            ▼
   归簇 + 阈值检查(默认 threshold=3)
            │
            ▼
   ┌─────────────────────────────────┐
   │ Layer 2: 必要性评估              │  NecessityEvaluator.evaluate()
   │                                  │
   │   RuleBasedNecessityEvaluator    │  ← 默认,5 条规则
   │     few_unique_samples /         │     (零 LLM 成本)
   │     high_repetition /            │
   │     too_short /                  │
   │     low_density /                │
   │     trivial_dominated            │
   │          ↓ fallback              │
   │   LlmNecessityEvaluator          │  ← 可选,语义判断
   │     Repeatable + Transferable    │     失败/解析错 → 规则版
   │     + Technical depth            │     → audit: necessity_rejected
   └────────┬────────────────────────┘
            │ necessary=true
            ▼
        生成 Proposal
        (带 necessityReason + suggestedTitle)
```

#### Layer 1:规则预过滤(`prefilterMessage`)

| 规则              | 触发条件                                  | 用途                                   |
| ----------------- | ----------------------------------------- | -------------------------------------- |
| `system_role`     | role === 'system'                         | system 消息不观察(设计意图)            |
| `empty`           | trim 后长度为 0                           | 空消息                                 |
| `too_short`       | user 消息 < 30 chars;assistant < 15 chars | 短确认/问候                            |
| `trivial_pattern` | trivial 词占比 > 60%                      | 识别 `ok ok ok done done` 这类重复琐碎 |
| `only_punct`      | 仅标点/符号                               | 测试输入                               |
| `low_density`     | 去停用词后有效 token < 4                  | 全停用词长字符串                       |

trivial 词集合覆盖中英文(`ok / hello / 测试 / 好的` 等 30 余个),按 token 比例判断,避免漏掉 `ok ok ok ok` 这类整句重复。

#### Layer 2:必要性评估(`NecessityEvaluator`)

**`RuleBasedNecessityEvaluator`(默认,零依赖)** 在 cluster 累积到 threshold 后,从 samples 判断是否值得提案。规则按顺序检查,任一命中即拒绝:

| 规则                 | 触发条件                              | 含义                    |
| -------------------- | ------------------------------------- | ----------------------- |
| `no_samples`         | samples 为空                          | 防御性                  |
| `few_unique_samples` | unique samples < 2 且 occurrences > 1 | 完全雷同(自动重试/粘贴) |
| `high_repetition`    | uniqueRatio < 0.5                     | 机械复制粘贴            |
| `too_short`          | 平均长度 < 30 chars                   | 样本过短                |
| `low_density`        | 平均有效 token < 5                    | 信息密度过低            |
| `trivial_dominated`  | 70%+ samples 命中 trivial             | 琐碎内容主导            |

全部通过 → `necessary=true`,reason 形如 `Passed 5 rule checks: 4 unique samples, avg 100 chars, 27.8 tokens`。

**`LlmNecessityEvaluator`(可选,语义判断)** 宿主注入 `LlmClient` 实例后,会用 LLM 判断"是否值得固化为团队记忆",评估标准:

- **Repeatable**:此话题会在未来对话中反复出现(非一次性任务)
- **Transferable**:解决方案/偏好对其他团队成员或未来会话有用
- **Technical depth**:包含非平凡决策、配置、教训或设计依据

LLM 返回 JSON `{ necessary, reason, suggestedTitle }`。失败(网络/超时/非 JSON)自动 fallback 到 `RuleBasedNecessityEvaluator`,reason 标 `[llm-unavailable, rule-fallback] ...` 或 `[llm-parse-failed, rule-fallback] ...`,保证 proposal engine 始终可用。

### Provider-agnostic LLM 抽象

core 只定义 `LlmClient` 接口(`complete(prompt, opts) → string`),具体 provider 适配由 host 实现:

| Host            | 适配器                            | 配置 fallback                                                           |
| --------------- | --------------------------------- | ----------------------------------------------------------------------- |
| openclaw-plugin | `createOpenAiCompatibleLlmClient` | OpenAI 兼容 `/chat/completions`,fallback 读 `~/.openclaw/openclaw.json` |
| claude-code-mcp | `createAnthropicLlmClient`        | Anthropic Messages API,fallback 读 env `ANTHROPIC_API_KEY`              |

适配器会处理 reasoning 模型(`Qwen3` / `DeepSeek-R1` / `DeepSeek-V4` / `GLM-5.2` / Claude w/ thinking)的响应:content 字段为空时 fallback 读 `reasoning_content` / `thinking` 块,避免 `max_tokens` 不够时被截断。`max_tokens` 设为 1500,留足 reasoning 阶段的预算,保证 content 能正常输出。

### 生命周期

1. **观察**(宿主职责):宿主对每条消息调用 `observe()`
2. **Layer 1 预过滤**:挡机械噪音(静默丢弃 —— Layer 1 每条消息都会触发,记 audit 会让 audit.jsonl 被淹没)
3. **聚类**:增量更新质心
4. **Layer 2 评估**:达到阈值 → 必要性评估 → `audit: necessity_rejected` 或继续
5. **晋升**:检查去重 → 写入候选(带 `necessityReason` + 可选 `suggestedTitle`)
6. **提示**:会话开始 → 宿主注入 `[co-engram] N candidates pending`
7. **分诊**:LLM/用户调用 `engram_list_proposals` → `engram_accept_proposal` 或 `engram_dismiss_proposal`

### 文件

- `topic-clusters.jsonl` —— 聚类状态(质心、出现次数、样本)
- `proposals.jsonl` —— pending/accepted/dismissed 的候选(包含 `necessityReason` / `suggestedTitle` 字段)
- `audit.jsonl` —— 每次 `propose` / `accept` / `dismiss` / `necessity_rejected` / 状态变更都会落到这里

三者都是派生状态。删除它们是安全的 —— 已记录的 engram 不会受影响,引擎会从头开始重新观察。

## 查看器

一个仅绑定 loopback 的 HTTP 服务器,用于在浏览器中浏览数据仓库。默认关闭 —— 通过 `CO_ENGRAM_VIEWER_ENABLED=1`(MCP)或 `startViewer: true`(OpenClaw plugin)启用。

默认端口:`18899`(2026-07 起两宿主统一)。可选 bearer token,通过 `CO_ENGRAM_VIEWER_TOKEN` 设置。

设置细节参见 [host-claude-code.md](./host-claude-code.zh-CN.md) 和 [host-openclaw.md](./host-openclaw.zh-CN.md)。

### 端点

| 方法   | 路径                           | 用途                                                                                                                                                                          |
| ------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/`                            | SPA(htmx + Alpine.js)                                                                                                                                                         |
| GET    | `/api/stats`                   | 总数、按 kind/status 的分布、热门标签                                                                                                                                         |
| GET    | `/api/engrams`                 | 列表,可选 `?kind=` / `?tag=` 过滤                                                                                                                                             |
| GET    | `/api/engrams/:id`             | 单个 engram 的完整详情                                                                                                                                                        |
| PATCH  | `/api/engrams/:id`             | 更新 title/content/importance 等                                                                                                                                              |
| DELETE | `/api/engrams/:id`             | 删除 engram                                                                                                                                                                   |
| GET    | `/api/search?q=`               | FTS 搜索                                                                                                                                                                      |
| GET    | `/api/graph`                   | 图视图的节点 + 边。边携带完整元数据:`id`、`weight`、`evidenceCount`、`direction`、可选的 `resolutionStatus`。节点可选携带 `slug`,用于更友好的显示。                           |
| GET    | `/api/proposals`               | pending 或全部候选                                                                                                                                                            |
| GET    | `/api/audit`                   | 带过滤的审计日志                                                                                                                                                              |
| GET    | `/api/effectiveness?engramId=` | 单个 engram 的有效性报告                                                                                                                                                      |
| GET    | `/api/trash`                   | 回收站中的 engram                                                                                                                                                             |
| GET    | `/api/path-tree?maxDepth=`     | 用于渐进式披露的目录树。返回 `{ enabled, root: { path, engramCount, children } }`。                                                                                           |
| GET    | `/api/doctor?incremental=`     | 触发自愈扫描并返回报告。`incremental=1` 仅做 mtime 增量扫描。返回 `{ enabled, report: { startedAt, finishedAt, totalEngrams, totalSynapses, fixes, pendingManualReview } }`。 |

如果配置了 token,所有 `/api/*` 端点都需要 `Authorization: Bearer <token>`。

### 安全性

查看器只绑定到 `127.0.0.1` —— 不对外暴露。如果在共享主机上运行 co-engram,请设置 `CO_ENGRAM_VIEWER_TOKEN`,以防止其他本地用户访问。
