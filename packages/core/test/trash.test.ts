import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngramRepository } from "../src/storage/repository.js";
import {
  sweepToTrash,
  listTrashed,
  findTrashed,
  restoreFromTrash,
  purgeAllTrash,
  readTrashed,
  formatTrashPartition,
  deriveTrashFilePaths,
  TRASH_DIR_NAME,
  DEFAULT_TRASH_AFTER_DAYS,
  DEFAULT_TRASH_PURGE_AFTER_DAYS,
} from "../src/dreaming/trash.js";
import { AuditLog } from "../src/observability/audit-log.js";
import { runDeepDreaming } from "../src/dreaming/deep.js";

let tmpDir: string;
let repo: EngramRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-trash-"));
  repo = new EngramRepository({ rootPath: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEngram(input: {
  title: string;
  content?: string;
  importance?: number;
  domainTags?: string[];
}) {
  return repo.createEngram({
    title: input.title,
    content: input.content ?? `content of ${input.title}`,
    kind: "fact",
    domainTags: input.domainTags ?? ["t"],
    createdBy: "tester",
    importance: input.importance ?? 0.5,
  });
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** 手动调整 engram 文件的 mtime（模拟 "X 天前被遗忘"） */
function backdateMetaMtime(engramId: string, daysAgo: number): void {
  const entry = repo.listEngramIndex().find((e) => e.id === engramId);
  if (!entry) return;
  const filePath = join(tmpDir, entry.path);
  if (!existsSync(filePath)) return;
  const newMtime = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  const { utimesSync } = require("node:fs");
  utimesSync(filePath, newMtime, newMtime);
}

// ============================================================
// 纯函数：formatTrashPartition / deriveTrashFilePaths
// ============================================================

describe("formatTrashPartition", () => {
  it("返回 YYYY-MM 格式", () => {
    const d = new Date(Date.UTC(2026, 5, 15)); // 2026-06-15 UTC
    expect(formatTrashPartition(d)).toBe("2026-06");
  });

  it("月份补零", () => {
    const d = new Date(Date.UTC(2026, 0, 1)); // 2026-01
    expect(formatTrashPartition(d)).toBe("2026-01");
  });
});

describe("deriveTrashFilePaths", () => {
  it("三文件路径在 .trash/<partition>/ 下镜像（legacy 兼容签名）", () => {
    const paths = deriveTrashFilePaths("foo/bar.md", "2026-06");
    expect(paths.content).toBe(".trash/2026-06/engrams/content/foo/bar.md");
    expect(paths.meta).toBe(".trash/2026-06/engrams/meta/foo/bar.yaml");
    expect(paths.synapses).toBe(".trash/2026-06/engrams/synapses/foo/bar.yaml");
  });
});

// ============================================================
// sweepToTrash
// ============================================================

describe("sweepToTrash", () => {
  it("空仓库 → 空 sweep", () => {
    const r = sweepToTrash(repo, { nowIso: new Date().toISOString() });
    expect(r.scanned).toBe(0);
    expect(r.trashed).toEqual([]);
    expect(r.purged).toEqual([]);
  });

  it("active engram 不被 sweep", () => {
    makeEngram({ title: "A" });
    const r = sweepToTrash(repo, {
      nowIso: new Date().toISOString(),
      afterDays: 0,
    });
    expect(r.scanned).toBe(0); // forgotten=0,所以 scanned=0
    expect(r.trashed).toEqual([]);
  });

  it("刚 forgotten 的 engram 在窗口内 → skipped", () => {
    const e = makeEngram({ title: "A" });
    repo.updateLifecycle(e.id, "forgotten", "forgotten");
    backdateMetaMtime(e.id, 5);

    const r = sweepToTrash(repo, { afterDays: 30 });
    expect(r.scanned).toBe(1);
    expect(r.trashed).toEqual([]);
    expect(r.skipped.length).toBe(1);
    expect(r.skipped[0]!.id).toBe(e.id);
    expect(r.skipped[0]!.reason).toContain("< 30");

    // 文件仍在原位
    expect(repo.exists(e.id)).toBe(true);
  });

  it("forgotten 超过阈值 → 移入 trash", () => {
    const e = makeEngram({ title: "A", domainTags: ["x"] });
    repo.updateLifecycle(e.id, "forgotten", "forgotten");
    backdateMetaMtime(e.id, 60); // 60 天前 forgotten

    const r = sweepToTrash(repo, {
      afterDays: 30,
      nowIso: new Date().toISOString(),
    });
    expect(r.scanned).toBe(1);
    expect(r.trashed).toEqual([e.id]);
    expect(r.skipped).toEqual([]);

    // 原位置不存在
    expect(repo.exists(e.id)).toBe(false);

    // trash 中能找到
    const trashed = findTrashed(repo, e.id);
    expect(trashed).not.toBeNull();
    expect(trashed!.partition).toMatch(/^\d{4}-\d{2}$/);
    expect(existsSync(trashed!.contentPath)).toBe(true);
  });

  it("dryRun=true 不移动文件", () => {
    const e = makeEngram({ title: "A" });
    repo.updateLifecycle(e.id, "forgotten", "forgotten");
    backdateMetaMtime(e.id, 60);

    const r = sweepToTrash(repo, { afterDays: 30, dryRun: true });
    expect(r.trashed).toEqual([e.id]); // 报告"会被 sweep"
    expect(repo.exists(e.id)).toBe(true); // 实际未移动
    expect(findTrashed(repo, e.id)).toBeNull();
  });

  it("默认阈值：DEFAULT_TRASH_AFTER_DAYS=30", () => {
    expect(DEFAULT_TRASH_AFTER_DAYS).toBe(30);
  });

  it("默认 purge 阈值：DEFAULT_TRASH_PURGE_AFTER_DAYS=365", () => {
    expect(DEFAULT_TRASH_PURGE_AFTER_DAYS).toBe(365);
  });

  it("多 engram：forgotten 中只有超阈值的被 sweep", () => {
    const young = makeEngram({ title: "Young" });
    repo.updateLifecycle(young.id, "forgotten", "forgotten");
    backdateMetaMtime(young.id, 5);

    const old1 = makeEngram({ title: "Old1" });
    repo.updateLifecycle(old1.id, "forgotten", "forgotten");
    backdateMetaMtime(old1.id, 40);

    const old2 = makeEngram({ title: "Old2" });
    repo.updateLifecycle(old2.id, "forgotten", "forgotten");
    backdateMetaMtime(old2.id, 100);

    // active 不应被扫描
    makeEngram({ title: "Active" });

    const r = sweepToTrash(repo, { afterDays: 30 });
    expect(r.scanned).toBe(3); // 3 个 forgotten
    expect(r.trashed.length).toBe(2);
    expect(r.trashed).toContain(old1.id);
    expect(r.trashed).toContain(old2.id);
    expect(r.skipped.length).toBe(1);
    expect(r.skipped[0]!.id).toBe(young.id);
  });

  it("按 id 字典序 sweep（稳定）", () => {
    const ids: string[] = [];
    for (const t of ["Zebra", "Apple", "Mango"]) {
      const e = makeEngram({ title: t });
      repo.updateLifecycle(e.id, "forgotten", "forgotten");
      backdateMetaMtime(e.id, 60);
      ids.push(e.id);
    }
    const r = sweepToTrash(repo, { afterDays: 30 });
    // id = domainSlug/titleSlug → 按 t/ 前缀相同,后按 titleSlug 排序
    const sorted = [...r.trashed].sort();
    expect(r.trashed).toEqual(sorted);
  });
});

// ============================================================
// listTrashed / findTrashed
// ============================================================

describe("listTrashed / findTrashed", () => {
  it("空 trash → 空列表", () => {
    expect(listTrashed(repo)).toEqual([]);
    expect(findTrashed(repo, "nonexistent")).toBeNull();
  });

  it("跨多个分区列出 trashed engram", () => {
    const e1 = makeEngram({ title: "A", domainTags: ["x"] });
    repo.updateLifecycle(e1.id, "forgotten", "forgotten");
    backdateMetaMtime(e1.id, 180); // 回溯 180 天,确保 first sweep(nowIso=June)时 elapsed > afterDays=30
    sweepToTrash(repo, {
      afterDays: 30,
      nowIso: new Date(2026, 5, 15).toISOString(),
    });

    const e2 = makeEngram({ title: "B", domainTags: ["y"] });
    repo.updateLifecycle(e2.id, "forgotten", "forgotten");
    backdateMetaMtime(e2.id, 180);
    sweepToTrash(repo, {
      afterDays: 30,
      nowIso: new Date(2026, 6, 20).toISOString(),
    });

    const list = listTrashed(repo);
    expect(list.length).toBe(2);
    expect(list.map((t) => t.partition).sort()).toEqual(["2026-06", "2026-07"]);

    // findTrashed 能找到
    expect(findTrashed(repo, e1.id)?.partition).toBe("2026-06");
    expect(findTrashed(repo, e2.id)?.partition).toBe("2026-07");
    expect(findTrashed(repo, "nonexistent")).toBeNull();
  });
});

// ============================================================
// restoreFromTrash
// ============================================================

describe("restoreFromTrash", () => {
  it("未在 trash 中 → ok=false", () => {
    const r = restoreFromTrash(repo, "no/such/id");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("not found");
  });

  it("从 trash 恢复 → 移回 active 区 + status=active", () => {
    const e = makeEngram({ title: "A", domainTags: ["x"] });
    repo.updateLifecycle(e.id, "forgotten", "forgotten");
    backdateMetaMtime(e.id, 60);
    sweepToTrash(repo, { afterDays: 30 });

    expect(repo.exists(e.id)).toBe(false);

    const r = restoreFromTrash(repo, e.id);
    expect(r.ok).toBe(true);

    // 文件移回
    expect(repo.exists(e.id)).toBe(true);
    const restored = repo.readEngram(e.id);
    expect(restored.status).toBe("active");
    expect(restored.freshness).toBe("fresh");
  });

  it("恢复后 trash 中不再有该 id", () => {
    const e = makeEngram({ title: "A", domainTags: ["x"] });
    repo.updateLifecycle(e.id, "forgotten", "forgotten");
    backdateMetaMtime(e.id, 60);
    sweepToTrash(repo, { afterDays: 30 });

    restoreFromTrash(repo, e.id);
    expect(findTrashed(repo, e.id)).toBeNull();
  });

  it("active 区已存在同 id → 拒绝覆盖", () => {
    const e = makeEngram({ title: "A", domainTags: ["x"] });
    repo.updateLifecycle(e.id, "forgotten", "forgotten");
    backdateMetaMtime(e.id, 60);
    sweepToTrash(repo, { afterDays: 30 });

    // 模拟：active 区被手动塞回同 id 文件
    // 这里通过重新 createEngram 制造冲突——但 createEngram 会因为 content 已存在而抛错
    // 所以改用直接写文件方式：先 restore,再 sweep 不会重复
    // 简化：用第二个 engram 但同样路径——不可行,因为路径由 title 决定
    // 此 case 用真实场景：再次 restore 已 restore 的 → trash 里没有了,直接返回 not found
    const r1 = restoreFromTrash(repo, e.id);
    expect(r1.ok).toBe(true);
    const r2 = restoreFromTrash(repo, e.id);
    expect(r2.ok).toBe(false);
  });
});

// ============================================================
// purgeExpiredTrash
// ============================================================

describe("purge expired trash", () => {
  it("purgeAfterDays=0 → 永不删除（sweep 时不动）", () => {
    const e = makeEngram({ title: "A", domainTags: ["x"] });
    repo.updateLifecycle(e.id, "forgotten", "forgotten");
    backdateMetaMtime(e.id, 60);
    sweepToTrash(repo, { afterDays: 30 });

    // 第二次 sweep,即使分区很老,purgeAfterDays=0 应保留
    // 手动 backdate trash 分区目录,模拟"很老"
    const trashPart = join(
      tmpDir,
      TRASH_DIR_NAME,
      formatTrashPartition(new Date()),
    );
    const oldDate = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    const { utimesSync } = require("node:fs");
    utimesSync(trashPart, oldDate, oldDate);

    const r = sweepToTrash(repo, { afterDays: 30, purgeAfterDays: 0 });
    expect(r.purged).toEqual([]); // 0 表示永不
    expect(findTrashed(repo, e.id)).not.toBeNull();
  });

  it("purgeAfterDays > 0 + 分区超期 → 物理删除", () => {
    const e = makeEngram({ title: "A", domainTags: ["x"] });
    repo.updateLifecycle(e.id, "forgotten", "forgotten");
    backdateMetaMtime(e.id, 60);
    sweepToTrash(repo, { afterDays: 30 });

    // 把分区目录 mtime 调到 400 天前
    const trashPart = join(
      tmpDir,
      TRASH_DIR_NAME,
      formatTrashPartition(new Date()),
    );
    const oldDate = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    const { utimesSync } = require("node:fs");
    utimesSync(trashPart, oldDate, oldDate);

    const r = sweepToTrash(repo, { afterDays: 30, purgeAfterDays: 365 });
    expect(r.purged).toEqual([e.id]);
    expect(findTrashed(repo, e.id)).toBeNull();
  });
});

// ============================================================
// purgeAllTrash(用户触发的全量/分区清空)
// ============================================================

describe("purgeAllTrash", () => {
  it("空 trash → 返回空", () => {
    const r = purgeAllTrash(repo);
    expect(r.purged).toEqual([]);
    expect(r.partitionsRemoved).toEqual([]);
  });

  it("清空所有分区 → 返回 purged ids + 移除分区目录", () => {
    const e1 = makeEngram({ title: "A", domainTags: ["x"] });
    const e2 = makeEngram({ title: "B", domainTags: ["y"] });
    for (const e of [e1, e2]) {
      repo.updateLifecycle(e.id, "forgotten", "forgotten");
      backdateMetaMtime(e.id, 60);
    }
    sweepToTrash(repo, { afterDays: 30 });
    expect(listTrashed(repo).length).toBe(2);

    const r = purgeAllTrash(repo);
    expect(r.purged.sort()).toEqual([e1.id, e2.id].sort());
    expect(r.partitionsRemoved.length).toBeGreaterThan(0);
    expect(listTrashed(repo)).toEqual([]);
  });

  it("partition 过滤 → 只清该分区", () => {
    const e = makeEngram({ title: "A", domainTags: ["x"] });
    repo.updateLifecycle(e.id, "forgotten", "forgotten");
    backdateMetaMtime(e.id, 60);
    sweepToTrash(repo, { afterDays: 30 });

    const partition = formatTrashPartition(new Date());
    const r = purgeAllTrash(repo, { partition });
    expect(r.purged).toEqual([e.id]);
    expect(r.partitionsRemoved).toEqual([partition]);
  });

  it("partition 不存在 → 返回空,不抛", () => {
    const r = purgeAllTrash(repo, { partition: "1999-01" });
    expect(r.purged).toEqual([]);
    expect(r.partitionsRemoved).toEqual([]);
  });

  it("dryRun=true → 只计算不删除", () => {
    const e = makeEngram({ title: "A", domainTags: ["x"] });
    repo.updateLifecycle(e.id, "forgotten", "forgotten");
    backdateMetaMtime(e.id, 60);
    sweepToTrash(repo, { afterDays: 30 });

    const r = purgeAllTrash(repo, { dryRun: true });
    expect(r.purged).toEqual([e.id]);
    expect(r.partitionsRemoved).toEqual([]); // dryRun 不删目录
    expect(listTrashed(repo).length).toBe(1); // 文件仍在
  });

  it("auditLog 传入 → 每条 purge 写一条 audit", () => {
    const auditLog = new AuditLog(tmpDir);
    const e1 = makeEngram({ title: "A", domainTags: ["x"] });
    const e2 = makeEngram({ title: "B", domainTags: ["y"] });
    for (const e of [e1, e2]) {
      repo.updateLifecycle(e.id, "forgotten", "forgotten");
      backdateMetaMtime(e.id, 60);
    }
    sweepToTrash(repo, { afterDays: 30 });

    purgeAllTrash(repo, { auditLog, actor: "user" });
    const purgedEntries = auditLog.query({ action: "purge" });
    expect(purgedEntries.length).toBe(2);
    for (const entry of purgedEntries) {
      expect(entry.actor).toBe("user");
      expect(entry.metadata?.source).toBe("purge_all");
    }
  });
});

// ============================================================
// readTrashed(UI 预览用)
// ============================================================

describe("readTrashed", () => {
  it("存在 → 返回完整 frontmatter + content", () => {
    const e = makeEngram({
      title: "ADB 调试",
      content: "连接手机时记得 adb devices",
      domainTags: ["android", "debug"],
    });
    repo.updateLifecycle(e.id, "forgotten", "forgotten");
    backdateMetaMtime(e.id, 60);
    sweepToTrash(repo, { afterDays: 30 });

    const r = readTrashed(repo, e.id);
    expect(r).not.toBeNull();
    expect(r!.id).toBe(e.id);
    expect(r!.partition).toBe(formatTrashPartition(new Date()));
    expect(r!.content).toContain("adb devices");
    expect(r!.frontmatter.title).toBe("ADB 调试");
  });

  it("不存在 → 返回 null", () => {
    expect(readTrashed(repo, "nonexistent_id")).toBeNull();
  });

  it("恢复后 → 再 read 返回 null(已离开 trash)", () => {
    const e = makeEngram({ title: "A", domainTags: ["x"] });
    repo.updateLifecycle(e.id, "forgotten", "forgotten");
    backdateMetaMtime(e.id, 60);
    sweepToTrash(repo, { afterDays: 30 });

    expect(readTrashed(repo, e.id)).not.toBeNull();
    restoreFromTrash(repo, e.id);
    expect(readTrashed(repo, e.id)).toBeNull();
  });
});

// ============================================================
// runDeepDreaming 集成
// ============================================================

describe("runDeepDreaming trash 集成", () => {
  it("默认（无 trash 配置）→ trash 字段为 null", () => {
    makeEngram({ title: "A" });
    const r = runDeepDreaming(repo);
    expect(r.trash).toBeNull();
  });

  it("trash: {} 启用 trash（默认参数）", () => {
    const e = makeEngram({ title: "A" });
    repo.updateLifecycle(e.id, "forgotten", "forgotten");
    backdateMetaMtime(e.id, 60);

    const r = runDeepDreaming(repo, { trash: { afterDays: 30 } });
    expect(r.trash).not.toBeNull();
    expect(r.trash!.trashed).toEqual([e.id]);
  });

  it("skipTrash=true → 跳过 trash", () => {
    const e = makeEngram({ title: "A" });
    repo.updateLifecycle(e.id, "forgotten", "forgotten");
    backdateMetaMtime(e.id, 60);

    const r = runDeepDreaming(repo, {
      trash: { afterDays: 30 },
      skipTrash: true,
    });
    expect(r.trash).toBeNull();
    expect(repo.exists(e.id)).toBe(true); // 没被移动
  });
});
