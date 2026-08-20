/**
 * SkillRepository —— Skill CRUD over sidecar（对称 EngramRepository，但不接 SQLite/不接维护引擎）
 * @module @co-engram/core/skill
 */
import { computeContentHash } from "../storage/hash.js";
import { validationError, notFoundError } from "../tools/error-schema.js";
import type {
  Skill,
  SkillCreateInput,
  SkillUpdateInput,
} from "../types/skill.js";
import {
  updateUtility,
  computeRetention,
  projectRetentionStage,
  canTransitionAcquisition,
  isRetireCandidate,
  DEFAULT_LEARNING_RATE,
} from "./dynamics.js";
import {
  writeImprint,
  readImprint,
  deleteImprint,
  scanAllImprints,
} from "./imprint.js";

export interface RecordUseInput {
  readonly success: boolean;
  readonly effectiveness?: number;
}

export class SkillRepository {
  constructor(private readonly dataRoot: string) {}

  createSkill(input: SkillCreateInput): Skill {
    if (this.exists(input.skillId)) {
      throw validationError(`Skill already exists: ${input.skillId}`, {
        resourceId: input.skillId,
      });
    }
    const now = new Date().toISOString();
    const skill: Skill = {
      schemaVersion: 1,
      skillId: input.skillId,
      sourcePath: input.sourcePath,
      contentHash: computeSkillContentHash(
        input.skillId,
        input.sourcePath,
        input.initiationSet,
      ),
      initiationSet: input.initiationSet,
      ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
      ...(input.license ? { license: input.license } : {}),
      ...(input.skillVersion ? { skillVersion: input.skillVersion } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(input.compatibility ? { compatibility: input.compatibility } : {}),
      utility: 0.5,
      sampleSize: 0,
      invocationCount: 0,
      successCount: 0,
      failureCount: 0,
      lastUsedAt: null,
      acquisitionStage: "draft",
      retentionStage: "active",
      visibility: input.visibility ?? "team",
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      version: 1,
      composes: [...(input.composes ?? [])],
      relatedEngrams: [...(input.relatedEngrams ?? [])],
    };
    writeImprint(this.dataRoot, skill);
    return skill;
  }

  readSkill(skillId: string): Skill {
    const s = this.find(skillId);
    if (!s) throw notFoundError("Skill", skillId);
    return s;
  }

  listSkills(): Skill[] {
    return scanAllImprints(this.dataRoot).sort((a, b) =>
      a.skillId.localeCompare(b.skillId),
    );
  }

  exists(skillId: string): boolean {
    return !!this.find(skillId);
  }

  updateSkill(skillId: string, patch: SkillUpdateInput): Skill {
    const cur = this.readSkill(skillId);
    if (
      patch.acquisitionStage &&
      patch.acquisitionStage !== cur.acquisitionStage
    ) {
      if (
        !canTransitionAcquisition(cur.acquisitionStage, patch.acquisitionStage)
      ) {
        throw validationError(
          `Illegal acquisition transition: ${cur.acquisitionStage}→${patch.acquisitionStage} (only forward single-step draft→compiled→tuned)`,
          { resourceId: skillId },
        );
      }
    }
    const next: Skill = {
      ...cur,
      // S6.x: contentHash 现追踪 initiationSet（原追踪 policy,policy 已移除）;initiationSet 变更时同步重算
      ...(patch.initiationSet !== undefined
        ? {
            initiationSet: patch.initiationSet,
            contentHash: computeSkillContentHash(
              cur.skillId,
              cur.sourcePath,
              patch.initiationSet,
            ),
          }
        : {}),
      ...(patch.visibility !== undefined
        ? { visibility: patch.visibility }
        : {}),
      ...(patch.acquisitionStage !== undefined
        ? { acquisitionStage: patch.acquisitionStage }
        : {}),
      updatedAt: new Date().toISOString(),
      version: cur.version + 1,
    };
    writeImprint(this.dataRoot, next);
    return next;
  }

  /**
   * skill_invoke(S3) 与测试用：记录一次使用，Rescorla-Wagner 更新 utility + retention 重算。
   *
   * S1 限制：不接 light stage 周期性重算，故 recordUse 后 retentionStage 总是 active
   * （lastUsedAt=now → computeRetention≈1）；周期性衰退留 S3 维护引擎接入。
   */
  recordUse(skillId: string, use: RecordUseInput): Skill {
    const cur = this.readSkill(skillId);
    const reward = use.success ? (use.effectiveness ?? 1.0) : 0.0;
    const utility = updateUtility(cur.utility, reward, DEFAULT_LEARNING_RATE);
    // 使用即复活:剥离 retiredAt(退役的人工裁决被真实使用翻案,与 forgotten
    // 复活同构;调用方 skill_invoke 另行撤销 pending 的 skill-retire 提案)
    const { retiredAt: _retiredAt, ...rest } = cur;
    const updatedSkill: Skill = {
      ...rest,
      utility,
      sampleSize: cur.sampleSize + 1,
      invocationCount: cur.invocationCount + 1,
      successCount: cur.successCount + (use.success ? 1 : 0),
      failureCount: cur.failureCount + (use.success ? 0 : 1),
      lastUsedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: cur.version + 1,
    };
    const retentionStage = projectRetentionStage(
      computeRetention(updatedSkill, Date.now()),
    );
    const next: Skill = {
      ...updatedSkill,
      retentionStage,
    };
    writeImprint(this.dataRoot, next);
    return next;
  }

  /**
   * 批量重算所有 skill 的 retentionStage（light stage 周期调用）。
   * 用 Oblivion computeRetention(projectRetentionStage)；只改 retentionStage，不动 utility/stats/lastUsedAt。
   * @returns scanned 扫描数；changed retentionStage 实际变更数
   */
  recomputeRetentionAll(nowMs: number = Date.now()): {
    readonly scanned: number;
    readonly changed: number;
  } {
    const all = scanAllImprints(this.dataRoot);
    let scanned = 0;
    let changed = 0;
    for (const skill of all) {
      scanned += 1;
      const newStage = projectRetentionStage(computeRetention(skill, nowMs));
      if (newStage === skill.retentionStage) continue;
      // 只改 retentionStage（spread 新对象，字段 readonly）
      const updated: Skill = {
        ...skill,
        retentionStage: newStage,
        updatedAt: new Date(nowMs).toISOString(),
        version: skill.version + 1,
      };
      writeImprint(this.dataRoot, updated);
      changed += 1;
    }
    return { scanned, changed };
  }

  /**
   * 重新激活 forgotten/stale 技能(viewer 恢复按钮)。
   *
   * retentionStage 是纯派生投影(无锁字段),恢复语义 = touch lastUsedAt
   * 让 computeRetention 回满 → retentionStage 回 active。与 recordUse 不同:
   * 不增 invocationCount / 不动 utility 与成败统计——人工恢复不是一次"使用"。
   * retired 技能同此复活:清除 retiredAt(退役是人工裁决态,touch 即翻案)。
   */
  reactivateSkill(skillId: string, nowMs: number = Date.now()): Skill {
    const cur = this.readSkill(skillId);
    const lastUsedAt = new Date(nowMs).toISOString();
    const { retiredAt: _retiredAt, ...rest } = cur;
    const next: Skill = {
      ...rest,
      lastUsedAt,
      retentionStage: projectRetentionStage(
        computeRetention({ ...cur, lastUsedAt }, nowMs),
      ),
      updatedAt: new Date(nowMs).toISOString(),
      version: cur.version + 1,
    };
    writeImprint(this.dataRoot, next);
    return next;
  }

  /**
   * 技能退役(2026-08 退役回路):accept skill-retire 提案时调用。
   *
   * 只写 retiredAt 人工裁决态——不动 retentionStage(纯派生投影)、不动
   * utility/stats、不删印迹、不动 SKILL.md。skill_list 默认过滤、catalog
   * 不注入由消费方按 retiredAt 判定。
   */
  retireSkill(skillId: string, nowMs: number = Date.now()): Skill {
    const cur = this.readSkill(skillId);
    if (cur.retiredAt !== undefined) return cur; // 幂等
    const next: Skill = {
      ...cur,
      retiredAt: new Date(nowMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
      version: cur.version + 1,
    };
    writeImprint(this.dataRoot, next);
    return next;
  }

  /**
   * 扫描退役候选(纯判定见 dynamics.isRetireCandidate)。light 周期调用,
   * 候选交 proposalEngine.proposeSkillRetire 生成提案——不直接退役。
   */
  listRetireCandidates(
    nowMs: number,
    minZeroUseDays: number,
  ): readonly Skill[] {
    return scanAllImprints(this.dataRoot).filter((s) =>
      isRetireCandidate(s, nowMs, minZeroUseDays),
    );
  }

  /**
   * 加组合关系（去重：已存在不重复加）。返回更新后的 skill。
   */
  addCompose(skillId: string, targetSkillId: string): Skill {
    const cur = this.readSkill(skillId);
    if (cur.composes.includes(targetSkillId)) return cur; // 去重
    const next: Skill = {
      ...cur,
      composes: [...cur.composes, targetSkillId],
      updatedAt: new Date().toISOString(),
      version: cur.version + 1,
    };
    writeImprint(this.dataRoot, next);
    return next;
  }

  /**
   * 移除组合关系。
   */
  removeCompose(skillId: string, targetSkillId: string): Skill {
    const cur = this.readSkill(skillId);
    const next: Skill = {
      ...cur,
      composes: cur.composes.filter((c) => c !== targetSkillId),
      updatedAt: new Date().toISOString(),
      version: cur.version + 1,
    };
    writeImprint(this.dataRoot, next);
    return next;
  }

  /**
   * 加 engram 关联（去重）。返回更新后的 skill。
   */
  addRelatedEngram(skillId: string, engramId: string): Skill {
    const cur = this.readSkill(skillId);
    if (cur.relatedEngrams.includes(engramId)) return cur;
    const next: Skill = {
      ...cur,
      relatedEngrams: [...cur.relatedEngrams, engramId],
      updatedAt: new Date().toISOString(),
      version: cur.version + 1,
    };
    writeImprint(this.dataRoot, next);
    return next;
  }

  /**
   * 移除 engram 关联。返回更新后的 skill。
   */
  removeRelatedEngram(skillId: string, engramId: string): Skill {
    const cur = this.readSkill(skillId);
    const next: Skill = {
      ...cur,
      relatedEngrams: cur.relatedEngrams.filter((e) => e !== engramId),
      updatedAt: new Date().toISOString(),
      version: cur.version + 1,
    };
    writeImprint(this.dataRoot, next);
    return next;
  }

  deleteSkill(skillId: string): void {
    const cur = this.find(skillId);
    if (!cur) return;
    deleteImprint(this.dataRoot, skillId, cur.sourcePath);
  }

  /**
   * 按 skillId 查找。YAGNI: 走 scanAllImprints 全盘扫描——skill 数量预期几十，可接受；
   * >100 时考虑加 skills-index.json（类比 engram-index.json）。
   */
  private find(skillId: string): Skill | undefined {
    return scanAllImprints(this.dataRoot).find((s) => s.skillId === skillId);
  }
}

/**
 * S6.x: contentHash 算法 —— 原 computePolicyHash(policy) 随 policy 字段一并移除。
 * 现追踪 skill 的剩余"内容"字段（skillId|sourcePath|initiationSet），无执行语义,仅作身份指纹。
 *
 * skill-doctor 复用此函数检测 contentHash stale(直编 imprint 改 initiationSet 后指纹不符),
 * 保证"写入算法"与"校验算法"同源,避免双实现 drift。
 */
export function computeSkillContentHash(
  skillId: string,
  sourcePath: string,
  initiationSet: string,
): string {
  return computeContentHash(`${skillId}|${sourcePath}|${initiationSet}`);
}
