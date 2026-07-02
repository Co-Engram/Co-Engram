/**
 * 行为审计日志（Audit Log）
 *
 * 记录 engram 状态变更 + 必要事件,为 co-engram 自身进化提供数据。
 *
 * 当前写入的事件:
 *   - 状态变更: create/update/update_lifecycle/reinforce/report_failure/
 *               forget/restore/sweep_to_trash/restore_from_trash/purge/
 *               propose/accept/dismiss
 *   - 必要性拒绝: necessity_rejected(Layer 2 评估拒绝,需要审计便于调参)
 *   - 冲突标记: contradicted(供 EffectivenessTracker.effectiveness() 派生用)
 *   - git merge driver 事件: merge_resolved(driver 自动解决冲突)/
 *                           merge_backup_failed(输方备份落盘失败)/
 *                           merge_conflict_escalated(driver 留 marker 升级人工)
 *
 * 不再写入的事件(避免淹没 audit.jsonl,详见 effectiveness-tracker.ts):
 *   - noise_filtered(Layer 1 入口拒绝,每条对话消息都会产生)
 *   - retrieve_hit / retrieve_effective / retrieve_inconclusive
 *     (effectiveness 已从 observation-windows.jsonl 派生,无需冗余写 audit)
 *
 * AuditAction 枚举保留这些值以便读旧日志,但新代码不再 append 它们。
 *
 * 存储格式: $DATA_ROOT/.co-engram/audit.jsonl (append-only,gitignored)
 * 每行一个 JSON 对象,~200 字节/条。
 *
 * @module @co-engram/core/observability
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** 审计动作 */
export type AuditAction =
  // 状态变更
  | "create"
  | "update"
  | "update_lifecycle"
  | "reinforce"
  | "report_failure"
  | "forget"
  | "restore"
  | "sweep_to_trash"
  | "restore_from_trash"
  | "purge"
  | "propose"
  | "accept"
  | "dismiss"
  // close_learning_loop 闭环事件(P0-1:此前完全不写 audit)
  | "learning_loop_success"
  | "learning_loop_partial"
  | "learning_loop_failure"
  // 有效性信号(只有 contradicted 仍写入;retrieve_* 不再写,见模块注释)
  | "retrieve_hit"
  | "retrieve_effective"
  | "retrieve_inconclusive"
  | "contradicted"
  // proposal engine 过滤(Layer 1 不再写 audit;Layer 2 必要性拒绝仍写)
  | "noise_filtered"
  | "necessity_rejected"
  // git merge driver 事件(Phase 1 MVP 起)
  | "merge_resolved"
  | "merge_backup_failed"
  | "merge_conflict_escalated"
  // git merge driver LLM 仲裁事件(Phase 3 起,spec §5.5)
  | "merge_llm_arbitrated"
  | "merge_llm_arbitrated_escalated"
  | "merge_llm_arbitrated_failed";

/** 审计行为者 */
export type AuditActor = "user" | "llm" | "system";

/** 单条审计记录 */
export interface AuditEntry {
  /** ISO 时间戳 */
  readonly ts: string;
  /** 触发者 */
  readonly actor: AuditActor;
  /** 动作类型 */
  readonly action: AuditAction;
  /** 相关 engram id(状态变更必填;有效性必填) */
  readonly engramId?: string;
  /** 检索查询(仅 retrieve_* 事件) */
  readonly query?: string;
  /** 检索分数(仅 retrieve_hit) */
  readonly score?: number;
  /**
   * 触发宿主标识(P0-4:此前 AuditActor 只有 user/llm/system,无法区分 claude-code-mcp
   * vs openclaw-plugin)。ToolContext 注入 host 后,所有 append 自动带上,
   * 便于跨宿主行为审计与归因。
   */
  readonly host?: "claude-code-mcp" | "openclaw-plugin" | string;
  /** 任意附加元数据 */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** 查询过滤条件 */
export interface AuditQueryFilter {
  /** 起始时间(包含) */
  readonly since?: string;
  /** 截止时间(不包含) */
  readonly until?: string;
  /** 按 action 过滤(单个或多个) */
  readonly action?: AuditAction | readonly AuditAction[];
  /** 按 engramId 过滤 */
  readonly engramId?: string;
  /** 返回上限(默认 1000) */
  readonly limit?: number;
}

/** 默认 limit */
const DEFAULT_QUERY_LIMIT = 1000;

/**
 * 审计日志
 *
 * 构造时传入 dataRoot,自动确定 audit.jsonl 路径。
 * append 操作是 fire-and-forget,失败不阻塞调用方。
 */
export class AuditLog {
  private readonly filePath: string;

  constructor(dataRoot: string) {
    this.filePath = join(dataRoot, ".co-engram", "audit.jsonl");
  }

  /** 追加一条记录(失败静默) */
  append(entry: Omit<AuditEntry, "ts">): void {
    try {
      const fullEntry: AuditEntry = { ts: new Date().toISOString(), ...entry };
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      appendFileSync(this.filePath, `${JSON.stringify(fullEntry)}\n`, "utf8");
    } catch {
      // intentional:审计失败不应阻塞业务逻辑
    }
  }

  /** 查询历史记录 */
  query(filter: AuditQueryFilter = {}): readonly AuditEntry[] {
    if (!existsSync(this.filePath)) {
      return [];
    }

    const raw = readFileSync(this.filePath, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);

    const actionSet = Array.isArray(filter.action)
      ? new Set(filter.action)
      : filter.action
        ? new Set([filter.action])
        : null;

    const limit = filter.limit ?? DEFAULT_QUERY_LIMIT;

    // 从尾部往前读,优先返回最新记录(常见用例)
    const out: AuditEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      let entry: AuditEntry;
      try {
        entry = JSON.parse(lines[i]!) as AuditEntry;
      } catch {
        continue;
      }

      if (filter.since && entry.ts < filter.since) continue;
      if (filter.until && entry.ts >= filter.until) continue;
      if (actionSet && !actionSet.has(entry.action)) continue;
      if (filter.engramId && entry.engramId !== filter.engramId) continue;

      out.push(entry);
    }

    // 反转回时间正序(便于人类阅读)
    return out.reverse();
  }

  /** 清空所有记录(测试用) */
  clear(): void {
    if (existsSync(this.filePath)) {
      writeFileSync(this.filePath, "", "utf8");
    }
  }

  /** 文件绝对路径(测试/审计用) */
  get path(): string {
    return this.filePath;
  }
}
