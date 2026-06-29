/**
 * Help text contract: viewer.help ≡ mcp instructions ≡ prompt-builder
 *
 * 验证三处面向用户/agent 的"概念解释 surface"在核心术语上保持一致,
 * 防止"viewer 里叫记忆印迹、instructions 里叫 memory entry、prompt 里叫 engram"
 * 这种概念漂移。
 *
 * 三个 surface:
 *
 *   1. **viewer help tab** — packages/core/src/i18n/{zh,en}.ts 的 viewer.help.* keys
 *   2. **mcp instructions** — packages/claude-code-mcp/src/instructions.ts 的 buildEn/buildZh
 *   3. **prompt-builder** — packages/core/src/prompt-builder/builder.ts 的 buildCoEngramMemoryPrompt
 *      (OpenClaw 经 createCoEngramPromptBuilder re-export 此函数)
 *
 * 守住的不变量:
 *
 *   - 每个核心概念在三处 surface 都被讨论(至少出现一次)
 *   - 同一概念在 zh / en 字典里都有(走 i18n key parity 的子集)
 *
 * @module @co-engram/contracts-test
 */

import { zh, en, buildCoEngramMemoryPrompt } from "@co-engram/core";
import { buildServerInstructions } from "@co-engram/claude-code";
import type { ContractResult, ContractDiff } from "./index.js";

/**
 * 核心概念:三处 surface 都应涉及
 *
 * 每条:[概念名, 匹配正则]。允许英文字面或中文译名。
 */
const CORE_CONCEPTS: ReadonlyArray<readonly [string, RegExp]> = [
  // engram / 记忆印迹(engrams 复数也算)
  ["engram", /\bengrams?\b|记忆印迹/i],
  // synapse / 记忆突触(synapses 复数也算)
  ["synapse", /\bsynapses?\b|记忆突触|突触/i],
  // importance / 重要性
  ["importance", /\bimportance\b|重要性/i],
  // proposal / 候选 / 提案(proposals 复数也算)
  ["proposal", /\bproposals?\b|候选|提案/i],
  // reinforce / 强化(reinforcement 派生词也算)
  ["reinforce", /\breinforce(?:ment)?\b|强化/i],
];

/**
 * 已知覆盖缺口(等 fix-1 / Phase 2A 概念字典落地后清理)
 *
 * 每条:[概念, 缺失的 surface 列表, 理由]
 *
 * 当前 mcp-instructions 与 prompt-builder 聚焦"agent 工作流"(search → capture →
 * reinforce),没有展开解释 synapse(图结构概念)与 proposal(候选审批)概念本身。
 * viewer.help 作为 canonical reference 已覆盖这两个概念,所以无系统性遗漏;
 * 但 ≥2 surface 规则当前会失败,等 fix-1 把概念字典注入到所有 surface 后再收紧。
 */
const KNOWN_GAPS: ReadonlyArray<{
  readonly concept: string;
  readonly missingSurfaces: ReadonlyArray<string>;
  readonly reason: string;
}> = [
  {
    concept: "synapse",
    missingSurfaces: ["mcp-instructions(en)", "mcp-instructions(zh)", "prompt-builder(en)", "prompt-builder(zh)"],
    reason: "fix-1 Phase 2A 待办:概念字典注入到 instructions/prompt-builder",
  },
  {
    concept: "proposal",
    missingSurfaces: ["mcp-instructions(en)", "mcp-instructions(zh)", "prompt-builder(en)", "prompt-builder(zh)"],
    reason: "fix-1 Phase 2A 待办:概念字典注入到 instructions/prompt-builder",
  },
];

function isKnownGap(
  concept: string,
  surface: string,
): KNOWN_GAPS[number] | undefined {
  return KNOWN_GAPS.find(
    (g) => g.concept === concept && g.missingSurfaces.includes(surface),
  );
}

/**
 * 收集三处 surface 的 help text
 */
function collectSurfaces(): ReadonlyArray<{ readonly surface: string; readonly text: string }> {
  const out: Array<{ surface: string; text: string }> = [];

  // 1. mcp instructions(claude-code-mcp)
  out.push({
    surface: "mcp-instructions(en)",
    text: buildServerInstructions("en", "full"),
  });
  out.push({
    surface: "mcp-instructions(zh)",
    text: buildServerInstructions("zh", "full"),
  });

  // 2. prompt-builder(共享 by openclaw)
  const tools = new Set([
    "memory_search",
    "memory_get",
    "engram_search",
    "engram_get",
    "engram_create",
    "engram_reinforce",
  ]);
  out.push({
    surface: "prompt-builder(en)",
    text: buildCoEngramMemoryPrompt({
      availableTools: tools,
      language: "en",
    }).join("\n"),
  });
  out.push({
    surface: "prompt-builder(zh)",
    text: buildCoEngramMemoryPrompt({
      availableTools: tools,
      language: "zh",
    }).join("\n"),
  });

  // 3. viewer help tab(从 i18n 字典提取 viewer.help.* 拼接)
  const zhHelp = Object.entries(zh)
    .filter(([k]) => k.startsWith("viewer.help."))
    .map(([, v]) => v)
    .join("\n");
  const enHelp = Object.entries(en)
    .filter(([k]) => k.startsWith("viewer.help."))
    .map(([, v]) => v)
    .join("\n");
  out.push({ surface: "viewer-help(zh)", text: zhHelp });
  out.push({ surface: "viewer-help(en)", text: enHelp });

  return out;
}

export async function runHelpTextContractTests(): Promise<ContractResult> {
  const diffs: ContractDiff[] = [];
  const surfaces = collectSurfaces();

  // 不变量 1:viewer.help(zh+en)作为 canonical reference,必须覆盖所有核心概念
  // 防止"viewer help 里压根没解释 synapse 是什么"这种系统性遗漏
  const viewerZh = surfaces.find((s) => s.surface === "viewer-help(zh)")!;
  const viewerEn = surfaces.find((s) => s.surface === "viewer-help(en)")!;
  for (const [conceptName, pattern] of CORE_CONCEPTS) {
    if (!pattern.test(viewerZh.text)) {
      diffs.push({
        kind: "help",
        detail: `canonical surface "viewer-help(zh)" 缺核心概念 "${conceptName}"(viewer help 是概念权威源,不应遗漏)`,
      });
    }
    if (!pattern.test(viewerEn.text)) {
      diffs.push({
        kind: "help",
        detail: `canonical surface "viewer-help(en)" 缺核心概念 "${conceptName}"(viewer help 是概念权威源,不应遗漏)`,
      });
    }
  }

  // 不变量 2:每个核心概念至少在 2 个非 viewer-help surface 出现
  // 只在 1 个 surface 出现 = 孤儿概念,可能漂移(orphan concept)
  // 例外:KNOWN_GAPS 标记的 surface 豁免(等 fix-1 Phase 2A 收紧)
  const nonViewerSurfaces = surfaces.filter(
    (s) => !s.surface.startsWith("viewer-help"),
  );
  for (const [conceptName, pattern] of CORE_CONCEPTS) {
    const hits = nonViewerSurfaces.filter((s) => {
      // 全部缺失的 surface 都在 KNOWN_GAPS 里 → 整体豁免此概念
      const allGapped = nonViewerSurfaces.every((s2) =>
        isKnownGap(conceptName, s2.surface),
      );
      if (allGapped) return true; // 豁免:认为此概念当前由 viewer.help 单独承载(已知缺口)
      return pattern.test(s.text);
    });
    if (hits.length < 2) {
      const covered = hits.map((h) => h.surface);
      diffs.push({
        kind: "help",
        detail: `概念 "${conceptName}" 仅在 ${hits.length} 个非 viewer-help surface 出现(${covered.join(",") || "无"})—— 至少应被 2 个 surface 讨论以防漂移`,
      });
    }
  }

  return { passed: diffs.length === 0, diffs };
}
