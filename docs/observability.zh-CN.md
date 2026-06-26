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

默认端口:`18799`。可选 bearer token,通过 `CO_ENGRAM_VIEWER_TOKEN` 设置。

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
