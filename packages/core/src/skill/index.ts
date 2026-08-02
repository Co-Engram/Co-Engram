/**
 * Skill 子系统导出（spec §S1）
 * - types: Skill 类型定义
 * - repository: SkillRepository（CRUD + recordUse）
 * - dynamics: 印迹核纯函数（utility/retention）
 * - imprint: sidecar 存储抽象
 *
 * @module @co-engram/core/skill
 */

export type {
  Skill,
  SkillImprint,
  AcquisitionStage,
  RetentionStage,
  SkillCreateInput,
  SkillUpdateInput,
  SkillResult,
} from "../types/skill.js";

export { SkillRepository } from "./skill-repository.js";
export type { RecordUseInput } from "./skill-repository.js";

export {
  updateUtility,
  computeRetention,
  projectRetentionStage,
  canTransitionAcquisition,
  clamp01,
  DEFAULT_LEARNING_RATE,
} from "./dynamics.js";

export {
  writeImprint,
  readImprint,
  deleteImprint,
  scanAllImprints,
  sidecarPath,
  fallbackPath,
  computeImprintHash,
  SIDECAR_DIR,
  SIDECAR_FILE,
  FALLBACK_DIR,
} from "./imprint.js";
