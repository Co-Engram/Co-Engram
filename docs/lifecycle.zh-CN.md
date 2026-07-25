# 实体生命周期

本页系统讲解 co-engram 三类核心实体 —— **engram(记忆印迹)**、**synapse(突触)**、**proposal(候选提案)** —— 从诞生到销毁的完整生命周期,以及在 Claude Code 与 OpenClaw 两种宿主下分别由哪些事件触发。

> 阅读前建议先看过 [核心概念](./concepts.zh-CN.md) 与 [架构](./architecture.zh-CN.md)。

---

## 1. 全景图

```
       用户/LLM 输入                工具调用
              │                       │
              ▼                       ▼
     ┌─────────────────┐     ┌──────────────────┐
     │  ProposalEngine │     │  MCP / 插件工具   │
     │  (被动观察)     │     │  (主动操作)      │
     └────────┬────────┘     └────────┬─────────┘
              │                       │
              ▼                       ▼
        ┌──────────────────────────────────┐
        │     Engram(记忆印迹)            │
        │   draft → active → frozen      │
        │                ↘ forgotten       │
        └──────────────┬───────────────────┘
                       │ synapse_create / 自动
                       ▼
                ┌──────────────┐
                │   Synapse    │
                │ (突触/连接)  │
                └──────────────┘
                       │
                       ▼  contradicts
              ┌──────────────────┐
              │ 矛盾裁决流程     │
              │ pending → ...    │
              │ → resolved       │
              └──────────────────┘

    旁路:ToolCallEvent → 信号抽取 → RPE → 自动强化/衰减
```

三大实体的关系:

- **engram** 是知识本身(声明性记忆)
- **synapse** 是 engram 之间的有类型连接(影响检索加权)
- **proposal** 是 _尚未确认_ 的候选 engram,经用户审批后晋升为 engram

---

## 2. Engram 生命周期

### 2.1 状态枚举(`status`)

`packages/core/src/types/engram.ts:42-46` 定义四个互斥状态:

| 状态        | 含义                                          | 是否参与默认检索 | 文件位置           |
| ----------- | --------------------------------------------- | ---------------- | ------------------ |
| `draft`     | 已创建未激活(预留给未来"草稿"工作流)          | 否               | 主目录             |
| `active`    | 默认状态,正常参与检索                         | 是               | 主目录             |
| `frozen`  | 归档:不参与默认检索,但完全可恢复              | 否               | 主目录             |
| `forgotten` | 遗忘:从所有默认检索移除,30 天后进入 `.trash/` | 否               | 主目录 → `.trash/` |

### 2.2 状态迁移图

```
        engram_create (new)
              │
              ▼
          ┌───────┐  engram_archive   ┌──────────┐
          │active │ ────────────────▶ │ frozen │
          └───┬───┘                   └────┬─────┘
              │                            │
              │ engram_forget              │ engram_restore
              ▼                            │
        ┌───────────┐                      │
        │ forgotten │ ◀────────────────────┘
        └─────┬─────┘
              │ 30 天后 trash sweep
              ▼
        ┌───────────┐  365 天后
        │  .trash/  │ ────────▶ 物理删除
        └───────────┘
              │
              │ engram_restore(任何时刻)
              ▼
          回到 active
```

触发迁移的 MCP 工具(`packages/core/src/tools/engram-tools.ts`):

| 工具             | 起点 → 终点                       | 说明                                                 |
| ---------------- | --------------------------------- | ---------------------------------------------------- |
| `engram_create`  | (无) → `active`                   | 新建;若命中去重则进入 UPDATE/DUPLICATE 分支(见 §2.4) |
| `engram_archive` | `active`/`forgotten` → `frozen` | 仅状态变更,内容不动                                  |
| `engram_forget`  | `active`/`frozen` → `forgotten` | 同时把 freshness 标为 `forgotten`                    |
| `engram_restore` | `frozen`/`forgotten` → `active` | 若文件已在 `.trash/` 还会先物理移回                  |
| `engram_delete`  | 任意 → (物理删除)                 | 硬删除:内容 + 元数据 + 关联 synapse                  |

### 2.3 派生属性 `freshness`

`packages/core/src/lifecycle/freshness.ts` 根据 `lastEffectiveAt`/`createdAt` + 由 `importance` + `kind` 派生的 halfLife(`halfLife = 50 × (importance+0.1)^1.5 × kind 倍率`)实时计算,不持久化:

| 距离 lastEffectiveAt | freshness                          |
| -------------------- | ---------------------------------- |
| ≤ 1 × halflife       | `fresh`                            |
| ≤ 2 ×                | `aging`                            |
| ≤ 4 ×                | `stale`                            |
| > 4 ×                | `forgotten`(进入 trash sweep 候选) |

### 2.4 创建分支:NEW / UPDATE / DUPLICATE

`engram_create` 不是简单的"新建",它会先调用 dedup 检查(`dedup/merge.ts`):

- **NEW**:没有相似 engram → 创建新的 `active` engram
- **UPDATE**:存在高相似 engram,且用户提交的内容是补充 → 合并到现有 engram,`version++`
- **DUPLICATE**:存在高相似 engram,内容等同 → 不创建新 engram,而是 `engram_reinforce` 现有的(避免冗余)

这个分支让重复的捕获请求自动变成强化信号,而不是堆出大量重复记忆。

### 2.5 `verificationStatus` 状态机

`packages/core/src/verification/state-machine.ts:25-105`,严格线性:

```
unverified → plausible → probable → verified

任何非终态 ──refuted──▶ (终态,无法回退)
```

升级条件(`verification/upgrade.ts:10-12`):

| 目标状态    | 必要条件                                                         |
| ----------- | ---------------------------------------------------------------- |
| `plausible` | `evidenceCount ≥ 1`                                              |
| `probable`  | `evidenceCount ≥ 2`,且来自 ≥2 个不同 domain                      |
| `verified`  | `evidenceCount ≥ 3`,且 ≥2 个 domain,且 `ageDays ≥ stabilityDays` |

升级成功还会把 `confidence` +0.2(上限 0.95),经 `applyConfidenceSignal(..., "verify")` 处理;反驳则暴跌至 ×0.3(`upgrade.ts:416-421`)。

降级路径只有一条:REM 阶段的元认知扫描(`verification/metacognition.ts`)计算 truth score,在 `overall confidence < 0.30` 且存在 `contradicts` 突触时**建议**反驳。反驳不再自动落盘——维护引擎改为生成 `rem-verification` 提案,用户在 Proposals 页 accept 后状态才会变更。

### 2.6 自动衰减触发器

以下三种自动路径会把 engram 推向 `frozen`/`forgotten`:

1. **LTD 阈值**(`reinforcement/ltd.ts:96-97`):`failedUses ≥ 3 → shouldArchive`,`≥ 5 → shouldForget`。这是返回给调用方的 _建议标志_,不会自动执行;由维护引擎或上层应用决定。
2. **Deep 阶段衰减**(`dreaming/decay.ts:55,90`):深睡阶段强制检查 `importance < forgetThreshold` 的 engram。
3. **Trash sweep**(`dreaming/trash.ts:131-190`):forgotten 状态超过 30 天的 engram 文件被移到 `.trash/YYYY-MM/`;365 天后物理删除。

---

## 3. Synapse 生命周期

### 3.1 12 种 kind(5 族)

`packages/core/src/types/synapse.ts:16-33`:

| 族         | kind             | 语义                      |
| ---------- | ---------------- | ------------------------- |
| **结构族** | `extends`        | A 在 B 基础上扩展         |
|            | `part_of`        | A 是 B 的组成部分         |
|            | `similar_to`     | A 与 B 语义相近           |
| **因果族** | `depends_on`     | A 的成立依赖 B            |
|            | `causes`         | A 触发或产生 B            |
|            | `follows`        | A 在时间/逻辑上跟随 B     |
| **证据族** | `derives_from`   | A 从 B 推导而来           |
|            | `contradicts`    | A 与 B 相互冲突(进入裁决) |
|            | `exemplifies`    | A 是 B 的具体实例         |
| **时间族** | `supersedes`     | A 取代过时的 B            |
|            | `consolidates`   | A 合并/精炼了 B 的内容    |
| **调节族** | `contextualizes` | A 为 B 提供情境背景       |

### 3.2 检索加权的副作用

当 engram A 被检索时,其邻居获得 Hebbian 式加权(`tools/engram-tools.ts:604` 中的 `engram_reinforce` 实现):

- `extends`、`consolidates` 邻居:**正向加成**(扩展记忆一起被强化)
- `contradicts` 邻居:**抑制**(避免同时推荐冲突结论)

### 3.3 矛盾裁决流程(`contradicts` 专属)

`packages/core/src/contradiction/` 目录实现 4 阶段裁决:

```
   synapse_create(kind='contradicts')
              │
              ▼
        ┌─────────┐
        │ pending │ ──── LLM arbiter 裁决 ────┐
        └─────────┘                           │
              │                                │
       ┌──────┴──────┐                         │
       │             │                         │
       ▼             ▼                         ▼
┌────────────┐  ┌──────────┐           ┌──────────────┐
│auto_resolved│ │escalated │ ─ 7 天超时 ─▶│  contested  │
└────────────┘  └────┬─────┘           └──────┬───────┘
                     │ manualResolve            │
                     │ (contradiction_resolve) │
                     ▼                          ▼
                ┌──────────┐              ┌──────────┐
                │ resolved │ ◀────────────│ resolved │
                └──────────┘              └──────────┘
```

裁决结论(`verdict`)有四种(`auto-degrade.ts:60-67`):

| verdict    | 副作用                          |
| ---------- | ------------------------------- |
| `keep_new` | 旧 engram 标为 `refuted` + 败方 `confidence ×0.3`        |
| `keep_old` | 新 engram 标为 `refuted` + 败方 `confidence ×0.3`        |
| `merge`    | 内容合并到保留方,删除该 synapse |
| `archive`  | 较新方标为 `frozen`           |

**特殊副作用**:创建一个 `contradicts` synapse 时会同时(`synapse-tools.ts:82-94`):

- 写两条 `contradicted` 审计日志
- 触发一个 `-0.8` 的负向行为信号(对相关 engram 施加 LTD 压力)

### 3.4 创建/删除工具

| 工具                           | 作用                                                             |
| ------------------------------ | ---------------------------------------------------------------- |
| `synapse_create`               | 手动创建突触;`contradicts` 会进入裁决流程                        |
| `synapse_delete`               | 删除突触(不会撤销已产生的副作用,如已 refuted 的 engram 不会恢复) |
| `synapse_get` / `synapse_list` | 只读                                                             |
| `contradiction_resolve`        | 用户/所有者手动结束 phase-2 裁决                                 |

> **注意**:目前所有 synapse 都是显式调用 `synapse_create` 创建。维护引擎的 dreaming(抽象)阶段会产生 _新 engram_,但不会自动在现有 engram 之间连边。

---

## 4. Proposal(候选提案)管线

### 4.1 触发源

| 宿主            | 触发点                                                                    | 实现                                                  |
| --------------- | ------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Claude Code** | `UserPromptSubmit` / `Stop` hook 调用 `observe.py`,POST 到 `/api/observe` | `claude-code-mcp/src/hooks/installer.ts:6,70,119-139` |
| **OpenClaw**    | 插件直接监听 `llm_input` / `llm_output` 事件                              | `openclaw-plugin/src/plugin-entry.ts:284-303`         |

两者最终都调用 `proposalEngine.observe({role, message})`(role 为 `user` 或 `assistant`)。

### 4.2 三阶段管线

`packages/core/src/observability/proposal-engine.ts`:

```
1. observe(message)
   ├── 过滤系统消息、过短消息(< 20 字)
   ├── embed via DEFAULT_HASHER_EMBEDDER(256 维哈希 + CJK bigram 切分)
   └── findBestMatch:余弦 ≥ DEFAULT_HASHER_SIMILARITY_THRESHOLD(0.35)视为同主题

2. cluster 阶段
   ├── 命中现有 cluster → 加入并更新质心
   └── 否则 → newCluster

3. maybePromoteToProposal(当 occurrences ≥ threshold,默认 3)
   ├── hasSimilarEngram:关键词子串匹配,≥2 命中则跳过(避免与现有 engram 重复)
   └── 生成 proposal,persist 到 .co-engram/proposals.jsonl
```

**为什么 hash embedder 必须用更低的阈值(0.35,而非 LLM embedding 的 0.75):**
默认 hasher 是 256 维特征哈希 + CJK 字符 bigram。自然语言同义改写的余弦
现实范围是 0.15-0.40(hash 只能抓词面重叠,抓不到语义等价)。LLM embedding
的 0.75 阈值对 hasher 来说根本不可达——proposal 永远不会形成。
`DEFAULT_HASHER_SIMILARITY_THRESHOLD = 0.35` 的取值:足以让"arrow function
偏好"这类技术话题在 3-5 次提及后成簇,又能拒绝无关话题(余弦通常 0.0-0.10)。

**为什么 CJK 文本必须切 bigram:**
`normalize()` 按空白切词,但中文没有词间空白——`"我们以后所有"` 会被当成
一个超大 token。更糟的是,这个超大 token 的 hash 会与其它无关中文句子的 hash
随机碰撞,导致任意两句中文的余弦接近正交,proposal pipeline 在中文场景下
完全失灵。修复:`tokenizeForEmbedding()` 检测 CJK 连续段,切成字符 bigram
(`我们`、`们以`、`以后`、…)。这是无词典中文搜索/聚类的标准零成本方案。

### 4.3 Proposal 状态

`pending | accepted | dismissed`(proposal-engine.ts:68):

| 状态        | 含义                                           |
| ----------- | ---------------------------------------------- |
| `pending`   | 待用户审批                                     |
| `accepted`  | 已通过 `engram_accept_proposal` 晋升为 engram  |
| `dismissed` | 已驳回,**默认永久**不再浮出。设 `dismissDays > 0` 时 N 天后可被新事件重新激活 |

### 4.4 Accept / Dismiss

| 工具                      | 行为                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `engram_accept_proposal`  | 调用 `repository.createEngram` 创建一个 `active` engram;`kind` 由调用方指定(默认 `fact`);原 cluster 从待处理队列移除 |
| `engram_dismiss_proposal` | **默认永久驳回**(`dismissedUntil` 不设置);显式传 `dismissDays > 0` 时 N 天后可重新提升                                   |

### 4.5 kind 推断

proposal 本身没有 `kind` 字段。晋升时由审批者(用户或 LLM)显式传入。Viewer 的抽屉编辑器提供下拉选择;若不传,默认为 `fact`。

### 4.6 外部 Markdown 提案(external-markdown)

除了对话聚类管线(§4.1–4.2),`dataRoot` 下任何裸 `.md` 文件被 watcher 捕获后都会生成一条 pending proposal。提取分两层:有 LLM client 时智能抽取 `title` / `kind` / `domainTags` / `summary`;不可用或失败时降级到规则版(H1 或文件名→`title`,`kind = observation`,`domainTags = ["imported"]`)。因此往 `dataRoot` 丢任何 `.md` 都会在「记忆提案」tab 出现一条 pending proposal,不再被静默忽略。这类提案带 `source: "external-markdown"`,可通过 `engram_accept_proposals_by_source` 批量 accept。

---

## 5. 信号、RPE 与维护引擎

### 5.1 行为信号抽取

`packages/core/src/signals/extract.ts:365`,6 条规则产生 `[-1, 1]` 权重:

| 规则                        | 权重     | 触发条件                                 |
| --------------------------- | -------- | ---------------------------------------- |
| `contradicts_created`       | **-0.8** | 该 engram 被新 synapse `contradicts`     |
| `get_then_immediate_search` | **-0.7** | 检索后立刻又发起另一次检索(说明上次不准) |
| `get_then_action`           | **+0.8** | 检索后紧跟文件编辑 / bash / commit       |
| `repeated_get`              | **+0.6** | 同一 engram 在窗口内被检索 ≥2 次         |
| `user_correction`           | **-0.4** | 用户消息含"不"、"错"、"actually"等纠正词 |
| `get_no_resimilar_search`   | **+0.4** | 检索后没再发起类似检索(够用了)           |

### 5.2 RPE 强化学习

`packages/core/src/signals/rpe.ts:44-90`,神经科学式 RPE(Reward Prediction Error):

```
actual    = (signalSum + 1) / 2     # 归一化到 [0, 1]
expected  = lastRetrievalScore ?? 0.5
rpe       = actual - expected
```

应用规则:

- `|rpe| ≤ 0.05`:死区,不动作
- `rpe > 0.05`(超出预期):`effectiveRetrievals++`,`reinforcementScore += rpe × 0.1`
- `rpe < -0.05`(低于预期):`failedUses++`

### 5.3 维护引擎三阶段

`packages/core/src/maintenance/engine.ts`:

| 阶段      | 默认频率 | 主要动作                                                                                         |
| --------- | -------- | ------------------------------------------------------------------------------------------------ |
| **Light** | 5 分钟   | 抽取信号 → 计算 RPE → 更新 engram `reinforcementScore`/`failedUses` → 刷新 `prompt-signals.json` |
| **Deep**  | 1 小时   | 触发 dreaming(deep):衰减检查 + 抽象新 engram                                                     |
| **REM**   | 1 天     | 触发 dreaming(rem):元认知扫描生成 `rem-verification` / `rem-pattern` 提案(用户 accept 后落盘)      |

阶段切换、阈值均可通过环境变量或配置覆盖。

---

## 6. 工具 → 生命周期映射(standard profile 子集)

> 完整工具签名见 [工具参考](./tool-reference.zh-CN.md)。

| 工具                      | 影响的实体 | 生命周期效果                                                                                |
| ------------------------- | ---------- | ------------------------------------------------------------------------------------------- |
| `engram_search`           | engram     | bumpRetrievalStats + 开启有效性窗口                                                         |
| `engram_get`              | —          | 只读(自适应披露 tier)                                                                       |
| `engram_list`             | —          | 只读                                                                                        |
| `engram_list_paths`       | —          | 只读目录树                                                                                  |
| `engram_create`           | engram     | NEW → `active` / DUPLICATE → reinforce / UPDATE → merge                                     |
| `engram_update`           | engram     | 字段变更,`version++`                                                                        |
| `engram_reinforce`        | engram     | LTP:`effectiveRetrievals++`,`importance += eff × 0.02`(×`min(1, confidence×2)`,confidence<0.5 被抑制),Hebbian 邻居加成 |
| `engram_report_failure`   | engram     | LTD:`failedUses++`,`importance -= 0.03`(×`1+max(0,(0.5-confidence)×2)`,confidence<0.5 加速衰减;escalated 时 ×1.5);返回 `shouldArchive/Forget` 建议 |
| `engram_delete`           | engram     | 硬删除(内容 + 元 + 关联 synapse)                                                            |
| `synapse_create`          | synapse    | 创建连接;`contradicts` 触发裁决流程 + 审计 + 负向信号                                       |
| `close_learning_loop`     | engram     | success → LTP + Hebbian;failure → LTD;partial → 按 effectiveness 缩放 LTP                   |
| `contradiction_resolve`   | synapse    | 手动结束 phase-2 → `resolved`                                                               |
| `engram_list_proposals`   | —          | 读 pending proposal                                                                         |
| `engram_accept_proposal`  | engram     | proposal → `active` engram                                                                  |
| `engram_dismiss_proposal` | proposal   | 默认**永久驳回**(dismissedUntil 留空);显式 `dismissDays > 0` 时 N 天冷却 |
| `engram_doctor`           | (索引)     | 自愈:slug/索引/移动文件修复                                                                 |

**仅 full profile 可见**:`engram_archive`、`engram_restore`、`engram_forget`、`synapse_get/list/delete`、`skill_*`、`upgrade_verification`、`get_evolution_lineage`。这些工具通常由维护引擎或 CLI 触发,不对日常 LLM 暴露。

---

## 7. 宿主集成差异

### 7.1 Claude Code(MCP server)

```
┌──────────────┐  UserPromptSubmit   ┌─────────────┐
│ Claude Code  │ ──────────────────▶ │ observe.py  │
│              │  Stop               │ (hooks)     │
└──────────────┘ ──────────────────▶ └──────┬──────┘
                       ▼                    │
                  settings.json             │ POST /api/observe
                  (auto-injected)           ▼
                                          ┌──────────────────┐
                                          │ viewer /api/observe │
                                          └────────┬─────────┘
                                                   │
                                                   ▼
                                          ┌──────────────────┐
                                          │ proposalEngine   │
                                          │   .observe()     │
                                          └──────────────────┘
```

- **自动启用**:proposal 引擎开启时,viewer 自动启动(`mcp-server.ts:431`)
- **会话注入**:MCP server 启动时查询 `proposalEngine.listPending()`,有 pending 时通过 instructions 注入系统提示(`mcp-server.ts:418-420`),提醒 LLM 在合适时机调用 `engram_accept_proposal` / `engram_dismiss_proposal`
- **失败容忍**:viewer 不可达时,hook 静默 no-op,不影响 Claude Code 正常使用

### 7.2 OpenClaw(插件)

```
┌──────────────────┐   session.new event     ┌──────────────────┐
│  OpenClaw agent  │ ─────────────────────▶  │ enqueueNextTurn  │
│                  │                         │ Injection        │
│                  │   llm_input event       │  (pending 提示)   │
│                  │ ─────────────────────▶  └──────────────────┘
│                  │   llm_output event              │
│                  │                         ┌──────────────────┐
│                  │                         │ proposalEngine   │
│                  │   工具调用事件           │   .observe()     │
│                  │ ─────────────────────▶  └──────────────────┘
└──────────────────┘
        │
        │ 每个工具调用通过 wrapAllToolsWithSignalSink 包装
        ▼
┌──────────────────┐   signalSink.jsonl    ┌──────────────────┐
│  Maintenance     │ ────────────────────▶ │ RPE 更新 engram  │
│  Engine          │                        │ importance/score │
└──────────────────┘                        └──────────────────┘
```

主要差异:

- **无文件 hook**:不依赖 `observe.py`,所有事件在进程内通过插件 SDK 直接消费(`plugin-entry.ts:251-304`)
- **工具调用拦截**:`wrapAllToolsWithSignalSink`(`plugin-entry.ts:208`)包装每个工具调用,自动写入 `signals.jsonl`,供维护引擎消费
- **可选内置维护**:`startMaintenance: true` 时(`plugin-entry.ts:236`),三阶段调度器在插件进程内运行,无需外部 cron

### 7.3 关键差异表

| 维度      | Claude Code                                    | OpenClaw                         |
| --------- | ---------------------------------------------- | -------------------------------- |
| 事件接入  | 文件 hook(python) + HTTP                       | 进程内事件监听                   |
| 信号 sink | 文件(`.co-engram/signals.jsonl`)由维护引擎读取 | 同上(同一路径,两端共享)          |
| 维护调度  | MCP server 启动时内置                          | 可选内置,或外部触发              |
| 失败容忍  | viewer 不可达 → hook no-op                     | 插件内组件故障 → 由插件 SDK 处理 |
| 部署单元  | 单独 `mcp-server` 进程                         | openclaw agent 进程内            |

---

## 8. 典型场景走查

### 8.1 用户表达一个偏好(产生 proposal)

```
用户对话:"以后我们项目用 arrow function,不用 function 关键字"
   │
   ▼  UserPromptSubmit hook
proposalEngine.observe({role:'user', message:'...'})
   │
   ▼  第 1 次:新建 cluster
   ▼  第 2 次:加入同 cluster
   ▼  第 3 次:occurrences ≥ 3
maybePromoteToProposal → pending proposal
   │
   ▼  下次会话开始
LLM 收到 system prompt 注入:"有 N 条 pending proposal"
   │
   ▼  LLM 调用 engram_list_proposals / engram_accept_proposal
新 engram 诞生,kind=pattern,status=active
```

### 8.2 LLM 检索不准(自动衰减)

```
LLM 调用 engram_search("PostgreSQL 配置")
   │
   ▼  返回 engram X
LLM 立刻又 engram_search("PG 配置 password")   ← 不同关键词
   │
   ▼  信号抽取:get_then_immediate_search(-0.7)
RPE 计算:actual=0.15,expected=0.5,rpe=-0.35
   │
   ▼  failedUses += 1, importance -= 0.03
   ▼  若 failedUses ≥ 3 → shouldArchive 标志
   ▼  若 failedUses ≥ 5 → shouldForget 标志
维护引擎据标志迁移状态(archive/forget)
```

### 8.3 发现矛盾(裁决流程)

```
用户对话:"我们已经不用 Redis 了,改用 Postgres"
   │
   ▼  LLM 检索到旧 engram "项目用 Redis 做缓存"
LLM 调用 engram_create({title:'改用 Postgres', content:'...'})
   │
   ▼  LLM 调用 synapse_create({from:new, to:old, kind:'contradicts'})
进入 pending 状态,LLM arbiter 启动 phase-1
   │
   ▼  若 LLM 无法裁决 → escalated(等所有者)
   │
   ▼  用户调用 contradiction_resolve({verdict:'keep_new'})
旧 engram 标 refuted,synapse 转 resolved
```

### 8.4 维护引擎清理(forgotten → trash)

```
engram_report_failure 多次触发后 failedUses ≥ 5
   │
   ▼  shouldForget 标志返回
用户/维护引擎调用 engram_forget
   │
   ▼  状态 forgotten,freshness forgotten
30 天后...
   │
   ▼  deep 阶段 trash sweep
文件移动到 .trash/2026-06/
365 天后...
   │
   ▼  物理删除
```

---

## 9. 相关文档

- [核心概念](./concepts.zh-CN.md) — 实体定义与字段
- [架构](./architecture.zh-CN.md) — 多层设计与数据流
- [维护引擎](./maintenance-engine.zh-CN.md) — light/deep/rem 阶段细节
- [工具参考](./tool-reference.zh-CN.md) — 29 个工具完整签名
- [Claude Code 集成](./host-claude-code.zh-CN.md)
- [OpenClaw 集成](./host-openclaw.zh-CN.md)
- [可观测性](./observability.zh-CN.md) — 审计日志、viewer

---

## 10. 可执行文档

本文档中的阈值、枚举数、管线时长等关键数值,由**可执行文档测试**自动校验,
位于 [`packages/core/test/lifecycle-doc.test.ts`](../packages/core/test/lifecycle-doc.test.ts)。
任何数值漂移(例如 `DEFAULT_FORGET_THRESHOLD` 从 5 改为其他值,或 AuditAction
枚举增长超过 25 种),测试会失败,强制同步更新文档。

运行:`pnpm --filter @co-engram/core test test/lifecycle-doc.test.ts`
