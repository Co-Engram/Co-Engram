/**
 * Claude Code auto-memory 文件监听器
 *
 * 启动时做两件事:
 *   1. **初始扫描**:`<projectsRoot>/<encoded-cwd>/memory/*.md` 全量同步
 *   2. **增量监听**:`fs.watch` 每个 memory 目录(以及 projectsRoot 自身,
 *      以捕捉新项目目录被创建的场景)
 *
 * 失败语义:
 *   - 整个 watcher 启动失败(projectsRoot 不存在 / 无权限)→ `start()` 返回
 *     `enabled: false`,MCP server 继续启动,只 stderr 提示一次
 *   - 单个目录 watch 失败 → 跳过该目录,继续监听其他
 *   - 单个文件解析失败 → 静默跳过(解析器已记录)
 *
 * Debounce:
 *   Claude Code 写 MEMORY.md 时往往会触发多次写入(先写内容、再写索引),
 *   每个 change 加 500ms debounce 避免重复 syncMemory。
 *
 * @module @co-engram/claude-code/memory-sync
 */

import { FSWatcher, watch, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { AutoMemorySyncEngine } from "./sync-engine.js";
import {
  isAutoMemoryFileName,
  parseAutoMemoryFile,
  type ParsedAutoMemory,
} from "./memory-parser.js";

/** watcher 启动结果 */
export interface WatcherStartResult {
  /** true=正在监听;false=无法启动(projectsRoot 不存在等) */
  readonly enabled: boolean;
  /** 初始扫描统计(仅在 enabled=true 时有意义) */
  readonly initialSync?: {
    readonly files: number;
    readonly created: number;
    readonly updated: number;
    readonly unchanged: number;
    readonly skipped: number;
    readonly failed: number;
    readonly errors: readonly string[];
  };
  readonly reason?: string;
}

/**
 * Auto-memory 文件监听器
 *
 * 使用 `fs.watch`(原子语义依赖内核 inotify/kqueue);对模糊的 rename 事件
 * 做双目录扫描兜底:任何目录触发都重新扫该目录全部 .md,简单但可靠。
 */
export class AutoMemoryWatcher {
  private watchers: FSWatcher[] = [];
  /** 与 watchers 同步的目录路径,用于检测"已监听"集合 */
  private watchedPaths = new Set<string>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private stopped = false;
  private readonly debounceMs: number;

  constructor(params: {
    readonly projectsRoot: string;
    readonly engine: AutoMemorySyncEngine;
    readonly debounceMs?: number;
    readonly log?: (msg: string) => void;
  }) {
    this.projectsRoot = params.projectsRoot;
    this.engine = params.engine;
    this.debounceMs = params.debounceMs ?? 500;
    this.log = params.log ?? (() => {});
  }

  /**
   * 启动 watcher:初始扫描 + 增量监听
   *
   * 失败不抛错,返回 `enabled: false` + reason。MCP server 启动路径不阻塞。
   */
  start(): WatcherStartResult {
    if (!existsSync(this.projectsRoot)) {
      return {
        enabled: false,
        reason: `projectsRoot not found: ${this.projectsRoot}`,
      };
    }
    let statOk = false;
    try {
      const stat = statSync(this.projectsRoot);
      statOk = stat.isDirectory();
    } catch {
      // ignore
    }
    if (!statOk) {
      return {
        enabled: false,
        reason: `projectsRoot not a directory: ${this.projectsRoot}`,
      };
    }

    // 1. 初始扫描
    const projectDirs = this.listProjectMemoryDirs();
    const initialFiles = this.collectAllMemoryFiles(projectDirs);
    const parsed = this.parseAll(initialFiles);
    const initialStats = this.engine.syncBatch(parsed);

    this.log(
      `[memory-sync] initial scan: ${initialFiles.length} files, ` +
        `${initialStats.created} created, ${initialStats.updated} updated, ` +
        `${initialStats.unchanged} unchanged, ${initialStats.skipped} skipped, ` +
        `${initialStats.failed} failed`,
    );

    // 2. 监听 projectsRoot 自身(捕捉新项目目录创建)
    this.watchDirectory(this.projectsRoot, () => {
      // 新项目可能被创建 → 重新扫所有 memory 目录,补 watch
      this.refreshProjectWatches();
    });

    // 3. 监听每个 memory 目录
    for (const dir of projectDirs) {
      this.watchMemoryDir(dir);
    }

    return {
      enabled: true,
      initialSync: {
        files: initialFiles.length,
        ...initialStats,
      },
    };
  }

  /** 停止所有 watcher */
  stop(): void {
    this.stopped = true;
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }
    this.watchers = [];
    this.watchedPaths.clear();
    for (const [, t] of this.debounceTimers) {
      clearTimeout(t);
    }
    this.debounceTimers.clear();
  }

  /** 测试用:当前 watcher 数量 */
  get watcherCount(): number {
    return this.watchers.length;
  }

  // ────────────────────────────────────────────────────────────

  /** 监听一个 memory 目录(专门处理 .md 文件事件) */
  private watchMemoryDir(dir: string): void {
    this.watchDirectory(
      dir,
      () => {
        // 该目录下任何 .md 变化 → 重新扫该目录全部 .md(简单可靠,文件数有限)
        this.scheduleSyncDirectory(dir);
      },
      { onlyMarkdown: true },
    );
  }

  /**
   * 通用目录监听:封装 fs.watch,处理 ENOENT/errors
   *
   * @param dir 目标目录
   * @param onAny "有变化"回调(由调用方决定如何重新扫描)
   * @param opts.onlyMarkdown 仅对 .md 文件名事件触发(用于 memory 目录)
   *                           否则任何文件名/子目录事件都触发(用于 projectsRoot)
   */
  private watchDirectory(
    dir: string,
    onAny: () => void,
    opts: { readonly onlyMarkdown?: boolean } = {},
  ): void {
    if (this.watchedPaths.has(dir)) return;
    try {
      const w = watch(dir, { recursive: false }, (_event, filename) => {
        if (this.stopped) return;
        if (!filename) {
          onAny();
          return;
        }
        if (opts.onlyMarkdown) {
          // 只关心 .md 文件(其他文件忽略)
          if (filename.endsWith(".md")) {
            onAny();
          }
        } else {
          // 任何事件都触发(用于 projectsRoot 检测新子目录)
          onAny();
        }
      });
      w.on("error", (err) => {
        if (this.stopped) return;
        this.log(
          `[memory-sync] watcher error on ${dir}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
      this.watchers.push(w);
      this.watchedPaths.add(dir);
    } catch (err) {
      this.log(
        `[memory-sync] failed to watch ${dir}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** 重新扫描所有 memory 目录的 watch(新项目目录加入) */
  private refreshProjectWatches(): void {
    const currentDirs = this.listProjectMemoryDirs();
    for (const dir of currentDirs) {
      if (!this.watchedPaths.has(dir)) {
        this.watchMemoryDir(dir);
        // 新项目目录,立即同步(不走 debounce,避免错过创建期间的写入)
        try {
          const files = this.collectMemoryFilesFromDir(dir);
          const parsed = this.parseAll(files);
          const stats = this.engine.syncBatch(parsed);
          if (stats.created + stats.updated > 0) {
            this.log(
              `[memory-sync] new project dir ${dir}: ${stats.created} created, ` +
                `${stats.updated} updated`,
            );
          }
        } catch (err) {
          this.log(
            `[memory-sync] initial sync error on new dir ${dir}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
  }

  /** 调度一个目录的去抖同步(500ms 内多次 change 合并) */
  private scheduleSyncDirectory(dir: string): void {
    const existing = this.debounceTimers.get(dir);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(dir);
      if (this.stopped) return;
      try {
        const files = this.collectMemoryFilesFromDir(dir);
        const parsed = this.parseAll(files);
        const stats = this.engine.syncBatch(parsed);
        if (stats.created + stats.updated > 0) {
          this.log(
            `[memory-sync] ${dir}: ${stats.created} created, ` +
              `${stats.updated} updated`,
          );
        }
      } catch (err) {
        this.log(
          `[memory-sync] sync error on ${dir}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }, this.debounceMs);
    timer.unref?.();
    this.debounceTimers.set(dir, timer);
  }

  /** 扫所有 `<project>/memory/` 子目录(只到 memory 这一层) */
  private listProjectMemoryDirs(): string[] {
    let projectNames: string[];
    try {
      projectNames = readdirSync(this.projectsRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
    const dirs: string[] = [];
    for (const name of projectNames) {
      const memoryDir = join(this.projectsRoot, name, "memory");
      if (existsSync(memoryDir) && statSync(memoryDir).isDirectory()) {
        dirs.push(memoryDir);
      }
    }
    return dirs;
  }

  /** 单个 memory 目录下的所有 .md 文件(排除 MEMORY.md) */
  private collectMemoryFilesFromDir(dir: string): string[] {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }
    return entries
      .filter(isAutoMemoryFileName)
      .map((name) => join(dir, name));
  }

  /** 多个 memory 目录汇总 */
  private collectAllMemoryFiles(dirs: readonly string[]): string[] {
    const all: string[] = [];
    for (const dir of dirs) {
      all.push(...this.collectMemoryFilesFromDir(dir));
    }
    return all;
  }

  /** 批量解析(解析失败的单条静默跳过) */
  private parseAll(files: readonly string[]): ParsedAutoMemory[] {
    const out: ParsedAutoMemory[] = [];
    for (const f of files) {
      const p = parseAutoMemoryFile(f);
      if (p) out.push(p);
    }
    return out;
  }

  private readonly projectsRoot: string;
  private readonly engine: AutoMemorySyncEngine;
  private readonly log: (msg: string) => void;
}
