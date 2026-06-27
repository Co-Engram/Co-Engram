# Git Merge Driver for Team Memory

**Date:** 2026-06-26
**Status:** Draft — awaiting user review
**Author:** Yang Yang + Claude (brainstorming)
**Packages affected:** `@co-engram/core`, `@co-engram/openclaw-plugin`, `@co-engram/claude-code-mcp`
**Estimated effort:** 4-5 weeks (4 phased milestones)

---

## 1. Background & Motivation

co-engram 团队记忆目录用 git 管理时,每个 engram 是单 `.md` 文件(含 YAML frontmatter),每个 synapse 是 `synapses/{kind}/syn-{hash}.yaml` 单文件。多人协作下,**同一 engram 或 synapse 被双方修改**会产生 git content conflict。

50 人协作场景建模(详见 §9.1):

- 仓库稳态 ~1000 engram,每人每天 ~2.4 次修改命中已存在 engram
- 同窗口(2-3h)同 engram 双方修改概率 ~4.5%/天
- 不介入时,**每年 ~17 次 git 冲突事件**

绝大多数冲突是机械可解的(reinforce 走统计字段累加、不同字段双方改走 git 自身 3-way、同字段双方改走 `updatedAt` 仲裁)。本设计目标:**自动解决 95%+ 的冲突,人工介入率 < 5%**。

## 2. Goals & Non-Goals

### Goals

1. 自动解决 engram + synapse 文件的内容冲突,无需用户手动 resolve
2. 数据安全:**任何不确定都 fallback 到 git 默认 conflict marker**,绝不静默丢失数据
3. 零手动接入:onboard 自动配置,日常 git 操作完全透明
4. LLM 仲裁作为 updatedAt 仲裁的兜底,默认开启(已配置 API key 时)
5. 备份兜底:输方版本写 `.co-engram/merge-backup/`,7 天清理
6. 全量审计:每次自动解决落 audit,可追溯

### Non-Goals

1. 处理 add/add(路径碰撞)、rename/delete、kind 变化等"非内容冲突"—— git 原生处理
2. 处理 `.co-engram/` 派生数据(`audit.jsonl` / `digest.jsonl` / `graph.json` 等)—— 已 gitignored
3. 跨仓库 / 跨远程的同步逻辑 —— 只处理单仓库内的 git merge
4. 替代 git 的 3-way merge —— 复用 `git merge-file`,只在它产生 marker 时介入

## 3. High-Level Architecture

```
git pull / merge / rebase / cherry-pick / stash pop
       │
       ▼  .gitattributes 匹配文件类型(*.md / synapses/*.yaml)
┌──────────────────────────────────────────────────┐
│  Git merge driver "co-engram"                     │
│  (注册于 .git/config,name = driver 脚本路径)      │
└──────────────────────────────────────────────────┘
       │  exec %O %A %B %L %P  (base/ours/theirs/marker-size/path)
       ▼
┌──────────────────────────────────────────────────┐
│  Driver CLI 入口(driver-main.ts bundle 成单 JS)  │
│  按 %P 路由:engram vs synapse vs 其他 .md         │
└──────────────────────────────────────────────────┘
       │
       ├─→ EngramMerger   ──→ FrontmatterMerger(YAML AST 逐字段)
       │                  └─→ ContentMerger(段落级 3-way)
       │
       ├─→ SynapseMerger  ──→ evidence 数组 union
       │                  └─→ resolutionState 状态机合并
       │
       └─→ LlmArbiter(Layer A 解决不了时介入,默认 ON)

三层仲裁:
  Layer A: updatedAt 仲裁(机械,99%)
  Layer B: LLM 仲裁(默认 ON,失败降级)
  Layer C: 留 git marker + 升级人工

副作用(成功解决冲突时):
  • 输方版本写 .co-engram/merge-backup/{YYYYMMDD}/{path}(7 天 TTL)
  • audit action: merge_resolved / merge_llm_arbitrated
```

### Module Layout

| 模块                 | 路径                                                            | 职责                                              |
| -------------------- | --------------------------------------------------------------- | ------------------------------------------------- |
| Driver 入口          | `packages/core/src/merge/driver-main.ts`                        | CLI shim,读 git 参数,路由                         |
| EngramMerger         | `packages/core/src/merge/merge-engram.ts`                       | engram 文件合并入口                               |
| SynapseMerger        | `packages/core/src/merge/merge-synapse.ts`                      | synapse 文件合并入口                              |
| FrontmatterMerger    | `packages/core/src/merge/frontmatter.ts`                        | YAML AST 逐字段合并                               |
| ContentMerger        | `packages/core/src/merge/content.ts`                            | content body 段落级 3-way                         |
| LlmArbiter           | `packages/core/src/merge/llm-arbiter.ts`                        | LLM 仲裁;失败 fallback                            |
| CrossFileCoordinator | `packages/core/src/merge/cross-file.ts`                         | refuted/superseded 状态联动(post-merge pass)      |
| Backup               | `packages/core/src/merge/backup.ts`                             | 输方版本快照 + 7 天 TTL                           |
| Onboard              | `packages/{openclaw-plugin,claude-code-mcp}/src/onboard/git.ts` | 安装 .gitattributes + .git/config + driver bundle |

### Core Principle

**Driver 是"尽力而为"** —— 任何不确定都 fallback 到 git 默认行为,绝不静默丢失数据。备份兜底 + audit 永远落盘。

## 4. Engram Merge Algorithm

**输入**:base / ours / theirs 三个 engram 文件版本(markdown + YAML frontmatter)
**输出**:合并后的完整文件内容,写到 `%A`(git 约定)

### 4.1 Five-Step Flow

1. **解析三方** → 调 `parseEngramFile()` 拆成 `{ frontmatter, content }`。任一方解析失败 → 留 marker,退出 1
2. **frontmatter 按字段语义分类合并**(关键 —— 不是所有字段同一规则)
3. **content 段落级合并**(下方 4.3)
4. **updatedAt 仲裁**(冲突字段的默认仲裁规则,下方 4.4)
5. **收尾重算 + 输出**(下方 4.5)

### 4.2 Frontmatter Field Classification

| 字段类             | 字段                                                                                                                                                                                                                             | 合并规则                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **不可变**         | `id` `createdAt` `createdBy`                                                                                                                                                                                                     | 始终用 base;ours/theirs 改了 → 留 marker(异常信号) |
| **数值累加**       | `retrievalCount` `effectiveRetrievals` `failedUses` `reinforcementScore` `evidenceCount`                                                                                                                                         | `merged = ours + theirs - base`(避免重复计数)      |
| **取 max**         | `updatedAt` `lastRetrievedAt` `lastEffectiveAt` `version`                                                                                                                                                                        | `max(ours, theirs)`                                |
| **updatedAt 仲裁** | `title` `summary` `kind` `kinds` `importance` `confidence` `emotionalValence` `decayHalfLifeDays` `visibility` `status` `forcedFreshness` `verificationStatus` `encodingContext` `perspective` `domainTags` `contextTags` `tags` | 三方 3-way;双方都改且不等 → 走 §4.4 仲裁           |
| **重新计算**       | `contentHash` `contentSize`                                                                                                                                                                                                      | content 合并后重算                                 |
| **遗留派生**       | `outgoingSynapseCount` `incomingSynapseCount` `activeContradictionCount`                                                                                                                                                         | frontmatter 里如存在,删掉(由 repository 重建)      |

**统计字段走累加**是关键决策 —— `engram_reinforce` 在两个用户机器上各跑一次,合并应该是 +2 而不是"取赢家的 +1"。否则会丢检索计数。

### 4.3 Content Body Paragraph-Level Merge

```
1. 先调 git merge-file -p --diff3 ours.tmp base.tmp theirs.tmp
2. 如果 exit 0 → 直接用输出作为 merged content
3. 如果输出含 <<<<<<< marker → content 真冲突
   → fallback updatedAt(整段 content 取赢家)
   → 输方完整 content 备份到 .co-engram/merge-backup/
   → updatedAt 一致(秒级碰撞)→ 走 LLM 仲裁(§5)
```

### 4.4 updatedAt Arbitration Rules

适用于"updatedAt 仲裁"类字段的双方冲突:

```
if ours.updatedAt > theirs.updatedAt: winner = ours
elif theirs.updatedAt > ours.updatedAt: winner = theirs
else:  # 秒级碰撞
    # tiebreaker:哪一方相对 base 真的改了?
    #   - ours.contentHash != base.contentHash 且 theirs.contentHash == base.contentHash → winner = ours
    #   - 反之亦然 → winner = theirs
    #   - 双方都改了(contentHash 都 != base)→ 走 LLM 仲裁(§5)
    #   - 双方都没改(异常,可能 base == ours == theirs)→ winner = ours(任选,记 audit)
    tiebreaker = whoChangedRelativeToBase(ours, theirs, base)
    if tiebreaker is None: → 走 LLM 仲裁(§5)
    else: winner = tiebreaker
```

### 4.5 Finalization

- 重算 `contentHash` / `contentSize`
- `updatedAt` 取 `max(ours, theirs)`(合并本身就是新状态)
- `updatedBy` 写 `"merge-driver"`
- `version` 取 `max(ours, theirs) + 1`
- 序列化回 markdown,覆盖 `%A`,退出 0
- audit `merge_resolved` + 赢家 + 策略
- 输方备份到 `.co-engram/merge-backup/{date}/{path}`

### 4.6 Edge Cases

- **删除 vs 修改**(一方把 status 改成 `forgotten`,一方改 content)→ updatedAt 仲裁,status 和 content 都按赢家取
- **pathHint 碰撞**(两人用同 slug 创建不同 engram)→ driver 不处理,git 报 add/add → 升级人工
- **frontmatter 路径漂移**(A 改 frontmatter 但 content 一致)→ §4.2 正常合并,无 content 冲突

## 5. LLM Arbitration

### 5.1 Provider Reuse

直接复用 co-engram 已有 `LlmClient` 抽象(`complete(prompt, opts) → string`):

| Host            | Adapter                           | Fallback config             |
| --------------- | --------------------------------- | --------------------------- |
| openclaw-plugin | `createOpenAiCompatibleLlmClient` | `~/.openclaw/openclaw.json` |
| claude-code-mcp | `createAnthropicLlmClient`        | env `ANTHROPIC_API_KEY`     |

Adapter 已处理 reasoning 模型(Qwen3 / DeepSeek-R1 / DeepSeek-V4 / GLM-5.2 / Claude w/ thinking)的 `reasoning_content` fallback,直接复用。

### 5.2 Input Contract

```typescript
interface LlmMergeInput {
  conflictType:
    | "engram_frontmatter"
    | "engram_content"
    | "synapse_field"
    | "synapse_evidence"
    | "resolution_state"
    | "updatedAt_collision"
    | "cross_file_inconsistency";
  path: string;
  fieldName?: string;
  base: unknown;
  ours: unknown;
  theirs: unknown;
  meta: {
    oursUpdatedAt: string;
    theirsUpdatedAt: string;
    oursUpdatedBy: string;
    theirsUpdatedBy: string;
  };
}
```

### 5.3 Output Contract

```typescript
interface LlmMergeOutput {
  verdict: "ours" | "theirs" | "merge" | "escalate";
  mergedValue?: unknown; // verdict='merge' 时必填
  rationale: string; // 必填,写进 audit
  confidence: number; // [0, 1]
}
```

### 5.4 Prompt Template

```
You are a merge arbitrator for co-engram team memory files.

Conflict type: {conflictType}
Field: {fieldName}
Path: {path}

BASE (common ancestor): {base}
OURS ({oursUpdatedBy} at {oursUpdatedAt}): {ours}
THEIRS ({theirsUpdatedBy} at {theirsUpdatedAt}): {theirs}

Decide:
1. verdict="ours"     — take OURS as-is
2. verdict="theirs"   — take THEIRS as-is
3. verdict="merge"    — synthesize; provide mergedValue
4. verdict="escalate" — cannot decide confidently

Rules:
- Preserve both sides' intent when possible (prefer "merge")
- "escalate" if low confidence or semantic incoherence
- Never invent facts not present in either side

Return JSON: { "verdict": ..., "mergedValue"?: ..., "rationale": ..., "confidence": 0.0-1.0 }
```

### 5.5 Engineering Parameters

| 维度         | 值                                                        | 理由                                                                        |
| ------------ | --------------------------------------------------------- | --------------------------------------------------------------------------- |
| 同步等待     | 是(15s 超时)                                              | merge driver 必须 block,但不能拖死 git pull                                 |
| 置信度阈值   | **0.7**(`git config co-engram.llm-confidence 0.7` 可配置) | 低于阈值 → 不执行,降级到 marker                                             |
| 失败降级     | API 不可用 / JSON 解析失败 / 超时 / 低置信 → 留 marker    | driver 永不静默丢数据                                                       |
| Prompt cache | 开启(系统 prompt + base context 缓存)                     | 复用 co-engram 既有 prompt cache 机制                                       |
| 重试         | 不重试                                                    | 失败就降级,backup + audit 兜底                                              |
| Token 预算   | input < 1000,output < 200                                 | 50 人/周触发 < 10 次,月成本 < $5                                            |
| 审计         | `merge_llm_arbitrated`                                    | promptHash / verdict / confidence / rationale / latencyMs / provider 全落盘 |

### 5.6 Three-Layer Arbitration Flow

```
字段冲突 / content 冲突
        │
        ▼
Layer A: updatedAt 仲裁(机械,99% 在此解决)
  ours.updatedAt vs theirs.updatedAt 单调可比
        │ 不能判定(updatedAt 一致 / 秒级碰撞 / tiebreaker 平局)
        ▼
Layer B: LLM 仲裁(智能,默认 ON)
  GLM/Claude 读 base/ours/theirs + 冲突字段
  返回 verdict + rationale + confidence
        │ LLM 不可用 / 失败 / 置信度 < 0.7
        ▼
Layer C: 留 git marker + 升级人工
```

### 5.7 LLM Trigger Conditions(具体)

| 场景                                                 | 为何需要 LLM                        |
| ---------------------------------------------------- | ----------------------------------- |
| `updatedAt` 秒级碰撞 + tiebreaker 平局               | 没有时间信号可分,只能看语义         |
| 双方都改了 `title` 但语义差异大                      | updatedAt 仲裁可能取错              |
| 双方都改了 `domainTags` 且无交集                     | 应该 union 而非二选一               |
| `content` 同段落双方都改且语义冲突                   | content fallback updatedAt 会丢一边 |
| `synapse evidence` 双方加了互相矛盾的证据            | evidence union 会保留矛盾           |
| 跨文件协调(engram 被 refuted,另一方在其上加 synapse) | 单文件 driver 看不到跨文件状态      |

## 6. Synapse Merge Algorithm

**输入**:base / ours / theirs 三个 synapse YAML 文件版本
**输出**:合并后的 YAML,写到 `%A`

### 6.1 Field Classification

| 字段                                            | 合并规则                                                           | 理由                             |
| ----------------------------------------------- | ------------------------------------------------------------------ | -------------------------------- |
| `id` `from` `to` `kind` `createdBy` `createdAt` | **不可变**;任一方 ≠ base → 留 marker                               | 身份字段;改了说明出现异常        |
| `weight`                                        | updatedAt 仲裁                                                     | 主观判断,非累加                  |
| `direction`                                     | updatedAt 仲裁                                                     | enum,二选一                      |
| `evidence`                                      | **数组 union**(按 `description + addedBy` 去重,保留最新 `addedAt`) | evidence 累积型,双方加的都应保留 |
| `sourceSemantic` / `targetSemantic`             | updatedAt 仲裁                                                     | 语义快照                         |
| `updatedAt`                                     | `max(ours, theirs)`                                                | 合并本身就是新状态               |
| `retrievalWeight`                               | 重算(派生字段)                                                     | 系统计算                         |
| `resolutionState`                               | **状态机合并**(下方 6.3)                                           | contradicts synapse 专用,复杂    |

### 6.2 Evidence Union Algorithm

```typescript
function mergeEvidence(
  base: Evidence[],
  ours: Evidence[],
  theirs: Evidence[],
): Evidence[] {
  const oursAdded = diffByDescAndAuthor(ours, base);
  const theirsAdded = diffByDescAndAuthor(theirs, base);
  const all = [...base, ...oursAdded, ...theirsAdded];
  // 去重 key: `${description}::${addedBy}` 字符串
  // 同一人对同一描述多次添加 → 保留最新 addedAt
  return dedupeByDescAndAuthor(all);
}
```

**矛盾 evidence**(A: "因为 X",B: "因为 not X")→ union 后两条都保留,**触发 LLM 仲裁**。

### 6.3 resolutionState State Machine Merge

contradicts synapse 三阶段:`pending → auto_resolved / escalated → contested → resolved`

```
if ours.resolutionState == theirs.resolutionState:
    use either
elif ours absent or theirs absent:
    use the one present
else:
    # 双方都改了 resolutionState
    phaseOurs = ours.resolutionState.phase
    phaseTheirs = theirs.resolutionState.phase
    if phaseOurs != phaseTheirs:
        winner = higher phase (closer to resolution)
    else:
        # phase 相同 → 用状态优先级
        priority = { resolved: 4, escalated: 3, auto_resolved: 2, contested: 2, pending: 1 }
        winner = higher priority
    # 同时把输方的 rationale 作为 evidence append 到 winner.resolutionState
```

### 6.4 Edge Cases

- **evidence 数组中 addedBy 缺失**(老数据)→ 用 description-only 去重,容错
- **resolutionState 部分字段缺失**(phase 1 vs phase 2 数据格式不同)→ 用 phase 数字兜底
- **YAML 字段顺序差异**(不同 serializer 输出顺序不同)→ 解析后用 normalized 字段顺序重排,避免假冲突
- **kind 改变**(ours 改了 kind 触发 delete+create)→ driver 不介入,git 自己产生 rename/add 冲突 → 升级人工。**driver 只处理内容冲突,身份字段变更走 git 原生**

## 7. Cross-File Coordination

### 7.1 Driver Limitation

git merge driver 在单文件冲突时被调用,**看不到其他文件状态**。所以"engram 被 refuted,另一方在其上加 synapse"这类跨文件逻辑不一致,driver 不能直接处理。

### 7.2 Solution: Reuse Existing MaintenanceEngine

加一个 **post-merge consistency pass**,作为既有 `MaintenanceEngine.light()` 的新 check。

| 触发点                      | 时机                                      | 实现                                                                                           |
| --------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `post-merge` git hook(可选) | git pull 完成后                           | host plugin 安装时可选写 `.git/hooks/post-merge`,触发 `co-engram maintenance run --post-merge` |
| 定期 maintenance(默认)      | 已有的 maintenance light stage 周期跑     | 不需要新触发点                                                                                 |
| 手动                        | `co-engram maintenance run --consistency` | 应急用                                                                                         |

### 7.3 Consistency Check Catalog

| 不一致类型                                            | 检测                                                               | 处理                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------- |
| refuted/forgotten engram 仍有 active outgoing synapse | 扫 status 的 engram → 查 `synapses/{kind}/*.yaml` 中 from == 该 id | LLM 仲裁"是否清理 synapse";不同意 → audit inconsistency  |
| supersedes 关系破坏                                   | A supersedes B(B 应 archived)→ B 仍 active                         | 自动把 B.status=archived(明确语义,不需 LLM)              |
| contradicts synapse 双方 resolutionState 冲突         | synapse.resolutionState 在 ours/theirs 走了不同分支                | LLM 仲裁最终 verdict;输方 rationale 作为 evidence append |
| 双方都改 domainTags 且新加 tags 完全不相交            | merged engram 的 domainTags 在原文中找不到                         | LLM 仲裁"union 还是二选一";倾向 union                    |

### 7.4 Statistics Impact

跨文件不一致事件:**50 人场景下,每月 0.5-2 次**。

| 处理路径                                        | 占比 |
| ----------------------------------------------- | ---- |
| 自动处理(supersedes→archived 等明确语义)        | 50%  |
| LLM 仲裁处理                                    | 35%  |
| LLM 不可用 / 不确定 → audit + 等下次 deep stage | 15%  |

## 8. Onboard Integration

### 8.1 Driver Bundle Strategy

driver 是独立 Node CLI 入口,通过 `node /path/to/driver.js %O %A %B %L %P` 调用。

**决策**:esbuild bundle 成单文件 → onboard 时拷贝到 `~/.co-engram/merge-driver.js`。

理由:

- plugin 安装位置不固定(`node_modules/@co-engram/core/dist/...`),版本升级路径漂移
- 单文件 bundle,路径稳定,git config 引用不失效
- 多 host 共存(用户机器同时装 openclaw-plugin + claude-code-mcp)无冲突

### 8.2 Three Install Artifacts

**1. driver bundle**(用户级,所有仓库共享):

```
~/.co-engram/merge-driver.js   ← 单文件 bundle,文件头标注版本号
```

**2. `.gitattributes`**(commit 进仓库,团队共享):

```gitattributes
# co-engram structured merge driver
**/*.md            merge=co-engram
synapses/**/*.yaml merge=co-engram
```

- `**/*.md` 会匹配所有 markdown(包括 README/docs),driver 内部用 `isEngramFile()` 检测,不是 engram 就调 `git merge-file` 透明 fallback
- 第一位开发者 onboard 后 commit,其他人 clone 自动有

**3. `.git/config`**(本地,每人各装一次):

```ini
[merge "co-engram"]
    name = co-engram structured merge
    driver = node /home/USER/.co-engram/merge-driver.js %O %A %B %L %P
```

- 用绝对路径(git config 不支持 `~`)
- 通过 `git config merge.co-engram.*` 命令写,不手写 ini

### 8.3 Onboard Algorithm

```typescript
function installMergeDriver(repoRoot: string): void {
  // 1. 拷贝 bundle(检测版本号,一致则跳过)
  const driverDest = path.join(os.homedir(), ".co-engram", "merge-driver.js");
  if (!existsSync(driverDest) || readVersion(driverDest) !== CURRENT_VERSION) {
    copyBundle(driverSrc, driverDest);
  }

  // 2. 写 .git/config(本地,每人各装一次)
  execSync('git config merge.co-engram.name "co-engram structured merge"', {
    cwd: repoRoot,
  });
  execSync(
    `git config merge.co-engram.driver "node ${driverDest} %O %A %B %L %P"`,
    { cwd: repoRoot },
  );

  // 3. append .gitattributes(团队共享)
  appendIfMissing(path.join(repoRoot, ".gitattributes"), GITATTRIBUTES_ENTRY);
}
```

### 8.4 Trigger Points

| 时机                                              | 动作                                                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `openclaw onboarding` / `claude-code-mcp onboard` | 检测当前目录是 git 仓库 + 团队记忆根 → 自动安装                                                      |
| plugin 启动                                       | 检测 `.git/config` 里 `merge.co-engram.driver` 是否存在 + driver 文件版本号是否匹配 → 不匹配静默升级 |
| `co-engram git enable`(手动)                      | 重装(应急)                                                                                           |

### 8.5 Version Management

- driver bundle 文件头注释含版本号 `// co-engram-merge-driver v1.2.3`
- plugin 启动 / onboard 时读版本号与当前 plugin 版本对比,不一致 → 静默重拷贝
- 兼容性策略:driver 接口 contract 锁定(`%O %A %B %L %P` 五参数),内部逻辑可大改

### 8.6 Multi-Host Coexistence

用户机器同时装 openclaw-plugin + claude-code-mcp:

- 两边共用 `~/.co-engram/merge-driver.js`(同一文件)
- driver bundle 来自 core 包,版本由 core 决定
- 两边 onboard 都写 `.git/config`,entry 完全相同(idempotent)

### 8.7 Failure Tolerance

| 故障                       | git 行为                                                  |
| -------------------------- | --------------------------------------------------------- |
| driver 脚本丢失            | git 报 "merge driver not found",fallback 到默认文本 merge |
| driver 崩溃(non-zero exit) | git fallback 到默认文本 merge,产生标准 conflict marker    |
| driver 写错 `%A` 但 exit 0 | git 用 `%A` 内容作为合并结果(故 driver 必须严格契约)      |

**关键不变量**:driver 任何故障都不阻塞 git workflow,最坏退回标准 conflict marker 流程。

### 8.8 Uninstall

- `co-engram git disable` → 删 `.git/config` 里 `merge.co-engram.*` 段
- `.gitattributes` 由用户决定(commit 进仓库,删了影响团队)
- `~/.co-engram/merge-driver.js` 不自动删,提供 `co-engram git uninstall --global` 显式清理

## 9. User Experience

### 9.1 First-Time Enable(一次性,完全自动化)

按 [[low-friction-defaults]] 偏好,用户不主动做事。触发的"自动安装"时机:

| 时机                                                     | 触发动作                                                             |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| 用户跑 `openclaw onboarding` / `claude-code-mcp onboard` | onboard 流程检测当前目录是否 git 仓库 + 是否团队记忆根,是 → 自动安装 |
| onboard 时不是 git,后续 `engram_create` 第一次落盘       | 检测到已是 git,补装一次                                              |
| 重装/手动启用                                            | 提供 `co-engram git enable` 命令(应急用)                             |

### 9.2 Daily Usage(完全透明)

用户日常命令不变,**driver 在 git 检测到冲突时自动介入**:

| 用户动作                                          | driver 是否跑     |
| ------------------------------------------------- | ----------------- |
| `git pull` 无冲突(fast-forward)                   | ✗                 |
| `git pull` 有冲突                                 | ✓ git 调用 driver |
| `git merge <branch>` 有冲突                       | ✓                 |
| `git rebase` / `cherry-pick` / `stash pop` 有冲突 | ✓                 |
| 日常 `engram_create` / `engram_update` 本地写     | ✗(本地操作)       |

### 9.3 User-Visible Output

**默认安静**。

无冲突:

```
Updating a1b2c3d..e4f5g6h
Fast-forward
```

driver 自动解决(git 默认不显示细节):

```
Auto-merging engrams/AIOS/some-decision.md
Merge made by the 'ort' strategy.
```

driver 解决不了(留 marker):

```
CONFLICT (content): Merge conflict in engrams/AIOS/some-decision.md
Automatic merge failed; fix conflicts and then commit the result.
```

→ 用户用 `git status` 看冲突文件,手动 resolve(此时已是 git 标准 `<<<<<<<` marker)。

**可选的可见性**:

```
git config co-engram.report on
```

开了之后 driver 自动解决时会输出到 stderr:

```
[co-engram] resolved engrams/AIOS/some-decision.md
  strategy: frontmatter field merge (3 fields) + content updatedAt fallback
  winner: theirs (2026-06-25T10:00:00Z > 2026-06-25T09:00:00Z)
  backup: ~/.co-engram/merge-backup/20260625/engrams/AIOS/some-decision.md.ours
```

## 10. Error Handling

### 10.1 Driver Failure Path Table

| 失败模式                              | driver 行为                             | git 后果             | 用户感知                                 |
| ------------------------------------- | --------------------------------------- | -------------------- | ---------------------------------------- |
| driver 脚本丢失                       | exit 127                                | fallback 默认 merge  | 标准 merge 流程                          |
| driver 崩溃                           | exit non-zero                           | fallback 默认 merge  | 标准 conflict marker                     |
| 解析失败(任一方文件损坏)              | 留 marker,exit 1                        | git 报 conflict      | 手动 resolve                             |
| 字段冲突 + updatedAt 可比             | Layer A 解决,exit 0                     | 自动合并             | 透明                                     |
| 字段冲突 + LLM 仲裁成功               | Layer B 解决,exit 0                     | 自动合并             | 透明(可选 report)                        |
| LLM 不可用 / 失败 / 低置信            | 留 marker,exit 1                        | git 报 conflict      | 手动 resolve                             |
| 路径碰撞(add/add)                     | driver 不介入                           | git 报 add/add       | 手动 resolve                             |
| kind 变化(rename/delete)              | driver 不介入                           | git 报 rename/delete | 手动 resolve                             |
| 备份失败                              | 不阻塞 merge,audit 标记 `backup_failed` | merge 继续           | audit 可见                               |
| LLM 仲裁成功但 mergedValue 序列化失败 | 留 marker,exit 1                        | git 报 conflict      | 手动 resolve;audit 标 `serialize_failed` |

**核心原则**:任何不确定都 fallback 到 git 默认行为,**绝不静默丢失数据**。

## 11. Testing Strategy

### 11.1 Test Matrix

| 层                          | 内容                                                                                                                       | 工具                         | 频率    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------- |
| 单元(纯函数)                | FrontmatterMerger 字段分类合并;ContentMerger 段落;SynapseMerger evidence union;resolutionState 状态机;updatedAt tiebreaker | vitest + fixture             | 每 PR   |
| 单元(LLM mock)              | LlmArbiter 各种 verdict;置信度阈值;JSON 解析;失败降级                                                                      | vitest + LlmClient mock      | 每 PR   |
| 集成(driver CLI)            | driver-main 端到端:base/ours/theirs → 输出文件;10+ 冲突组合                                                                | vitest + child_process       | 每 PR   |
| 集成(真实 git merge driver) | setup test repo,触发 git merge,验证 driver 被调用 + 结果正确                                                               | vitest + child_process + git | 每 PR   |
| 端到端(50 人模拟)           | 模拟 50 并发 push,测人工介入率,验证概率估算                                                                                | 压测脚本                     | nightly |
| 回归                        | 真实历史冲突案例 replay                                                                                                    | fixture 库                   | 每 PR   |

### 11.2 Key Fixtures

```
test/fixtures/merge/
├── engram-same-field-updatedAt-wins/       # §4.4 字段仲裁基础
├── engram-diff-field-git-3way/             # git 自动合并
├── engram-content-same-para-llm/           # content 段落冲突 → LLM
├── engram-stat-fields-additive/            # retrievalCount 累加
├── engram-updatedAt-collision-llm/         # 秒级碰撞 → LLM
├── synapse-evidence-union/                 # §6.2 evidence union
├── synapse-evidence-contradiction-llm/     # 矛盾 evidence → LLM
├── synapse-resolution-state-merge/         # 状态机合并
├── cross-file-refuted-with-synapse/        # §7 跨文件协调
├── cross-file-supersedes-cleanup/          # 自动 archived
├── non-engram-md-transparent-fallback/     # 非 engram .md 透明处理
├── driver-crash-git-fallback/              # driver 崩溃 → git fallback
└── llm-unavailable-degrade/                # LLM 不可用 → marker
```

### 11.3 CI Strategy

- **每 PR 必跑**:单元 + driver CLI 集成 + 真实 git merge driver 集成(< 60s)
- **nightly**:50 人并发模拟 + LLM 真实调用(staging key,验证 provider 适配)
- **release 前**:跨平台验证(Linux / macOS / Windows;Node 22+)

## 12. Implementation Roadmap

### Phase 1: MVP — Driver + Engram Merge(1 周)

**Scope**:

- driver CLI 入口(driver-main.ts)+ esbuild bundle 配置
- EngramMerger + FrontmatterMerger + ContentMerger
- updatedAt 仲裁(Layer A)
- 备份机制 + audit(`merge_resolved` / `merge_backup_failed`)
- onboard 模块骨架(手动 `co-engram git enable` 测试)

**不含**:LLM 仲裁、Synapse 合并、跨文件协调、自动 onboard

**验收**:

- engram 文件冲突能被 driver 处理,统计字段累加正确
- 输方备份落盘,7 天 TTL 工作
- driver 崩溃时 git 正确 fallback 到默认 merge

### Phase 2: Synapse Merge + Auto-Onboard(1 周)

**Scope**:

- SynapseMerger + evidence union + resolutionState 状态机
- plugin 启动时检测 + 自动安装 driver
- `.gitattributes` + `.git/config` 自动写入
- driver 版本号检测 + 静默升级

**不含**:LLM 仲裁、跨文件协调

**验收**:

- 50% 团队 onboard 后,synapse 冲突自动解决
- 多 host 共存场景验证(openclaw + claude-code-mcp 同装)

### Phase 3: LLM Arbitration + Cross-File Coordination(1.5 周)

**Scope**:

- LlmArbiter + provider 适配(复用 `LlmClient`)
- prompt 模板 + JSON 输出契约
- 置信度阈值 + 失败降级
- CrossFileCoordinator(post-merge consistency pass)
- 可选 `post-merge` git hook 安装

**不含**:压测优化

**验收**:

- LLM 仲裁率 / 人工介入率符合估算
- 跨文件 refuted + synapse 场景正确处理

### Phase 4: Stress Test + Monitoring + Polish(1 周)

**Scope**:

- 50 人并发模拟压测脚本
- viewer "Merges" tab
- `co-engram merge stats` 命令
- 跨平台验证(Linux / macOS / Windows)
- 异常报警:LLM 仲裁率飙升、备份失败

**验收**:

- 压测下人工介入率 ≤ 5%
- 全平台 git workflow 不阻塞

**总工期**:**4-4.5 周**(含缓冲)

## 13. Metrics & Monitoring

### 13.1 KPI

| 指标                              | 目标    |
| --------------------------------- | ------- |
| driver 自动解决率                 | ≥ 95%   |
| LLM 仲裁成功率                    | ≥ 70%   |
| 人工介入率                        | ≤ 5%    |
| 备份失败率                        | ≤ 0.1%  |
| driver 平均延迟(Layer A)          | < 200ms |
| driver 平均延迟(Layer B with LLM) | < 5s    |
| 50 人场景下每周人工介入次数       | < 1     |

### 13.2 Monitoring

- audit `merge_resolved` / `merge_llm_arbitrated` / `merge_backup_failed` 全量落盘
- viewer 加 "Merges" tab,展示最近事件 + 统计图表
- 用户可 `co-engram merge stats` 查看
- 异常报警:LLM 仲裁率突然飙升(可能 prompt drift)、备份失败(磁盘问题)

## 14. Alternatives Considered

### 14.1 Conflict Granularity(已决策)

| 选项                   | 评价                              |
| ---------------------- | --------------------------------- |
| 严格文件级(原始提议)   | ✗ 简单但丢数据                    |
| **结构感知合并(已选)** | ✓ 保留最多数据,复用 git 3-way     |
| 完全字段级合并         | ✗ 实现复杂,content 段落合并价值低 |
| 文件级 + 备份兜底      | △ 折中,但 content 丢失语义        |

### 14.2 Trigger Mechanism(已决策)

| 选项                       | 评价                             |
| -------------------------- | -------------------------------- |
| **Git merge driver(已选)** | ✓ 透明、原生、无新命令           |
| Post-merge hook            | ✗ 已被 merge 完成后,定位冲突困难 |
| 手动 CLI 命令              | ✗ 违反 [[low-friction-defaults]] |
| 只提供 core API            | ✗ 多 host 重复集成               |

### 14.3 Driver Bundle Location(已决策)

| 选项                             | 评价                    |
| -------------------------------- | ----------------------- |
| 跟 plugin 走(node_modules)       | ✗ 路径漂移              |
| **稳定位置 ~/.co-engram/(已选)** | ✓ 路径稳定,多 host 共享 |
| npx -p                           | ✗ 启动延迟 1-3s         |

### 14.4 LLM Arbitration Default(已决策)

| 选项                            | 评价                                          |
| ------------------------------- | --------------------------------------------- |
| 默认 OFF                        | ✗ 违反 [[low-friction-defaults]],人工介入率高 |
| **默认 ON,失败 fallback(已选)** | ✓ 符合偏好,失败有兜底                         |
| 强制要求 LLM                    | ✗ 离线/受限环境不可用                         |

## 15. Risks

| 风险                                   | 缓解                                               |
| -------------------------------------- | -------------------------------------------------- |
| LLM 仲裁错误(低概率但高影响)           | 置信度阈值 + 输方备份 + audit 全量落盘             |
| driver bundle 升级时版本不兼容         | 文件头版本号 + plugin 启动时检测 + 静默重拷贝      |
| git merge driver 接口在 git 新版本变化 | contract 锁定 `%O %A %B %L %P`,广泛兼容(git 2.9+)  |
| driver 拖慢 git pull                   | Layer A 单文件 < 200ms;Layer B 15s 超时硬上限      |
| 团队集中编辑核心 engram 导致冲突率飙升 | metrics 监控,异常报警                              |
| YAML 字段顺序在不同 serializer 间漂移  | 解析后用 normalized 字段顺序重排                   |
| 跨平台路径问题(Windows 反斜杠)         | driver 内部统一用 posix 路径,git config 用绝对路径 |
| 多人同时秒级 collision                 | tiebreaker + LLM 仲裁 + 升级人工三重保障           |

## 16. References

- co-engram engram 存储格式:`packages/core/src/storage/engram-store.ts`
- co-engram synapse 存储格式:`packages/core/src/storage/synapse-store.ts:32-43`
- `git merge-file` plumbing 文档:https://git-scm.com/docs/git-merge-file
- Custom merge driver 文档:https://git-scm.com/docs/gitattributes#_defining_a_custom_merge_driver
- 已有 LlmClient 抽象:`packages/core/src/llm/client.ts`
- 已有 MaintenanceEngine:`packages/core/src/maintenance/engine.ts`
- 用户偏好:[[low-friction-defaults]](默认开启 + 自动配置 + 零手动步骤)

## 17. Open Questions

无 —— brainstorming 阶段的所有关键决策(冲突粒度、触发机制、driver bundle 策略、LLM 仲裁默认、备份机制)均已通过 AskUserQuestion 确认。

实施阶段若遇到 spec 未覆盖的边界,以下默认原则:

1. **数据安全优先于自动率** —— 不确定时 fallback 到 marker
2. **复用既有机制** —— 不增加新组件,优先用 maintenance / audit / LlmClient
3. **失败模式可观测** —— 任何 fallback / 降级都落 audit

---

**Spec status**: Draft, awaiting user review. After approval, will transition to writing-plans skill for implementation plan generation.
