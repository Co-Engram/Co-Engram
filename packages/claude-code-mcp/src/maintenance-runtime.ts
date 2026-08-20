/**
 * Claude Code MCP Maintenance Runtime（P4 D.3）
 *
 * 把 @co-engram/core 的 MaintenanceEngine 桥接到 MCP server 生命周期。
 *
 * 职责：
 *   - 创建 DreamingScheduler + MaintenanceEngine（如果尚未提供）
 *   - 启动 setInterval + unref 自托管调度（不依赖 Claude Code 的 /loop）
 *   - 把 MaintenanceConfig.trash 透传到 scheduler.deepOptions.trash
 *   - 提供 stop() 供宿主在 shutdown 时清理
 *
 * 使用：
 *   const { stop } = startMaintenanceRuntime({ repository, signalSink })
 *   // ... MCP server 运行期间自动维护
 *   process.on('SIGTERM', () => stop())
 *
 * @module @co-engram/claude-code
 */

import {
  MaintenanceEngine,
  createDreamingScheduler,
  type DreamingScheduleConfig,
  type MaintenanceConfig,
  type MaintenanceDeps,
  type TrashMaintenanceConfig,
  type TrashOptions,
} from "@co-engram/core";

/**
 * 把 MaintenanceConfig.trash 转换为 deepOptions.trash 需要的 TrashOptions
 *
 * enabled=false（或未设）→ 返回 undefined,deep 阶段跳过 trash sweep。
 */
function trashToDeepOptions(
  trash: TrashMaintenanceConfig | undefined,
): TrashOptions | undefined {
  if (!trash?.enabled) return undefined;
  return {
    afterDays: trash.afterDays,
    purgeAfterDays: trash.purgeAfterDays,
  };
}

/**
 * 启动维护运行时
 *
 * 如果 deps.dreamingScheduler 未提供,会自动创建一个,并应用 trash 透传。
 *
 * @returns stop 函数（停止所有定时器）
 */
export function startMaintenanceRuntime(
  deps: MaintenanceDeps,
  config: MaintenanceConfig = {},
): { readonly engine: MaintenanceEngine; readonly stop: () => void } {
  const schedulerConfig: DreamingScheduleConfig = {
    lightIntervalMs: config.lightIntervalMs,
    deepIntervalMs: config.deepIntervalMs,
    remIntervalMs: config.remIntervalMs,
    deepOptions: { trash: trashToDeepOptions(config.trash) },
    ...(deps.llmClient ? { llmClient: deps.llmClient } : {}),
    ...(deps.proposalEngine ? { proposalEngine: deps.proposalEngine } : {}),
  };

  const dreamingScheduler =
    deps.dreamingScheduler ??
    createDreamingScheduler(deps.repository, schedulerConfig);

  const engine = new MaintenanceEngine(
    {
      repository: deps.repository,
      signalSink: deps.signalSink,
      dreamingScheduler,
      ...(deps.effectivenessTracker
        ? { effectivenessTracker: deps.effectivenessTracker }
        : {}),
      ...(deps.dataRoot ? { dataRoot: deps.dataRoot } : {}),
      ...(deps.llmClient ? { llmClient: deps.llmClient } : {}),
      ...(deps.proposalEngine ? { proposalEngine: deps.proposalEngine } : {}),
      // S4 Task 2: 注入 skillRepository(供 light stage skill retention 衰退用)
      ...(deps.skillRepository ? { skillRepository: deps.skillRepository } : {}),
      // 沉思孵化器(2026-08-17 重设计):REM 灵感模式消费 queued 条目;
      // 深思由提问动作触发,无排程(旧锚点日调度已移除)
      ...(deps.incubator ? { incubator: deps.incubator } : {}),
    },
    config,
  );

  engine.start();

  return {
    engine,
    stop: () => {
      engine.stop();
    },
  };
}
