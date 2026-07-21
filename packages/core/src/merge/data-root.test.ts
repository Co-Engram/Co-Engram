import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDataRoot } from "./data-root.js";

describe("findDataRoot", () => {
  it("finds the dir containing .co-engram/ when walking up", () => {
    const root = mkdtempSync(join(tmpdir(), "data-root-"));
    mkdirSync(join(root, ".co-engram"), { recursive: true });
    mkdirSync(join(root, "engrams", "AIOS"), { recursive: true });

    const result = findDataRoot(join(root, "engrams", "AIOS", "decision.md"));
    expect(result).toBe(root);
  });

  it("returns null when no .co-engram/ found", () => {
    const root = mkdtempSync(join(tmpdir(), "no-marker-"));
    mkdirSync(join(root, "sub"), { recursive: true });
    expect(findDataRoot(join(root, "sub", "file.md"))).toBeNull();
  });

  it("returns null at filesystem root", () => {
    expect(findDataRoot("/")).toBeNull();
  });

  it("handles file path that does not exist yet (git stage)", () => {
    const root = mkdtempSync(join(tmpdir(), "data-root-staging-"));
    mkdirSync(join(root, ".co-engram"), { recursive: true });
    mkdirSync(join(root, "engrams"), { recursive: true });
    // %A path may not exist when driver is invoked first time; pass a non-existent file
    const result = findDataRoot(join(root, "engrams", "does-not-exist.md"));
    expect(result).toBe(root);
  });

  it("skips a .co-engram/ whose config.json.dataRoot points elsewhere (bootstrap 配置)", () => {
    // 复现 bug:~/.co-engram/(bootstrap,dataRoot → 他处)其下的普通仓库 git pull 时,
    // findDataRoot 不应把 HOME 当 dataRoot,应返回 null(避免误触发 doctor 在 HOME 上跑)。
    const home = mkdtempSync(join(tmpdir(), "bootstrap-home-"));
    mkdirSync(join(home, ".co-engram"), { recursive: true });
    writeFileSync(
      join(home, ".co-engram", "config.json"),
      JSON.stringify({ version: 1, dataRoot: "/some/other/team-memory" }),
    );
    mkdirSync(join(home, "some-repo"), { recursive: true });
    expect(findDataRoot(join(home, "some-repo", "file.md"))).toBeNull();
  });

  it("returns real dataRoot whose config.json has no dataRoot field", () => {
    // 真 dataRoot 的 config.json 无 dataRoot 字段(或指自己)→ 正常返回。
    const root = mkdtempSync(join(tmpdir(), "real-dataroot-"));
    mkdirSync(join(root, ".co-engram"), { recursive: true });
    writeFileSync(
      join(root, ".co-engram", "config.json"),
      JSON.stringify({ version: 1, language: "zh" }),
    );
    mkdirSync(join(root, "engrams"), { recursive: true });
    expect(findDataRoot(join(root, "engrams", "x.md"))).toBe(root);
  });
});
