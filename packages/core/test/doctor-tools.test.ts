import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import {
  engramDoctorTool,
  engramListPathsTool,
} from "../src/tools/doctor-tools.js";
import type { ToolContext } from "../src/tools/tool.js";

let tmpDir: string;
let repo: EngramRepository;
let ctx: ToolContext;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-doctor-tools-"));
  repo = new EngramRepository({ rootPath: tmpDir });
  ctx = { repository: repo } as ToolContext;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("engram_doctor tool", () => {
  it("空仓库返回空 report", () => {
    const result = engramDoctorTool.execute({}, ctx);
    expect(result.totalEngrams).toBe(0);
    expect(result.totalSynapses).toBe(0);
    expect(result.autoFixesApplied).toBe(0);
    expect(result.issues).toEqual([]);
  });

  it("检测已存在 engram", () => {
    repo.createEngram({
      title: "A",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "a",
    });
    const result = engramDoctorTool.execute({}, ctx);
    expect(result.totalEngrams).toBe(1);
  });

  it("incremental 参数生效", () => {
    repo.createEngram({
      title: "X",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "a",
    });
    const result = engramDoctorTool.execute({ incremental: true }, ctx);
    expect(result.totalEngrams).toBe(1);
  });

  it("无 repository 抛错", () => {
    const badCtx = {} as ToolContext;
    expect(() => engramDoctorTool.execute({}, badCtx)).toThrow(
      /engram_doctor requires a Repository/,
    );
  });
});

describe("engram_list_paths tool", () => {
  it("空仓库返回空 root", () => {
    const result = engramListPathsTool.execute({}, ctx);
    expect(result.root.engramCount).toBe(0);
    expect(result.root.children).toEqual([]);
  });

  it("列出目录树", () => {
    repo.createEngram({
      title: "A",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "a",
      pathHint: "foo/a.md",
    });
    repo.createEngram({
      title: "B",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "a",
      pathHint: "foo/bar/b.md",
    });
    repo.createEngram({
      title: "C",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "a",
      pathHint: "baz/c.md",
    });
    const result = engramListPathsTool.execute({}, ctx);
    expect(result.root.engramCount).toBe(3);
    const topDirs = result.root.children.map((c) => c.path).sort();
    expect(topDirs).toEqual(["baz", "foo"]);
  });

  it("maxDepth 限制深度", () => {
    repo.createEngram({
      title: "X",
      content: "x",
      kind: "observation",
      domainTags: [],
      createdBy: "a",
      pathHint: "a/b/c/d/e/x.md",
    });
    const result = engramListPathsTool.execute({ maxDepth: 2 }, ctx);
    expect(result.root.children.length).toBe(1);
    expect(result.root.children[0]!.path).toBe("a");
    expect(result.root.children[0]!.children.length).toBe(0);
  });

  it("无 repository 抛错", () => {
    const badCtx = {} as ToolContext;
    expect(() => engramListPathsTool.execute({}, badCtx)).toThrow(
      /engram_list_paths requires a Repository/,
    );
  });
});

describe("repository-health tools 元信息", () => {
  it("engram_doctor 有正确 name + description", () => {
    expect(engramDoctorTool.name).toBe("engram_doctor");
    expect(engramDoctorTool.description.length).toBeGreaterThan(10);
  });

  it("engram_list_paths 有正确 name + description", () => {
    expect(engramListPathsTool.name).toBe("engram_list_paths");
    expect(engramListPathsTool.description.length).toBeGreaterThan(10);
  });

  it("两个工具都有 inputSchema", () => {
    expect(engramDoctorTool.inputSchema).toBeDefined();
    expect(engramListPathsTool.inputSchema).toBeDefined();
  });
});

describe("repository-health tools 错误消息使用英文(international-friendly)", () => {
  it("engram_doctor 无 repository 时抛英文错误", () => {
    const badCtx = {} as ToolContext;
    expect(() => engramDoctorTool.execute({}, badCtx)).toThrow(
      /engram_doctor requires a Repository/,
    );
  });

  it("engram_list_paths 无 repository 时抛英文错误", () => {
    const badCtx = {} as ToolContext;
    expect(() => engramListPathsTool.execute({}, badCtx)).toThrow(
      /engram_list_paths requires a Repository/,
    );
  });
});

describe("engram_doctor 报告消息使用英文", () => {
  it("orphan_markdown issue 的 message 是英文", () => {
    writeFileSync(
      join(tmpDir, "orphan.md"),
      "# no frontmatter\n\nplain text\n",
    );
    const result = engramDoctorTool.execute({}, ctx);
    const orphan = result.issues.find((i) => i.kind === "orphan_markdown");
    expect(orphan).toBeDefined();
    expect(orphan!.message).toMatch(/without frontmatter|Markdown/i);
    expect(orphan!.message).not.toMatch(/无 frontmatter/);
  });
});
