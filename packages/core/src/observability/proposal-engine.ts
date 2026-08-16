/**
 * 记忆候选引擎（Proposal Engine）
 *
 * 实现"候选提示(prompted candidates)"机制——被动观察对话片段,
 * 当某主题被多次提及但无匹配 engram 时,生成候选提案等待确认。
 *
 * 工作流:
 *   1. observe(message) — host 每次对话都调用,把片段喂进引擎
 *   2. 内部:向量化 → 在线聚类(余弦 > 阈值归同簇)
 *   3. cluster.occurrences ≥ threshold → 检查是否已有匹配 engram
 *   4. 无匹配 → 生成/更新 proposal(status=pending)
 *   5. 下次会话开始 → system prompt 注入提示
 *   6. accept / dismiss — LLM 或用户决策
 *
 * 设计原则:
 *   - embedder 注入式: core 不绑定 embedding provider
 *   - 默认 embedder: hash-based(无 LLM 成本,准确度低但可用于 M1)
 *   - 查重: 仅用 repository.listEngrams() + 标题子串匹配(简单,M1 够用)
 *   - 失败静默: 观察失败不阻塞对话流
 *
 * @module @co-engram/core/observability
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

import type { EngramRepository } from "../storage/repository.js";
import type { VerificationStatus } from "../types/engram.js";
import type { AuditLog } from "./audit-log.js";
import type { EngramCreateInput, EngramVisibility } from "../types/engram.js";
import type { Synapse } from "../types/synapse.js";
import { isSymmetricKind } from "../types/synapse.js";
import type { SkillRepository } from "../skill/skill-repository.js";
import { upgradeVerification, refuteEngram } from "../verification/upgrade.js";
import { safeEmit } from "../prompt-signals/event-bus.js";
import {
  RuleBasedNecessityEvaluator,
  prefilterMessage,
  type LlmClient,
  type NecessityEvaluator,
  type NecessityVerdict,
} from "./necessity-evaluator.js";
import {
  extractBareMarkdownDefaults,
  extractEngramFieldsWithLlm,
} from "./bare-markdown-extractor.js";
import { normalizeProposalFields } from "./chinese-post-processor.js";
import {
  notFoundError,
  validationError,
  configError,
} from "../tools/error-schema.js";
import {
  parseSkillMd,
  inferSkillFields,
  inferSkillFieldsWithLlm,
} from "../skill/skill-detector.js";

/** Embedder 接口:文本 → 向量 */
export type Embedder = (text: string) => Promise<readonly number[]>;

/** 主题簇 */
export interface TopicCluster {
  /** 簇唯一 ID(短 hash) */
  readonly id: string;
  /** 质心向量(增量平均) */
  readonly centroid: readonly number[];
  /** 出现次数 */
  readonly occurrences: number;
  /** 最近 N 条样本(原文截断,最多 100 字符) */
  readonly samples: readonly string[];
  /** 首次见到时间 */
  readonly firstSeenAt: string;
  /** 最后见到时间 */
  readonly lastSeenAt: string;
}

/** Proposal 来源:对话流聚类 / Claude Code auto-memory 文件 / 外部 .md 检测 / REM 产出 / skill 目录 */
export type ProposalSource =
  | "conversation"
  | "auto-memory"
  | "external-markdown"
  | "rem-verification"
  | "rem-pattern"
  | "rem-synapse"
  | "rem-tag-refresh"
  | "rem-insight"
  | "skill";

/**
 * 预填的 engram 字段(auto-memory 与 external-markdown 来源共用)
 *
 * 对话流聚类的 proposal 不携带 payload —— 仅有 sampleQuotes/centroidExcerpt
 * 片段,LLM 在 accept 时需自行具象化 title/content。
 *
 * auto-memory / external-markdown 来源的 proposal 携带完整 payload —— 文件
 * 本身已是完整内容,accept 时可直接用 payload 创建 engram,LLM 无需重复填表。
 *
 * external-markdown 来源额外携带 `sourcePath`(原始 .md 在 dataRoot 中的相对
 * 路径,用于 accept 时移动/重写文件)。
 */
export interface ProposalPayload {
  readonly title: string;
  readonly content: string;
  readonly summary?: string;
  readonly domainTags: readonly string[];
  readonly contextTags?: readonly string[];
  readonly kind: EngramCreateInput["kind"];
  readonly createdBy?: string;
  readonly sourceType?: EngramCreateInput["sourceType"];
  readonly importance?: number;
  readonly visibility?: EngramCreateInput["visibility"];
  readonly encodingContext?: string;
  /** external-markdown 专用:文件在 dataRoot 内的相对路径 */
  readonly sourcePath?: string;
  /** rem-pattern 专用:REM 提炼置信度(accept 时写入 engram.confidence) */
  readonly remConfidence?: number;
  /** rem-pattern 专用:来源记忆 id 列表(accept 时连 derives_from synapse) */
  readonly remSourceIds?: readonly string[];
  /** rem-pattern 专用:REM 提炼理由(展示给用户,辅助审批) */
  readonly remReason?: string;
  /** rem-synapse 专用:突触操作类型 */
  readonly synapseOp?: "add" | "delete" | "retype";
  /** rem-synapse 专用:突触起点 engram id */
  readonly synapseFrom?: string;
  /** rem-synapse 专用:突触终点 engram id */
  readonly synapseTo?: string;
  /** rem-synapse 专用:add 目标 kind / retype 新 kind */
  readonly synapseKind?: import("../types/synapse.js").SynapseKind;
  /** rem-synapse 专用:retype/delete 原始 kind(幂等 + 校验) */
  readonly synapseOldKind?: import("../types/synapse.js").SynapseKind;
  /** rem-synapse 专用:delete/retype 锁定具体突触 id */
  readonly synapseId?: string;
  /** rem-synapse 专用:add 权重(默认 0.5) */
  readonly synapseWeight?: number;
  /** rem-synapse 专用:REM 提议理由(展示给用户) */
  readonly remSynapseReason?: string;
  /** rem-synapse 专用:REM 置信度(卡片 band 档位) */
  readonly remSynapseConfidence?: number;
  /** rem-synapse 专用:起点标题快照(卡片展示) */
  readonly synapseFromTitle?: string;
  /** rem-synapse 专用:终点标题快照 */
  readonly synapseToTitle?: string;
  /** skill 专用:skill 目录的 skillId（= frontmatter name 或目录名） */
  readonly skillId?: string;
  /** skill 专用:skill 目录相对路径（与 sourcePath 同义，显式命名便于区分） */
  readonly skillSourcePath?: string;
  /** skill 专用:Options I_ω 适用情境（规则版推断） */
  readonly initiationSet?: string;
  /** skill 专用:SKILL.md 原生 allowed-tools(规范化为 string[]) */
  readonly allowedTools?: readonly string[];
  /** skill 专用:SKILL.md 原生 license */
  readonly license?: string;
  /** skill 专用:SKILL.md 原生 version(语义版本,映射到内部 skillVersion 字段) */
  readonly skillVersion?: string;
  /** skill 专用:SKILL.md 原生 metadata(任意键值对) */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** skill 专用:SKILL.md 原生 compatibility(兼容性描述) */
  readonly compatibility?: string;
  /** rem-tag-refresh 专用:待刷新标签的目标 engram id(accept 时改其 domainTags,不创建 engram) */
  readonly tagEngramId?: string;
  /** rem-tag-refresh 专用:刷新前 domainTags 快照(卡片展示 oldTags→newTags diff) */
  readonly tagOldTags?: readonly string[];
  /** rem-tag-refresh 专用:LLM 重提的 domainTags(accept 时写入) */
  readonly tagNewTags?: readonly string[];
  /** rem-tag-refresh 专用:REM 刷新理由(展示给用户) */
  readonly tagReason?: string;
  /** rem-tag-refresh 专用:内容漂移度(展示用) */
  readonly tagDrift?: number;
  /** rem-insight 专用:思维模式(integration/retrospective/inspiration) */
  readonly insightMode?: string;
  /** rem-insight 专用:洞察类型(theme/lesson/analogy/hypothesis) */
  readonly insightType?: string;
  /** rem-insight 专用:独立 critic 综合分(accept 时写入 engram.confidence;机器主观初值) */
  readonly criticScore?: number;
  /** rem-insight 专用:critic 评语(展示给用户,辅助审批) */
  readonly criticRationale?: string;
  /** rem-insight 专用:夜思孵化条目 id(无则非孵化产出) */
  readonly incubationId?: string;
  /** rem-insight 专用:夜思轮次(entityId 防撞车的关键成分) */
  readonly insightRound?: number;
}

/** REM 元认知验证 proposal 的 payload（accept 时改 verificationStatus,不创建 engram） */
export interface VerificationProposalPayload {
  /** REM 建议的目标状态 */
  readonly action: string;
  /** 修改前 verificationStatus */
  readonly before: string;
  /** 修改后（= action） */
  readonly after: string;
  /** REM truth score */
  readonly truthScore: number;
  /** REM 为什么建议 */
  readonly reasoning: string;
}

/** 候选提案 */
export interface Proposal {
  /** 关联的 cluster id / `am:<slug>`(auto-memory) / `ext:<relpath-hash>`(external-markdown) */
  readonly entityId: string;
  /** 出现次数(snapshot) */
  readonly occurrences: number;
  /** 样本引用(snapshot,最多 3 条) */
  readonly sampleQuotes: readonly string[];
  /** 最接近质心的样本(用于预览) */
  readonly centroidExcerpt: string;
  /** 首次见到时间 */
  readonly firstSeenAt: string;
  /** 最后见到时间 */
  readonly lastSeenAt: string;
  /** 创建时间(生成 proposal 时) */
  readonly createdAt: string;
  /** 状态 */
  readonly status: "pending" | "accepted" | "dismissed";
  /** dismiss 时的截止时间(期间不再提示) */
  readonly dismissedUntil?: string;
  /** dismiss 原因 */
  readonly dismissReason?: string;
  /** accept 时创建的 engramId */
  readonly acceptedEngramId?: string;
  /** 必要性评估理由(展示给用户,辅助审批决策) */
  readonly necessityReason?: string;
  /** 必要性评估触发的规则(规则版填充,如 'high_repetition') */
  readonly necessityRule?: string;
  /** LLM 建议的标题(可作审批草稿) */
  readonly suggestedTitle?: string;
  /** 来源标识:对话流聚类(默认,向前兼容)/ auto-memory 文件 / 外部 .md 检测 */
  readonly source?: ProposalSource;
  /** auto-memory 来源时的可读 slug(用于 list/audit 展示) */
  readonly slug?: string;
  /** external-markdown 来源时的相对路径(用于 list/audit 展示) */
  readonly sourcePath?: string;
  /** external-markdown 来源时,上次刷新 proposal 所依据的源文件 mtime(ms)。
   * listPending/listAll 入口的 refreshStaleFileProposals 据此判断文件是否被外部
   * 编辑(mtime 变新则同步重提取),实现「改文件 → 提案标题/内容同步最新」。 */
  readonly sourceMtimeMs?: number;
  /** 预填的 engram 字段(auto-memory / external-markdown 来源专用;conversation 来源恒为 undefined) */
  readonly payload?: ProposalPayload;
}

/** auto-memory proposal 的 entityId 前缀(命名空间隔离,永不与对话聚类 `c<dim>-<hash>` 冲突) */
export const AUTO_MEMORY_PROPOSAL_PREFIX = "am:";

/**
 * rem-insight 提案的确定性 entityId(导出供 incubator 在 timeline 记录同案 id):
 * `rem-insight:<sha256(mode|incubationId|round|sortedSourceIds)[:16]>`。
 * 显式纳入轮次防夜思回灌多轮撞幂等(spec §七 v2 关键修复)。
 */
export function insightEntityId(
  mode: string,
  incubationId: string | undefined,
  round: number,
  sourceIds: readonly string[],
): string {
  const sortedIds = [...sourceIds].sort();
  const hash = createHash("sha256")
    .update([mode, incubationId ?? "", String(round), sortedIds.join(",")].join("|"))
    .digest("hex")
    .slice(0, 16);
  return `rem-insight:${hash}`;
}

/** external-markdown proposal 的 entityId 前缀(命名空间隔离,永不与其他来源冲突) */
export const EXTERNAL_MARKDOWN_PROPOSAL_PREFIX = "ext:";

/** skill proposal 的 entityId 前缀 */
export const SKILL_PROPOSAL_PREFIX = "skill:";

/**
 * tombstone 文件的 unique entityId 上限,超过则触发 compact。
 *
 * 防止 append-only 文件无限增长。compact 三步压缩(方案 C):
 * 1. **TTL**:删 dismissedUntil <= now(已过冷却期,与 isTombstoned 判定语义等价)
 * 2. **dedup**:同 entityId 保留最后一条(Map 自然语义)
 * 3. **FIFO**:若 unique 数仍 > threshold,按 dismissedAt ?? compactedAt 降序保留最新 N 条
 *
 * 硬上限:compact 后 unique ≤ 1000 × ~90 bytes(仅 entityId + dismissedUntil + compactedAt)
 * = **~90 KB**(实测,无论用户行为如何都不会超)。TTL 删过期是「自然衰减」,FIFO 砍超额是
 * 「硬兜底」 —— 大量永久 dismiss 累积导致 TTL 无能为力时,FIFO 保证文件大小有界。
 *
 * 被 FIFO 砍掉的 entityId 下次 propose 时会复活,等价于「这个 slug 已很久没被
 * 用户驳回,允许重新进入候选池」 —— 产品语义合理(用户偏好可能已变化)。
 *
 * 触发频率:每次 appendTombstone 检查一次 O(1)(readTombstones 走 mtime cache),
 * 只有 unique > 1000 才做实际 readJsonl + writeJsonl。
 */
export const TOMBSTONE_COMPACT_THRESHOLD = 1000;

/** 由 slug 构造 auto-memory proposal 的 entityId */
export function autoMemoryEntityId(slug: string): string {
  return `${AUTO_MEMORY_PROPOSAL_PREFIX}${slug}`;
}

/** 判断 entityId 是否来自 auto-memory */
export function isAutoMemoryProposal(entityId: string): boolean {
  return entityId.startsWith(AUTO_MEMORY_PROPOSAL_PREFIX);
}

/**
 * 由 dataRoot 内相对路径构造 external-markdown proposal 的 entityId。
 *
 * 使用短 hash(SHA-256 前 16 字符)而非原路径,因为路径可能含 `/` 等不友好字符,
 * 且 entityId 在 audit log / proposals.json 中作为 key 频繁出现,短 hash 更紧凑。
 * 同一文件反复触发 watcher → 同一 entityId → proposeExternalMarkdown 幂等去重。
 */
export function externalMarkdownEntityId(relativePath: string): string {
  const hash = createHash("sha256")
    .update(relativePath)
    .digest("hex")
    .slice(0, 16);
  return `${EXTERNAL_MARKDOWN_PROPOSAL_PREFIX}${hash}`;
}

/** 判断 entityId 是否来自 external-markdown */
export function isExternalMarkdownProposal(entityId: string): boolean {
  return entityId.startsWith(EXTERNAL_MARKDOWN_PROPOSAL_PREFIX);
}

/**
 * skill proposal 的 entityId：基于 skill 目录 sourcePath 的稳定 hash
 *
 * 设计同 externalMarkdownEntityId：sha256(sourcePath) 取前 16 位 hex，
 * 命名空间隔离为 skill: 前缀。同一 skill 目录反复触发 detector →
 * 同一 entityId → proposeSkill 幂等去重。
 */
export function skillEntityId(sourcePath: string): string {
  const hash = createHash("sha256")
    .update(sourcePath)
    .digest("hex")
    .slice(0, 16);
  return `${SKILL_PROPOSAL_PREFIX}${hash}`;
}

/** Proposal Engine 配置 */
export interface ProposalEngineConfig {
  /** 触发阈值(默认 3) */
  readonly threshold?: number;
  /** 余弦相似度阈值(默认 0.75) */
  readonly similarityThreshold?: number;
  /** 样本保留数(默认 3) */
  readonly maxSamples?: number;
  /** 默认 dismiss 天数(默认 30) */
  readonly defaultDismissDays?: number;
  /** 短消息过滤阈值(默认 20 字符,更短跳过;Layer 1 已用更严格规则,此字段仅作粗筛) */
  readonly minMessageLength?: number;
}

/** 默认配置 */
export const DEFAULT_PROPOSAL_CONFIG: Required<ProposalEngineConfig> = {
  threshold: 3,
  similarityThreshold: 0.75,
  maxSamples: 3,
  defaultDismissDays: 0,
  minMessageLength: 20,
};

/** 已知机器/系统作者标签(精确匹配)——非真人。accept 保留 external-markdown 的
 *  payload.createdBy 时必须排除这些值,否则机器标签污染 engram 作者字段并自我传播。 */
const MACHINE_AUTHOR_LABELS = new Set<string>([
  "proposal-engine",
  "claude-code",
  "claude-code-auto-memory",
  "dreaming-rem",
  "unknown",
  "system",
]);

/** 机器作者标签前缀(rem-*-accept / skill-proposal-accept / skill-batch-accept)。 */
const MACHINE_AUTHOR_PREFIXES = ["rem-", "skill-proposal", "skill-batch"];

/**
 * 判断 createdBy 是否为「机器/系统标签」而非真人作者。
 *
 * accept 的 external-markdown 分支默认保留 payload.createdBy(外部文档原作者,事实信息)。
 * 但若该值是 host/系统误填的机器标签,保留它违反「作者归属原则」(createdBy 必须是真人
 * git 身份),且会让机器标签随 .md 被 external-markdown watcher 二次扫描而自我传播。
 * 命中机器标签(或空/缺省)时,accept 应回退到真人 git author(resolveCreatedByOrDefault)。
 */
export function isMachineAuthorLabel(
  name: string | undefined | null,
): boolean {
  if (typeof name !== "string" || name.trim().length === 0) return true;
  const v = name.trim();
  if (MACHINE_AUTHOR_LABELS.has(v)) return true;
  return MACHINE_AUTHOR_PREFIXES.some((prefix) => v.startsWith(prefix));
}

/**
 * Proposal Engine
 *
 * 使用:
 *   const engine = new ProposalEngine({ repository, embedder, auditLog, dataRoot })
 *   await engine.observe({ role: 'user', content: '...', at: nowIso })
 *   const pending = engine.listPending()
 *   engine.accept(entityId, { title, content, domainTags })
 */
export class ProposalEngine {
  private readonly repository: EngramRepository;
  private readonly embedder: Embedder;
  private readonly auditLog: AuditLog;
  private readonly dataRoot: string;
  private readonly config: Required<ProposalEngineConfig>;
  private readonly clustersFile: string;
  private readonly proposalsFile: string;
  private readonly tombstonesFile: string;
  private readonly necessityEvaluator: NecessityEvaluator;
  private readonly skillRepository?: SkillRepository;
  /**
   * 默认创建者(host adapter 注入的 git author:user.name > user.email)。
   *
   * accept 内部 createdBy 兜底链:
   *   input.createdBy(工具层传的 ctx.defaultCreatedBy) > this.defaultCreatedBy
   *   (host 注入) > "unknown"。
   *
   * 设计理由:createdBy 是「人类责任归属」字段,core 不冒充任何机器角色
   * (历史值 "proposal-engine" / "rem-*-accept" / "skill-proposal-accept" 已清除)。
   * host adapter 从 git config 解析当前操作者身份注入,使 viewer / MCP / daemon
   * 审批路径的作者统一为真人,而非机器标签。
   */
  private readonly defaultCreatedBy?: string;
  /**
   * 动态作者解析器(host 注入):每次调读最新 git 身份(user.name > email),
   * 优先于 defaultCreatedBy 启动快照。git user.name 改动后无需重启即生效。
   */
  private readonly resolveCreatedBy?: () => string | undefined;
  /** 宿主标识(构造注入);所有 proposal 审计 append 自动携带,见 appendAcceptAudit */
  private readonly host?: string;
  /**
   * readProposals / readClusters 的 mtime-based cache。
   *
   * 背景(2026-07 性能修复):旧实现每次 listPending / listAll / 调用方读
   * proposals.jsonl(9.4MB / 5400+ 条候选)都走 readFileSync + split + JSON.parse,
   * 单次 ~200-500ms 同步 IO。13 处调用点(viewer 端点、prompts、register、tools 等)
   * 反复触发,叠加导致 event loop 长时间阻塞 → ProcessLock heartbeat setInterval
   * 没机会跑 → onLost 不触发 → 卡死的旧 holder 持续占着 viewer port + 烧 CPU。
   *
   * 缓存策略:statSync 极快(metadata only,~0.1ms),只在 mtime 变化时重新解析。
   * writeProposals / writeClusters 后自动 invalidate(同进程内一致)。
   * 跨进程:外部进程(如 git pull / editor)修改 proposals.jsonl 后,本进程下次
   * readProposals 会 statSync 检测到 mtime 变化,自动 reload。
   */
  private proposalsCache: { mtime: number; data: Proposal[] } | null = null;
  private clustersCache: { mtime: number; data: TopicCluster[] } | null = null;
  /**
   * dismissed-tombstones 的 mtime-based cache。
   *
   * 背景(2026-07 dismiss-复活 bug):用户 dismiss auto-memory proposal 后,
   * 若再点「清空已驳回」(purgeDismissed),proposals.jsonl 中的 dismissed 行被
   * 物理删除。但 ~/.claude/.../memory/*.md 仍在磁盘,AutoMemorySyncEngine 下次
   * 扫描调 proposeAutoMemory 时,readProposals 找不到 existing → 走「新建」分支,
   * 用户驳回过的 proposal 全部复活为 pending。
   *
   * tombstone 是 dismiss 时的 append-only 永久记录,独立于 proposals.jsonl,
   * 即使 proposals 行被 purge,tombstone 仍生效。三个 propose 入口
   * (proposeAutoMemory / proposeExternalMarkdown / maybePromoteToProposal)
   * 在 existing 检查后,额外查 isTombstoned —— 命中则返回 no-change。
   *
   * dismissedUntil 语义保留:null = 永久屏蔽;ISO string = 屏蔽到该时刻。
   * readTombstones 用 Map(entityId → dismissedUntil),同 entityId 多次 dismiss
   * 时后写覆盖前写,自然取最新状态。
   */
  private tombstonesCache: {
    mtime: number;
    data: Map<string, string | null>;
  } | null = null;

  constructor(deps: {
    readonly repository: EngramRepository;
    readonly embedder: Embedder;
    readonly auditLog: AuditLog;
    readonly dataRoot: string;
    readonly config?: ProposalEngineConfig;
    /**
     * 必要性评估器(可选)。
     * 默认 RuleBasedNecessityEvaluator(零依赖,挡机械噪声)。
     * host 可注入 LlmNecessityEvaluator(需 LlmClient)做语义判断。
     */
    readonly necessityEvaluator?: NecessityEvaluator;
    readonly skillRepository?: SkillRepository;
    /** 默认创建者(host 注入 git author),详见 this.defaultCreatedBy 注释 */
    readonly defaultCreatedBy?: string;
    /**
     * 动态作者解析器(host 注入):每次调读最新 git 身份,优先于 defaultCreatedBy
     * 启动快照。让 git user.name 改动后无需重启即生效。
     */
    readonly resolveCreatedBy?: () => string | undefined;
    /**
     * 宿主标识(claude-code-mcp / openclaw-plugin / dsh-plugin / viewer)。
     * H7 归因修复(2026-08-16 loop r24):accept 决策审计此前不带 host,
     * 真人点卡 / viewer 批量 / MCP 工具调用在 audit 里不可区分,「rem 自执行」
     * 误判正源于此。host 注入后所有 proposal 审计自动可归因。
     */
    readonly host?: string;
  }) {
    this.repository = deps.repository;
    this.embedder = deps.embedder;
    this.auditLog = deps.auditLog;
    this.dataRoot = deps.dataRoot;
    this.config = { ...DEFAULT_PROPOSAL_CONFIG, ...deps.config };
    this.clustersFile = join(
      deps.dataRoot,
      ".co-engram",
      "topic-clusters.jsonl",
    );
    this.proposalsFile = join(deps.dataRoot, ".co-engram", "proposals.jsonl");
    this.tombstonesFile = join(
      deps.dataRoot,
      ".co-engram",
      "dismissed-tombstones.jsonl",
    );
    this.necessityEvaluator =
      deps.necessityEvaluator ?? new RuleBasedNecessityEvaluator();
    this.skillRepository = deps.skillRepository;
    this.defaultCreatedBy = deps.defaultCreatedBy;
    this.resolveCreatedBy = deps.resolveCreatedBy;
    this.host = deps.host;
  }

  /**
   * proposal accept 决策审计(H7 归因修复)。
   *
   * 统一 action="accept"(此前各分支记 update/create/purge 或漏记,同一「用户批准
   * 提案」语义多种写法,r24 按 action=accept 检索误判「audit 零 accept 事件」;
   * rem-pattern 分支则完全零审计)。具体落盘动作放 metadata.appliedAction,
   * 调用通道放 metadata.via(viewer-card / viewer-batch / mcp),host 来自构造注入。
   */
  private appendAcceptAudit(params: {
    readonly entityId: string;
    readonly engramId: string;
    readonly via?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): void {
    this.auditLog.append({
      actor: "user",
      action: "accept",
      engramId: params.engramId,
      ...(this.host ? { host: this.host } : {}),
      metadata: {
        entityId: params.entityId,
        ...(params.via ? { via: params.via } : {}),
        ...params.metadata,
      },
    });
  }

  /**
   * createdBy 兜底:动态解析器(host 注入,每次读 git)> 启动快照 > "unknown"。
   *
   * 动态优先:让用户改 git config user.name 后无需重启 MCP,新 accept 立即用新值。
   * accept 内 createdBy / verifiedBy 兜底统一走本方法(input.createdBy 仍优先)。
   */
  private resolveCreatedByOrDefault(): string {
    return this.resolveCreatedBy?.() ?? this.defaultCreatedBy ?? "unknown";
  }

  /**
   * 观察一条对话消息
   *
   * 流程:
   *   1. Layer 1 规则预过滤(零成本挡机械噪声:trivial/短消息/低密度)
   *   2. 向量化
   *   3. 找最相似的现有 cluster
   *   4. 归簇 or 新建
   *   5. 若 occurrences 达到阈值 → Layer 2 必要性评估 → 查重 → 生成 proposal
   */
  async observe(message: {
    readonly role: "user" | "assistant" | "system";
    readonly content: string;
    readonly at?: string;
  }): Promise<void> {
    // Layer 1:规则预过滤(挡机械噪声)
    //   - system role 不观察(设计意图)
    //   - 其他被过滤的情形静默丢弃(不写 audit,避免每条对话消息都产生噪音)
    //     Layer 1 拒绝率 60-80%,记 audit 会让 audit.jsonl 被噪声淹没
    if (message.role === "system") return;

    const pre = prefilterMessage(message.content, message.role);
    if (!pre.accepted) {
      return;
    }

    const now = message.at ?? new Date().toISOString();

    let vector: readonly number[];
    try {
      vector = await this.embedder(message.content);
    } catch {
      // embedder 失败:静默放弃本次观察
      return;
    }

    const clusters = this.readClusters();
    const matchResult = findBestMatch(
      vector,
      clusters,
      this.config.similarityThreshold,
    );

    let updatedClusters: readonly TopicCluster[];
    let targetCluster: TopicCluster;

    if (matchResult) {
      targetCluster = addToCluster(
        matchResult.cluster,
        message.content,
        vector,
        now,
        this.config.maxSamples,
      );
      updatedClusters = clusters.map((c) =>
        c.id === targetCluster.id ? targetCluster : c,
      );
    } else {
      const candidate = newCluster(vector, message.content, now);
      // 防御:即使 clusterId 算法发生碰撞,也合并到已有 cluster,
      // 避免文件里出现同 id 多行(findBestMatch 没命中但 id 已存在 →
      // 说明相似度算法和 id 算法不一致,仍按 id 合并以保证文件唯一性)
      const collision = clusters.find((c) => c.id === candidate.id);
      if (collision) {
        targetCluster = addToCluster(
          collision,
          message.content,
          vector,
          now,
          this.config.maxSamples,
        );
        updatedClusters = clusters.map((c) =>
          c.id === targetCluster.id ? targetCluster : c,
        );
      } else {
        targetCluster = candidate;
        updatedClusters = [...clusters, targetCluster];
      }
    }

    this.writeClusters(updatedClusters);

    // 达到阈值 → 检查查重 → 生成 proposal
    if (targetCluster.occurrences >= this.config.threshold) {
      await this.maybePromoteToProposal(targetCluster, now);
    }
  }

  /** 列出 status=pending 的提案 */
  /**
   * REM 元认知验证 proposal（centroidExcerpt 方案:不碰 ProposalPayload 类型）。
   * verification 信息存 centroidExcerpt("before → after") + sampleQuotes(score + reasoning)。
   * dedup: pending 覆盖 / dismissed 冷却 / accepted 跳过。
   */
  proposeVerification(
    engramId: string,
    engramTitle: string,
    action: string,
    before: string,
    truthScore: number,
    reasoning: string,
  ): boolean {
    const entityId = `rem:${engramId}`;
    const proposals = this.readProposals();
    const existing = proposals.find((p) => p.entityId === entityId);

    if (existing?.status === "accepted") return false;
    if (
      existing?.status === "dismissed" &&
      (existing.dismissedUntil === null || // null = 永久屏蔽(之前 bug:null && → false → 不冷却 → 复活)
        (!!existing.dismissedUntil &&
          existing.dismissedUntil > new Date().toISOString()))
    )
      return false;
    // tombstone 检查:purgeDismissed 清 proposals.jsonl 后,tombstone 仍记录 dismiss → 防复活
    if (this.isTombstoned(entityId)) return false;

    const now = new Date().toISOString();
    const proposal: Proposal = {
      entityId,
      occurrences: (existing?.occurrences ?? 0) + 1,
      sampleQuotes: [`score=${truthScore.toFixed(2)}`, reasoning.slice(0, 120)],
      centroidExcerpt: `${engramTitle.slice(0, 30)}|${before}|${action}|${truthScore.toFixed(2)}`,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      createdAt: existing?.createdAt ?? now,
      status: "pending",
      source: "rem-verification",
    };

    const updated = [
      proposal,
      ...proposals.filter((p) => p.entityId !== entityId),
    ];
    this.writeProposals(updated);
    return true;
  }

  /**
   * REM 突触操作提案(add/delete/retype)。
   *
   * entityId 幂等:`rem-synapse:<op>:<sha256(canonical)[:16]>`
   *  - add:canonical = `op|from|to|kind`(对称 kind 端点规范化,见 isSymmetricKind)
   *  - delete:canonical = `op|from|to|oldKind`
   *  - retype:canonical = `op|from|to|oldKind|kind`
   *
   * 同 entityId:accepted 跳过;dismissed 走 tombstone 冷却;pending 覆盖。
   */
  proposeSynapseOp(input: {
    readonly op: "add" | "delete" | "retype";
    readonly from: string;
    readonly to: string;
    readonly kind: import("../types/synapse.js").SynapseKind;
    readonly oldKind?: import("../types/synapse.js").SynapseKind;
    readonly synapseId?: string;
    readonly weight?: number;
    readonly reason: string;
    readonly confidence: number;
    readonly fromTitle?: string;
    readonly toTitle?: string;
  }): boolean {
    // canonical key:op + 端点 + kind。对称 kind 的 add 端点规范化,
    // 保证 add(A,B) 与 add(B,A) 视为同一提案(对称关系无方向,源自 isSymmetricKind)。
    const op = input.op;
    let cf = input.from;
    let ct = input.to;
    if (op === "add" && isSymmetricKind(input.kind) && cf > ct) {
      [cf, ct] = [ct, cf];
    }
    const canonical =
      op === "add"
        ? `${op}|${cf}|${ct}|${input.kind}`
        : op === "delete"
          ? `${op}|${input.from}|${input.to}|${input.oldKind ?? ""}`
          : `${op}|${input.from}|${input.to}|${input.oldKind ?? ""}|${input.kind}`;
    const hash = createHash("sha256")
      .update(canonical)
      .digest("hex")
      .slice(0, 16);
    const entityId = `rem-synapse:${input.op}:${hash}`;
    const proposals = this.readProposals();
    const existing = proposals.find((p) => p.entityId === entityId);

    if (existing?.status === "accepted") return false;
    if (
      existing?.status === "dismissed" &&
      (existing.dismissedUntil === null || // null = 永久屏蔽(之前 bug:null && → false → 不冷却 → 复活)
        (!!existing.dismissedUntil &&
          existing.dismissedUntil > new Date().toISOString()))
    )
      return false;
    // tombstone 检查:purgeDismissed 清 proposals.jsonl 后,tombstone 仍记录 dismiss → 防复活
    if (this.isTombstoned(entityId)) return false;

    const now = new Date().toISOString();
    const proposal: Proposal = {
      entityId,
      occurrences: (existing?.occurrences ?? 0) + 1,
      sampleQuotes: [
        `confidence=${input.confidence.toFixed(2)}`,
        input.reason.slice(0, 120),
      ],
      centroidExcerpt: input.fromTitle?.slice(0, 40) ?? input.from,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      createdAt: existing?.createdAt ?? now,
      status: "pending",
      source: "rem-synapse",
      payload: {
        title: `${input.op} synapse ${input.from}→${input.to}`,
        content: input.reason,
        domainTags: [],
        kind: "pattern",
        synapseOp: input.op,
        synapseFrom: input.from,
        synapseTo: input.to,
        synapseKind: input.kind,
        synapseOldKind: input.oldKind,
        synapseId: input.synapseId,
        synapseWeight: input.weight,
        remSynapseReason: input.reason,
        remSynapseConfidence: input.confidence,
        synapseFromTitle: input.fromTitle,
        synapseToTitle: input.toTitle,
      },
    };

    const updated = [
      proposal,
      ...proposals.filter((p) => p.entityId !== entityId),
    ];
    this.writeProposals(updated);
    return true;
  }

  /**
   * REM 模式提炼 proposal（payload 方案:产生**新** pattern 记忆）。
   *
   * 与 rem-verification（改已有记忆状态,不创建 engram）不同,rem-pattern 是
   * dreaming 从多个相似记忆提炼出的高阶 pattern,accept 时**创建新 pattern engram**
   * + 连 derives_from synapse。因此用 payload 携带完整新记忆字段(title/content/
   * summary/domainTags/kind=pattern)+ REM 特有信息(remConfidence/remSourceIds/remReason)。
   *
   * dedup:同一组来源记忆(sourceIds)视为同一提案——重复提炼覆盖(pending)/
   * 冷却(dismissed)/跳过(accepted)。entityId = rem-pattern:<sourceIds sha256 hash>。
   */
  proposePattern(input: {
    readonly title: string;
    readonly content: string;
    readonly summary: string;
    readonly confidence: number;
    readonly reason: string;
    readonly sourceIds: readonly string[];
    readonly domainTags: readonly string[];
  }): boolean {
    const sortedIds = [...input.sourceIds].sort();
    const hash = createHash("sha256")
      .update(sortedIds.join(","))
      .digest("hex")
      .slice(0, 16);
    const entityId = `rem-pattern:${hash}`;
    const proposals = this.readProposals();
    const existing = proposals.find((p) => p.entityId === entityId);

    if (existing?.status === "accepted") return false;
    if (
      existing?.status === "dismissed" &&
      (existing.dismissedUntil === null || // null = 永久屏蔽(之前 bug:null && → false → 不冷却 → 复活)
        (!!existing.dismissedUntil &&
          existing.dismissedUntil > new Date().toISOString()))
    )
      return false;
    // tombstone 检查:purgeDismissed 清 proposals.jsonl 后,tombstone 仍记录 dismiss → 防复活
    if (this.isTombstoned(entityId)) return false;

    const now = new Date().toISOString();
    const proposal: Proposal = {
      entityId,
      occurrences: (existing?.occurrences ?? 0) + 1,
      sampleQuotes: [
        `confidence=${input.confidence.toFixed(2)}`,
        input.reason.slice(0, 120),
      ],
      centroidExcerpt: input.title.slice(0, 80),
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      createdAt: existing?.createdAt ?? now,
      status: "pending",
      source: "rem-pattern",
      payload: {
        title: input.title,
        content: input.content,
        summary: input.summary,
        domainTags: input.domainTags,
        kind: "pattern",
        sourceType: "inferred",
        importance: 0.7,
        remConfidence: input.confidence,
        remSourceIds: input.sourceIds,
        remReason: input.reason,
      },
    };

    const updated = [
      proposal,
      ...proposals.filter((p) => p.entityId !== entityId),
    ];
    this.writeProposals(updated);
    return true;
  }

  /**
   * REM 标签刷新 proposal(payload 方案:改已有记忆的 domainTags,不创建 engram)。
   *
   * tag-refresh 把"笼统占位标签"(imported/uncategorized)或漂移后的旧标签刷新成
   * 内容语义标签。与 rem-verification/rem-synapse 同属"改字段不建 engram"——accept 时
   * 才 updateEngram(tagEngramId, { domainTags }),dismiss 则保持原标签。
   *
   * 与 rem-pattern(建新 engram)的区别:本 proposal 的 payload 携带 tagEngramId +
   * tagOldTags + tagNewTags,accept 用 newTags 覆盖目标 engram 的 domainTags。
   *
   * dedup:同一目标 engram 视为同一提案——重复刷新覆盖(pending)/冷却(dismissed)/
   * 跳过(accepted)。entityId = rem-tag-refresh:<engramId>。
   */
  /**
   * REM 深度思考洞察提案(rem-insight;spec §七)。
   *
   * entityId 由 insightEntityId() 计算(纳入轮次,v2 关键修复):夜思回灌
   * 多轮若沿用 proposePattern 式纯 sourceIds 哈希,第二轮起会被幂等机制吞掉;
   * 纳入 mode+incubationId+round 后每轮独立成案。非孵化路径 round=0,
   * 同 mode+sources 天然去重(期望语义)。
   *
   * 幂等三段与 proposePattern 一致:accepted 跳过 / pending 同案不重写 /
   * dismissed 冷却 / tombstone 防复活。
   */
  proposeInsight(input: {
    readonly mode: string;
    readonly insightType: string;
    readonly title: string;
    readonly content: string;
    readonly summary: string;
    readonly domainTags: readonly string[];
    readonly sourceIds: readonly string[];
    readonly criticScore: number;
    readonly criticRationale: string;
    readonly incubationId?: string;
    readonly round?: number;
  }): boolean {
    const entityId = insightEntityId(
      input.mode,
      input.incubationId,
      input.round ?? 0,
      input.sourceIds,
    );
    const proposals = this.readProposals();
    const existing = proposals.find((p) => p.entityId === entityId);

    if (existing?.status === "accepted") return false;
    // 已 pending 的同案(同 mode+incubationId+round+sources)不重写、返回 false:
    // 让调用方(runner 限流计数 / incubator 循环检测)以返回值区分「新提案」
    if (existing?.status === "pending") return false;
    if (
      existing?.status === "dismissed" &&
      (existing.dismissedUntil === null ||
        (!!existing.dismissedUntil &&
          existing.dismissedUntil > new Date().toISOString()))
    ) {
      return false;
    }
    if (this.isTombstoned(entityId)) return false;

    const now = new Date().toISOString();
    const proposal: Proposal = {
      entityId,
      occurrences: (existing?.occurrences ?? 0) + 1,
      sampleQuotes: [
        `mode=${input.mode} type=${input.insightType} critic=${input.criticScore.toFixed(2)}`,
        input.criticRationale.slice(0, 120),
      ],
      centroidExcerpt: input.title.slice(0, 80),
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      createdAt: existing?.createdAt ?? now,
      status: "pending",
      source: "rem-insight",
      payload: {
        title: input.title,
        content: input.content,
        summary: input.summary,
        domainTags: [...input.domainTags],
        // 溯因假设产物建 kind=hypothesis,其余默认 pattern(spec §三)
        kind: input.insightType === "hypothesis" ? "hypothesis" : "pattern",
        sourceType: "inferred",
        importance: 0.7,
        // confidence = critic 分(机器主观初值,非客观真值)
        remConfidence: input.criticScore,
        remSourceIds: [...input.sourceIds],
        remReason: input.criticRationale,
        insightMode: input.mode,
        insightType: input.insightType,
        criticScore: input.criticScore,
        criticRationale: input.criticRationale,
        ...(input.incubationId !== undefined
          ? { incubationId: input.incubationId }
          : {}),
        ...(input.round !== undefined ? { insightRound: input.round } : {}),
      },
    };

    const updated = [
      proposal,
      ...proposals.filter((p) => p.entityId !== entityId),
    ];
    this.writeProposals(updated);
    return true;
  }

  proposeTagRefresh(input: {
    readonly engramId: string;
    readonly oldTags: readonly string[];
    readonly newTags: readonly string[];
    readonly reason: string;
    readonly drift?: number;
    readonly engramTitle?: string;
  }): boolean {
    const entityId = `rem-tag-refresh:${input.engramId}`;
    const proposals = this.readProposals();
    const existing = proposals.find((p) => p.entityId === entityId);

    if (existing?.status === "accepted") return false;
    if (
      existing?.status === "dismissed" &&
      (existing.dismissedUntil === null || // null = 永久屏蔽
        (!!existing.dismissedUntil &&
          existing.dismissedUntil > new Date().toISOString()))
    )
      return false;
    // tombstone 检查:purgeDismissed 清 proposals.jsonl 后,tombstone 仍记录 dismiss → 防复活
    if (this.isTombstoned(entityId)) return false;

    const now = new Date().toISOString();
    const proposal: Proposal = {
      entityId,
      occurrences: (existing?.occurrences ?? 0) + 1,
      sampleQuotes: [
        `${[...input.oldTags].join(",")} → ${[...input.newTags].join(",")}`,
        input.reason.slice(0, 120),
      ],
      centroidExcerpt: (input.engramTitle ?? input.engramId).slice(0, 80),
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      createdAt: existing?.createdAt ?? now,
      status: "pending",
      source: "rem-tag-refresh",
      payload: {
        title: input.engramTitle ?? input.engramId,
        content: input.reason,
        domainTags: [...input.newTags],
        kind: "pattern",
        tagEngramId: input.engramId,
        tagOldTags: [...input.oldTags],
        tagNewTags: [...input.newTags],
        tagReason: input.reason,
        ...(input.drift !== undefined ? { tagDrift: input.drift } : {}),
      },
    };

    const updated = [
      proposal,
      ...proposals.filter((p) => p.entityId !== entityId),
    ];
    this.writeProposals(updated);
    return true;
  }

  /**
   * 按 entityId 查 proposal(任意状态)。供 tag-refresh 判断"已有 pending 则不重复
   * 提取",避免占位符记忆每轮 REM 白调 LLM。
   */
  findProposalByEntityId(entityId: string): Proposal | undefined {
    return this.readProposals().find((p) => p.entityId === entityId);
  }

  listPending(): readonly Proposal[] {
    this.refreshStaleFileProposals();
    return this.readProposals().filter((p) => {
      if (p.status !== "pending") return false;
      // 检查 dismissedUntil 是否已过期(重新激活)
      if (p.dismissedUntil && p.dismissedUntil > new Date().toISOString()) {
        return false;
      }
      return true;
    });
  }

  /** 列出所有提案(包含 accepted/dismissed,调试用) */
  listAll(): readonly Proposal[] {
    this.refreshStaleFileProposals();
    return this.readProposals();
  }

  /**
   * 按需刷新 stale 的 external-markdown pending 提案:源文件被外部编辑
   * (IDE / git pull / cp)后,fs.watch 在 Linux 上对原子写/进程外修改可能漏
   * 事件,导致提案标题/内容不同步。本方法在每次 listPending/listAll 入口同步
   * 检测 pending external-markdown 提案对应文件的 mtime,变新则用规则版
   * (extractBareMarkdownDefaults,同步快)重提取刷新 title/content,保留旧
   * domainTags/summary(语义标签刷新交给 fs.watch→scan→LLM 链路)。
   *
   * 设计:
   *   - 仅 external-markdown(auto-memory 的 slug 不映射磁盘路径,无法定位)
   *   - 仅 pending(accepted 已入库走 engram 同步;dismissed 不复活)
   *   - sourceMtimeMs 记录上次刷新依据的 mtime,无变化时仅 stat、不读不写
   *   - 同步执行:list 当次即返回最新 title/content(用户核心诉求)
   */
  private refreshStaleFileProposals(): void {
    const proposals = this.readProposals();
    const stale: Array<{
      readonly abs: string;
      readonly relPath: string;
      readonly id: string;
      readonly mtime: number;
      readonly oldDomainTags?: readonly string[];
      readonly oldSummary?: string;
    }> = [];
    for (const p of proposals) {
      if (
        p.status !== "pending" ||
        p.source !== "external-markdown" ||
        !p.sourcePath
      ) {
        continue;
      }
      const abs = join(this.dataRoot, p.sourcePath);
      let mtime: number;
      try {
        mtime = statSync(abs).mtimeMs;
      } catch {
        continue; // 文件已删:清理走 scanForDeletedEngrams,此处跳过
      }
      if (p.sourceMtimeMs !== undefined && mtime <= p.sourceMtimeMs) {
        continue; // 未变
      }
      stale.push({
        abs,
        relPath: p.sourcePath,
        id: p.entityId,
        mtime,
        oldDomainTags: p.payload?.domainTags,
        oldSummary: p.payload?.summary,
      });
    }
    if (stale.length === 0) return;

    // 同步重提取(规则版),保留旧 domainTags/summary(规则版 domainTags 仅 uncategorized)
    for (const item of stale) {
      let raw: string;
      try {
        raw = readFileSync(item.abs, "utf8");
      } catch {
        continue;
      }
      const fields = extractBareMarkdownDefaults(item.relPath, raw);
      this.proposeExternalMarkdown({
        sourcePath: item.relPath,
        title: fields.title,
        content: fields.content,
        kind: fields.kind,
        domainTags: item.oldDomainTags ?? fields.domainTags,
        ...(item.oldSummary !== undefined ? { summary: item.oldSummary } : {}),
      });
    }

    // 记录最新 sourceMtimeMs(即便 payloadEqual 未变也记录,避免下次重复刷新)
    const latest = this.readProposals();
    const mtimeById = new Map(stale.map((s) => [s.id, s.mtime]));
    let dirty = false;
    const next = latest.map((p) => {
      const m = mtimeById.get(p.entityId);
      if (m === undefined || p.sourceMtimeMs === m) return p;
      dirty = true;
      return { ...p, sourceMtimeMs: m };
    });
    if (dirty) this.writeProposals(next);
  }

  /**
   * createEngram + path conflict 兜底（auto-memory / 虚拟 external-markdown 用）。
   *
   * external-markdown 原地纳管（adoptOrPromoteEngramAt）返回 undefined 时（源文件不存在）
   * 或非 external-markdown 来源，走此默认路径：deriveDefaultPath 推导路径创建；
   * 若路径已存在同名 .md，则 adopt 现有文件（orphan 计入 totalEngrams，幂等）。
   */
  private createEngramWithConflictFallback(input: EngramCreateInput): {
    id: string;
  } {
    try {
      return this.repository.createEngram(input);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const m = msg.match(/^Engram already exists at (.+)$/);
      if (!m) throw e;
      const existing = this.repository.ingestExistingEngramFile(m[1]!);
      if (!existing) throw e;
      return existing;
    }
  }

  /**
   * 接受提案 → 创建 engram
   *
   * 当 proposal 自带 payload(auto-memory 来源)且调用方未传 title/content/domainTags/kind 时,
   * 从 payload 兜底 —— 这让 LLM 可直接 `accept(entityId)` 而无需重复填表。
   * conversation 来源的 proposal(payload=undefined)仍要求调用方显式传 title/content。
   *
   * @returns 新建的 engram id
   */
  accept(
    entityId: string,
    input: {
      readonly title?: string;
      readonly content?: string;
      readonly domainTags?: readonly string[];
      readonly createdBy?: string;
      readonly kind?: EngramCreateInput["kind"];
      readonly visibility?: EngramVisibility;
      /** 调用通道标识(viewer-card / viewer-batch / mcp),写入 audit metadata.via 供归因 */
      readonly via?: string;
    },
  ): string {
    const proposals = this.readProposals();
    const target = proposals.find((p) => p.entityId === entityId);
    if (!target) {
      throw notFoundError("Proposal", entityId);
    }

    // REM verification proposal:accept → 完整落盘(status + confidence + evidence + importance 连锁)
    if (target.source === "rem-verification") {
      const engramId = entityId.replace(/^rem:/, "");
      // centroidExcerpt 格式:title|before|action|score(action = 变更后状态)
      const pipeParts = target.centroidExcerpt.split("|");
      const newStatus = pipeParts[2]?.trim() as VerificationStatus | undefined;
      if (newStatus) {
        const evidence = {
          description:
            `REM 审批通过（用户 accept）: ${target.sampleQuotes?.[0] ?? ""} ${target.sampleQuotes?.[1] ?? ""}`.trim(),
          verifiedBy: input.createdBy ?? this.resolveCreatedByOrDefault(),
          confidence: 0.8,
        };
        // 用 upgradeVerification/refuteEngram 替代手动调用:
        // 自动处理 status + confidence + evidence 追加到 derives_from synapse
        if (newStatus === "refuted") {
          refuteEngram(this.repository, engramId, evidence);
        } else {
          // 逐步升级到目标(canTransition 要求相邻级;REM 可能跨级如 unverified→verified)
          const PATH: readonly VerificationStatus[] = [
            "plausible",
            "probable",
            "verified",
          ];
          let current = this.repository.readEngram(engramId).verificationStatus;
          const currentIdx = PATH.indexOf(current as VerificationStatus);
          const targetIdx = PATH.indexOf(newStatus);
          for (let i = Math.max(0, currentIdx + 1); i <= targetIdx; i++) {
            const result = upgradeVerification(
              this.repository,
              engramId,
              PATH[i]!,
              evidence,
              { force: true },
            );
            if (result.applied) {
              current = result.newStatus as VerificationStatus;
            } else {
              break;
            }
          }
        }
      }
      const updated = proposals.map((p) =>
        p.entityId === entityId
          ? {
              ...p,
              status: "accepted" as const,
              acceptedEngramId: engramId,
            }
          : p,
      );
      this.writeProposals(updated);
      this.clustersCache = null;
      // H7 修复:rem-verification accept 决策此前零审计(字段变更靠
      // upgradeVerification/refuteEngram 内部留痕,但「谁批准」不可追溯),补齐。
      this.appendAcceptAudit({
        entityId,
        engramId,
        via: input.via,
        metadata: {
          source: "rem-verification",
          ...(newStatus ? { appliedAction: newStatus } : {}),
          ...(pipeParts[0] ? { title: pipeParts[0].slice(0, 80) } : {}),
        },
      });
      return engramId;
    }

    // REM synapse proposal:accept → 按 op 改突触网络(add/delete/retype),不创建 engram
    if (target.source === "rem-synapse") {
      const p = target.payload;
      if (
        !p ||
        !p.synapseOp ||
        !p.synapseFrom ||
        !p.synapseTo ||
        !p.synapseKind
      ) {
        throw validationError(
          `rem-synapse proposal missing payload (entityId=${entityId})`,
        );
      }
      const createdBy = input.createdBy ?? this.resolveCreatedByOrDefault();
      if (p.synapseOp === "add") {
        const ts = new Date().toISOString();
        const synapse: Synapse = {
          id: randomUUID(),
          from: p.synapseFrom,
          to: p.synapseTo,
          kind: p.synapseKind,
          weight: p.synapseWeight ?? 0.5,
          evidence: [
            {
              description:
                `REM 突触提议(用户 accept): ${p.remSynapseReason ?? ""}`.trim(),
              source: "rem-synapse",
              confidence: p.remSynapseConfidence ?? 0.5,
              addedAt: ts,
              addedBy: createdBy,
            },
          ],
          createdBy,
          createdAt: ts,
          updatedAt: ts,
          visibility: "public",
        };
        this.repository.addOutgoingSynapse(p.synapseFrom, synapse);
      } else {
        const sid =
          p.synapseId ??
          this.resolveSynapseId(p.synapseFrom, p.synapseTo, p.synapseOldKind);
        if (!sid) {
          throw validationError(
            `rem-synapse ${p.synapseOp}:找不到目标突触(from=${p.synapseFrom}, to=${p.synapseTo}, oldKind=${p.synapseOldKind ?? "?"})——可能已被外部删除/修改。proposal 保持 pending,REM 下轮重新提议。`,
            { resourceId: "synapseId" },
          );
        }
        if (p.synapseOp === "delete") {
          this.repository.removeOutgoingSynapse(p.synapseFrom, sid);
        } else {
          this.repository.updateSynapse(p.synapseFrom, sid, {
            kind: p.synapseKind,
            updatedBy: createdBy,
          });
        }
      }

      this.appendAcceptAudit({
        entityId,
        engramId: p.synapseFrom,
        via: input.via,
        metadata: {
          source: "rem-synapse",
          appliedAction:
            p.synapseOp === "add"
              ? "create"
              : p.synapseOp === "delete"
                ? "purge"
                : "update",
          op: p.synapseOp,
          from: p.synapseFrom,
          to: p.synapseTo,
          kind: p.synapseKind,
          oldKind: p.synapseOldKind,
        },
      });

      const updated = proposals.map((pp) =>
        pp.entityId === entityId
          ? {
              ...pp,
              status: "accepted" as const,
              acceptedEngramId: p.synapseFrom,
            }
          : pp,
      );
      this.writeProposals(updated);
      this.clustersCache = null;
      safeEmit({
        type: "proposal_accepted",
        engramId: p.synapseFrom,
        at: new Date().toISOString(),
      });
      return p.synapseFrom;
    }

    // REM tag-refresh proposal:accept → 改目标 engram 的 domainTags,不创建 engram
    if (target.source === "rem-tag-refresh") {
      const p = target.payload;
      if (!p || !p.tagEngramId || !p.tagNewTags || p.tagNewTags.length === 0) {
        throw validationError(
          `rem-tag-refresh proposal missing payload (entityId=${entityId})`,
        );
      }
      if (!this.repository.exists(p.tagEngramId)) {
        throw validationError(
          `rem-tag-refresh:目标 engram 不存在(id=${p.tagEngramId})——可能已被删除。proposal 保持 pending。`,
          { resourceId: "tagEngramId" },
        );
      }
      const createdBy = input.createdBy ?? this.resolveCreatedByOrDefault();
      this.repository.updateEngram(p.tagEngramId, {
        domainTags: [...p.tagNewTags],
        updatedBy: createdBy,
      });
      this.appendAcceptAudit({
        entityId,
        engramId: p.tagEngramId,
        via: input.via,
        metadata: {
          source: "rem-tag-refresh",
          appliedAction: "update",
          oldTags: p.tagOldTags,
          newTags: p.tagNewTags,
          reason: p.tagReason,
        },
      });
      const updated = proposals.map((pp) =>
        pp.entityId === entityId
          ? {
              ...pp,
              status: "accepted" as const,
              acceptedEngramId: p.tagEngramId,
            }
          : pp,
      );
      this.writeProposals(updated);
      this.clustersCache = null;
      safeEmit({
        type: "proposal_accepted",
        engramId: p.tagEngramId,
        at: new Date().toISOString(),
      });
      return p.tagEngramId;
    }

    // REM insight proposal(深度思考/夜思):accept → 复验来源 → 创建 pattern/hypothesis
    // engram(confidence=critic 分)+ derives_from 证据链(spec §五第二关)。
    if (target.source === "rem-insight") {
      const payload = target.payload;
      if (!payload || !payload.title || !payload.content) {
        throw validationError(
          `rem-insight proposal missing payload (entityId=${entityId})`,
        );
      }
      // ---- accept-time 复验:来源仍存在、未被 refute(删来源/refute 后 accept 被拦)----
      const sourceIds = payload.remSourceIds ?? [];
      for (const sourceId of sourceIds) {
        if (!this.repository.exists(sourceId)) {
          throw validationError(
            `rem-insight:来源记忆 ${sourceId} 已不存在 —— 提案依据失效。proposal 保持 pending,请 dismiss。`,
            { resourceId: sourceId },
          );
        }
        const src = this.repository.readEngram(sourceId);
        if (src.verificationStatus === "refuted") {
          throw validationError(
            `rem-insight:来源记忆 ${sourceId} 已被 refute —— 提案依据失效。proposal 保持 pending,请 dismiss。`,
            { resourceId: sourceId },
          );
        }
      }
      const createdBy = input.createdBy ?? this.resolveCreatedByOrDefault();
      // encodingContext 打上 rem-insight 标记:存活期证据链衰减监测据此识别
      // 洞察类 engram(spec §五第三关)
      let insightEngram: { id: string; createdAt: string };
      try {
        insightEngram = this.repository.createEngram({
          title: payload.title,
          content: payload.content,
          summary: payload.summary,
          kind: payload.kind === "hypothesis" ? "hypothesis" : "pattern",
          domainTags: [...payload.domainTags],
          importance: payload.importance ?? 0.7,
          confidence: payload.criticScore ?? payload.remConfidence ?? 0.6,
          sourceType: "inferred",
          createdBy,
          encodingContext: `rem-insight:${entityId}`,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const m = msg.match(/^Engram already exists at (.+)$/);
        if (!m) throw e;
        const existing = this.repository.ingestExistingEngramFile(m[1]!);
        if (!existing) throw e;
        insightEngram = existing;
      }
      // derives_from 证据链指向每条来源(与 rem-pattern 分支同构)
      const timestamp = insightEngram.createdAt;
      for (const sourceId of sourceIds) {
        const synapse: Synapse = {
          id: randomUUID(),
          from: insightEngram.id,
          to: sourceId,
          kind: "derives_from",
          weight: 0.8,
          evidence: [
            {
              description: `REM 深度思考洞察(critic=${(payload.criticScore ?? 0).toFixed(2)}): ${payload.criticRationale ?? ""}`.slice(0, 200),
              source: "rem-insight",
              confidence: payload.criticScore ?? 0.6,
              addedAt: timestamp,
              addedBy: createdBy,
            },
          ],
          createdBy,
          createdAt: timestamp,
          updatedAt: timestamp,
          visibility: "public",
        };
        this.repository.addOutgoingSynapse(insightEngram.id, synapse);
      }
      this.appendAcceptAudit({
        entityId,
        engramId: insightEngram.id,
        via: input.via,
        metadata: {
          source: "rem-insight",
          mode: payload.insightMode,
          criticScore: payload.criticScore,
          ...(payload.incubationId !== undefined
            ? { incubationId: payload.incubationId }
            : {}),
        },
      });
      const updated = proposals.map((p) =>
        p.entityId === entityId
          ? {
              ...p,
              status: "accepted" as const,
              acceptedEngramId: insightEngram.id,
            }
          : p,
      );
      this.writeProposals(updated);
      this.clustersCache = null;
      safeEmit({
        type: "proposal_accepted",
        engramId: insightEngram.id,
        at: new Date().toISOString(),
      });
      return insightEngram.id;
    }

    // REM pattern proposal:accept → 创建**新** pattern engram + 连 derives_from synapse
    // (从 runRemDreaming 自动创建逻辑移来;提案化后,自动创建改为用户 accept 才执行)
    if (target.source === "rem-pattern") {
      const payload = target.payload;
      if (!payload || !payload.title || !payload.content) {
        throw validationError(
          `rem-pattern proposal missing payload (entityId=${entityId})`,
        );
      }
      const createdBy = input.createdBy ?? this.resolveCreatedByOrDefault();
      // path conflict 兜底(同通用分支):若已有同 title 的 pattern engram,
      // createEngram 抛 "Engram already exists at <path>",此时 adopt 现有的而非失败。
      let patternEngram: { id: string; createdAt: string };
      try {
        patternEngram = this.repository.createEngram({
          title: payload.title,
          content: payload.content,
          summary: payload.summary,
          kind: "pattern",
          domainTags: [...payload.domainTags],
          importance: payload.importance ?? 0.7,
          confidence: payload.remConfidence ?? 0.7,
          sourceType: "inferred",
          createdBy,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const m = msg.match(/^Engram already exists at (.+)$/);
        if (!m) throw e;
        const existing = this.repository.ingestExistingEngramFile(m[1]!);
        if (!existing) throw e;
        patternEngram = existing;
      }
      // 连 derives_from synapse 到每个来源记忆(标注新 pattern 的出处)
      const timestamp = patternEngram.createdAt;
      for (const sourceId of payload.remSourceIds ?? []) {
        const synapse: Synapse = {
          id: randomUUID(),
          from: patternEngram.id,
          to: sourceId,
          kind: "derives_from",
          weight: 0.8,
          evidence: [],
          createdBy,
          createdAt: timestamp,
          updatedAt: timestamp,
          visibility: "public",
        };
        this.repository.addOutgoingSynapse(patternEngram.id, synapse);
      }
      const updated = proposals.map((p) =>
        p.entityId === entityId
          ? {
              ...p,
              status: "accepted" as const,
              acceptedEngramId: patternEngram.id,
            }
          : p,
      );
      this.writeProposals(updated);
      this.clustersCache = null;
      // H7 修复:rem-pattern accept 此前零审计(其余 accept 分支均留痕),补齐决策审计。
      this.appendAcceptAudit({
        entityId,
        engramId: patternEngram.id,
        via: input.via,
        metadata: {
          source: "rem-pattern",
          appliedAction: "create",
          confidence: payload.remConfidence,
        },
      });
      safeEmit({
        type: "proposal_accepted",
        engramId: patternEngram.id,
        at: new Date().toISOString(),
      });
      return patternEngram.id;
    }

    // skill proposal:accept → 创建 Skill 实体（skillRepository.createSkill），不创建 engram
    if (target.source === "skill") {
      const p = target.payload;
      if (
        !p ||
        !nonEmpty(p.skillId) ||
        !nonEmpty(p.skillSourcePath) ||
        !nonEmpty(p.initiationSet)
      ) {
        throw validationError(
          `skill proposal missing payload fields (entityId=${entityId})`,
        );
      }
      if (!this.skillRepository) {
        throw configError(
          "skillRepository",
          "accepting a skill proposal requires skillRepository injected into ProposalEngine (S4 host wiring).",
        );
      }
      // 幂等 accept(2026-08-16 修复):印迹已注册时 createSkill 会抛
      // "Skill already exists" 挡住审批 —— 场景:purgeAccepted 清掉 accepted 行后
      // 提案复活为 pending,或用户曾 skill_create 过同名技能。改为直接采纳现有
      // 印迹:proposal 置 accepted、返回现有 skillId,不重复创建(与 proposeSkill
      // 的印迹级幂等对称)。
      if (this.skillRepository.exists(p.skillId!)) {
        const updated = proposals.map((pp) =>
          pp.entityId === entityId
            ? {
                ...pp,
                status: "accepted" as const,
                acceptedEngramId: p.skillId!,
              }
            : pp,
        );
        this.writeProposals(updated);
        this.clustersCache = null;
        this.appendAcceptAudit({
          entityId,
          engramId: p.skillId!,
          via: input.via,
          metadata: { source: "skill", skillId: p.skillId, idempotent: true },
        });
        safeEmit({
          type: "proposal_accepted",
          engramId: p.skillId!,
          at: new Date().toISOString(),
        });
        return p.skillId!;
      }
      const skill = this.skillRepository.createSkill({
        skillId: p.skillId!, // nonEmpty 已确保非空
        sourcePath: p.skillSourcePath!, // nonEmpty 已确保非空
        initiationSet: p.initiationSet!, // nonEmpty 已确保非空
        createdBy: input.createdBy ?? this.resolveCreatedByOrDefault(),
        ...(input.visibility !== undefined && input.visibility !== "restricted"
          ? { visibility: input.visibility }
          : {}),
        ...(p.allowedTools ? { allowedTools: p.allowedTools } : {}),
        ...(p.license ? { license: p.license } : {}),
        ...(p.skillVersion ? { skillVersion: p.skillVersion } : {}),
        ...(p.metadata ? { metadata: p.metadata } : {}),
        ...(p.compatibility ? { compatibility: p.compatibility } : {}),
      });
      const updatedSkill = proposals.map((pp) =>
        pp.entityId === entityId
          ? {
              ...pp,
              status: "accepted" as const,
              acceptedEngramId: skill.skillId,
            }
          : pp,
      );
      this.writeProposals(updatedSkill);
      this.clustersCache = null;
      this.appendAcceptAudit({
        entityId,
        engramId: skill.skillId,
        via: input.via,
        metadata: { source: "skill", skillId: skill.skillId },
      });
      safeEmit({
        type: "proposal_accepted",
        engramId: skill.skillId,
        at: new Date().toISOString(),
      });
      return skill.skillId;
    }

    // payload 兜底:auto-memory / external-markdown 来源的 proposal 已携带完整 engram 字段。
    // 注意:`??` 只在 null/undefined 时回落,空数组/空字符串需要显式判断(2026-07 修复):
    //   旧实现 `input.domainTags ?? payload?.domainTags` 在前端传 `domainTags: []` 时
    //   不会回落,导致 accept 抛 400。现用「非空生效,否则回落」语义覆盖所有「空」形态。
    const payload = target.payload;
    // conversation 兜底:conversation 来源(payload=undefined)无预填字段,用 proposal
    // 自身字段(sampleQuotes / centroidExcerpt / suggestedTitle)兜底,让 viewer/MCP
    // 默认采纳能成功。优先级:caller input > payload(external-markdown/auto-memory 等)
    // > conversation 兜底。caller 显式传字段仍优先,不破坏自定义路径。
    const payloadTitle = payload?.title;
    const payloadContent = payload?.content;
    const payloadDomainTags = payload?.domainTags;
    const title = nonEmpty(input.title)
      ? input.title
      : nonEmpty(payloadTitle)
        ? payloadTitle
        : nonEmpty(target.suggestedTitle)
          ? target.suggestedTitle
          : nonEmpty(target.centroidExcerpt)
            ? target.centroidExcerpt
            : undefined;
    const content = nonEmpty(input.content)
      ? input.content
      : nonEmpty(payloadContent)
        ? payloadContent
        : target.sampleQuotes && target.sampleQuotes.length > 0
          ? target.sampleQuotes.join("\n\n")
          : undefined;
    const domainTags =
      input.domainTags && input.domainTags.length > 0
        ? input.domainTags
        : payloadDomainTags && payloadDomainTags.length > 0
          ? payloadDomainTags
          : ["conversation"];
    const kind = input.kind ?? payload?.kind ?? "fact";
    if (!title || !content || domainTags.length === 0) {
      throw validationError(
        `accept requires title/content/domainTags (neither provided nor available in proposal.payload for entityId=${entityId})`,
      );
    }

    const createInput: EngramCreateInput = {
      title,
      content,
      kind,
      domainTags,
      // 2026-07 修复:external-markdown 的 payload.createdBy 是外部文档原作者
      // (从 frontmatter 解析,事实信息),保留;conversation/auto-memory 的
      // payload.createdBy 是 LLM/host 自填(常误填 host 标识如 "claude-code"),
      // 忽略,走 input.createdBy(工具层传的 ctx.defaultCreatedBy,即 host git author)。
      // 2026-08 加固:即便 external-markdown,payload.createdBy 若是机器标签
      // (proposal-engine/claude-code/rem-*-accept/skill-*/unknown 等,源自旧版
      // 硬编码或 host 误填)也必须排除——否则机器标签污染作者字段并自我传播。
      createdBy:
        target.source === "external-markdown" &&
        payload?.createdBy &&
        !isMachineAuthorLabel(payload.createdBy)
          ? payload.createdBy
          : (input.createdBy ?? this.resolveCreatedByOrDefault()),
      ...(payload?.summary !== undefined ? { summary: payload.summary } : {}),
      ...(payload?.contextTags !== undefined
        ? { contextTags: payload.contextTags }
        : {}),
      ...(payload?.sourceType !== undefined
        ? { sourceType: payload.sourceType }
        : {}),
      ...(payload?.importance !== undefined
        ? { importance: payload.importance }
        : {}),
      // visibility 优先级:caller input > proposal.payload > undefined(走 createEngram 默认 public)
      ...(input.visibility !== undefined
        ? { visibility: input.visibility }
        : payload?.visibility !== undefined
          ? { visibility: payload.visibility }
          : {}),
      ...(payload?.encodingContext !== undefined
        ? { encodingContext: payload.encodingContext }
        : {}),
    };

    // path conflict 兜底:auto-memory / external-markdown 来源的 proposal
    // 经常指向「在 dataRoot 已有 .md 但未在 engram-index.json」的 orphan 文件
    // (watcher 扫描发现 .md → 提案;用户 accept 时 deriveDefaultPath 算出
    // 与现有 .md 相同的路径 → createEngram 抛 "Engram already exists at <path>")。
    // 旧实现整个 accept 失败,proposal 状态不变,batch accept 30 个只有 N 个
    // path-new 的成功 → totalEngrams 增量远小于 30(2026-07 实测:30 accept
    // 仅 6 增量,24 个 path conflict 全 400)。
    //
    // 修复:捕获 conflict,把现有 .md 文件 adopt 进 index + SQLite,
    // 标记 proposal accepted,返回 engram.id —— 让 orphan 也计入 totalEngrams。
    let engram: { id: string };
    if (target.source === "external-markdown" && payload?.sourcePath) {
      // external-markdown：原地纳管源文件（裸 md 原地提升 / 合法 engram orphan adopt），
      // 用 payload.sourcePath 作目标路径，不在 imported/ 下新建副本。
      // 详见 EngramRepository.adoptOrPromoteEngramAt。
      // 源文件不存在（虚拟 proposal / 已被外部删除）→ undefined，退化默认路径创建。
      const adopted = this.repository.adoptOrPromoteEngramAt(
        payload.sourcePath,
        createInput,
      );
      engram = adopted ?? this.createEngramWithConflictFallback(createInput);
    } else {
      engram = this.createEngramWithConflictFallback(createInput);
    }

    const updated: Proposal = {
      ...target,
      status: "accepted",
      acceptedEngramId: engram.id,
    };
    this.writeProposals(
      proposals.map((p) => (p.entityId === entityId ? updated : p)),
    );

    // 移除对应的 cluster(已转化);auto-memory proposal 无对应 cluster,filter 是 noop
    this.writeClusters(this.readClusters().filter((c) => c.id !== entityId));

    this.appendAcceptAudit({
      entityId,
      engramId: engram.id,
      via: input.via,
      metadata: {
        occurrences: target.occurrences,
        appliedAction: "create",
        ...(target.source ? { source: target.source } : {}),
        ...(target.slug ? { slug: target.slug } : {}),
      },
    });

    // Task 3.4 Phase B:proposal accepted → 新 engram 已创建,触发 prompt-signals rebuild
    safeEmit({
      type: "proposal_accepted",
      engramId: engram.id,
      at: new Date().toISOString(),
    });

    return engram.id;
  }

  /** 按 (from, to, oldKind?) 在 repository 里定位 synapseId(rem-synapse delete/retype 用)。 */
  private resolveSynapseId(
    from: string,
    to: string,
    oldKind?: string,
  ): string | undefined {
    const { outgoing, incoming } = this.repository.readSynapses(from);
    const all = [...outgoing, ...incoming];
    const match = all.find(
      (s) =>
        s.from === from &&
        s.to === to &&
        (oldKind === undefined || s.kind === oldKind),
    );
    return match?.id;
  }

  /**
   * 把 Claude Code auto-memory 文件作为 pending proposal 写入仓库
   *
   * 与 `observe()`(对话流聚类)不同的地方:
   *   - 不走 embedder/cluster/necessity-evaluator 路径
   *   - 文件本身已是完整内容,直接作为 payload 携带
   *   - entityId 用 `am:<slug>` 命名空间,永不与对话聚类的 `c<dim>-<hash>` 冲突
   *
   * 幂等行为:
   *   - 已 accepted → 跳过(避免重开已审批项;源文件变化不影响已落库的 engram)
   *   - 已 pending 且 payload fingerprint 相同 → 跳过(no-change)
   *   - 已 pending 且 payload 变化 → upsert(payload + lastSeenAt 更新)
   *   - 不存在 → 创建 pending proposal
   *
   * @returns 写入动作(用于上层日志统计)
   */
  proposeAutoMemory(input: {
    readonly slug: string;
    readonly title: string;
    readonly content: string;
    readonly summary?: string;
    readonly domainTags: readonly string[];
    readonly contextTags?: readonly string[];
    readonly kind: EngramCreateInput["kind"];
    readonly createdBy?: string;
    readonly sourceType?: EngramCreateInput["sourceType"];
    readonly importance?: number;
    readonly visibility?: EngramCreateInput["visibility"];
    readonly encodingContext?: string;
    readonly at?: string;
  }): "proposed" | "updated" | "no-change" {
    // AI-6 中文 artifact 后处理:LLM 生成 / Claude Code auto-memory 写入的 title/content
    // 常含 tokenizer artifact(如"清 cache 时必须先 备份"),落盘前规范化。
    // 不可变输入 → normalizeProposalFields 返回新对象,不影响调用方。
    const normalized = normalizeProposalFields(input);
    const entityId = autoMemoryEntityId(input.slug);
    const now = input.at ?? new Date().toISOString();

    const payload: ProposalPayload = {
      title: normalized.title,
      content: normalized.content,
      ...(normalized.summary !== undefined
        ? { summary: normalized.summary }
        : {}),
      domainTags: normalized.domainTags,
      ...(normalized.contextTags !== undefined
        ? { contextTags: normalized.contextTags }
        : {}),
      kind: normalized.kind,
      ...(normalized.createdBy !== undefined
        ? { createdBy: normalized.createdBy }
        : {}),
      ...(normalized.sourceType !== undefined
        ? { sourceType: normalized.sourceType }
        : {}),
      ...(normalized.importance !== undefined
        ? { importance: normalized.importance }
        : {}),
      ...(normalized.visibility !== undefined
        ? { visibility: normalized.visibility }
        : {}),
      ...(normalized.encodingContext !== undefined
        ? { encodingContext: normalized.encodingContext }
        : {}),
    };

    const proposals = this.readProposals();
    const existing = proposals.find((p) => p.entityId === entityId);

    if (existing?.status === "accepted") {
      return "no-change";
    }

    if (existing?.status === "dismissed") {
      // 永久驳回(或仍在 dismissDays 冷却期):源文件即使变化也不再重开
      return "no-change";
    }

    // tombstone 检查:用户曾 dismiss 且 proposals.jsonl 中该行已被 purge 清掉。
    // 此时 existing=undefined,但 tombstone 仍记录「曾被驳回」 → 不复活。
    if (this.isTombstoned(entityId)) {
      return "no-change";
    }

    if (
      existing &&
      existing.payload &&
      payloadEqual(existing.payload, payload)
    ) {
      // payload 未变化 —— 不动 proposal,只刷新 lastSeenAt 也无意义(无样本聚合)
      return "no-change";
    }

    if (existing) {
      // pending 状态且 payload 变化 → upsert
      const next: Proposal = {
        ...existing,
        sampleQuotes: [],
        centroidExcerpt: contentExcerpt(normalized.content),
        lastSeenAt: now,
        status: "pending",
        dismissedUntil: undefined,
        dismissReason: undefined,
        payload,
      };
      this.writeProposals(
        proposals.map((p) => (p.entityId === entityId ? next : p)),
      );
      return "updated";
    }

    // 新建
    const proposal: Proposal = {
      entityId,
      occurrences: 1,
      sampleQuotes: [],
      centroidExcerpt: contentExcerpt(normalized.content),
      firstSeenAt: now,
      lastSeenAt: now,
      createdAt: now,
      status: "pending",
      source: "auto-memory",
      slug: input.slug,
      payload,
    };
    this.writeProposals([...proposals, proposal]);
    this.auditLog.append({
      actor: "system",
      action: "propose",
      metadata: { entityId, source: "auto-memory", slug: input.slug },
    });
    return "proposed";
  }

  /**
   * 外部 .md 检测入口:由 EngramRepository.scanForExternalMarkdown 通过
   * host 适配层的钩子调用,把 dataRoot 下未追踪的 .md 转成待审批 proposal。
   *
   * 与 `proposeAutoMemory` 的差异:
   *   - entityId 用 `ext:<relpath-hash>` 命名空间,与 am: / 对话聚类永不冲突
   *   - 必须携带 sourcePath(accept 时用它定位原始 .md 做移动/重命名)
   *   - 来源标识为 `external-markdown`(用于 viewer / audit 区分)
   *
   * 信任语义(关键):
   *   - auto-memory:Claude Code 写的 .claude/projects/.../memory/ 文件,
   *     半信任(已是 Claude 的输出),accept 时复制内容到 dataRoot
   *   - external-markdown:用户拷贝/IDE 写入/rsync 等无明确来源的 .md,
   *     **不信任**,accept 时由 host 决定如何处理(典型:移动到 canonical 路径)
   *
   * 幂等行为(与 proposeAutoMemory 一致):
   *   - 已 accepted → 跳过(避免重开已审批项)
   *   - 已 pending 且 payload fingerprint 相同 → 跳过(no-change)
   *   - 已 pending 且 payload 变化 → upsert
   *   - 已 dismissed → 跳过(永久驳回)
   *   - 不存在 → 创建 pending proposal
   *
   * @returns 写入动作(用于上层日志统计)
   */
  proposeExternalMarkdown(input: {
    readonly sourcePath: string;
    readonly title: string;
    readonly content: string;
    readonly summary?: string;
    readonly domainTags: readonly string[];
    readonly contextTags?: readonly string[];
    readonly kind: EngramCreateInput["kind"];
    readonly createdBy?: string;
    readonly sourceType?: EngramCreateInput["sourceType"];
    readonly importance?: number;
    readonly visibility?: EngramCreateInput["visibility"];
    readonly encodingContext?: string;
    readonly at?: string;
  }): "proposed" | "updated" | "no-change" {
    // AI-6 中文 artifact 后处理(同 proposeAutoMemory)
    const normalized = normalizeProposalFields(input);
    const entityId = externalMarkdownEntityId(input.sourcePath);
    const now = input.at ?? new Date().toISOString();

    const payload: ProposalPayload = {
      title: normalized.title,
      content: normalized.content,
      ...(normalized.summary !== undefined
        ? { summary: normalized.summary }
        : {}),
      domainTags: normalized.domainTags,
      ...(normalized.contextTags !== undefined
        ? { contextTags: normalized.contextTags }
        : {}),
      kind: normalized.kind,
      ...(normalized.createdBy !== undefined
        ? { createdBy: normalized.createdBy }
        : {}),
      ...(normalized.sourceType !== undefined
        ? { sourceType: normalized.sourceType }
        : {}),
      ...(normalized.importance !== undefined
        ? { importance: normalized.importance }
        : {}),
      ...(normalized.visibility !== undefined
        ? { visibility: normalized.visibility }
        : {}),
      ...(normalized.encodingContext !== undefined
        ? { encodingContext: normalized.encodingContext }
        : {}),
      sourcePath: input.sourcePath,
    };

    // 记录源文件 mtime,供 refreshStaleFileProposals 判断文件是否被外部编辑过。
    // 生成时即写入,避免首次 listPending 误判 stale 而用规则版覆盖 LLM 初始提取结果。
    let sourceMtimeMs: number | undefined;
    try {
      sourceMtimeMs = statSync(join(this.dataRoot, input.sourcePath)).mtimeMs;
    } catch {
      sourceMtimeMs = undefined;
    }

    const proposals = this.readProposals();
    const existing = proposals.find((p) => p.entityId === entityId);

    if (existing?.status === "accepted") {
      return "no-change";
    }

    if (existing?.status === "dismissed") {
      // 永久驳回(或仍在 dismissDays 冷却期):源文件即使变化也不再重开
      return "no-change";
    }

    // tombstone 检查(同 proposeAutoMemory,fixes purge-dismissed 后 external-markdown 复活)
    if (this.isTombstoned(entityId)) {
      return "no-change";
    }

    if (
      existing &&
      existing.payload &&
      payloadEqual(existing.payload, payload)
    ) {
      return "no-change";
    }

    if (existing) {
      const next: Proposal = {
        ...existing,
        sampleQuotes: [],
        centroidExcerpt: contentExcerpt(normalized.content),
        lastSeenAt: now,
        status: "pending",
        dismissedUntil: undefined,
        dismissReason: undefined,
        payload,
        ...(sourceMtimeMs !== undefined ? { sourceMtimeMs } : {}),
      };
      this.writeProposals(
        proposals.map((p) => (p.entityId === entityId ? next : p)),
      );
      return "updated";
    }

    const proposal: Proposal = {
      entityId,
      occurrences: 1,
      sampleQuotes: [],
      centroidExcerpt: contentExcerpt(normalized.content),
      firstSeenAt: now,
      lastSeenAt: now,
      createdAt: now,
      status: "pending",
      source: "external-markdown",
      sourcePath: input.sourcePath,
      payload,
      ...(sourceMtimeMs !== undefined ? { sourceMtimeMs } : {}),
    };
    this.writeProposals([...proposals, proposal]);
    this.auditLog.append({
      actor: "system",
      action: "propose",
      metadata: {
        entityId,
        source: "external-markdown",
        sourcePath: input.sourcePath,
      },
    });
    return "proposed";
  }

  /**
   * 把"watcher 发现的外部 .md"转成 proposeExternalMarkdown 调用的工厂。
   *
   * 供 host 适配层(claude-code-mcp / openclaw-plugin)使用,确保两宿主用
   * 同一份字段映射逻辑(避免漂移)。
   *
   * 行为:
   *   - parsed 非 null + frontmatter 含 title + kind → 直接走原逻辑(从 frontmatter 提取)
   *   - parsed 为 null(裸 .md,无 frontmatter)→ 异步提取:
   *     - llmClient 提供 → LLM 智能提取 title/kind/domainTags/summary
   *     - llmClient 未提供 或 LLM 失败 → 规则版降级(H1/文件名 → title, kind=observation, tags=["imported"])
   *   - frontmatter 缺 title 或 kind → 同样走异步提取(等同裸 .md)
   *   - domainTags 缺失 → 默认 `["imported"]`,accept 时用户可调整
   *   - createdBy 缺失 → 不传(由 engram_create 走 defaultCreatedBy 兜底)
   *
   * 异步处理:hook 同步签名,内部 fire-and-forget 异步任务,不阻塞 watcher 的
   * 2s debounce。LLM 失败 / 超时 / JSON 解析错都降级到规则版,保证"用户友好"——
   * 即使 LLM 不可用,裸 .md 仍能进入 proposal 流程。
   *
   * @param options.llmClient 可选,LLM 提取器;未提供时直接走规则版
   * @param options.onLlmError 可选,LLM 失败回调(诊断用,默认 no-op)
   *
   * @returns 符合 EngramRepository.setExternalMarkdownHook 签名的回调
   */
  createExternalMarkdownHook(options?: {
    readonly llmClient?: LlmClient;
    readonly onLlmError?: (err: unknown, sourcePath: string) => void;
  }): (params: {
    readonly absPath: string;
    readonly relPath: string;
    readonly raw: string;
    readonly parsed: {
      readonly frontmatter: { readonly [key: string]: unknown };
    } | null;
  }) => void {
    return (params) => {
      const { parsed, relPath, raw } = params;

      // 空文件拦截:IDE 新建文件瞬间文件常为空,此时提案只会得到 content=""
      // 的无价值候选(用户实测均 dismiss)。跳过首次提案,等文件有实质内容后
      // watcher 再次触发才生成。仅作用于"首次生成";已 pending 提案的内容
      // 刷新走 proposeExternalMarkdown 的 existing(upsert)分支,不受此拦截影响。
      // 空文件拦截:IDE 新建文件瞬间文件常为空,此时提案只会得到 content=""
      // 的无价值候选(用户实测均 dismiss)。跳过首次提案,等文件有实质内容后
      // watcher 再次触发才生成。仅作用于"首次生成";已 pending 提案的内容
      // 刷新走 proposeExternalMarkdown 的 existing(upsert)分支,不受此拦截影响。
      //
      // 2026-08-16 停写 audit:曾按 (relPath) 内存 Set 去重写 noise_filtered,
      // 但多宿主实例 / 进程重启即失效 —— 真实库一个 IDE 空文件
      // (「未命名.md」)被持续扫描重写,7 天 46 万条、占 audit.jsonl 的
      // 99.9%(106MB),轮转 50MB 上限形同虚设。「空文件不进提案」是显然
      // 正确的行为,无诊断价值,不值得为它持久化去重状态 —— 直接静默。
      if (raw.trim().length === 0) {
        return;
      }

      // 路径 1:合法 engram(有 frontmatter 且含 title + kind)→ 现有同步逻辑
      if (parsed) {
        const fm = parsed.frontmatter as {
          title?: unknown;
          kind?: unknown;
          domainTags?: unknown;
          summary?: unknown;
          createdBy?: unknown;
          sourceType?: unknown;
          importance?: unknown;
          visibility?: unknown;
          encodingContext?: unknown;
          contextTags?: unknown;
          content?: unknown;
        };
        if (typeof fm.title === "string" && typeof fm.kind === "string") {
          const content = typeof fm.content === "string" ? fm.content : raw;
          this.proposeExternalMarkdown({
            sourcePath: relPath,
            title: fm.title,
            content,
            ...(typeof fm.summary === "string" ? { summary: fm.summary } : {}),
            domainTags:
              Array.isArray(fm.domainTags) &&
              fm.domainTags.every((t) => typeof t === "string")
                ? (fm.domainTags as readonly string[])
                : ["imported"],
            ...(typeof fm.createdBy === "string"
              ? { createdBy: fm.createdBy }
              : {}),
            ...(typeof fm.sourceType === "string"
              ? { sourceType: fm.sourceType as never }
              : {}),
            ...(typeof fm.importance === "number"
              ? { importance: fm.importance }
              : {}),
            ...(typeof fm.visibility === "string"
              ? { visibility: fm.visibility as never }
              : {}),
            ...(typeof fm.encodingContext === "string"
              ? { encodingContext: fm.encodingContext }
              : {}),
            ...(Array.isArray(fm.contextTags) &&
            fm.contextTags.every((t) => typeof t === "string")
              ? { contextTags: fm.contextTags as readonly string[] }
              : {}),
            kind: fm.kind as EngramCreateInput["kind"],
          });
          return;
        }
        // frontmatter 缺关键字段 → fall through 到裸 .md 路径
      }

      // 路径 2:裸 .md(无 frontmatter 或 frontmatter 不完整)→ fire-and-forget 异步提取
      // 不阻塞 watcher 同步签名;LLM 失败自动降级到规则版
      this.proposeBareMarkdownAsync(relPath, raw, options?.llmClient).catch(
        (err) => {
          options?.onLlmError?.(err, relPath);
        },
      );
    };
  }

  /**
   * 把 watcher 检测到的 skill 目录转成 pending 提案（source="skill"）。
   * 幂等：印迹已注册（skillRepository.exists）→ no-change（顺带自愈存量
   * pending 复活行为 accepted）；同 entityId 的 accepted/dismissed/tombstone
   * → no-change；pending 且 payload 变 → updated；无 existing → proposed。
   */
  proposeSkill(input: {
    readonly sourcePath: string;
    readonly skillId: string;
    readonly initiationSet: string;
    readonly createdBy?: string;
    readonly visibility?: EngramVisibility;
    readonly at?: string;
    readonly allowedTools?: readonly string[];
    readonly license?: string;
    readonly skillVersion?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly compatibility?: string;
  }): "proposed" | "updated" | "no-change" {
    const entityId = skillEntityId(input.sourcePath);
    const now = input.at ?? new Date().toISOString();
    const payload: ProposalPayload = {
      title: input.skillId, // skill 提案的展示标题用 skillId
      content: input.initiationSet, // centroidExcerpt 用 initiationSet 预览
      kind: "procedure", // skill 是程序性记忆
      domainTags: ["skill"],
      ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {}),
      ...(input.visibility !== undefined
        ? { visibility: input.visibility }
        : {}),
      sourcePath: input.sourcePath,
      skillId: input.skillId,
      skillSourcePath: input.sourcePath,
      initiationSet: input.initiationSet,
      ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
      ...(input.license ? { license: input.license } : {}),
      ...(input.skillVersion ? { skillVersion: input.skillVersion } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(input.compatibility ? { compatibility: input.compatibility } : {}),
    };

    // —— 以下完全参照 proposeExternalMarkdown 的幂等分支 ——
    const proposals = this.readProposals();
    const existing = proposals.find((p) => p.entityId === entityId);

    // —— 印迹级幂等(2026-08-16 修复 purge-复活 bug) ——
    // skillId 已注册(skill-imprints/ 有印迹)说明「是否纳入记忆库」这个提案问题
    // 已有答案 —— 比同 entityId proposal 行存在性更强的幂等键。此前只查后者:
    // purgeAccepted 物理删除 accepted 行且不留 tombstone,watcher 重扫 `.claude/skills/`
    // 时 9 个已注册技能被当新发现重新提议。印迹存在时:
    //   - 无 proposal 行 → 不新建(直接 no-change)
    //   - 存量 pending 复活行 → 自愈对齐为 accepted(acceptedEngramId=现有 skillId),
    //     免去用户逐条清理;自愈写盘留 audit 痕迹
    //   - accepted/dismissed 行 → 维持原分支语义(下方)
    // 未注入 skillRepository 的宿主降级为旧行为(仅查 proposal 行)。
    // skill_delete 删掉印迹后同 sourcePath 重扫会重新提议 —— 合理复活。
    if (this.skillRepository?.exists(input.skillId)) {
      if (existing?.status === "pending") {
        this.writeProposals(
          proposals.map((p) =>
            p.entityId === entityId
              ? {
                  ...p,
                  status: "accepted" as const,
                  acceptedEngramId: input.skillId,
                }
              : p,
          ),
        );
        this.auditLog.append({
          actor: "system",
          action: "propose",
          metadata: {
            entityId,
            source: "skill",
            sourcePath: input.sourcePath,
            skillId: input.skillId,
            selfHealed: "imprint-exists",
          },
        });
      }
      return "no-change";
    }

    if (existing?.status === "accepted") {
      return "no-change";
    }

    if (existing?.status === "dismissed") {
      // 永久驳回(或仍在 dismissDays 冷却期):源文件即使变化也不再重开
      return "no-change";
    }

    // tombstone 检查(同 proposeExternalMarkdown)
    if (this.isTombstoned(entityId)) {
      return "no-change";
    }

    if (
      existing &&
      existing.payload &&
      payloadEqual(existing.payload, payload)
    ) {
      return "no-change";
    }

    if (existing) {
      const next: Proposal = {
        ...existing,
        sampleQuotes: [],
        centroidExcerpt: input.initiationSet,
        lastSeenAt: now,
        status: "pending",
        dismissedUntil: undefined,
        dismissReason: undefined,
        payload,
      };
      this.writeProposals(
        proposals.map((p) => (p.entityId === entityId ? next : p)),
      );
      return "updated";
    }

    const proposal: Proposal = {
      entityId,
      occurrences: 1,
      sampleQuotes: [],
      centroidExcerpt: input.initiationSet,
      firstSeenAt: now,
      lastSeenAt: now,
      createdAt: now,
      status: "pending",
      source: "skill",
      sourcePath: input.sourcePath,
      payload,
    };
    this.writeProposals([...proposals, proposal]);
    this.auditLog.append({
      actor: "system",
      action: "propose",
      metadata: {
        entityId,
        source: "skill",
        sourcePath: input.sourcePath,
        skillId: input.skillId,
      },
    });
    return "proposed";
  }

  /**
   * 创建 skill 检测钩子（符合 EngramRepository.setSkillHook 签名）。
   * hook 收到 {absPath, relPath, raw} → parseSkillMd → inferSkillFields → proposeSkill。
   *
   * 两 tier 模式（S2.x）：
   *   1. 有 llmClient → LLM 推断 initiationSet（精准）
   *   2. llmClient 未提供 或 LLM 抛错 → 规则版（description → initiationSet）
   */
  createSkillHook(options?: {
    readonly llmClient?: LlmClient;
    readonly onLlmError?: (err: unknown, sourcePath: string) => void;
  }): (params: {
    readonly absPath: string;
    readonly relPath: string;
    readonly raw: string;
  }) => void {
    return (params) => {
      const { raw, relPath } = params;
      const parsed = parseSkillMd(raw, relPath);
      if (!parsed) {
        this.auditLog.append({
          actor: "system",
          action: "noise_filtered",
          metadata: {
            entityId: skillEntityId(relPath),
            source: "skill",
            sourcePath: relPath,
            reason: "not-a-skill-md",
          },
        });
        return;
      }

      // 路径 1:有 LLM → 异步推断（fire-and-forget，不阻塞 watcher）
      if (options?.llmClient) {
        inferSkillFieldsWithLlm(parsed, options.llmClient)
          .then((fields) => {
            this.proposeSkill({
              sourcePath: relPath,
              skillId: parsed.skillId,
              initiationSet: fields.initiationSet,
              allowedTools: parsed.allowedTools,
              license: parsed.license,
              skillVersion: parsed.skillVersion,
              metadata: parsed.metadata,
              compatibility: parsed.compatibility,
            });
          })
          .catch((err) => {
            // LLM 失败 → 降级到规则版（保证用户能拿到 proposal）
            const fallbackFields = inferSkillFields(parsed);
            this.proposeSkill({
              sourcePath: relPath,
              skillId: parsed.skillId,
              initiationSet: fallbackFields.initiationSet,
              allowedTools: parsed.allowedTools,
              license: parsed.license,
              skillVersion: parsed.skillVersion,
              metadata: parsed.metadata,
              compatibility: parsed.compatibility,
            });
            options.onLlmError?.(err, relPath);
          });
        return;
      }

      // 路径 2:未配置 LLM → 直接规则版
      const fields = inferSkillFields(parsed);
      this.proposeSkill({
        sourcePath: relPath,
        skillId: parsed.skillId,
        initiationSet: fields.initiationSet,
        allowedTools: parsed.allowedTools,
        license: parsed.license,
        skillVersion: parsed.skillVersion,
        metadata: parsed.metadata,
        compatibility: parsed.compatibility,
      });
    };
  }

  /**
   * 异步处理裸 .md:LLM 提取 → proposeExternalMarkdown
   *
   * 降级链:
   *   1. llmClient 提供 → LLM 提取 title/kind/domainTags/summary(精准)
   *   2. llmClient 未提供 或 LLM 抛错 → 规则版(H1/文件名 → title, kind=observation, tags=["imported"])
   *
   * 无论哪条路径都调用 proposeExternalMarkdown,让裸 .md 进入 proposal 审批流程。
   * 幂等性由 proposeExternalMarkdown 自身负责(同 entityId 的 pending/accepted/dismissed 都 no-change)。
   */
  private async proposeBareMarkdownAsync(
    sourcePath: string,
    raw: string,
    llmClient?: LlmClient,
  ): Promise<void> {
    let fields;
    if (llmClient) {
      try {
        fields = await extractEngramFieldsWithLlm(
          raw,
          llmClient,
          basename(sourcePath, ".md"),
        );
      } catch {
        // LLM 失败 → 降级到规则版(不抛错,保证用户能拿到 proposal)
        fields = extractBareMarkdownDefaults(sourcePath, raw);
      }
    } else {
      // 未配置 LLM → 直接规则版
      fields = extractBareMarkdownDefaults(sourcePath, raw);
    }

    this.proposeExternalMarkdown({
      sourcePath,
      title: fields.title,
      content: fields.content,
      kind: fields.kind,
      domainTags: fields.domainTags,
      ...(fields.summary !== undefined ? { summary: fields.summary } : {}),
    });
  }

  /**
   * 拒绝提案
   *
   * 默认**永久驳回**(dismissedUntil = undefined),不再自动重新浮出。
   * 若调用方显式传 dismissDays > 0,则 N 天后该 proposal 可被 proposeAutoMemory/
   * proposeExternalMarkdown/observe 流程重新激活(向后兼容旧行为)。
   *
   * @param entityId 簇 id
   * @param reason 拒绝原因(可选,便于元学习)
   * @param dismissDays N 天后可重新激活;0 / undefined = 永久
   */
  dismiss(entityId: string, reason?: string, dismissDays?: number): void {
    const proposals = this.readProposals();
    const target = proposals.find((p) => p.entityId === entityId);
    if (!target) {
      throw notFoundError("Proposal", entityId);
    }

    // 永久为默认,符合工具契约「默认永久驳回」与 @param 注释(0 / undefined = 永久)。
    // 不再读 config.defaultDismissDays —— 它会让 undefined 误落为 N 天、过期后复活,违反契约
    // (2026-07 修复)。caller 想限时驳回可显式传 dismissDays>0。config.defaultDismissDays 字段保留但废弃。
    const days = dismissDays ?? 0;
    const dismissedUntil =
      days > 0
        ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
        : undefined;

    const updated: Proposal = {
      ...target,
      status: "dismissed",
      dismissReason: reason,
      dismissedUntil,
    };
    this.writeProposals(
      proposals.map((p) => (p.entityId === entityId ? updated : p)),
    );

    // tombstone:即使之后用户点「清空已驳回」purge 掉 proposals.jsonl 中这行,
    // proposeAutoMemory / proposeExternalMarkdown / maybePromoteToProposal 仍能
    // 通过 tombstone 知道该 entityId 曾被 dismiss,不会因 source 文件仍存在就
    // 重新创建 pending proposal(fixes 2026-07 dismiss-复活 bug)。
    // dismissedUntil: null = 永久屏蔽;ISO string = 屏蔽到该时刻(过期失效)。
    this.appendTombstone(entityId, dismissedUntil, target);

    this.auditLog.append({
      actor: "user",
      action: "dismiss",
      metadata: { entityId, reason, dismissedUntil },
    });

    // Task 3.4 Phase B:proposal dismissed → pendingCount 变化,触发 prompt-signals rebuild
    safeEmit({
      type: "proposal_dismissed",
      at: new Date().toISOString(),
    });
  }

  /**
   * 撤销驳回(viewer「5 秒撤销」toast):dismissed → pending,清除 dismissedUntil。
   *
   * 使用场景:批量驳回后 5 秒内反悔。tombstone 不删除 —— 它只影响
   * 「purge 后从 source 文件重建 proposal」路径,与本方法(status 翻转)正交;
   * 5 秒窗口内撤销,提案直接回到待审列表。
   *
   * @returns true 若找到并还原了 dismissed 提案;false(不存在 / 非 dismissed)
   */
  reactivate(entityId: string): boolean {
    const proposals = this.readProposals();
    const target = proposals.find((p) => p.entityId === entityId);
    if (!target || target.status !== "dismissed") return false;
    this.writeProposals(
      proposals.map((p) =>
        p.entityId === entityId
          ? ({ ...p, status: "pending", dismissedUntil: undefined } as Proposal)
          : p,
      ),
    );
    this.auditLog.append({
      actor: "user",
      action: "update",
      metadata: { entityId, proposalReactivated: true },
    });
    return true;
  }

  /**
   * 批量 accept(AI-8):按 source 过滤,自动 accept 所有匹配的 pending proposal。
   *
   * 设计约束:
   *   - 仅支持 source='auto-memory' / 'external-markdown'(这些 proposal 自带 payload,
   *     无需 LLM 填表)。conversation 来源必须显式 title/content,不支持 batch accept
   *     —— 防止批量创建无 title 的垃圾 engram。
   *   - 单个 accept 失败不阻塞 batch,记录到 failures 让 LLM 决定后续动作。
   *   - limit 截断后剩余 pending 留给下次调用(防止一次性创建海量 engram 触发 N+1)。
   *
   * @returns accept 结果 + 失败明细 + 截断数
   */
  acceptBatch(
    filter: {
      readonly source: "auto-memory" | "external-markdown" | "skill";
      readonly limit?: number;
    },
    input: {
      readonly createdBy?: string;
      readonly visibility?: EngramVisibility;
      /** 调用通道标识(mcp / viewer-batch),写入 audit metadata.via;缺省 "batch" */
      readonly via?: string;
    } = {},
  ): {
    readonly acceptedIds: readonly string[];
    readonly engramIds: readonly string[];
    readonly failures: ReadonlyArray<{
      readonly entityId: string;
      readonly reason: string;
    }>;
    readonly skipped: number;
  } {
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 500);
    const now = new Date().toISOString();

    // AI-8 N+1 修复:1次 readProposals + 1次 readClusters + 逐条 createEngram(O(1))+
    // 1次 writeProposals + 1次 writeClusters。旧实现逐条调 this.accept(),
    // 每次全量读写 proposals + clusters(各 9.4MB),500 候选预计 7-15s。
    const allProposals = this.readProposals();
    const allClusters = this.readClusters();

    // 匹配 pending + source(与 listPending 语义一致:status=pending 且 dismissedUntil 未过期)
    const matched = allProposals.filter((p) => {
      if (p.status !== "pending") return false;
      if (p.dismissedUntil && p.dismissedUntil > now) return false;
      return p.source === filter.source;
    });
    const target = matched.slice(0, limit);
    const skipped = matched.length - target.length;

    const acceptedIds: string[] = [];
    const engramIds: string[] = [];
    const failures: Array<{ entityId: string; reason: string }> = [];
    const acceptedMap = new Map<string, string>(); // entityId → engramId
    const proposalMeta = new Map<string, Proposal>(); // entityId → proposal(audit 用)

    // 逐条 createEngram(O(1) 各):payload 兜底 + createEngram + path conflict。
    // acceptBatch 的 input 只含 createdBy/visibility(无 title/content/domainTags/kind),
    // 这些必须从 proposal.payload 兜底 —— filter.source 限制为 auto-memory/external-markdown,
    // 它们的 payload 一定存在(设计约束)。
    for (const p of target) {
      try {
        // skill proposal:acceptBatch → 调 skillRepository.createSkill，不走 createEngram
        if (p.source === "skill") {
          if (!this.skillRepository) {
            failures.push({
              entityId: p.entityId,
              reason: "skillRepository not injected (S4)",
            });
            continue;
          }
          const p2 = p.payload;
          if (!p2?.skillId || !p2.skillSourcePath || !p2.initiationSet) {
            failures.push({
              entityId: p.entityId,
              reason: "skill payload missing fields",
            });
            continue;
          }
          const sk = this.skillRepository.createSkill({
            skillId: p2.skillId,
            sourcePath: p2.skillSourcePath,
            initiationSet: p2.initiationSet,
            createdBy: input.createdBy ?? "skill-batch-accept",
            ...(input.visibility !== undefined &&
            input.visibility !== "restricted"
              ? { visibility: input.visibility }
              : {}),
            ...(p2.allowedTools ? { allowedTools: p2.allowedTools } : {}),
            ...(p2.license ? { license: p2.license } : {}),
            ...(p2.skillVersion ? { skillVersion: p2.skillVersion } : {}),
            ...(p2.metadata ? { metadata: p2.metadata } : {}),
            ...(p2.compatibility ? { compatibility: p2.compatibility } : {}),
          });
          acceptedIds.push(p.entityId);
          engramIds.push(sk.skillId);
          acceptedMap.set(p.entityId, sk.skillId);
          proposalMeta.set(p.entityId, p);
          continue;
        }

        const payload = p.payload;
        const title = payload?.title;
        const content = payload?.content;
        const domainTags = payload?.domainTags;
        const kind = payload?.kind ?? "fact";
        if (!title || !content || !domainTags || domainTags.length === 0) {
          throw validationError(
            `acceptBatch requires proposal.payload with title/content/domainTags for entityId=${p.entityId} (source=${filter.source})`,
          );
        }
        const createInput: EngramCreateInput = {
          title,
          content,
          kind,
          domainTags,
          // 2026-07 修复(同 accept):external-markdown 保留 payload.createdBy
          // (外部文档原作者),auto-memory 走 input.createdBy(host git author)。
          // 2026-08 加固:机器标签(payload.createdBy 命中 isMachineAuthorLabel)同样排除。
          createdBy:
            p.source === "external-markdown" &&
            payload?.createdBy &&
            !isMachineAuthorLabel(payload.createdBy)
              ? payload.createdBy
              : (input.createdBy ?? this.resolveCreatedByOrDefault()),
          ...(payload?.summary !== undefined
            ? { summary: payload.summary }
            : {}),
          ...(payload?.contextTags !== undefined
            ? { contextTags: payload.contextTags }
            : {}),
          ...(payload?.sourceType !== undefined
            ? { sourceType: payload.sourceType }
            : {}),
          ...(payload?.importance !== undefined
            ? { importance: payload.importance }
            : {}),
          ...(input.visibility !== undefined
            ? { visibility: input.visibility }
            : payload?.visibility !== undefined
              ? { visibility: payload.visibility }
              : {}),
          ...(payload?.encodingContext !== undefined
            ? { encodingContext: payload.encodingContext }
            : {}),
        };

        let engram: { id: string };
        if (p.source === "external-markdown" && payload?.sourcePath) {
          // external-markdown：原地纳管源文件，不在 imported/ 下新建（见 adoptOrPromoteEngramAt）。
          // 源文件不存在 → undefined，退化默认路径创建（不阻塞 batch，失败进 failures）。
          const adopted = this.repository.adoptOrPromoteEngramAt(
            payload.sourcePath,
            createInput,
          );
          engram =
            adopted ?? this.createEngramWithConflictFallback(createInput);
        } else {
          engram = this.createEngramWithConflictFallback(createInput);
        }

        acceptedIds.push(p.entityId);
        engramIds.push(engram.id);
        acceptedMap.set(p.entityId, engram.id);
        proposalMeta.set(p.entityId, p);
      } catch (e) {
        failures.push({
          entityId: p.entityId,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // 批量更新 proposals + clusters(仅当至少一个成功)
    if (acceptedMap.size > 0) {
      const updatedProposals = allProposals.map((p) => {
        if (!acceptedMap.has(p.entityId)) return p;
        return {
          ...p,
          status: "accepted" as const,
          acceptedEngramId: acceptedMap.get(p.entityId),
        };
      });
      this.writeProposals(updatedProposals); // 1次写

      // 移除已转化的 cluster(conversation proposal 的 cluster id = entityId;
      // auto-memory/external-markdown proposal 无对应 cluster,filter 是 noop)
      const updatedClusters = allClusters.filter((c) => !acceptedMap.has(c.id));
      this.writeClusters(updatedClusters); // 1次写

      // audit + emit:逐条(auditLog.append 是 O(1) 追加)
      for (const [entityId, engramId] of acceptedMap) {
        const proposal = proposalMeta.get(entityId)!;
        this.appendAcceptAudit({
          entityId,
          engramId,
          via: input.via ?? "batch",
          metadata: {
            occurrences: proposal.occurrences,
            ...(proposal.source ? { source: proposal.source } : {}),
            ...(proposal.slug ? { slug: proposal.slug } : {}),
          },
        });
        safeEmit({
          type: "proposal_accepted",
          engramId,
          at: now,
        });
      }
    }

    return { acceptedIds, engramIds, failures, skipped };
  }

  /**
   * 批量 dismiss(AI-8):按 source / domainTags / createdAt 过滤,批量驳回。
   *
   * 默认永久驳回(dismissDays 缺省 / 0);显式传 dismissDays > 0 时 N 天后可重新激活。
   *
   * 设计约束:
   *   - 单次 dismiss 失败不阻塞 batch,记录到 failures。
   *   - filter.domainTags 语义:proposal.payload.domainTags 与此有交集即命中。
   *     conversation 来源无 payload,按 centroidExcerpt 派生 tags 匹配(避免误删)。
   *   - 时间窗 createdBefore / createdAfter 用 ISO8601 字符串比较(与 createdAt 同格式)。
   *
   * @returns dismiss 结果 + 失败明细 + 截断数
   */
  dismissBatch(
    filter: {
      readonly source?: ProposalSource;
      readonly domainTags?: readonly string[];
      readonly createdBefore?: string;
      readonly createdAfter?: string;
      readonly limit?: number;
    },
    reason: string,
    dismissDays?: number,
  ): {
    readonly dismissedIds: readonly string[];
    readonly failures: ReadonlyArray<{
      readonly entityId: string;
      readonly reason: string;
    }>;
    readonly skipped: number;
  } {
    const limit = Math.min(Math.max(filter.limit ?? 1000, 1), 5000);
    const now = new Date().toISOString();
    // 永久为默认,符合工具契约「默认永久驳回」与 @param 注释(0 / undefined = 永久)。
    // 不再读 config.defaultDismissDays —— 它会让 undefined 误落为 N 天、过期后复活,违反契约
    // (2026-07 修复)。caller 想限时驳回可显式传 dismissDays>0。config.defaultDismissDays 字段保留但废弃。
    const days = dismissDays ?? 0;
    const dismissedUntil =
      days > 0
        ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
        : undefined;

    // AI-8 N+1 修复:1次 readProposals + 内存批量改 status + 1次 writeProposals。
    // 旧实现逐条调 this.dismiss(),每次都 readProposals(全量)+ writeProposals(全量),
    // writeProposals 后 proposalsCache=null,导致下次 readProposals 真读文件。
    // 处理 2000 候选 = 2001 次全量读 + 2000 次全量写,几分钟级延迟 + event loop 阻塞。
    const allProposals = this.readProposals();

    // 内存中匹配 pending + filter(与 listPending 语义一致:status=pending 且 dismissedUntil 未过期)
    const matched: Proposal[] = [];
    for (const p of allProposals) {
      if (p.status !== "pending") continue;
      if (p.dismissedUntil && p.dismissedUntil > now) continue;
      const effectiveSource: ProposalSource = p.source ?? "conversation";
      if (filter.source && effectiveSource !== filter.source) continue;
      if (filter.createdBefore && p.createdAt >= filter.createdBefore) continue;
      if (filter.createdAfter && p.createdAt <= filter.createdAfter) continue;
      if (filter.domainTags && filter.domainTags.length > 0) {
        const pTags = p.payload?.domainTags ?? [];
        if (!pTags.some((t) => filter.domainTags!.includes(t))) continue;
      }
      matched.push(p);
    }
    const target = matched.slice(0, limit);
    const skipped = matched.length - target.length;

    // 内存中批量改 status
    const targetIds = new Set(target.map((p) => p.entityId));
    const dismissedIds: string[] = [];
    const updatedProposals = allProposals.map((p) => {
      if (!targetIds.has(p.entityId)) return p;
      dismissedIds.push(p.entityId);
      return {
        ...p,
        status: "dismissed" as const,
        dismissReason: reason,
        dismissedUntil,
      };
    });

    // 1次 writeProposals(全量)
    this.writeProposals(updatedProposals);

    // audit:逐条 append(appendFileSync 是 O(1) 追加,非全量读写,可接受)。
    // 保持与单条 dismiss() 的 audit shape 一致,让 engram_audit_query 能查到每个 proposal。
    for (const entityId of dismissedIds) {
      this.auditLog.append({
        actor: "user",
        action: "dismiss",
        metadata: { entityId, reason, dismissedUntil },
      });
    }

    // 1次 emit(而非 N 次 safeEmit)
    if (dismissedIds.length > 0) {
      safeEmit({
        type: "proposal_dismissed",
        at: now,
      });
    }

    // failures 恒为空:批量操作不调 createEngram,不涉及路径冲突;
    // target 来自 listPending,proposal 一定存在,不会抛 not found。
    return { dismissedIds, failures: [], skipped };
  }

  /**
   * 按 status 统计 proposal 数量(viewer UI「已采纳(N) / 已驳回(M) / ...」按钮计数用)。
   *
   * 2026-07 加:之前 viewer 按钮无数字,用户无法判断各状态规模。
   * pending 计数与 listPending() 同源(过滤 dismissedUntil 未过期)。
   */
  statusCounts(): {
    readonly pending: number;
    readonly accepted: number;
    readonly dismissed: number;
    readonly all: number;
  } {
    const all = this.readProposals();
    let pending = 0;
    let accepted = 0;
    let dismissed = 0;
    const nowIso = new Date().toISOString();
    for (const p of all) {
      if (p.status === "accepted") {
        accepted += 1;
      } else if (p.status === "dismissed") {
        dismissed += 1;
      } else if (p.status === "pending") {
        // 与 listPending 同源:dismissedUntil 未过期则不算 pending
        if (p.dismissedUntil && p.dismissedUntil > nowIso) continue;
        pending += 1;
      }
    }
    return { pending, accepted, dismissed, all: all.length };
  }

  /**
   * 物理删除所有 status=dismissed 的 proposal(用户「已驳回清空」操作)。
   *
   * 与 dismiss/dismissBatch 的差异:
   *   - dismiss 把 status 改为 dismissed(保留记录,dismissDays 后可重新激活)
   *   - purgeDismissed 永久删除行(只在用户主动清空「已驳回」时调用)
   *
   * 不删 accepted(已转 engram,删除 proposal 不影响 engram,但保留 proposal 用于审计)。
   * 不删 pending(用户应通过 dismiss 主动处理,而非 purge)。
   *
   * @returns 被删除的 entityId 列表(供 audit / UI toast 显示)
   */
  purgeDismissed(): readonly string[] {
    const all = this.readProposals();
    const dismissedIds: string[] = [];
    const remaining: Proposal[] = [];
    for (const p of all) {
      if (p.status === "dismissed") {
        dismissedIds.push(p.entityId);
      } else {
        remaining.push(p);
      }
    }
    if (dismissedIds.length === 0) return [];
    this.writeProposals(remaining);
    return dismissedIds;
  }

  /**
   * 物理删除所有 status=accepted 的 proposal(proposals.jsonl)。
   *
   * 只清空"采纳记录"——accept 时创建的 engram 不受影响(engram 在独立文件,
   * proposals.jsonl 只是提案索引)。用户场景:accepted 列表累积过多,清空记录
   * 释放空间,但已采纳的记忆保留。
   *
   * 不需 tombstone(accepted 不像 dismissed 需防 auto-memory 复活;purge 后
   * 同 entityId 重新 propose 会新建 pending,合理)。
   */
  purgeAccepted(): readonly string[] {
    const all = this.readProposals();
    const acceptedIds: string[] = [];
    const remaining: Proposal[] = [];
    for (const p of all) {
      if (p.status === "accepted") {
        acceptedIds.push(p.entityId);
      } else {
        remaining.push(p);
      }
    }
    if (acceptedIds.length === 0) return [];
    this.writeProposals(remaining);
    return acceptedIds;
  }

  /** 清理过期/已处理数据(测试用) */
  clear(): void {
    for (const f of [this.clustersFile, this.proposalsFile]) {
      if (existsSync(f)) writeFileSync(f, "", "utf8");
    }
    // 清内存 cache:writeFileSync 改 mtime 理论上让 readProposals/readClusters
    // 下次失效重载,但同毫秒写-读时 mtime 精度不足会误命中旧 cache(测试 flaky)。
    this.proposalsCache = null;
    this.clustersCache = null;
  }

  // ============================================================
  // 内部
  // ============================================================

  /**
   * 检查是否已有相关 engram;若无则创建/更新 proposal
   *
   * 流程:
   *   1. 查重:已有相似 engram → 跳过
   *   2. 已 accepted → 跳过;已 dismissed 且未过期 → 跳过
   *   3. Layer 2 必要性评估:necessity=false → 记 audit 不晋升
   *   4. necessity=true → 生成/更新 proposal(带 necessityReason)
   */
  private async maybePromoteToProposal(
    cluster: TopicCluster,
    now: string,
  ): Promise<void> {
    const centroidExcerpt = cluster.samples[cluster.samples.length - 1] ?? "";

    // 查重:简单标题/摘要子串匹配(M1 够用,M2 可升级为语义)
    if (this.hasSimilarEngram(centroidExcerpt)) {
      return; // 已有相关 engram,不生成 proposal
    }

    const proposals = this.readProposals();
    const existing = proposals.find((p) => p.entityId === cluster.id);

    if (existing && existing.status === "accepted") {
      return; // 已接受,不再更新
    }

    if (existing && existing.status === "dismissed") {
      // dismissed 但 dismissUntil 已过 → 重新激活
      if (existing.dismissedUntil && existing.dismissedUntil > now) {
        return; // 仍在 dismiss 期
      }
    }

    // tombstone 检查:dismissed 行被 purgeDismissed 清掉后,proposals.jsonl 找不到 existing,
    // 但 tombstone 仍记录「曾被 dismiss」。dismissibleUntil 未过期 → 不复活;null/永久 → 不复活。
    // 注意:若 dismissedUntil 已过期(原"暂时屏蔽 N 天"语义允许复活),isTombstoned 返回 false,放行。
    if (this.isTombstoned(cluster.id, now)) {
      return;
    }

    // Layer 2:必要性评估
    const existingTitles = this.repository.listEngrams().map((e) => e.title);
    const verdict = await this.necessityEvaluator.evaluate({
      samples: cluster.samples,
      occurrences: cluster.occurrences,
      firstSeenAt: cluster.firstSeenAt,
      lastSeenAt: cluster.lastSeenAt,
      existingTitles,
    });

    if (!verdict.necessary) {
      // 不晋升,但保留 cluster(后续新样本可能改变判断)
      this.auditLog.append({
        actor: "system",
        action: "necessity_rejected",
        metadata: {
          entityId: cluster.id,
          occurrences: cluster.occurrences,
          rule: verdict.rule,
          reason: verdict.reason,
        },
      });
      return;
    }

    const proposal: Proposal = {
      entityId: cluster.id,
      occurrences: cluster.occurrences,
      sampleQuotes: cluster.samples.slice(-this.config.maxSamples),
      centroidExcerpt,
      firstSeenAt: cluster.firstSeenAt,
      lastSeenAt: cluster.lastSeenAt,
      createdAt: existing?.createdAt ?? now,
      status: "pending",
      necessityReason: verdict.reason,
      ...(verdict.suggestedTitle
        ? { suggestedTitle: verdict.suggestedTitle }
        : {}),
    };

    const next = existing
      ? {
          ...existing,
          ...proposal,
          dismissedUntil: undefined,
          dismissReason: undefined,
        }
      : proposal;

    if (existing) {
      this.writeProposals(
        proposals.map((p) => (p.entityId === cluster.id ? next : p)),
      );
    } else {
      this.writeProposals([...proposals, next]);
      // 首次生成 proposal → audit propose
      this.auditLog.append({
        actor: "system",
        action: "propose",
        metadata: { entityId: cluster.id, occurrences: cluster.occurrences },
      });
    }
  }

  /** 查重:简单子串匹配 */
  private hasSimilarEngram(excerpt: string): boolean {
    const entries = this.repository.listEngrams();
    const normalizedExcerpt = normalize(excerpt);
    if (!normalizedExcerpt) return false;

    // 提取 excerpt 的关键词(去停用词、取前 5 个)
    const keywords = extractKeywords(normalizedExcerpt, 5);
    if (keywords.length === 0) return false;

    for (const entry of entries) {
      const title = normalize(entry.title);
      // 至少 2 个关键词命中才算匹配
      const hits = keywords.filter((k) => title.includes(k)).length;
      if (hits >= 2) return true;
    }
    return false;
  }

  private readClusters(): TopicCluster[] {
    if (!existsSync(this.clustersFile)) return [];
    let mtime: number;
    try {
      mtime = statSync(this.clustersFile).mtimeMs;
    } catch {
      return this.clustersCache?.data ?? [];
    }
    if (this.clustersCache && this.clustersCache.mtime === mtime) {
      return this.clustersCache.data;
    }
    const raw = readJsonl(this.clustersFile) as TopicCluster[];
    // 防御性 dedupe by id:历史数据可能因 clusterId 碰撞 + push 不查重
    // 出现同 id 多行(已修复,但已有污染数据需在读时清理)。同 id 取
    // occurrences 最大者(代表累积最完整),其余字段以它为准。
    if (raw.length <= 1) {
      this.clustersCache = { mtime, data: raw };
      return raw;
    }
    const byId = new Map<string, TopicCluster>();
    for (const c of raw) {
      const existing = byId.get(c.id);
      if (!existing || c.occurrences > existing.occurrences) {
        byId.set(c.id, c);
      }
    }
    const deduped = Array.from(byId.values());
    // 若发生 dedupe,立刻把干净数据写回(下次 observe 走 writeClusters 自然保持)
    if (deduped.length !== raw.length) {
      this.writeClusters(deduped);
      // writeClusters 内部已 invalidate + 重新 cache,这里直接返回 deduped
      return deduped;
    }
    this.clustersCache = { mtime, data: deduped };
    return deduped;
  }

  private writeClusters(clusters: readonly TopicCluster[]): void {
    // cap:防 topic-clusters.jsonl 无限增长。保留 occurrences 最高的 N 个
    // (重要聚类优先;低 occurrences 的旧聚类可被 proposal 重新聚类重建)。
    const MAX_CLUSTERS = 500;
    const capped =
      clusters.length > MAX_CLUSTERS
        ? [...clusters]
            .sort((a, b) => b.occurrences - a.occurrences)
            .slice(0, MAX_CLUSTERS)
        : clusters;
    writeJsonl(this.clustersFile, capped);
    // invalidate cache:writeJsonl 后下次 readClusters 会重新 statSync + parse。
    // 不在这里重建 cache —— 写后通常立即有 read,让 read 路径按需重建。
    this.clustersCache = null;
  }

  private readProposals(): Proposal[] {
    if (!existsSync(this.proposalsFile)) return [];
    let mtime: number;
    try {
      mtime = statSync(this.proposalsFile).mtimeMs;
    } catch {
      return this.proposalsCache?.data ?? [];
    }
    if (this.proposalsCache && this.proposalsCache.mtime === mtime) {
      return this.proposalsCache.data;
    }
    const data = readJsonl(this.proposalsFile) as Proposal[];
    this.proposalsCache = { mtime, data };
    return data;
  }

  private writeProposals(proposals: readonly Proposal[]): void {
    writeJsonl(this.proposalsFile, proposals);
    this.proposalsCache = null;
  }

  /**
   * 读取 dismissed-tombstones,返回 entityId → dismissedUntil 的 Map。
   *
   * - 文件不存在 / 空 → 空 Map
   * - 同 entityId 多次 dismiss → 后写覆盖前写(Map 自然语义)
   * - dismissedUntil 字段:null/缺省 = 永久屏蔽;ISO string = 屏蔽到该时刻
   *
   * mtime cache 与 readProposals 同模式:statSync 极快,只在 mtime 变化时重新解析。
   */
  private readTombstones(): Map<string, string | null> {
    if (!existsSync(this.tombstonesFile)) return new Map();
    let mtime: number;
    try {
      mtime = statSync(this.tombstonesFile).mtimeMs;
    } catch {
      return this.tombstonesCache?.data ?? new Map();
    }
    if (this.tombstonesCache && this.tombstonesCache.mtime === mtime) {
      return this.tombstonesCache.data;
    }
    const raw = readJsonl(this.tombstonesFile) as Array<{
      readonly entityId: string;
      readonly dismissedUntil?: string | null;
    }>;
    const map = new Map<string, string | null>();
    for (const r of raw) {
      if (!r?.entityId) continue;
      map.set(r.entityId, r.dismissedUntil ?? null);
    }
    this.tombstonesCache = { mtime, data: map };
    return map;
  }

  /**
   * append 一条 tombstone 记录。append-only,不查重(同 entityId 多次 dismiss 时
   * 自然累积历史;readTombstones 用 Map 取最后状态)。
   *
   * 增长控制:append 后检查 unique entityId 数,超过 TOMBSTONE_COMPACT_THRESHOLD
   * 触发 compact(dedup 同 entityId 多次写的记录,文件大小压到 unique × ~170B)。
   */
  private appendTombstone(
    entityId: string,
    dismissedUntil: string | undefined,
    target: Proposal,
  ): void {
    const dir = dirname(this.tombstonesFile);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const record: {
      readonly entityId: string;
      readonly dismissedUntil: string | null;
      readonly dismissedAt: string;
      readonly source?: string;
      readonly slug?: string;
      readonly sourcePath?: string;
    } = {
      entityId,
      dismissedUntil: dismissedUntil ?? null,
      dismissedAt: new Date().toISOString(),
      ...(target.source !== undefined ? { source: target.source } : {}),
      ...(target.slug !== undefined ? { slug: target.slug } : {}),
      ...(target.sourcePath !== undefined
        ? { sourcePath: target.sourcePath }
        : {}),
    };
    appendFileSync(this.tombstonesFile, JSON.stringify(record) + "\n", "utf8");
    // appendFileSync 后文件 mtime 必变,下次 readTombstones 会 statSync reload。
    // 这里直接 invalidate,让下次 read 走 statSync → parse。
    this.tombstonesCache = null;

    // 增长控制:unique entityId 超 threshold → compact(TTL + FIFO + dedup)
    // readTombstones 走 mtime cache(刚才 invalidate 后会重新 statSync + parse
    // 当前文件),返回的 Map.size 就是 unique entityId 数。compact 在同进程内
    // 写回后立刻 invalidate cache,跨进程下次 read 自动 reload。
    const after = this.readTombstones();
    if (after.size > TOMBSTONE_COMPACT_THRESHOLD) {
      this.compactTombstones();
    }
  }

  /**
   * 三步压缩(方案 C:TTL + FIFO + dedup)。
   *
   * 1. **TTL**:删除 dismissedUntil != null && dismissedUntil <= now(已过冷却期)。
   *    与 [isTombstoned] 语义完全等价 —— 过期的 tombstone 本来也不会屏蔽,删除零行为变化。
   * 2. **dedup**:同 entityId 保留最后一条(文件顺序,后写覆盖前写)。
   * 3. **FIFO**:若 unique 数仍 > TOMBSTONE_COMPACT_THRESHOLD,按时间降序保留最新 N 条。
   *
   * 硬上限:compact 后 unique ≤ TOMBSTONE_COMPACT_THRESHOLD × ~90B = **~90 KB**(实测)。
   * TTL 是「自然衰减」(删过期),FIFO 是「硬兜底」(砍超额) —— 大量永久 dismiss
   * 累积导致 TTL 无能为力时,FIFO 保证文件大小始终有界。
   *
   * FIFO 兜底语义:被砍掉的 entityId 下次 propose 时会复活,等价于「这个 slug 已
   * 很久没被用户驳回,允许重新进入候选池」 —— 用户偏好可能已变化,合理。
   *
   * 触发频率:每次新 entityId(使 unique > threshold)触发一次。读 raw + 写 raw,
   * 但 compact 是低频操作(日常几乎不触发),性能不敏感。
   *
   * 并发:read-all + write-all,跨进程并发存在 lost update 风险(另一进程在
   * 我们 read 后 write 前 append 了一条)。tombstone 单调 append 语义,
   * 即使丢一条,下次该 entityId 重新 dismiss 会再写 —— 不影响屏蔽正确性,
   * 只影响「最近一次 dismiss 时间戳」。
   */
  private compactTombstones(now: string = new Date().toISOString()): void {
    const raw = readJsonl(this.tombstonesFile) as Array<{
      readonly entityId: string;
      readonly dismissedUntil?: string | null;
      readonly dismissedAt?: string;
      readonly compactedAt?: string;
    }>;

    // Step 1 + 2: TTL 删过期 + dedup 保留最后(一遍扫完)
    // 文件顺序就是写入顺序,后写覆盖前写 —— Map 自然语义
    const latest = new Map<
      string,
      {
        entityId: string;
        dismissedUntil: string | null;
        timestamp: string; // dismissedAt ?? compactedAt,用于 FIFO 排序
      }
    >();
    for (const r of raw) {
      if (!r?.entityId) continue;
      const until = r.dismissedUntil ?? null;
      // Step 1: TTL —— 已过冷却期的跳过(等价于该 tombstone 失效)
      if (until !== null && until <= now) continue;
      // Step 2: dedup —— 后写覆盖前写
      latest.set(r.entityId, {
        entityId: r.entityId,
        dismissedUntil: until,
        timestamp: r.dismissedAt ?? r.compactedAt ?? now,
      });
    }

    // Step 3: FIFO —— TTL 删完后仍超阈值,按时间降序保留最新 N 条
    let entries = Array.from(latest.values());
    if (entries.length > TOMBSTONE_COMPACT_THRESHOLD) {
      entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      entries = entries.slice(0, TOMBSTONE_COMPACT_THRESHOLD);
    }

    // 写回 —— 标记 compactedAt(原始 dismissedAt 已不可考)
    const compacted: ReadonlyArray<{
      readonly entityId: string;
      readonly dismissedUntil: string | null;
      readonly compactedAt: string;
    }> = entries.map((e) => ({
      entityId: e.entityId,
      dismissedUntil: e.dismissedUntil,
      compactedAt: new Date().toISOString(),
    }));
    writeJsonl(this.tombstonesFile, compacted);
    this.tombstonesCache = null;
  }

  /**
   * 检查 entityId 是否处于 tombstone 屏蔽期。
   *
   * - 不在 tombstone → false(放行 propose)
   * - dismissedUntil=null → true(永久屏蔽)
   * - dismissedUntil > now → true(仍在 dismiss 期)
   * - dismissedUntil <= now → false(dismiss 期已过,允许复活 —— 与 maybePromoteToProposal
   *   现有「dismissedUntil 过期后允许重新 propose」语义一致)
   */
  private isTombstoned(
    entityId: string,
    now: string = new Date().toISOString(),
  ): boolean {
    const until = this.readTombstones().get(entityId);
    if (until === undefined) return false; // 不在 tombstone
    if (until === null) return true; // 永久
    return until > now;
  }
}

// ============================================================
// 纯函数(可测试)
// ============================================================

/**
 * 创建新 cluster
 */
export function newCluster(
  vector: readonly number[],
  firstSample: string,
  at: string,
): TopicCluster {
  return {
    id: clusterId(vector),
    centroid: [...vector],
    occurrences: 1,
    samples: [truncate(firstSample, 100)],
    firstSeenAt: at,
    lastSeenAt: at,
  };
}

/**
 * 把新样本加入现有 cluster,更新质心
 *
 * 质心更新公式: new = old + (sample - old) / (n+1)
 */
export function addToCluster(
  cluster: TopicCluster,
  sample: string,
  vector: readonly number[],
  at: string,
  maxSamples: number,
): TopicCluster {
  const n = cluster.occurrences + 1;
  const newCentroid = cluster.centroid.map((c, i) => {
    const v = vector[i] ?? 0;
    return c + (v - c) / n;
  });

  const samples = [...cluster.samples, truncate(sample, 100)].slice(
    -maxSamples,
  );

  return {
    ...cluster,
    centroid: newCentroid,
    occurrences: n,
    samples,
    lastSeenAt: at,
  };
}

/**
 * 找最相似的 cluster(余弦)
 *
 * 返回 null 表示无匹配(需新建)
 */
export function findBestMatch(
  vector: readonly number[],
  clusters: readonly TopicCluster[],
  threshold: number,
): { readonly cluster: TopicCluster; readonly similarity: number } | null {
  if (clusters.length === 0) return null;

  let bestCluster: TopicCluster | null = null;
  let bestSim = -1;

  for (const c of clusters) {
    const sim = cosineSimilarity(vector, c.centroid);
    if (sim > bestSim) {
      bestSim = sim;
      bestCluster = c;
    }
  }

  if (!bestCluster || bestSim < threshold) return null;
  return { cluster: bestCluster, similarity: bestSim };
}

/** 余弦相似度 */
export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  const len = Math.max(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** 从向量派生短 id(便于调试 + 唯一索引) */
export function clusterId(vector: readonly number[]): string {
  // 全向量 SHA256 → 16 字符前缀,碰撞概率 ~1/2^64
  //
  // 历史 bug:旧实现只取前 4 + 后 4 维拼 hash,而 DEFAULT_HASHER_EMBEDDER
  // 把词 hash 到 0..N 的随机维度,只要词都没命中前 4/后 4 维,id 必然
  // 碰撞成 c128-0-0-0-0-0-0-0-0(或迁移到 c256 后的同等碰撞),导致 observe
  // 走 newCluster 分支时多次创建同 id 的不同 cluster,污染 topic-clusters.jsonl。
  const serialized = vector.map((n) => n.toFixed(6)).join(",");
  const digest = createHash("sha256").update(serialized).digest("hex");
  return `c${vector.length}-${digest.slice(0, 16)}`;
}

/**
 * 默认 embedder: hash-based(无 LLM)
 *
 * 把文本拆词,每个词 hash 到某维度,符号累加。CJK 字符连续段会进一步切成
 * 字符 bigram(我们/以后/所有…)——不加这一步,中文整段会被当成一个超大 token,
 * 导致相似 Chinese 句子的余弦接近正交,proposal pipeline 在中文场景下完全失灵。
 * 准确度低但零成本,可用于 M1 验证机制。M2 由宿主替换为真实 embedding。
 */
export const DEFAULT_HASHER_EMBEDDER: Embedder = async (text) => {
  const DIM = 256;
  const vec = new Array(DIM).fill(0);
  const tokens = tokenizeForEmbedding(text);
  for (const w of tokens) {
    let hash = 0;
    for (let i = 0; i < w.length; i++) {
      hash = (hash * 31 + w.charCodeAt(i)) | 0;
    }
    const dim = Math.abs(hash) % DIM;
    const sign = hash < 0 ? -1 : 1;
    vec[dim] += sign;
  }
  // L2 归一化(便于余弦)
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
  if (norm > 0) {
    for (let i = 0; i < DIM; i++) vec[i] /= norm;
  }
  return vec;
};

/**
 * Hash-based embedder 配套的相似度阈值。
 *
 * `DEFAULT_PROPOSAL_CONFIG.similarityThreshold = 0.75` 是为真实 LLM embedding
 * 设计的;hash-based fallback 的余弦分布完全不同(同义改写最多 ~0.4,完全无关
 * 的文本 ~0.05-0.1),用 0.75 会导致 proposal pipeline 在 hash fallback 下
 * 完全无法成簇——任何话题被反复提及都不会生成 proposal。
 *
 * 0.35 是经验值:在 256 维 + CJK bigram 切分下,足以让"arrow function"
 * 这样的核心词在 4-5 次提及后成簇,又不会把"今天天气真好"和"我们去爬山"
 * 这种无关句子误聚到一起。宿主替换为真实 embedder 时应使用更高阈值(如 0.75)。
 */
export const DEFAULT_HASHER_SIMILARITY_THRESHOLD = 0.35;

// ============================================================
// 辅助
// ============================================================

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "shall",
  "of",
  "in",
  "on",
  "at",
  "to",
  "for",
  "with",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "up",
  "down",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "i",
  "me",
  "my",
  "we",
  "us",
  "our",
  "you",
  "your",
  "he",
  "him",
  "his",
  "she",
  "her",
  "it",
  "its",
  "they",
  "them",
  "their",
  "this",
  "that",
  "these",
  "those",
  "what",
  "which",
  "who",
  "whom",
  "how",
  "when",
  "why",
  "的",
  "了",
  "是",
  "在",
  "和",
  "与",
  "或",
  "但",
  "可以",
  "应该",
  "需要",
  "我",
  "你",
  "他",
  "她",
  "它",
  "我们",
  "你们",
  "他们",
  "这",
  "那",
]);

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 字符串/数组非空判断(2026-07 修复 accept 兜底用)
 *
 * `??` 只在 null/undefined 时回落,但前端可能传空字符串或空数组(语义等同"未提供"),
 * 这种情况下应当回落到 payload 兜底值。本函数把"空"统一判定为 falsy。
 */
function nonEmpty<T>(value: readonly T[] | string | null | undefined): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.length > 0;
  return value.length > 0;
}

// CJK / Hangana / Hangul 范围。用于把连续 CJK 段切成字符 bigram。
// 没有这一步,中文整段会被 normalize() 当成一个 token。
const CJK_RUN = /[㐀-鿿豈-﫿぀-ヿ가-힯]/;

/**
 * 把 normalize 后的文本切成可 hash 的 token:
 *   - 拉丁/数字词:原样返回
 *   - 连续 CJK/Hangana/Hangul 段:切成字符 bigram("我们以后" → 我们/们以/以后)
 *     · 1 字符的孤儿(罕见,通常是被空格分隔的单字)按原样发出
 *     · bigram 是 zero-cost 中文语义近似的最优切分粒度:
 *       既能抓住常用双字词(我们/以后/所有),又无需词典或分词器
 */
function tokenizeForEmbedding(text: string): string[] {
  const tokens: string[] = [];
  for (const word of normalize(text).split(/\s+/).filter(Boolean)) {
    if (CJK_RUN.test(word)) {
      if (word.length === 1) {
        tokens.push(word);
        continue;
      }
      for (let i = 0; i + 1 < word.length; i++) {
        tokens.push(word.slice(i, i + 2));
      }
    } else {
      tokens.push(word);
    }
  }
  return tokens;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

/**
 * 从 markdown 原文生成内容摘要:剥掉前导 frontmatter(`---\n…\n---`),
 * 取正文前 max 字符。用于 external-markdown / auto-memory 来源 proposal
 * 的 centroidExcerpt —— 展示文件/记忆内容片段,而非文件路径(slug/sourcePath)。
 *
 * 仅剥「文件起始」的 frontmatter;正文中的 --- 不受影响。空内容返回空串
 * (配合 createExternalMarkdownHook 的空文件拦截,正常不会命中空值)。
 */
function contentExcerpt(raw: string, max = 200): string {
  let body = raw;
  const fm = body.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (fm) body = body.slice(fm[0].length);
  body = body.trim();
  if (body.length === 0) return "";
  if (body.length > max) return `${body.slice(0, max - 1)}…`;
  return body;
}

function extractKeywords(text: string, n: number): string[] {
  return text
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w))
    .slice(0, n);
}

function readJsonl(filePath: string): readonly unknown[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((r) => r !== null);
}

function writeJsonl(filePath: string, records: readonly unknown[]): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const content =
    records.map((r) => JSON.stringify(r)).join("\n") +
    (records.length > 0 ? "\n" : "");
  writeFileSync(filePath, content, "utf8");
}

/**
 * 比较两个 ProposalPayload 是否等价(用于 proposeAutoMemory 的幂等判断)
 *
 * 逐字段比对,数值/字符串/数组/可选字段全匹配才返回 true。
 */
function payloadEqual(a: ProposalPayload, b: ProposalPayload): boolean {
  if (a.title !== b.title) return false;
  if (a.content !== b.content) return false;
  if ((a.summary ?? "") !== (b.summary ?? "")) return false;
  if (!arrayEqual(a.domainTags, b.domainTags)) return false;
  if (!arrayEqual(a.contextTags ?? [], b.contextTags ?? [])) return false;
  if (a.kind !== b.kind) return false;
  if ((a.createdBy ?? "") !== (b.createdBy ?? "")) return false;
  if ((a.sourceType ?? "") !== (b.sourceType ?? "")) return false;
  if ((a.importance ?? -1) !== (b.importance ?? -1)) return false;
  if ((a.visibility ?? "") !== (b.visibility ?? "")) return false;
  if ((a.encodingContext ?? "") !== (b.encodingContext ?? "")) return false;
  return true;
}

function arrayEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
