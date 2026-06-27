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
});
