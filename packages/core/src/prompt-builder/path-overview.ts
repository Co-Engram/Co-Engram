/**
 * 仓库目录概览(host-agnostic 工具)
 *
 * 用于 system prompt 的"目录深度渐进式披露":常驻注入 depth=1 顶级目录,
 * 让 LLM 在 search 前看到仓库结构。
 *
 * 设计判断(详见对话样本 2026-07-04):
 *   - 目录是**结构信息**(静态、廉价),不是统计信息(动态、需算频次)
 *   - 因此走常驻 system prompt,不走 prompt-signals 自进化路径
 *   - 深度梯度靠 maxDepth 参数:system prompt=1、engram_list_paths 工具按需调用
 *
 * @module @co-engram/core/prompt-builder
 */

import type { Language } from "../i18n/index.js";
import { translatePrompt } from "../i18n/index.js";
import type { PathTreeNode } from "../types/repository-types.js";

/** 单条目录概览项(扁平,无树结构) */
export interface PathOverviewItem {
  /** 相对 dataRoot 的目录路径(如 "co-engram"、"设计原则/co-engram") */
  readonly path: string;
  /** 该目录及其所有子目录的累积 engram 数 */
  readonly engramCount: number;
}

/**
 * 从完整 PathTreeNode 截断到指定深度,返回扁平概览列表。
 *
 * @param maxDepth - 1=顶级目录(项目级),2=加孙目录(领域级),以此类推
 */
export function pathOverviewFromTree(
  tree: PathTreeNode,
  maxDepth = 1,
): readonly PathOverviewItem[] {
  const out: PathOverviewItem[] = [];
  const walk = (node: PathTreeNode, depth: number): void => {
    if (depth > maxDepth) return;
    for (const child of node.children) {
      out.push({ path: child.path, engramCount: child.engramCount });
      walk(child, depth + 1);
    }
  };
  walk(tree, 1);
  return out;
}

/**
 * 格式化目录概览为可注入 system prompt 的 i18n 文本。
 *
 * 空列表返回空字符串(调用方决定是否注入)。
 */
export function formatPathOverview(
  items: readonly PathOverviewItem[],
  language: Language,
): string {
  if (items.length === 0) return "";
  const tree = items.map((i) => `- ${i.path} (${i.engramCount})`).join("\n");
  return translatePrompt(language, "prompt.memory.repo_overview", { tree });
}
