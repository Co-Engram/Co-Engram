/**
 * 从本地 git 配置探测默认作者标识
 *
 * 用于在不强制用户配置的情况下,把 engram_create / synapse_create 的 `createdBy`
 * 默认值绑定到本机 git 身份。优先 `user.name`(人类可读),其次 `user.email`。
 *
 * 容错策略:
 *   - git 未安装(`ENOENT`)→ 返回 undefined
 *   - git 退出非零(配置缺失)→ 返回 undefined
 *   - 命令输出为空或仅空白 → 返回 undefined
 *   - 其它异常一律返回 undefined(绝不抛出)
 *
 * 注意:`git config user.name` 不要求当前目录是 git 仓库,会读 global / system
 * 配置。因此即便 dataRoot 尚未 git init,只要用户做过 `git config --global user.name`,
 * 仍能拿到身份。
 *
 * @module @co-engram/core/host
 */

import { execFileSync, type SpawnSyncReturns } from "node:child_process";

/**
 * 读取单条 git 配置值。
 *
 * 返回去首尾空白后的字符串;配置不存在或 git 不可用时返回 undefined。
 */
function readGitConfig(key: "user.name" | "user.email"): string | undefined {
  try {
    const result = execFileSync("git", ["config", key], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }) as string;
    const trimmed = result.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch (err) {
    // ENOENT:git 未安装
    // 非零退出:key 不存在
    // timeout:git 卡住(罕见)
    // 一律静默返回 undefined,绝不影响宿主启动
    void (err as SpawnSyncReturns<Buffer>);
    return undefined;
  }
}

/**
 * 从本地 git 配置探测默认作者标识
 *
 * 解析顺序:`user.name` → `user.email`。两者皆无或 git 不可用时返回 undefined,
 * 由调用方继续回退到 env / config / 'unknown'。
 */
export function detectGitAuthor(): string | undefined {
  return readGitConfig("user.name") ?? readGitConfig("user.email");
}
