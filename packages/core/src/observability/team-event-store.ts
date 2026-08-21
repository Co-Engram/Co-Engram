/**
 * 团队动态事件仓库(跨机同步的事件出口)
 *
 * 背景(2026-08-19 设计):viewer 概览「记忆动态」读本地 .co-engram/audit.jsonl,
 * 而该目录整体被 gitignore——「各自 clone + git 同步」拓扑下,别人机器上产生的
 * create/update/reinforce 等事件不会随 git 流到本地,动态流退化成「只有本机事件」。
 *
 * 方案:高价值动作除写本地 audit 外,同时落一份**可同步**的轻量事件文件:
 *   <dataRoot>/events/<YYYY-MM-DD>/<origin>.jsonl
 *
 * 团队协议(多写者冲突的消解):
 *   - **写者隔离分片**:每文件单写者(一台机器一个 origin),不同机器写不同
 *     文件、跨天写不同日期目录——git 合并在结构上零冲突(不用 union merge
 *     driver:它对「append+删行」会产生重复行与顺序不稳定)。
 *   - **eventId 全局唯一**(randomUUID):读端去重键,重放/复制不产生重复条目。
 *   - **origin** = 作者标识(git user.name → user.email,复用 detectGitAuthor,
 *     与 engram createdBy 同源)——engram 本体的 createdBy 本来就随仓库同步,
 *     事件文件匿名没有隐私意义;private 过滤才是隐私防线。
 *   - **private 隔离**:visibility='private' 的 engram 事件只进本地 audit,
 *     绝不落 events/(否则 private 记忆的存在性/标题经事件文件泄漏进团队仓库)。
 *   - **内容最小化**:metadata 白名单投影 + 字符串截断(≤80 字,与 feed 展示
 *     口径一致),不携带 changes.content 全文。
 *   - **schemaVersion**:读端忽略未知版本行,混合版本团队前向兼容。
 *
 * 保留策略:retentionDays(默认 14)外的日期目录**整目录删除**——文件粒度删除
 * 不与任何远端 append 产生 delete/modify 冲突(远端不可能还在写 14 天前的日期)。
 * 清理由 append 背压触发(1h 冷却),无宿主装配依赖。
 *
 * 失败契约:与 AuditLog.append 一致——fire-and-forget,全程静默,不阻塞业务。
 *
 * @module @co-engram/core/observability
 */

import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AuditEntry, AuditAction } from "./audit-log.js";

/** 当前事件 schema 版本;读端忽略大于自身的版本行 */
const TEAM_EVENT_SCHEMA_VERSION = 1;

/**
 * 同步动作集(团队动态价值)。
 *
 * 不含 maintenance_run / retrieve_*(本机行为,跨机归因无意义且量大)与
 * merge_*(merge driver 进程内无 repository,visibility 无法判定)。
 */
export const SYNCED_TEAM_ACTIONS: ReadonlySet<AuditAction> = new Set([
  "create",
  "update",
  "reinforce",
  "contradicted",
  "accept",
  "skill_create",
  "skill_update",
]);

/** metadata 白名单:feed 渲染(authorFor/excerptFor/去重 key/技能动态标题)实际消费的键 */
const METADATA_ALLOW_KEYS: ReadonlySet<string> = new Set([
  "updatedBy",
  "createdBy",
  "title",
  "kind",
  "reason",
  "note",
  "source",
  "target",
  "entityId",
  "synapseId",
  // skill_create/skill_update 动态标题与去重键(2026-08-22:此前被投影掉,
  // 跨机技能动态只能显示动作名「创建技能」,看不出是哪个技能)
  "skillId",
]);

/** 同步事件的字符串值截断长度(与 viewer feed excerptFor 的 80 字口径一致) */
const METADATA_VALUE_CLIP = 80;

/** 默认保留天数:过期日期目录整目录删除 */
const DEFAULT_TEAM_EVENT_RETENTION_DAYS = 14;

/** 清理背压冷却(ms):高频写入进程最多每小时清一次 */
const CLEANUP_COOLDOWN_MS = 60 * 60 * 1000;

/** 日期目录名格式(读取侧校验,防任意目录被当事件分片) */
const DAY_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 单条同步事件(文件内 JSONL 一行) */
export interface TeamEvent {
  readonly schemaVersion: number;
  /** 全局唯一 id(randomUUID);读端去重键 */
  readonly eventId: string;
  /** 作者标识(git user.name/email)——文件名与条目双携带,渲染兜底显示 */
  readonly origin: string;
  /** ISO 时间戳(与本地 audit 同源,读端按 action|engramId|ts 语义去重) */
  readonly ts: string;
  readonly actor: AuditEntry["actor"];
  readonly action: AuditAction;
  readonly engramId?: string;
  readonly host?: string;
  /** 白名单投影 + 截断后的元数据 */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** 查询过滤条件(与 AuditQueryFilter 对齐的子集) */
export interface TeamEventQueryFilter {
  readonly since?: string;
  readonly until?: string;
  readonly action?: AuditAction | readonly AuditAction[];
  readonly engramId?: string;
  readonly limit?: number;
}

/**
 * AuditLog.append 的转发目标(接口解耦,AuditLog 不依赖具体实现)。
 *
 * TeamEventStore 实现它;AuditLog 持有可选引用,append 成功后同步转发。
 */
export interface TeamEventRecorder {
  record(entry: AuditEntry): void;
}

/** 把 origin 标识安全化为文件名(防 path traversal / 特殊字符) */
function sanitizeOriginFileName(origin: string): string {
  const cleaned = origin
    // 折叠连续点(`..` 即使作为文件名成分也无路径语义,但某些工具会困惑)
    .replace(/\.{2,}/g, ".")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .slice(0, 64);
  // 全量替换后为空(纯中文 origin 等)→ 用 base64url 稳定可逆表示
  return cleaned.length >= 2
    ? cleaned
    : `origin-${Buffer.from(origin).toString("base64url").slice(0, 24)}`;
}

/** 字符串值截断(多空白折叠,与 feed excerptFor 同法) */
function clipValue(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > METADATA_VALUE_CLIP
    ? `${normalized.slice(0, METADATA_VALUE_CLIP - 2)}…`
    : normalized;
}

/**
 * metadata 白名单投影:
 *   - 白名单键 → 字符串截断 / 原样保留(非字符串标量)
 *   - changes → 只留 field 名清单;content.to 单独截断保留(feed 摘要用),
 *     绝不携带全文
 */
function projectMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (!metadata) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (METADATA_ALLOW_KEYS.has(key)) {
      out[key] = typeof value === "string" ? clipValue(value) : value;
    }
  }
  const changes = metadata["changes"];
  if (changes && typeof changes === "object") {
    const fields = Object.keys(changes as Record<string, unknown>);
    if (fields.length > 0) {
      const projected: Record<string, unknown> = { fields: fields.slice(0, 8) };
      const contentTo = (changes as Record<string, unknown>)["content"];
      if (
        contentTo &&
        typeof contentTo === "object" &&
        typeof (contentTo as Record<string, unknown>)["to"] === "string"
      ) {
        projected.contentTo = clipValue(
          (contentTo as Record<string, unknown>)["to"] as string,
        );
      }
      out.changes = projected;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 团队动态事件仓库。
 *
 * 写路径 record() 挂在 AuditLog.append 内部(宿主装配 setTeamEventStore),
 * 所有 audit 调用点自动双写,零调用点改动;读路径 query() 供 viewer 合并。
 */
export class TeamEventStore implements TeamEventRecorder {
  private readonly eventsRoot: string;
  private readonly origin: string;
  private readonly originFile: string;
  private readonly retentionDays: number;
  private readonly visibilityLookup:
    | ((engramId: string) => string | undefined)
    | undefined;
  /** 清理背压冷却:上次触发清理的时间戳 */
  private lastCleanupAt = 0;

  constructor(
    dataRoot: string,
    options: {
      /** 作者标识(detectGitAuthor() 解析结果) */
      readonly origin: string;
      /** 保留天数(默认 14) */
      readonly retentionDays?: number;
      /**
       * engram 可见性查询(SQLite 单查,毫秒级);返回 'private' 时事件不落盘。
       * 未提供时(无 repository 的进程)视为不可判定——record 直接跳过,
       * 宁缺勿漏(private 防线优先于动态完整性)。
       */
      readonly visibilityLookup?: (engramId: string) => string | undefined;
    },
  ) {
    this.eventsRoot = join(dataRoot, "events");
    this.origin = options.origin;
    this.originFile = `${sanitizeOriginFileName(options.origin)}.jsonl`;
    this.retentionDays =
      options.retentionDays ?? DEFAULT_TEAM_EVENT_RETENTION_DAYS;
    this.visibilityLookup = options.visibilityLookup;
  }

  /** events 根目录(测试用) */
  get root(): string {
    return this.eventsRoot;
  }

  /** 转发入口:动作过滤 → private 过滤 → 投影截断 → 分片追加(全程静默) */
  record(entry: AuditEntry): void {
    try {
      if (!SYNCED_TEAM_ACTIONS.has(entry.action)) return;
      // private engram 的事件只留在本地 audit,不进可同步目录。
      // 无 visibilityLookup(无 repository 的进程)→ 同样跳过:无法证明
      // 非 private 就不同步,隐私防线优先。
      if (entry.engramId) {
        if (!this.visibilityLookup) return;
        if (this.visibilityLookup(entry.engramId) === "private") return;
      }
      const event: TeamEvent = {
        schemaVersion: TEAM_EVENT_SCHEMA_VERSION,
        eventId: randomUUID(),
        origin: this.origin,
        ts: entry.ts,
        actor: entry.actor,
        action: entry.action,
        ...(entry.engramId ? { engramId: entry.engramId } : {}),
        ...(entry.host ? { host: entry.host } : {}),
        ...(entry.metadata
          ? { metadata: projectMetadata(entry.metadata) }
          : {}),
      };
      const day = entry.ts.slice(0, 10);
      const dayDir = join(this.eventsRoot, day);
      if (!existsSync(dayDir)) {
        mkdirSync(dayDir, { recursive: true });
      }
      appendFileSync(
        join(dayDir, this.originFile),
        `${JSON.stringify(event)}\n`,
        "utf-8",
      );
      this.maybeCleanup();
    } catch {
      // intentional:与 AuditLog.append 同语义,同步失败不阻塞业务
    }
  }

  /**
   * 读取全部分片并合并(跨日期目录 × 跨 origin 文件),按 ts 降序。
   *
   * 坏行(截断/冲突标记/未知 schemaVersion)静默跳过——读端永不因个别
   * 损坏行失败。不去重:本机双写产生的重复由调用方(viewer)按
   * action|engramId|ts 语义键对 audit 去重。
   */
  query(filter: TeamEventQueryFilter = {}): readonly TeamEvent[] {
    const out: TeamEvent[] = [];
    let days: readonly string[];
    try {
      days = readdirSync(this.eventsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && DAY_DIR_PATTERN.test(d.name))
        .map((d) => d.name);
    } catch {
      return [];
    }
    const actions = filter.action
      ? new Set(
          Array.isArray(filter.action) ? filter.action : [filter.action],
        )
      : undefined;
    for (const day of days) {
      let files: readonly string[];
      try {
        files = readdirSync(join(this.eventsRoot, day)).filter((f) =>
          f.endsWith(".jsonl"),
        );
      } catch {
        continue;
      }
      for (const file of files) {
        let raw: string;
        try {
          raw = readFileSync(join(this.eventsRoot, day, file), "utf-8");
        } catch {
          continue;
        }
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let parsed: TeamEvent;
          try {
            parsed = JSON.parse(trimmed) as TeamEvent;
          } catch {
            continue;
          }
          if (
            typeof parsed?.schemaVersion !== "number" ||
            parsed.schemaVersion > TEAM_EVENT_SCHEMA_VERSION
          ) {
            continue;
          }
          if (typeof parsed?.ts !== "string" || typeof parsed?.action !== "string") {
            continue;
          }
          if (actions && !actions.has(parsed.action as AuditAction)) continue;
          if (filter.engramId && parsed.engramId !== filter.engramId) continue;
          if (filter.since && parsed.ts < filter.since) continue;
          if (filter.until && parsed.ts >= filter.until) continue;
          out.push(parsed);
        }
      }
    }
    out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return filter.limit ? out.slice(0, filter.limit) : out;
  }

  /**
   * 清理背压(与 AuditLog.maybeBackpressureRotate 同法):append 触发、
   * 1h 冷却、setTimeout 异步执行不阻塞 record 返回。
   *
   * 只删「日期 < 今天 − retentionDays」的整个日期目录;future 日期目录
   * (时钟漂移产物)不动,防删掉协作者正在写的分片。
   */
  private maybeCleanup(): void {
    const now = Date.now();
    if (now - this.lastCleanupAt < CLEANUP_COOLDOWN_MS) return;
    this.lastCleanupAt = now;
    const tick = (): void => {
      try {
        this.cleanupExpired(new Date(now));
      } catch {
        // fail-soft
      }
    };
    const h = setTimeout(tick, 0);
    if (typeof h.unref === "function") h.unref();
  }

  /** 删除过期日期目录(幂等;测试直接调用)。返回删除的目录数。 */
  cleanupExpired(now: Date): number {
    const cutoff = new Date(
      now.getTime() - this.retentionDays * 24 * 60 * 60 * 1000,
    );
    const cutoffDay = cutoff.toISOString().slice(0, 10);
    let removed = 0;
    let days: readonly string[];
    try {
      days = readdirSync(this.eventsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && DAY_DIR_PATTERN.test(d.name))
        .map((d) => d.name);
    } catch {
      return 0;
    }
    for (const day of days) {
      // 字典序即时间序(ISO 日期);只删严格早于 cutoff 的过去日期
      if (day < cutoffDay) {
        try {
          rmSync(join(this.eventsRoot, day), { recursive: true, force: true });
          removed++;
        } catch {
          // 单目录失败不影响其余
        }
      }
    }
    return removed;
  }
}
