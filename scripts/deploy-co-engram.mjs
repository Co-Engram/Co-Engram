#!/usr/bin/env node
/**
 * deploy-co-engram.mjs — 一键部署 co-engram 到运行中的 OpenClaw gateway
 *
 * 起因(2026-07):co-engram 是跨宿主插件,改源码后部署链路长且易错:
 *   1. 删 tsbuildinfo(防半刷新)
 *   2. build core / viewer / openclaw-plugin / claude-code-mcp
 *   3. verify i18n dist 一致性(防 src/dict drift)
 *   4. cp dist 到 ~/.openclaw/npm/node_modules/@co-engram/{core,viewer,openclaw}/dist
 *      (openclaw sync-deps 在 real-copy 状态下 noop,不可靠)
 *      + (--cli-global) cp 到 /opt/nodejs/lib/node_modules/@co-engram/claude-code/
 *        {dist + node_modules/@co-engram/{core,viewer}/dist}
 *   5. openclaw gateway restart
 *   6. 等待加载完成 + 健康检查
 *
 * 任何一步失败 → 立即 abort,输出诊断信息。禁止半新半旧部署。
 *
 * 用法:
 *   node scripts/deploy-co-engram.mjs             # 完整部署 + 重启
 *   node scripts/deploy-co-engram.mjs --no-restart # 只 build + cp,不重启(测试用)
 *   node scripts/deploy-co-engram.mjs --cli-global # 同时部署到 CLI 全局路径
 *                                                  # /opt/nodejs/lib/node_modules/@co-engram/claude-code/
 *
 * 退出码:
 *   0 — 部署成功,gateway 健康
 *   非 0 — 任何步骤失败,abort
 *
 * @module co-engram/scripts/deploy-co-engram
 */
import { spawn } from "node:child_process";
import { rm, readdir, stat, cp, readFile, symlink, readlink, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const HOME = homedir();

// buildAll: 全部参与 buildPackages()
// openclawDeploy: 是否 cp 到 OpenClaw npm node_modules(claude-code-mcp 不部署到 OpenClaw,
//   只走 CLI global 路径;但仍需 build 以保证 cli-global cp 拿到最新 dist)
const PACKAGES = [
  { name: "@co-engram/core", filter: "@co-engram/core", src: "packages/core", openclawDeploy: true },
  { name: "@co-engram/viewer", filter: "@co-engram/viewer", src: "packages/viewer", openclawDeploy: true },
  {
    name: "@co-engram/openclaw",
    filter: "@co-engram/openclaw",
    src: "packages/openclaw-plugin",
    openclawDeploy: true,
  },
  {
    name: "@co-engram/claude-code",
    filter: "@co-engram/claude-code", // 注意:package name 是 @co-engram/claude-code,目录是 claude-code-mcp
    src: "packages/claude-code-mcp",
    openclawDeploy: false,
  },
];

const OPENCLAW_DEPLOY_ROOT = join(
  HOME,
  ".openclaw",
  "npm",
  "node_modules",
  "@co-engram",
);

const CLI_GLOBAL_ROOT = "/opt/nodejs/lib/node_modules/@co-engram/claude-code";

const VIEWER_PORT = 18899;
const GATEWAY_WAIT_MS = 25_000;

const args = new Set(process.argv.slice(2));
const NO_RESTART = args.has("--no-restart");
const CLI_GLOBAL = args.has("--cli-global");

function log(msg) {
  console.log(`[deploy] ${msg}`);
}
function err(msg) {
  console.error(`[deploy:ERROR] ${msg}`);
}

async function run(cmd, cmdArgs, opts = {}) {
  const { cwd = ROOT, ignoreExitCode = false } = opts;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, cmdArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => {
      stdout += c.toString();
    });
    child.stderr?.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code !== 0 && !ignoreExitCode) {
        const e = new Error(
          `${cmd} ${cmdArgs.join(" ")} 退出码 ${code}\n${stderr}`,
        );
        e.stdout = stdout;
        e.stderr = stderr;
        e.code = code;
        rejectPromise(e);
      } else {
        resolvePromise({ stdout, stderr, code });
      }
    });
  });
}

async function deleteTsbuildinfo() {
  log("步骤 1/6: 删除 tsbuildinfo(防 dist 半刷新)...");
  // 详见 [[tsbuildinfo-stale-dist]]:tsc composite 缓存会让 src 改动后 dist 不刷新
  const { execSync } = await import("node:child_process");
  execSync(
    `find ${ROOT} -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete`,
    { stdio: "inherit" },
  );
  log("  ✓ tsbuildinfo 已清");
}

async function buildPackages() {
  log("步骤 2/6: build core / viewer / openclaw-plugin / claude-code-mcp...");
  for (const pkg of PACKAGES) {
    log(`  → pnpm --filter ${pkg.filter} build`);
    const result = await run("pnpm", ["--filter", pkg.filter, "build"]);
    // pnpm 在「No projects matched」时 exit 0(quirk),必须显式检查输出
    // 否则 filter 名错会静默跳过 build,只看到旧 dist 存在就报成功(fail-silent 反模式)
    const combined = result.stdout + result.stderr;
    if (combined.includes("No projects matched")) {
      throw new Error(
        `${pkg.name}: pnpm filter "${pkg.filter}" 未匹配任何项目(检查 package.json 的 name 字段)`,
      );
    }
    const distPath = join(ROOT, pkg.src, "dist");
    if (!existsSync(distPath)) {
      throw new Error(`${pkg.name}: build 后 ${distPath} 不存在`);
    }
    log(`    ✓ ${pkg.name} dist 已生成`);
  }
}

async function verifyI18n() {
  log("步骤 3/6: 验证 i18n dist 一致性...");
  await run("node", [join("scripts", "verify-i18n-dist.mjs")]);
  log("  ✓ i18n dist 一致");
}

async function cpDistToOpenclaw() {
  log(`步骤 4/6: cp dist 到 ${OPENCLAW_DEPLOY_ROOT}...`);
  if (!existsSync(OPENCLAW_DEPLOY_ROOT)) {
    throw new Error(
      `OpenClaw 部署目录不存在: ${OPENCLAW_DEPLOY_ROOT}\n` +
        `请确认已通过 openclaw plugins install co-engram 安装`,
    );
  }
  for (const pkg of PACKAGES) {
    if (!pkg.openclawDeploy) continue; // claude-code-mcp 跳过
    const src = join(ROOT, pkg.src, "dist");
    // openclaw 包目录名:packages/openclaw-plugin 对应 @co-engram/openclaw,
    // 其他包名与目录名一致(core→core, viewer→viewer)
    const pkgDirName = pkg.name.replace("@co-engram/", "");
    const dstParent = join(OPENCLAW_DEPLOY_ROOT, pkgDirName, "dist");
    if (!existsSync(join(OPENCLAW_DEPLOY_ROOT, pkgDirName))) {
      throw new Error(
        `${pkg.name} 未在 ${OPENCLAW_DEPLOY_ROOT} 中找到,请先 openclaw plugins install`,
      );
    }
    // cp -rT: 把 src 的内容直接覆盖到 dstParent(覆盖而非嵌套)
    await rm(dstParent, { recursive: true, force: true });
    await cp(src, dstParent, { recursive: true });
    log(`  ✓ ${pkg.name}: ${src} → ${dstParent}`);
  }
}

async function cpDistToCliGlobal() {
  if (!CLI_GLOBAL) return;
  log(`步骤 4b/6 (--cli-global): cp dist 到 ${CLI_GLOBAL_ROOT}...`);
  if (!existsSync(CLI_GLOBAL_ROOT)) {
    throw new Error(
      `CLI 全局路径不存在: ${CLI_GLOBAL_ROOT}\n` +
        `请确认已通过 npm install -g @co-engram/claude-code 安装`,
    );
  }
  // claude-code CLI 自身 + 嵌套 core/viewer
  const targets = [
    {
      src: join(ROOT, "packages", "claude-code-mcp", "dist"),
      dst: join(CLI_GLOBAL_ROOT, "dist"),
      label: "@co-engram/claude-code (CLI 自身)",
    },
    {
      src: join(ROOT, "packages", "core", "dist"),
      dst: join(CLI_GLOBAL_ROOT, "node_modules", "@co-engram", "core", "dist"),
      label: "@co-engram/core (CLI 嵌套)",
    },
    {
      src: join(ROOT, "packages", "viewer", "dist"),
      dst: join(CLI_GLOBAL_ROOT, "node_modules", "@co-engram", "viewer", "dist"),
      label: "@co-engram/viewer (CLI 嵌套)",
    },
  ];
  for (const t of targets) {
    if (!existsSync(t.src)) {
      throw new Error(`${t.label}: src 不存在 ${t.src}(buildPackages 应已构建,请检查)`);
    }
    await rm(t.dst, { recursive: true, force: true });
    await cp(t.src, t.dst, { recursive: true });
    log(`  ✓ ${t.label}`);
  }
  // sync bin symlinks:cp dist 不会触发 npm 重链接,新加的 bin(如 co-engram-mcp-daemon)
  // 需手动创建 symlink,读 package.json bin 字段循环同步
  const pkgJson = JSON.parse(
    await readFile(join(ROOT, "packages", "claude-code-mcp", "package.json"), "utf8"),
  );
  const binField = pkgJson.bin || {};
  const BIN_DIR = "/opt/nodejs/bin";
  // 从 BIN_DIR 到 CLI_GLOBAL_ROOT/dist/<entry> 的相对路径
  // BIN_DIR = /opt/nodejs/bin, CLI_GLOBAL_ROOT = /opt/nodejs/lib/node_modules/@co-engram/claude-code
  // 相对:../lib/node_modules/@co-engram/claude-code/<entry>
  for (const [binName, entry] of Object.entries(binField)) {
    if (typeof entry !== "string") continue;
    const entryRel = entry.replace(/^\.\//, "");
    const symlinkPath = join(BIN_DIR, binName);
    const target = join(
      "..",
      "lib",
      "node_modules",
      "@co-engram",
      "claude-code",
      entryRel,
    );
    let needCreate = false;
    try {
      const existing = await readlink(symlinkPath);
      if (existing !== target) {
        await rm(symlinkPath, { force: true });
        needCreate = true;
      }
    } catch {
      needCreate = true;
    }
    if (needCreate) {
      await symlink(target, symlinkPath);
      log(`  ✓ bin symlink: ${binName} → ${target}`);
    }
    // tsc 不保留 src 的 +x 权限,dist/*.js 默认 0644;bin 入口需要可执行
    // npm publish 时会自动加 +x,但 cp dist 不触发 npm 机制,手动补
    const targetAbs = join(CLI_GLOBAL_ROOT, entryRel);
    if (existsSync(targetAbs)) {
      await chmod(targetAbs, 0o755);
    }
  }
}

async function restartGateway() {
  if (NO_RESTART) {
    log("步骤 5/6: 跳过 gateway 重启(--no-restart)");
    return;
  }
  log("步骤 5/6: 重启 OpenClaw gateway...");
  await run("openclaw", ["gateway", "restart"], { ignoreExitCode: true });
  log(`  → 等待 ${GATEWAY_WAIT_MS / 1000}s 让 plugin 加载完成...`);
  await new Promise((r) => setTimeout(r, GATEWAY_WAIT_MS));
}

async function healthCheck() {
  log("步骤 6/6: 健康检查...");
  // gateway status
  const statusRes = await run("openclaw", ["gateway", "status"], {
    ignoreExitCode: true,
  });
  const statusText = (statusRes.stdout + statusRes.stderr).toLowerCase();
  if (!statusText.includes("running")) {
    err("gateway status 输出:");
    err(statusRes.stdout + statusRes.stderr);
    throw new Error("gateway 未进入 running 状态");
  }
  log("  ✓ gateway running");

  if (NO_RESTART) {
    log("  (--no-restart: 跳过 viewer 端口探测)");
    return;
  }

  // viewer port 探测(允许失败,因为 viewer 端口仅在 plugin loaded 后开)
  const probeRes = await run(
    "curl",
    ["-sf", `http://127.0.0.1:${VIEWER_PORT}/`, "-o", "/dev/null", "-w", "%{http_code}"],
    { ignoreExitCode: true },
  );
  const httpCode = probeRes.stdout.trim();
  if (httpCode === "200") {
    log(`  ✓ viewer port ${VIEWER_PORT} 返回 200`);
  } else {
    err(`  ✗ viewer port ${VIEWER_PORT} 返回 ${httpCode || "(连接失败)"}`);
    err("  gateway 已 running 但 viewer 未起来,可能是 plugin load 异常");
    err("  排查:openclaw plugins inspect co-engram");
    throw new Error("viewer 健康检查失败");
  }
}

async function main() {
  console.log(
    "━ deploy-co-engram: 一键部署 co-engram 到 OpenClaw gateway ━",
  );
  if (NO_RESTART) console.log("  (mode: --no-restart,不重启 gateway)");
  if (CLI_GLOBAL) console.log("  (mode: --cli-global,同时部署 CLI 全局路径)");

  try {
    await deleteTsbuildinfo();
    await buildPackages();
    await verifyI18n();
    await cpDistToOpenclaw();
    await cpDistToCliGlobal();
    await restartGateway();
    await healthCheck();
    console.log("\n[deploy] ✓ 部署成功");
  } catch (e) {
    err(`部署失败: ${e.message}`);
    if (e.stderr) err(e.stderr);
    process.exit(1);
  }
}

main();
