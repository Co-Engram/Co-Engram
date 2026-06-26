/**
 * 行为信号数据模型（P4 自动维护服务 A 层）
 *
 * 从工具调用事件流中提取 implicit behavioral signals,不依赖 agent 主动上报。
 *
 * 数据流：
 *   tools/*.execute → ctx.signalSink.append(ToolCallEvent)
 *                  → signals.jsonl(JSONL, <dataRoot>/.co-engram/)
 *   engine.runLight → sink.drain() → extractSignals(events) → BehavioralSignal[]
 *
 * @module @co-engram/core/signals
 */

/**
 * 一次工具调用事件（recorded for later signal extraction）
 *
 * 写入时机：tools/wrapped.ts 包裹的 execute 在返回前 append。
 * 写入是非阻塞的（fire-and-forget），失败不影响工具调用本身。
 */
export interface ToolCallEvent {
  /** 工具名（engram_get / engram_search / synapse_create ...） */
  readonly toolName: string;
  /** 工具入参（只保留可序列化字段） */
  readonly input: Readonly<Record<string, unknown>>;
  /** 输出摘要（避免把整个 engram content 塞进事件流） */
  readonly outputSummary?: string;
  /** 工具结果涉及的 engram id 列表（如 engram_get 的返回 id、engram_search 的 hits） */
  readonly retrievedEngramIds?: readonly string[];
  /** 会话 id（每次工具调用生成新 UUID；extract 用 sliding window 替代会话边界） */
  readonly sessionId: string;
  /** 触发时间（epoch ms） */
  readonly at: number;
}

/**
 * 行为信号（从 ToolCallEvent 流提取的"这条 engram 有多被信任/有用"的归一化打分）
 *
 * weight ∈ [-1, 1]：
 *   - 正值：engram 被认为有用（强正 ≥ 0.6、弱正 0.2-0.5）
 *   - 负值：engram 被认为失败/错误（强负 ≤ -0.6、弱负 -0.2 - -0.5）
 *   - 0：中性，通常不产生
 */
export interface BehavioralSignal {
  /** 关联的 engram id */
  readonly engramId: string;
  /** 权重 [-1, 1] */
  readonly weight: number;
  /** 来源规则名（extract.ts 的 Rule.name） */
  readonly source: string;
  /** 证据（用于审计：触发事件、窗口大小、命中字段等） */
  readonly evidence: Readonly<Record<string, unknown>>;
  /** 触发事件所属的 sessionId */
  readonly sessionId: string;
  /** 信号生成时间（epoch ms） */
  readonly at: number;
}

/**
 * 信号收集器接口
 *
 * 宿主负责实现，core 提供默认 FileSignalSink(JSONL) 和 MemorySignalSink(测试用)。
 */
export interface SignalSink {
  /**
   * 追加一次工具调用事件
   *
   * 实现必须容忍失败（文件锁、磁盘满等），不应阻塞工具调用本身。
   */
  append(event: ToolCallEvent): Promise<void> | void;

  /**
   * 取出全部事件并清空内部缓冲
   *
   * 维护引擎 runLight 会调用此方法，拿到自上次维护以来的事件流。
   */
  drain(): readonly ToolCallEvent[];

  /**
   * 修剪过期事件
   *
   * 默认保留 7 天（runLight 末尾调用）。
   */
  prune(olderThanMs: number): Promise<void> | void;
}
