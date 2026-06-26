/**
 * Co-Engram programmatic core usage example.
 *
 * Demonstrates: create an engram, read it back, reinforce it.
 *
 * No MCP, no plugin — just @co-engram/core.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  EngramRepository,
  engramCreateTool,
  engramGetTool,
  engramReinforceTool,
  rebuildSearchIndex,
  SearchOrchestrator,
  type ToolContext,
} from "@co-engram/core";

const dataRoot = process.env.DATA_ROOT;
if (!dataRoot) {
  console.error("Set DATA_ROOT env var to an absolute path.");
  process.exit(1);
}

mkdirSync(dataRoot, { recursive: true });

const repository = new EngramRepository({ rootPath: dataRoot });
const searchOrchestrator = new SearchOrchestrator();
rebuildSearchIndex(searchOrchestrator, repository);

const ctx: ToolContext = { repository, searchOrchestrator };

async function main() {
  // 1. Create an engram
  const created = await engramCreateTool.execute(
    {
      title: "TypeScript strict mode readonly gotcha",
      content:
        "In TS strict mode, readonly fields cannot be directly assigned. Use Object.assign({}, ...parts) to merge.",
      kind: "pattern",
      domainTags: ["typescript", "strict-mode"],
      createdBy: "example-script",
    },
    ctx,
  );
  console.log("Created engram:", created.id, "status:", created.status);

  // 2. Read it back (digest tier by default)
  const view = await engramGetTool.execute(
    { id: created.id, tier: "content" },
    ctx,
  );
  console.log("Retrieved:", view.title);

  // 3. Reinforce it (LTP)
  const reinforced = await engramReinforceTool.execute(
    { id: created.id, effectiveness: 0.9 },
    ctx,
  );
  console.log(
    "Reinforced. effectiveRetrievals:",
    reinforced.retrievalStats.effectiveRetrievals,
    "reinforcementScore:",
    reinforced.retrievalStats.reinforcementScore.toFixed(2),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
