import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import type { Engram } from "../src/types/engram.js";

/**
 * Task 2a:repository.updateEngram 集成 visibility 单向闸门。
 *
 * 这层守卫是 core 的防御性契约:不管哪个宿主(MCP / OpenClaw plugin /
 * viewer)调用 updateEngram,都不得把非-private 记忆降级为 private。
 * private 路径进 .gitignore,降级会隐性删除其他成员工作树中的该记忆。
 */
describe("repository.updateEngram visibility gate", () => {
  let tmpDir: string;
  let repo: EngramRepository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "co-engram-vis-gate-"));
    repo = new EngramRepository({ rootPath: tmpDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  let engramCounter = 0;
  function makeEngram(
    overrides: Partial<Parameters<EngramRepository["createEngram"]>[0]> = {},
  ): Engram {
    engramCounter += 1;
    return repo.createEngram({
      title: `T-${engramCounter}`,
      content: "C",
      kind: "fact",
      domainTags: [`dev-${engramCounter}`],
      createdBy: "tester",
      ...overrides,
    });
  }

  it("forbids updating public engram to private", () => {
    const created = makeEngram({ visibility: "public" });
    expect(() =>
      repo.updateEngram(created.id, {
        visibility: "private",
        updatedBy: "tester",
      }),
    ).toThrow(/private.*not allowed/);
  });

  it("forbids updating team engram to private", () => {
    const created = makeEngram({ visibility: "team" });
    expect(() =>
      repo.updateEngram(created.id, {
        visibility: "private",
        updatedBy: "tester",
      }),
    ).toThrow(/private.*not allowed/);
  });

  it("forbids updating restricted engram to private", () => {
    const created = makeEngram({ visibility: "restricted" });
    expect(() =>
      repo.updateEngram(created.id, {
        visibility: "private",
        updatedBy: "tester",
      }),
    ).toThrow(/private.*not allowed/);
  });

  it("allows updating private engram to public (one-way open)", () => {
    const created = makeEngram({ visibility: "private" });
    const updated = repo.updateEngram(created.id, {
      visibility: "public",
      updatedBy: "tester",
    });
    expect(updated.visibility).toBe("public");
  });

  it("allows public → team (reversible)", () => {
    const created = makeEngram({ visibility: "public" });
    const updated = repo.updateEngram(created.id, {
      visibility: "team",
      updatedBy: "tester",
    });
    expect(updated.visibility).toBe("team");
  });

  it("allows team → public (reversible)", () => {
    const created = makeEngram({ visibility: "team" });
    const updated = repo.updateEngram(created.id, {
      visibility: "public",
      updatedBy: "tester",
    });
    expect(updated.visibility).toBe("public");
  });

  it("does not throw when visibility is unchanged (no-op)", () => {
    const created = makeEngram({ visibility: "public" });
    const updated = repo.updateEngram(created.id, {
      visibility: "public",
      updatedBy: "tester",
    });
    expect(updated.visibility).toBe("public");
  });

  it("does not throw when visibility is not in input", () => {
    const created = makeEngram({ visibility: "public" });
    const updated = repo.updateEngram(created.id, {
      title: "New Title",
      updatedBy: "tester",
    });
    expect(updated.visibility).toBe("public");
    expect(updated.title).toBe("New Title");
  });

  it("forbids chain: public → team → private (gate fires on second step)", () => {
    const created = makeEngram({ visibility: "public" });
    const intermediate = repo.updateEngram(created.id, {
      visibility: "team",
      updatedBy: "tester",
    });
    expect(intermediate.visibility).toBe("team");
    expect(() =>
      repo.updateEngram(created.id, {
        visibility: "private",
        updatedBy: "tester",
      }),
    ).toThrow(/private.*not allowed/);
  });

  it("on forbidden transition, file is not modified", () => {
    const created = makeEngram({ visibility: "public" });
    expect(() =>
      repo.updateEngram(created.id, {
        visibility: "private",
        updatedBy: "tester",
      }),
    ).toThrow();

    // 重新读取,visibility 仍是 public(守卫违规不应留下副作用)
    const after = repo.readEngram(created.id);
    expect(after.visibility).toBe("public");
  });
});
