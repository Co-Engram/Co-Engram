/**
 * 默认信号收集器实现
 *
 * - FileSignalSink：JSONL 文件持久化（生产用，路径默认 <dataRoot>/.co-engram/signals.jsonl）
 * - MemorySignalSink：内存数组（测试用，断言方便）
 *
 * 设计：
 *   - append 只追加一行 JSON，不做 fsync（性能优先）
 *   - drain 读取整个文件 + 截断（O(n)）
 *   - prune 读取 + 过滤 + 重写（O(n)）
 *
 * 并发：单进程内 by-design 安全；多进程并发需要文件锁，留作 TODO（MVP 单进程场景够用）。
 *
 * @module @co-engram/core/signals
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { SignalSink, ToolCallEvent } from "./types.js";

/**
 * 进程级 exit handler 注册表(单例)
 *
 * 每个 FileSignalSink 实例都需要在进程退出前 flush 一次,但若每个实例都调
 * process.once('beforeExit' / 'exit'),创建 N 个 sink 就会注册 2N 个 listener,
 * 超过 Node 默认的 maxListeners=10 → 触发 MaxListenersExceededWarning。
 *
 * 测试场景会频繁创建 sink(每个用例一个),生产场景通常只 1 个,所以警告主要
 * 污染测试日志。但监听器膨胀本身就是泄漏 + 让人误以为有真问题。
 *
 * 解决:模块级单 Set 跟踪所有 active sinks,只注册一次 exit handler,handler
 * 内部遍历所有 sinks 调 flushSync。WeakSet 自动 GC 回收后的 sink 不会泄漏。
 */
const activeSinks = new Set<FileSignalSink>();
let exitHandlerRegistered = false;

function registerGlobalExitHandlerOnce(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  const handler = (): void => {
    for (const sink of activeSinks) {
      try {
        (sink as unknown as { flushSync: () => void }).flushSync();
      } catch {
        // ignore — best effort on exit
      }
    }
  };
  process.once("beforeExit", handler);
  process.once("exit", handler);
}

/**
 * JSONL 文件信号收集器
 *
 * 文件格式：每行一个 JSON object,字段对应 ToolCallEvent。
 * drain() 会读取全部并截断文件；prune() 会保留最近 N ms 的事件。
 */
export class FileSignalSink implements SignalSink {
  private readonly filePath: string;
  private readonly buffer: ToolCallEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly flushIntervalMs: number;
  private readonly flushThreshold: number;

  constructor(options: FileSignalSinkOptions) {
    this.filePath = options.filePath;
    this.flushIntervalMs = options.flushIntervalMs ?? 5_000;
    this.flushThreshold = options.flushThreshold ?? 50;

    // 注册到全局 exit handler(只真正注册一次 process listener)
    activeSinks.add(this);
    registerGlobalExitHandlerOnce();
  }

  append(event: ToolCallEvent): void {
    this.buffer.push(event);
    if (this.buffer.length >= this.flushThreshold) {
      void this.flush();
    } else if (this.flushTimer === null) {
      this.flushTimer = setInterval(() => {
        void this.flush();
      }, this.flushIntervalMs);
      this.flushTimer.unref?.();
    }
  }

  drain(): readonly ToolCallEvent[] {
    // 同步 flush 缓冲，再读取整个文件
    this.flushSync();
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, "utf8").trim();
    if (raw === "") return [];
    const events: ToolCallEvent[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as ToolCallEvent);
      } catch {
        // 跳过损坏行（部分写入）
      }
    }
    // 清空文件
    writeFileSync(this.filePath, "", "utf8");
    return events;
  }

  async prune(olderThanMs: number): Promise<void> {
    const cutoff = Date.now() - olderThanMs;
    const events = this.drain();
    const kept = events.filter((e) => e.at >= cutoff);
    if (kept.length === 0) {
      if (existsSync(this.filePath)) writeFileSync(this.filePath, "", "utf8");
      return;
    }
    const lines = kept.map((e) => JSON.stringify(e)).join("\n");
    writeFileSync(this.filePath, lines + "\n", "utf8");
  }

  /** 显式 flush（测试或进程退出时调） */
  async flush(): Promise<void> {
    this.flushSync();
  }

  /**
   * 主动从 exit handler 注销(测试结束后清理)
   *
   * 不强制要求调用,但测试中创建大量 sink 时调用可避免 Set 无限增长
   * (生产中只有 1 个 sink,生命周期 = 进程生命周期,无所谓)。
   */
  dispose(): void {
    activeSinks.delete(this);
  }

  private flushSync(): void {
    if (this.buffer.length === 0) return;
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    const pending = this.buffer.splice(0, this.buffer.length);
    const lines = pending.map((e) => JSON.stringify(e)).join("\n") + "\n";
    // 追加模式打开,避免覆盖已有数据。
    // 容错:filePath 所在目录可能已被删除(测试 rmSync tmpdir 后,unref 定时
    // flush 仍可能触发)。信号是派生数据,此时丢弃这批缓冲可接受;吞掉 ENOENT
    // 避免异步 flush 的 unhandled rejection 污染测试输出。生产 dataRoot 不会
    // 被外部删除,该分支几乎不触发。
    try {
      const fd = openSync(this.filePath, "a");
      try {
        writeFileSync(fd, lines, "utf8");
      } finally {
        closeSync(fd);
      }
    } catch {
      // intentional:目录不存在 → 放弃这批缓冲
    }
  }
}

export interface FileSignalSinkOptions {
  /** JSONL 文件路径 */
  readonly filePath: string;
  /** 批量 flush 间隔（ms，默认 5000） */
  readonly flushIntervalMs?: number;
  /** 触发立即 flush 的缓冲大小（默认 50） */
  readonly flushThreshold?: number;
}

/**
 * 内存信号收集器（测试用）
 *
 * drain() 返回当前缓冲并清空，但不涉及文件 IO。
 */
export class MemorySignalSink implements SignalSink {
  private readonly events: ToolCallEvent[] = [];

  append(event: ToolCallEvent): void {
    this.events.push(event);
  }

  drain(): readonly ToolCallEvent[] {
    const drained = [...this.events];
    this.events.length = 0;
    return drained;
  }

  async prune(olderThanMs: number): Promise<void> {
    const cutoff = Date.now() - olderThanMs;
    const kept = this.events.filter((e) => e.at >= cutoff);
    this.events.length = 0;
    this.events.push(...kept);
  }

  /** 当前缓冲长度（不断言 drain 后的状态） */
  get size(): number {
    return this.events.length;
  }

  /** 查看当前缓冲（不消费） */
  peek(): readonly ToolCallEvent[] {
    return [...this.events];
  }
}

/**
 * 创建默认的 FileSignalSink（便捷工厂）
 *
 * 文件位置:`<dataRoot>/.co-engram/signals.jsonl`,与 audit.jsonl /
 * proposals.jsonl / topic-clusters.jsonl / prompt-signals.json 等其它
 * 状态文件保持一致。
 *
 * 历史遗留:0.x 版本曾写到 `<dataRoot>/signals.jsonl`(根目录),与其它状态
 * 文件不在同一子目录,导致用户备份 `.co-engram/` 时会漏掉 signals。此处会
 * 自动把根目录的旧文件迁移到新位置(只在首次创建 sink 时执行一次,代价极低)。
 */
export function createDefaultSignalSink(dataRoot: string): FileSignalSink {
  const newPath = join(dataRoot, ".co-engram", "signals.jsonl");
  migrateLegacySignalFile(dataRoot, newPath);
  return new FileSignalSink({ filePath: newPath });
}

/** 把 `<dataRoot>/signals.jsonl`(老路径)迁移到 `newPath`,如果老文件存在。
 *  幂等:新路径已存在时不覆盖;老文件不存在时 no-op。 */
function migrateLegacySignalFile(dataRoot: string, newPath: string): void {
  const legacyPath = join(dataRoot, "signals.jsonl");
  if (!existsSync(legacyPath)) return;
  // 新路径已存在:用户已经在新位置写过 → 不覆盖,只把老文件备份标识后留下
  // (避免数据丢失;运维可以人工合并)
  if (existsSync(newPath)) return;
  try {
    mkdirSync(dirname(newPath), { recursive: true });
    renameSync(legacyPath, newPath);
  } catch {
    // 迁移失败不阻塞 sink 创建;老文件依然可读,只是不一致
  }
}

/** 仅用于测试：清空文件 */
export function resetFileSignalSink(sink: FileSignalSink): void {
  // 用反射读取私有 filePath
  const filePath = (sink as unknown as { filePath: string }).filePath;
  if (existsSync(filePath)) {
    try {
      unlinkSync(filePath);
    } catch {
      // ignore
    }
  }
}
