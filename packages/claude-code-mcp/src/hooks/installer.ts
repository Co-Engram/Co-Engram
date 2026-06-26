/**
 * Claude Code settings.json 自动 patch
 *
 * 启动时检测 ~/.claude/settings.json 是否已挂 co-engram observe hook,
 * 若未挂则幂等注入。设计原则:
 *   - 只动 hooks.UserPromptSubmit / hooks.Stop 两个字段,以及 env.CO_ENGRAM_VIEWER_URL
 *   - 已存在(命令字符串包含 observe.py)则跳过,绝不重复添加
 *   - 写回失败时保留原文件,只打印 stderr,不阻塞 MCP server 启动
 *   - 完全透明:每次 patch 都打印日志,不"偷偷"修改
 *
 * @module @co-engram/claude-code/hooks/installer
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * hook 脚本识别标记(用于幂等判断)。
 *
 * 用 `observe.py` 而非更具体的 `hooks/observe.py`,以便在用户曾手动配置过
 * 旧路径(如 `~/bin/co-engram-observe.py`)时也能识别并自动迁移到包内路径。
 * 副作用是任何名为 observe.py 的脚本都会被识别——这是可接受的,因为该名字
 * 在 Claude Code hook 生态里基本只被 co-engram 使用。
 */
export const HOOK_MARKER = "observe.py";

/**
 * observe hook 需要 viewer URL 才能找到 proposal engine 的 /api/observe。
 *
 * 默认 18799 与 viewer 默认端口对齐;若 viewer 启动在非默认端口,installer
 * 会把真实 URL 注入 settings.json 的 env 块,确保 hook 子进程能拿到。
 */
export const DEFAULT_VIEWER_URL = "http://127.0.0.1:18799";

/**
 * 解析 hook 脚本的绝对路径(dist/hooks/observe.py)
 *
 * 用 import.meta.url 反推,在打包后(npm install)也能正确定位。
 */
export function resolveHookScriptPath(): string {
  // dist/hooks/installer.js → dist/hooks/observe.py
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "observe.py");
}

/**
 * Claude Code 用户 settings.json 路径
 *
 * 默认 ~/.claude/settings.json,可被 CO_ENGRAM_CLAUDE_SETTINGS_PATH 覆盖
 * (用于测试或非标准安装位置)。
 */
export function resolveSettingsPath(): string {
  const override = process.env.CO_ENGRAM_CLAUDE_SETTINGS_PATH;
  if (override) return override;
  const home = process.env.HOME ?? "/tmp";
  return join(home, ".claude", "settings.json");
}

/**
 * 检测 settings.json 是否已挂 co-engram hook
 *
 * 判断标准:UserPromptSubmit 或 Stop 任一 hook 列表里存在 command 含 HOOK_MARKER 的 entry。
 */
export function isHookInstalled(settings: unknown): boolean {
  if (typeof settings !== "object" || settings === null) return false;
  const hooks = (settings as { hooks?: Record<string, unknown> }).hooks;
  if (!hooks || typeof hooks !== "object") return false;

  for (const eventName of ["UserPromptSubmit", "Stop"] as const) {
    const entries = hooks[eventName];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const innerHooks = (entry as { hooks?: unknown[] }).hooks;
      if (!Array.isArray(innerHooks)) continue;
      for (const h of innerHooks) {
        if (typeof h !== "object" || h === null) continue;
        const cmd = (h as { command?: string }).command;
        if (typeof cmd === "string" && cmd.includes(HOOK_MARKER)) return true;
      }
    }
  }
  return false;
}

/**
 * 把 co-engram hook 注入 settings 对象(纯函数,不写文件)
 *
 * 策略:幂等 + 自迁移。每次都先移除所有匹配 marker 的旧 entry(无论路径),
 * 然后添加一条指向当前 hookScriptPath 的新 entry。同时把 viewerUrl 写入
 * settings.env.CO_ENGRAM_VIEWER_URL(hook 子进程靠这个找 viewer)。
 *
 * 行为矩阵:
 *   - 首次:添加新 hooks + 写 env,changed=true
 *   - 二次(hook 路径 + viewer URL 都一致):changed=false
 *   - 路径迁移(旧 ~/bin/co-engram-observe.py → 新 dist/hooks/observe.py):
 *     移除旧的 + 添加新的 + 同步 env,changed=true
 *   - viewer 端口变更(env.CO_ENGRAM_VIEWER_URL 与目标不同):更新 env,changed=true
 *
 * changed 通过"目标 hook 是否已在期望位置 + env 是否正确"判断,避免每次启动都重写文件。
 */
export function injectHooks(
  settings: unknown,
  hookScriptPath: string,
  viewerUrl: string = DEFAULT_VIEWER_URL,
): {
  readonly settings: unknown;
  readonly changed: boolean;
} {
  const base = (
    typeof settings === "object" && settings !== null ? settings : {}
  ) as Record<string, unknown>;
  const hooks = (
    base.hooks && typeof base.hooks === "object"
      ? { ...(base.hooks as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;
  const env = (
    base.env && typeof base.env === "object"
      ? { ...(base.env as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;

  const targetUserCmd = `${hookScriptPath} user`;
  const targetAssistantCmd = `${hookScriptPath} assistant`;

  // hook 路径是否已是期望状态
  const currentUserCmds = extractMatchingCommands(hooks.UserPromptSubmit);
  const currentAssistantCmds = extractMatchingCommands(hooks.Stop);
  const hooksCorrect =
    currentUserCmds.length === 1 &&
    currentUserCmds[0] === targetUserCmd &&
    currentAssistantCmds.length === 1 &&
    currentAssistantCmds[0] === targetAssistantCmd;

  // env 是否已是期望状态(只在 viewerUrl 非 default 时强制写入;
  // default 时也写,确保 hook 默认能找到 viewer)
  const envCorrect = env.CO_ENGRAM_VIEWER_URL === viewerUrl;

  if (hooksCorrect && envCorrect) {
    return { settings: base, changed: false };
  }

  let nextHooks = hooks;
  if (!hooksCorrect) {
    const cleanedUps = removeAllMatching(hooks.UserPromptSubmit);
    const cleanedStop = removeAllMatching(hooks.Stop);
    cleanedUps.push({
      hooks: [{ type: "command", command: targetUserCmd, async: true }],
    });
    cleanedStop.push({
      hooks: [{ type: "command", command: targetAssistantCmd, async: true }],
    });
    nextHooks = { ...hooks, UserPromptSubmit: cleanedUps, Stop: cleanedStop };
  }

  const nextEnv = envCorrect
    ? env
    : { ...env, CO_ENGRAM_VIEWER_URL: viewerUrl };

  return {
    settings: { ...base, hooks: nextHooks, env: nextEnv },
    changed: true,
  };
}

/** 从某个 hook 事件列表里提取所有匹配 HOOK_MARKER 的 command 字符串 */
function extractMatchingCommands(entries: unknown): readonly string[] {
  if (!Array.isArray(entries)) return [];
  const out: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const innerHooks = (entry as { hooks?: unknown[] }).hooks;
    if (!Array.isArray(innerHooks)) continue;
    for (const h of innerHooks) {
      if (typeof h !== "object" || h === null) continue;
      const cmd = (h as { command?: string }).command;
      if (typeof cmd === "string" && cmd.includes(HOOK_MARKER)) out.push(cmd);
    }
  }
  return out;
}

/** 从某个 hook 事件列表里移除所有匹配 HOOK_MARKER 的 inner hook,保留其他 inner hook
 *  以及不含 marker 的整个 entry。
 *
 * 行为矩阵:
 *   - entry 只有我们的 marker hooks → 整个 entry 移除(避免留下空 entry)
 *   - entry 同时有用户 hook 和我们的 marker hook → 仅剔除 marker inner hook,
 *     保留用户的 hook(历史上用户曾手动把多个 hook 合并到一个 entry,
 *     旧实现的 every() 检查会因用户 hook 不匹配而保留整个 entry,
 *     再加上我们 push 的新 entry → 同一 marker 出现 2 次,流量翻倍)
 *   - entry 没有任何 marker hook → 原样保留
 */
function removeAllMatching(entries: unknown): unknown[] {
  if (!Array.isArray(entries)) return [];
  const result: unknown[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      // 非对象 entry 不动(可能是用户错误配置)
      result.push(entry);
      continue;
    }
    const entryObj = entry as { hooks?: unknown[]; [k: string]: unknown };
    const innerHooks = entryObj.hooks;
    if (!Array.isArray(innerHooks)) {
      // 没有 hooks 字段或格式不对 → 原样保留,不动用户配置
      result.push(entry);
      continue;
    }
    // 只保留 inner hooks 里 *不* 匹配 marker 的
    const keptInner = innerHooks.filter((h) => {
      if (typeof h !== "object" || h === null) return true;
      const cmd = (h as { command?: string }).command;
      return !(typeof cmd === "string" && cmd.includes(HOOK_MARKER));
    });
    if (keptInner.length === 0) {
      // 整个 entry 都是 marker hooks → 丢弃空 entry
      continue;
    }
    if (keptInner.length === innerHooks.length) {
      // 没有 marker hook → 原样保留(避免不必要的对象重建)
      result.push(entry);
      continue;
    }
    // 有混合:保留 entry,但 hooks 字段缩减
    result.push({ ...entryObj, hooks: keptInner });
  }
  return result;
}

/**
 * 主入口:确保 hook 脚本存在 + 可执行,settings.json 已挂 hook
 *
 * 行为:
 *   1. 检查 hook 脚本是否存在,不存在 → 直接返回(包安装异常)
 *   2. 确保 hook 脚本可执行(chmod +x)
 *   3. 读 settings.json(不存在视为 {})
 *   4. JSON parse;失败 → stderr 报错,不动文件
 *   5. 已挂 → 跳过
 *   6. 注入 + 写回(保留 2 空格 indent)
 *
 * 任何错误都不抛,只 stderr 提示——MCP server 启动不能被 hook 安装阻塞。
 */
export function ensureClaudeCodeHooksInstalled(
  options: {
    readonly log?: (msg: string) => void;
    readonly viewerUrl?: string;
  } = {},
): void {
  const log =
    options.log ?? ((msg: string) => process.stderr.write(msg + "\n"));
  const viewerUrl = options.viewerUrl ?? DEFAULT_VIEWER_URL;

  const hookScriptPath = resolveHookScriptPath();
  if (!existsSync(hookScriptPath)) {
    log(
      `[co-engram] hook script not found at ${hookScriptPath}, skipping settings patch`,
    );
    return;
  }

  // 确保可执行
  try {
    chmodSync(hookScriptPath, 0o755);
  } catch {
    // chmod 失败不阻塞(Windows 上是 no-op)
  }

  const settingsPath = resolveSettingsPath();

  // 读现有 settings
  let raw = "{}";
  if (existsSync(settingsPath)) {
    try {
      raw = readFileSync(settingsPath, "utf8");
    } catch (err) {
      log(
        `[co-engram] failed to read ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
  }

  let parsed: unknown;
  try {
    parsed = raw.trim().length === 0 ? {} : JSON.parse(raw);
  } catch (err) {
    log(
      `[co-engram] ${settingsPath} is not valid JSON, skipping (manual fix required)`,
    );
    log(
      `[co-engram] parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const { settings: next, changed } = injectHooks(
    parsed,
    hookScriptPath,
    viewerUrl,
  );
  if (!changed) {
    // 已挂,静默(避免每次启动都刷屏)
    return;
  }

  // 写回前确保父目录存在
  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(next, null, 2) + "\n", "utf8");
    log(`[co-engram] auto-installed Claude Code hooks into ${settingsPath}`);
    log(`[co-engram]   - UserPromptSubmit → ${hookScriptPath} user`);
    log(`[co-engram]   - Stop            → ${hookScriptPath} assistant`);
    log(`[co-engram]   - env.CO_ENGRAM_VIEWER_URL = ${viewerUrl}`);
    log(`[co-engram] restart Claude Code for hooks to take effect`);
  } catch (err) {
    log(
      `[co-engram] failed to write ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
