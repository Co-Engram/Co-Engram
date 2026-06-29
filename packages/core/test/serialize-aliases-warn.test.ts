/**
 * serializeEngramFile aliases warn 测试(Task 5.4)
 *
 * 验证:frontmatter 含非空 aliases 字段时,serializeEngramFile 会 warn
 * (而非静默剥离)。让用户知道手动加的 aliases 字段会被丢弃。
 */
import { describe, it, expect, vi } from "vitest";
import { serializeEngramFile } from "../src/storage/engram-store.js";
import type { EngramFile } from "../src/storage/engram-store.js";
import type { EngramFrontmatter } from "../src/types/engram.js";

function makeFile(overrides: Partial<EngramFrontmatter> = {}): EngramFile {
  return {
    frontmatter: {
      id: "E1",
      title: "test",
      slug: "test",
      slugLocked: false,
      kind: "observation",
      importance: 0.5,
      confidence: 0.5,
      sourceType: "manual",
      createdBy: "tester",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      version: 1,
      ...overrides,
    } as EngramFrontmatter,
    content: "hello world",
  };
}

describe("serializeEngramFile aliases warn (Task 5.4)", () => {
  it("warns when aliases field is non-empty", () => {
    const warns: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((m) => {
      warns.push(typeof m === "string" ? m : String(m));
    });
    try {
      const file = makeFile({
        // @ts-expect-error testing legacy field
        aliases: ["old-slug", "another-name"],
      });
      serializeEngramFile(file);
      expect(warns.some((w) => /aliases/i.test(w))).toBe(true);
      expect(warns.some((w) => /E1/.test(w))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not warn when aliases field is absent", () => {
    const warns: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((m) => {
      warns.push(typeof m === "string" ? m : String(m));
    });
    try {
      const file = makeFile();
      serializeEngramFile(file);
      expect(warns.some((w) => /aliases/i.test(w))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not warn when aliases field is empty array", () => {
    const warns: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((m) => {
      warns.push(typeof m === "string" ? m : String(m));
    });
    try {
      const file = makeFile({
        // @ts-expect-error testing legacy field
        aliases: [],
      });
      serializeEngramFile(file);
      expect(warns.some((w) => /aliases/i.test(w))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("serialised output strips aliases from frontmatter", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const file = makeFile({
        // @ts-expect-error testing legacy field
        aliases: ["old-slug"],
      });
      const output = serializeEngramFile(file);
      expect(output).not.toMatch(/aliases/);
    } finally {
      spy.mockRestore();
    }
  });
});
