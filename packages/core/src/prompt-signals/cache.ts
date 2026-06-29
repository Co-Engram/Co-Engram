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
import { EMPTY_PROMPT_SIGNALS } from "./types.js";
import type { PromptSignalBus } from "./event-bus.js";

/**
 * 缓存文件名
 */
export const PROMPT_SIGNALS_FILENAME = "prompt-signals.json";

// ============================================================
// Task 3.4: invalidating cache(事件驱动 debounced 刷新)
// ============================================================

/**
 * PromptSignalCache 配置
 *
 *   - bus:事件源,cache 订阅它的 emit
 *   - rebuild:实际重算 snapshot 的回调(由消费方注入,
 *     通常读 team-memory + computePromptSignals + writePromptSignals)
 *   - debounceMs:事件触发后等多久才真的 rebuild(默认 200ms,
 *     让 burst 事件合并成单次重算)
 *   - initialSnapshot:启动时的初始值(默认 EMPTY_PROMPT_SIGNALS)
 */
export interface PromptSignalCacheOptions {
  readonly bus: PromptSignalBus;
  readonly rebuild: () => Promise<PromptSignalSnapshot>;
  readonly debounceMs?: number;
  readonly initialSnapshot?: PromptSignalSnapshot;
}

/**
 * 事件驱动的 invalidating cache(Task 3.4 root cause AD)
 *
 * 旧实现:prompt-builder 直接读 prompt-signals.json,只在 maintenance light stage
 * 周期跑(默认 5min)时刷新。engram_create / synapse_create / proposal accept 等
 * 操作不会立即触发刷新,导致"刚创建的 engram 没出现在下次 prompt 的 topTags"。
 *
 * 新实现:cache 订阅 PromptSignalBus,任何相关事件都标记 stale + debounced rebuild,
 * 保证下一次 promptBuilder.snapshot() 拿到最新数据。
 *
 * 失败策略:rebuild 抛错时保留旧 snapshot 并清掉 stale 标记(避免无限重试);
 * 调用方可通过 getRevision() 观察是否真的更新过。
 */
export class PromptSignalCache {
  private snapshotValue: PromptSignalSnapshot;
  private revisionValue = 0;
  private staleValue = false;
  private debounceMs: number;
  private readonly rebuildFn: () => Promise<PromptSignalSnapshot>;
  private readonly unsubscribe: () => void;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(opts: PromptSignalCacheOptions) {
    this.snapshotValue = opts.initialSnapshot ?? EMPTY_PROMPT_SIGNALS;
    this.debounceMs = opts.debounceMs ?? 200;
    this.rebuildFn = opts.rebuild;
    this.unsubscribe = opts.bus.on(() => this.handleBusEvent());
  }

  /**
   * 当前 snapshot 引用
   *
   * rebuild 成功后引用会替换,消费方可以用引用相等检测是否需要重读。
   */
  snapshot(): PromptSignalSnapshot {
    return this.snapshotValue;
  }

  /**
   * rebuild 次数(成功才递增)
   *
   * 用于测试断言和监控:revision 没动 = 数据没变。
   */
  getRevision(): number {
    return this.revisionValue;
  }

  /**
   * 是否有事件触发但还未 rebuild 完成
   *
   * true 表示当前 snapshot 可能过时。
   */
  isStale(): boolean {
    return this.staleValue;
  }

  /**
   * 手动触发 rebuild(忽略 stale 状态)
   *
   * 成功 → revision++ + 替换 snapshot + 清 stale;
   * 失败 → 保留旧 snapshot + 清 stale(避免无限重试),不抛错。
   */
  async rebuild(): Promise<void> {
    if (this.disposed) return;
    try {
      const fresh = await this.rebuildFn();
      this.snapshotValue = fresh;
      this.revisionValue += 1;
    } catch {
      // 静默失败:保留旧 snapshot,清 stale 避免下一轮立刻重试
    } finally {
      this.staleValue = false;
    }
  }

  /**
   * 停止接收 bus 事件,清掉 pending timer
   *
   * dispose 后再调用 rebuild() 是 noop,snapshot() 返回最后一次成功的值。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }

  private handleBusEvent(): void {
    if (this.disposed) return;
    this.staleValue = true;
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
    }
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      void this.rebuild();
    }, this.debounceMs);
  }
}

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
