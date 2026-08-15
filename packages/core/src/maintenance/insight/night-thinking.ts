/**
 * 夜思契约与 L1 基线执行器(spec §四)。
 *
 * core 只定义任务/回写契约,不绑宿主;L2 执行器由宿主提供(claude-code =
 * headless spawn / 现场会话;openclaw 一期降级 L1)。L1 = 单次 LLM 远距类比,
 * 仅当宿主无 agent runtime 或 L2 不可用时使用 —— 不与 L2 并存竞争预算。
 *
 * Dormio 协议形态(非睡眠机制):播种 → 锚定 → 捕获 → 回灌迭代 → resolve。
 *
 * @module @co-engram/core/maintenance/insight
 */

import type { EngramRepository } from "../../storage/repository.js";
import type { LlmClient } from "../../observability/necessity-evaluator.js";
import { buildNightThinkingL1Prompt } from "./modes.js";
import { parseDrafts } from "./run.js";
import type { NightThinkingReport, NightThinkingTask } from "./types.js";

/**
 * 固化协议(spec §四 L2 主路径):协议固化在 incubation_run 返回的结构化
 * 指令中,不依赖 agent 自觉;incubation_report 是唯一写回路径。
 */
export const NIGHT_THINKING_PROTOCOL = `NIGHT-THINKING PROTOCOL (follow exactly):
1. CAPABILITY INVENTORY — enumerate your available read-only capabilities
   (installed skills, engram_search, repository reading, WebSearch if allowed).
2. PLAN — decide the steps: what to examine, which capability for each step,
   what question each step answers. Keep it small (3-6 steps).
3. EXECUTE — run the plan with READ-ONLY actions only. Record what you did
   and what you found at each step. Do NOT write or modify anything.
   PRIVACY: web research is ${"__WEB__"} — if disabled, do not make any
   network call; never send raw memory content to external services; only
   the question and summary-level content may leave.
4. REPORT — call the tool \`incubation_report\` exactly once with a JSON object:
   { "incubationId": "<id>", "report": { "insights": [ <insight drafts> ],
     "plan": [ {"step": "...", "capability": "..."} ],
     "trace": [ {"step": "...", "action": "...", "detail": "..."} ],
     "externalCalls": [ {"tool": "...", "purpose": "...", "at": "<ISO>"} ] } }
   Each insight draft: { "type": "theme|lesson|analogy|hypothesis", "title",
   "summary", "content", "sourceIds": [...], "domainTags": [...], "reason",
   "aar": {...} (lesson only) }. Insights are captured immediately — do not
   wait or batch. Do not repeat directions already explored in the dream
   history; deepen or pivot.`;

/** 组装带隐私开关的协议文本 */
export function buildProtocol(webResearchOptIn: boolean): string {
  return NIGHT_THINKING_PROTOCOL.replace("__WEB__", webResearchOptIn ? "ALLOWED (opted-in)" : "DISABLED (default)");
}

/**
 * L1 基线执行器:单次 llmClient.complete,远距类比 + 锚定 + 梦境史回灌。
 * 无 plan/trace(L1 无编排);externalCalls 为空(不联网)。
 */
export function createL1Executor(
  llm: LlmClient,
  repo: EngramRepository,
): { execute(task: NightThinkingTask): Promise<NightThinkingReport> } {
  return {
    async execute(task) {
      const seedText = task.seedDigests
        .map((s) => `- [${s.id}] ${s.title} | tags=${s.domainTags.join("/")} | ${s.summary}`)
        .join("\n");
      const prompt = buildNightThinkingL1Prompt(
        task.question,
        seedText || "(no seeds)",
        task.dreamHistory,
      );
      const raw = await llm.complete(prompt, { temperature: 0.5, maxTokens: 4096 });
      const insights = parseDrafts(raw, "inspiration").map((d) => ({
        ...d,
        mode: "inspiration" as const,
      }));
      return {
        insights,
        plan: [{ step: "L1 single-pass distant analogy", capability: "llm" }],
        trace: [
          { step: "generate", action: "llm.complete", detail: `${insights.length} drafts` },
        ],
        externalCalls: [],
      };
    },
  };
}

/** 种子摘要(脱敏:不带记忆原文;viewer/L2 prompt 组装共用) */
export function collectSeedDigests(
  repo: EngramRepository,
  seedEngramIds: readonly string[],
  cap = 12,
): NightThinkingTask["seedDigests"] {
  const out: Array<NightThinkingTask["seedDigests"][number]> = [];
  for (const id of seedEngramIds.slice(0, cap)) {
    try {
      const e = repo.readEngram(id);
      out.push({
        id: e.id,
        title: e.title,
        summary: e.summary,
        domainTags: e.domainTags ?? [],
      });
    } catch {
      // 种子可能已删除,跳过
    }
  }
  return out;
}
