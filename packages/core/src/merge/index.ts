/**
 * @module @co-engram/core/merge
 *
 * Public exports for the git merge driver subsystem.
 * Host packages (openclaw-plugin, claude-code-mcp) consume via this barrel
 * in Phase 2 when wiring auto-onboard.
 */

export * from "./version.js";
export * from "./backup.js";
export * from "./frontmatter-rules.js";
export * from "./arbitration.js";
export * from "./frontmatter.js";
export * from "./content.js";
export * from "./merge-engram.js";
export * from "./synapse-rules.js";
export * from "./evidence-union.js";
export * from "./resolution-state.js";
export * from "./synapse-merger.js";
export * from "./data-root.js";
export * from "./driver-main.js";
export * from "./onboard.js";
export * from "./auto-onboard.js";
export * from "./llm-contract.js";
export * from "./llm-prompt.js";
export * from "./llm-arbiter.js";
export * from "./driver-llm.js";
export * from "./cross-file-coordinator.js";
export * from "./post-merge-hook.js";
export * from "./merge-stats.js";
export * from "./anomaly-detector.js";
