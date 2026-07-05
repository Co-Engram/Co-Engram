# 数据格式

本文档描述 Co-Engram 数据仓库(`$CO_ENGRAM_DATA_ROOT`,默认 `~/team-memory`)的布局。

## 设计原则

Co-Engram 的存储基于三条原则:

1. **一个 engram = 一个 Markdown 文件。** frontmatter 承载元数据,正文承载内容。这样元数据可以演进,而内容的 Git diff 保持干净。
2. **稳定 ID(ULID)与路径解耦。** 重命名标题、移动目录或重写正文都不会破坏 synapse 引用。路径由 `domainTags + slug(title)` 派生,但 id 是永久的。
3. **按边存储 synapse。** 两个 engram 之间的每条连接都是独立的 YAML 文件,以确定性 hash 为键。没有重复边,去重很简单,剪枝只需删除一个文件。

## 目录布局

```
~/team-memory/                         # Git 仓库(用户持有,不属于 co-engram)
├── <domainTags>/<slug>.md              # engram 文件,按 domain 组织
│   ├── engineering/
│   │   └── typescript/
│   │       └── strict-mode-gotcha.md
│   └── ops/
│       └── linux/
│           └── ssh-tunnel-bastion.md
├── synapses/                           # 按边存储的连接
│   ├── extends/
│   │   └── syn-<hash>.yaml
│   ├── contradicts/
│   │   └── syn-<hash>.yaml
│   ├── similar_to/
│   │   └── syn-<hash>.yaml
│   ├── derives_from/
│   │   └── syn-<hash>.yaml
│   └── consolidates/
│       └── syn-<hash>.yaml
├── skills/                             # 过程性记忆
│   └── <skill-id>.yaml
├── intentions/                         # 待处理的意图
│   └── <intention-id>.yaml
├── config/                             # 仓库级配置
│   └── co-engram.yaml
├── .trash/                             # 记忆回收站(可选开启,纳入 Git 跟踪)
│   └── 2026-06/                        # 按月分区(UTC)
│       └── <domainTags>/<slug>.md
└── .co-engram/                         # 派生缓存(gitignored)
    ├── engram-index.json               # {version, engrams: {ULID → entry}, lastRebuiltAt}
    ├── graph.json                      # synapse 图快照
    ├── audit.jsonl                     # 只追加的审计日志
    └── signals.jsonl                   # 待处理的 tool-call 事件(由 light stage 消费)
```

## Engram 文件格式

每个 engram 是一个 `.md` 文件,包含 YAML frontmatter 与 Markdown 正文。

### `<domainTags>/<slug>.md`

```markdown
---
id: 01J6XQK5P7R2V8Y3M4N6ZH0WQT
title: TypeScript strict mode readonly gotcha
slug: strict-mode-gotcha # 可选;默认 = slugify(title)
domainTags:
  - engineering
  - typescript
kind: pattern
kinds:
  - pattern
tags:
  - gotcha
summary: Use Object.assign({}, ...parts) to merge readonly configs
importance: 0.62
confidence: 0.85
emotionalValence: neutral
sourceType: firsthand
visibility: team
decayHalfLifeDays: 30
verificationStatus: unverified
status: active
createdBy: claude-code
createdAt: 2026-06-21T10:30:00.000Z
updatedBy: claude-code
updatedAt: 2026-06-21T11:45:00.000Z
version: 3
contentHash: sha256:...
contentSize: 412
retrievalCount: 12
effectiveRetrievals: 9
failedUses: 1
reinforcementScore: 0.42
lastRetrievalScore: 0.71
lastRetrievedAt: 2026-06-21T11:45:00.000Z
lastEffectiveAt: 2026-06-21T11:45:00.000Z
---

# TypeScript strict mode readonly gotcha

In TS strict mode, readonly fields cannot be directly assigned. Use the
`Object.assign({}, ...parts)` pattern to merge partial configs:

\`\`\`typescript
const merged = Object.assign({}, ...parts)
\`\`\`
```

**Frontmatter 字段:**

| 字段                                                  | 类型            | 说明                                                                 |
| ----------------------------------------------------- | --------------- | -------------------------------------------------------------------- |
| `id`                                                  | ULID string     | 26 字符稳定标识符(Crockford base32,可按时间排序)                     |
| `title`                                               | string          | 人类可读的标题                                                       |
| `slug`                                                | string(可选)    | URL 安全的路径成分;默认为 slugify(title)                             |
| `domainTags`                                          | string[](可选)  | domain 层级;默认从路径推断                                           |
| `kind`                                                | enum            | `observation` / `fact` / `pattern` / `procedure` / `hypothesis` 之一 |
| `kinds`                                               | enum[](可选)    | 额外的次要 kind                                                      |
| `tags`                                                | string[]        | 自由格式的上下文标签                                                 |
| `summary`                                             | string          | 一行摘要                                                             |
| `importance`                                          | number `[0, 1]` | 综合重要性分数                                                       |
| `confidence`                                          | number `[0, 1]` | 基于 `sourceType` 的初始置信度                                       |
| `sourceType`                                          | enum            | `firsthand` / `secondhand` / `inferred`;影响默认 confidence          |
| `decayHalfLifeDays`                                   | number 或 null  | Ebbinghaus 半衰期;`null` = 永不衰减                                  |
| `status`                                              | enum            | `draft` / `active` / `archived` / `forgotten`                        |
| `verificationStatus`                                  | enum            | `unverified` / `plausible` / `verified` / `refuted`                  |
| `forcedFreshness`                                     | enum(可选)      | 覆盖派生的新鲜度(由生命周期工具写入)                                 |
| `retrievalCount`、`effectiveRetrievals`、`failedUses` | integer         | 三信号可塑性计数器                                                   |
| `reinforcementScore`                                  | number          | 累积的 RPE 驱动强化值                                                |
| `lastEffectiveAt`                                     | ISO timestamp   | 最近一次该 engram 被有效使用的时间                                   |
| `contentHash`                                         | string          | 正文的 SHA-256 hash(用于变更检测)                                    |

正文中第一行 `# 标题` 是可选的但推荐 —— 部分 viewer 会把它用作预览。

### 中文模式(`language='zh'`)

当仓库的 `language` 为 `'zh'`(0.2.0 起的默认值)时,engram 文件翻转为**正文在上,中文键的 YAML 在 HTML 注释标记之下**。正文内容不变;只是 frontmatter 块的位置变了,键名也本地化。

```markdown
# TypeScript strict mode readonly gotcha

In TS strict mode, readonly fields cannot be directly assigned. Use the
`Object.assign({}, ...parts)` pattern to merge partial configs:

\`\`\`typescript
const merged = Object.assign({}, ...parts)
\`\`\`

## <!-- co-engram-meta:zh -->

标识: 01J6XQK5P7R2V8Y3M4N6ZH0WQT
标题: TypeScript strict mode readonly gotcha
别名: strict-mode-gotcha
领域标签:

- engineering
- typescript
  类型: pattern
  标签:
- gotcha
  摘要: Use Object.assign({}, ...parts) to merge readonly configs
  重要性: 0.62
  置信度: 0.85
  情感极性: neutral
  来源类型: firsthand
  可见性: team
  半衰期天数: 30
  验证状态: unverified
  状态: active
  创建者: claude-code
  创建时间: 2026-06-21T10:30:00.000Z
  更新者: claude-code
  更新时间: 2026-06-21T11:45:00.000Z
  版本: 3
  \_\_语言: zh

---
```

**与英文模式的差异:**

- 正文位于 frontmatter 之上(打开文件时人类先看到内容)
- frontmatter 由 `<!-- co-engram-meta:zh -->` 开场(HTML 注释 —— 在渲染后的 Markdown 中不可见),并使用中文键(`标识` / `标题` / `类型` / `领域标签` / `创建时间` / `重要性` …)
- 一个保留字段 `__语言: zh` 权威标记文件的语言;解析器据此跳过启发式检测
- **枚举值保持英文**(`类型: pattern`,而不是 `类型: 模式`)—— 它们是 TypeScript 字面量 union 类型,运行时用 `===` 比较。翻译它们会破坏类型系统
- 用户自定义的值(`标签`、`领域标签`、`创建者`、`摘要` 文本、正文内容)不会被翻译

解析器透明地接受两种格式。中文仓库里的旧英文文件会在首次启动迁移时被重写(见下文)。

## Synapse 文件格式

每个 synapse 是一个位于 `synapses/<kind>/syn-<hash>.yaml` 的 YAML 文件。hash 为 `syn-` + `SHA-256("|"-joined)` 的前 16 个十六进制字符,其中拼接字符串为 `${a}|${b}|${kind}`,`[a, b]` 是两个端点:

- 对于 `bidirectional` 边,端点会排序(`a ≤ b`),这样 `(A, B, kind)` 与 `(B, A, kind)` 会产生同一个文件 —— 这正是对称边幂等的原因。
- 对于 `directional` 边,顺序保持不变(`a = from`,`b = to`)。

`direction` **不**属于 hash 输入;两条端点与 kind 相同但方向不同的边会合并为同一个文件。这意味着每个 `(from, to, kind)` 三元组最多只有一个 synapse 文件。

```yaml
id: syn-a1b2c3d4e5f6a7b8
from: 01J6XQK5P7R2V8Y3M4N6ZH0WQT
to: 01J7TRY9F8G7H6J5K4L3M2N1O0P
kind: extends
weight: 0.8
direction: directional # 或 "bidirectional"
evidence:
  - description: Both cover TS strict-mode patterns
    addedBy: claude-code
    confidence: 0.9
    addedAt: 2026-06-21T10:35:00.000Z
resolutionState:
  status: pending # pending / resolved / escalated
createdBy: claude-code
createdAt: 2026-06-21T10:35:00.000Z
updatedAt: 2026-06-21T10:35:00.000Z
retrievalWeight: 0.8
```

**Synapse kind(跨 5 个家族共 12 种):**

| 家族           | Kind             | 语义                            |
| -------------- | ---------------- | ------------------------------- |
| **structural** | `extends`        | A 是 B 的泛化/超集              |
|                | `part_of`        | A 是 B 的组成部分               |
|                | `similar_to`     | A 与 B 以不同方式涵盖同一主题   |
| **causal**     | `depends_on`     | A 依赖 B                        |
|                | `causes`         | A 产生 B                        |
|                | `follows`        | A 在序列上先于 B                |
| **evidential** | `derives_from`   | A 派生自 B(证据链)              |
|                | `contradicts`    | A 与 B 相互矛盾(触发元认知检查) |
|                | `exemplifies`    | A 是 B 的具体实例               |
| **temporal**   | `supersedes`     | A 取代 B(更新版本)              |
|                | `consolidates`   | A 强化/合并入 B                 |
| **modulatory** | `contextualizes` | A 为 B 提供上下文               |

**方向:** `directional`(from → to)或 `bidirectional`(对称)。`contradicts` 通常是 `bidirectional`。

### 中文模式(`language='zh'`)

中文仓库下的 synapse 文件使用中文顶层键和中文嵌套键(`证据[]` / `裁决状态`):

```yaml
标识: syn-a1b2c3d4e5f6a7b8
起点: 01J6XQK5P7R2V8Y3M4N6ZH0WQT
终点: 01J7TRY9F8G7H6J5K4L3M2N1O0P
类型: extends
权重: 0.8
方向: directional
证据:
  - 描述: Both cover TS strict-mode patterns
    添加者: claude-code
    置信度: 0.9
    添加时间: 2026-06-21T10:35:00.000Z
创建者: claude-code
创建时间: 2026-06-21T10:35:00.000Z
更新时间: 2026-06-21T10:35:00.000Z
检索权重: 0.8
__语言: zh
```

与 engram 一样,枚举值保持英文(`类型: extends`、`方向: directional`)。

## ID 格式

Engram ID 是 **ULID**(Universally Unique Lexicographically Sortable Identifier):

- 26 字符,Crockford base32 编码
- 前缀:48 位时间戳(自 Unix 纪元起的毫秒数)
- 后缀:80 位随机数

特性:

- 全局唯一(无需协调)
- 可按创建时间排序(高效的时间范围查询)
- 紧凑(26 字符,相比之下 UUID 为 36 字符)
- **与文件路径解耦** —— 重命名与移动不改 id

示例:`01J6XQK5P7R2V8Y3M4N6ZH0WQT`

Synapse ID 是确定性 hash:`syn-` + `SHA-256("|"-joined endpoints + kind)` 的前 16 个十六进制字符。对于 `bidirectional` 边,端点在 hash 前会排序,因此同一对端点不论顺序都产生同一 id;对于 `directional` 边,顺序保持不变。

## 缓存目录(`.co-engram/`)

`.co-engram/` 目录是**派生**的 —— 完全可从 engram 文件 + synapse 文件这一真相源重建。它被 gitignored。

### `engram-index.json`

顶层结构:`{ version: 1, engrams: { ULID → entry }, lastRebuiltAt: ISO }`。每个 entry 包含:

| 字段                      | 类型          | 说明                                          |
| ------------------------- | ------------- | --------------------------------------------- |
| `id`                      | ULID          | 稳定的 engram id                              |
| `path`                    | string        | 相对路径(移动会改变)                          |
| `title`                   | string        | 当前 frontmatter 标题                         |
| `slug`                    | string        | slug(来自 frontmatter 或派生)                 |
| `slugLocked`              | boolean       | frontmatter 是否固定了 slug?                  |
| `domainTags`              | string[]      | 固定值或从路径推断                            |
| `domainTagsLocked`        | boolean       | frontmatter 是否固定了 domainTags?            |
| `tags`                    | string[]      | 自由格式的上下文标签                          |
| `kind`                    | enum          | 主 kind                                       |
| `verificationStatus`      | enum(可选)    | 若 frontmatter 设置了则存在                   |
| `createdAt` / `updatedAt` | ISO timestamp | frontmatter 值                                |
| `mtime`                   | number        | 文件 mtime(epoch 毫秒)—— 驱动 doctor 增量扫描 |
| `contentHash`             | string        | 正文 SHA-256 —— 变更时触发检索索引重建        |

用途:

- 快速的 id → path 查找(无需扫描目录)
- `engram_doctor` 增量扫描(mtime + contentHash 比较)
- `engram_list_paths` 树视图
- viewer UI

在 `createEngram` / `updateEngram` / `deleteEngram` 时自动重建。若文件被外部编辑,运行 `engram_doctor` 手动重建。

### 全文检索索引(内存中)

Co-Engram **不**持久化 FTS 数据库。每次检索时,retrieval orchestrator 会在内存中针对 engram 内容 + 标题 + 标签构建倒排索引。这让数据层保持为纯粹的真相源(没有派生 DB 需要同步),代价是每次检索有少量构建开销。对于大型仓库(10k+ engram),维护引擎可以预热索引 —— 见 [maintenance-engine.md](./maintenance-engine.zh-CN.md)。

分词:ASCII 单词小写化;CJK 文本切分为重叠的 bigram,使中文/日文/韩文查询都能匹配。

### `graph.json`

synapse 图的快照,用于快速遍历。在每次 `synapse_create` / `synapse_delete` 时重建。

### `audit.jsonl`

只追加的状态变更与有效性信号审计日志。供 viewer、维护引擎与元学习使用。绝不手动编辑。

每行是一个 `AuditEntry`:

```json
{"ts":"2026-06-21T10:30:00.000Z","actor":"user","action":"create","engramId":"01J...A"}
{"ts":"2026-06-21T10:31:00.000Z","actor":"system","action":"retrieve_hit","engramId":"01J...A","query":"adb","score":0.82}
{"ts":"2026-06-21T11:00:00.000Z","actor":"system","action":"retrieve_effective","engramId":"01J...A","query":"adb"}
```

跟踪的 action:`create`、`update`、`update_lifecycle`、`reinforce`、`report_failure`、`forget`、`restore`、`sweep_to_trash`、`restore_from_trash`、`purge`、`propose`、`accept`、`dismiss`、`retrieve_hit`、`retrieve_effective`、`retrieve_inconclusive`、`contradicted`。

大致增长:200 字节/事件,典型使用下每年 10-20 MB。

### `signals.jsonl`(位于 `.co-engram/` 内)

收集 `ToolCallEvent` 的 JSON Lines 文件。每个 light stage 消费一次。保留期剪枝为 7 天。

> 历史遗留:0.x 版本曾把该文件写在仓库根目录(`<dataRoot>/signals.jsonl`),与其它状态文件不在同一子目录。1.x 起统一迁到 `.co-engram/`;首次创建 sink 时若发现老路径文件存在,会自动迁移到新位置(不覆盖已存在的新文件)。

示例行:

```json
{
  "toolName": "engram_get",
  "input": { "id": "01J..." },
  "retrievedEngramIds": ["01J..."],
  "sessionId": "abc",
  "at": 1718956300000
}
```

## 回收站目录(`.trash/`)

当 deep maintenance stage 在 `CO_ENGRAM_TRASH_ENABLED=1` 下运行时,被遗忘的 engram 会移到这里,而不是直接删除。结构镜像主目录树:

```
.trash/
└── 2026-06/                                    # YYYY-MM 分区(UTC)
    └── engineering/typescript/
        └── old-deprecated-api.md
```

**行为:**

- 仅当 `status=forgotten` **且** engram 文件 mtime 早于 `CO_ENGRAM_TRASH_AFTER_DAYS`(默认 30)时,engram 才会进入 `.trash/`。
- ULID 保留不变,因此 `engram_restore` 能够找到并把文件移回。
- 指向 `.trash/` 的 synapse **不会**级联 —— 它们保持为悬空引用,并在恢复时自愈。
- 早于 `CO_ENGRAM_TRASH_PURGE_AFTER_DAYS`(默认 365)的分区会在下次清扫时被物理删除。设为 `0` 可完全禁用清除。

**Git 跟踪:**

`.trash/` 是数据仓库的一部分(未被 gitignored)。清扫在可能时使用 `git mv`,因此移动过程中的历史得以保留。这意味着通过 Git 同步的团队成员会看到相同的回收站状态。

## 配置文件(`config/co-engram.yaml`)

仓库级配置,在环境变量 / 插件配置之外叠加应用:

```yaml
defaultCreatedBy: claude-code
defaultVisibility: team
defaultDecayHalfLifeDays: 30
maintenance:
  learningRate: 0.1
  enabledStages: [light, deep, rem]
```

环境变量与插件配置优先级高于此文件。

### `.co-engram/config.json` —— team memory 配置

与上面用户编写的 `config/co-engram.yaml` 不同,`.co-engram/config.json` 是由 host 管理的文件,由首次运行 `co-engram init` 时写入,并在 host 启动时更新。它记录团队选择的 `language` 和磁盘格式迁移状态:

```json
{
  "version": 1,
  "language": "zh",
  "migratedToLanguage": "zh"
}
```

- `language` —— 工具描述、系统提示词,以及**磁盘格式**(中文 vs 英文 YAML 键)的权威语言
- `migratedToLanguage` —— 所有 engram + synapse 文件已经被迁移到的语言。当 host 启动时发现该字段与 `language` 不一致,会执行 `repository.migrateFormat(language)` 把所有文件重写为目标格式,然后将 `migratedToLanguage = language` 写回。这让切换语言成为一次性迁移,而非每文件分支

迁移会重写每个文件(以目标格式 parse + 重新 serialize),但是幂等的:已经处于目标格式的文件会通过 `__语言` 标记或顶部 frontmatter 签名检测到并被跳过。建议:在切换 `language` 前先做 Git 检查点提交,让格式变化成为一个可评审的 diff。

## Git 卫生

由于数据仓库是 Git 仓库,提交会迅速累积。最佳实践:

### 提交信息约定

Co-Engram 使用约定式提交风格的信息:

```
feat(engram): create 01J...A "TypeScript strict mode gotcha"
update(engram): bump 01J...A importance 0.6 → 0.7
archive(engram): 01J...B "superseded by 01J...C"
create(synapse): 01J...A --extends--> 01J...C
```

### 大型仓库管理

在数千个 engram 之后,可考虑:

- **CI 浅克隆**:`git clone --depth 1`
- 若内容包含许多内嵌图片的大型 Markdown 文件,使用 **Git LFS**
- **周期性归档清扫**:`engram_list({ filter: { status: [archived] }, limit: 500 })` 然后批量 forget(超过 500 条用 cursor 翻页)

## 备份策略

数据仓库**本身**就是备份。标准 Git 工作流即可:

- 推送到私有远端(GitHub、GitLab、Gitea)
- 打标签发布:`git tag memory-snapshot-2026-06-21`
- 克隆到新机器以复制记忆

无需特殊工具 —— 这正是设计意图。
