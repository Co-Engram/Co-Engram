import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

vi.mock("@co-engram/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@co-engram/core")>();
  return { ...actual, detectGitAuthor: vi.fn() };
});

const { detectGitAuthor } = await import("@co-engram/core");
const mockDetectGitAuthor = vi.mocked(detectGitAuthor);

import { resolveDefaultCreatedBy } from "../src/mcp-server.js";

// ============================================================
// resolveDefaultCreatedBy
// ============================================================

describe("resolveDefaultCreatedBy", () => {
  beforeEach(() => {
    mockDetectGitAuthor.mockReset();
  });
  afterEach(() => {
    delete process.env.CO_ENGRAM_DEFAULT_CREATED_BY;
  });

  it("git 可用时,优先于 env 和 config(git 主导)", () => {
    mockDetectGitAuthor.mockReturnValue("git-user");
    process.env.CO_ENGRAM_DEFAULT_CREATED_BY = "env-user";
    const r = resolveDefaultCreatedBy({ defaultCreatedBy: "config-user" });
    expect(r).toBe("git-user");
    expect(mockDetectGitAuthor).toHaveBeenCalledTimes(1);
  });

  it("git 可用 + env/config 均未设 → 返回 git 作者", () => {
    mockDetectGitAuthor.mockReturnValue("git-user");
    delete process.env.CO_ENGRAM_DEFAULT_CREATED_BY;
    const r = resolveDefaultCreatedBy(undefined);
    expect(r).toBe("git-user");
  });

  it("git 不可用 + config 设 → 回退到 config", () => {
    mockDetectGitAuthor.mockReturnValue(undefined);
    delete process.env.CO_ENGRAM_DEFAULT_CREATED_BY;
    const r = resolveDefaultCreatedBy({ defaultCreatedBy: "config-user" });
    expect(r).toBe("config-user");
  });

  it("git 不可用 + config 空白 → 跳过 config 到 env", () => {
    mockDetectGitAuthor.mockReturnValue(undefined);
    process.env.CO_ENGRAM_DEFAULT_CREATED_BY = "env-user";
    const r = resolveDefaultCreatedBy({ defaultCreatedBy: "   " });
    expect(r).toBe("env-user");
  });

  it("git 不可用 + config 未设 + env 设 → 回退到 env", () => {
    mockDetectGitAuthor.mockReturnValue(undefined);
    process.env.CO_ENGRAM_DEFAULT_CREATED_BY = "env-user";
    const r = resolveDefaultCreatedBy(undefined);
    expect(r).toBe("env-user");
  });

  it("git 不可用 + env 是空白 → 视为未设", () => {
    mockDetectGitAuthor.mockReturnValue(undefined);
    process.env.CO_ENGRAM_DEFAULT_CREATED_BY = "   ";
    const r = resolveDefaultCreatedBy(undefined);
    expect(r).toBeUndefined();
  });

  it("三者皆空 → undefined(由调用方继续回退到 unknown)", () => {
    mockDetectGitAuthor.mockReturnValue(undefined);
    delete process.env.CO_ENGRAM_DEFAULT_CREATED_BY;
    const r = resolveDefaultCreatedBy(undefined);
    expect(r).toBeUndefined();
  });
});
