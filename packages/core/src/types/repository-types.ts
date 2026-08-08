/**
 * Co-Engram 仓库类型定义
 *
 * 核心概念:
 * - `StableEngramId`: ULID 形式的 engram 标识,与文件路径解耦
 * - `EngramIndex`: 派生缓存 {stableId → 文件元数据}
 * - `DoctorReport`: 自愈扫描报告
 * - `PathTreeNode`: 人类目录树
 *
 * @module @co-engram/core/types
 */

import type { EngramId } from "./engram.js";
import type { EngramKind, EngramStatus, VerificationStatus } from "./engram.js";

/**
 * Stable Engram ID(ULID,26 字符 Crockford Base32)
 *
 * 与物理路径解耦:文件移动/重命名不影响 id,所有 synapse 引用稳定。
 *
 * 仍以 string 表示以兼容旧调用者,但语义是 ULID。
 */
export type StableEngramId = EngramId & { readonly __brand?: "StableEngramId" };

/** ULID 正则(Crockford Base32, 26 字符) */
export const ULID_REGEX = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** 校验字符串是否为合法 ULID */
export function isStableEngramId(value: string): value is StableEngramId {
  return ULID_REGEX.test(value);
}

/**
 * Engram 索引项(派生缓存)
 *
 * 单条 engram 在 `.co-engram/engram-index.json` 中的记录。
 */
export interface EngramIndexEntry {
  /** Stable engram id (ULID) */
  readonly id: StableEngramId;
  /** 相对 dataRoot 的路径(可能因人类操作而变化) */
  readonly path: string;
  /** 文件标题(可能因人类编辑 frontmatter 而变化) */
  readonly title: string;
  /** 当前 slug(来自 frontmatter 显式 slug 或从 title 派生) */
  readonly slug: string;
  /** frontmatter 显式锁定 slug? */
  readonly slugLocked: boolean;
  /** domainTags(锁定或从路径推断) */
  readonly domainTags: readonly string[];
  /** frontmatter 锁定 domainTags? */
  readonly domainTagsLocked: boolean;
  /** 人类可读 tags */
  readonly tags: readonly string[];
  /** Engram kind */
  readonly kind: EngramKind;
  /** 验证状态 */
  readonly verificationStatus?: VerificationStatus;
  /**
   * 生命周期状态(draft/active/frozen/forgotten)。
   *
   * 用于目录树等视图排除 forgotten(软删除):buildIndexEntryFromFrontmatter
   * 从 frontmatter.status 投影;旧 engram-index.json 缺该字段时视为 active。
   * listPathTree 计数与 viewer engramLocations 据此过滤 forgotten,与卡片
   * 视图(status=active)口径一致。
   */
  readonly status?: EngramStatus;
  /** 创建时间 */
  readonly createdAt: string;
  /** 最后更新时间 */
  readonly updatedAt: string;
  /** 文件 mtime (epoch ms) - doctor 增量扫描用 */
  readonly mtime: number;
  /** 内容 sha256 - 触发搜索索引重建的依据 */
  readonly contentHash: string;
}

/**
 * engram-index.json 派生缓存文件
 *
 * 完整结构,见设计文档 §engram-index.json。
 */
export interface EngramIndex {
  readonly version: 1;
  readonly engrams:
    | ReadonlyMap<StableEngramId, EngramIndexEntry>
    | Record<string, EngramIndexEntry>;
  readonly lastRebuiltAt: string;
}

/**
 * Doctor next-action 提示
 *
 * 让"doctor 报告问题"不只是描述现象,还告诉用户/agent 用哪个工具、怎么解决。
 * 解决 root cause「报告完然后呢?」——挑剔用户不需要翻文档查怎么处理 dangling synapse。
 */
export interface DoctorNextAction {
  /** 推荐使用的工具名(如 engram_delete / synapse_delete / engram_create) */
  readonly tool: string;
  /** 参数提示(自然语言,告诉用户传什么 args) */
  readonly argsHint: string;
  /** 解释为什么用这个工具(用户层说明) */
  readonly explanation: string;
}

/**
 * Doctor 扫描发现的问题
 */
export interface DoctorIssue {
  readonly kind:
    | "moved_file" // 文件路径变了,index 里 id 存在但 path 不同
    | "title_changed" // frontmatter title 与 index 不符(需要重新 slugify)
    | "slug_conflict" // 新 slug 与同目录其他文件冲突
    | "missing_file" // index 里的 id 在磁盘找不到
    | "orphan_markdown" // 无 frontmatter / id 的 markdown
    | "dangling_synapse" // synapse 引用不存在的 engram
    | "duplicate_id" // 两文件 id 重复
    | "duplicate_engram" // 相似度 > 0.95
    | "obsidian_view_stale" // frontmatter.aliases 缺失 或 派生段与 synapse 不一致
    | "index_rebuilt" // digest.jsonl / graph.json 缺失,被 infra-doctor 全量重建
    | "merge_driver_installed" // merge driver 未配置,被 infra-doctor 自动 onboard
    | "dangling_index_reference" // 派生索引(observation-windows/digest/graph)引用了已删 engram,被 post-doctor cleanup 清理
    // ── frontmatter 值合法性校验(2026-07 增强)──
    | "invalid_frontmatter" // YAML 语法错(从 orphan_markdown 分流;有 marker 但 parse 失败)
    | "invalid_field_value" // 字段类型/枚举/范围/格式/必填错(category 通过 message 区分)
    | "multiple_frontmatter" // 文件含多个 frontmatter block(外部编辑/merge 误留);doctor 保留第一个,删多余
    | "derived_field_stale" // contentHash/contentSize 与实际 content 不符(可自动修)
    | "status_renamed" // 2026-07 archived→frozen 重命名:doctor 自动迁移旧 frontmatter
    | "dangling_synapse_cleaned" // synapse 的 from/to 引用不存在的 engram,doctor 自动删除
    | "sqlite_ghost" // SQLite engrams 表有 entry 但 markdown 源文件不存在,doctor 自动级联清理
    | "sqlite_resynced" // SQLite engrams 表字段与 frontmatter 真相不一致,doctor 全量重投对齐(index-no-truth 修复)
    | "skill_imprint_dangling" // skill imprint 的 sourcePath 下 SKILL.md 不存在(skill 目录被删/移),doctor 报告待人工处理
    // ── skill 健康检查(skill-doctor.ts,对称 engram doctor 范式;2026-08 全面适配)──
    | "skill_orphan_skillmd" // SKILL.md 合法但无对应 imprint(手放目录未注册 / imprint 被删),报人工
    | "skill_id_mismatch" // imprint.skillId 与 SKILL.md frontmatter.name 不一致(用户改了 name),报人工
    | "skill_compose_dangling" // skill.composes 引用的 skillId 不存在(被删),doctor 自动移除引用
    | "skill_related_engram_dangling" // skill.relatedEngrams 引用的 engramId 不在 index(被删),doctor 自动移除引用
    | "skill_duplicate_id" // 多个 imprint(sidecar+fallback 或两 sidecar)共一 skillId,报人工
    | "skill_invalid_field_value" // imprint.json 字段级问题(utility 越界 / stats 不自洽 / 枚举非法 / 日期格式错 / schemaVersion≠1);数值类自动修,语义类报人工
    | "skill_contenthash_stale" // imprint.contentHash 与当前指纹不符(直编 imprint 改了 initiationSet),doctor 自动重算
    | "dead_field_removed"; // L1:frontmatter 死字段(如 evidenceCount,派生量从不 increment)被 doctor 自动移除
  readonly stableId?: StableEngramId;
  readonly path?: string;
  readonly message: string;
  /** doctor 是否已自动修复 */
  readonly autoFixed: boolean;
  /** 人工裁决类问题的 next-action 提示(可选,只对需要人工介入的 kind 填) */
  readonly nextAction?: DoctorNextAction;
}

/**
 * Doctor 扫描报告
 */
export interface DoctorReport {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly totalEngrams: number;
  readonly totalSynapses: number;
  readonly issues: readonly DoctorIssue[];
  readonly fixes: readonly DoctorIssue[];
  readonly pendingManualReview: readonly DoctorIssue[];
}

/**
 * 目录树节点(渐进式披露 - 人类浏览层)
 *
 * 用于 viewer 和 engram_list_paths 工具。
 */
export interface PathTreeNode {
  /** 相对 dataRoot 的目录路径(`""` 表示根) */
  readonly path: string;
  /** 当前目录直接包含的 engram 数 */
  readonly engramCount: number;
  /** 子目录 */
  readonly children: readonly PathTreeNode[];
  /** 累积检索次数(用于 activePaths signals) */
  readonly retrievalCount?: number;
  /** 最后活动时间(ISO) */
  readonly lastActivity?: string;
}
