/**
 * 默认信号收集器实现
 *
 * - FileSignalSink：JSONL 文件持久化（生产用，路径默认 <dataRoot>/.co-engram/signals.jsonl）
 * - MemorySignalSink：内存数组（测试用，断言方便）
 *
 * 设计：
 *   - append 只追加一行 JSON，不做 fsync（性能优先）
 *   - 事件文件是 append-only 证据日志:drain(维护消费)按 <file>.cursor
 *     游标返回增量并推进水位,不清空文件;snapshot(PDCA 证据)读全部。
 *     2026-08-19 修复:旧实现 drain 读完清空,任何进程的 runLight 都会吃掉
 *     其他进程正在进行的沉思 run 的证据(多进程下「零盘点」必现误拒)
 *   - prune 按年龄收缩体积(读-过滤-重写,不推进游标)
 *
 * 并发:append 多进程安全(O_APPEND 追加);drain/prune 消费方为 processLock
 * holder 单进程;prune 重写的读-写竞态窗口为毫秒级(已知限制,派生数据可容忍)。
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
  /** 消费游标文件(持久化 maxAt 水位;与事件文件一一对应) */
  private readonly cursorPath: string;
  private readonly buffer: ToolCallEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly flushIntervalMs: number;
  private readonly flushThreshold: number;

  constructor(options: FileSignalSinkOptions) {
    this.filePath = options.filePath;
    this.cursorPath = `${options.filePath}.cursor`;
    this.flushIntervalMs = options.flushIntervalMs ?? 5_000;
    this.flushThreshold = options.flushThreshold ?? 50;
    // 兼容保留(2026-08-19 write-through 后不再使用 buffer 批量路径);
    // 注册仍保留以便旧 subclass 行为不破
    activeSinks.add(this);
    registerGlobalExitHandlerOnce();
  }

  /**
   * write-through(2026-08-19 跨进程证据延迟修复):事件同步追加落盘。
   *
   * 此前 buffer(5s interval / 50 条阈值)批量 flush 在同进程内无害 ——
   * 但 headless 沉思(auto 模式)的工具调用事件写在 headless MCP server
   * 进程的 buffer 里,而 Incubator(report 所在进程)的 flush 只能刷
   * 本进程 buffer:executor 返回后立即 report(≪ 5s)→ 事件仍在异进程
   * buffer → PDCA 时间窗内零证据 → 每次 headless run 必现「零盘点」
   * 误拒。工具调用是交互级低频操作,同步追加的可靠性 > 批量性能;
   * flushThreshold / flushIntervalMs 配置字段保留(向后兼容,不再生效)。
   */
  append(event: ToolCallEvent): void {
    const line = JSON.stringify(event) + "\n";
    try {
      const fd = openSync(this.filePath, "a");
      try {
        writeFileSync(fd, line, "utf8");
      } finally {
        closeSync(fd);
      }
    } catch {
      // 与旧 flush 同款容错:目录被删等场景丢弃该行,不阻塞工具调用
    }
  }

  drain(): readonly ToolCallEvent[] {
    // 同步 flush 缓冲，再读取整个文件
    this.flushSync();
    const events = this.readAll();
    // 消费游标化(2026-08-19 P0 修复):signals.jsonl 同时承担两种角色 ——
    // 维护引擎的消费队列(drain)与沉思 PDCA 的证据日志(snapshot)。旧实
    // 现 drain 读完清空文件:任何进程的 runLight(默认 5 分钟)都会吃掉
    // **全部**事件,包括其他进程正在进行的沉思 run 的证据(实测:12 分钟
    // run 内被清空 ≥3 次,PDCA 判「零盘点」误拒)。修复:文件改 append-only
    // 证据日志,drain 按游标(<file>.cursor 持久化 maxAt 水位)返回增量并
    // 推进水位,**不再清空**。消费方(maintenance)是 processLock holder 单
    // 进程,游标单写者;holder 切换瞬间的双消费窗口与旧实现同级,已知限制。
    const cursor = this.readCursor(events);
    const fresh = events.filter((e) => e.at > cursor);
    const maxAt = events.length ? Math.max(...events.map((e) => e.at)) : cursor;
    this.writeCursor(maxAt);
    return fresh;
  }

  /**
   * 快照读取(PDCA 闭合证据用,2026-08-18):flush 缓冲后读全部事件,
   * **不截断文件** —— 与 drain 的消费语义不同,维护引擎的信号消费不受
   * 影响。2026-08-19 起 drain 也不再清空文件(游标消费),跨进程 drain
   * 不会再吃掉本进程 run 的证据;残余限制见 prune 注释(毫秒级重写窗口)。
   */
  snapshot(): readonly ToolCallEvent[] {
    this.flushSync();
    return this.readAll();
  }

  /** 读全文件解析为事件(drain/snapshot 共用;文件不存在或空 → []) */
  private readAll(): ToolCallEvent[] {
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
    return events;
  }

  async prune(olderThanMs: number): Promise<void> {
    // 体积收缩(2026-08-19 与 drain 游标化配套):按年龄删旧事件,**只读
    // 不消费**(不推进游标;也不再经 drain —— 旧实现 prune 内调 drain 会
    // 把未消费事件标记为已消费后丢弃)。证据时间窗(分钟级)≪ 收缩年龄
    // (天级),活跃证据不会被误删。重写的读-写竞态窗口为毫秒级(期间其
    // 他进程 append 的极端交错可能丢行),对比修复前的 5 分钟级全清是量级
    // 改善;信号是派生数据,残余风险可接受。
    const cutoff = Date.now() - olderThanMs;
    const events = this.readAll();
    const kept = events.filter((e) => e.at >= cutoff);
    if (kept.length === 0) {
      if (existsSync(this.filePath)) writeFileSync(this.filePath, "", "utf8");
      return;
    }
    if (kept.length === events.length) return; // 无过期事件:避免无谓重写放大竞态窗口
    const lines = kept.map((e) => JSON.stringify(e)).join("\n");
    writeFileSync(this.filePath, lines + "\n", "utf8");
  }

  /** 消费游标读(<file>.cursor 持久化 maxAt);缺失(升级首跑)= 存量视为已消费,不重放 */
  private readCursor(events: readonly ToolCallEvent[]): number {
    try {
      const raw = readFileSync(this.cursorPath, "utf8").trim();
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch {
      // 无游标文件(升级首跑):把现有存量标记为已消费(旧清空语义下这些
      // 事件大概率已被消费过;重放会导致一轮重复强化),游标从存量顶部开始
      return events.length ? Math.max(...events.map((e) => e.at)) : 0;
    }
  }

  private writeCursor(maxAt: number): void {
    try {
      writeFileSync(this.cursorPath, String(maxAt), "utf8");
    } catch {
      // 游标写失败(目录被删等):下次 drain 重放本段 —— 重复消费优于丢证据
    }
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

  /** 查看当前缓冲（不消费）;与 FileSignalSink.snapshot 对齐(PDCA 证据契约) */
  peek(): readonly ToolCallEvent[] {
    return [...this.events];
  }

  snapshot(): readonly ToolCallEvent[] {
    return this.peek();
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
