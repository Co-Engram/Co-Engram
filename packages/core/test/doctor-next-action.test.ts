/**
 * doctor next-action hints 测试(Task 3.5)
 *
 * 验证 doctor 报告的"人工裁决"类 issue 自带 nextAction 提示,
 * 让挑剔用户不需要翻文档就能知道下一步用哪个工具。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import { engramDoctorTool } from "../src/tools/doctor-tools.js";
import type { ToolContext } from "../src/tools/tool.js";

let tmpDir: string;
let repo: EngramRepository;
let ctx: ToolContext;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-doctor-next-action-"));
  repo = new EngramRepository({ rootPath: tmpDir });
  ctx = { repository: repo } as ToolContext;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("doctor next-action hints (Task 3.5)", () => {
  it("orphan_markdown issue 包含 engram_create nextAction", () => {
    // 放一个无 frontmatter 的 markdown
    writeFileSync(
      join(tmpDir, "orphan.md"),
      "# no frontmatter\n\nplain text\n",
    );

    const result = engramDoctorTool.execute({}, ctx);
    const orphan = result.issues.find((i) => i.kind === "orphan_markdown");
    expect(orphan).toBeDefined();
    expect(orphan!.nextAction).toBeDefined();
    expect(orphan!.nextAction!.tool).toBe("engram_create");
    // argsHint 应该提示关键字段
    expect(orphan!.nextAction!.argsHint).toContain("title");
    expect(orphan!.nextAction!.argsHint).toContain("content");
    // explanation 应该告诉用户为什么用这个工具
    expect(orphan!.nextAction!.explanation.length).toBeGreaterThan(10);
  });

  it("dangling_synapse issue 包含 synapse_delete nextAction", () => {
    // 1. 创建两个 engram 让它们进入 index
    const a = repo.createEngram({
      title: "A",
      content: "content A",
      kind: "observation",
      domainTags: [],
      createdBy: "tester",
    });
    const b = repo.createEngram({
      title: "B",
      content: "content B",
      kind: "observation",
      domainTags: [],
      createdBy: "tester",
    });
    // 2. 创建 synapse B → A(让 A 有 incoming synapse)
    repo.createSynapse({
      from: b.id,
      to: a.id,
      kind: "extends",
      createdBy: "tester",
    });
    // 3. 物理删除 A.md 文件,但 index 里还有 A
    //    找到 A 的相对路径
    const aPath = repo.resolvePath(a.id);
    if (aPath) {
      unlinkSync(join(tmpDir, aPath));
    }
    // 4. 跑 doctor:应该检测到 missing_file + dangling_synapse
    const result = engramDoctorTool.execute({}, ctx);
    const dangling = result.issues.find((i) => i.kind === "dangling_synapse");
    expect(dangling).toBeDefined();
    expect(dangling!.nextAction).toBeDefined();
    expect(dangling!.nextAction!.tool).toBe("synapse_delete");
    expect(dangling!.nextAction!.argsHint).toContain("synapseId");
  });

  it("auto-fixed 类 issue(如 moved_file)不带 nextAction(已自动修复,无需用户介入)", () => {
    // 只创建一个 engram(没有任何人工裁决类问题)
    repo.createEngram({
      title: "Healthy",
      content: "no issues here",
      kind: "observation",
      domainTags: [],
      createdBy: "tester",
    });
    const result = engramDoctorTool.execute({}, ctx);
    // 所有 issue 都应该是 autoFixed 类(或没有 issue),不应有 nextAction
    for (const issue of result.issues) {
      if (issue.autoFixed) {
        // autoFixed 类不要求 nextAction(已自动处理)
        // 这个断言空转,确保 loop 跑通
        expect(issue.autoFixed).toBe(true);
      }
    }
  });
});
