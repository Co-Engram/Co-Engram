/**
 * 沉思契约与 L1 基线执行器(2026-08-17 重设计)。
 *
 * core 只定义任务/回写契约,不绑宿主;L2 执行器由宿主注入(headless spawn /
 * 现场会话;openclaw 2026-08-17 起接入)。L1 = 单次 LLM 远距类比,仅当宿主
 * 无 agent runtime 时使用 —— 不与 L2 并存竞争预算。
 *
 * 沉思定位:围绕一个问题做一次全资源盘点式深度思考——调用全部记忆图谱、
 * 行为日志、技能库、受控联网检索与宿主可用的 MCP 工具,深思一次出一份
 * 报告(回答 + 洞察提案 + 过程 + 资源申报)。本地记忆仓库只读不写;联网
 * 仅限只读检索(问题与摘要级内容可出域,记忆原文不出域,隐私边界固化在
 * 协议里)。
 *
 * @module @co-engram/core/maintenance/insight
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { EngramRepository } from "../../storage/repository.js";
import type { LlmClient } from "../../observability/necessity-evaluator.js";
import { buildNightThinkingL1Prompt } from "./modes.js";
import { parseDrafts } from "./run.js";
import type { NightThinkingReport, NightThinkingTask } from "./types.js";

/**
 * 零存活轮标记(共享契约常量):生产端 dreamHistoryFor(incubator.ts)在
 * 零存活轮的深思史行里渲染它,消费端(synthesizeAnswerDraft 兜底路径)靠
 * 它判定空态。两端必须引用同一常量,禁止手写串 —— 漂移会导致空态诚实性
 * 指令失配。
 */
export const NO_SURVIVOR_MARKER = "(no insight survived validation)";

/**
 * dataRoot/.co-engram 下可作沉思证据源的日志/状态文件(存在才返回)。
 * 仅列行为证据类文件;不列 incubations/proposals 等内部存储 —— 那些由
 * dreamHistory / 提案工具面结构化提供,直读会绕过脱敏边界。
 */
const RESOURCE_FILES = [
  "signals.jsonl",
  "maintenance-state.json",
  "audit.jsonl",
  "rem-state.json",
  "observation-windows.jsonl",
] as const;

/** 收集 dataRoot/.co-engram 下存在的资源文件路径(协议 RESOURCE MANDATE 证据面) */
export function collectResourceHints(dataRoot: string): string[] {
  const dir = join(dataRoot, ".co-engram");
  return RESOURCE_FILES.map((f) => join(dir, f)).filter((p) => existsSync(p));
}

/**
 * 固化协议:协议固化在 ponder_run 返回的结构化指令中,不依赖 agent 自觉;
 * ponder_report 是唯一写回路径。回答由执行现场生产(M1)——agent 手握全部
 * 盘点上下文,它写的回答质量最高;资源使用申报(resourcesUsed)支撑 UI
 * 「依据」区,engram id 过引用闭合闸。
 */
export const CONTEMPLATION_PROTOCOL = `CONTEMPLATION PROTOCOL (follow exactly):
1. CAPABILITY INVENTORY — enumerate your available read-only capabilities
   (installed skills — both co-engram skill imprints and host-runtime
   skills; engram_search; repository reading; local file Read; any
   web search / fetch tools; and any other MCP tools your host exposes
   beyond co-engram's own).
2. RESOURCE MANDATE — mine ALL available resources before planning:
   - Full memory graph: engram_search from multiple angles (keywords,
     synonyms, upstream/downstream concepts); survey engram_list_paths.
     Do NOT limit yourself to the seed digests.
   - Synapse graph: for high-value hits, follow their synapses (engram_get
     with tier="synapses") to pull in structurally related memories —
     extends isolated hits into an evidence web (extends / derives_from /
     contradicts links often surface what plain search misses).
   - Behavioral logs: paths in task.resourceHints are local log/state files
     you may Read; ground improvement-type questions in real usage evidence
     (retrieval counts, failed uses). For "how did this memory come to be /
     who reinforced or contradicted it" questions, use engram_audit_query.
   - Skills: enumerate co-engram imprints via skill_list; read the relevant
     ones via skill_get and APPLY their methodology. Their utility stats
     (utility / invocationCount / retentionStage) are themselves behavioral
     evidence of whether the toolchain is being used effectively. Also
     inventory host-runtime skills (research / structured-thinking /
     analysis) and apply one when the question is analysis-heavy. Record
     which skill you applied in the trace.
   - Web research: when the host provides search/fetch tools and the
     question involves external facts (industry trends, competitor moves,
     benchmarks, latest versions), search the web to ground the answer in
     current external evidence instead of memory-only speculation.
   - MCP tools: inventory the other MCP servers connected to your host
     (code search / code graphs, document readers, data APIs, ...) and use
     their read-only capabilities as evidence sources when relevant —
     e.g. a code-graph MCP to verify claims against the actual codebase.
     Prefer calls that cannot mutate external state; record which MCP tool
     served which step in the trace.
3. PLAN — decide the steps: what to examine, which capability for each step,
   what question each step answers. Keep it small (3-6 steps).
4. EXECUTE — run the plan with READ-ONLY actions only. Record what you did
   and what you found at each step. Do NOT write or modify anything in the
   memory repo or local files. Web research (search engines, URL fetch) is
   ALLOWED as a read-only action when the host provides such tools.
   PRIVACY: never send raw memory content to external services; only the
   question itself and summary-level content may leave the machine.
5. ANSWER — write the answer to the question yourself, grounded in the
   evidence you collected during EXECUTE. This is the primary deliverable:
   direct, specific, and in the same language as the question. Do not pad
   with generalities — cite which memories / logs / skills / web sources
   support each claim.
   The answer text MUST be delivered as the "answer" string field of the
   report JSON in step 6 — a report without a non-empty "answer" is
   considered incomplete.
6. REPORT — call the tool \`ponder_report\` exactly once with a JSON object
   ("answer" is REQUIRED — never omit it, never leave it empty):
   { "incubationId": "<id>", "report": { "answer": "<your answer text>",
     "insights": [ <insight drafts> ],
     "plan": [ {"step": "...", "capability": "..."} ],
     "trace": [ {"step": "...", "action": "...", "detail": "..."} ],
     "resourcesUsed": { "engrams": [<real ids of memories you actually read>],
       "skills": [<skill names you actually used>],
       "logs": [<paths you actually read>],
       "web": [{"query": "<search query or URL>",
         "purpose": "<what question it answered>"}] } } }
   Each insight draft: { "type": "theme|lesson|analogy|hypothesis", "title",
   "summary", "content", "sourceIds": [...], "domainTags": [...], "reason",
   "aar": {...} (lesson only) }. Insights are captured immediately — do not
   wait or batch. Do not repeat directions already explored in the previous
   thinking sessions; deepen or pivot.
   EVIDENCE ANCHORING (hard gate): every insight's sourceIds must contain ONLY
   real engram ids from the memory repo — the path-like ids returned by
   engram_search / engram_get / seed digests — at least one per insight.
   Findings from other resources (source code, behavioral logs) are valuable
   evidence but are NOT valid sourceIds: cite them inside content (e.g.
   "verified in repo source / log") and mention them in reason.
   resourcesUsed.engrams follows the same rule: list only real engram ids you
   actually read. Insights with empty, invented, or non-engram sourceIds are
   rejected by the citation gate before review.`;

/** 组装协议文本(2026-08-17 起受控联网:只读检索允许,隐私边界固化;无开关) */
export function buildProtocol(): string {
  return CONTEMPLATION_PROTOCOL;
}

/**
 * L1 基线执行器:单次 llmClient.complete,远距类比 + 锚定 + 深思史回灌。
 * 无 plan/trace 编排、无资源申报(L1 无盘点过程);仅在宿主无 agent runtime
 * 时使用。回答由 core 综合层兜底补写(见 incubator.report)。
 */
export function createL1Executor(
  llm: LlmClient,
  repo: EngramRepository,
): { execute(task: NightThinkingTask): Promise<NightThinkingReport> } {
  return {
    async execute(task) {
      // 种子用 S 别名(与 run.ts 同因:LLM 抄写 26 位 ULID 极易出错)
      const alias = new Map<string, string>();
      const seedText = task.seedDigests
        .map((s, i) => {
          const a = `S${i + 1}`;
          alias.set(a, s.id);
          return `- [${a}] ${s.title} (id=${s.id}) | tags=${s.domainTags.join("/")} | ${s.summary}`;
        })
        .join("\n");
      const prompt = buildNightThinkingL1Prompt(
        task.question,
        seedText || "(no seeds)",
        task.dreamHistory,
      );
      const raw = await llm.complete(prompt, { temperature: 0.5, maxTokens: 131072, timeoutMs: 600_000 });
      const insights = parseDrafts(raw, "inspiration")
        .map((d) => ({
          ...d,
          sourceIds: d.sourceIds.map((x) => alias.get(x) ?? x),
        }))
        .map((d) => ({
          ...d,
          mode: "inspiration" as const,
        }));
      return {
        insights,
        plan: [{ step: "L1 single-pass distant analogy", capability: "llm" }],
        trace: [
          { step: "generate", action: "llm.complete", detail: `${insights.length} drafts` },
        ],
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

/**
 * 回答兜底综合(M1 降格:仅当 L2 未交 answer 或走 L1 时由 core 补写):
 * 对「问题 + 深思史 + 本轮摘要 + 本轮执行语境」做单次综合。不降级 ——
 * 调用失败/空输出由调用方记 answerError,绝不拼接伪回答。
 *
 * roundContext(2026-08-16 机制缺陷修复:综合层信息面断裂):零存活轮里
 * 执行层 agent 往往做了大量实质工作(资源盘点/源码核实),但旧输入面只有
 * 「存活摘要」—— 综合层对拒因与执行轨迹一无所知,只能猜测性归因,把系统
 * 缺陷误报成用户提问问题。此处把拒因/轨迹注入综合输入,归因锚定真实证据。
 */
export async function synthesizeAnswerDraft(
  llm: LlmClient,
  question: string,
  dreamHistoryBefore: string,
  roundSummaries: readonly string[],
  roundContext?: {
    /** 本轮逐条拒绝原因(三道闸;title 前缀 + reason) */
    readonly rejectReasons?: readonly string[];
    /** 本轮执行轨迹摘要(step: action — detail) */
    readonly traceSummary?: readonly string[];
  },
): Promise<string> {
  const ctx = roundContext ?? {};
  const prompt = [
    "You are writing the ANSWER for a deep-thinking (contemplation) question.",
    "Audience: the user who asked the question. Language: match the question's language.",
    "",
    "## Question",
    question,
    "",
    "## Previous thinking sessions (with user accept/dismiss dispositions)",
    dreamHistoryBefore.trim() || "(no previous sessions)",
    "",
    "## This round's surviving insight summaries",
    roundSummaries.length ? roundSummaries.map((s) => `- ${s}`).join("\n") : "(none survived this round)",
    "",
    "## This round's execution trace (what the thinking agent actually did)",
    ctx.traceSummary?.length ? ctx.traceSummary.map((t) => `- ${t}`).join("\n") : "(no trace recorded)",
    "## This round's rejection reasons (why drafts died at the quality gates)",
    ctx.rejectReasons?.length ? ctx.rejectReasons.map((r) => `- ${r}`).join("\n") : "(none)",
    "",
    "Write 3-6 sentences: what the accumulated evidence currently suggests as an answer,",
    "how confident it is, and what a re-think should examine. If nothing survived yet,",
    "say so honestly instead of inventing conclusions — and when explaining WHY nothing",
    "survived, ground the explanation in the rejection reasons and execution trace above.",
    "Do NOT speculate that the question is too vague or ask the user to clarify the",
    "subject unless the rejection reasons actually say so.",
    "Plain text only, no markdown fences.",
  ].join("\n");
  // 效果优先(2026-08-15 用户决策,与 critic.ts 对齐):GLM thinking 模型
  // 思考耗时长,120s 会系统性超时 → 600s;8192 → 16384 给足输出预算
  const raw = await llm.complete(prompt, {
    temperature: 0.3,
    maxTokens: 16384,
    timeoutMs: 600_000,
  });
  const text = raw.trim();
  if (!text) throw new Error("empty synthesis output");
  return text.slice(0, 4000);
}
