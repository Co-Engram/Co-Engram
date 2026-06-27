#!/usr/bin/env node
/**
 * Git merge driver CLI entry.
 *
 * Git invokes: `node driver.js %O %A %B %L %P`
 *   %O = base (common ancestor)        argv[2]
 *   %A = ours (also the output target)  argv[3]
 *   %B = theirs                         argv[4]
 *   %L = conflict marker size           argv[5]
 *   %P = repo-relative path             argv[6]
 *
 * Routing:
 *   - isEngramFile(content) → mergeEngramFile
 *   - synapse path (starts with 'synapses/' + ends '.yaml') → mergeSynapseFile
 *   - everything else → transparent git merge-file fallback
 *
 * Behavior:
 *   - Escalation → write conflict markers + exit 1.
 *   - Any thrown error → write conflict markers + exit 1.
 *
 * @module @co-engram/core/merge
 */

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isEngramFile } from "../storage/engram-store.js";
import { mergeEngramFile } from "./merge-engram.js";
import { mergeSynapseFile, mergeSynapseFileAsync } from "./synapse-merger.js";
import { findDataRoot } from "./data-root.js";
import { AuditLog } from "../observability/audit-log.js";
import { DRIVER_BUNDLE_VERSION } from "./version.js";
import { LlmArbiter } from "./llm-arbiter.js";
import { createDriverLlmClient } from "./driver-llm.js";

// CJS-compatible "am I the main module" guard (works after esbuild bundle to cjs).
declare const require: { main?: { filename?: string } } | undefined;
declare const __filename: string | undefined;
const isMain =
  typeof require !== "undefined" &&
  require.main &&
  typeof __filename !== "undefined" &&
  require.main.filename === __filename;

const USAGE = "usage: co-engram-merge-driver %O %A %B %L %P";

/** Heuristic: synapse files live under synapses/ and have .yaml extension. */
function isSynapsePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  return normalized.startsWith("synapses/") && normalized.endsWith(".yaml");
}

export async function runDriver(argv: string[]): Promise<{
  exitCode: number;
  stderr?: string;
}> {
  const args = argv.slice(2);
  if (args.length < 5) {
    return { exitCode: 1, stderr: USAGE };
  }

  const [baseP, oursP, theirsP, markerSizeStr, pathArg] = args as [
    string,
    string,
    string,
    string,
    string,
  ];
  const markerSize = parseInt(markerSizeStr, 10) || 7;

  let baseRaw: string, oursRaw: string, theirsRaw: string;
  try {
    baseRaw = readFileSync(baseP, "utf8");
    oursRaw = readFileSync(oursP, "utf8");
    theirsRaw = readFileSync(theirsP, "utf8");
  } catch (e) {
    return {
      exitCode: 1,
      stderr: `co-engram-merge-driver: failed to read input files: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Route: engram vs synapse vs non-engram
  const isEngram =
    isEngramFile(oursRaw) || isEngramFile(baseRaw) || isEngramFile(theirsRaw);

  if (!isEngram && isSynapsePath(pathArg)) {
    return await runSynapseMerge({
      baseP,
      oursP,
      baseRaw,
      oursRaw,
      theirsRaw,
      pathArg,
    });
  }

  if (!isEngram) {
    // Transparent fallback: let git merge-file do its thing
    const result = spawnSync(
      "git",
      [
        "merge-file",
        "-p",
        `--marker-size=${markerSize}`,
        oursP,
        baseP,
        theirsP,
      ],
      { encoding: "utf8" },
    );
    if (typeof result.stdout === "string") {
      writeFileSync(oursP, result.stdout, "utf8");
    }
    // exit status: 0 = clean, >0 = conflict count, null = error
    return { exitCode: result.status ?? 1 };
  }

  // Engram merge
  let dataRoot: string | null = null;
  try {
    dataRoot = findDataRoot(oursP);
  } catch {
    dataRoot = null;
  }
  const auditLog = dataRoot ? new AuditLog(dataRoot) : undefined;

  // Construct LLM arbiter if config available (Layer B, spec §5.6)
  const llmBootstrap = createDriverLlmClient();
  const llmArbiter = llmBootstrap
    ? new LlmArbiter({
        client: llmBootstrap.client,
        auditLog,
        providerName: llmBootstrap.config.model,
      })
    : undefined;

  try {
    const result = await mergeEngramFile({
      baseRaw,
      oursRaw,
      theirsRaw,
      relPath: pathArg,
      dataRoot: dataRoot ?? undefined,
      auditLog,
      llmArbiter,
    });
    writeFileSync(oursP, result.mergedContent, "utf8");

    if (result.escalated) {
      auditLog?.append({
        actor: "system",
        action: "merge_conflict_escalated",
        metadata: {
          path: pathArg,
          reason: result.strategy,
        },
      });
      return { exitCode: 1 };
    }

    return { exitCode: 0 };
  } catch (e) {
    return handleDriverError(e, {
      oursP,
      oursRaw,
      theirsRaw,
      pathArg,
      auditLog,
    });
  }
}

async function runSynapseMerge(params: {
  baseP: string;
  oursP: string;
  baseRaw: string;
  oursRaw: string;
  theirsRaw: string;
  pathArg: string;
}): Promise<{ exitCode: number; stderr?: string }> {
  const { oursP, baseRaw, oursRaw, theirsRaw, pathArg } = params;
  let dataRoot: string | null = null;
  try {
    dataRoot = findDataRoot(params.baseP);
  } catch {
    dataRoot = null;
  }
  const auditLog = dataRoot ? new AuditLog(dataRoot) : undefined;

  // Construct LLM arbiter if config available (Layer B)
  const llmBootstrap = createDriverLlmClient();
  const llmArbiter = llmBootstrap
    ? new LlmArbiter({
        client: llmBootstrap.client,
        auditLog,
        providerName: llmBootstrap.config.model,
      })
    : undefined;

  try {
    const result = llmArbiter
      ? await mergeSynapseFileAsync({
          baseRaw,
          oursRaw,
          theirsRaw,
          arbiter: llmArbiter,
          path: pathArg,
        })
      : mergeSynapseFile({ baseRaw, oursRaw, theirsRaw });
    writeFileSync(oursP, result.mergedContent, "utf8");

    if (result.escalated) {
      auditLog?.append({
        actor: "system",
        action: "merge_conflict_escalated",
        metadata: { path: pathArg, reason: result.strategy },
      });
      return { exitCode: 1 };
    }

    auditLog?.append({
      actor: "system",
      action: "merge_resolved",
      metadata: {
        path: pathArg,
        reason: result.strategy,
      },
    });
    return { exitCode: 0 };
  } catch (e) {
    return handleDriverError(e, {
      oursP,
      oursRaw,
      theirsRaw,
      pathArg,
      auditLog,
    });
  }
}

function handleDriverError(
  e: unknown,
  params: {
    oursP: string;
    oursRaw: string;
    theirsRaw: string;
    pathArg: string;
    auditLog?: AuditLog;
  },
): { exitCode: number; stderr?: string } {
  const { oursP, oursRaw, theirsRaw, pathArg, auditLog } = params;
  const msg = e instanceof Error ? e.message : String(e);
  const wrapped = `<<<<<<< ours\n${oursRaw}\n=======\n${theirsRaw}\n>>>>>>> theirs\n`;
  writeFileSync(oursP, wrapped, "utf8");
  auditLog?.append({
    actor: "system",
    action: "merge_conflict_escalated",
    metadata: { path: pathArg, reason: `driver-error: ${msg}` },
  });
  return { exitCode: 1, stderr: `co-engram-merge-driver: ${msg}` };
}

// Entry point (CJS-compatible after esbuild bundle).
if (isMain) {
  runDriver(process.argv).then(({ exitCode }) => {
    process.exitCode = exitCode;
  });
}

// Re-export for introspection by the bundle
export { DRIVER_BUNDLE_VERSION };
