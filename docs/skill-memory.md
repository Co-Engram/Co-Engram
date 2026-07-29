# Skill Memory

Co-Engram 的 Skill 记忆系统是对 **程序性记忆**（"怎么做"）的建模，与 Engram（陈述性记忆，"是什么"）对称。Skill 捕获可复用的流程、模式和操作能力，科学根基来自认知科学：

- **ACT-R utility**（动力学）：Rescorla-Wagner 强化学习模型
- **Oblivion retention**（衰退）：遗忘曲线，时间强度衰减
- **Options 三元组**（结构）：initiation set（触发条件）+ policy（执行策略）+ termination（终止条件）

## 核心概念

### 三层分离

Skill 系统采用三层架构，关注点分离：

1. **本体**：不变的 Skill 标识与核心语义（skillId、initiation set、termination）
2. **投影**：运行时动态计算的可变属性（utility、retention stage、acquisition stage）
3. **载体**：可插拔的执行策略（Claude Skill、OpenClaw Skill、prompt、code、workflow）

这种分离让同一个 Skill 可以适配不同宿主（Claude Code vs OpenClaw），而不变的核心语义保持稳定。

### 与 Engram 的对称关系

| 维度 | Engram（陈述性记忆） | Skill（程序性记忆） |
|------|---------------------|-------------------|
| **内容** | "是什么"（事实、模式、决策） | "怎么做"（流程、操作、能力） |
| **科学根基** | 重要性（importance）+ 有效性验证 | 效用值（utility）+ 成功率 |
| **遗忘机制** | fresh/stale 生命周期 + failedUses | Oblivion retention 时间衰减 |
| **存储** | 单文件 Markdown（YAML frontmatter + body） | sidecar `imprint.json`（JSON，不碰本体 SKILL.md） |
| **检测** | proposal engine（两层过滤） | 任意 SKILL.md 目录 → 自动提案 |
| **组合** | synapse graph（12 种边类型） | composes 关系（skill chaining） |

## 数据模型

### SkillImprint 结构

Skill 的持久化存储在 sidecar `imprint.json` 中（不修改 SKILL.md 本体，D6 约束）：

```typescript
interface SkillImprint {
  readonly schemaVersion: 1;
  readonly skillId: string;                          // 稳定标识
  readonly sourcePath: string;                       // SKILL.md 路径（只读引用）
  readonly contentHash: string;                      // policy 哈希（变化检测）
  readonly initiationSet: string;                    // Options 三元组：触发条件
  readonly termination: string;                       // Options 三元组：终止条件
  readonly policy: SkillPolicy;                      // Options 三元组：执行策略
  readonly utility: number;                          // ACT-R utility [0,1]
  readonly sampleSize: number;                       // 调用次数（n）
  readonly invocationCount: number;                  // 总调用次数
  readonly successCount: number;                     // 成功次数
  readonly failureCount: number;                     // 失败次数
  readonly lastUsedAt: string | null;               // 最后使用时间
  readonly acquisitionStage: AcquisitionStage;       // 习得深度轴
  readonly retentionStage: RetentionStage;           // 衰退阶段
  readonly visibility: "public" | "team" | "private";
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
  readonly composes: readonly SkillId[];             // 组合关系（skill chaining）
  readonly relatedEngrams: readonly EngramId[];      // 关联陈述性记忆
}
```

### 存储位置

Sidecar `imprint.json` 存储在两个位置（优先级从高到低）：

1. **Skill 本体目录**：`<skill-dir>/.co-engram/imprint.json`（首选）
2. **数据根目录**：`<dataRoot>/skills/<skillId>/imprint.json`（兜底，当本体目录不可写时）

这种设计让 team-memory 的 skill 可以分发到宿主目录（`~/.claude/skills`、`~/.openclaw/skills`），而用户工作目录的 skill 保持优先。

## 全链路

### 1. 检测（自动提案）

Co-Engram 会自动扫描包含 `SKILL.md` 的目录（不绑死特定路径），为每个 Skill 创建提案：

- **触发条件**：目录下存在 `SKILL.md` 或 `skill.md` 文件
- **提案生成**：解析 frontmatter（name、description 等），生成 draft Skill 实体
- **解冲突策略**（D11）：team-memory skill 分发到宿主目录时，不覆盖工作目录原有 skill（复制非软链）

提案会出现在 viewer 的 **Proposals** 页面，等待用户审批。

### 2. 接受（落盘）

用户审批提案后，Skill 实体写入 sidecar `imprint.json`：

- **初始状态**：`acquisitionStage = "draft"`，`utility = 0.5`（初始效用）
- **关联建立**：自动关联相关的 engram（程序性 ↔ 陈述性记忆链接）
- **可见性**：根据来源设置 `visibility`（team-memory 默认 `team`，本地 skill 默认 `private`）

### 3. 调用（强化）

当宿主（Claude Code / OpenClaw）执行 Skill 时，调用 `skill_invoke` 记录使用结果：

- **Rescorla-Wagner 更新**：`utility(n+1) = utility(n) + α × [reward - utility(n)]`
- **成功率追踪**：`successCount` / `failureCount` 累积
- **衰退重算**：基于 `lastUsedAt` 和 `utility` 重新计算 `retentionStage`

调用示例：

```typescript
skill_invoke({
  id: "superpowers-writing-plans",
  success: true,
  effectiveness: 0.9  // 可选：执行效果评分 [0,1]
})
```

### 4. 衰退（遗忘）

**Oblivion 遗忘曲线**：`retention = exp(-n/S)`，其中：

- `n` = 距离上次使用的天数
- `S` = `(utility + frequency + ε) × T`（记忆强度）
- `T = 10`（时间尺度常数）
- `frequency = min(invocationCount / 20, 1)`（频率归一化）

**衰退阶段**（`retentionStage`）：

| 阶段 | retention 阈值 | 行为 |
|------|---------------|------|
| `active` | > 0.75 | 正常调用，utility 全强度更新 |
| `aging` | 0.5 - 0.75 | utility 更新衰减 |
| `stale` | 0.25 - 0.5 | 仅记录调用，不更新 utility |
| `forgotten` | < 0.25 | 禁止调用，需重新实例化或恢复 |

**周期性重算**：maintenance engine 的 **light stage**（每 5 分钟）调用 `recomputeRetentionAll()`，批量更新所有 skill 的 `retentionStage`。

**重要**：`forgotten` 只改变投影状态，不物理删除 sidecar 或本体。用户可通过 `skill_update` 手动恢复 `acquisitionStage` 重新激活。

### 5. 组合（Skill Chaining）

Skill 可以通过 `composes` 关系形成 **Skill Chaining**（高级技能由基础技能组合）：

```typescript
skill_compose_add({
  skillId: "superpowers-dispatching-parallel-agents",
  targetSkillId: "deep-research"  // 高级 skill 包含基础 skill
})
```

**设计原则**：

- **建议模式**：`composes` 关系只是候选建议，不自动构建 workflow
- **去重**：已存在的组合关系不会重复添加
- **双向可见**：viewer 的 Skill tab 显示 "composes" 和 "composed_by" 列表

## 习得深度轴（Acquisition Stage）

基于 **ACT-R compilation** 理论，Skill 习得沿单向路径演进：

```
draft → compiled → tuned
```

| 阶段 | 含义 | 迁移条件 |
|------|------|----------|
| `draft` | 新捕获，未验证 | 用户手动迁移 `skill_update({ acquisitionStage: "compiled" })` |
| `compiled` | 已验证，可用 | 成功调用 ≥ 10 次且 utility > 0.7（建议阈值，非强制） |
| `tuned` | 高度优化，稳定 | 长期高 utility 且低 variance（未来可自动检测） |

**重要约束**：单向不可逆。`tuned` 不能退回 `compiled`，`compiled` 不能退回 `draft`（防止误操作导致经验丢失）。

## 工具集

Co-Engram 提供 9 个 Skill 工具（standard profile）：

| 工具 | 功能 | 审计 action |
|------|------|-------------|
| `skill_create` | 创建 Skill 实体（从提案或手动） | `skill_create` |
| `skill_get` | 读取 Skill 元信息与印迹 | — |
| `skill_list` | 列出所有 Skill，可按 stage 过滤 | — |
| `skill_update` | 更新 initiationSet/termination/policy 或迁移 acquisitionStage | `skill_update` |
| `skill_delete` | 删除 sidecar（不动 SKILL.md） | `skill_delete` |
| `skill_invoke` | 记录使用结果，更新 utility + retention | `skill_invoke` |
| `skill_compose_add` | 加组合关系 | `skill_compose_add` |
| `skill_compose_remove` | 移除组合关系 | `skill_compose_remove` |
| `skill_compose_list` | 列出组合关系 | — |

**审计日志**：所有写操作（`create`/`update`/`delete`/`invoke`/`compose_add`/`compose_remove`）都会写入 `audit.jsonl`，可通过 viewer 的 **Audit** 页面或 `engram_audit_query` 工具查询。

## Viewer 集成

### Skill Tab（D10 对称 Engram 前端）

Viewer 的 **Skill** tab 提供与 Engram tab 对称的 UI：

- **列表视图**：显示所有 Skill，可按 `acquisitionStage`/`retentionStage`/`visibility` 过滤
- **详情视图**：显示 SkillImprint 完整内容，包括 `utility` 趋势图、调用统计、组合关系
- **关联视图**：显示 `relatedEngrams`（程序性 ↔ 陈述性记忆链接）

### API 端点

- `GET /api/skills`：列出所有 Skill（支持过滤）
- `GET /api/skills/:id`：读取单个 Skill 详情
- `POST /api/skills`：创建 Skill（内部使用，对应 `skill_create`）

### Stats 维度

Viewer 的 **Stats** tab 新增 Skill 维度：

- **总数**：active / aging / stale / forgotten 的分布
- **平均 utility**：所有 Skill 的平均效用值
- **调用统计**：总调用次数、成功率、最后活跃时间

## 科学根基

### ACT-R Utility（Rescorla-Wagner）

**强化学习公式**：`U(n+1) = U(n) + α × [R(n) - U(n)]`

- `U(n)`：第 n 次调用后的效用值
- `R(n)`：第 n 次的奖励（成功 = `effectiveness`，失败 = 0）
- `α`：学习率（默认 0.1）

**性质**：

- **初始值**：`U(0) = 0.5`（中性偏好）
- **上界**：`U ∈ [0, 1]`（clamp 保护）
- **收敛**：持续成功时渐进接近奖励值
- **惩罚**：失败时快速下降

### Oblivion Retention

**遗忘曲线**：`retention = exp(-n/S)`

- `n`：距上次使用天数
- `S`：记忆强度 = `(utility + frequency + ε) × T`

**关键参数**：

- `T = 10`：时间尺度常数
- `ε = 0.1`：防零除数
- `frequency = min(invocationCount / 20, 1)`：频率归一化，上限 20 次

**直观理解**：

- 高 utility + 高频率 → `S` 大 → 遗忘慢
- 低 utility + 低频率 → `S` 小 → 遗忘快
- 刚调用完（`n = 0`）→ `retention = 1.0`（完全保留）

### Options Framework

**三元组结构**（来自认知科学的 Options 理论）：

1. **Initiation Set**：触发条件（何时开始执行）
2. **Policy**：执行策略（如何执行，可插拔载体）
3. **Termination**：终止条件（何时停止）

**设计优势**：

- **触发条件外显**：不依赖隐式调用模式
- **策略可插拔**：同一 Skill 可适配不同宿主（Claude Skill vs OpenClaw Skill vs prompt）
- **终止条件明确**：防止无限循环或资源泄漏

## 使用场景

### 1. 捕获团队流程

当团队反复执行某操作（如 code review 流程、部署检查清单），捕获为 Skill：

```markdown
<!-- SKILL.md -->
---
name: code-review-checklist
description: 标准 code review 流程
kind: claude-skill
---

1. 检查是否有对应测试
2. 验证逻辑是否正确
3. 检查性能影响
4. 确认安全性问题
```

Co-Engram 自动提案 → 用户审批 → 后续调用自动强化。

### 2. Superpowers 集成

Superpowers 技能（如 `superpowers-writing-plans`）可被 Co-Engram 自动检测并导入：

- **检测路径**：`~/.claude/skills/superpowers-writing-plans/SKILL.md`
- **自动关联**：Skill 的 `relatedEngrams` 自动链接相关 engram（如设计决策、最佳实践）
- **调用记录**：每次使用 Superpowers 调用 `skill_invoke`，记录成功/失败

### 3. 跨宿主复用

同一 Skill 在不同宿主间保持语义一致：

- **Claude Code**：`policy.kind = "claude-skill"`
- **OpenClaw**：`policy.kind = "openclaw-skill"`
- **通用 prompt**：`policy.kind = "prompt"`

sidecar `imprint.json` 记录的 `utility` 和调用统计跨宿主共享。

## 维护与优化

### 自动维护（Maintenance Engine）

**Light Stage**（每 5 分钟）：

- 调用 `recomputeRetentionAll()`，批量更新 `retentionStage`
- 基于 `lastUsedAt` 和当前时间重算遗忘曲线

**建议**（未来增强）：

- **Deep Stage**：检测 `forgotten` skill，提示用户是否删除或恢复
- **REM Stage**：分析 skill 调用模式，建议优化 initiation set 或 policy

### 手动优化

用户可通过 `skill_update` 手动调整：

```typescript
skill_update({
  id: "my-skill",
  acquisitionStage: "compiled",  // 手动迁移习得深度
  initiationSet: "updated triggers",  // 优化触发条件
  policy: { kind: "prompt", ref: "improved-prompt" }  // 切换执行策略
})
```

## 最佳实践

### 1. 初始捕获

- **明确 initiation set**：不要过度宽泛（避免误触发）或过度狭窄（降低召回）
- **选择合适载体**：简单流程用 `prompt`，复杂交互用 `claude-skill`
- **设置可见性**：team 共享流程用 `team`，个人偏好用 `private`

### 2. 持续优化

- **观察 utility 趋势**：viewer 显示 utility 曲线，判断 Skill 是否有效
- **监控成功率**：`failureCount` 上升时考虑调整 policy 或 termination
- **组合基础技能**：通过 `composes` 构建高级 Skill（如 "release-management" 包含 "testing" + "deployment"）

### 3. 遗忘管理

- **定期 review forgotten**：检查 `retentionStage = "forgotten"` 的 Skill，决定是否恢复
- **重新激活**：`skill_update({ acquisitionStage: "draft" })` 重新开始习得流程
- **归档无用 Skill**：`skill_delete` 清理不再需要的 sidecar（SKILL.md 本体不受影响）

## 参考文档

- [Skill Schema](./data-format.md#skill-imprint)（完整数据模型）
- [Tool Reference](./tool-reference.md#skill-tools)（工具详细文档）
- [Maintenance Engine](./maintenance-engine.md)（自动维护机制）
- [Architecture](./architecture.md)（系统架构）
