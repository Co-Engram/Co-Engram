/**
 * 仓库健康工具集
 *
 *   - engram_doctor        触发自愈扫描
 *   - engram_list_paths    列出目录树(渐进式披露)
 *
 * @module @co-engram/core/tools
 */

import { z } from "zod";

import type { Tool, ToolContext } from "./tool.js";
import { validateInput } from "./tool.js";

// ============================================================
// engram_doctor
// ============================================================

export const EngramDoctorInputSchema = z
  .object({
    incremental: z
      .boolean()
      .optional()
      .describe("增量扫描(只比对 mtime 变化的文件);默认全量"),
  })
  .strict();

export type EngramDoctorToolInput = z.infer<typeof EngramDoctorInputSchema>;

export interface EngramDoctorResult {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly totalEngrams: number;
  readonly totalSynapses: number;
  readonly autoFixesApplied: number;
  readonly pendingManualReview: number;
  readonly issues: readonly {
    readonly kind: string;
    readonly stableId?: string;
    readonly path?: string;
    readonly message: string;
    readonly autoFixed: boolean;
    readonly nextAction?: {
      readonly tool: string;
      readonly argsHint: string;
      readonly explanation: string;
    };
  }[];
}

export const engramDoctorTool: Tool<EngramDoctorToolInput, EngramDoctorResult> =
  {
    name: "engram_doctor",
    description:
      "Run a self-healing scan over the memory repo. Detects and auto-fixes: moved files (index re-pointed), title renames (re-slug + file rename), missing files (index cleared), and Obsidian view drift (frontmatter.aliases missing or derived synapses wikilink section out of sync with synapse yaml — both regenerated). Reports for manual review: orphan markdown without frontmatter and dangling synapse references. Each manual-review issue includes a `nextAction` hint (tool + argsHint + explanation) so the caller knows exactly which tool to invoke next. Returns a structured report.",
    inputSchema: EngramDoctorInputSchema,
    execute(input, ctx) {
      const parsed = validateInput<EngramDoctorToolInput>(
        EngramDoctorInputSchema,
        input,
      );
      if (!ctx.repository) {
        throw new Error(
          "engram_doctor requires a Repository — inject `repository` into ToolContext",
        );
      }
      const report = ctx.repository.runDoctor({
        incremental: parsed.incremental,
      });

      return {
        startedAt: report.startedAt,
        finishedAt: report.finishedAt,
        totalEngrams: report.totalEngrams,
        totalSynapses: report.totalSynapses,
        autoFixesApplied: report.fixes.length,
        pendingManualReview: report.pendingManualReview.length,
        issues: [...report.fixes, ...report.pendingManualReview].map((i) => ({
          kind: i.kind,
          stableId: i.stableId,
          path: i.path,
          message: i.message,
          autoFixed: i.autoFixed,
          nextAction: i.nextAction,
        })),
      };
    },
  };

// ============================================================
// engram_list_paths
// ============================================================

export const EngramListPathsInputSchema = z
  .object({
    maxDepth: z
      .number()
      .int()
      .positive()
      .max(10)
      .optional()
      .describe("目录树最大深度(默认 5)"),
  })
  .strict();

export type EngramListPathsToolInput = z.infer<
  typeof EngramListPathsInputSchema
>;

export interface PathNodeDto {
  readonly path: string;
  readonly engramCount: number;
  readonly children: readonly PathNodeDto[];
}

export interface EngramListPathsResult {
  readonly root: PathNodeDto;
}

export const engramListPathsTool: Tool<
  EngramListPathsToolInput,
  EngramListPathsResult
> = {
  name: "engram_list_paths",
  description:
    "List the physical directory tree of the memory repo (human-organized paths). Each node carries an engramCount (cumulative subtree count). Used for progressive disclosure: the LLM can see where current work is concentrated before searching.",
  inputSchema: EngramListPathsInputSchema,
  execute(input, ctx) {
    validateInput<EngramListPathsToolInput>(EngramListPathsInputSchema, input);
    if (!ctx.repository) {
      throw new Error(
        "engram_list_paths requires a Repository — inject `repository` into ToolContext",
      );
    }
    const tree = ctx.repository.listPathTree();
    return {
      root: pruneTree(tree, input.maxDepth ?? 5, 0),
    };
  },
};

function pruneTree(
  node: { path: string; engramCount: number; children: readonly any[] },
  maxDepth: number,
  currentDepth: number,
): PathNodeDto {
  const children =
    currentDepth + 1 >= maxDepth
      ? []
      : node.children.map((c) => pruneTree(c, maxDepth, currentDepth + 1));
  return {
    path: node.path,
    engramCount: node.engramCount,
    children,
  };
}

// ============================================================
// 注册
// ============================================================

export const ALL_DOCTOR_TOOLS: readonly Tool[] = [
  engramDoctorTool,
  engramListPathsTool,
];
