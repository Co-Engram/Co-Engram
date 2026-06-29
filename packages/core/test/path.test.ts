import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveEngramPath,
  deriveContentFilePath,
  deriveMetaFilePath,
  deriveSynapsesFilePath,
  deriveAllFilePaths,
  idFromRelativePath,
  safeJoinWithinRoot,
  isPathWithinRoot,
} from "../src/storage/path.js";
import { EngramRepository } from "../src/storage/repository.js";

describe("deriveEngramPath", () => {
  it("从 domainTags + title 推导路径", () => {
    const path = deriveEngramPath({
      title: "Android 14 无线 ADB",
      domainTags: ["testing", "adb", "android"],
    });
    expect(path).toBe("testing/adb/android/android-14-无线-adb");
  });

  it("限制最多 3 层 domainTags", () => {
    const path = deriveEngramPath({
      title: "某知识",
      domainTags: ["a", "b", "c", "d", "e"],
    });
    expect(path).toBe("a/b/c/某知识");
  });

  it("domainTags 为空时只有 slug", () => {
    const path = deriveEngramPath({
      title: "独立知识",
      domainTags: [],
    });
    expect(path).toBe("独立知识");
  });

  it("title 为空时返回 untitled", () => {
    const path = deriveEngramPath({
      title: "",
      domainTags: ["a"],
    });
    expect(path).toBe("a/untitled");
  });
});

describe("文件路径推导", () => {
  it("content 路径", () => {
    expect(deriveContentFilePath("testing/adb/x")).toBe(
      "engrams/content/testing/adb/x.md",
    );
  });

  it("meta 路径", () => {
    expect(deriveMetaFilePath("testing/adb/x")).toBe(
      "engrams/meta/testing/adb/x.yaml",
    );
  });

  it("synapses 路径", () => {
    expect(deriveSynapsesFilePath("testing/adb/x")).toBe(
      "engrams/synapses/testing/adb/x.yaml",
    );
  });

  it("deriveAllFilePaths 返回三个路径", () => {
    const paths = deriveAllFilePaths("a/b");
    expect(paths.content).toBe("engrams/content/a/b.md");
    expect(paths.meta).toBe("engrams/meta/a/b.yaml");
    expect(paths.synapses).toBe("engrams/synapses/a/b.yaml");
  });

  it("idFromRelativePath 直接返回原值", () => {
    expect(idFromRelativePath("a/b/c")).toBe("a/b/c");
  });
});

// ============================================================
// safeJoinWithinRoot / isPathWithinRoot (path traversal 防御)
// ============================================================

describe("safeJoinWithinRoot — path traversal 防御", () => {
  it("合法相对路径返回绝对路径", () => {
    const tmp = mkdtempSync(join(tmpdir(), "co-engram-path-trav-"));
    try {
      const abs = safeJoinWithinRoot(tmp, "engrams/content/test.md");
      expect(abs).toBe(join(tmp, "engrams/content/test.md"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("拒绝 `..` 逃逸", () => {
    const tmp = mkdtempSync(join(tmpdir(), "co-engram-path-trav-"));
    try {
      expect(() => safeJoinWithinRoot(tmp, "../etc/passwd")).toThrow(/escapes root/);
      expect(() => safeJoinWithinRoot(tmp, "engrams/../../etc/passwd")).toThrow(/escapes root/);
      expect(() => safeJoinWithinRoot(tmp, "a/../../b")).toThrow(/escapes root/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("拒绝绝对路径", () => {
    const tmp = mkdtempSync(join(tmpdir(), "co-engram-path-trav-"));
    try {
      expect(() => safeJoinWithinRoot(tmp, "/etc/passwd")).toThrow(/absolute path/);
      expect(() => safeJoinWithinRoot(tmp, "C:\\Windows\\system32")).toThrow(/absolute path/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("拒绝 NUL 字节(防止截断攻击)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "co-engram-path-trav-"));
    try {
      expect(() => safeJoinWithinRoot(tmp, "safe.md\0.evil")).toThrow(/NUL/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("拒绝空路径", () => {
    const tmp = mkdtempSync(join(tmpdir(), "co-engram-path-trav-"));
    try {
      expect(() => safeJoinWithinRoot(tmp, "")).toThrow(/empty/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("isPathWithinRoot 不抛错,返回 boolean", () => {
    const tmp = mkdtempSync(join(tmpdir(), "co-engram-path-trav-"));
    try {
      expect(isPathWithinRoot(tmp, "a/b.md")).toBe(true);
      expect(isPathWithinRoot(tmp, "../etc/passwd")).toBe(false);
      expect(isPathWithinRoot(tmp, "/etc/passwd")).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("EngramRepository — path traversal 端到端防御 (.. / 绝对路径)", () => {
  it("createEngram 拒绝 pathHint 逃逸", () => {
    const tmp = mkdtempSync(join(tmpdir(), "co-engram-path-trav-"));
    try {
      const repo = new EngramRepository({ rootPath: tmp });
      expect(() =>
        repo.createEngram({
          title: "evil",
          content: "x",
          kind: "fact",
          domainTags: [],
          createdBy: "attacker",
          pathHint: "../../../etc/co-engram-evil-marker",
        }),
      ).toThrow(/escapes root|absolute path/);
      // 标记文件不应被创建(若 pathHint 逃逸成功,会在 tmp 之外创建文件)
      expect(existsSync(join(tmp, "..", "..", "..", "etc", "co-engram-evil-marker"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("createEngram 拒绝 domainTag 含 `..`", () => {
    const tmp = mkdtempSync(join(tmpdir(), "co-engram-path-trav-"));
    try {
      const repo = new EngramRepository({ rootPath: tmp });
      expect(() =>
        repo.createEngram({
          title: "evil",
          content: "x",
          kind: "fact",
          domainTags: [".."],
          createdBy: "attacker",
        }),
      ).toThrow(/escapes root/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("readEngram 拒绝 stableId=`../../etc/passwd`", () => {
    const tmp = mkdtempSync(join(tmpdir(), "co-engram-path-trav-"));
    try {
      // 先在 tmp 外写一个"敏感"文件
      const outside = join(tmp, "..", "outside-secret.md");
      writeFileSync(outside, "secret");
      try {
        const repo = new EngramRepository({ rootPath: tmp });
        expect(() => repo.readEngram("../outside-secret.md")).toThrow(/not found|escapes root/);
        // 即便 exists() 也不应返回 true
        expect(repo.exists("../outside-secret.md")).toBe(false);
      } finally {
        rmSync(outside, { force: true });
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
