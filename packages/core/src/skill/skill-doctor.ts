/**
 * Skill 健康自愈 —— 对称 `EngramRepository.runDoctor` 的 skill 层。
 *
 * 由 `engram_doctor` 工具在 engram 主流程之后(postflight)调用。检查范围覆盖
 * skill 子系统的全部健康维度,与 engram doctor 的范式对称(orphan / dangling /
 * duplicate / 字段校验 / derived stale)。
 *
 * 检查清单(8 种,kind 见 DoctorIssue):
 *   A. SKILL.md ↔ imprint 双向一致性
 *     - skill_imprint_dangling         imprint 在,SKILL.md 不在(skill 目录被删/移)         报人工
 *     - skill_orphan_skillmd           SKILL.md 合法但无 imprint 注册此 sourcePath         报人工
 *     - skill_id_mismatch              imprint.skillId ≠ SKILL.md frontmatter.name        报人工
 *   B. 引用完整性
 *     - skill_compose_dangling         composes 引用的 skillId 不存在                      自动移除
 *     - skill_related_engram_dangling  relatedEngrams 引用的 engramId 不在 index           自动移除
 *   C. Schema 校验
 *     - skill_invalid_field_value      utility 越界 / stats 不自洽(自动修);枚举非法 / 日期
 *                                      格式错 / imprint.json corrupt(报人工)
 *     - skill_contenthash_stale        contentHash 与当前指纹不符                          自动重算
 *   D. 物理一致性
 *     - skill_duplicate_id             多个 imprint(sidecar+fallback 或两 sidecar)共一 skillId  报人工
 *
 * 设计原则(对称 engram doctor + master plan「基础输入 → 派生」范式):
 *   - 纯函数:接受 dataRoot + canonicalEngramIds(engram 真相,校验 relatedEngrams),
 *     不持有状态、不依赖 SkillRepository 实例(直接复用 imprint / skill-detector 的纯函数)。
 *   - 自动修只做安全可逆操作:数值 clamp、删悬空引用、重算 contentHash、stats 自洽重算。
 *     涉及身份标识(skillId)或语义裁决(枚举值该改成哪个合法值、duplicate 哪份 canonical)
 *     的一律报人工 + nextAction(精确指向 skill_* 工具)。
 *   - 单条异常不阻塞(吞掉继续其他 skill),整体不抛错(上层 doctor 主流程不受影响)。
 *   - 幂等:同一磁盘状态多次跑,自动修只触发一次(修后即一致);人工类每次报直到用户处理。
 *   - 合并回写:同一 imprint 的多项自动修(B1/B2/C1-数值/C2)攒在一次 writeImprint,
 *     避免多次 IO,且 version 只 +1;但分别上报各自的 kind(便于统计 / 过滤)。
 *
 * 与 proposal-engine 的边界:`scanForSkills`(watcher)→ proposeSkill 是"实时捕获新 skill"
 * 的增量流程;本函数是"全量健康审计"。orphan SKILL.md 即使已被 propose(待审批),从健康
 * 角度仍是"有 SKILL.md 无 imprint",照报(语义不同:proposal=待捕获,doctor=健康问题)。
 *
 * @module @co-engram/core/skill
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { DoctorIssue } from "../types/repository-types.js";
import type { SkillImprint } from "../types/skill.js";
import {
  scanAllImprints,
  collectImprintLocations,
  writeImprint,
} from "./imprint.js";
import { collectSkillDirs, parseSkillMd, SKILL_MD_FILENAME } from "./skill-detector.js";
import { computeSkillContentHash } from "./skill-repository.js";

/** 合法 acquisitionStage 枚举(ACT-R compilation 三阶段) */
const VALID_ACQUISITION = new Set(["draft", "compiled", "tuned"]);
/** 合法 retentionStage 枚举(Oblivion retention 离散化) */
const VALID_RETENTION = new Set(["active", "aging", "stale", "forgotten"]);
/** 合法 visibility 枚举 */
const VALID_VISIBILITY = new Set(["public", "team", "private"]);

/** runSkillDoctor 返回结构:fixes(已自动修)+ pending(待人工裁决) */
export interface SkillDoctorResult {
  readonly fixes: readonly DoctorIssue[];
  readonly pending: readonly DoctorIssue[];
}

/**
 * 扫描 skill 子系统并自愈。
 *
 * @param params.dataRoot 记忆仓库根(engram 与 skill 共用)
 * @param params.canonicalEngramIds engram 真相集合(ULID),用于校验 relatedEngrams 引用完整性
 * @returns { fixes, pending }
 */
export function runSkillDoctor(params: {
  readonly dataRoot: string;
  readonly canonicalEngramIds: ReadonlySet<string>;
}): SkillDoctorResult {
  const { dataRoot, canonicalEngramIds } = params;
  const fixes: DoctorIssue[] = [];
  const pending: DoctorIssue[] = [];

  // 扫描阶段:任一扫描失败整体兜底,skill 子系统异常不阻塞 doctor 主流程(engram 层已自愈)
  let imprints: SkillImprint[];
  let locations: ReturnType<typeof collectImprintLocations>;
  let skillDirs: string[];
  try {
    imprints = scanAllImprints(dataRoot);
  } catch {
    return { fixes, pending };
  }
  try {
    locations = collectImprintLocations(dataRoot);
  } catch {
    locations = [];
  }
  try {
    skillDirs = collectSkillDirs(dataRoot);
  } catch {
    skillDirs = [];
  }

  const knownSkillIds = new Set(imprints.map((s) => s.skillId));
  const registeredSourcePaths = new Set(imprints.map((s) => s.sourcePath));

  // ── D. skill_duplicate_id(物理层:多文件共一 skillId)──────────────────────
  // 用 collectImprintLocations(不去重)统计每个 skillId 的物理文件数。
  // scanAllImprints 已 Map 去重(sidecar 覆盖 fallback),磁盘冗余对用户不可见 → 此处暴露。
  const bySkillId = new Map<string, typeof locations>();
  for (const loc of locations) {
    if (loc.skillId === null) continue; // corrupt 文件走 C1
    const arr = bySkillId.get(loc.skillId) ?? [];
    arr.push(loc);
    bySkillId.set(loc.skillId, arr);
  }
  for (const [skillId, locs] of bySkillId) {
    if (locs.length <= 1) continue;
    const channels = locs.map((l) => `${l.channel}:${l.absPath}`).join(", ");
    pending.push({
      kind: "skill_duplicate_id",
      path: locs[0]!.sourcePath ?? undefined,
      message: `Skill "${skillId}" has ${locs.length} imprint files (${channels}) — keep one, delete the others`,
      autoFixed: false,
      nextAction: {
        tool: "skill_delete",
        argsHint: `{ id: "${skillId}" }  // skill_delete 删 sidecar+fallback 两处印迹;若只想删一份,手动 rm 对应 imprint.json`,
        explanation: `多个 imprint 文件共用 skillId "${skillId}"(常见于 sidecar 不可写时降级到 fallback,后来 sidecar 恢复两份都在;或两个 skill 目录的 SKILL.md 同 name)。scanAllImprints 以 sidecar 为准去重,但磁盘冗余该清。决定哪份 canonical,删其余。`,
      },
    });
  }

  // ── C1(corrupt imprint:parse 失败 / schemaVersion≠1)────────────────────
  // 这些文件已被 scanAllImprints 忽略(不进 skill_list),对应 skill 程序性记忆"丢失"。
  for (const loc of locations) {
    if (loc.imprint !== null) continue;
    pending.push({
      kind: "skill_invalid_field_value",
      path: loc.absPath,
      message: `Skill imprint file corrupt (unparseable JSON or schemaVersion≠1): ${loc.absPath}`,
      autoFixed: false,
      nextAction: {
        tool: "(manual edit)",
        argsHint: `修复或删除 ${loc.absPath}`,
        explanation: `imprint.json 无法解析(JSON 语法错 / schemaVersion 不是 1)。此文件已被 scanAllImprints 忽略,对应的 skill 程序性记忆层面"丢失"。手动修复 JSON,或删除后用 skill_create 重新注册(若 SKILL.md 仍在)。`,
      },
    });
  }

  // ── A1/A3(SKILL.md ↔ imprint:imprint 视角)───────────────────────────────
  for (const imp of imprints) {
    const skillMdAbs = safeSkillMdPath(dataRoot, imp.sourcePath);
    if (skillMdAbs === null || !existsSync(skillMdAbs)) {
      // A1: imprint 在,SKILL.md 不在
      pending.push({
        kind: "skill_imprint_dangling",
        path: imp.sourcePath,
        message: `Skill imprint "${imp.skillId}" references sourcePath "${imp.sourcePath}" but its SKILL.md no longer exists — restore the skill directory or delete the imprint`,
        autoFixed: false,
        nextAction: {
          tool: "skill_delete",
          argsHint: `{ id: "${imp.skillId}" }  // 若 skill 已废弃;或把 skill 目录恢复回 "${imp.sourcePath}"`,
          explanation: `imprint 在但 SKILL.md 不在(skill 目录被 rm / mv 走)。这个 skill 在 skill_list 里还在,但宿主按 sourcePath 找不到 SKILL.md,实际不可用。恢复 skill 目录,或 skill_delete 清掉悬空印迹。`,
        },
      });
      continue; // SKILL.md 不存在 → A3 无从比对,跳过
    }
    // A3: SKILL.md 存在 → 比对 skillId(frontmatter name)
    const skillMdSkillId = readSkillMdSkillId(dataRoot, imp.sourcePath);
    if (skillMdSkillId !== null && skillMdSkillId !== imp.skillId) {
      pending.push({
        kind: "skill_id_mismatch",
        path: imp.sourcePath,
        message: `Skill id mismatch: imprint.skillId="${imp.skillId}" but SKILL.md name="${skillMdSkillId}" at "${imp.sourcePath}" — user likely renamed the skill`,
        autoFixed: false,
        nextAction: {
          tool: "skill_update",
          argsHint: `{ id: "${imp.skillId}" }  // 或重建:skill_delete + skill_create 用新 skillId`,
          explanation: `SKILL.md 的 frontmatter name("${skillMdSkillId}")与注册时的 skillId("${imp.skillId}")不一致——通常是用户改了 SKILL.md 的 name。改 skillId 会破坏其他 skill 的 composes 引用,doctor 不自动改。请决定 canonical 名:把 SKILL.md name 改回,或 skill_delete 后用新 skillId 重建(并更新引用方)。`,
        },
      });
    }
  }

  // ── A2(SKILL.md 视角:有合法 SKILL.md 但无 imprint 注册此 sourcePath)────
  for (const sourcePath of skillDirs) {
    if (registeredSourcePaths.has(sourcePath)) continue; // 已注册(A3 已查 skillId 一致性)
    const parsedSkillId = readSkillMdSkillId(dataRoot, sourcePath);
    if (parsedSkillId === null) continue; // SKILL.md 无 frontmatter / YAML 错,不归 doctor 管
    pending.push({
      kind: "skill_orphan_skillmd",
      path: sourcePath,
      message: `SKILL.md at "${sourcePath}" (skillId="${parsedSkillId}") has no imprint — not registered as a skill`,
      autoFixed: false,
      nextAction: {
        tool: "skill_create",
        argsHint: `{ skillId: "${parsedSkillId}", sourcePath: "${sourcePath}", initiationSet: "<触发条件>", createdBy: "<作者>" }`,
        explanation: `目录里有合法 SKILL.md 但没有 imprint(手动放的 skill 目录 / imprint 被删)。这个 skill 不在 skill_list 里,程序性记忆层面"丢失"。用 skill_create 注册(把 SKILL.md 的 description 作为 initiationSet);若是误放,直接 rm 目录。注意:proposal-engine 的 watcher 可能已为它生成待审批提案,两者职责不同(doctor=健康审计,proposal=待捕获)。`,
      },
    });
  }

  // ── B/C(每个 imprint 的引用完整性 + 字段校验 + contentHash)─────────────
  // 自动修(B1/B2/C1-数值/C2)合并到一次 writeImprint;语义类(C1-枚举/日期)报 pending。
  for (const imp of imprints) {
    const skillFixes: DoctorIssue[] = [];
    let next: SkillImprint = imp;

    // B1 composes dangling → 自动移除
    if (imp.composes.length > 0) {
      const kept = imp.composes.filter((id) => knownSkillIds.has(id));
      if (kept.length !== imp.composes.length) {
        const dropped = imp.composes.filter((id) => !knownSkillIds.has(id));
        next = { ...next, composes: kept };
        skillFixes.push({
          kind: "skill_compose_dangling",
          path: imp.sourcePath,
          message: `Skill "${imp.skillId}": removed ${dropped.length} dangling compose(s) [${dropped.join(", ")}] (target skill no longer exists)`,
          autoFixed: true,
        });
      }
    }
    // B2 relatedEngrams dangling → 自动移除
    if (imp.relatedEngrams.length > 0) {
      const kept = imp.relatedEngrams.filter((id) => canonicalEngramIds.has(id));
      if (kept.length !== imp.relatedEngrams.length) {
        const dropped = imp.relatedEngrams.filter((id) => !canonicalEngramIds.has(id));
        next = { ...next, relatedEngrams: kept };
        skillFixes.push({
          kind: "skill_related_engram_dangling",
          path: imp.sourcePath,
          message: `Skill "${imp.skillId}": removed ${dropped.length} dangling relatedEngram(s) [${dropped.join(", ")}] (engram no longer exists)`,
          autoFixed: true,
        });
      }
    }

    // C1 数值类自动修:类型错(JSON 被外部改成 string / null)/ NaN / 越界 / 负值
    // imp.* 类型上是 number,但用户直编 imprint.json 可写入任意类型 → defensive 用 toNumberOrNaN 归一。
    const utilityRaw = toNumberOrNaN(imp.utility);
    if (Number.isNaN(utilityRaw) || utilityRaw < 0 || utilityRaw > 1) {
      const clamped = Number.isNaN(utilityRaw) ? 0.5 : Math.max(0, Math.min(1, utilityRaw));
      next = { ...next, utility: clamped };
      skillFixes.push({
        kind: "skill_invalid_field_value",
        path: imp.sourcePath,
        message: `Skill "${imp.skillId}": utility ${JSON.stringify(imp.utility)} clamped to [0,1] → ${clamped}`,
        autoFixed: true,
      });
    }
    const sn = toNumberOrNaN(imp.successCount);
    const fn = toNumberOrNaN(imp.failureCount);
    const successCount = Number.isNaN(sn) ? 0 : Math.max(0, sn);
    const failureCount = Number.isNaN(fn) ? 0 : Math.max(0, fn);
    if (successCount !== imp.successCount) {
      next = { ...next, successCount };
      skillFixes.push({
        kind: "skill_invalid_field_value",
        path: imp.sourcePath,
        message: `Skill "${imp.skillId}": successCount ${JSON.stringify(imp.successCount)} → ${successCount}`,
        autoFixed: true,
      });
    }
    if (failureCount !== imp.failureCount) {
      next = { ...next, failureCount };
      skillFixes.push({
        kind: "skill_invalid_field_value",
        path: imp.sourcePath,
        message: `Skill "${imp.skillId}": failureCount ${JSON.stringify(imp.failureCount)} → ${failureCount}`,
        autoFixed: true,
      });
    }
    // stats 不自洽:以 success+failure 为真相重算 invocationCount / sampleSize
    // (success / failure 由 recordUse 原子 ++,比 invocationCount 更可靠)
    const reconciledInvoc = successCount + failureCount;
    if (imp.invocationCount !== reconciledInvoc) {
      next = { ...next, invocationCount: reconciledInvoc };
      skillFixes.push({
        kind: "skill_invalid_field_value",
        path: imp.sourcePath,
        message: `Skill "${imp.skillId}": invocationCount ${imp.invocationCount} reconciled to success+failure = ${reconciledInvoc}`,
        autoFixed: true,
      });
    }
    if (imp.sampleSize !== reconciledInvoc) {
      next = { ...next, sampleSize: reconciledInvoc };
      skillFixes.push({
        kind: "skill_invalid_field_value",
        path: imp.sourcePath,
        message: `Skill "${imp.skillId}": sampleSize ${imp.sampleSize} synced to invocationCount = ${reconciledInvoc}`,
        autoFixed: true,
      });
    }

    // C2 contentHash stale → 自动重算(与 skill-repository.computeSkillContentHash 同源)
    const freshHash = computeSkillContentHash(imp.skillId, imp.sourcePath, imp.initiationSet);
    if (freshHash !== imp.contentHash) {
      next = { ...next, contentHash: freshHash };
      skillFixes.push({
        kind: "skill_contenthash_stale",
        path: imp.sourcePath,
        message: `Skill "${imp.skillId}": contentHash recomputed (initiationSet/sourcePath/skillId 指纹不符, likely 直编 imprint)`,
        autoFixed: true,
      });
    }

    // 合并回写:任一字段变了 → 一次 writeImprint(version +1),push 全部 skillFixes
    if (next !== imp) {
      const written: SkillImprint = {
        ...next,
        updatedAt: new Date().toISOString(),
        version: imp.version + 1,
      };
      try {
        writeImprint(dataRoot, written);
        fixes.push(...skillFixes);
      } catch {
        // 回写失败(sidecar+fallback 都不可写)→ 降级报人工,把待修项说明清楚
        pending.push({
          kind: "skill_invalid_field_value",
          path: imp.sourcePath,
          message: `Skill "${imp.skillId}" needs auto-repair (${skillFixes.map((f) => f.message).join("; ")}) but imprint write failed — check filesystem permissions`,
          autoFixed: false,
          nextAction: {
            tool: "(manual edit)",
            argsHint: `检查 ${imp.sourcePath} 目录与 skill-imprints/ 的写权限`,
            explanation: `doctor 计算了修复但无法回写 imprint(sidecar 与 fallback 都不可写,通常是权限 / 磁盘满)。修复文件系统权限后重跑 doctor。`,
          },
        });
      }
    }

    // C1 语义类(不自动修,报人工):枚举非法 / 日期格式错
    // schemaVersion 已由 parseImprint 保证 === 1(否则 imprint=null,走 corrupt 分支)。
    if (!VALID_ACQUISITION.has(imp.acquisitionStage)) {
      pending.push(skillSemanticIssue(imp, `acquisitionStage "${imp.acquisitionStage}" 不在合法枚举 [draft, compiled, tuned]`));
    }
    if (!VALID_RETENTION.has(imp.retentionStage)) {
      pending.push(skillSemanticIssue(imp, `retentionStage "${imp.retentionStage}" 不在合法枚举 [active, aging, stale, forgotten]`));
    }
    if (!VALID_VISIBILITY.has(imp.visibility)) {
      pending.push(skillSemanticIssue(imp, `visibility "${imp.visibility}" 不在合法枚举 [public, team, private]`));
    }
    if (!isValidIsoDate(imp.createdAt)) {
      pending.push(skillSemanticIssue(imp, `createdAt "${imp.createdAt}" 不是合法 ISO 日期`));
    }
    if (!isValidIsoDate(imp.updatedAt)) {
      pending.push(skillSemanticIssue(imp, `updatedAt "${imp.updatedAt}" 不是合法 ISO 日期`));
    }
    if (imp.lastUsedAt !== null && !isValidIsoDate(imp.lastUsedAt)) {
      pending.push(skillSemanticIssue(imp, `lastUsedAt "${imp.lastUsedAt}" 不是合法 ISO 日期(从未使用应设为 null)`));
    }
  }

  return { fixes, pending };
}

/**
 * 安全构造 SKILL.md 绝对路径。sourcePath 非法(逃逸 dataRoot)→ null。
 * imprint.sourcePath 理论受信(我们写入),但用户可直编 imprint.json,defensive 校验。
 */
function safeSkillMdPath(dataRoot: string, sourcePath: string): string | null {
  try {
    return sourcePath === "."
      ? join(dataRoot, SKILL_MD_FILENAME)
      : join(dataRoot, sourcePath, SKILL_MD_FILENAME);
  } catch {
    return null;
  }
}

/**
 * 读取并解析 SKILL.md 的 skillId(frontmatter name || dirName)。
 * 无 frontmatter / YAML 错 / IO 错 → null(调用方据此判断是否合法 SKILL.md)。
 *
 * 注意:parseSkillMd 的第二参数 sourcePath 用于 skillId 兜底(dirName),必须传
 * 相对 dataRoot 的路径(不能传绝对路径,否则 dirName 会取成 "SKILL.md")。
 */
function readSkillMdSkillId(dataRoot: string, sourcePath: string): string | null {
  const abs = sourcePath === "."
    ? join(dataRoot, SKILL_MD_FILENAME)
    : join(dataRoot, sourcePath, SKILL_MD_FILENAME);
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  return parseSkillMd(raw, sourcePath)?.skillId ?? null;
}

/** 把任意值转 number;非 number 类型(string / null / boolean / object)→ NaN,供 clamp 逻辑统一处理 */
function toNumberOrNaN(v: unknown): number {
  return typeof v === "number" ? v : NaN;
}

/** ISO 日期校验(空 / 非法格式 → false;Date.parse 失败返回 NaN) */
function isValidIsoDate(s: string | null | undefined): boolean {
  if (s === null || s === undefined || s === "") return false;
  return !Number.isNaN(Date.parse(s));
}

/** 构造语义类(枚举 / 日期)的 pending issue —— 不自动修,带 nextAction */
function skillSemanticIssue(imp: SkillImprint, detail: string): DoctorIssue {
  return {
    kind: "skill_invalid_field_value",
    path: imp.sourcePath,
    message: `Skill "${imp.skillId}": ${detail}`,
    autoFixed: false,
    nextAction: {
      tool: "skill_update",
      argsHint: `{ id: "${imp.skillId}" }  // 修正对应字段;若 imprint.json 多处损坏,skill_delete + skill_create 重建`,
      explanation: `${detail}。doctor 不自动改语义字段(合法值该由用户决定)。手动编辑 imprint.json 修正,或删后重建印迹。`,
    },
  };
}
