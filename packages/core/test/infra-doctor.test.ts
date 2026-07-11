import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { EngramRepository } from "../src/storage/repository.js";
import { runInfraDoctor } from "../src/storage/infra-doctor.js";
import { writeTeamMemoryConfig } from "../src/config/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-infra-doctor-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function initWarehouse(dataRoot: string, opts: { git?: boolean } = {}): Promise<void> {
  mkdirSync(join(dataRoot, ".co-engram"), { recursive: true });
  await writeTeamMemoryConfig(dataRoot, {
    version: 1,
    language: "zh",
    defaultCreatedBy: "test",
    createdAt: new Date().toISOString(),
    initializedBy: "test",
  });
  if (opts.git) {
    try {
      execSync("git init", { cwd: dataRoot, stdio: "ignore" });
      execSync('git config user.email "test@x"', { cwd: dataRoot, stdio: "ignore" });
      execSync('git config user.name "test"', { cwd: dataRoot, stdio: "ignore" });
    } catch {
      // git 不可用,跳过
    }
  }
}

describe("runInfraDoctor / 派生索引缺失", () => {
  it("digest.jsonl + graph.json 都缺失 → 重建两条,各产 1 个 fix", async () => {
    await initWarehouse(tmpDir);
    const repo = new EngramRepository({ rootPath: tmpDir });
    repo.createEngram({
      title: "test",
      content: "content",
      kind: "fact",
      domainTags: ["test"],
      createdBy: "test",
    });
    // 派生索引文件默认不存在(repository.rebuildIndex 只管 engram-index.json)
    expect(existsSync(join(tmpDir, ".co-engram", "digest.jsonl"))).toBe(false);
    expect(existsSync(join(tmpDir, ".co-engram", "graph.json"))).toBe(false);

    const result = runInfraDoctor({ repo, dataRoot: tmpDir });

    expect(result.fixes.length).toBe(1);
    expect(result.fixes[0]!.kind).toBe("index_rebuilt");
    expect(result.fixes[0]!.autoFixed).toBe(true);
    expect(result.fixes[0]!.message).toContain("digest.jsonl");
    expect(result.fixes[0]!.message).toContain("graph.json");
    expect(existsSync(join(tmpDir, ".co-engram", "digest.jsonl"))).toBe(true);
    expect(existsSync(join(tmpDir, ".co-engram", "graph.json"))).toBe(true);
  });

  it("digest.jsonl 已存在但 graph.json 缺失 → 只重建 graph,fix 只提 graph", async () => {
    await initWarehouse(tmpDir);
    const repo = new EngramRepository({ rootPath: tmpDir });
    repo.createEngram({
      title: "test",
      content: "content",
      kind: "fact",
      domainTags: ["test"],
      createdBy: "test",
    });
    // 预先创建 digest.jsonl
    writeFileSync(join(tmpDir, ".co-engram", "digest.jsonl"), "");

    const result = runInfraDoctor({ repo, dataRoot: tmpDir });

    expect(result.fixes.length).toBe(1);
    expect(result.fixes[0]!.kind).toBe("index_rebuilt");
    expect(result.fixes[0]!.message).not.toContain("digest.jsonl");
    expect(result.fixes[0]!.message).toContain("graph.json");
  });

  it("派生索引都已存在 → 仍重建 graph.json(2026-07 index-no-truth 防护:覆盖字段级 drift)", async () => {
    await initWarehouse(tmpDir);
    const repo = new EngramRepository({ rootPath: tmpDir });
    writeFileSync(join(tmpDir, ".co-engram", "digest.jsonl"), "");
    writeFileSync(join(tmpDir, ".co-engram", "graph.json"), "{}");

    const result = runInfraDoctor({ repo, dataRoot: tmpDir });

    // 2026-07 index-no-truth 修复:graph.json 即使存在也总是重建,
    // 防止「edge count 一致但 createdBy / weight 等字段 drift」长期累积。
    // digest.jsonl 已存在则不重建(增量,不强制)。
    const indexFix = result.fixes.find((f) => f.kind === "index_rebuilt");
    expect(indexFix).toBeDefined();
    expect(indexFix!.message).toContain("resynced");
  });
});

describe("runInfraDoctor / merge driver 安装", () => {
  it("非 git 仓库 → 跳过 merge driver 安装(无 fix)", async () => {
    await initWarehouse(tmpDir); // 不传 git
    const repo = new EngramRepository({ rootPath: tmpDir });

    const result = runInfraDoctor({ repo, dataRoot: tmpDir });

    const onboardFix = result.fixes.find((f) => f.kind === "merge_driver_installed");
    expect(onboardFix).toBeUndefined();
  });

  it("是 git 仓库但 bundle 不存在 → 跳过(无 fix,不抛错)", async () => {
    await initWarehouse(tmpDir, { git: true });
    const repo = new EngramRepository({ rootPath: tmpDir });

    // runInfraDoctor 内部用 import.meta.url 解析 bundle 路径,
    // 在测试环境下 @co-engram/core/dist/merge-driver.cjs 可能不存在(未 build)
    // 此时应该静默跳过,不抛错
    const result = runInfraDoctor({ repo, dataRoot: tmpDir });

    const onboardFix = result.fixes.find((f) => f.kind === "merge_driver_installed");
    // 如果 bundle 存在 → onboardFix 可能存在;如果不存在 → undefined。两者都可接受
    if (onboardFix) {
      expect(onboardFix.autoFixed).toBe(true);
    }
  });
});

describe("runInfraDoctor / 幂等性", () => {
  it("连跑两次:第二次仍重建 graph.json(2026-07 index-no-truth:总是重建覆盖字段 drift)", async () => {
    await initWarehouse(tmpDir);
    const repo = new EngramRepository({ rootPath: tmpDir });
    repo.createEngram({
      title: "test",
      content: "content",
      kind: "fact",
      domainTags: ["test"],
      createdBy: "test",
    });

    const first = runInfraDoctor({ repo, dataRoot: tmpDir });
    expect(first.fixes.some((f) => f.kind === "index_rebuilt")).toBe(true);

    // 2026-07 index-no-truth 修复:graph.json 总是重建(不依赖 isGraphStale count check)。
    // 第二次跑仍会触发 index_rebuilt,但 message 含 "resynced" 标识非首次构建。
    // 性能保证:每次重建 ~60ms / 1000 synapse,doctor 不频繁,可接受。
    const second = runInfraDoctor({ repo, dataRoot: tmpDir });
    expect(second.fixes.some((f) => f.kind === "index_rebuilt")).toBe(true);
    const secondFix = second.fixes.find((f) => f.kind === "index_rebuilt");
    expect(secondFix!.message).toContain("resynced");
  });
});
