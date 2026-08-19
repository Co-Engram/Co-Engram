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
 *   - maintenance 触发: maintenance_run(仅 rem/daily 写入,供用户查 "REM 跑过吗")
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
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { TeamEventRecorder } from "./team-event-store.js";

/** 审计动作 */
export type AuditAction =
  // 状态变更
  | "create"
  | "update"
  | "update_lifecycle"
  | "reinforce"
  | "report_failure"
  // D1:统一 importance 变更事件(reinforce / report_failure 工具改写此 action)
  | "importance_update"
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
  | "merge_llm_arbitrated_failed"
  // maintenance 阶段触发(仅 rem/daily 低频 stage 写入;light/deep 太频繁会变噪音)
  | "maintenance_run"
  // skill 记忆系统事件(S6 Task 4 起)
  | "skill_create"
  | "skill_update"
  | "skill_delete"
  | "skill_invoke"
  | "skill_compose_add"
  | "skill_compose_remove"
  | "skill_related_engram_add"
  | "skill_related_engram_remove";

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

/** append 背压冷却(1h):防上限边界反复轮转 */
const BACKPRESSURE_COOLDOWN_MS = 60 * 60 * 1000;

/** 自动轮转启动首跑延迟(30s):避开进程启动 IO 高峰 */
const FIRST_ROTATION_DELAY_MS = 30_000;

/**
 * 审计日志
 *
 * 构造时传入 dataRoot,自动确定 audit.jsonl 路径。
 * append 操作是 fire-and-forget,失败不阻塞调用方。
 */
export class AuditLog {
  private readonly filePath: string;
  /**
   * 自动轮转参数(startAutoRotation 注入;append 背压依赖)。
   * 未启用轮转(rotation.enabled=false)时为 undefined —— append 不私自删数据,
   * 尊重「用户明确关闭轮转」的语义。
   */
  private autoRotationOpts:
    | { readonly retentionDays: number; readonly highValueRetentionDays: number; readonly maxSizeMb: number }
    | undefined;
  /** 背压冷却:上次 append 触发轮转的时间戳(防边界震荡) */
  private lastBackpressureAt = 0;
  /**
   * 团队动态事件出口(2026-08-19):宿主装配 TeamEventStore 后,append 自动
   * 双写——本地 audit.jsonl 照旧,高价值动作另落 events/ 分片随 git 同步。
   * 接口解耦(TeamEventRecorder),本模块不依赖具体实现,无循环引用。
   */
  private teamEventRecorder?: TeamEventRecorder;

  constructor(dataRoot: string) {
    this.filePath = join(dataRoot, ".co-engram", "audit.jsonl");
  }

  /** 注入团队动态事件出口(幂等;不注入则 append 行为与历史版本一致) */
  setTeamEventRecorder(recorder: TeamEventRecorder): void {
    this.teamEventRecorder = recorder;
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
      // 团队事件转发在本地写入成功之后(本地审计优先;转发内部自带过滤与静默)
      this.teamEventRecorder?.record(fullEntry);
      this.maybeBackpressureRotate();
    } catch {
      // intentional:审计失败不应阻塞业务逻辑
    }
  }

  /**
   * append 侧背压(2026-08-16):文件超上限 ×1.1 且冷却期外 → 排队一次异步轮转。
   *
   * 背景:轮转 interval 默认 24h 且无首跑时,短命进程(daemon 重启间隙的 stdio
   * 连接)永远轮转不到,audit.jsonl 曾涨到 106MB。背压让「高频写入进程」自己
   * 兜底上限。触发线 1.1×maxSizeMb 留 buffer 防边界反复轮转;冷却 1h;
   * setTimeout 异步执行不阻塞 append 返回(轮转含全量 IO)。
   */
  private maybeBackpressureRotate(): void {
    const opts = this.autoRotationOpts;
    if (!opts) return;
    const now = Date.now();
    if (now - this.lastBackpressureAt < BACKPRESSURE_COOLDOWN_MS) return;
    const maxBytes = opts.maxSizeMb * 1024 * 1024;
    let size = 0;
    try {
      size = this.statSize();
    } catch {
      return;
    }
    if (size <= maxBytes * 1.1) return;
    this.lastBackpressureAt = now;
    const tick = (): void => {
      try {
        const r = this.rotate(opts);
        if (r.droppedCount > 0) {
          process.stderr.write(
            `[co-engram] audit backpressure rotation: dropped ${r.droppedCount} entries ` +
              `(${r.originalSize} → ${r.newSize} bytes)\n`,
          );
        }
      } catch {
        // fail-soft
      }
    };
    const h = setTimeout(tick, 0);
    if (typeof h.unref === "function") h.unref();
  }

  /**
   * 查询历史记录(流式读 + ring buffer)
   *
   * 性能修复(2026-07):旧实现 readFileSync 全文 + split 全部行,内存峰值 = 整个
   * audit.jsonl 大小(50MB 量级),让 viewer event loop 完全卡死。新实现用
   * readSync 流式读 + 环形缓冲,内存峰值 = limit 条 entries(~200KB @ limit=1000)。
   *
   * 算法:顺序扫描文件,符合 filter 的 entry push 到 ringBuf;长度超过 limit 时
   * 丢弃最旧。扫完后 ringBuf 是时间正序(append 顺序 = 文件顺序 = 写入时间正序)。
   *
   * **返回顺序契约**(2026-07 修复):返回时间正序(旧→新)。
   * - `engram_audit_query` 工具 doc 明确 "items 按时间正序",直接返回给用户。
   * - viewer `/api/audit` 用 `paginateWithCursor({ descending: true })` 自带排序,
   *   不依赖 query 的返回顺序。
   * 旧实现错误地 `ringBuf.reverse()` 返回逆序,导致工具契约违反。
   *
   * 边界:跨 chunk 的不完整行用 pendingLine 拼接;末尾无 \n 的最后一行单独处理。
   * ringBuf.shift() 是 O(limit),但 audit.jsonl 行数有限(几千~几十万),整体可接受。
   */
  query(filter: AuditQueryFilter = {}): readonly AuditEntry[] {
    if (!existsSync(this.filePath)) {
      return [];
    }

    const actionSet = Array.isArray(filter.action)
      ? new Set(filter.action)
      : filter.action
        ? new Set([filter.action])
        : null;

    const limit = filter.limit ?? DEFAULT_QUERY_LIMIT;

    const matchesFilter = (entry: AuditEntry): boolean => {
      if (filter.since && entry.ts < filter.since) return false;
      if (filter.until && entry.ts >= filter.until) return false;
      if (actionSet && !actionSet.has(entry.action)) return false;
      if (filter.engramId && entry.engramId !== filter.engramId) return false;
      return true;
    };

    let fd: number | undefined;
    try {
      fd = openSync(this.filePath, "r");
    } catch {
      return [];
    }

    const ringBuf: AuditEntry[] = [];
    const CHUNK_SIZE = 64 * 1024;
    const chunk = Buffer.alloc(CHUNK_SIZE);
    let pos = 0;
    let pendingLine = "";

    try {
      while (true) {
        const bytesRead = readSync(fd, chunk, 0, CHUNK_SIZE, pos);
        if (bytesRead === 0) break;
        pos += bytesRead;

        const text = chunk.slice(0, bytesRead).toString("utf8");
        const endsWithNewline = text.charCodeAt(text.length - 1) === 10;
        const lines = text.split("\n");

        if (pendingLine.length > 0 && lines.length > 0) {
          lines[0] = pendingLine + lines[0];
          pendingLine = "";
        }

        if (!endsWithNewline) {
          pendingLine = lines.pop()!;
        } else {
          lines.pop();
        }

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          let entry: AuditEntry;
          try {
            entry = JSON.parse(trimmed) as AuditEntry;
          } catch {
            continue;
          }
          if (!matchesFilter(entry)) continue;
          ringBuf.push(entry);
          if (ringBuf.length > limit) ringBuf.shift();
        }
      }

      if (pendingLine.length > 0) {
        const trimmed = pendingLine.trim();
        if (trimmed.length > 0) {
          try {
            const entry = JSON.parse(trimmed) as AuditEntry;
            if (matchesFilter(entry)) {
              ringBuf.push(entry);
              if (ringBuf.length > limit) ringBuf.shift();
            }
          } catch {
            // 末尾损坏行忽略
          }
        }
      }
    } finally {
      try {
        closeSync(fd);
      } catch {
        // ignore close error
      }
    }

    return ringBuf;
  }

  /**
   * 轮转清理(按时间窗 + action 价值分层 + 文件大小硬上限)
   *
   * 大小硬上限按价值分级(2026-08-16):超限时优先丢最老的低价值行,
   * 高价值行只在低价值丢光仍超限时才被动兜底 —— 时间维度承诺高价值保留
   * highValueRetentionDays,大小维度必须同向,否则低价值洪流会把高价值
   * 审计挤出大小窗口。
   *
   * 与 maintenance 引擎完全解耦:作为独立后台任务运行(见 startAutoRotation),
   * 维护引擎只动 engram 数据,日志管理自成体系。
   *
   * 触发场景:
   *   - 后台 setInterval(默认 24h)
   *   - 手动调用(运维 / 测试)
   *
   * 失败 fail-soft:任何 IO/JSON 异常都不抛错,返回 `droppedCount: 0`。
   * 不写 audit:清理动作本身写 audit 会自指产生新数据,反向激励。
   *
   * @returns droppedCount 删除行数 / originalSize 原字节数 / newSize 新字节数
   */
  rotate(opts: {
    readonly retentionDays: number;
    readonly highValueRetentionDays: number;
    readonly maxSizeMb: number;
  }): { droppedCount: number; originalSize: number; newSize: number } {
    if (!existsSync(this.filePath)) {
      return { droppedCount: 0, originalSize: 0, newSize: 0 };
    }
    const originalSize = this.statSize();
    try {
      const now = Date.now();
      const retentionMs = opts.retentionDays * 24 * 60 * 60 * 1000;
      const highValueMs = opts.highValueRetentionDays * 24 * 60 * 60 * 1000;
      const maxBytes = Math.max(0, opts.maxSizeMb * 1024 * 1024);

      // 单行分类(两遍共用,确定性一致):时间维度保留决策 + 价值等级。
      // parse 失败 / 无 ts 的行 → keep=true(损坏行不擅自删除)、high=true
      // (保守:不知道内容价值时宁可占着大小预算也不先丢)。
      const classifyLine = (trimmed: string): { keep: boolean; high: boolean } => {
        let entry: AuditEntry;
        try {
          entry = JSON.parse(trimmed) as AuditEntry;
        } catch {
          return { keep: true, high: true }; // 损坏行保留(交给人工/audit-query 处理)
        }
        const tsMs = Date.parse(entry.ts ?? "");
        if (Number.isNaN(tsMs)) return { keep: true, high: true };
        const isHighValue = HIGH_VALUE_ACTIONS.has(entry.action);
        const threshold = isHighValue ? highValueMs : retentionMs;
        return { keep: now - tsMs <= threshold, high: isHighValue };
      };

      // Pass 1(流式,内存 ≈ keep 行数 × 16B 的两个 number[]):时间决策 +
      // 字节/价值统计。2026-08-16 流式化:旧实现 readFileSync 全文 + split,
      // 内存峰值 = 整个文件(真实库曾 106MB),与 query 的 2026-07 修复同款问题。
      const keepLineBytes: number[] = [];
      const keepLineHigh: number[] = []; // 1=高价值(大小截断最后才动)
      let droppedByTime = 0;
      this.forEachLine((trimmed) => {
        const c = classifyLine(trimmed);
        if (c.keep) {
          // 字节数用 Buffer.byteLength(UTF-8),与 statSize/背压判定同口径。
          // 2026-08-16 修复:曾用 trimmed.length(code-unit 数),非 ASCII 行
          // (中文路径等)被低估 ~⅔ —— 真实库 56.4MB 按代码单元只算 ~50MB,
          // 背压按真实字节触发 rotate、rotate 按低估值判「未超限」noop,
          // 死循环:文件永远涨、永不截断。
          keepLineBytes.push(Buffer.byteLength(trimmed, "utf8") + 1);
          keepLineHigh.push(c.high ? 1 : 0);
        } else {
          droppedByTime += 1;
        }
      });

      // 大小硬上限:即使按时间窗未到也强制截到 maxSizeMb 内,按行边界切,
      // 避免半行残留。2026-08-16 分级截断:超限时**优先丢最老的低价值行**
      // (noise_filtered / propose 等),低价值丢光仍超才从最老的高价值行兜底。
      // 动机:真实库 99% 体积是同一空文件反复上报的 noise_filtered,无差别
      // 头部截断让 50MB 上限实际只给 create/update/accept 留了 ~8 天,时间
      // 维度的「高价值保留 365 天」承诺被大小维度单方面撕毁。
      const sizeDropped = new Uint8Array(keepLineBytes.length); // 1=被大小截断丢弃
      let totalBytes = 0;
      for (const b of keepLineBytes) totalBytes += b;
      let need = totalBytes - maxBytes;
      if (need > 0) {
        // 轮 1:从最老开始丢低价值
        for (let i = 0; i < keepLineBytes.length && need > 0; i++) {
          if (keepLineHigh[i] === 0) {
            sizeDropped[i] = 1;
            need -= keepLineBytes[i]!;
          }
        }
        // 轮 2:兜底 —— 低价值丢光仍超限,从最老开始丢高价值
        //(保留尾部最新,与分级前的旧语义一致)
        for (let i = 0; i < keepLineBytes.length && need > 0; i++) {
          if (!sizeDropped[i]) {
            sizeDropped[i] = 1;
            need -= keepLineBytes[i]!;
          }
        }
      }
      let sizeDroppedCount = 0;
      for (const d of sizeDropped) sizeDroppedCount += d;
      if (sizeDroppedCount === 0 && droppedByTime === 0) {
        return { droppedCount: 0, originalSize, newSize: originalSize };
      }

      // Pass 2(流式):写出 时间 keep 且未被大小截断标记的行,原子 rename。
      // writeIdx 与 Pass 1 的 keep 序号对齐;两 pass 之间新 append 的行落在
      // sizeDropped 越界处(undefined → falsy → 保留),不会误删。
      const tmpPath = `${this.filePath}.rotate-${process.pid}-${Date.now()}`;
      const fd = openSync(tmpPath, "w");
      let writeIdx = 0;
      let newSize = 0;
      try {
        this.forEachLine((trimmed) => {
          if (!classifyLine(trimmed).keep) return;
          if (!sizeDropped[writeIdx]) {
            writeSync(fd, trimmed + "\n");
            newSize += Buffer.byteLength(trimmed, "utf8") + 1;
          }
          writeIdx++;
        });
      } finally {
        closeSync(fd);
      }
      renameSync(tmpPath, this.filePath);
      const droppedCount = droppedByTime + sizeDroppedCount;
      return { droppedCount, originalSize, newSize };
    } catch {
      return { droppedCount: 0, originalSize, newSize: originalSize };
    }
  }

  /** 流式逐行遍历 audit.jsonl(跨 chunk 行拼接;空行跳过;只读) */
  private forEachLine(cb: (trimmed: string) => void): void {
    const CHUNK = 64 * 1024;
    const buf = Buffer.alloc(CHUNK);
    const fd = openSync(this.filePath, "r");
    let pos = 0;
    let pending = "";
    try {
      while (true) {
        const n = readSync(fd, buf, 0, CHUNK, pos);
        if (n === 0) break;
        pos += n;
        const text = buf.subarray(0, n).toString("utf8");
        const endsWithNewline = text.charCodeAt(text.length - 1) === 10;
        const lines = text.split("\n");
        if (pending.length > 0 && lines.length > 0) {
          lines[0] = pending + lines[0];
          pending = "";
        }
        if (!endsWithNewline) {
          pending = lines.pop()!;
        } else {
          lines.pop();
        }
        for (const l of lines) {
          const t = l.trim();
          if (t.length > 0) cb(t);
        }
      }
      if (pending.trim().length > 0) cb(pending.trim());
    } finally {
      closeSync(fd);
    }
  }

  /**
   * 启动独立后台轮转(默认 24h)
   *
   * 与 maintenance 引擎完全解耦:不进 light/deep/rem/daily 任何阶段,
   * 自己持有 setInterval。返回 stop 函数,host adapter 在卸载/退出时调。
   *
   * 配置项来自 persisted config 或默认值;intervalMs ≤ 0 时不启动。
   *
   * 2026-08-16 修复「轮转从未执行」:
   * - **启动首跑**(30s 延迟避峰):旧实现只有 setInterval(24h),短命进程
   *   (daemon 重启间隙的 stdio 连接)活不到首次触发,轮转形同虚设 ——
   *   真实库 audit.jsonl 曾涨到 106MB(上限 50MB)。
   * - **注入 append 背压参数**:超限 ×1.1 时写入路径自己触发异步轮转
   *   (见 maybeBackpressureRotate),高频写入进程不再单纯依赖定时器。
   */
  startAutoRotation(opts: {
    readonly retentionDays: number;
    readonly highValueRetentionDays: number;
    readonly maxSizeMb: number;
    readonly intervalMs: number;
  }): () => void {
    if (opts.intervalMs <= 0) return () => {};
    this.autoRotationOpts = {
      retentionDays: opts.retentionDays,
      highValueRetentionDays: opts.highValueRetentionDays,
      maxSizeMb: opts.maxSizeMb,
    };
    const tick = (): void => {
      try {
        const r = this.rotate(opts);
        if (r.droppedCount > 0) {
          process.stderr.write(
            `[co-engram] audit rotation: dropped ${r.droppedCount} entries ` +
              `(${r.originalSize} → ${r.newSize} bytes)\n`,
          );
        }
      } catch {
        // fail-soft
      }
    };
    const handle = setInterval(tick, opts.intervalMs);
    const first = setTimeout(tick, FIRST_ROTATION_DELAY_MS);
    // unref:不阻塞 Node 退出(host adapter 显式 stop 时清理)
    if (typeof handle.unref === "function") handle.unref();
    if (typeof first.unref === "function") first.unref();
    return () => {
      clearInterval(handle);
      clearTimeout(first);
    };
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

  /** stat 文件大小(字节),失败返回 0 */
  private statSize(): number {
    try {
      return statSync(this.filePath).size;
    } catch {
      return 0;
    }
  }
}

/**
 * 高价值 audit action 集合(默认保留 365 天)
 *
 * 选择标准:状态变更 + 用户决策 + 跨进程协同 — 这些是审计的核心目的
 * (追溯"为什么这条 engram 被删/合并/接受/驳回")。高频但低追溯价值的
 * propose / reinforce / report_failure / retrieve_* / noise_filtered /
 * necessity_rejected 走默认 90 天保留。
 */
const HIGH_VALUE_ACTIONS: ReadonlySet<AuditAction> = new Set<AuditAction>([
  // 状态变更
  "create",
  "update",
  "update_lifecycle",
  // 重要性变更虽由 reinforce/report_failure 触发,但作为独立 action 仍高价值
  "importance_update",
  "forget",
  "restore",
  "sweep_to_trash",
  "restore_from_trash",
  "purge",
  // 用户决策(proposal 审批)
  "accept",
  "dismiss",
  // 冲突标记
  "contradicted",
  // git merge driver 协同
  "merge_resolved",
  "merge_backup_failed",
  "merge_conflict_escalated",
  "merge_llm_arbitrated",
  "merge_llm_arbitrated_escalated",
  "merge_llm_arbitrated_failed",
  // 学习回路闭环
  "learning_loop_success",
  "learning_loop_partial",
  "learning_loop_failure",
  // maintenance 触发
  "maintenance_run",
]);
