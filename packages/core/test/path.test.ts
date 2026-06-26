import { describe, it, expect } from "vitest";
import {
  deriveEngramPath,
  deriveContentFilePath,
  deriveMetaFilePath,
  deriveSynapsesFilePath,
  deriveAllFilePaths,
  idFromRelativePath,
} from "../src/storage/path.js";

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
