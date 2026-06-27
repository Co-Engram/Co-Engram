# Co-Engram 数据模型 v2:Per-Edge Synapse + 人类友好存储

**日期**: 2026-06-22
**状态**: 设计已确认,待实施
**作者**: Yang Yang + Claude

## Context

co-engram 当前的 synapse 存储模型有两个根本性的逻辑缺陷:

1. **per-engram synapse 存储**:synapse 存在 engram 的 `synapses.yaml` 里,作为节点的"属性"。但 synapse 是连接两个节点的关系,把它放在任一端点都破坏了对称性——`direction: bidirectional` 的 synapse 到底该放 from 还是 to?
2. **路径式 engram id**:engram id 是 `testing/2026-06-21-abc123`,身份和文件路径绑死。人类一旦移动或重命名文件,身份就丢了,所有 synapse 引用失效。

同时,当前存储对人类不友好:三件套(content.md / meta.yaml / synapses.yaml)、机器可读但难看的 id 文件名、不自然的 `engrams/` 顶层包裹层。人类想像用 Obsidian 一样直接在任意目录里写 markdown。

本设计同时修复逻辑缺陷和可用性问题,合并为一次重构(实验阶段,允许破坏性升级,不写迁移脚本)。

## 目标与非目标

### 目标

- **synapse 成为一等实体**:独立 id / lifecycle / state,per-edge 文件存储
- **engram 身份独立于路径**:ULID stable id,文件移动/重命名不影响关系
- **人类友好存储**:任意多层目录,单文件(frontmatter + content),title 直接可读
- **自愈能力**:doctor 扫描检测并修复人类操作导致的不一致
- **渐进式披露**:通过 prompt signals 暴露路径 + domain + 跨域桥梁信息

### 非目标

- 不写迁移脚本(实验阶段,破坏性升级)
- 不重做 SynapseKind 体系(12 种 5 族已合理)
- 不引入交互式图库(后续独立工作)
- 搜索不走路径维度(纯语义,路径的价值在导航和 signals)

## 核心设计决策(全部已确认)

### 身份模型

| 标识           | 生成方式                                    | 性质   | 变更条件                                |
| -------------- | ------------------------------------------- | ------ | --------------------------------------- |
| **EngramId**   | `ulid()` 库,26 字符 Crockford Base32        | 永不变 | 永不变(系统生成,人类不可改)             |
| **SynapseId**  | `syn-` + sha256(from\|to\|kind).slice(0,16) | 确定性 | 同 (from,to,kind) 必同 id               |
| **slug**       | 从 title slugify(保留 unicode 中文)         | 可变   | 默认跟随 title;frontmatter 显式写则锁定 |
| **domainTags** | 从路径所有目录层推断                        | 可变   | 默认从路径推断;frontmatter 显式写则锁定 |

### slug 策略

- **默认**:frontmatter 无 `slug` 字段 → slug 是派生属性,每次 title 变就重新 slugify + rename 文件
- **锁定**:frontmatter 有 `slug` 字段 → slug 固定,title 变不跟随
- **冲突处理**:新 slug 与同目录其他文件冲突 → 保持旧 slug + doctor 警告
- **unicode**:保留中文等非 ASCII 字符(如 `操作系统内存优化`);ASCII 字母转小写;`/` `:` `\` `?` `*` 等非法路径字符替换为 `-`;连续空格合并为一个 `-`;首尾 `-` 裁剪。例:`"React Hooks 最佳实践"` → `"react-hooks-最佳实践"`

### domainTags 推断

- **默认**:从路径**所有目录层**推断
  - `项目管理/需求管理/操作系统内存优化.md` → `["项目管理", "需求管理"]`
- **锁定**:frontmatter 显式写 `domainTags` → 用显式值,路径不影响
  - 用途:语义域覆盖物理位置(如文件在 `项目管理/` 下但内容是操作系统知识)

**进化作用**(已通过 codegraph 验证):

- `checkUpgradeEligibility` 用 `distinctDomains` 做 verification 升级硬条件(probable/verified 要求跨域证据)
- `LocalHeuristicCrossPollinationProvider` 在不同 domain 间生成跨域类比
- `sampleEngrams` 按 domain 过滤采样

## 终态存储布局

```
<dataRoot>/                              ← team-memory 根(git 仓库)
├── 项目管理/                             ← 人类笔记,任意多层目录
│   └── 需求管理/
│       └── 操作系统内存优化.md
├── 技术笔记/
│   └── 前端/
│       └── React/
│           └── Hooks最佳实践.md
├── synapses/                            ← synapse 数据(顶层,git 提交)
│   └── extends/
│       └── syn-a1b2c3d4e5f67890.yaml
└── .co-engram/                          ← 派生缓存(gitignore)
    ├── engram-index.json
    ├── graph.json
    └── prompt-signals.json
```

**设计要点**:

- 无 `engrams/` 顶层包裹(整个 dataRoot 就是 engram 集合)
- 无 `domain/` 层(人类目录就是分类,任意多层)
- `synapses/` 顶层保留(与笔记平级,强调 synapse 是一等实体;保留名约定,类似 `.git/`)
- `.co-engram/` 放派生缓存(gitignore),synapses 不在此目录(重要数据需提交)

## engram 文件格式(单文件)

```markdown
---
id: 01JXKA9F8S7TQN8C9V2F3M4P5 # ULID,永不变(系统生成)
title: 操作系统内存优化 # 人类可改
# slug: 操作系统内存优化                     # 可选,默认从 title slugify
# domainTags: [操作系统, 内存管理]           # 可选,默认从路径推断
tags: [性能, 优化]
createdAt: 2026-06-22T10:00:00Z
updatedAt: 2026-06-22T15:30:00Z
version: 1
---

(content,无 H1 标题;title 只在 frontmatter)
```

**决定**:

- title **只在 frontmatter**(content 不要求 H1),避免两处同步问题
- 三件套合并为单文件:meta 字段进 frontmatter,content 跟在后面
- `version` 用于乐观锁(update 时 version 不匹配则拒绝)

## synapse 文件格式(per-edge)

```yaml
# synapses/extends/syn-a1b2c3d4e5f67890.yaml
id: syn-a1b2c3d4e5f67890
from: 01JXKA9F8S7TQN8C9V2F3M4P5 # engram stable id(ULID)
to: 01JXKB2F9S8UQN7D1W4E6R8T0
kind: extends
weight: 0.8
direction: directional
retrievalWeight: 0.75
createdBy: alice
createdAt: 2026-06-21T10:00:00Z
updatedAt: 2026-06-22T09:15:00Z
evidence:
  - description: "wireless adb 扩展了原有调试流程"
    source: code-review
    confidence: 0.85
    addedBy: alice
    addedAt: 2026-06-21T10:00:00Z
  - description: "在 PR #42 验证"
    addedBy: bob
    addedAt: 2026-06-22T09:15:00Z
sourceSemantic: "wireless adb 命令"
targetSemantic: "完整调试流程"
resolutionState: # 仅 contradicts synapse 使用
  status: pending
  phase: 1
```

**决定**:

- `from` / `to` 引用 **stable id(ULID)**,不是路径 → 文件移动不影响关系
- synapse 文件**不冗余** from_title / to_title(viewer 渲染时查 index;冗余会带来 title 变更时的同步负担)
- `direction: bidirectional` 只存储一次,解决原"对称边只能放一边"的悖论
- `evidence[]` 是 append-only,多人追加天然不冲突

## engram-index.json(派生缓存)

```json
{
  "version": 1,
  "engrams": {
    "01JXKA9F8S7TQN8C9V2F3M4P5": {
      "path": "项目管理/需求管理/操作系统内存优化.md",
      "title": "操作系统内存优化",
      "slug": "操作系统内存优化",
      "slugLocked": false,
      "domainTags": ["项目管理", "需求管理"],
      "tags": ["性能", "优化"],
      "kind": "observation",
      "verificationStatus": "probable",
      "createdAt": "2026-06-22T10:00:00Z",
      "updatedAt": "2026-06-22T15:30:00Z",
      "mtime": 1719047400000,
      "contentHash": "sha256:abc123..."
    }
  },
  "lastRebuiltAt": "2026-06-22T16:00:00Z"
}
```

- `{stableId → 文件元数据}` 映射
- `mtime` 用于增量扫描(doctor 比对)
- `contentHash` 用于检测内容变化触发搜索索引重建

## prompt-signals.json(三层渐进式披露)

```json
{
  "version": 1,
  "activePaths": [
    {
      "path": "项目管理/需求管理",
      "engramCount": 5,
      "retrievalCount": 12,
      "lastActivity": "2026-06-22T15:30:00Z"
    }
  ],
  "activeDomains": [
    {
      "domain": "操作系统",
      "engramCount": 8,
      "retrievalCount": 20,
      "avgConfidence": 0.7
    }
  ],
  "crossDomainSynapses": [
    {
      "synapseId": "syn-a1b2c3d4e5f67890",
      "fromDomain": "操作系统",
      "toDomain": "前端",
      "kind": "extends",
      "weight": 0.8
    }
  ],
  "topTags": [{ "tag": "性能", "count": 12 }],
  "lowConfidenceTopics": ["auth-flow"],
  "missedTopics": [],
  "updatedAt": "2026-06-22T16:00:00Z"
}
```

**crossDomainSynapses 判断规则**:

- from.domainTags 与 to.domainTags 的**交集为空** = 跨域 synapse
- fromDomain / toDomain 取各自 domainTags 的第一个元素(主要 domain)展示
- 上限 10 条(按 weight 降序),避免 prompt 膨胀
- 用途:提示 LLM 这些是高价值知识桥梁,可触发 cross-pollination 生成跨域类比
  "topTags": [
  { "tag": "性能", "count": 12 }
  ],
  "lowConfidenceTopics": ["auth-flow"],
  "missedTopics": [],
  "updatedAt": "2026-06-22T16:00:00Z"
  }

````

**三层各有作用**:
- `activePaths`:人类导航——当前工作集中在哪些物理目录
- `activeDomains`:进化焦点——当前活跃的语义域(LLM 判断专业知识分布)
- `crossDomainSynapses`:知识桥梁——跨域 synapse 是高价值连接,提示 LLM 可生成跨域类比

## Repository API

### 不变的方法

```typescript
class EngramRepository {
  listEngrams(): EngramCatalogEntry[]    // 扫描人类目录下所有 .md
  collectAllSynapses(): Synapse[]        // 扫描 synapses/**/*.yaml
}
````

### 签名变更(破坏性)

```typescript
// 旧:只返回 outgoing
readSynapses(engramId): { outgoing: Synapse[] }

// 新:双向返回(per-edge 模型下 engram 不"拥有" synapse)
readSynapses(engramId): {
  outgoing: Synapse[]    // from = engramId 的 edge
  incoming: Synapse[]    // to = engramId 的 edge
}
```

### 新增方法

```typescript
// 按 endpoints 查单条 edge(确定性 ID 让 O(1))
readSynapseByEndpoints(from: EngramId, to: EngramId, kind: SynapseKind): Synapse | undefined

// 按 synapseId 查
readSynapseById(synapseId: SynapseId): Synapse | undefined

// 级联删除:删 engram 时删所有触及的 edge
deleteSynapsesTouching(engramId: EngramId): number

// 自愈扫描
runDoctor(options: { incremental?: boolean }): DoctorReport

// 路径查询
readEngramByPath(relativePath: string): Engram | undefined
listPathTree(): PathTreeNode                // 目录树 + 每节点 engram 数
```

## 自愈机制(doctor)

**触发时机**:启动时增量(mtime 比对)+ maintenance light 定期全量

| 人类操作                    | 检测方法                                             | 自愈动作                                                   |
| --------------------------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| 移动文件 `mv a/x.md b/x.md` | 扫描 .md frontmatter id,index 里 id 存在但 path 变了 | 更新 engram-index.json 的 path 字段                        |
| 重命名 title                | frontmatter title 与 index 的 titleHash 不符         | 重新 slugify;不冲突则 rename 文件;冲突则保持旧 slug + 警告 |
| 删除文件                    | index 里的 id 在磁盘找不到                           | 标记所有引用此 id 的 synapses 为 `dangling: true`          |
| 新建无 frontmatter 的 .md   | 扫描发现无 id 的 markdown                            | 提示注册为 engram                                          |
| synapse 引用不存在 id       | synapse 的 from/to 在 index 找不到                   | 标记 dangling,doctor 报告                                  |
| 两文件 id 重复              | index 构建时 id 冲突                                 | 警告 + 为其中一个生成新 id                                 |
| 重复 engram(相似度高)       | embedder 算相似度 > 0.95                             | 提示合并                                                   |

## 渐进式披露机制(汇总)

| 层面             | 机制                                                              | 实施阶段                       |
| ---------------- | ----------------------------------------------------------------- | ------------------------------ |
| 人类浏览         | 自然目录结构 + `listPathTree()` 工具                              | Phase 4                        |
| LLM session 提示 | prompt-signals 注入 activePaths/activeDomains/crossDomainSynapses | Phase 2(已有,maintenance 维护) |
| Viewer 展示      | 目录树 + edge metadata(id/weight/evidenceCount/resolution)        | Phase 6                        |
| 搜索             | 纯语义(不走路径)                                                  | 不变                           |

## 实施阶段(逻辑依赖驱动)

| Phase                  | 内容                                                                                                    | 依赖 | 验证                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------- | ---- | ------------------------------- |
| **1. 类型基础**        | EngramId=ULID; SynapseId=确定性 hash; slugify(unicode); 新类型(EngramIndex, DoctorReport, PathTreeNode) | 无   | 单测 computeSynapseId / slugify |
| **2. 存储重写**        | engram-store(单文件 frontmatter); synapse-store(per-edge kind/ 子目录); engram-index 维护; graph 派生   | 1    | 文件 round-trip 单测            |
| **3. Repository 重写** | 所有方法适配; readSynapses 双向返回; deleteEngram 级联                                                  | 2    | repository.test.ts 全绿         |
| **4. Tools 适配**      | engram-tools(接受 stableId/path); synapse-tools(idempotent create); engram_doctor; engram_list_paths    | 3    | tools.test.ts 全绿              |
| **5. 上层适配**        | tier-loader, contradiction, reinforcement, metacognition, cross-pollinate 签名核查                      | 3    | 全部 core 测试绿                |
| **6. Viewer**          | buildGraph 完整 edge metadata; 节点用 slug; 目录树展示; HTML filter                                     | 4    | 手测 viewer                     |
| **7. 测试重建**        | 删旧 fixture; 新模型覆盖; 并发/idempotent/cascade/自愈/跨域                                             | 1-6  | 全仓库测试绿                    |
| **8. 清理遗留**        | 删三件套代码; 删 per-engram synapse; 删路径式 id 遗留                                                   | 7    | 无死代码                        |

**每个 phase 独立可提交,失败可回滚。**

## 新增依赖

- `ulid` npm 包(~1KB,主流,用于 EngramId 生成)

## 测试策略

### 删除的测试(实验阶段,不迁移)

- 所有基于三件套 fixture 的测试
- 所有基于路径式 engram id 的断言

### 新增测试

- `computeSynapseId` 确定性(同输入必同输出)
- `slugify` unicode 保留(中文标题 → 中文 slug)
- idempotent create:重复创建同 (from,to,kind) → 合并 evidence 而非报错
- `deleteEngram` cascade:删 engram 后触及它的 edge 全部消失
- 文件移动:`mv` 后 synapse 关系保持
- title 变化:slug 默认跟随;frontmatter 锁定则不跟随
- domainTags 推断:路径所有层;frontmatter 锁定
- 并发写:Alice/Bob 同时加 evidence 到同 edge → git auto-merge
- doctor 全场景:移动/重命名/删除/重复/dangling

### 透明传导测试(签名兼容,内部自动适配)

- contradiction / reinforcement / metacognition / cross-pollinate:基于 collectAllSynapses,API 不变
- graph-traverse:基于 graph.json 派生缓存,完全不变

## 命名哲学

| 名字                  | 来源                                    | 理由                                                 |
| --------------------- | --------------------------------------- | ---------------------------------------------------- |
| engram                | 神经科学"记忆痕迹"                      | 已确立,不动                                          |
| synapse               | 神经科学"突触"                          | 已确立,不动                                          |
| `synapses/` 顶层目录  | 与笔记目录平级                          | 强调 synapse 是基本实体,不是节点属性                 |
| 按 `kind/` 分子目录   | 12 种 SynapseKind                       | 关系类型作为一级组织维度,符合知识图谱浏览习惯        |
| `syn-<hash>` 文件前缀 | syn- = synapse 缩写                     | 与 engram id(ULID 无前缀)视觉区分;grep syn- 一秒定位 |
| `engram-index.json`   | 派生缓存                                | {stableId → path} 映射,doctor 维护                   |
| ULID                  | Universal Lexicographically Sortable ID | 时间排序 + 全局唯一 + 短(26 字符)                    |

**拒绝的命名**:

- ❌ `links/` / `edges/` / `relations/` — 丢失神经科学隐喻
- ❌ `<engramId>.edges.yaml` — 把 edge 当成 node 属性,正是要修正的错
- ❌ 复合可读 filename(如 `A__B__extends.yaml`) — slug 问题 + 文件名过长 + id 变了文件名要改

## 风险与备选

1. **ULID 库依赖**
   - 风险:额外 1 依赖
   - 备选:内联 Crockford Base32 实现(~50 行)
   - 决定:用库(主流、成熟、避免重复造轮子)

2. **slug 自动跟随 title 导致频繁 rename**
   - 风险:Git 历史里文件"消失"(实际是 rename)
   - 缓解:frontmatter 显式写 slug 即可锁定;doctor 检测 title 变化时提示

3. **synapses/ 顶层与人类目录名冲突**
   - 风险:人类恰好建了叫 synapses 的笔记目录
   - 缓解:文档声明保留名(类似 `.git/`);doctor 检测冲突时警告

4. **domainTags 从路径所有层推断导致过长**
   - 风险:深层目录(5+ 层)的 engram 有 5+ 个 domainTags
   - 缓解:domainTags 查询是 O(n),5 个标签可忽略;进化条件检查不受影响

5. **搜索不走路径可能遗漏**
   - 风险:用户期望"搜某目录下的内容"
   - 缓解:listPathTree 工具 + viewer 目录树 + activePaths signals 已覆盖导航需求

## 下一步

本设计文档经用户审查后,调用 `writing-plans` skill 生成分阶段实施计划。
