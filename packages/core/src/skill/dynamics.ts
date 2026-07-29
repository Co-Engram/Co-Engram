/**
 * Skill 印迹核纯函数（spec §2.3）
 * - utility: ACT-R Rescorla-Wagner
 * - retention: Oblivion exp(-n/S), S=(U+F+ε)·T
 * @module @co-engram/core/skill
 */
import type { AcquisitionStage, RetentionStage } from "../types/skill.js";

export const DEFAULT_LEARNING_RATE = 0.1;
const OBLIVION_T = 10;
const OBLIVION_EPSILON = 0.1;
const FREQUENCY_CAP = 20;
const RETENTION_THRESHOLD_ACTIVE = 0.75;
const RETENTION_THRESHOLD_AGING = 0.5;
const RETENTION_THRESHOLD_STALE = 0.25;

export function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/** Rescorla-Wagner: U(n)=U(n-1)+α·[R(n)-U(n-1)] */
export function updateUtility(currentU: number, reward: number, alpha = DEFAULT_LEARNING_RATE): number {
  return clamp01(currentU + alpha * (reward - currentU));
}

/** Oblivion: retention=exp(-n/S), S=(U+F+ε)·T, n=距上次使用天数, F=归一化频率 */
export function computeRetention(
  skill: { readonly utility: number; readonly invocationCount: number; readonly lastUsedAt: string | null },
  nowMs: number,
): number {
  const u = clamp01(skill.utility);
  const f = Math.min(1, skill.invocationCount / FREQUENCY_CAP);
  const s = (u + f + OBLIVION_EPSILON) * OBLIVION_T;
  const last = skill.lastUsedAt ? new Date(skill.lastUsedAt).getTime() : nowMs;
  const nDays = Math.max(0, (nowMs - last) / 86_400_000);
  return Math.exp(-nDays / s);
}

export function projectRetentionStage(retention: number): RetentionStage {
  if (retention > RETENTION_THRESHOLD_ACTIVE) return "active";
  if (retention > RETENTION_THRESHOLD_AGING) return "aging";
  if (retention > RETENTION_THRESHOLD_STALE) return "stale";
  return "forgotten";
}

const ACQUISITION_ORDER: readonly AcquisitionStage[] = ["draft", "compiled", "tuned"];

export function canTransitionAcquisition(from: AcquisitionStage, to: AcquisitionStage): boolean {
  if (from === to) return false;
  return ACQUISITION_ORDER.indexOf(to) - ACQUISITION_ORDER.indexOf(from) === 1;
}
