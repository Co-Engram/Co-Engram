/**
 * Prompt signals 事件总线(Task 3.4)
 *
 * 15 轮拉通分析 root cause AD「prompt 提示不刷新」的核心修复:
 * 仓库状态变化(engram 创建/验证/reinforce、synapse 创建、proposal 决议、
 * doctor 完成)应触发 prompt-signals 缓存失效并 debounced rebuild,
 * 让下一次 prompt build 看到最新 signals。
 *
 * 设计:
 *   - 基于 Node EventEmitter,零依赖
 *   - 类型安全:event.type 是有限枚举,拼错编译期 fail
 *   - on() 返回 unsubscribe,便于 cache.dispose() 解绑
 *
 * Phase A 只交付原语(event bus + cache class);
 * Phase B 把 emit 点接入 close_learning_loop / synapse_create / repository 等。
 *
 * @module @co-engram/core/prompt-signals
 */

import { EventEmitter } from "node:events";

/**
 * 触发 prompt-signals 失效的事件类型
 *
 * 每种事件对应一个"会改变 topTags / missedTopics / lowConfidenceTopics"的仓库操作:
 *   - engram_created / engram_updated / engram_verified / engram_reinforced /
 *     engram_failed:engram 增删改、验证状态变化、强化或失败信号
 *   - synapse_created:新增 synapse 影响 graph 结构和 domain profile
 *   - proposal_accepted / proposal_dismissed:proposal 决议改变 engram 集合
 *   - doctor_completed:doctor 可能 sweep/forget,engram 集合变化
 */
export type PromptSignalEventType =
  | "engram_created"
  | "engram_updated"
  | "engram_verified"
  | "engram_reinforced"
  | "engram_failed"
  | "synapse_created"
  | "proposal_accepted"
  | "proposal_dismissed"
  | "doctor_completed";

/**
 * 一条 prompt signal 事件
 *
 * engramId 可选:某些事件(如 doctor_completed)不针对单个 engram。
 * at 是 ISO timestamp,由 emit 方填入(便于审计/调试)。
 */
export interface PromptSignalEvent {
  readonly type: PromptSignalEventType;
  readonly engramId?: string;
  readonly at: string;
}

/**
 * Prompt signals 事件总线
 *
 * 用法:
 *   const bus = new PromptSignalBus();
 *   const unsubscribe = bus.on((event) => console.log(event));
 *   bus.emit({ type: "engram_created", engramId: "E1", at: new Date().toISOString() });
 *   unsubscribe();
 */
export class PromptSignalBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // prompt signals 不需要无限 listener,SetMaxListeners 避免开发期警告
    this.emitter.setMaxListeners(20);
  }

  /**
   * 发布事件,同步通知所有订阅者
   *
   * 同步语义让 emit 方能在调试时立刻看到效果;
   * cache 订阅者收到事件后会自己调度 debounced rebuild(异步)。
   */
  emit(event: PromptSignalEvent): void {
    this.emitter.emit("signal", event);
  }

  /**
   * 订阅事件
   *
   * @returns unsubscribe 函数,调用后停止接收事件
   */
  on(handler: (event: PromptSignalEvent) => void): () => void {
    this.emitter.on("signal", handler);
    return () => {
      this.emitter.off("signal", handler);
    };
  }
}

// ============================================================
// Task 3.4 Phase B:进程级 singleton bus
// ============================================================

/**
 * 进程级 singleton PromptSignalBus
 *
 * 设计权衡:
 *   - 选 singleton 而非 DI:repository / proposalEngine / closeLearningLoop
 *     都是高频核心路径,加 bus 参数会污染所有调用方签名。
 *   - 进程内一致即可:prompt-signals 是宿主进程内部的派生缓存,
 *     不跨进程、不持久化,singleton 不会引入全局状态污染问题。
 *   - 测试隔离:resetGlobalPromptSignalBus() 让每个 test 拿干净 bus。
 *
 * 用法:
 *   import { getGlobalPromptSignalBus } from ".../prompt-signals";
 *   getGlobalPromptSignalBus().emit({ type: "engram_created", engramId, at });
 */
let globalPromptSignalBus: PromptSignalBus | null = null;

export function getGlobalPromptSignalBus(): PromptSignalBus {
  if (globalPromptSignalBus === null) {
    globalPromptSignalBus = new PromptSignalBus();
  }
  return globalPromptSignalBus;
}

/**
 * 测试辅助:重置 singleton bus(让每个 test 隔离)
 *
 * 生产代码不应调用。cache.dispose() 不会自动调用此函数——
 * 进程退出即清理,无需手动 reset。
 */
export function resetGlobalPromptSignalBus(): void {
  if (globalPromptSignalBus !== null) {
    globalPromptSignalBus = null;
  }
}

/**
 * 安全 emit:任何异常都吞掉(bus 不应阻塞业务路径)
 *
 * 失败场景:listener 抛错(EventEmitter 默认会 uncaught),bus 写审计落盘失败,等。
 * prompt signals 是派生数据,丢失一次刷新无影响——下次事件触发会再 rebuild。
 */
export function safeEmit(event: PromptSignalEvent): void {
  try {
    getGlobalPromptSignalBus().emit(event);
  } catch {
    // intentional:bus 失败不阻塞业务
  }
}
