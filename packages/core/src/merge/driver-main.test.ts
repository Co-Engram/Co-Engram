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
import { stringify } from "yaml";
import { runDriver } from "./driver-main.js";
import { computeSynapseId } from "../types/synapse-id.js";
import type { EngramId, Synapse } from "../types/synapse.js";

function engramRaw(overrides: Record<string, unknown>, body: string): string {
  const baseFm = {
    id: "01HXXX",
    title: "base",
    kind: "observation",
    createdBy: "user-a",
    createdAt: "2026-01-01T00:00:00Z",
    updatedBy: "user-a",
    updatedAt: "2026-01-01T00:00:00Z",
    version: 1,
    domainTags: ["AIOS"],
  };
  const fm = { ...baseFm, ...overrides };
  const yaml = Object.entries(fm)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  return `---\n${yaml}\n---\n\n${body}\n`;
}

describe("runDriver", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "driver-test-"));
    mkdirSync(join(dir, ".co-engram"), { recursive: true });
    mkdirSync(join(dir, "engrams", "AIOS"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns exit 0 and writes merged content for clean engram merge", async () => {
    const base = engramRaw({ retrievalCount: 5 }, "Body");
    const ours = engramRaw(
      { retrievalCount: 7, updatedAt: "2026-06-01T00:00:00Z" },
      "Body",
    );
    const theirs = engramRaw(
      { retrievalCount: 6, updatedAt: "2026-06-02T00:00:00Z" },
      "Body + addition",
    );

    const baseP = join(dir, "base.md");
    const oursP = join(dir, "engrams", "AIOS", "decision.md"); // acts as %A
    const theirsP = join(dir, "theirs.md");
    writeFileSync(baseP, base);
    writeFileSync(oursP, ours);
    writeFileSync(theirsP, theirs);

    const result = await runDriver([
      "node",
      "driver.js",
      baseP,
      oursP,
      theirsP,
      "7",
      oursP,
    ]);

    expect(result.exitCode).toBe(0);
    const written = readFileSync(oursP, "utf8");
    expect(written).toContain("Body + addition");
    expect(written).toMatch(/retrievalCount:\s*8/); // 5 + (7-5) + (6-5)
  });

  it("returns exit 1 and writes conflict markers when escalated", async () => {
    const base = engramRaw(
      { updatedAt: "2026-06-01T00:00:00Z", title: "base" },
      "Base body",
    );
    const ours = engramRaw(
      { updatedAt: "2026-06-01T00:00:00Z", title: "ours" },
      "Our body",
    );
    const theirs = engramRaw(
      { updatedAt: "2026-06-01T00:00:00Z", title: "theirs" },
      "Their body",
    );

    const baseP = join(dir, "base.md");
    const oursP = join(dir, "engrams", "AIOS", "decision.md");
    const theirsP = join(dir, "theirs.md");
    writeFileSync(baseP, base);
    writeFileSync(oursP, ours);
    writeFileSync(theirsP, theirs);

    const result = await runDriver([
      "node",
      "driver.js",
      baseP,
      oursP,
      theirsP,
      "7",
      oursP,
    ]);

    expect(result.exitCode).toBe(1);
    const written = readFileSync(oursP, "utf8");
    expect(written).toContain("<<<<<<< ours");
    expect(written).toContain(">>>>>>> theirs");
  });

  it("transparently falls back to git merge-file for non-engram .md files", async () => {
    const base = "# README\n\nLine 1\n\nLine 2\n";
    const ours = "# README\n\nLine 1 edited\n\nLine 2\n";
    const theirs = "# README\n\nLine 1\n\nLine 2\n\nLine 3\n";

    const baseP = join(dir, "README.base.md");
    const oursP = join(dir, "README.md");
    const theirsP = join(dir, "README.theirs.md");
    writeFileSync(baseP, base);
    writeFileSync(oursP, ours);
    writeFileSync(theirsP, theirs);

    const result = await runDriver([
      "node",
      "driver.js",
      baseP,
      oursP,
      theirsP,
      "7",
      oursP,
    ]);

    expect(result.exitCode).toBe(0);
    const written = readFileSync(oursP, "utf8");
    expect(written).toContain("Line 1 edited");
    expect(written).toContain("Line 3");
  });

  it("exits 1 when given wrong number of args", async () => {
    const result = await runDriver(["node", "driver.js", "only-one-arg"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/usage|expected|arguments/i);
  });

  it("exits 1 when base file is unparseable as engram but starts with frontmatter", async () => {
    const broken = "---\nbad: frontmatter\n---\n\nNo id or title\n";
    const valid = engramRaw({}, "Body");

    const baseP = join(dir, "base.md");
    const oursP = join(dir, "engrams", "AIOS", "decision.md");
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
      oursP,
    ]);

    expect(result.exitCode).toBe(1);
  });

  it("routes synapses/*.yaml through SynapseMerger (unions evidence)", async () => {
    const synId = computeSynapseId(
      "01HENG001" as EngramId,
      "01HENG002" as EngramId,
      "causes",
    );
    function synRaw(weight: number, updatedAt: string, evidence: unknown[]) {
      const s: Synapse = {
        id: synId,
        from: "01HENG001" as EngramId,
        to: "01HENG002" as EngramId,
        kind: "causes",
        weight,
        direction: "directional",
        evidence: evidence as Synapse["evidence"],
        createdBy: "alice",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt,
      };
      return stringify(s, { lineWidth: 0 });
    }
    const base = synRaw(0.5, "2026-06-01T00:00:00Z", []);
    const ours = synRaw(0.7, "2026-06-02T00:00:00Z", [
      { description: "ours reason", addedBy: "bob", addedAt: "2026-06-02" },
    ]);
    const theirs = synRaw(0.9, "2026-06-03T00:00:00Z", [
      {
        description: "theirs reason",
        addedBy: "carol",
        addedAt: "2026-06-03",
      },
    ]);

    const baseP = join(dir, "base.yaml");
    const oursP = join(dir, "synapses", "causes", `${synId}.yaml`);
    const theirsP = join(dir, "theirs.yaml");
    mkdirSync(join(dir, "synapses", "causes"), { recursive: true });
    writeFileSync(baseP, base);
    writeFileSync(oursP, ours);
    writeFileSync(theirsP, theirs);

    const result = await runDriver([
      "node",
      "driver.js",
      baseP,
      oursP,
      theirsP,
      "7",
      `synapses/causes/${synId}.yaml`,
    ]);

    expect(result.exitCode).toBe(0);
    const written = readFileSync(oursP, "utf8");
    expect(written).toContain("ours reason");
    expect(written).toContain("theirs reason");
    expect(written).toMatch(/weight:\s*0\.9/); // theirs newer updatedAt
  });
});
