/**
 * SkillRepository —— Skill CRUD over sidecar（对称 EngramRepository，但不接 SQLite/不接维护引擎）
 * @module @co-engram/core/skill
 */
import { computeContentHash } from "../storage/hash.js";
import { validationError, notFoundError } from "../tools/error-schema.js";
import type { Skill, SkillCreateInput, SkillUpdateInput, SkillPolicy } from "../types/skill.js";
import {
  updateUtility,
  computeRetention,
  projectRetentionStage,
  canTransitionAcquisition,
  DEFAULT_LEARNING_RATE,
} from "./dynamics.js";
import { writeImprint, readImprint, deleteImprint, scanAllImprints } from "./imprint.js";

export interface RecordUseInput {
  readonly success: boolean;
  readonly effectiveness?: number;
}

export class SkillRepository {
  constructor(private readonly dataRoot: string) {}

  createSkill(input: SkillCreateInput): Skill {
    if (this.exists(input.skillId)) {
      throw validationError(`Skill already exists: ${input.skillId}`, { resourceId: input.skillId });
    }
    const now = new Date().toISOString();
    const skill: Skill = {
      schemaVersion: 1,
      skillId: input.skillId,
      sourcePath: input.sourcePath,
      contentHash: computePolicyHash(input.policy),
      initiationSet: input.initiationSet,
      termination: input.termination,
      policy: input.policy,
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
    return scanAllImprints(this.dataRoot).sort((a, b) => a.skillId.localeCompare(b.skillId));
  }

  exists(skillId: string): boolean {
    return !!this.find(skillId);
  }

  updateSkill(skillId: string, patch: SkillUpdateInput): Skill {
    const cur = this.readSkill(skillId);
    if (patch.acquisitionStage && patch.acquisitionStage !== cur.acquisitionStage) {
      if (!canTransitionAcquisition(cur.acquisitionStage, patch.acquisitionStage)) {
        throw validationError(
          `Illegal acquisition transition: ${cur.acquisitionStage}→${patch.acquisitionStage} (only forward single-step draft→compiled→tuned)`,
          { resourceId: skillId },
        );
      }
    }
    const next: Skill = {
      ...cur,
      ...(patch.initiationSet !== undefined ? { initiationSet: patch.initiationSet } : {}),
      ...(patch.termination !== undefined ? { termination: patch.termination } : {}),
      ...(patch.policy !== undefined ? { policy: patch.policy, contentHash: computePolicyHash(patch.policy) } : {}),
      ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
      ...(patch.acquisitionStage !== undefined ? { acquisitionStage: patch.acquisitionStage } : {}),
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
    const updatedSkill: Skill = {
      ...cur,
      utility,
      sampleSize: cur.sampleSize + 1,
      invocationCount: cur.invocationCount + 1,
      successCount: cur.successCount + (use.success ? 1 : 0),
      failureCount: cur.failureCount + (use.success ? 0 : 1),
      lastUsedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: cur.version + 1,
    };
    const retentionStage = projectRetentionStage(computeRetention(updatedSkill, Date.now()));
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
  recomputeRetentionAll(nowMs: number = Date.now()): { readonly scanned: number; readonly changed: number } {
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

function computePolicyHash(policy: SkillPolicy): string {
  return computeContentHash(`${policy.kind}|${policy.ref}`);
}
