import { describe, it, expect } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ProposalEngine } from "../src/observability/proposal-engine.js";
import { EngramRepository } from "../src/storage/repository.js";
import { AuditLog } from "../src/observability/audit-log.js";

function setup(): { engine: ProposalEngine; repo: EngramRepository; dir: string } {
  const dir = join(process.cwd(), ".tmp-rem-synapse-test");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const repo = new EngramRepository({ rootPath: dir, language: "zh" });
  const auditLog = new AuditLog(dir);
  const engine = new ProposalEngine({
    repository: repo,
    embedder: async () => [1, 0, 0],
    auditLog,
    dataRoot: dir,
  });
  return { engine, repo, dir };
}

describe("rem-synapse ProposalSource", () => {
  it("ProposalSource 联合类型包含 rem-synapse", () => {
    const src: import("../src/observability/proposal-engine.js").ProposalSource =
      "rem-synapse";
    expect(src).toBe("rem-synapse");
  });
});
