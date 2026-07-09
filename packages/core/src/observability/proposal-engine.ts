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
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import type { EngramRepository } from "../storage/repository.js";
import type { AuditLog } from "./audit-log.js";
import type { EngramCreateInput, EngramVisibility } from "../types/engram.js";
import { safeEmit } from "../prompt-signals/event-bus.js";
import {
  RuleBasedNecessityEvaluator,
  prefilterMessage,
  type NecessityEvaluator,
  type NecessityVerdict,
} from "./necessity-evaluator.js";
import { normalizeProposalFields } from "./chinese-post-processor.js";

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

/** Proposal 来源:对话流聚类 / Claude Code auto-memory 文件 / 外部 .md 检测 */
export type ProposalSource = "conversation" | "auto-memory" | "external-markdown";

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
  /** 预填的 engram 字段(auto-memory / external-markdown 来源专用;conversation 来源恒为 undefined) */
  readonly payload?: ProposalPayload;
}

/** auto-memory proposal 的 entityId 前缀(命名空间隔离,永不与对话聚类 `c<dim>-<hash>` 冲突) */
export const AUTO_MEMORY_PROPOSAL_PREFIX = "am:";

/** external-markdown proposal 的 entityId 前缀(命名空间隔离,永不与其他来源冲突) */
export const EXTERNAL_MARKDOWN_PROPOSAL_PREFIX = "ext:";

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
  private readonly necessityEvaluator: NecessityEvaluator;
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
    this.necessityEvaluator =
      deps.necessityEvaluator ?? new RuleBasedNecessityEvaluator();
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
  listPending(): readonly Proposal[] {
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
    return this.readProposals();
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
    },
  ): string {
    const proposals = this.readProposals();
    const target = proposals.find((p) => p.entityId === entityId);
    if (!target) {
      throw new Error(`Proposal not found: ${entityId}`);
    }

    // payload 兜底:auto-memory / external-markdown 来源的 proposal 已携带完整 engram 字段。
    // 注意:`??` 只在 null/undefined 时回落,空数组/空字符串需要显式判断(2026-07 修复):
    //   旧实现 `input.domainTags ?? payload?.domainTags` 在前端传 `domainTags: []` 时
    //   不会回落,导致 accept 抛 400。现用「非空生效,否则回落」语义覆盖所有「空」形态。
    const payload = target.payload;
    const title = nonEmpty(input.title) ? input.title : payload?.title;
    const content = nonEmpty(input.content) ? input.content : payload?.content;
    const domainTags =
      input.domainTags && input.domainTags.length > 0
        ? input.domainTags
        : payload?.domainTags;
    const kind = input.kind ?? payload?.kind ?? "fact";
    if (!title || !content || !domainTags || domainTags.length === 0) {
      throw new Error(
        `accept requires title/content/domainTags (neither provided nor available in proposal.payload for entityId=${entityId})`,
      );
    }

    const createInput: EngramCreateInput = {
      title,
      content,
      kind,
      domainTags,
      createdBy: input.createdBy ?? payload?.createdBy ?? "proposal-engine",
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
    try {
      engram = this.repository.createEngram(createInput);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const m = msg.match(/^Engram already exists at (.+)$/);
      if (!m) throw e;
      const existing = this.repository.ingestExistingEngramFile(m[1]!);
      if (!existing) throw e;
      engram = existing;
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

    this.auditLog.append({
      actor: "user",
      action: "accept",
      engramId: engram.id,
      metadata: {
        entityId,
        occurrences: target.occurrences,
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
      ...(normalized.summary !== undefined ? { summary: normalized.summary } : {}),
      domainTags: normalized.domainTags,
      ...(normalized.contextTags !== undefined
        ? { contextTags: normalized.contextTags }
        : {}),
      kind: normalized.kind,
      ...(normalized.createdBy !== undefined ? { createdBy: normalized.createdBy } : {}),
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

    if (existing && existing.payload && payloadEqual(existing.payload, payload)) {
      // payload 未变化 —— 不动 proposal,只刷新 lastSeenAt 也无意义(无样本聚合)
      return "no-change";
    }

    if (existing) {
      // pending 状态且 payload 变化 → upsert
      const next: Proposal = {
        ...existing,
        sampleQuotes: [input.slug],
        centroidExcerpt: input.slug,
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
      sampleQuotes: [input.slug],
      centroidExcerpt: input.slug,
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
      ...(normalized.summary !== undefined ? { summary: normalized.summary } : {}),
      domainTags: normalized.domainTags,
      ...(normalized.contextTags !== undefined
        ? { contextTags: normalized.contextTags }
        : {}),
      kind: normalized.kind,
      ...(normalized.createdBy !== undefined ? { createdBy: normalized.createdBy } : {}),
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

    const proposals = this.readProposals();
    const existing = proposals.find((p) => p.entityId === entityId);

    if (existing?.status === "accepted") {
      return "no-change";
    }

    if (existing?.status === "dismissed") {
      // 永久驳回(或仍在 dismissDays 冷却期):源文件即使变化也不再重开
      return "no-change";
    }

    if (existing && existing.payload && payloadEqual(existing.payload, payload)) {
      return "no-change";
    }

    if (existing) {
      const next: Proposal = {
        ...existing,
        sampleQuotes: [input.sourcePath],
        centroidExcerpt: input.sourcePath,
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
      sampleQuotes: [input.sourcePath],
      centroidExcerpt: input.sourcePath,
      firstSeenAt: now,
      lastSeenAt: now,
      createdAt: now,
      status: "pending",
      source: "external-markdown",
      sourcePath: input.sourcePath,
      payload,
    };
    this.writeProposals([...proposals, proposal]);
    this.auditLog.append({
      actor: "system",
      action: "propose",
      metadata: { entityId, source: "external-markdown", sourcePath: input.sourcePath },
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
   *   - parsed 为 null → noop(裸 .md,不进入提案流程)
   *   - frontmatter 缺 title 或 kind → noop(无法构成最小 engram)
   *   - domainTags 缺失 → 默认 `["imported"]`,accept 时用户可调整
   *   - createdBy 缺失 → 不传(由 engram_create 走 defaultCreatedBy 兜底)
   *
   * @returns 符合 EngramRepository.setExternalMarkdownHook 签名的回调
   */
  createExternalMarkdownHook(): (params: {
    readonly absPath: string;
    readonly relPath: string;
    readonly raw: string;
    readonly parsed: { readonly frontmatter: { readonly [key: string]: unknown } } | null;
  }) => void {
    return (params) => {
      const { parsed, relPath } = params;
      if (!parsed) return;
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
      if (typeof fm.title !== "string" || typeof fm.kind !== "string") return;
      const content =
        typeof fm.content === "string" ? fm.content : params.raw;
      this.proposeExternalMarkdown({
        sourcePath: relPath,
        title: fm.title,
        content,
        ...(typeof fm.summary === "string" ? { summary: fm.summary } : {}),
        domainTags:
          Array.isArray(fm.domainTags) && fm.domainTags.every((t) => typeof t === "string")
            ? (fm.domainTags as readonly string[])
            : ["imported"],
        ...(typeof fm.createdBy === "string" ? { createdBy: fm.createdBy } : {}),
        ...(typeof fm.sourceType === "string" ? { sourceType: fm.sourceType as never } : {}),
        ...(typeof fm.importance === "number" ? { importance: fm.importance } : {}),
        ...(typeof fm.visibility === "string" ? { visibility: fm.visibility as never } : {}),
        ...(typeof fm.encodingContext === "string"
          ? { encodingContext: fm.encodingContext }
          : {}),
        ...(Array.isArray(fm.contextTags) &&
        fm.contextTags.every((t) => typeof t === "string")
          ? { contextTags: fm.contextTags as readonly string[] }
          : {}),
        kind: fm.kind as EngramCreateInput["kind"],
      });
    };
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
      throw new Error(`Proposal not found: ${entityId}`);
    }

    const days = dismissDays ?? this.config.defaultDismissDays ?? 0;
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
      readonly source: "auto-memory" | "external-markdown";
      readonly limit?: number;
    },
    input: {
      readonly createdBy?: string;
      readonly visibility?: EngramVisibility;
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
    const pending = this.listPending().filter(
      (p) => p.source === filter.source,
    );
    const target = pending.slice(0, limit);
    const skipped = pending.length - target.length;

    const acceptedIds: string[] = [];
    const engramIds: string[] = [];
    const failures: Array<{ entityId: string; reason: string }> = [];

    for (const p of target) {
      try {
        const engramId = this.accept(p.entityId, {
          ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {}),
          ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        });
        acceptedIds.push(p.entityId);
        engramIds.push(engramId);
      } catch (e) {
        failures.push({
          entityId: p.entityId,
          reason: e instanceof Error ? e.message : String(e),
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
    const days = dismissDays ?? this.config.defaultDismissDays ?? 0;
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

  /** 清理过期/已处理数据(测试用) */
  clear(): void {
    for (const f of [this.clustersFile, this.proposalsFile]) {
      if (existsSync(f)) writeFileSync(f, "", "utf8");
    }
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
    writeJsonl(this.clustersFile, clusters);
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
