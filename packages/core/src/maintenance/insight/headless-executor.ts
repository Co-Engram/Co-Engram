/**
 * L2 headless 执行器 —— `claude -p` spawn(2026-08-17 收敛到 core)。
 *
 * 三宿主(claude-code-mcp / dsh-plugin / openclaw-plugin)共用本实现;
 * 原 claude-code-mcp 与 dsh-plugin 的复制文件改为 re-export,禁止再分叉
 * (协议文本曾是隐性双维护点:buildHeadlessPrompt 用字符串 replace 锚定
 * 协议原文,两份复制品漏改一份即 L2 静默失效)。
 *
 * 隐私与安全硬约束:
 * - allowedTools 只读白名单(engram 检索/技能发现/本地 Read),不含任何写
 *   工具,不含 WebSearch/WebFetch(2026-08-17 联网线整体移除,纯本地执行)
 * - prompt 只携带种子摘要级内容(task.seedDigests 由 core 脱敏组装,不带
 *   记忆原文)
 *
 * @module @co-engram/core/maintenance/insight
 */

import { spawn } from "node:child_process";

import type {
  NightThinkingExecutor,
  NightThinkingReport,
  NightThinkingResourcesUsed,
  NightThinkingTask,
} from "./types.js";

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

// M4(2026-08-17):全资源盘点(engram 多角度检索 + 日志 Read + 技能 + 综合)
// 的实际步数对齐 —— 40 轮后半程逼近上限会仓促交卷,放宽到 80。
const DEFAULT_MAX_TURNS = 80;
// 2026-08-16 场景重放实测:全资源盘点在 10min 内跑不完,超时降级 L1 反而
// 丢掉全部执行成果 —— 沉思不赶时间,给足 20min(EVIDENCE ANCHORING 的检索
// 锚定也需要时间)。
const DEFAULT_TIMEOUT_MS = 20 * 60_000;

/**
 * 组装 headless 会话 prompt:任务包(问题/种子摘要/深思史/本地只读边界)+
 * 固化协议。
 */
export function buildHeadlessPrompt(task: NightThinkingTask): string {
  const seeds = task.seedDigests
    .map((s) => `- [${s.id}] ${s.title} | tags=${s.domainTags.join("/")} | ${s.summary}`)
    .join("\n");
  return [
    `You are the L2 contemplation agent. Work through the task below READ-ONLY.`,
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
      ? [`## Previous thinking sessions (deepen or pivot, do not repeat)`, task.dreamHistory, ``]
      : []),
    `## Execution boundary`,
    `- All execution is LOCAL and READ-ONLY: do not make any network call.`,
    ``,
    task.protocol.replace(
      "call the tool `ponder_report` exactly once",
      "return the report object as your final answer in the exact JSON shape below (you have no ponder_report tool in this headless session)",
    ),
    ``,
    `Final answer: ONLY the JSON object {"answer":"<non-empty answer text — REQUIRED>","insights":[...],"plan":[...],"trace":[...],"resourcesUsed":{...}} — no prose outside it.`,
  ].join("\n");
}

export function buildHeadlessArgs(
  task: NightThinkingTask,
  maxTurns: number,
): readonly string[] {
  void task;
  return [
    "--output-format",
    "json",
    "--max-turns",
    String(maxTurns),
    "--allowedTools",
    READONLY_ALLOWED_TOOLS.join(","),
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
  const parsed = JSON.parse(body.slice(start, end + 1)) as Partial<NightThinkingReport> & {
    resourcesUsed?: NightThinkingResourcesUsed;
  };
  if (!Array.isArray(parsed.insights)) {
    throw new Error("headless executor: report missing insights array");
  }
  return {
    ...(typeof parsed.answer === "string" && parsed.answer.trim() ? { answer: parsed.answer } : {}),
    insights: parsed.insights,
    plan: Array.isArray(parsed.plan) ? parsed.plan : [],
    trace: Array.isArray(parsed.trace) ? parsed.trace : [],
    ...(parsed.resourcesUsed ? { resourcesUsed: parsed.resourcesUsed } : {}),
  };
}

/**
 * 创建 L2 headless 执行器。spawn 失败 / 超时 / 输出不可解析 → 抛错,
 * 由 Incubator 显式报错(2026-08-17 M2:砍静默降级;仅 spawn ENOENT 环境
 * 缺 claude CLI 时降级 L1,审计如实标注)。
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
      env: process.env,
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
