import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDriver } from "./driver-main.js";

function engramRaw(): string {
  return `---
id: "01HXXX"
title: "base"
kind: "observation"
createdBy: "user-a"
createdAt: "2026-01-01T00:00:00Z"
updatedBy: "user-a"
updatedAt: "2026-01-01T00:00:00Z"
version: 1
domainTags: ["AIOS"]
---

Body.
`;
}

describe("driver failure modes (spec §10.1)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "driver-fail-"));
    mkdirSync(join(dir, "engrams"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 1 with usage message when no args", async () => {
    const result = await runDriver(["node", "driver.js"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/usage/i);
  });

  it("exits 1 when input file does not exist", async () => {
    const result = await runDriver([
      "node",
      "driver.js",
      join(dir, "nonexistent-base.md"),
      join(dir, "ours.md"),
      join(dir, "theirs.md"),
      "7",
      "ours.md",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/failed to read input files|ENOENT/i);
  });

  it("exits 1 with conflict markers when engram parse fails on base", async () => {
    const broken = "---\nno id or title\n---\n\nbroken\n";
    const valid = engramRaw();

    const baseP = join(dir, "base.md");
    const oursP = join(dir, "engrams", "decision.md");
    const theirsP = join(dir, "theirs.md");
    writeFileSync(baseP, broken);
    writeFileSync(oursP, valid);
    writeFileSync(theirsP, valid);

    const result = await runDriver([
      "node",
      "driver.js",
      baseP,
      oursP,
      theirsP,
      "7",
      "ours.md",
    ]);
    expect(result.exitCode).toBe(1);

    // %A should contain conflict markers (so user sees the conflict)
    const written = readFileSync(oursP, "utf8");
    expect(written).toContain("<<<<<<< ours");
    expect(written).toContain(">>>>>>> theirs");
  });

  it("exits 1 with conflict markers when ours is corrupted", async () => {
    const valid = engramRaw();
    const broken = "---\nbroken: true\n---\n\nno engram fields\n";

    const baseP = join(dir, "base.md");
    const oursP = join(dir, "engrams", "decision.md");
    const theirsP = join(dir, "theirs.md");
    writeFileSync(baseP, valid);
    writeFileSync(oursP, broken);
    writeFileSync(theirsP, valid);

    const result = await runDriver([
      "node",
      "driver.js",
      baseP,
      oursP,
      theirsP,
      "7",
      "ours.md",
    ]);
    expect(result.exitCode).toBe(1);

    const written = readFileSync(oursP, "utf8");
    expect(written).toContain("<<<<<<<");
  });

  it("transparently handles non-engram markdown via git fallback", async () => {
    // Use non-overlapping edits so git produces a clean merge.
    const baseP = join(dir, "README.base.md");
    const oursP = join(dir, "README.md");
    const theirsP = join(dir, "README.theirs.md");
    writeFileSync(baseP, "# Title\n\nSection A\n\nSection B\n");
    writeFileSync(oursP, "# Title\n\nSection A edited\n\nSection B\n");
    writeFileSync(theirsP, "# Title\n\nSection A\n\nSection B\n\nSection C\n");

    const result = await runDriver([
      "node",
      "driver.js",
      baseP,
      oursP,
      theirsP,
      "7",
      "README.md",
    ]);
    expect(result.exitCode).toBe(0);

    const written = readFileSync(oursP, "utf8");
    expect(written).toContain("Section A edited");
    expect(written).toContain("Section C");
    expect(written).not.toContain("<<<<<");
  });
});
