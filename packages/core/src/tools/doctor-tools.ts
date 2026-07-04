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
import { runInfraDoctor } from "../storage/infra-doctor.js";
import { cleanupDanglingIndexReferences } from "../storage/index-cleanup.js";
import { readEngramIndex } from "../storage/engram-index.js";

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
      "Run a self-healing scan over the memory repo. Detects and auto-fixes: moved files (index re-pointed), title renames (re-slug + file rename), missing files (index cleared), Obsidian view drift (frontmatter.aliases missing or derived synapses wikilink section out of sync with synapse yaml — both regenerated), missing derived indexes (digest.jsonl/graph.json rebuilt), unconfigured merge driver (auto-onboarded), and dangling references in derived indexes (observation-windows/digest/graph entries pointing to deleted engrams — filtered or rebuilt). Reports for manual review: orphan markdown without frontmatter and dangling synapse references. Each manual-review issue includes a `nextAction` hint (tool + argsHint + explanation) so the caller knows exactly which tool to invoke next. Returns a structured report.",
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
      // 基础设施自愈 preflight:补齐 runDoctor 不覆盖的层(派生索引 + merge driver)
      // 让 engram_doctor 真正成为"一键自愈"工具,匹配 computeStatus 给出的 fix.tool=engram_doctor 承诺
      const dataRoot = ctx.repository.rootPath;
      const infra = runInfraDoctor({ repo: ctx.repository, dataRoot });

      const report = ctx.repository.runDoctor({
        incremental: parsed.incremental,
      });

      // postflight:runDoctor 已 persist 最新的 engram-index.json,
      // 据此清派生索引中对已删 engram 的悬空引用(observation-windows / digest / graph)。
      // 兜底用户外部 rm 文件、git rm 后只清 engram-index.json 但派生索引残留的场景。
      const canonicalIds = new Set<string>(
        Array.from(readEngramIndex(dataRoot).entries.keys()) as string[],
      );
      const post = cleanupDanglingIndexReferences({
        repo: ctx.repository,
        dataRoot,
        canonicalIds,
      });

      // infra fixes 放头部(基础设施层先于文件层),postflight 放尾部
      const combinedFixes = [
        ...infra.fixes,
        ...report.fixes,
        ...post.fixes,
      ];

      return {
        startedAt: report.startedAt,
        finishedAt: report.finishedAt,
        totalEngrams: report.totalEngrams,
        totalSynapses: report.totalSynapses,
        autoFixesApplied: combinedFixes.length,
        pendingManualReview: report.pendingManualReview.length,
        issues: [...combinedFixes, ...report.pendingManualReview].map((i) => ({
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
//
// Task 3.5 形态对齐确认:本工具的「limit」语义已经是 `maxDepth`(目录树深度),
// 而非结果数量;目录树一次性返回,无 cursor。这与 plan 的「list_paths 的 limit
// 含义改 maxDepth,不变 cursor 语义(目录树一次性返回即可)」一致 —— 当前
// 实现已满足,无需修改。保留 maxDepth 可选(默认 5,上限 10)。

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
