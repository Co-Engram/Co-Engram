/**
 * 健康可视化状态(Finding 128 / 254 等 P0 的用户感知层)
 *
 * `co-engram status` 命令与 viewer Health tab 共用本模块。
 * 设计目标:把"静默失败"变成"一眼可见"——挑剔用户首启就能看到问题在哪。
 *
 * @module @co-engram/core/status
 */

import { existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { EngramRepository } from "../storage/repository.js";
import { AuditLog } from "../observability/audit-log.js";

/** 单项健康检查结果 */
export interface HealthCheck {
  /** 检查项 id(snake_case) */
  readonly id: string;
  /** 显示名 */
  readonly label: string;
  /** ok / warn / error / info */
  readonly status: "ok" | "warn" | "error" | "info";
  /** 简短说明 */
  readonly message: string;
  /** 可选详情(展开看) */
  readonly detail?: string;
  /**
   * 警告含义说明(只在 warn/error 时填;ok/info 留空)
   *
   * 结构化对齐:i18n key `viewer.health.why.<checkId>` —— viewer 端按当前
   * 语言渲染,core 不耦合文案。例如 checkId='merge_driver' 时 viewer 翻译表里
   * 有 `viewer.health.why.merge_driver = "未配置时,多人协作合并分支会引发
   * engram frontmatter 冲突,需手工解决"`。
   */
  readonly whyI18nKey?: string;
  /**
   * 修复指引(结构化,只在 warn/error 时填)
   *
   * 与 doctor 的 `DoctorNextAction` 区别:nextAction 给 LLM agent(含 argsHint),
   * `fix` 给人(含可复制命令)。两者刻意区分,不混用。
   */
  readonly fix?: HealthCheckFix;
}

/** 健康检查的修复指引(给 viewer UI 用) */
export interface HealthCheckFix {
  /**
   * 修复描述 i18n key(viewer 端按语言渲染)
   *
   * 例如 checkId='merge_driver' → `viewer.health.fix.merge_driver.description`
   */
  readonly descriptionI18nKey: string;
  /**
   * 可执行的 shell 命令(可选,UI 提供"复制命令"按钮)
   *
   * 不通过 i18n key —— 命令跨语言一致。例如 `co-engram init`、
   * `git init && git add -A && git commit -m initial`。
   */
  readonly command?: string;
  /**
   * 对应的 co-engram 工具名(可选,UI 显示工具名 + argsHint)
   *
   * 例如 `engram_list_proposals`、`engram_doctor`。
   */
  readonly tool?: string;
  /** 工具参数提示(配合 tool 用) */
  readonly argsHint?: string;
}

/** 完整状态快照 */
export interface StatusSnapshot {
  /** 生成时间 ISO */
  readonly generatedAt: string;
  /** dataRoot 路径 */
  readonly dataRoot: string;
  /** dataRoot 是否存在 */
  readonly dataRootExists: boolean;
  /** 是否为 co-engram 仓库(含 .co-engram/config.json) */
  readonly isEngramWarehouse: boolean;
  /** 配置(若可读) */
  readonly config?: Readonly<Record<string, unknown>>;
  /** engram 统计 */
  readonly stats: {
    readonly total: number;
    readonly byKind: Readonly<Record<string, number>>;
    readonly byStatus: Readonly<Record<string, number>>;
    readonly archived: number;
    readonly forgotten: number;
  };
  /** 索引文件状态 */
  readonly indexes: {
    readonly engramIndex: { readonly exists: boolean; readonly mtime?: string; readonly sizeBytes?: number };
    readonly digestJsonl: { readonly exists: boolean; readonly mtime?: string; readonly sizeBytes?: number };
    readonly graphJson: { readonly exists: boolean; readonly mtime?: string; readonly sizeBytes?: number };
  };
  /** 候选提案 */
  readonly proposals: { readonly pending: number; readonly total: number };
  /** Git 状态 */
  readonly git: { readonly isRepo: boolean; readonly dirty: boolean; readonly uncommittedCount: number };
  /** merge driver 配置 */
  readonly mergeDriver: { readonly configured: boolean; readonly detail?: string };
  /** 健康检查项列表 */
  readonly checks: readonly HealthCheck[];
  /** 总体健康(ok = 所有 check 都 ok/info;warn = 有 warn;error = 有 error) */
  readonly overall: "ok" | "warn" | "error";
}

/**
 * 计算仓库健康状态
 *
 * @param dataRoot team-memory 根目录
 * @param opts.indexDb 可选 SQLite 索引层,有则走快路径(单次 GROUP BY),
 *   无则 fallback 到 N+1 readEngram(CLI 场景,小仓库可接受)。viewer 必须传,
 *   否则 1000+ engram 在同步 handler 里阻塞 event loop 30 秒。
 * @returns StatusSnapshot;即使 dataRoot 不存在也返回(便于 UI 显示诊断)
 */
export function computeStatus(
  dataRoot: string,
  opts: { readonly indexDb?: { countGrouped(): {
    readonly byStatus: Readonly<Record<string, number>>;
    readonly byKind: Readonly<Record<string, number>>;
    readonly byVisibility: Readonly<Record<string, number>>;
    readonly total: number;
  } } } = {},
): StatusSnapshot {
  const generatedAt = new Date().toISOString();
  const dataRootExists = existsSync(dataRoot);
  const configPath = join(dataRoot, ".co-engram", "config.json");
  const isEngramWarehouse = existsSync(configPath);

  // 配置
  let config: Readonly<Record<string, unknown>> | undefined;
  if (isEngramWarehouse) {
    try {
      const raw = readFileSync(configPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && parsed.version === 1) {
        config = parsed as Readonly<Record<string, unknown>>;
      }
    } catch {
      // 配置读取失败,下面 check 会标记
    }
  }

  // engram 统计(catalog 层,快;status 分布需要读 meta,见下方可选展开)
  const stats = { total: 0, byKind: {} as Record<string, number>, byStatus: {} as Record<string, number>, archived: 0, forgotten: 0 };
  if (dataRootExists && isEngramWarehouse) {
    // SQLite 快路径:viewer 注入 indexDb 时,一次 GROUP BY 拿到 status/kind/visibility
    // 分布,彻底替代下面的 N+1 readEngram(1026 engram 同步读会让 viewer event loop 卡 30s)
    if (opts.indexDb) {
      try {
        const g = opts.indexDb.countGrouped();
        stats.total = g.total;
        for (const [k, v] of Object.entries(g.byKind)) stats.byKind[k] = v;
        for (const [s, v] of Object.entries(g.byStatus)) {
          stats.byStatus[s] = v;
          if (s === "archived") stats.archived += v;
          if (s === "forgotten") stats.forgotten += v;
        }
      } catch {
        // SQLite 读失败,下面 check 会标记
      }
    } else {
      // Fallback(CLI 场景,无 indexDb):N+1 readEngram
      try {
        const repo = new EngramRepository({ rootPath: dataRoot });
        const all = repo.listEngrams();
        stats.total = all.length;
        for (const e of all) {
          const kind = e.kind ?? "unknown";
          stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1;
        }
        // status 分布需要读 meta(慢路径,但对诊断重要)
        for (const e of all) {
          try {
            const full = repo.readEngram(e.id);
            const status = full.status ?? "active";
            stats.byStatus[status] = (stats.byStatus[status] ?? 0) + 1;
            if (status === "archived") stats.archived += 1;
            if (status === "forgotten") stats.forgotten += 1;
          } catch {
            // 单条 engram meta 读失败,跳过(下面 check 会标记)
          }
        }
      } catch {
        // 仓库不可读,下面 check 会标记
      }
    }
  }

  // 索引文件
  const indexBase = join(dataRoot, ".co-engram");
  const indexes = {
    engramIndex: statFile(join(indexBase, "engram-index.json")),
    digestJsonl: statFile(join(indexBase, "digest.jsonl")),
    graphJson: statFile(join(indexBase, "graph.json")),
  };

  // 候选提案
  let proposals = { pending: 0, total: 0 };
  if (dataRootExists && isEngramWarehouse) {
    try {
      const proposalsDir = join(indexBase, "proposals");
      if (existsSync(proposalsDir)) {
        const files = readdirSync(proposalsDir).filter((f) => f.endsWith(".json"));
        proposals.total = files.length;
        for (const f of files) {
          try {
            const raw = readFileSync(join(proposalsDir, f), "utf8");
            const parsed = JSON.parse(raw) as { status?: string };
            if (parsed.status === "pending") proposals.pending += 1;
          } catch {
            // 单个提案文件损坏,跳过
          }
        }
      }
    } catch {
      // 提案目录不可读
    }
  }

  // Git 状态
  const git = checkGit(dataRoot);

  // merge driver
  const mergeDriver = checkMergeDriver(dataRoot);

  // 健康检查项
  const checks: HealthCheck[] = [];

  if (!dataRootExists) {
    checks.push({
      id: "data_root",
      label: "Data Root",
      status: "error",
      message: `目录不存在: ${dataRoot}`,
      whyI18nKey: "viewer.health.why.data_root_missing",
      fix: {
        descriptionI18nKey: "viewer.health.fix.data_root_missing.description",
        command: `mkdir -p ${dataRoot} && co-engram init --path ${dataRoot}`,
      },
    });
  } else if (!isEngramWarehouse) {
    checks.push({
      id: "data_root",
      label: "Data Root",
      status: "error",
      message: `不是 co-engram 仓库(缺 .co-engram/config.json)`,
      detail: `运行 'co-engram init --path ${dataRoot}' 初始化,或换一个已存在的仓库路径。`,
      whyI18nKey: "viewer.health.why.data_root_not_warehouse",
      fix: {
        descriptionI18nKey: "viewer.health.fix.data_root_not_warehouse.description",
        command: `co-engram init --path ${dataRoot}`,
      },
    });
  } else {
    checks.push({
      id: "data_root",
      label: "Data Root",
      status: "ok",
      message: dataRoot,
    });
  }

  // 配置
  if (isEngramWarehouse) {
    if (!config) {
      checks.push({
        id: "config",
        label: "Config",
        status: "error",
        message: ".co-engram/config.json 读取失败",
        whyI18nKey: "viewer.health.why.config_unreadable",
        fix: {
          descriptionI18nKey: "viewer.health.fix.config_unreadable.description",
          command: `co-engram init --path ${dataRoot}`,
        },
      });
    } else {
      const lang = config["language"];
      const createdBy = config["defaultCreatedBy"];
      const ok = !!(lang && createdBy);
      checks.push({
        id: "config",
        label: "Config",
        status: ok ? "ok" : "warn",
        message: `language=${String(lang ?? "(missing)")}, defaultCreatedBy=${String(createdBy ?? "(missing)")}`,
        ...(ok
          ? {}
          : {
              whyI18nKey: "viewer.health.why.config_missing_fields",
              fix: {
                descriptionI18nKey:
                  "viewer.health.fix.config_missing_fields.description",
                command: `co-engram config set language zh && co-engram config set defaultCreatedBy <你的名字>`,
              },
            }),
      });
    }
  }

  // engram 数
  if (dataRootExists && isEngramWarehouse) {
    checks.push({
      id: "engrams",
      label: "Engrams",
      status: stats.total === 0 ? "warn" : "ok",
      message: `${stats.total} 条记忆${stats.archived ? `, ${stats.archived} archived` : ""}${stats.forgotten ? `, ${stats.forgotten} forgotten` : ""}`,
      detail: stats.total > 0 ? `by kind: ${formatDist(stats.byKind)}\nby status: ${formatDist(stats.byStatus)}` : undefined,
    });
  }

  // 索引
  if (dataRootExists && isEngramWarehouse) {
    const idxChecks = [
      { name: "engramIndex", file: indexes.engramIndex, label: "engram-index.json" },
      { name: "digestJsonl", file: indexes.digestJsonl, label: "digest.jsonl" },
      { name: "graphJson", file: indexes.graphJson, label: "graph.json" },
    ];
    for (const { name, file, label } of idxChecks) {
      if (!file.exists) {
        checks.push({
          id: `index_${name}`,
          label: `Index: ${label}`,
          status: "warn",
          message: "缺失(将在下次访问时重建)",
          whyI18nKey: "viewer.health.why.index_missing",
          fix: {
            descriptionI18nKey: "viewer.health.fix.index_missing.description",
            tool: "engram_doctor",
            argsHint: "{ incremental: false }",
          },
        });
      } else {
        checks.push({
          id: `index_${name}`,
          label: `Index: ${label}`,
          status: "ok",
          message: `${label} 存在 (${formatBytes(file.sizeBytes ?? 0)})`,
        });
      }
    }
  }

  // 候选提案
  if (dataRootExists && isEngramWarehouse) {
    const overThreshold = proposals.pending > 5;
    checks.push({
      id: "proposals",
      label: "Proposals",
      status: overThreshold ? "warn" : "info",
      message: `${proposals.pending} 个待处理 / ${proposals.total} 总计`,
      detail: proposals.pending > 0 ? "调 engram_list_proposals 审核,或忽略。" : undefined,
      ...(overThreshold
        ? {
            whyI18nKey: "viewer.health.why.proposals_pending_high",
            fix: {
              descriptionI18nKey: "viewer.health.fix.proposals_pending_high.description",
              tool: "engram_list_proposals",
            },
          }
        : {}),
    });
  }

  // Git
  if (dataRootExists) {
    if (!git.isRepo) {
      checks.push({
        id: "git",
        label: "Git",
        status: "warn",
        message: "不是 git 仓库(无版本历史,丢失无法恢复)",
        detail: "运行 'cd <dataRoot> && git init' 初始化。",
        whyI18nKey: "viewer.health.why.git_not_repo",
        fix: {
          descriptionI18nKey: "viewer.health.fix.git_not_repo.description",
          command: `cd ${dataRoot} && git init`,
        },
      });
    } else if (git.dirty) {
      const overThreshold = git.uncommittedCount > 10;
      checks.push({
        id: "git",
        label: "Git",
        status: overThreshold ? "warn" : "info",
        message: `${git.uncommittedCount} 个未提交变更`,
        detail: "co-engram 不会自动 commit;手动 commit 或配置 hook。",
        ...(overThreshold
          ? {
              whyI18nKey: "viewer.health.why.git_dirty_high",
              fix: {
                descriptionI18nKey: "viewer.health.fix.git_dirty_high.description",
                command: `cd ${dataRoot} && git add -A && git commit -m "chore(memory): sync engram updates"`,
                // tool="commit" 让 viewer 渲染「立即提交」按钮,POST /api/commit 一键落盘
                tool: "commit",
              },
            }
          : {}),
      });
    } else {
      checks.push({
        id: "git",
        label: "Git",
        status: "ok",
        message: "干净",
      });
    }
  }

  // merge driver
  if (dataRootExists && isEngramWarehouse) {
    if (!mergeDriver.configured) {
      checks.push({
        id: "merge_driver",
        label: "Merge Driver",
        status: "warn",
        message: "未配置 git merge driver(多人协作时 engram 合并会冲突)",
        detail: mergeDriver.detail,
        whyI18nKey: "viewer.health.why.merge_driver_missing",
        fix: {
          descriptionI18nKey: "viewer.health.fix.merge_driver_missing.description",
          command: "co-engram git enable",
          tool: "engram_sync",
        },
      });
    } else {
      checks.push({
        id: "merge_driver",
        label: "Merge Driver",
        status: "ok",
        message: "已配置",
      });
    }
  }

  // 总体
  const hasError = checks.some((c) => c.status === "error");
  const hasWarn = checks.some((c) => c.status === "warn");
  const overall: StatusSnapshot["overall"] = hasError
    ? "error"
    : hasWarn
      ? "warn"
      : "ok";

  return {
    generatedAt,
    dataRoot,
    dataRootExists,
    isEngramWarehouse,
    config,
    stats,
    indexes,
    proposals,
    git,
    mergeDriver,
    checks,
    overall,
  };
}

/**
 * 把 StatusSnapshot 格式化为人类可读文本
 */
export function formatStatusAsText(s: StatusSnapshot): string {
  const lines: string[] = [];
  lines.push(`[co-engram status] ${s.dataRoot}`);
  lines.push(`  generated: ${s.generatedAt}`);
  lines.push(`  overall:   ${badge(s.overall)}`);
  lines.push("");
  lines.push("Checks:");
  for (const c of s.checks) {
    lines.push(`  ${badge(c.status)} ${c.label}: ${c.message}`);
    if (c.detail) {
      for (const detailLine of c.detail.split("\n")) {
        lines.push(`        ${detailLine}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

function badge(status: HealthCheck["status"] | StatusSnapshot["overall"]): string {
  switch (status) {
    case "ok":
      return "[OK]";
    case "warn":
      return "[WARN]";
    case "error":
      return "[ERROR]";
    case "info":
      return "[INFO]";
    default:
      return "[?]";
  }
}

function statFile(path: string): { exists: boolean; mtime?: string; sizeBytes?: number } {
  if (!existsSync(path)) return { exists: false };
  try {
    const st = statSync(path);
    return { exists: true, mtime: st.mtime.toISOString(), sizeBytes: st.size };
  } catch {
    return { exists: false };
  }
}

function checkGit(dataRoot: string): StatusSnapshot["git"] {
  if (!existsSync(join(dataRoot, ".git"))) {
    return { isRepo: false, dirty: false, uncommittedCount: 0 };
  }
  try {
    const out = execSync("git status --porcelain", {
      cwd: dataRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const lines = out.split("\n").filter((l) => l.trim().length > 0);
    return { isRepo: true, dirty: lines.length > 0, uncommittedCount: lines.length };
  } catch {
    return { isRepo: true, dirty: false, uncommittedCount: 0 };
  }
}

function checkMergeDriver(dataRoot: string): StatusSnapshot["mergeDriver"] {
  if (!existsSync(join(dataRoot, ".git"))) {
    return { configured: false, detail: "不是 git 仓库,无需 merge driver" };
  }
  try {
    const configOut = execSync("git config --get-regexp 'merge\\.co-engram|merge\\.engram'", {
      cwd: dataRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const attrOut = execSync("git check-attr merge - engrams/README.md 2>/dev/null || true", {
      cwd: dataRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const configured = configOut.trim().length > 0 && attrOut.includes("merge: co-engram");
    return {
      configured,
      detail: configured
        ? undefined
        : "运行 'co-engram init' 或 'openclaw plugin co-engram auto-onboard' 自动配置。",
    };
  } catch {
    return { configured: false };
  }
}

function formatDist(d: Readonly<Record<string, number>>): string {
  return Object.entries(d)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}
