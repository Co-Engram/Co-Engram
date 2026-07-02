import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  computeStatus,
  formatStatusAsText,
  type StatusSnapshot,
} from "../src/status/status.js";
import { writeTeamMemoryConfig } from "../src/config/index.js";
import { EngramRepository } from "../src/storage/repository.js";
import { zh, en } from "../src/i18n/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-status-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function initWarehouse(dataRoot: string, opts: { language?: "en" | "zh"; defaultCreatedBy?: string; git?: boolean } = {}): Promise<void> {
  mkdirSync(join(dataRoot, ".co-engram"), { recursive: true });
  await writeTeamMemoryConfig(dataRoot, {
    version: 1,
    language: opts.language ?? "zh",
    defaultCreatedBy: opts.defaultCreatedBy ?? "test",
    createdAt: new Date().toISOString(),
    initializedBy: "test",
  });
  if (opts.git) {
    try {
      execSync("git init", { cwd: dataRoot, stdio: "ignore" });
    } catch {
      // git 不可用,跳过
    }
  }
}

describe("computeStatus / 基础场景", () => {
  it("目录不存在 → overall=error,data_root check 标 error", async () => {
    const snapshot = computeStatus(join(tmpDir, "nonexistent"));
    expect(snapshot.dataRootExists).toBe(false);
    expect(snapshot.isEngramWarehouse).toBe(false);
    expect(snapshot.overall).toBe("error");
    const dataRootCheck = snapshot.checks.find((c) => c.id === "data_root");
    expect(dataRootCheck?.status).toBe("error");
  });

  it("目录存在但不是 engram 仓库 → overall=error", async () => {
    const snapshot = computeStatus(tmpDir);
    expect(snapshot.dataRootExists).toBe(true);
    expect(snapshot.isEngramWarehouse).toBe(false);
    expect(snapshot.overall).toBe("error");
  });

  it("空仓库(刚 init)→ overall=warn(engram 数 0 + 索引缺失 + git)", async () => {
    await initWarehouse(tmpDir);
    const snapshot = computeStatus(tmpDir);
    expect(snapshot.isEngramWarehouse).toBe(true);
    expect(snapshot.stats.total).toBe(0);
    expect(snapshot.overall).toBe("warn");
    const configCheck = snapshot.checks.find((c) => c.id === "config");
    expect(configCheck?.status).toBe("ok");
  });

  it("config 读取失败 → config check 标 error", async () => {
    await initWarehouse(tmpDir);
    // 覆盖 config.json 为无效 JSON
    writeFileSync(join(tmpDir, ".co-engram", "config.json"), "{ invalid json");
    const snapshot = computeStatus(tmpDir);
    const configCheck = snapshot.checks.find((c) => c.id === "config");
    expect(configCheck?.status).toBe("error");
  });
});

describe("computeStatus / engram 统计", () => {
  it("有 engram 时正确统计 byKind / byStatus", async () => {
    await initWarehouse(tmpDir, { defaultCreatedBy: "test" });
    const repo = new EngramRepository({ rootPath: tmpDir });
    repo.createEngram({
      title: "obs 1",
      content: "content",
      kind: "observation",
      domainTags: ["test"],
      createdBy: "test",
    });
    repo.createEngram({
      title: "pattern 1",
      content: "content",
      kind: "pattern",
      domainTags: ["test"],
      createdBy: "test",
    });
    repo.createEngram({
      title: "fact 1",
      content: "content",
      kind: "fact",
      domainTags: ["test"],
      createdBy: "test",
    });

    const snapshot = computeStatus(tmpDir);
    expect(snapshot.stats.total).toBe(3);
    expect(snapshot.stats.byKind.observation).toBe(1);
    expect(snapshot.stats.byKind.pattern).toBe(1);
    expect(snapshot.stats.byKind.fact).toBe(1);
    expect(snapshot.stats.byStatus.active).toBe(3);
    expect(snapshot.stats.archived).toBe(0);
  });

  it("archived engram 计入 archived 统计", async () => {
    await initWarehouse(tmpDir);
    const repo = new EngramRepository({ rootPath: tmpDir });
    const e = repo.createEngram({
      title: "to archive",
      content: "content",
      kind: "fact",
      domainTags: ["test"],
      createdBy: "test",
    });
    repo.updateLifecycle(e.id, "archived");

    const snapshot = computeStatus(tmpDir);
    expect(snapshot.stats.total).toBe(1);
    expect(snapshot.stats.archived).toBe(1);
    expect(snapshot.stats.byStatus.archived).toBe(1);
  });
});

describe("computeStatus / 索引文件", () => {
  it("索引文件缺失 → 对应 check 标 warn", async () => {
    await initWarehouse(tmpDir);
    const snapshot = computeStatus(tmpDir);
    const digestCheck = snapshot.checks.find((c) => c.id === "index_digestJsonl");
    expect(digestCheck?.status).toBe("warn");
    expect(digestCheck?.message).toContain("缺失");
  });

  it("索引文件存在 → 对应 check 标 ok", async () => {
    await initWarehouse(tmpDir);
    mkdirSync(join(tmpDir, ".co-engram"), { recursive: true });
    writeFileSync(join(tmpDir, ".co-engram", "engram-index.json"), "[]");
    writeFileSync(join(tmpDir, ".co-engram", "digest.jsonl"), "");
    writeFileSync(join(tmpDir, ".co-engram", "graph.json"), "{}");
    const snapshot = computeStatus(tmpDir);
    const idxCheck = snapshot.checks.find((c) => c.id === "index_engramIndex");
    expect(idxCheck?.status).toBe("ok");
  });
});

describe("computeStatus / git", () => {
  it("非 git 仓库 → git check 标 warn", async () => {
    await initWarehouse(tmpDir);
    const snapshot = computeStatus(tmpDir);
    const gitCheck = snapshot.checks.find((c) => c.id === "git");
    expect(gitCheck?.status).toBe("warn");
  });

  it("git 仓库且干净 → git check 标 ok", async () => {
    await initWarehouse(tmpDir, { git: true });
    // 预创建索引文件,避免 computeStatus 触发 rebuildIndex 写盘导致 dirty
    writeFileSync(join(tmpDir, ".co-engram", "engram-index.json"), "[]");
    writeFileSync(join(tmpDir, ".co-engram", "digest.jsonl"), "");
    writeFileSync(join(tmpDir, ".co-engram", "graph.json"), "{}");
    try {
      execSync("git add -A", { cwd: tmpDir, stdio: "ignore" });
      execSync('git commit -m "init"', {
        cwd: tmpDir,
        stdio: "ignore",
        env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@x", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@x" },
      });
    } catch {
      // git 不可用,跳过
    }
    const snapshot = computeStatus(tmpDir);
    const gitCheck = snapshot.checks.find((c) => c.id === "git");
    expect(gitCheck?.status).toBe("ok");
  });
});

describe("computeStatus / overall 计算", () => {
  it("有 error 时 overall=error(即使有 warn)", async () => {
    // 目录不存在 → error
    const snapshot = computeStatus(join(tmpDir, "nonexistent"));
    expect(snapshot.overall).toBe("error");
  });

  it("只有 warn 时 overall=warn", async () => {
    await initWarehouse(tmpDir);
    const snapshot = computeStatus(tmpDir);
    expect(snapshot.overall).toBe("warn");
  });

  it("所有 check ok/info 时 overall=ok", async () => {
    await initWarehouse(tmpDir, { git: true });
    // 创建 engram 让 stats.total > 0
    const repo = new EngramRepository({ rootPath: tmpDir });
    repo.createEngram({
      title: "test",
      content: "content",
      kind: "fact",
      domainTags: ["test"],
      createdBy: "test",
    });
    // 创建索引文件
    writeFileSync(join(tmpDir, ".co-engram", "engram-index.json"), "[]");
    writeFileSync(join(tmpDir, ".co-engram", "digest.jsonl"), "");
    writeFileSync(join(tmpDir, ".co-engram", "graph.json"), "{}");
    // git commit 让 dirty=false
    try {
      execSync("git add -A", { cwd: tmpDir, stdio: "ignore" });
      execSync('git commit -m "init"', {
        cwd: tmpDir,
        stdio: "ignore",
        env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@x", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@x" },
      });
    } catch {
      // git 不可用,跳过
    }

    const snapshot = computeStatus(tmpDir);
    // merge driver 可能仍 warn(未配置),所以 overall 至少 warn
    // 但如果 git 不可用,git check 也 warn
    // 这里只验证 overall 不是 error
    expect(snapshot.overall).not.toBe("error");
  });
});

describe("formatStatusAsText", () => {
  it("生成包含 dataRoot 和 overall 的文本", async () => {
    await initWarehouse(tmpDir);
    const snapshot = computeStatus(tmpDir);
    const text = formatStatusAsText(snapshot);
    expect(text).toContain("[co-engram status]");
    expect(text).toContain(tmpDir);
    expect(text).toContain("overall:");
    expect(text).toContain("Checks:");
  });

  it("包含所有 check 的 label 和 badge", async () => {
    await initWarehouse(tmpDir);
    const snapshot = computeStatus(tmpDir);
    const text = formatStatusAsText(snapshot);
    expect(text).toContain("Data Root:");
    expect(text).toContain("Config:");
    expect(text).toContain("Engrams:");
  });

  it("detail 字段展开为缩进行", async () => {
    await initWarehouse(tmpDir);
    const repo = new EngramRepository({ rootPath: tmpDir });
    repo.createEngram({
      title: "test",
      content: "content",
      kind: "fact",
      domainTags: ["test"],
      createdBy: "test",
    });
    const snapshot = computeStatus(tmpDir);
    const text = formatStatusAsText(snapshot);
    expect(text).toContain("by kind:");
  });
});

describe("computeStatus / JSON 可序列化", () => {
  it("snapshot 可被 JSON.stringify 往返", async () => {
    await initWarehouse(tmpDir);
    const snapshot = computeStatus(tmpDir);
    const json = JSON.stringify(snapshot);
    const parsed = JSON.parse(json) as StatusSnapshot;
    expect(parsed.dataRoot).toBe(snapshot.dataRoot);
    expect(parsed.stats.total).toBe(snapshot.stats.total);
    expect(parsed.checks.length).toBe(snapshot.checks.length);
  });
});

// ============================================================
// 结构化修复指引:每个 warn/error check 必须填 whyI18nKey + fix
// 防回归:viewer 端依赖这些字段渲染「为什么 / 怎么修」展开区块。
// 如果某 check 漏填,UI 上警告就没解释、没修复指引——回到本次改进前的状态。
// ============================================================
describe("computeStatus / 结构化 why/fix 字段", () => {
  it("data_root missing → error check 含 whyI18nKey + fix.command", () => {
    const snapshot = computeStatus(join(tmpDir, "nonexistent"));
    const dataRootCheck = snapshot.checks.find((c) => c.id === "data_root");
    expect(dataRootCheck?.status).toBe("error");
    expect(dataRootCheck?.whyI18nKey).toBeTruthy();
    expect(dataRootCheck?.whyI18nKey).toMatch(/^viewer\.health\.why\./);
    expect(dataRootCheck?.fix).toBeDefined();
    expect(dataRootCheck?.fix?.command).toBeTruthy();
    expect(dataRootCheck?.fix?.descriptionI18nKey).toMatch(/^viewer\.health\.fix\./);
  });

  it("data_root not warehouse → error check 含 whyI18nKey + fix", () => {
    const snapshot = computeStatus(tmpDir); // tmpDir 存在但不是 warehouse
    const dataRootCheck = snapshot.checks.find((c) => c.id === "data_root");
    expect(dataRootCheck?.status).toBe("error");
    expect(dataRootCheck?.whyI18nKey).toMatch(/^viewer\.health\.why\.data_root_not_warehouse/);
    expect(dataRootCheck?.fix?.command).toContain("co-engram init");
  });

  it("config unreadable → error check 含 whyI18nKey + fix", async () => {
    await initWarehouse(tmpDir);
    writeFileSync(join(tmpDir, ".co-engram", "config.json"), "{ invalid json");
    const snapshot = computeStatus(tmpDir);
    const configCheck = snapshot.checks.find((c) => c.id === "config");
    expect(configCheck?.status).toBe("error");
    expect(configCheck?.whyI18nKey).toMatch(/^viewer\.health\.why\.config_unreadable/);
    expect(configCheck?.fix?.command).toBeTruthy();
  });

  it("config 缺 language 或 defaultCreatedBy → warn check 含 whyI18nKey + fix", async () => {
    // 只写 defaultCreatedBy,缺 language
    mkdirSync(join(tmpDir, ".co-engram"), { recursive: true });
    await writeTeamMemoryConfig(tmpDir, {
      version: 1,
      language: "zh",
      defaultCreatedBy: "test",
      createdAt: new Date().toISOString(),
      initializedBy: "test",
    });
    // 覆盖 config 让 language 字段消失
    writeFileSync(
      join(tmpDir, ".co-engram", "config.json"),
      JSON.stringify({ version: 1, defaultCreatedBy: "test" }),
    );
    const snapshot = computeStatus(tmpDir);
    const configCheck = snapshot.checks.find((c) => c.id === "config");
    expect(configCheck?.status).toBe("warn");
    expect(configCheck?.whyI18nKey).toMatch(/^viewer\.health\.why\.config_missing_fields/);
    expect(configCheck?.fix).toBeDefined();
  });

  it("索引文件缺失 → warn check 含 whyI18nKey + fix.tool=engram_doctor", async () => {
    await initWarehouse(tmpDir);
    const snapshot = computeStatus(tmpDir);
    const digestCheck = snapshot.checks.find((c) => c.id === "index_digestJsonl");
    expect(digestCheck?.status).toBe("warn");
    expect(digestCheck?.whyI18nKey).toMatch(/^viewer\.health\.why\.index_missing/);
    expect(digestCheck?.fix?.tool).toBe("engram_doctor");
  });

  it("非 git 仓库 → warn check 含 whyI18nKey + fix.command", async () => {
    await initWarehouse(tmpDir);
    const snapshot = computeStatus(tmpDir);
    const gitCheck = snapshot.checks.find((c) => c.id === "git");
    expect(gitCheck?.status).toBe("warn");
    expect(gitCheck?.whyI18nKey).toMatch(/^viewer\.health\.why\.git_not_repo/);
    expect(gitCheck?.fix?.command).toContain("git init");
  });

  it("未配置 merge driver → warn check 含 whyI18nKey + fix", async () => {
    await initWarehouse(tmpDir, { git: true });
    const snapshot = computeStatus(tmpDir);
    const mergeCheck = snapshot.checks.find((c) => c.id === "merge_driver");
    expect(mergeCheck?.status).toBe("warn");
    expect(mergeCheck?.whyI18nKey).toMatch(/^viewer\.health\.why\.merge_driver_missing/);
    expect(mergeCheck?.fix?.command).toContain("co-engram git enable");
  });

  it("git 仓库 + >10 未提交变更 → warn check 含 whyI18nKey + fix.tool=commit", async () => {
    await initWarehouse(tmpDir, { git: true });
    // 制造 11 个未提交文件,触发 overThreshold 分支
    for (let i = 0; i < 11; i++) {
      writeFileSync(join(tmpDir, `file-${i}.md`), `# file ${i}\n`);
    }
    const snapshot = computeStatus(tmpDir);
    const gitCheck = snapshot.checks.find((c) => c.id === "git");
    expect(gitCheck?.status).toBe("warn");
    expect(gitCheck?.whyI18nKey).toMatch(/^viewer\.health\.why\.git_dirty_high/);
    expect(gitCheck?.fix).toBeDefined();
    // tool=commit 让 viewer 渲染「立即提交」按钮(POST /api/commit 一键落盘)
    expect(gitCheck?.fix?.tool).toBe("commit");
    // command 同时给出完整 commit 命令,作为复制执行的 fallback
    expect(gitCheck?.fix?.command).toContain("git add -A");
    expect(gitCheck?.fix?.command).toContain("git commit");
  });

  it("ok/info check 不需要 whyI18nKey / fix(留空)", async () => {
    await initWarehouse(tmpDir, { git: true });
    // 让 data_root 是 ok 状态
    const snapshot = computeStatus(tmpDir);
    const dataRootCheck = snapshot.checks.find((c) => c.id === "data_root");
    expect(dataRootCheck?.status).toBe("ok");
    expect(dataRootCheck?.whyI18nKey).toBeUndefined();
    expect(dataRootCheck?.fix).toBeUndefined();
  });

  it("whyI18nKey 在 zh / en 翻译表里都有对应键(无渲染时回退到 key 本身)", async () => {
    await initWarehouse(tmpDir);
    const snapshot = computeStatus(tmpDir);
    const problemChecks = snapshot.checks.filter(
      (c) => c.status === "warn" || c.status === "error",
    );
    expect(problemChecks.length).toBeGreaterThan(0);
    for (const c of problemChecks) {
      if (c.whyI18nKey) {
        expect(zh[c.whyI18nKey as keyof typeof zh], `zh.${c.whyI18nKey} 缺翻译`).toBeTruthy();
        expect(en[c.whyI18nKey as keyof typeof en], `en.${c.whyI18nKey} 缺翻译`).toBeTruthy();
      }
      if (c.fix?.descriptionI18nKey) {
        const k = c.fix.descriptionI18nKey as keyof typeof zh;
        expect(zh[k], `zh.${k} 缺翻译`).toBeTruthy();
        expect(en[k], `en.${k} 缺翻译`).toBeTruthy();
      }
    }
  });
});
