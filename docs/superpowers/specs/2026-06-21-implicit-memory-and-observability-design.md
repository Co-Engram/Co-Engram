# 隐式记忆候选 + 观测系统 设计 spec

**作者:** Yang Yang (with Claude)
**日期:** 2026-06-21
**状态:** Draft — 等用户审核
**关联:** [FlexMem-local 分析](../../../openclaw/extensions/flexmem-local/docs/flexmem-local插件说明文档.md),[co-engram 开源 plan](../../../../.claude/plans/adaptive-knitting-riddle.md)

---

## 1. 背景

co-engram 当前所有 engram 必须通过显式 `engram_create` 产生。这违反了神经科学隐喻——人类记忆绝大多数是隐式形成的,无需意志努力。

外部参考 FlexMem-local 解决了这个问题,但采用完全自动记忆策略,在团队场景下误记代价高。本设计采用**候选提示(prompted candidates)**混合方案:被动观察 → 阈值触发 → 下次会话提示确认 → 格式化入库。

同时,co-engram 缺少观测层:用户无法直观查看记忆状态,系统也缺少自身进化的数据基础。本设计并行引入轻量 Viewer + 审计日志。

---

## 2. 用户决策(已确认)

| 决策点            | 选择                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 实体抽取          | **主题聚类**(跳过命名实体,用对话片段向量化 + 在线聚类)                                                                    |
| 提案注入          | **system prompt 追加**(宿主无关,简单通用)                                                                                 |
| Viewer 节奏       | **严格顺序**(M1 跑通验证价值后再做 Viewer);改自原"并行"决策——更稳健                                                       |
| audit 范围        | **状态变更 + 有效性信号**(create/update/reinforce/forget/restore + retrieve_hit/retrieve_effective/retrieve_inconclusive) |
| 观察窗口          | **按 kind 区分**(observation=6h / fact=24h / pattern=48h / procedure=48h / hypothesis=7d);多 kind 取最长                  |
| inconclusive 影响 | **v1 不影响 reinforcementScore**,纯记录(衰减已由艾宾浩斯机制覆盖,避免双重惩罚)                                            |
| 观察窗口存储      | **落盘到 `.co-engram/observation-windows.jsonl`**(跨进程一致性;SQLite 违反设计原则;纯内存会丢数据)                        |
| efficiency 公式   | `effective / (effective + inconclusive + contradicted)`;`minHits=3` 门槛;contradicted 不额外加权                          |

---

## 3. 总体架构

```
┌────────────────────────────────────────────────────────────┐
│ 宿主层(Claude Code MCP / OpenClaw 插件)               │
│                                                            │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────────┐    │
│  │ 对话观察器  │   │ system       │   │ Viewer HTTP  │    │
│  │ (observer)  │   │ prompt       │   │ 127.0.0.1    │    │
│  │             │   │ 注入器       │   │ :18799       │    │
│  └──────┬──────┘   └──────▲───────┘   └──────┬───────┘    │
│         │                 │                  │            │
└─────────┼─────────────────┼──────────────────┼────────────┘
          │ observe(message) │                  │ REST
          ▼                  │ proposals        │ API
┌────────────────────────────────────────────────────────────┐
│ 核心层(@co-engram/core)                                │
│                                                            │
│  ┌─────────────────────┐  ┌──────────────────────────┐    │
│  │ proposal-engine     │  │ audit-log                │    │
│  │ - 向量化对话片段    │  │ - 记录状态变更           │    │
│  │ - 在线聚类(余弦) │  │ - 写 audit.jsonl         │    │
│  │ - 阈值检测 ≥3 次   │  │                          │    │
│  │ - 生成 proposals   │  │                          │    │
│  └──────────┬──────────┘  └──────────────────────────┘    │
│             │                                              │
│             ▼                                              │
│  ┌─────────────────────────────────────────────────┐      │
│  │ 工具层(新增 3 个,M1 阶段)                   │      │
│  │ - engram_list_proposals                         │      │
│  │ - engram_accept_proposal                        │      │
│  │ - engram_dismiss_proposal                       │      │
│  └─────────────────────────────────────────────────┘      │
└────────────────────────────────────────────────────────────┘
          │
          ▼
┌────────────────────────────────────────────────────────────┐
│ 存储层($DATA_ROOT)                                     │
│                                                            │
│  engrams/  ←  现有三文件结构(不变)                   │
│  .co-engram/                                              │
│    ├── fts.sqlite          ← 现有                         │
│    ├── graph.json          ← 现有                         │
│    ├── signals.jsonl       ← 现有                         │
│    ├── topic-vectors.jsonl ← 新:主题向量缓冲             │
│    ├── proposals.jsonl     ← 新:候选提案                 │
│    └── audit.jsonl         ← 新:行为审计                 │
│  .trash/   ← 上一阶段新增                                │
└────────────────────────────────────────────────────────────┘
```

---

## 4. 模块设计

### 4.1 Proposal Engine(M1 核心)

**位置:** `packages/core/src/observability/proposal-engine.ts`

**职责:**

1. 接收对话片段(user/assistant message)
2. 向量化(委托给宿主提供的 embedder)
3. 在线聚类:与已有主题向量比较,余弦 > 0.75 归为同簇
4. 计数:每簇维护 occurrence count + sample quotes
5. 阈值检查:occurrence ≥ 3 且无匹配 engram(通过 FTS 查询)→ 生成 proposal

**接口:**

```typescript
export interface ProposalEngineDeps {
  readonly repository: EngramRepository;
  readonly embedder: (text: string) => Promise<readonly number[]>;
  readonly dataRoot: string; // 用于持久化 topic-vectors.jsonl / proposals.jsonl
}

export interface ProposalEngine {
  observe(message: {
    role: "user" | "assistant";
    content: string;
    at: string;
  }): Promise<void>;
  listPending(): readonly Proposal[];
  accept(
    entity: string,
    input: { title: string; content: string; domainTags: readonly string[] },
  ): string; // returns engramId
  dismiss(entity: string, reason?: string, dismissDays?: number): void;
}

export interface Proposal {
  readonly entityId: string; // 簇 ID(向量的 hash)
  readonly occurrences: number;
  readonly sampleQuotes: readonly string[]; // 最多保留 3 条
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly centroidExcerpt: string; // 最接近质心的样本(预览用)
  readonly status: "pending" | "accepted" | "dismissed";
}
```

**关键设计选择:**

- **向量存储**:用 `topic-vectors.jsonl`(每行一个簇:`{id, vector, occurrences, samples, lastUpdated}`)而不是 SQLite。理由:
  - 保持 Git 友好(jsonl 可 diff,SQLite 是二进制)
  - 簇数量通常 <1000,jsonl 完全够用
  - 避免引入 SQLite 向量扩展依赖
- **在线聚类**(不调 LLM):每次新片段来,计算余弦相似度,最大相似度 >0.75 → 归簇;否则新建簇。O(n) per observe,n=簇数
- **embedder 由宿主注入**:core 不绑定任何 embedding provider。Claude Code MCP 用 `@modelcontextprotocol/sdk` 的 sampling API,OpenClaw 用 plugin SDK 的 embedding hook
- **去重检查**:用现有 `engram_search(query=centroidExcerpt, limit=1)` 判断是否已有相关 engram。若 top-1 score > 阈值 → 不生成 proposal(因为已经记过了)

### 4.2 Audit Log

**位置:** `packages/core/src/observability/audit-log.ts`

**职责:** 记录 engram 的**状态变更**和**有效性信号**到 `.co-engram/audit.jsonl`,为 co-engram 自身进化提供数据。

**两类事件:**

#### A. 状态变更事件(显式动作)

| action               | 触发点                                          | 含义         |
| -------------------- | ----------------------------------------------- | ------------ |
| `create`             | engram_create                                   | 新建         |
| `update`             | engram_update                                   | 内容修改     |
| `update_lifecycle`   | engram_archive / engram_forget / engram_restore | 状态切换     |
| `reinforce`          | engram_reinforce                                | 正向强化     |
| `report_failure`     | engram_report_failure                           | 显式失败反馈 |
| `sweep_to_trash`     | deep 阶段 sweep                                 | 移入回收站   |
| `restore_from_trash` | engram_restore (from trash)                     | 从回收站恢复 |
| `purge`              | deep 阶段 purge                                 | 物理删除     |
| `propose`            | proposal-engine 阈值触发                        | 生成候选提案 |
| `accept`             | engram_accept_proposal                          | 提案接受     |
| `dismiss`            | engram_dismiss_proposal                         | 提案拒绝     |

#### B. 有效性信号事件(隐式反馈,**核心新增**)

| action                  | 触发点                                 | 含义           |
| ----------------------- | -------------------------------------- | -------------- |
| `retrieve_hit`          | engram_search 命中(返回 score > 阈值)  | 被检索到       |
| `retrieve_effective`    | 检索后该 engram 被 reinforce           | **被证明有效** |
| `retrieve_inconclusive` | 检索后 24h 内无 reinforce 也无 failure | 结果不明确     |
| `contradicted`          | 该 engram 收到新的 contradicts synapse | 被推翻         |

**有效性追踪机制(关键设计):**

```
engram_search 命中 → 写 retrieve_hit(engramId, query, score)
                ↓
        ┌──────────────────────────────────────────┐
        │ 按 engram.kinds 选最长窗口:             │
        │ - observation: 6h                        │
        │ - fact:        24h  ← 默认               │
        │ - pattern:     48h                       │
        │ - procedure:   48h                       │
        │ - hypothesis:  7d                        │
        │ 多 kind 取 max                           │
        │ (写到 observation-windows.jsonl)         │
        └──────────────────────────────────────────┘
                ↓
    ┌───────────┴───────────┐
    ▼                       ▼
engram_reinforce         窗口超时
(窗口期内)              (无任何反馈)
    ↓                       ↓
retrieve_effective      retrieve_inconclusive
```

**接口:**

```typescript
export interface AuditEntry {
  readonly ts: string;
  readonly actor: "user" | "llm" | "system";
  readonly action: AuditAction;
  readonly engramId?: string;
  readonly query?: string; // 仅 retrieve_* 事件
  readonly score?: number; // 仅 retrieve_hit 事件
  readonly metadata?: Record<string, unknown>;
}

export type AuditAction =
  // 状态变更
  | "create"
  | "update"
  | "update_lifecycle"
  | "reinforce"
  | "report_failure"
  | "forget"
  | "restore"
  | "sweep_to_trash"
  | "restore_from_trash"
  | "purge"
  | "propose"
  | "accept"
  | "dismiss"
  // 有效性信号
  | "retrieve_hit"
  | "retrieve_effective"
  | "retrieve_inconclusive"
  | "contradicted";

export class AuditLog {
  constructor(private readonly dataRoot: string) {}
  append(entry: Omit<AuditEntry, "ts">): void;
  query(filter: {
    since?: string;
    until?: string;
    action?: AuditAction | readonly AuditAction[];
    engramId?: string;
    limit?: number;
  }): readonly AuditEntry[];
  /**
   * 派生统计:某 engram 的有效率
   * - hits < minHits(默认 3) → effectiveRate 返回 null(数据不足)
   * - 否则 effectiveRate = effective / (effective + inconclusive + contradicted)
   *   - inconclusive 进分母但不进分子(算半负面信号)
   *   - contradicted 不额外加权(避免误伤用户误标的 contradicts)
   */
  effectiveness(
    engramId: string,
    options?: { minHits?: number },
  ): {
    hits: number;
    effective: number;
    inconclusive: number;
    contradicted: number;
    effectiveRate: number | null; // [0, 1] 或 null(数据不足)
  };
}
```

**集成点:**

- `engram-tools.ts` 每个工具 execute 末尾调 `auditLog.append(...)`(包括 `engram_search` 命中时调 `retrieve_hit`)
- `engram_reinforce` 触发时,检查是否有该 engram 的开放观察窗口,若有 → 写 `retrieve_effective` 并关闭窗口
- light maintenance 阶段:扫描超时的观察窗口(>24h 无反馈)→ 写 `retrieve_inconclusive`
- `contradicts` synapse 创建时:写 `contradicted`
- `trash.ts` sweep/restore/purge 末尾调
- `proposal-engine` accept/dismiss 末尾调

**观察窗口存储:** `.co-engram/observation-windows.jsonl`

```json
{
  "engramId": "openclaw/gateway-arch",
  "query": "how to restart gateway",
  "hitAt": "2026-06-21T10:00:00Z",
  "deadline": "2026-06-22T10:00:00Z"
}
```

light 阶段每次跑时扫描 deadline < now 的窗口,写 `retrieve_inconclusive` 并清理。

**预估日志量:** 每用户每天约 30-100 条(含 retrieve_hit)。1 年约 5-10 万条 → 10-20 MB。仍可接受,后期可加轮转。

**为什么不计 retrieve_miss(没命中)?**

- 每次未命中的 search 都记会产生巨大噪音(用户每天可能 search 几十次,大部分都是 miss)
- 信号价值低:miss 不告诉我们任何具体 engram 的质量
- 如果需要"哪些主题找不到",已经由 proposal-engine 的候选机制覆盖

**efficiency() 的用途:**

- 短期:Viewer 展示"有效率最低的 engram"(候选 archive/forget)
- 中期:metacognition 模块用有效率替代部分人工 verification
- 长期:训练数据,反向调整 decayHalfLifeDays(高有效率 → 延长半衰期)

### 4.3 Viewer(M1 并行)

**位置:** `packages/claude-code-mcp/src/viewer/server.ts`(core 只提供数据访问,viewer 在 mcp 包内)

**架构:**

- Node.js 原生 `http.Server`,绑定 `127.0.0.1`(仅本机)
- 端口 18799(可配),EADDRINUSE 自动重试 5 次
- 默认关闭(`CO_ENGRAM_VIEWER_ENABLED=1` 才启动)
- 可选 token 认证(`CO_ENGRAM_VIEWER_TOKEN`)

**端点(11 个,严格遵守):**

| 端点                 | 方法   | 用途                                 |
| -------------------- | ------ | ------------------------------------ |
| `/api/stats`         | GET    | 全局统计                             |
| `/api/engrams`       | GET    | 列表 + 过滤(支持 sort=effectiveness) |
| `/api/engrams/:id`   | GET    | 单条详情(含有效率、lineage)          |
| `/api/engrams/:id`   | PATCH  | 编辑(委托 engram_update)             |
| `/api/engrams/:id`   | DELETE | 删除(委托 engram_delete)             |
| `/api/search`        | GET    | 复用 engram_search                   |
| `/api/graph`         | GET    | graph.json 静态返回                  |
| `/api/proposals`     | GET    | 候选列表                             |
| `/api/audit`         | GET    | 审计日志查询(支持 action 筛选)       |
| `/api/effectiveness` | GET    | 按 engram 聚合有效率,排序返回        |
| `/api/trash`         | GET    | 回收站列表                           |

**前端:**

- 单页 HTML(原生 + htmx,无构建链)
- 视图:stats 仪表盘 / engram 列表 / 详情卡片 / graph 可视化(vis.js CDN) / proposals 卡片
- 写操作通过 fetch → REST API → MCP 工具,不直接读写文件

**HTML 资源:** 内嵌字符串模板(借鉴 flexmem `html.ts`),不引入额外打包工具

---

## 5. 工具接口扩展

新增 3 个工具(总工具数 22 → 25):

| 工具                      | 输入                                                                       | 输出                   | 副作用                                       |
| ------------------------- | -------------------------------------------------------------------------- | ---------------------- | -------------------------------------------- |
| `engram_list_proposals`   | `{ status?: 'pending' \| 'dismissed' }`                                    | `Proposal[]`           | 无                                           |
| `engram_accept_proposal`  | `{ entity: string; title: string; content: string; domainTags: string[] }` | `{ engramId: string }` | 创建 engram + 标记 proposal accepted + audit |
| `engram_dismiss_proposal` | `{ entity: string; reason?: string; dismissDays?: number }`                | `{ dismissed: true }`  | 标记 dismissed + audit                       |

**openclaw.plugin.json 更新:** `contracts.tools` 数组追加这 3 个名字。

---

## 6. 会话提示注入(M2)

**Claude Code MCP:**

- `parseMaintenanceConfig()` 旁加 `parseProposalConfig()`
- 环境变量:`CO_ENGRAM_PROPOSALS_ENABLED=1`, `CO_ENGRAM_PROPOSALS_THRESHOLD=3`, `CO_ENGRAM_PROPOSALS_SIMILARITY=0.75`
- server 启动时,读 `proposals.jsonl` 中 status=pending 的条目
- 若 >0,在初次 tool list 响应中追加一条说明文本(通过 `server.sendLoggingInfo()`)

**OpenClaw 插件:**

- 在 plugin entry 的 `onSessionStart` hook 中注入 prompt
- 通过 OpenClaw 的 prompt 资源机制暴露

**注入文本示例(英文,双语可配):**

```
[co-engram] N memory candidates pending (entities seen ≥3 times but not recorded).
Use `engram_list_proposals` to view, `engram_accept_proposal` to record, or
`engram_dismiss_proposal` to ignore.
```

---

## 7. 实施阶段

**总原则:** 严格顺序。每个阶段完成且测试通过 + 用户验证价值后,才进入下一个阶段。

### Phase M1 — Proposal Engine + Audit Log + Effectiveness Tracker(core 层)

**目标:** 完成 core 层所有能力 + 单元测试。手工通过 engram_list_proposals 工具验证候选生成。

**文件:**

- 新增 `packages/core/src/observability/proposal-engine.ts`(~250 行)
- 新增 `packages/core/src/observability/audit-log.ts`(~180 行,含有效性追踪)
- 新增 `packages/core/src/observability/effectiveness-tracker.ts`(~120 行,观察窗口管理)
- 新增 `packages/core/src/observability/index.ts`(barrel)
- 新增 `packages/core/src/tools/proposal-tools.ts`(~150 行,3 个工具)
- 修改 `packages/core/src/tools/index.ts` 导出新工具
- 修改 `packages/core/src/tools/engram-tools.ts`:
  - 每个工具 execute 末尾追加 audit
  - `engram_search` 命中时调 `retrieve_hit` + 启动观察窗口
  - `engram_reinforce` 时关闭窗口并写 `retrieve_effective`
- 修改 `packages/core/src/maintenance/engine.ts` light 阶段加超时窗口扫描
- 修改 `packages/core/src/dreaming/trash.ts` sweep/restore/purge 末尾追加 audit
- 新增 `packages/core/test/proposal-engine.test.ts`(~15 测试)
- 新增 `packages/core/test/audit-log.test.ts`(~15 测试,含有效性场景)
- 新增 `packages/core/test/effectiveness-tracker.test.ts`(~10 测试)

**预估:** ~1000 行代码 + ~450 行测试
**验收标准:** `pnpm -r test` 全部通过 + typecheck 通过 + 手动调 `engram_list_proposals` 能看到候选

### Phase M2 — Viewer 基础版(等 M1 验证价值后)

**前置:** 用户已通过 M1 看到候选机制产生真实提案(避免过早投入 UI 工程)

**文件:**

- 新增 `packages/claude-code-mcp/src/viewer/server.ts`(~350 行)
- 新增 `packages/claude-code-mcp/src/viewer/html.ts`(~200 行)
- 修改 `packages/claude-code-mcp/src/mcp-server.ts` 加 viewer 启动逻辑
- 新增 `packages/claude-code-mcp/test/viewer.test.ts`(~10 测试)

**预估:** ~600 行代码 + ~200 行测试
**验收标准:** 浏览器打开 127.0.0.1:18799 能看到 engram 列表 + 候选列表 + 有效率排序

### Phase M3 — 宿主集成(候选注入 system prompt)

**前置:** Viewer 完成,用户可在 UI 看到候选列表(为注入机制提供验证手段)

**文件:**

- 修改 `packages/claude-code-mcp/src/register.ts` 加 observer hook
- 修改 `packages/claude-code-mcp/src/mcp-server.ts` 加环境变量
- 修改 `packages/openclaw-plugin/src/plugin-entry.ts` 加事件监听
- 新增 `packages/e2e/test/proposals.e2e.test.ts`(~3 测试)

**预估:** ~400 行代码 + ~150 行测试
**验收标准:** e2e 测试通过 + 实际在 Claude Code 会话开始时看到候选提示

### Phase M4 — OpenClaw Viewer 适配

**文件:**

- 新增 `packages/openclaw-plugin/src/viewer/`(镜像 mcp 版本)
- 修改 `packages/openclaw-plugin/openclaw.plugin.json` 加 viewer 配置 schema

**预估:** ~400 行代码

### Phase M5 — 文档 + Skill 文件

- 更新 `docs/tool-reference.md`(3 个新工具)
- 更新 `docs/maintenance-engine.md`(候选机制章节)
- 更新 `docs/data-format.md`(新文件)
- 新增 `docs/observability.md`(Viewer 使用)
- 更新 `README.md` 双语(工具目录从 22 → 25)

---

## 8. 风险与备选

### 风险

1. **embedder 不可用**:Claude Code MCP 当前 sampling API 不直接提供 embedding。备选:
   - 用 `@modelcontextprotocol/sdk` 的 `sampling` 让宿主 LLM 生成摘要,然后 hash 摘要做相似度比较(无向量但 cheap)
   - 或要求用户配 `CO_ENGRAM_EMBEDDING_ENDPOINT`(指向 OpenAI 兼容 API)

2. **向量降级**:若 embedder 失败,proposal-engine 应 fallback 到 FTS 相似度(BM25)而非崩溃

3. **噪音提案**:聚类可能把无关片段归为一簇。缓解:
   - sampleQuotes 保留原文供 LLM 判断
   - dismiss 反馈可调高相似度阈值
   - 首次 accept/dismiss 后,该簇从缓冲区移除

4. **隐私**:对话片段进入 `.co-engram/topic-vectors.jsonl`,可能含敏感信息。缓解:
   - 向量是浮点数组,不可逆
   - sampleQuotes 默认截断 100 字符,且仅本地存储(gitignored)
   - Viewer 默认不展示 quotes,需点击展开

5. **Viewer 攻击面**:127.0.0.1 binding 已避免外部访问;可选 token 进一步保护;CSP 限制脚本来源

### 不在 v1 范围

- 元学习闭环(用 audit.jsonl 训练 RPE 自适应学习率)
- 跨用户协同过滤(用其他团队的 dismiss 模式优化阈值)
- 多模态记忆(图片/音频)
- Viewer 用户管理(单用户优先)

---

## 9. 验证标准

### 功能验证

```bash
# M1 通过的标准
pnpm -r test           # 所有测试通过(原 1062 + 新 ~25)
pnpm -r typecheck      # 类型无错
pnpm -r build          # 构建无错
```

### 端到端验证(M2 完成后)

```bash
# 启动 MCP server with proposals
CO_ENGRAM_PROPOSALS_ENABLED=1 \
CO_ENGRAM_DATA_ROOT=/tmp/test-memory \
co-engram-mcp &

# 模拟对话(用 mcp-cli 工具)
# 3 次提到 "OpenClaw gateway restart"
# 第 4 次会话开始时,system prompt 应包含候选提示

# 确认 proposals.jsonl 有 1 条 status=pending
cat /tmp/test-memory/.co-engram/proposals.jsonl
```

### Viewer 验证

```bash
CO_ENGRAM_VIEWER_ENABLED=1 co-engram-mcp &
curl http://127.0.0.1:18799/api/stats
# 应返回 JSON
# 浏览器打开 http://127.0.0.1:18799 应看到 engram 列表
```

---

## 10. 开放问题(实施时再决策)

1. **embedder provider 的具体选择** — M1 实施时先实现一个 fallback "hash-based similarity"(无向量),再在 M2 加真正的 embedding provider
2. **主题簇老化策略** — 长期未触发的簇是否自动清理?建议 30 天无新片段 + 未生成 proposal → 清理
3. **Viewer 是否支持批量操作** — 批量 archive/delete?v1 暂不做,避免误操作
4. **audit.jsonl 的轮转策略** — 1 年 10-20MB 不急,但长期需要。建议 append-only,达到 100MB 时切割
