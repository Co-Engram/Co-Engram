import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Deployed global CLI smoke(兜底:防部署态 stale dist 漂移)
 *
 * 为什么需要这条测试(测试盲区复盘):
 *   所有单元/集成测试都在 dev 解析图里跑——`@co-engram/core` 经 pnpm workspace
 *   永远指向新鲜源码/dist,永远看不见「部署态」的全局安装
 *   (`/opt/nodejs/lib/node_modules/@co-engram/claude-code/` 内嵌的 core/viewer dist)。
 *   一旦 core 新增导出(如 readMaintenanceState)后忘记 `pnpm deploy:cli-global`,
 *   全局 `co-engram` 二进制加载即 SyntaxError,而 `pnpm test` 仍全绿。
 *
 *   本测试 spawn 真二进制 `/opt/nodejs/bin/co-engram`,在进程启动时触发完整 ESM 模块
 *   实例化(所有 `import { ... } from "@co-engram/core"` 求值),任何缺失导出都会以
 *   SyntaxError 爆出——补上 dev 测试够不到的部署态盲区。
 *
 *   全局安装不存在时(如 CI、其它开发机)整体 skip,不阻断。
 *   失败修复:`pnpm deploy:cli-global`(postbuild 自动部署启用后通常不会再触发)。
 */
const GLOBAL_BIN = "/opt/nodejs/bin/co-engram";

describe.skipIf(!existsSync(GLOBAL_BIN))(
  "deployed global CLI smoke(防部署态 stale dist)",
  () => {
    function runGlobal(args: string[]): {
      stdout: string;
      stderr: string;
      status: number | null;
    } {
      try {
        const stdout = execFileSync(GLOBAL_BIN, args, {
          encoding: "utf8",
          timeout: 20_000,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env },
        });
        return { stdout, stderr: "", status: 0 };
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; status?: number };
        return {
          stdout: err.stdout ?? "",
          stderr: err.stderr ?? "",
          status: err.status ?? null,
        };
      }
    }

    it("全局 co-engram 能加载:`config data-root` 不抛 stale-dist SyntaxError", () => {
      const { stdout, stderr, status } = runGlobal(["config", "data-root"]);
      const combined = stdout + stderr;
      expect(
        combined,
        "全局 CLI 加载失败,疑似部署 dist stale(缺 core/viewer 新增导出)。\n" +
          "修复:pnpm deploy:cli-global\n\n实际输出:\n" +
          combined,
      ).not.toContain("SyntaxError");
      expect(combined, "同上,模块导出缺失").not.toContain(
        "does not provide an export named",
      );
      // 健康时应输出 data-root(确认不是「没报错但也没干活」)
      expect(
        stdout.toLowerCase(),
        "应输出 data-root,实际 stdout:\n" + stdout,
      ).toContain("data-root");
    });
  },
);
