/**
 * Prompt signals 缓存文件读写
 *
 * 路径:`<dataRoot>/.co-engram/prompt-signals.json`
 *
 * 与 team-memory/config.json 同目录,但语义不同:
 *   - config.json:用户首次选择(语言/作者),很少变
 *   - prompt-signals.json:light stage 周期性生成,频繁变
 *
 * 失败策略:
 *   - read: 文件不存在或解析失败 → 返回 undefined(首次启动/损坏降级)
 *   - write: 失败抛错(light stage 会捕获并记 log)
 *
 * @module @co-engram/core/prompt-signals
 */

import type { PromptSignalSnapshot } from "./types.js";

/**
 * 缓存文件名
 */
export const PROMPT_SIGNALS_FILENAME = "prompt-signals.json";

/**
 * 读取 prompt signals 缓存
 *
 * @param dataRoot team-memory 根目录
 * @param fsRead 可选的自定义读取函数(测试注入)
 */
export async function readPromptSignals(
  dataRoot: string,
  fsRead?: (path: string) => Promise<string>,
): Promise<PromptSignalSnapshot | undefined> {
  try {
    const path = joinPath(dataRoot, ".co-engram", PROMPT_SIGNALS_FILENAME);
    const content = fsRead ? await fsRead(path) : await defaultReadFile(path);
    const parsed = JSON.parse(content) as PromptSignalSnapshot;
    if (parsed && typeof parsed === "object" && parsed.version === 1) {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 写入 prompt signals 缓存
 *
 * @param dataRoot team-memory 根目录
 * @param signals 完整 snapshot
 * @param fsWrite 可选的自定义写入函数(测试注入)
 */
export async function writePromptSignals(
  dataRoot: string,
  signals: PromptSignalSnapshot,
  fsWrite?: (path: string, content: string) => Promise<void>,
): Promise<void> {
  const path = joinPath(dataRoot, ".co-engram", PROMPT_SIGNALS_FILENAME);
  const content = JSON.stringify(signals, null, 2) + "\n";
  if (fsWrite) {
    await fsWrite(path, content);
    return;
  }
  await defaultWriteFile(path, content);
}

// --- 内部:Node fs 默认实现 ---

async function defaultReadFile(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return await readFile(path, "utf-8");
}

async function defaultWriteFile(path: string, content: string): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
}

function joinPath(...segments: string[]): string {
  return segments.filter(Boolean).join("/").replace(/\/+/g, "/");
}
