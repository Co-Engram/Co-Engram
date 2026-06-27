# 实施计划:Co-Engram 数据模型 v2

**对应设计文档**: [2026-06-22-per-edge-synapse-refactor-design.md](../specs/2026-06-22-per-edge-synapse-refactor-design.md)
**日期**: 2026-06-22
**前提**: 实验阶段,允许破坏性升级,不需要迁移脚本

## 总览

9 个 phase,按逻辑依赖排序。每个 phase 独立可提交,失败可回滚。

```
Phase 1 (类型基础) ──────── 纯增量,零破坏
   ↓
Phase 2 (存储重写) ──────── 新存储层并行存在
   ↓
Phase 3 (Repository) ────── 切换到新存储
   ↓
Phase 4 (Tools) ─────────── 对外 API 适配
   ↓
Phase 5 (上层适配) ──────── 透明传导
   ↓ ↓
   Phase 6 (Viewer) ─────── 可并行
   ↓
Phase 7 (文档更新) ──────── 功能说明同步
   ↓
Phase 8 (测试重建) ──────── 删旧建新
   ↓
Phase 9 (清理遗留) ──────── 删死代码
```

---

## Phase 1: 类型基础(纯增量)

**目标**: 定义新类型和工具函数,不改现有代码。

### 1.1 新增 ULID 依赖

```bash
cd packages/core && pnpm add ulid
```

### 1.2 新文件:`packages/core/src/types/v2.ts`

```typescript
import type { EngramId, SynapseId, SynapseKind } from "./engram.js";
import type { Language } from "./i18n/index.js";

/** v2 EngramId:ULID 格式,26 字符 */
export type StableEngramId = string; // ULID

/** slug:从 title slugify,可被 frontmatter 锁定 */
export type Slug = string;

/** domainTags 推断结果 */
export interface InferredDomainTags {
  readonly fromPath: readonly string[];
  readonly explicit?: readonly string[];
}

/** engram-index.json 条目 */
export interface EngramIndexEntry {
  readonly stableId: StableEngramId;
  readonly path: string; // 相对于 dataRoot
  readonly title: string;
  readonly slug: Slug;
  readonly slugLocked: boolean;
  readonly domainTags: readonly string[];
  readonly tags: readonly string[];
  readonly kind: string;
  readonly verificationStatus?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly mtime: number;
  readonly contentHash: string;
}

/** engram-index.json 完整结构 */
export interface EngramIndex {
  readonly version: 1;
  readonly engrams: Record<StableEngramId, EngramIndexEntry>;
  readonly lastRebuiltAt: string;
}

/** doctor 扫描报告 */
export interface DoctorReport {
  readonly scannedAt: string;
  readonly totalEngrams: number;
  readonly totalSynapses: number;
  readonly issues: readonly DoctorIssue[];
  readonly autoFixed: number;
  readonly warnings: number;
}

export type DoctorIssueType =
  | "file_moved" // 文件被移动(更新 index)
  | "title_changed" // title 变了(slug 跟随或警告)
  | "file_deleted" // 文件被删(标记 dangling synapse)
  | "no_frontmatter_id" // 新 .md 无 id(提示注册)
  | "dangling_synapse" // synapse 引用不存在的 engram
  | "duplicate_id" // 两文件 id 重复
  | "duplicate_engram" // 内容高度相似
  | "slug_conflict"; // 新 slug 与同目录冲突

export interface DoctorIssue {
  readonly type: DoctorIssueType;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly engramId?: StableEngramId;
  readonly synapseId?: SynapseId;
  readonly path?: string;
  readonly autoFixed: boolean;
}

/** 目录树节点 */
export interface PathTreeNode {
  readonly name: string; // 目录名
  readonly fullPath: string; // 相对 dataRoot 的完整路径
  readonly engramCount: number; // 直接子文件数
  readonly children: readonly PathTreeNode[];
  readonly engramIds: readonly StableEngramId[];
}
```

### 1.3 新文件:`packages/core/src/types/synapse-id.ts`

```typescript
import { createHash } from "node:crypto";
import type { EngramId, SynapseId, SynapseKind } from "./engram.js";

/**
 * 确定性 synapse ID:基于 (from, to, kind) 三元组的 SHA-256 前 16 位
 *
 * 保证:
 *   - 同一 (from, to, kind) → 同一 ID → 同一文件
 *   - 多人独立创建同一条 edge → 写同一个文件 → git auto-merge
 *   - 人类重建 synapse 文件,from/to/kind 对则 id 自动恢复
 */
export function computeSynapseId(
  from: EngramId,
  to: EngramId,
  kind: SynapseKind,
): SynapseId {
  const composite = `${from}|${to}|${kind}`;
  const hash = createHash("sha256")
    .update(composite)
    .digest("hex")
    .slice(0, 16);
  return `syn-${hash}`;
}
```

### 1.4 新文件:`packages/core/src/types/slugify.ts`

```typescript
/**
 * slugify:从 title 生成人类可读的文件名 slug
 *
 * 规则:
 *   - 保留 unicode(中文/日文/韩文等非 ASCII)
 *   - ASCII 字母转小写
 *   - 非法路径字符 / : \ ? * < > " | 替换为 -
 *   - 连续空格合并为一个 -
 *   - 首尾 - 裁剪
 *   - 空字符串 fallback:untitled
 *
 * 例:
 *   "How to Configure Auth" → "how-to-configure-auth"
 *   "操作系统内存优化" → "操作系统内存优化"
 *   "React Hooks 最佳实践" → "react-hooks-最佳实践"
 *   "A/B: Test" → "a-b-test"
 */
export function slugify(title: string): string {
  return (
    title
      .trim()
      .replace(/[/\\:*?<>“|]/g, "-") // 非法字符
      .replace(/\s+/g, "-") // 空格
      .replace(/-+/g, "-") // 连续 -
      .replace(/^[A-Z]/, (c) => c.toLowerCase()) // 仅首字符转小写(如首字符是 ASCII)
      .replace(/^[-]+|[-]+$/g, "") || // 首尾 -
    "untitled"
  );
}

/**
 * 从文件路径推断 domainTags(所有目录层)
 *
 * 例:
 *   "项目管理/需求管理/操作系统内存优化.md" → ["项目管理", "需求管理"]
 *   "操作系统内存优化.md" → []
 */
export function inferDomainTagsFromPath(relativePath: string): string[] {
  const segments = relativePath.split("/");
  // 去掉最后一段(文件名)
  const dirs = segments.slice(0, -1);
  return dirs.filter((s) => s.length > 0 && !s.startsWith("."));
}
```

### 1.5 导出

更新 `packages/core/src/types/index.ts`:

```typescript
export * from "./v2.js";
export * from "./synapse-id.js";
export * from "./slugify.js";
```

### 验证

```bash
cd packages/core
pnpm test test/synapse-id.test.ts   # 确定性测试
pnpm test test/slugify.test.ts       # unicode / 非法字符
pnpm build                           # 类型编译通过
```

### 新增测试

- `computeSynapseId` 确定性:同输入必同输出
- `computeSynapseId` 不同 kind 不同 id
- `slugify` 保留中文
- `slugify` 替换非法字符
- `inferDomainTagsFromPath` 多层路径

### Commit

```
[refactor] v2 types: stable id, deterministic synapse id, slugify
```

---

## Phase 2: 存储重写(新文件,不动旧存储)

**目标**: 实现 v2 存储层,与旧 per-engram 存储并行存在。

### 2.1 新文件:`packages/core/src/storage/v2/engram-store-v2.ts`

职责:

- `readEngramFile(absPath)`: 读 markdown,解析 frontmatter + content
- `writeEngramFile(absPath, { frontmatter, content })`: 写单文件
- `parseFrontmatter(rawYaml)`: YAML → 对象
- `serializeFrontmatter(obj)`: 对象 → YAML
- `computeEngramHash(content)`: sha256

关键实现:

- frontmatter 用 `js-yaml`(已是依赖)
- content 是 frontmatter 之后的原始 markdown
- 写文件时按 `---\n{yaml}\n---\n{content}` 格式

### 2.2 新文件:`packages/core/src/storage/v2/synapse-store-v2.ts`

职责:

- `readSynapseFile(absPath)`: 读单个 synapse yaml
- `writeSynapseFile(absPath, synapse)`: 写
- `deleteSynapseFile(absPath)`: 删
- `listAllSynapseFiles(dataRoot)`: 扫描 `synapses/**/*.yaml`
- `synapseFilePath(dataRoot, kind, synapseId)`: 构造路径 `{dataRoot}/synapses/{kind}/{synapseId}.yaml`

### 2.3 新文件:`packages/core/src/storage/v2/engram-index.ts`

职责:

- `readEngramIndex(dataRoot)`: 读 `.co-engram/engram-index.json`
- `writeEngramIndex(dataRoot, index)`: 写
- `rebuildEngramIndex(dataRoot, options)`: 全量重建(扫描所有 .md)
- `incrementalUpdateEngramIndex(dataRoot)`: 增量(mtime 比对)
- `lookupByStableId(index, id)`: O(1) 查
- `lookupByPath(index, path)`: O(1) 反查

### 2.4 新文件:`packages/core/src/storage/v2/path-tree.ts`

职责:

- `buildPathTree(index)`: 从 engram-index 构建目录树(PathTreeNode)
- `walkPathTree(node, visitor)`: 遍历

### 2.5 新文件:`packages/core/src/storage/v2/doctor.ts`

职责:

- `runDoctor(dataRoot, options)`: DoctorReport
- 实现表格里的 7 种场景检测 + 自愈
- 增量模式:只扫 mtime 变化的文件
- 全量模式:扫描所有 .md 和 synapses/

### 2.6 graph-builder 升级

新文件:`packages/core/src/storage/v2/graph-builder-v2.ts`

职责:

- `buildGraphFromV2(dataRoot)`: 扫描 engrams + synapses,产出 GraphTraverser 需要的 GraphData
- 不读旧 per-engram synapses.yaml

### 验证

```bash
cd packages/core
pnpm test test/v2/engram-store-v2.test.ts    # 文件 round-trip
pnpm test test/v2/synapse-store-v2.test.ts    # per-edge round-trip
pnpm test test/v2/engram-index.test.ts        # 重建 + 增量
pnpm test test/v2/doctor.test.ts              # 7 种场景
pnpm build
```

### Commit

```
[refactor] v2 storage: single-file engram + per-edge synapse + index + doctor
```

---

## Phase 3: Repository 切换到 v2 存储

**目标**: EngramRepository 内部改用 v2 存储,对外 API 签名除了 readSynapses 外不变。

### 3.1 修改 `packages/core/src/storage/repository.ts`

**破坏性签名变更**:

```typescript
// 旧
readSynapses(engramId): { outgoing: Synapse[] }

// 新
readSynapses(engramId): { outgoing: Synapse[]; incoming: Synapse[] }
```

**内部重写**:

- `createEngram`: 不再写三件套;写单文件 `{dataRoot}/{path}/{slug}.md`;更新 engram-index
- `readEngram`: 查 engram-index 找 path;读单文件;合并 frontmatter + content
- `updateEngram`: 乐观锁(version 检查);写单文件;检测 title 变化触发 slug 跟随
- `deleteEngram`: 删 .md 文件 + 调 `deleteSynapsesTouching(stableId)` + 从 index 移除
- `addOutgoingSynapse`: 用 `computeSynapseId` 生成 idempotent id;写 `synapses/{kind}/{id}.yaml`
- `replaceSynapse`: 读 → 改 → 写 synapse 文件
- `collectAllSynapses`: 扫描 `synapses/**/*.yaml`
- `readSynapses`: 扫描所有 synapse 文件,过滤 from/to == engramId

**新增方法**:

- `readSynapseByEndpoints(from, to, kind)`: 构造确定性 id → 读单文件
- `readSynapseById(synapseId)`: `synapses/{kind}/{id}.yaml`
- `deleteSynapsesTouching(engramId)`: 扫描所有 synapse,from/to 命中则删
- `readEngramByPath(relativePath)`: 直接读文件
- `listPathTree()`: 调 `buildPathTree(index)`
- `runDoctor(options)`: 调 v2 doctor

### 3.2 修改 `packages/core/src/storage/repository.ts` 的 resolveFilePaths

旧实现根据路径式 id 拆 domain/date/hash 构造路径。v2 直接从 engram-index 查 path。

### 验证

```bash
cd packages/core
pnpm test test/repository.test.ts      # 大改 fixture
pnpm build
```

### Commit

```
[refactor] repository: switch to v2 storage, readSynapses returns {outgoing, incoming}
```

---

## Phase 4: Tools 适配

**目标**: engram-tools / synapse-tools 适配新模型;新增 engram_doctor + engram_list_paths。

### 4.1 修改 `packages/core/src/tools/engram-tools.ts`

- `engram_create`: input 可接受 `path`(可选,默认根据 slug 推断);生成 ULID + slugify
- `engram_get`: input 接受 `id`(stable ULID)或 `path`(相对路径)
- `engram_update`: input 加 `expectedVersion`(乐观锁)
- `engram_search`: 不变(纯语义,路径不参与)
- `engram_list`: 返回含 path + domainTags

### 4.2 修改 `packages/core/src/tools/synapse-tools.ts`

- `synapse_create`: 用 `computeSynapseId`;重复创建同 (from,to,kind) → 合并 evidence(idempotent)
- `synapse_get`: 支持按 `synapseId` 或 `(from, to, kind)` 查
- `synapse_list`: 参数改为 `engramId`,返回 `{ outgoing, incoming }`

### 4.3 新工具:`engram_doctor`

```typescript
{
  name: 'engram_doctor',
  description: '扫描 team-memory,检测并修复文件移动/重命名/删除/dangling 等不一致',
  inputSchema: z.object({
    incremental: z.boolean().optional().default(true),
    autoFix: z.boolean().optional().default(true),
  }),
  execute: (args, ctx) => ctx.repository.runDoctor(args),
}
```

### 4.4 新工具:`engram_list_paths`

```typescript
{
  name: 'engram_list_paths',
  description: '返回 team-memory 目录树 + 每个目录的 engram 数',
  inputSchema: z.object({}),
  execute: (_, ctx) => ctx.repository.listPathTree(),
}
```

### 4.5 修改 `packages/core/src/tools/registry.ts`

注册新工具 `engram_doctor` / `engram_list_paths`。

### 验证

```bash
cd packages/core
pnpm test test/tools.test.ts          # 大改断言
pnpm build
```

### Commit

```
[refactor] tools: adapt to v2 model, add engram_doctor + engram_list_paths
```

---

## Phase 5: 上层透明适配

**目标**: 所有基于 collectAllSynapses / readSynapses 的上层代码适配新签名。

### 5.1 修改 `packages/core/src/disclosure/tier-loader.ts:104`

```typescript
// 旧
const synapses = repo.readSynapses(entry.id)
for (const s of synapses.outgoing) { ... }

// 新(不变,因为原本就用 .outgoing)
const { outgoing, incoming } = repo.readSynapses(entry.id)
// incoming 可用于增强 tier-2 disclosure(可选)
```

### 5.2 验证上层透明传导

codegraph 影响数据(已验证):

- `collectAllSynapses`: 27 个 callers
- `readSynapses`: 200+ 个 callers(通过 Repository 类)

需要逐一核查的关键文件:

- `packages/core/src/contradiction/detector.ts`
- `packages/core/src/reinforcement/related.ts`
- `packages/core/src/verification/metacognition.ts`
- `packages/core/src/evolution/triggered.ts`
- `packages/core/src/maintenance/engine.ts`
- `packages/core/src/generative/cross-pollinate.ts`
- `packages/core/src/learning/loop.ts`

### 5.3 修改 `packages/core/src/storage/graph-builder.ts`

切换到 v2 graph-builder-v2(或内联适配)。

### 验证

```bash
cd packages/core
pnpm test                              # 全部 core 测试
pnpm -r build
```

### Commit

```
[refactor] align synapse consumers with v2 model
```

---

## Phase 6: Viewer 升级(可和 Phase 5 并行)

**目标**: buildGraph 返回完整 edge metadata;节点用 slug 展示;HTML 增 filter。

### 6.1 修改 `packages/claude-code-mcp/src/viewer/server.ts` 的 buildGraph

```typescript
// 新:直接扫 synapses/,edge 自带 from/to
const all = ctx.repository.collectAllSynapses();
const index = readEngramIndex(ctx.dataRoot);

const edges = all.map((synapse) => {
  const from = index.engrams[synapse.from];
  const to = index.engrams[synapse.to];
  return {
    id: synapse.id,
    from: synapse.from,
    fromPath: from?.path,
    fromTitle: from?.title,
    to: synapse.to,
    toPath: to?.path,
    toTitle: to?.title,
    kind: synapse.kind,
    weight: synapse.weight,
    direction: synapse.direction,
    evidenceCount: synapse.evidence.length,
    resolutionStatus: synapse.resolutionState?.status,
  };
});

const nodes = Object.values(index.engrams).map((e) => ({
  id: e.stableId,
  path: e.path,
  title: e.title,
  domainTags: e.domainTags,
  tags: e.tags,
  verificationStatus: e.verificationStatus,
}));
```

### 6.2 修改 `packages/claude-code-mcp/src/viewer/html.ts`

- 节点列表:显示 `path` 而非 id
- edge 列表:`fromPath → toPath (kind)` 格式
- 新增 filter:按 kind / domain / path 前缀过滤
- 暂不引入交互式图库(d3/cytoscape)

### 验证

```bash
cd packages/claude-code-mcp
pnpm test test/viewer.test.ts
pnpm build
# 手测 viewer:启动 server,打开浏览器检查 Graph tab
```

### Commit

```
[feat] viewer: show edge metadata + path-based display + filters
```

---

## Phase 7: 更新功能说明文档

**目标**: 同步所有功能文档到 v2 数据模型,确保用户文档与代码行为一致。

### 7.1 重写:`docs/data-format.md`

v1 描述三件套(content.md / meta.yaml / synapses.yaml),全部失效。重写为:

- 新目录布局(无 engrams/ 包裹、任意多层人类目录、synapses/ 平级、.co-engram/ 缓存)
- engram 单文件格式(frontmatter + content)
- synapse per-edge 文件格式(按 kind/ 分目录)
- engram-index.json 结构
- 人类操作示例(mv/rename/删除 → doctor 自愈)

### 7.2 更新:`docs/concepts.md`

- engram 身份:加入 stable id(ULID)概念,路径与身份解耦
- slug:默认从 title slugify 跟随变化;frontmatter 显式写则锁定
- domainTags:从路径所有层推断 + frontmatter 可锁定;用于进化(跨域验证、类比生成)
- synapse:强调是一等实体(独立 id/lifecycle),per-edge 存储

### 7.3 更新:`docs/tool-reference.md`

逐工具更新签名和行为:

| 工具                | 变更                                                  |
| ------------------- | ----------------------------------------------------- |
| `engram_create`     | 新增可选 `path` 参数;返回含 `stableId` + `path`       |
| `engram_get`        | input 接受 `id`(ULID)或 `path`(相对路径)              |
| `engram_update`     | 新增 `expectedVersion`(乐观锁)                        |
| `engram_search`     | 不变(纯语义,路径不参与)                               |
| `engram_list`       | 返回含 `path` + `domainTags`                          |
| `synapse_create`    | 标注 idempotent 行为(同 from/to/kind → 合并 evidence) |
| `synapse_get`       | 支持按 `synapseId` 或 `(from, to, kind)` 查           |
| `synapse_list`      | 返回 `{ outgoing, incoming }`                         |
| `engram_doctor`     | **新工具**:扫描并修复不一致                           |
| `engram_list_paths` | **新工具**:返回目录树                                 |

### 7.4 更新:`docs/architecture.md`

- 存储层:v2 模块(engram-store-v2 / synapse-store-v2 / engram-index / doctor / path-tree)
- 数据流:人类文件 → engram-index 缓存 → repository 查询 → tools 返回
- 派生缓存:engram-index.json / graph.json / prompt-signals.json 的角色区分

### 7.5 更新:`docs/quickstart.md`

- 创建 engram 后展示实际文件路径(如 `项目管理/需求管理/操作系统内存优化.md`)
- 新增:文件移动 + doctor 自愈演示
- 新增:跨域 synapse 创建示例

### 7.6 更新:`docs/design-rationale.md`

补充 v2 设计决策的理由:

- 为什么 per-edge(逻辑正确性:synapse 是关系不是属性)
- 为什么 ULID(身份独立于路径:文件移动不破坏关系)
- 为什么 slug 默认跟随 title(一致性:人类改 title,路径反映最新)
- 为什么 domainTags 路径推断(省事 + 进化可用)
- 为什么搜索不走路径(纯语义 + 路径的价值在导航/signals)

### 7.7 更新:`docs/migration.md`

- v0.1 → v0.2:破坏性升级,无迁移脚本
- 用户操作:清空 dataRoot 或重新初始化
- CLI 不兼容点(如有)

### 7.8 更新:`docs/faq.md`

新增 FAQ:

- slug 冲突怎么办(保持旧 slug + doctor 警告)
- 文件移动后 synapse 关系保持吗(是,引用 stable id)
- domainTags 怎么推断(路径所有层 + frontmatter 锁定)
- 如何固定 slug(frontmatter 写 `slug:` 字段)
- 如何手动修复不一致(调 engram_doctor)
- 中文标题的 slug 怎么处理(保留 unicode)

### 7.9 更新:`docs/maintenance-engine.md`

- 加入 doctor 集成(maintenance light 定期全量扫描)
- prompt-signals 的新字段(activePaths / activeDomains / crossDomainSynapses)

### 7.10 更新:`docs/host-claude-code.md` / `docs/host-openclaw.md`

- 如有 CLI 命令变化(如 `co-engram doctor` 新命令)
- MCP 配置无变化(内部存储透明)

### 7.11 更新:`README.md` / `README.zh-CN.md`

- Quickstart 示例:展示人类可读路径(非 hash)
- Tool count:如新增工具导致总数变化
- Architecture 段:存储层描述同步
- 复制到 `packages/*/README.md`(npm pack 需要)

### 7.12 更新:`CHANGELOG.md`

新增 `## [Unreleased]` 条目:

```markdown
## [Unreleased]

### Changed (BREAKING)

- **Data model v2**: engram storage switched from 3-file (content.md / meta.yaml / synapses.yaml) to single-file (frontmatter + content). Existing data must be cleared — no migration script (experimental stage).
- **Engram identity**: switched from path-based id (`testing/2026-06-21-abc`) to ULID stable id (26 chars, never changes). File move/rename no longer breaks synapse references.
- **Synapse storage**: switched from per-engram (`synapses.yaml`) to per-edge (`synapses/<kind>/syn-<hash>.yaml`). Synapse is now a first-class entity.
- **SynapseId**: deterministic hash of `(from, to, kind)`. Duplicate edge creation now merges evidence (idempotent).
- **readSynapses return type**: `{ outgoing }` → `{ outgoing, incoming }`.

### Added

- **engram_doctor tool**: scans team-memory and auto-fixes file moves/renames/deletes/dangling references.
- **engram_list_paths tool**: returns directory tree with engram counts per folder.
- **slug auto-tracking**: slug follows title by default; frontmatter `slug:` field locks it.
- **domainTags inference**: defaults to all path segments; frontmatter `domainTags:` overrides.
- **prompt-signals**: new `activePaths` / `activeDomains` / `crossDomainSynapses` fields.

### Removed

- 3-file engram storage (content.md / meta.yaml / synapses.yaml)
- Path-based engram id
- per-engram synapses.yaml
```

### 验证

```bash
# 文档内链接检查
grep -rn '\]\(' docs/ README.md README.zh-CN.md | grep -E '\.md\)' | while read line; do
  path=$(echo "$line" | sed -E 's/.*\]\(([^)]+)\).*/\1/')
  # 检查链接目标存在
done

# 文档与代码一致性抽查
# - tool-reference.md 里的工具名 vs registry.ts 注册的工具名
# - data-format.md 里的目录结构 vs 实际存储
# - concepts.md 里的类型定义 vs types/v2.ts
```

### Commit

```
[docs] sync all docs to v2 data model (single-file + per-edge + ULID)
```

---

## Phase 8: 测试重建

**目标**: 删除基于旧模型的 fixture;新建覆盖 v2 全部行为的测试。

### 7.1 删除旧测试 fixture

- 所有构造 `domain/date/hash/` 三件套的 helper
- 所有基于路径式 engram id 的断言

### 7.2 新增测试场景

**`test/v2/idempotent-create.test.ts`**:

- 重复创建同 (from, to, kind) → 同一 synapseId
- evidence 自动合并(非报错)

**`test/v2/cascade-delete.test.ts`**:

- 删 engram A → 所有 from=A 或 to=A 的 synapse 消失
- engram-index 更新

**`test/v2/file-move.test.ts`**:

- mv 文件后,doctor 检测 id 存在但 path 变了
- index 更新 path,synapse 引用不变

**`test/v2/title-change.test.ts`**:

- title 变 → slug 默认跟随 → rename 文件
- frontmatter 锁定 slug → title 变不跟随
- slug 冲突 → 保持旧 slug + 警告

**`test/v2/domaintags-infer.test.ts`**:

- 路径 `a/b/c/x.md` → domainTags = ["a","b","c"]
- frontmatter 显式 → 锁定

**`test/v2/concurrent-write.test.ts`**:

- Alice 加 evidence A,Bob 加 evidence B(不同条目)
- git auto-merge 无冲突

**`test/v2/doctor-full.test.ts`**:

- 7 种场景全覆盖

**`test/v2/cross-domain-signals.test.ts`**:

- domainTags 交集为空 → crossDomainSynapses 命中
- prompt-signals.json 正确生成

### 7.3 透明传导测试(签名兼容)

- contradiction / reinforcement / metacognition / cross-pollinate:基于 collectAllSynapses
- graph-traverse:基于 graph.json

### 验证

```bash
cd /home/10192021@zte.intra/AIOS/co-engram
pnpm -r test                            # 全仓库测试
```

### Commit

```
[test] rebuild v2 test coverage: idempotent, cascade, move, doctor, concurrent
```

---

## Phase 9: 清理遗留

**目标**: 删除所有旧模型代码,确保无死代码。

### 8.1 删除旧存储代码

- `packages/core/src/storage/synapse-store.ts`(per-engram 版本)
- `packages/core/src/storage/content-store.ts`(如果 v2 合并进了 engram-store-v2)
- `packages/core/src/storage/meta-store.ts`(同上)
- `packages/core/src/storage/synapses-file.ts`(SynapsesFile 类型)

### 8.2 删除旧类型

- `EngramId` 的路径式语义(改为 ULID 注释)
- 旧 `resolveFilePaths`(基于 domain/date/hash)

### 8.3 删除旧测试

- 所有引用三件套路径的测试(已在 Phase 7 替换)

### 8.4 grep 扫描死代码

```bash
grep -rn "SynapsesFile\|resolveFilePaths\|content-store\|meta-store" packages/ \
  --include="*.ts" | grep -v "\.test\.ts"
# 应为空
```

### 验证

```bash
pnpm -r build
pnpm -r test
pnpm check:import-cycles   # 如有
```

### Commit

```
[chore] remove legacy per-engram synapse storage + path-based id
```

---

## 跨 phase 验证清单

每个 phase 完成后:

- [ ] `pnpm -r build` 通过
- [ ] 受影响包的 `pnpm test` 通过
- [ ] codegraph 无新增 import cycle
- [ ] 提交信息符合 conventional commits

全部完成后:

- [ ] `pnpm -r test` 全绿(预期 1400+ tests)
- [ ] `pnpm -r build` 全绿
- [ ] grep 无死代码
- [ ] 手测:创建 engram → 创建 synapse → mv 文件 → doctor → 关系保持
- [ ] 手测:viewer 目录树 + edge metadata 展示正常
- [ ] docs/ 所有文档与 v2 行为一致(data-format / concepts / tool-reference / architecture 等)
- [ ] README Quickstart 示例可跑通(新会话从零开始)
- [ ] CHANGELOG.md 已记录 v2 破坏性升级

## 风险与回滚

- 每个 phase 独立 commit,失败可 `git revert <sha>`
- Phase 3(Repository 切换)是最大风险点——如果上层适配不完全,可能编译失败;Phase 5 必须紧跟
- Phase 7(测试重建)如果卡住,可临时 `skip` 旧测试,先推进 Phase 8 清理
- 实验阶段允许中间状态不完美,优先推进到终态

## 预估工作量

| Phase         | 文件数      | 预估时间   |
| ------------- | ----------- | ---------- |
| 1. 类型基础   | 4 新        | 1-2h       |
| 2. 存储重写   | 6 新        | 4-6h       |
| 3. Repository | 1 大改      | 3-4h       |
| 4. Tools      | 3 改 + 2 新 | 2-3h       |
| 5. 上层适配   | 7+ 核查     | 2-3h       |
| 6. Viewer     | 2 改        | 2h         |
| 7. 文档更新   | 12+ 改/重写 | 3-4h       |
| 8. 测试重建   | 8 新 + 删旧 | 4-6h       |
| 9. 清理       | 删 4+       | 1h         |
| **总计**      |             | **23-32h** |
