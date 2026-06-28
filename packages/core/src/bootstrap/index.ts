/**
 * Bootstrap 配置:dataRoot 的单一权威入口
 *
 * 设计动机:
 *   co-engram 启动时需要先找到 dataRoot,但 dataRoot 内的 `.co-engram/config.json`
 *   又保存了大部分配置 —— "鸡生蛋" 问题。本模块解决这个悖论:
 *
 *   - **bootstrap 配置文件位置固定**:`~/.co-engram/config.json`(用户 home 下,
 *     不在 dataRoot 内),只保存 dataRoot 一个字段
 *   - **单一权威入口**:用户通过 `co-engram config data-root <path>` CLI 命令修改
 *   - **不再支持 env / openclaw.json / viewer UI 修改 dataRoot**(避免多处入口造成混乱)
 *
 * 解析优先级:
 *   1. `~/.co-engram/config.json:dataRoot`(权威)
 *   2. `$HOME/team-memory`(默认 fallback)
 *
 * 异常处理:
 *   - bootstrap 文件不存在 → fallback 到默认 + warning(首次运行场景)
 *   - bootstrap 文件损坏 → 备份后重建 + warning
 *   - dataRoot 字段缺失 → fallback 到默认 + warning
 *
 * @module @co-engram/core/bootstrap
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** bootstrap 配置文件名 */
export const BOOTSTRAP_CONFIG_FILENAME = "config.json";

/** bootstrap 配置目录(用户 home 下,固定) */
export function getBootstrapDir(): string {
  return join(process.env.HOME ?? "/tmp", ".co-engram");
}

/** bootstrap 配置文件完整路径 */
export function getBootstrapConfigPath(): string {
  return join(getBootstrapDir(), BOOTSTRAP_CONFIG_FILENAME);
}

/** 默认 dataRoot fallback */
export function getDefaultDataRoot(): string {
  return join(process.env.HOME ?? "/tmp", "team-memory");
}

/** bootstrap 配置 schema */
export interface BootstrapConfig {
  /** schema 版本 */
  readonly version: 1;
  /** 数据根目录(绝对路径) */
  readonly dataRoot: string;
}

/** resolve 结果来源标签 */
export type BootstrapSource =
  | "bootstrap-config" // 正常从 ~/.co-engram/config.json 读到
  | "default" // fallback 到默认 $HOME/team-memory
  | "repaired"; // bootstrap 损坏,备份重建后用默认

/** resolve 结果 */
export interface BootstrapResolveResult {
  /** 解析后的 dataRoot(绝对路径) */
  readonly dataRoot: string;
  /** 来源 */
  readonly source: BootstrapSource;
  /** 用户可读的 warning 列表(stderr 输出用) */
  readonly warnings: readonly string[];
}

/**
 * 解析当前 dataRoot
 *
 * 调用方:mcp-server / openclaw plugin-entry 启动时调用一次,
 * 拿到 dataRoot 后再 loadAndSelfHealConfig 加载完整配置。
 */
export async function resolveBootstrapDataRoot(): Promise<BootstrapResolveResult> {
  const path = getBootstrapConfigPath();
  const defaultRoot = getDefaultDataRoot();
  const warnings: string[] = [];

  if (!existsSync(path)) {
    // 首次运行 / 配置被删除:fallback 到默认,提示用户运行 CLI 配置
    warnings.push(
      `Bootstrap config not found at ${path}. Using default ${defaultRoot}. Run 'co-engram config data-root <path>' to change.`,
    );
    return { dataRoot: defaultRoot, source: "default", warnings };
  }

  let raw: BootstrapConfig | undefined;
  try {
    const content = await readFile(path, "utf-8");
    const parsed = JSON.parse(content) as BootstrapConfig;
    if (parsed && typeof parsed === "object" && parsed.version === 1) {
      raw = parsed;
    }
  } catch {
    // JSON 损坏:备份后重建
  }

  if (raw === undefined) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${path}.broken.${ts}`;
    try {
      await rename(path, backupPath);
    } catch {
      // 备份失败不阻塞
    }
    await writeBootstrapDataRoot(defaultRoot);
    warnings.push(
      `Bootstrap config at ${path} was corrupt; backed up to ${backupPath}. Using default ${defaultRoot}.`,
    );
    return { dataRoot: defaultRoot, source: "repaired", warnings };
  }

  const dataRoot = raw.dataRoot?.trim();
  if (!dataRoot) {
    warnings.push(
      `Bootstrap config at ${path} has no dataRoot field; using default ${defaultRoot}.`,
    );
    return { dataRoot: defaultRoot, source: "default", warnings };
  }

  return { dataRoot, source: "bootstrap-config", warnings };
}

/**
 * 写入 bootstrap dataRoot(CLI 调用)
 *
 * 创建父目录,完整覆盖文件。
 */
export async function writeBootstrapDataRoot(
  dataRoot: string,
): Promise<void> {
  const path = getBootstrapConfigPath();
  const config: BootstrapConfig = { version: 1, dataRoot };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * 读取 bootstrap dataRoot(同步,无错误抛出)
 *
 * CLI 显示当前值时使用。文件不存在或损坏返回 undefined。
 */
export function readBootstrapDataRootSync(): string | undefined {
  const path = getBootstrapConfigPath();
  if (!existsSync(path)) return undefined;
  try {
    const content = readFileSync(path, "utf-8");
    const parsed = JSON.parse(content) as BootstrapConfig;
    if (parsed && typeof parsed === "object" && parsed.version === 1) {
      return parsed.dataRoot?.trim() || undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 同步 resolve 结果来源标签 */
export type BootstrapSourceSync =
  | "bootstrap-config"
  | "default"
  | "repaired";

/** 同步 resolve 结果(用于 OpenClaw 等要求 register 同步的宿主) */
export interface BootstrapResolveSyncResult {
  /** 解析后的 dataRoot(绝对路径) */
  readonly dataRoot: string;
  /** 来源 */
  readonly source: BootstrapSourceSync;
  /** 用户可读的 warning 列表(stderr 输出用) */
  readonly warnings: readonly string[];
}

/**
 * 同步解析当前 dataRoot
 *
 * OpenClaw 1.8+ 要求 plugin register() 同步完成,无法 await 异步 fs,
 * 这里用 readFileSync 替代。功能与 resolveBootstrapDataRoot 等价,
 * 但损坏文件时不做备份重建(只读 + warning)—— 重建由下次 CLI 调用完成。
 */
export function resolveBootstrapDataRootSync(): BootstrapResolveSyncResult {
  const path = getBootstrapConfigPath();
  const defaultRoot = getDefaultDataRoot();
  const warnings: string[] = [];

  if (!existsSync(path)) {
    warnings.push(
      `Bootstrap config not found at ${path}. Using default ${defaultRoot}. Run 'co-engram config data-root <path>' to change.`,
    );
    return { dataRoot: defaultRoot, source: "default", warnings };
  }

  let parsed: BootstrapConfig | undefined;
  try {
    const content = readFileSync(path, "utf-8");
    parsed = JSON.parse(content) as BootstrapConfig;
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1) {
      parsed = undefined;
    }
  } catch {
    parsed = undefined;
  }

  if (parsed === undefined) {
    warnings.push(
      `Bootstrap config at ${path} is corrupt or unreadable. Using default ${defaultRoot}. Run 'co-engram config data-root <path>' to repair.`,
    );
    return { dataRoot: defaultRoot, source: "repaired", warnings };
  }

  const dataRoot = parsed.dataRoot?.trim();
  if (!dataRoot) {
    warnings.push(
      `Bootstrap config at ${path} has no dataRoot field; using default ${defaultRoot}.`,
    );
    return { dataRoot: defaultRoot, source: "default", warnings };
  }

  return { dataRoot, source: "bootstrap-config", warnings };
}

// 共享 dataRoot 切换逻辑(CLI + viewer UI 都用)
export * from "./classify.js";
