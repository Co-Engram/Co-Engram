/**
 * runSkillDoctor 单测 —— skill 子系统健康自愈(对称 engram doctor)。
 *
 * 覆盖 8 类检查 + 否定用例 + 幂等。直接调纯函数 runSkillDoctor,构造真实 dataRoot
 * (SKILL.md + imprint sidecar/fallback),不依赖 SkillRepository 实例(仅用它造合法 imprint)。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSkillDoctor } from "../src/skill/skill-doctor.js";
import { SkillRepository } from "../src/skill/skill-repository.js";
import { computeImprintHash } from "../src/skill/imprint.js";
import { engramDoctorTool } from "../src/tools/doctor-tools.js";
import { EngramRepository } from "../src/storage/repository.js";

let tmpDir: string;
let skillRepo: SkillRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-skill-doctor-"));
  skillRepo = new SkillRepository(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** 在 <tmpDir>/<sourcePath>/SKILL.md 写合法 frontmatter(name + description) */
function writeSkillMd(sourcePath: string, name: string): void {
  const dir = join(tmpDir, sourcePath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: "trigger when ..."\n---\n\nbody\n`,
  );
}

/** 读 sidecar imprint(JSON),返回 any 便于测试断言 */
function readImprint(sourcePath: string): any {
  return JSON.parse(
    readFileSync(join(tmpDir, sourcePath, ".co-engram", "imprint.json"), "utf8"),
  );
}

/** 直写 sidecar imprint(模拟用户外部编辑,绕过 SkillRepository 类型约束) */
function writeImprintRaw(sourcePath: string, obj: any): void {
  writeFileSync(
    join(tmpDir, sourcePath, ".co-engram", "imprint.json"),
    JSON.stringify(obj, null, 2) + "\n",
  );
}

function doctor(canonicalEngramIds: ReadonlySet<string> = new Set()) {
  return runSkillDoctor({ dataRoot: tmpDir, canonicalEngramIds });
}

const has = (arr: readonly { readonly kind: string }[], kind: string) =>
  arr.some((i) => i.kind === kind);

describe("runSkillDoctor", () => {
  // ── A. SKILL.md ↔ imprint 双向一致性 ──────────────────────────────────

  it("A1 skill_imprint_dangling: imprint 在但 SKILL.md 不在 → pending", () => {
    skillRepo.createSkill({
      skillId: "foo",
      sourcePath: "skills/foo",
      initiationSet: "t",
      createdBy: "tester",
    });
    // 故意不写 SKILL.md
    const r = doctor();
    expect(has(r.pending, "skill_imprint_dangling")).toBe(true);
    expect(r.fixes).toHaveLength(0);
    const issue = r.pending.find((i) => i.kind === "skill_imprint_dangling")!;
    expect(issue.nextAction?.tool).toBe("skill_delete");
  });

  it("A2 skill_orphan_skillmd: SKILL.md 合法但无 imprint → pending + skill_create 提示", () => {
    writeSkillMd("skills/bar", "bar");
    const r = doctor();
    const orphan = r.pending.find((i) => i.kind === "skill_orphan_skillmd");
    expect(orphan).toBeDefined();
    expect(orphan!.nextAction!.tool).toBe("skill_create");
    expect(orphan!.path).toBe("skills/bar");
  });

  it("A2 否定: SKILL.md 无 frontmatter → 不报 orphan(不归 doctor 管)", () => {
    const dir = join(tmpDir, "skills/bare");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "no frontmatter, just body");
    const r = doctor();
    expect(has(r.pending, "skill_orphan_skillmd")).toBe(false);
  });

  it("A3 skill_id_mismatch: imprint.skillId ≠ SKILL.md name → pending", () => {
    skillRepo.createSkill({
      skillId: "foo",
      sourcePath: "skills/foo",
      initiationSet: "t",
      createdBy: "tester",
    });
    writeSkillMd("skills/foo", "bar"); // name=bar ≠ skillId=foo
    const r = doctor();
    expect(has(r.pending, "skill_id_mismatch")).toBe(true);
  });

  // ── B. 引用完整性 ────────────────────────────────────────────────────

  it("B1 skill_compose_dangling: composes 引用不存在的 skill → 自动移除 + 幂等", () => {
    skillRepo.createSkill({
      skillId: "A",
      sourcePath: "skills/a",
      initiationSet: "t",
      createdBy: "tester",
      composes: ["B"] as any, // B 不存在
    });
    writeSkillMd("skills/a", "A");
    const r1 = doctor();
    expect(has(r1.fixes, "skill_compose_dangling")).toBe(true);
    expect(readImprint("skills/a").composes).toEqual([]);
    // 幂等:再跑无此 fix
    const r2 = doctor();
    expect(has(r2.fixes, "skill_compose_dangling")).toBe(false);
  });

  it("B2 skill_related_engram_dangling: relatedEngrams 引用不在 index 的 engram → 自动移除", () => {
    skillRepo.createSkill({
      skillId: "A",
      sourcePath: "skills/a",
      initiationSet: "t",
      createdBy: "tester",
      relatedEngrams: ["01DEADULID"] as any,
    });
    writeSkillMd("skills/a", "A");
    const r = doctor(new Set()); // canonicalEngramIds 为空
    expect(has(r.fixes, "skill_related_engram_dangling")).toBe(true);
    expect(readImprint("skills/a").relatedEngrams).toEqual([]);
  });

  it("B2 否定: relatedEngram 在 canonicalEngramIds → 不报", () => {
    skillRepo.createSkill({
      skillId: "A",
      sourcePath: "skills/a",
      initiationSet: "t",
      createdBy: "tester",
      relatedEngrams: ["01ALIVE"] as any,
    });
    writeSkillMd("skills/a", "A");
    const r = doctor(new Set(["01ALIVE"]));
    expect(has(r.fixes, "skill_related_engram_dangling")).toBe(false);
  });

  // ── C. Schema 校验 ──────────────────────────────────────────────────

  it("C1 数值类: utility 越界 + stats 不自洽 + sampleSize drift → 自动修", () => {
    skillRepo.createSkill({
      skillId: "A",
      sourcePath: "skills/a",
      initiationSet: "t",
      createdBy: "tester",
    });
    writeSkillMd("skills/a", "A");
    const imp = readImprint("skills/a");
    imp.utility = 1.5; // 越界
    imp.successCount = 3;
    imp.failureCount = 2;
    imp.invocationCount = 10; // 不自洽(应 = 5)
    imp.sampleSize = 0; // drift(应 = 5)
    writeImprintRaw("skills/a", imp);
    const r = doctor();
    expect(r.fixes.length).toBeGreaterThan(0);
    const fixed = readImprint("skills/a");
    expect(fixed.utility).toBe(1);
    expect(fixed.invocationCount).toBe(5);
    expect(fixed.sampleSize).toBe(5);
  });

  it("C1 数值类: 非数字 utility → clamp 到 0.5", () => {
    skillRepo.createSkill({
      skillId: "A",
      sourcePath: "skills/a",
      initiationSet: "t",
      createdBy: "tester",
    });
    writeSkillMd("skills/a", "A");
    const imp = readImprint("skills/a");
    imp.utility = "not-a-number" as any; // JSON 里非数字
    writeImprintRaw("skills/a", imp);
    const r = doctor();
    expect(has(r.fixes, "skill_invalid_field_value")).toBe(true);
    expect(readImprint("skills/a").utility).toBe(0.5);
  });

  it("C1 枚举类: acquisitionStage 非法 → pending(不自动改)", () => {
    skillRepo.createSkill({
      skillId: "A",
      sourcePath: "skills/a",
      initiationSet: "t",
      createdBy: "tester",
    });
    writeSkillMd("skills/a", "A");
    const imp = readImprint("skills/a");
    imp.acquisitionStage = "bogus";
    writeImprintRaw("skills/a", imp);
    const r = doctor();
    expect(
      r.pending.some(
        (i) => i.kind === "skill_invalid_field_value" && i.message.includes("acquisitionStage"),
      ),
    ).toBe(true);
    // 不自动改语义字段
    expect(readImprint("skills/a").acquisitionStage).toBe("bogus");
  });

  it("C1 日期类: updatedAt 非法 → pending", () => {
    skillRepo.createSkill({
      skillId: "A",
      sourcePath: "skills/a",
      initiationSet: "t",
      createdBy: "tester",
    });
    writeSkillMd("skills/a", "A");
    const imp = readImprint("skills/a");
    imp.updatedAt = "not-a-date";
    writeImprintRaw("skills/a", imp);
    const r = doctor();
    expect(
      r.pending.some((i) => i.message.includes("updatedAt")),
    ).toBe(true);
  });

  it("C2 contentHash stale → 自动重算 + 幂等", () => {
    skillRepo.createSkill({
      skillId: "A",
      sourcePath: "skills/a",
      initiationSet: "old",
      createdBy: "tester",
    });
    writeSkillMd("skills/a", "A");
    const imp = readImprint("skills/a");
    imp.initiationSet = "new"; // 内容变了但 contentHash 未更新
    writeImprintRaw("skills/a", imp);
    const r1 = doctor();
    expect(has(r1.fixes, "skill_contenthash_stale")).toBe(true);
    // 幂等:重算后再跑不再报
    const r2 = doctor();
    expect(has(r2.fixes, "skill_contenthash_stale")).toBe(false);
  });

  // ── D. 物理一致性 ──────────────────────────────────────────────────

  it("D skill_duplicate_id: sidecar + fallback 共 skillId → pending", () => {
    skillRepo.createSkill({
      skillId: "dup",
      sourcePath: "skills/x",
      initiationSet: "t",
      createdBy: "tester",
    });
    writeSkillMd("skills/x", "dup");
    // 手动写同名 fallback(skillId="dup")
    const fbDir = join(tmpDir, "skill-imprints");
    mkdirSync(fbDir, { recursive: true });
    const fbName = `${computeImprintHash("dup", "")}.json`;
    writeFileSync(join(fbDir, fbName), JSON.stringify(readImprint("skills/x"), null, 2) + "\n");
    const r = doctor();
    expect(has(r.pending, "skill_duplicate_id")).toBe(true);
  });

  it("corrupt imprint.json(unparseable)→ pending", () => {
    const fbDir = join(tmpDir, "skill-imprints");
    mkdirSync(fbDir, { recursive: true });
    writeFileSync(
      join(fbDir, `${computeImprintHash("corrupt", "")}.json`),
      "{not valid json",
    );
    const r = doctor();
    expect(
      r.pending.some(
        (i) => i.kind === "skill_invalid_field_value" && i.message.includes("corrupt"),
      ),
    ).toBe(true);
  });

  // ── 综合 ───────────────────────────────────────────────────────────

  it("健康 skill(SKILL.md + imprint 一致 + 字段合法 + 引用有效)→ 无 fix 无 pending", () => {
    skillRepo.createSkill({
      skillId: "A",
      sourcePath: "skills/a",
      initiationSet: "t",
      createdBy: "tester",
    });
    writeSkillMd("skills/a", "A");
    const r = doctor();
    expect(r.fixes).toHaveLength(0);
    expect(r.pending).toHaveLength(0);
  });

  it("整体幂等:对已自愈的仓库再跑,fixes 不累积", () => {
    skillRepo.createSkill({
      skillId: "A",
      sourcePath: "skills/a",
      initiationSet: "old",
      createdBy: "tester",
      composes: ["B"] as any,
    });
    writeSkillMd("skills/a", "A");
    const imp = readImprint("skills/a");
    imp.utility = 1.5;
    writeImprintRaw("skills/a", imp);
    const r1 = doctor();
    expect(r1.fixes.length).toBeGreaterThan(0);
    const r2 = doctor();
    // 第二次:所有自动修已完成,无新 fix
    expect(r2.fixes).toHaveLength(0);
  });
});

describe("engram_doctor 端到端(工具层集成 runSkillDoctor)", () => {
  // 验证 engramDoctorTool.execute 的完整链路(runInfraDoctor → runDoctor → cleanup → runSkillDoctor)
  // 把 skill 的 fixes/pending 真的合并进工具返回的 issues —— 单测只覆盖 runSkillDoctor 纯函数,
  // 这里覆盖"接线":skill 检查结果经 engram_doctor 工具暴露给调用方。
  it("engram_doctor 返回的 issues 含 skill 检查结果(orphan 报告 + compose 自动修 + 幂等)", () => {
    // orphan SKILL.md(合法 frontmatter 但无 imprint)
    writeSkillMd("skills/orphan", "orphan-skill");
    // skill with dangling compose(B 不存在)
    skillRepo.createSkill({
      skillId: "A",
      sourcePath: "skills/a",
      initiationSet: "t",
      createdBy: "tester",
      composes: ["B"] as any,
    });
    writeSkillMd("skills/a", "A");

    const repo = new EngramRepository({ rootPath: tmpDir });
    const ctx = { repository: repo };
    const result = engramDoctorTool.execute({ incremental: false }, ctx as any);

    // skill_orphan_skillmd 进 issues(pending)
    expect(result.issues.some((i) => i.kind === "skill_orphan_skillmd")).toBe(true);
    // skill_compose_dangling 进 issues 且 autoFixed=true(runSkillDoctor 自动移除)
    expect(
      result.issues.some((i) => i.kind === "skill_compose_dangling" && i.autoFixed),
    ).toBe(true);
    // autoFixesApplied 计数包含 skill 的自动修
    expect(result.autoFixesApplied).toBeGreaterThan(0);

    // 幂等:再跑一次,compose 已修,不再报
    const result2 = engramDoctorTool.execute({ incremental: false }, ctx as any);
    expect(result2.issues.some((i) => i.kind === "skill_compose_dangling")).toBe(false);
  });
});
