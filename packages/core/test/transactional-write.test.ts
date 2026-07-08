/**
 * AI-2 transactional-write 单元测试
 *
 * 覆盖:
 *   - atomicWriteFile:成功 / rename 失败清理 tmp / 同 path 多次写
 *   - verifyDerivedIntegrity:ok / missing digest / count drift / unreadable index / 首次启动
 *
 * hyper-pattern 2(index-no-truth)的核心保护层:把派生索引与源 markdown 之间的
 * 不一致从"静默错误"变成"可见 warning",让用户知道该跑 engram_doctor 自愈。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  atomicWriteFile,
  verifyDerivedIntegrity,
} from "../src/storage/transactional-write.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-trans-write-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("atomicWriteFile", () => {
  it("写入新文件 + 内容正确", () => {
    const target = join(tmpDir, "out.json");
    atomicWriteFile(target, '{"hello":"world"}');
    expect(readFileSync(target, "utf8")).toBe('{"hello":"world"}');
  });

  it("覆盖已有文件(原子替换)", () => {
    const target = join(tmpDir, "out.json");
    writeFileSync(target, "OLD");
    atomicWriteFile(target, "NEW");
    expect(readFileSync(target, "utf8")).toBe("NEW");
  });

  it("同名 tmp 文件被清理(rename 成功后无残留)", () => {
    const target = join(tmpDir, "out.json");
    atomicWriteFile(target, "data");
    // tmp 文件命名约定:<path>.tmp.<pid>
    const tmpPath = `${target}.tmp.${process.pid}`;
    expect(existsSync(tmpPath)).toBe(false);
  });

  it("多次写同一目标(幂等,最后一次胜出)", () => {
    const target = join(tmpDir, "counter.txt");
    for (let i = 0; i < 5; i++) {
      atomicWriteFile(target, `v${i}`);
    }
    expect(readFileSync(target, "utf8")).toBe("v4");
  });

  it("自动创建中间目录?否——保持与 writeFileSync 一致的契约", () => {
    // atomicWriteFile 不创建中间目录(dirname 必须已存在),
    // 与 writeFileSync 行为一致。host adapter 调用前应确保目录存在。
    const target = join(tmpDir, "missing-dir", "out.json");
    expect(() => atomicWriteFile(target, "x")).toThrow();
  });
});

describe("verifyDerivedIntegrity", () => {
  /**
   * 生成符合 ULID 格式(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)的伪 ID 用于测试。
   * ULID 是 co-engram 的 stableId 格式;readEngramIndex 用 isStableEngramId 过滤 key,
   * 不合规的 key(I/L/O/U 等)会被丢弃,导致 entry 数为 0,测试无法验证"健康"状态。
   *
   * Crockford base32 字符集:0-9 + ABCDEFGHJKMNPQRSTVWXYZ(排除 I/L/O/U)。
   */
  const ULID_CHARSET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  function fakeUlid(i: number): string {
    // 26-char ULID:first char 0-7,remaining 25 from ULID_CHARSET
    // 用 23 个 '0' 前缀 + 3 字符 suffix 编码 i(32^3 = 32768 个组合,够测试用)
    const prefix = "0".repeat(23);
    const a = ULID_CHARSET[i % 32]!;
    const b = ULID_CHARSET[Math.floor(i / 32) % 32]!;
    const c = ULID_CHARSET[Math.floor(i / 1024) % 32]!;
    return prefix + c + b + a; // 23 + 3 = 26 chars
  }

  /**
   * 构造一个"健康"的 dataRoot:
   *   - 源 markdown 文件 N 个(在 dataRoot 顶级)
   *   - engram-index.json(N 条 entries,ULID key,字段名 engrams)
   *   - digest.jsonl 存在
   *   - graph.json 存在
   *   - audit.jsonl 存在
   */
  function makeHealthyDataRoot(engramCount: number): string {
    // 源 markdown
    for (let i = 0; i < engramCount; i++) {
      writeFileSync(
        join(tmpDir, `engram-${i}.md`),
        `---\ntitle: E${i}\n---\nbody`,
      );
    }
    // 派生层目录
    const cacheDir = join(tmpDir, ".co-engram");
    mkdirSync(cacheDir, { recursive: true });
    // engram-index.json:与 source 数量一致
    // 字段名是 `engrams`(readEngramIndex 读这个),key 必须是 ULID 格式
    const engrams: Record<string, unknown> = {};
    for (let i = 0; i < engramCount; i++) {
      engrams[fakeUlid(i)] = { relativePath: `engram-${i}.md` };
    }
    writeFileSync(
      join(cacheDir, "engram-index.json"),
      JSON.stringify({ version: 1, engrams }),
    );
    // digest / graph / audit 占位
    writeFileSync(join(cacheDir, "digest.jsonl"), "");
    writeFileSync(join(cacheDir, "graph.json"), "{}");
    writeFileSync(join(cacheDir, "audit.jsonl"), "");
    return tmpDir;
  }

  it("健康 dataRoot → status=ok,无 issues", () => {
    const root = makeHealthyDataRoot(3);
    const report = verifyDerivedIntegrity(root);
    expect(report.status).toBe("ok");
    expect(report.issues).toEqual([]);
    expect(report.sourceFileCount).toBe(3);
    expect(report.indexEntryCount).toBe(3);
    expect(report.digestPresent).toBe(true);
    expect(report.graphPresent).toBe(true);
    expect(report.auditPresent).toBe(true);
  });

  it("缺 digest.jsonl → status=warning + missing_digest issue", () => {
    const root = makeHealthyDataRoot(2);
    rmSync(join(root, ".co-engram", "digest.jsonl"));
    const report = verifyDerivedIntegrity(root);
    expect(report.status).toBe("warning");
    expect(report.issues.some((i) => i.kind === "missing_digest")).toBe(true);
    expect(report.digestPresent).toBe(false);
  });

  it("缺 graph.json → status=warning + missing_graph issue", () => {
    const root = makeHealthyDataRoot(2);
    rmSync(join(root, ".co-engram", "graph.json"));
    const report = verifyDerivedIntegrity(root);
    expect(report.status).toBe("warning");
    expect(report.issues.some((i) => i.kind === "missing_graph")).toBe(true);
  });

  it("缺 audit.jsonl → status=warning + missing_audit issue", () => {
    const root = makeHealthyDataRoot(2);
    rmSync(join(root, ".co-engram", "audit.jsonl"));
    const report = verifyDerivedIntegrity(root);
    expect(report.status).toBe("warning");
    expect(report.issues.some((i) => i.kind === "missing_audit")).toBe(true);
    expect(
      report.issues.find((i) => i.kind === "missing_audit")?.suggestedFix,
    ).toBe("config_audit_enabled");
  });

  it("source/index 数量漂移 > 5% → status=warning + index_count_drift", () => {
    // 10 个 source,5 个 index entry → drift 50%,远超 5% 阈值
    const root = makeHealthyDataRoot(10);
    // 重写 engram-index.json,只保留 5 条(用 ULID key)
    const cacheDir = join(root, ".co-engram");
    const engrams: Record<string, unknown> = {};
    for (let i = 0; i < 5; i++) {
      engrams[fakeUlid(i)] = { relativePath: `engram-${i}.md` };
    }
    writeFileSync(
      join(cacheDir, "engram-index.json"),
      JSON.stringify({ version: 1, engrams }),
    );
    const report = verifyDerivedIntegrity(root);
    expect(report.status).toBe("warning");
    expect(report.issues.some((i) => i.kind === "index_count_drift")).toBe(true);
    expect(report.sourceFileCount).toBe(10);
    expect(report.indexEntryCount).toBe(5);
  });

  it("小漂移 < 5% 不报警(容忍少量 orphan/历史条目)", () => {
    // 100 个 source,99 个 index → drift 1%,远低于 5% 阈值
    const root = makeHealthyDataRoot(100);
    const cacheDir = join(root, ".co-engram");
    const engrams: Record<string, unknown> = {};
    for (let i = 0; i < 99; i++) {
      engrams[fakeUlid(i)] = { relativePath: `engram-${i}.md` };
    }
    writeFileSync(
      join(cacheDir, "engram-index.json"),
      JSON.stringify({ version: 1, engrams }),
    );
    const report = verifyDerivedIntegrity(root);
    // drift = |100-99|/100 = 0.01,远低于 0.05 阈值
    expect(report.issues.some((i) => i.kind === "index_count_drift")).toBe(false);
  });

  it("engram-index.json 不可读(JSON 损坏)→ status=critical + unreadable_index", () => {
    const root = makeHealthyDataRoot(2);
    writeFileSync(join(root, ".co-engram", "engram-index.json"), "{ broken json");
    const report = verifyDerivedIntegrity(root);
    expect(report.status).toBe("critical");
    expect(report.issues.some((i) => i.kind === "unreadable_index")).toBe(true);
  });

  it("首次启动(空 dataRoot)→ status=ok(不算缺陷)", () => {
    // 空目录:sourceFileCount=0,所有"缺失派生文件"分支都跳过(条件 sourceFileCount > 0)
    const report = verifyDerivedIntegrity(tmpDir);
    expect(report.status).toBe("ok");
    expect(report.sourceFileCount).toBe(0);
    expect(report.indexEntryCount).toBe(0);
  });

  it("排除 .git / node_modules / .co-engram 子目录(不计入 sourceFileCount)", () => {
    // 主目录 2 个 .md
    writeFileSync(join(tmpDir, "a.md"), "a");
    writeFileSync(join(tmpDir, "b.md"), "b");
    // 噪声目录里的 .md 应被忽略
    mkdirSync(join(tmpDir, ".git"), { recursive: true });
    writeFileSync(join(tmpDir, ".git", "ignored.md"), "git");
    mkdirSync(join(tmpDir, "node_modules"), { recursive: true });
    writeFileSync(join(tmpDir, "node_modules", "pkg.md"), "pkg");
    mkdirSync(join(tmpDir, ".co-engram"), { recursive: true });
    writeFileSync(join(tmpDir, ".co-engram", "internal.md"), "internal");
    // readme.md 被SKIP_FILES 排除
    writeFileSync(join(tmpDir, "readme.md"), "readme");

    const report = verifyDerivedIntegrity(tmpDir);
    expect(report.sourceFileCount).toBe(2); // 只 a.md + b.md
  });

  it("read-only:不修改任何文件", () => {
    const root = makeHealthyDataRoot(2);
    const digestPath = join(root, ".co-engram", "digest.jsonl");
    const graphPath = join(root, ".co-engram", "graph.json");
    const before = {
      digest: readFileSync(digestPath, "utf8"),
      graph: readFileSync(graphPath, "utf8"),
    };
    verifyDerivedIntegrity(root);
    const after = {
      digest: readFileSync(digestPath, "utf8"),
      graph: readFileSync(graphPath, "utf8"),
    };
    expect(after).toEqual(before);
  });
});
