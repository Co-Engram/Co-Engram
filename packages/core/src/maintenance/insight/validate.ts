/**
 * 提案时机械硬校验(spec §五第一关)。
 *
 * 能力边界(诚实声明):只覆盖**结构客观性** —— 引用闭合、结构完整、
 * 查重、模式专属的结构性判据;覆盖不了 critic 四维的实际成色,
 * 该偏差维度由独立 critic(Task critic.ts)与人工 accept 把关。
 *
 * @module @co-engram/core/maintenance/insight
 */

import { jaccardSimilarity, tokenizeForDedup } from "../../dedup/similar.js";
import type { EngramRepository } from "../../storage/repository.js";
import { GENERIC_DOMAIN_TAGS, INSIGHT_LIMITS, type InsightDraft, type InsightSubgraph } from "./types.js";

/** 校验结果:ok=false 时 reason 说明拒绝原因(进 report,不抛错) */
export type ValidateResult = { ok: true } | { ok: false; reason: string };

/** 已有提案的最小结构(validate 查重用,避免循环依赖 ProposalEngine) */
export interface ProposalLike {
  readonly source?: string;
  readonly payload?: {
    readonly content?: string;
    readonly title?: string;
    readonly remSourceIds?: readonly string[];
  };
  readonly status?: string;
  readonly dismissReason?: string;
  readonly centroidExcerpt?: string;
  readonly createdAt?: string;
  readonly lastSeenAt?: string;
}

/** 内容 Jaccard(token 集合;title+content 参与查重) */
export function contentJaccard(a: string, b: string): number {
  return jaccardSimilarity(
    tokenizeForDedup(a),
    tokenizeForDedup(b),
  );
}

/**
 * 机械校验单条洞察草稿:
 * 1. 引用闭合:sourceIds ⊆ 输入子图且在 repo 中存在
 * 2. 结构完整:各类型必填字段
 * 3. 模式专属:
 *    - theme:跨情境性(≥2 来源)
 *    - lesson:AAR 四要素齐(缺一环即弃)
 *    - analogy:两源域不相交(过滤笼统标签)+ 低表面 Jaccard
 *    - hypothesis:必填可证伪说明(附「若真应观察到/若假应观察到」)
 * 4. 查重:与已有 rem-insight/pattern 提案或 pattern engram Jaccard ≥ 阈值丢弃
 */
export function validateInsightDraft(
  draft: InsightDraft,
  subgraph: InsightSubgraph,
  repo: EngramRepository,
  existingProposals: readonly ProposalLike[],
): ValidateResult {
  // ---- 结构完整 ----
  if (!draft.title.trim()) return { ok: false, reason: "empty title" };
  if (!draft.content.trim()) return { ok: false, reason: "empty content" };
  if (!draft.sourceIds.length) return { ok: false, reason: "no sourceIds" };

  // ---- 引用闭合 ----
  const subgraphIds = new Set(subgraph.nodes.map((n) => n.id));
  for (const id of draft.sourceIds) {
    if (!subgraphIds.has(id)) {
      return { ok: false, reason: `source ${id} not in input subgraph (citation closure)` };
    }
    if (!repo.exists(id)) {
      return { ok: false, reason: `source ${id} no longer exists` };
    }
  }

  // ---- 模式专属 ----
  switch (draft.type) {
    case "pattern": {
      // 与 theme 同构的 ≥2 来源要求:可复用规律必须从多条观察中提炼,
      // 单来源「规律」只是转述(theme 强调跨情境,pattern 强调可复用)。
      if (draft.sourceIds.length < 2) {
        return {
          ok: false,
          reason: "pattern requires >=2 sources (a reusable structure must be distilled from multiple observations)",
        };
      }
      break;
    }
    case "theme": {
      if (draft.sourceIds.length < 2) {
        return { ok: false, reason: "theme requires >=2 sources (cross-contextuality)" };
      }
      break;
    }
    case "lesson": {
      const aar = draft.aar;
      const four = ["expected", "actual", "cause", "improvement"] as const;
      for (const k of four) {
        if (!aar || !aar[k] || !aar[k]!.trim()) {
          return { ok: false, reason: `lesson missing AAR element: ${k} (缺一环即弃)` };
        }
      }
      break;
    }
    case "analogy": {
      const domainsPerSource = draft.sourceIds.map((id) => {
        const node = subgraph.nodes.find((n) => n.id === id);
        return new Set((node?.domainTags ?? []).filter((t) => !GENERIC_DOMAIN_TAGS.has(t)));
      });
      // 至少两个来源;任意两源的(有效)域集合不相交
      if (domainsPerSource.length < 2) {
        return { ok: false, reason: "analogy requires >=2 sources" };
      }
      for (let i = 0; i < domainsPerSource.length; i++) {
        for (let j = i + 1; j < domainsPerSource.length; j++) {
          const a = domainsPerSource[i]!;
          const b = domainsPerSource[j]!;
          if (a.size === 0 || b.size === 0) {
            return { ok: false, reason: "analogy source has no specific domain (generic tags only)" };
          }
          const overlap = [...a].filter((t) => b.has(t));
          if (overlap.length > 0) {
            return { ok: false, reason: `analogy domains overlap: ${overlap.join(",")}` };
          }
          // 低表面相似:title+summary Jaccard(代码只能验证「确实远」,
          // 验证不了映射有效性 ——「远而牵强」由 critic 与人工把关,spec §三)
          const na = subgraph.nodes.find((n) => n.id === draft.sourceIds[i])!;
          const nb = subgraph.nodes.find((n) => n.id === draft.sourceIds[j])!;
          const sim = contentJaccard(`${na.title} ${na.summary}`, `${nb.title} ${nb.summary}`);
          if (sim >= INSIGHT_LIMITS.jaccardDup) {
            return { ok: false, reason: `analogy sources too similar on surface (jaccard=${sim.toFixed(2)})` };
          }
        }
      }
      break;
    }
    case "hypothesis": {
      // 必须可证伪:附「若真应观察到/若假应观察到」
      if (!/if true|若真|if false|若假/i.test(draft.content)) {
        return { ok: false, reason: "hypothesis must be falsifiable (attach what to observe if true / if false)" };
      }
      break;
    }
  }

  // ---- 查重:与已有 rem-insight 提案 / pattern engram ----
  const draftText = `${draft.title}\n${draft.content}`;
  for (const p of existingProposals) {
    if (p.source === "rem-insight" && p.payload?.content) {
      if (contentJaccard(draftText, p.payload.content) >= INSIGHT_LIMITS.jaccardDup) {
        return { ok: false, reason: "duplicates an existing rem-insight proposal (jaccard >= threshold)" };
      }
    }
  }
  for (const e of repo.listDigestByVerificationStatus(["unverified", "plausible", "probable", "verified"], { lifecycleStatuses: ["active"] })) {
    if (e.kind !== "pattern") continue;
    if (contentJaccard(draftText, `${e.title}\n${e.summary}`) >= INSIGHT_LIMITS.jaccardDup) {
      return { ok: false, reason: "duplicates an existing pattern engram (jaccard >= threshold)" };
    }
  }

  return { ok: true };
}
