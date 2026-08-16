/**
 * L2 headless 执行器 —— `claude -p` spawn(spec §四主路径,claude-code 宿主)。
 *
 * PoC 已验证(2026-08-15):headless spawn 的 MCP 工具授权(--allowedTools)、
 * 用户级技能加载均工作。隐私硬约束(spec §四):
 * - 默认 allowedTools 只读白名单(engram 检索/技能发现),**不含**任何写工具
 * - WebSearch 仅按条目 opt-in 加入
 * - prompt 只携带种子摘要级内容(task.seedDigests 由 core 脱敏组装,不带记忆原文)
 * - externalCalls 由 agent 在回写中申报 → core 写审计日志
 *
 * @module @co-engram/claude-code/night-thinking
 */

import { spawn } from "node:child_process";

import type {
  NightThinkingExecutor,
  NightThinkingReport,
  NightThinkingTask,
} from "@co-engram/core";

/** 只读白名单:检索/读取/技能发现;任何写工具(engram_create 等)一律不给 */
export const READONLY_ALLOWED_TOOLS: readonly string[] = [
  "mcp__co-engram__engram_search",
  "mcp__co-engram__engram_get",
  "mcp__co-engram__engram_list",
  "mcp__co-engram__engram_list_paths",
  "mcp__co-engram__skill_list",
  "mcp__co-engram__skill_get",
  "Skill",
  "Read",
];

export interface HeadlessExecutorOptions {
  /** claude 可执行文件(默认 "claude";测试注入 fake spawnFn) */
  readonly claudeBin?: string;
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
  /** cwd(默认 process.cwd()) */
  readonly cwd?: string;
  /**
   * 注入 spawn 实现(测试用,不真调 claude)。
   * 签名对齐 node:child_process.spawn,返回 { stdout, stderr } 的 Promise 包装。
   */
  readonly spawnFn?: (cmd: string, args: readonly string[]) => Promise<{
    readonly stdout: string;
    readonly stderr: string;
    readonly code: number | null;
  }>;
}

const DEFAULT_MAX_TURNS = 40;
// 2026-08-16 场景重放实测:全资源盘点 10min 跑不完,超时降级 L1 丢掉全部执行
// 成果 —— 夜思不赶时间,给足 20min(与 claude-code-mcp 同源文件保持一致)。
const DEFAULT_TIMEOUT_MS = 20 * 60_000;

/**
 * 组装 headless 会话 prompt:任务包(问题/种子摘要/梦境史/隐私边界)+ 固化协议。
 */
export function buildHeadlessPrompt(task: NightThinkingTask): string {
  const seeds = task.seedDigests
    .map((s) => `- [${s.id}] ${s.title} | tags=${s.domainTags.join("/")} | ${s.summary}`)
    .join("\n");
  return [
    `You are the L2 night-thinking agent. Work through the task below READ-ONLY.`,
    ``,
    `## Task`,
    `${task.question}`,
    ``,
    `## Seed memory digests (summary-level only; read full content via engram_get if needed)`,
    seeds || "(no seeds — use engram_search to find relevant memories yourself)",
    ``,
    `## Resource hints (task.resourceHints — local, read-only)`,
    task.resourceHints.length > 0
      ? `Log/state files you may Read for behavioral evidence:`
      : `(none in this environment — skip the behavioral-logs step)`,
    ...task.resourceHints.map((p) => `- ${p}`),
    ``,
    ...(task.dreamHistory.trim().length > 0
      ? [`## Dream history (previous rounds — deepen or pivot, do not repeat)`, task.dreamHistory, ``]
      : []),
    `## Privacy boundary`,
    task.webResearchOptIn
      ? `- Web research is ALLOWED for this entry (user opted in). Only the task question and summary-level content may be sent to search engines; never raw memory content.`
      : `- Web research is DISABLED. Do NOT make any network call.`,
    `- Never send raw memory content to external services.`,
    ``,
    task.protocol.replace(
      "call the tool `incubation_report` exactly once",
      "return the report object as your final answer in the exact JSON shape below (you have no incubation_report tool in this headless session)",
    ),
    ``,
    `Final answer: ONLY the JSON object {"insights":[...],"plan":[...],"trace":[...],"externalCalls":[...]} — no prose outside it.`,
  ].join("\n");
}

/** 组装 CLI flags(不含 prompt;prompt 由 execute 以 `-p <prompt>` 前置) */
export function buildHeadlessArgs(
  task: NightThinkingTask,
  maxTurns: number,
): readonly string[] {
  const allowed = [...READONLY_ALLOWED_TOOLS];
  if (task.webResearchOptIn) allowed.push("WebSearch", "WebFetch");
  return [
    "--output-format",
    "json",
    "--max-turns",
    String(maxTurns),
    "--allowedTools",
    allowed.join(","),
  ];
}

/** 从 headless stdout 提取 NightThinkingReport(剥 ```json 围栏 / result 包裹) */
export function parseHeadlessReport(raw: string): NightThinkingReport {
  // claude -p --output-format json 输出 {"type":"result","result":"..."} 包裹
  let text = raw;
  try {
    const outer = JSON.parse(raw) as { result?: string };
    if (typeof outer.result === "string") text = outer.result;
  } catch {
    // 非 JSON 包裹,按裸文本处理
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("headless executor: no JSON object in output");
  }
  const parsed = JSON.parse(body.slice(start, end + 1)) as Partial<NightThinkingReport>;
  if (!Array.isArray(parsed.insights)) {
    throw new Error("headless executor: report missing insights array");
  }
  return {
    insights: parsed.insights,
    plan: Array.isArray(parsed.plan) ? parsed.plan : [],
    trace: Array.isArray(parsed.trace) ? parsed.trace : [],
    externalCalls: Array.isArray(parsed.externalCalls) ? parsed.externalCalls : [],
  };
}

/**
 * 创建 L2 headless 执行器。spawn 失败 / 超时 / 输出不可解析 → 抛错,
 * 由 Incubator 降级 L1(不阻塞交付)。
 */
export function createHeadlessExecutor(
  opts: HeadlessExecutorOptions = {},
): NightThinkingExecutor {
  const bin = opts.claudeBin ?? "claude";
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const run = opts.spawnFn ?? defaultSpawn;

  return {
    async execute(task: NightThinkingTask): Promise<NightThinkingReport> {
      const flags = buildHeadlessArgs(task, maxTurns);
      const prompt = buildHeadlessPrompt(task);
      const { stdout, code, stderr } = await Promise.race([
        run(bin, ["-p", prompt, ...flags]),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`headless executor timeout (${timeoutMs}ms)`)),
            timeoutMs,
          ),
        ),
      ]);
      if (code !== 0) {
        throw new Error(`headless executor exited ${code}: ${stderr.slice(0, 200)}`);
      }
      return parseHeadlessReport(stdout);
    },
  };
}

/** 真实 spawn(默认):capture stdout/stderr,继承 stdin=/dev/null */
function defaultSpawn(
  cmd: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...(process.env.NO_COLOR !== undefined ? { env: process.env } : { env: process.env }),
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}
