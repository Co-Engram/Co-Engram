# 核心概念

本页定义了贯穿代码库和文档的词汇。

## Engram

记忆的原子单位。灵感来自神经科学术语 "engram" — 记忆在大脑中的物理痕迹。

**结构:**

- `id` — ULID,可按创建时间排序
- `title` — 简短的人类可读标签
- `content` — Markdown 正文(实际的记忆内容)
- `summary` — 可选的自动生成摘要
- `kind` — 取值为 `observation` / `fact` / `pattern` / `procedure` / `hypothesis` 之一
- `domainTags` — 该 engram 所属的领域数组(例如 `["backend", "rust"]`)
- `contextTags` — 可选的情境标签
- `importance` — 浮点数 `[0, 1]`,由 personal/team/project/network/temporal 综合得出
- `confidence` — 浮点数 `[0, 1]`,表示我们对其为真的确定程度
- `verificationStatus` — `unverified` → `plausible` → `probable` → `verified`(或 `refuted`)
- `visibility` — `public` / `team` / `private` / `restricted`
- `createdBy` / `createdAt` / `updatedBy` / `updatedAt`

**存储:** 单个 Markdown 文件,位于 `<domainTags>/<slug>.md`(YAML frontmatter + 正文)— 详见 [data-format](./data-format.zh-CN.md)。

**生命周期:** create → reinforce/use → archive/forget/restore。参见 `engram_create`、`engram_archive`、`engram_forget`、`engram_restore`。

## Synapse

两个 engram 之间的有类型的、有方向的连接。以神经元之间的突触连接命名。

**结构:**

- `from` / `to` — engram ID
- `kind` — 取值之一为:
  - `extends` — A 在 B 的基础上构建
  - `part_of` — A 是 B 的组成部分
  - `similar_to` — A 和 B 描述相关现象
  - `depends_on` — A 依赖 B
  - `causes` — A 触发 B
  - `follows` — 时序上的先后 A → B
  - `derives_from` — A 派生自 B(来源)
  - `contradicts` — A 与 B 冲突(触发仲裁)
  - `exemplifies` — A 是 B 的示例
  - `supersedes` — A 取代 B
  - `consolidates` — A 合并了多个 B
  - `contextualizes` — A 为 B 提供上下文
- `weight` — 浮点数 `[0, 1]`
- `direction` — `directional` 或 `bidirectional`
- `evidence` — `{ description, source, confidence, addedBy }` 数组

**对检索的影响:** 当某个 engram 被检索到时,其 `extends`/`consolidates` 邻居会获得相关性加成(类似 Hebbian 强化)。`contradicts` 邻居则会被抑制。

## Skill

一种**过程性**记忆 — "如何做某事"。与 engram(陈述性记忆 — "什么是真的")互补。

**结构:**

- `id` — 稳定的标识符
- `template` — 工具序列或提示词模板
- `trigger` — 何时激活该 skill
- `args` — 预期的输入形状

**工具:** `skill_get`、`skill_invoke`。引擎会根据调用方提供的 `args` 解析模板变量,并渲染步骤列表;skill 本身以 YAML 文件形式编写,位于 `skills/` 下。

## Signal

从工具调用事件中提取的行为观察,供维护引擎使用。

**来源事件**(`ToolCallEvent`):

- `toolName` — 例如 `engram_get`
- `input` / `outputSummary`
- `retrievedEngramIds` — 触达了哪些 engram
- `sessionId` / `at`

**提取的信号**(`BehavioralSignal`):

- `engramId`
- `weight` — `[-1, 1]`,正数 = 有用,负数 = 有害
- `source` — 规则名称(见下文)

**内置规则**(位于 `signals/extract.ts`):
| 规则 | 权重 | 触发条件 |
|---|---|---|
| `repeated_get` | +0.6 | 同一 engram 在一个窗口内被检索 ≥2 次 |
| `get_followed_by_action` | +0.8 | 检索后跟随文件编辑 / bash / 提交 |
| `get_followed_by_no_search` | +0.4 | 检索后没有跟随另一次搜索(已经够用) |
| `get_then_immediate_search` | -0.7 | 检索后立刻又搜索(匹配错了) |
| `user_correction` | -0.4 | 用户消息包含纠正性词汇("no"、"wrong"、"actually") |
| `contradicts_created` | -0.8 | 针对该 engram 创建了 `contradicts` synapse |

## RPE(Reward Prediction Error)

用于更新 `reinforcementScore` 的学习信号。借自神经科学 — 当实际奖励超过预期时,多巴胺神经元会放电。

**公式:**

```
actual  = (clamp(signalWeight, -1, 1) + 1) / 2    // normalized to [0, 1]
rpe     = actual - expected                        // expected = retrievalScore at retrieval time
```

**应用:**

- `rpe > 0.05`:提升 `effectiveRetrievals`,`reinforcementScore += rpe * learningRate`
- `rpe < -0.05`:提升 `failedUses`,`reinforcementScore += rpe * learningRate`
- `|rpe| ≤ 0.05`:中性,不更新

**学习率**默认为 `0.1` — 可通过 `CO_ENGRAM_MAINTENANCE_LEARNING_RATE` 调整。

## Metacognition

在 REM 维护阶段运行的五维真值评分系统。决定是否升级或反驳某个 engram 的 `verificationStatus`。

**维度:**
| 维度 | 权重 | 衡量内容 |
|---|---|---|
| 跨上下文稳定性 | 0.30 | 该 engram 出现在多少个不同的领域中 |
| 时间稳定性 | 0.25 | 自创建以来经过的时间(30 天后饱和) |
| 相互支持度 | 0.25 | `extends`/`consolidates` 与 `contradicts` synapse 的比率 |
| 来源可靠性 | 0.20 | 创建者的可信度得分 |
| 可执行(仅 procedure) | gate | 该 procedure 是否被成功调用过 |

**判定阈值:**

- `overall ≥ 0.85` 且年龄 ≥ 7 天 → 升级为 `verified`
- `overall ≥ 0.70` → 升级一级
- `overall < 0.30` 且存在 `contradicts` → `refuted`
- 其他 → 保持不变

## 验证状态机

```
                   ┌──────────────────┐
                   │   unverified     │ ← default for new engrams
                   └────────┬─────────┘
                            │ upgrade
                            ▼
                   ┌──────────────────┐
                   │    plausible     │
                   └────────┬─────────┘
                            │ upgrade
                            ▼
                   ┌──────────────────┐
                   │    probable      │
                   └────────┬─────────┘
                            │ upgrade (with evidence)
                            ▼
                   ┌──────────────────┐
                   │    verified      │
                   └──────────────────┘

         (any state can transition to refuted via metacognition)
```

状态机强制约束 — 不带 `force: true` 的 `upgrade_verification` 不能跨级。

## 相关文档

- [工具参考](./tool-reference.zh-CN.md) — 如何通过 MCP/plugin 实际调用这些工具
- [维护引擎](./maintenance-engine.zh-CN.md) — 信号、RPE、metacognition 如何被调度
- [设计依据](./design-rationale.zh-CN.md) — 这些概念为何被设计成这样
