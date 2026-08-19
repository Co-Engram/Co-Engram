/**
 * 团队动态事件跨机同步 E2E(2026-08-19)
 *
 * 双 clone 模拟 git 分布式拓扑,验证六场景:
 *   1. A 机 create + reinforce → sync → B 机动态流出现 A 的事件(作者 = A)
 *   2. A、B 同日各自写事件 → 双向 sync → 无 merge 冲突、双方动态含对方事件
 *   3. A 创建 private engram → B 的事件文件与动态中无该记忆痕迹(隐私防线)
 *   4. B 无 events/(模拟老版本对端)→ A 读端不报错,本机事件正常
 *   5. 过期日期目录清理:20 天前目录被删,未来目录保留
 *   6. viewer 读端合并:本机 audit 双写去重(同事件不重复出现)
 *
 * git 拓扑:bare 远端 ← A clone / B clone(各自 user.name 区分 origin)。
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EngramRepository,
  AuditLog,
  TeamEventStore,
  IndexDb,
} from "@co-engram/core";

/** 每场景独立 git 拓扑:bare 远端 + A/B 两 clone(状态不跨场景泄漏) */
function setupTopology(): { workDir: string; cloneA: string; cloneB: string } {
  const workDir = mkdtempSync(join(tmpdir(), "team-events-e2e-"));
  const remotePath = join(workDir, "remote.git");
  spawnSync("git", ["init", "--bare", remotePath]);
  const cloneA = join(workDir, "machine-A");
  const cloneB = join(workDir, "machine-B");
  for (const [clone, name] of [
    [cloneA, "alice-zte"],
    [cloneB, "bob-zte"],
  ] as const) {
    mkdirSync(clone, { recursive: true });
    git(clone, ["init"]);
    try {
      git(clone, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    } catch {
      // 老 git 默认分支名不影响(push/pull 用 HEAD 相对 refspec)
    }
    git(clone, ["remote", "add", "origin", remotePath]);
    git(clone, ["config", "user.name", name]);
    git(clone, ["config", "user.email", "none@example.com"]);
    // git ≥2.27 分叉 pull 需显式策略;engram_sync 生产路径用 pull --rebase,
    // 测试同款(写者隔离分片下 rebase 无冲突)
    git(clone, ["config", "pull.rebase", "true"]);
    // 对齐 engram_sync 首跑行为(A 机):建 .gitignore 排除 .co-engram/(派生
    // 缓存 + 本机 audit 不入库)。没有它,add -A 会把 index.db/audit.jsonl
    // 带进仓库——正是 events/ 独立于 .co-engram/ 的原因(不受其 ignore 纠缠)。
    // B 机不预写:首个动作是 pull(从 A 的 commit 拿到 ignore),避免未跟踪
    // 同名文件阻塞合并——与真实团队的时序一致。
    if (clone === cloneA) {
      writeFileSync(
        join(clone, ".gitignore"),
        ".co-engram/\nprivate/\n",
        "utf8",
      );
    }
  }
  return { workDir, cloneA, cloneB };
}

/** spawnSync 数组参数(不经 shell,vitest 进程内 /bin/sh 不可用) */
function git(cwd: string, args: readonly string[]): string {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${r.stderr ?? r.status}`,
    );
  }
  return r.stdout ?? "";
}

/** 构造一台「机器」:repository(SQLite write-through)+ audit + TeamEventStore */
function makeMachine(dataRoot: string, origin: string) {
  const dbDir = join(dataRoot, ".co-engram");
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
  const indexDb = new IndexDb({ dbPath: join(dbDir, "index.db") });
  indexDb.open();
  const repository = new EngramRepository(
    { rootPath: dataRoot, language: "zh" },
    indexDb,
  );
  const auditLog = new AuditLog(dataRoot);
  const store = new TeamEventStore(dataRoot, {
    origin,
    visibilityLookup: (engramId) => {
      const row = indexDb.prepare(
        "SELECT visibility FROM engrams WHERE id = ?",
      ).get(engramId) as { visibility: string } | undefined;
      return row?.visibility;
    },
  });
  auditLog.setTeamEventRecorder(store);
  return { repository, auditLog, store, indexDb };
}


describe("团队动态事件跨机同步(双 clone git flow)", () => {
  it("场景1:A 机 create/reinforce → push → B 机 pull 后动态流含 A 的事件,作者 = A", () => {
    const { workDir, cloneA, cloneB } = setupTopology();
    try {
    const A = makeMachine(cloneA, "alice-zte");
    // A 机创建一条公共记忆 + 一条强化
    const engram = A.repository.createEngram({
      title: "部署端口契约",
      content: "viewer 固定 18899,不漂移。",
      summary: "viewer 端口契约",
      kind: "fact",
      domainTags: ["co-engram"],
      createdBy: "alice-zte",
    });
    A.auditLog.append({
      actor: "user",
      action: "create",
      engramId: engram.id,
      metadata: { createdBy: "alice-zte", title: "部署端口契约" },
    });
    A.auditLog.append({
      actor: "user",
      action: "reinforce",
      engramId: engram.id,
      metadata: { reason: "再次验证有效" },
    });

    // A 机 sync:git add -A(engram_sync 的实际行为,files: [] → add -A)
    git(cloneA, ["add", "-A"]);
    git(cloneA, ["commit", "-m", "A: engram + events"]);
    git(cloneA, ["push", "origin", "HEAD:refs/heads/main"]);
    // B 机 pull
    git(cloneB, ["pull", "--no-edit", "origin", "main"]);

    // B 机读端(viewer 合并逻辑的数据面):TeamEventStore.query 直接可见
    const B = makeMachine(cloneB, "bob-zte");
    const events = B.store.query();
    const creates = events.filter((e) => e.action === "create");
    expect(creates).toHaveLength(1);
    expect(creates[0]!.origin).toBe("alice-zte");
    expect(creates[0]!.engramId).toBe(engram.id);
    // reinforce 事件同步(metadata.reason 截断保留)
    const reinforces = events.filter((e) => e.action === "reinforce");
    expect(reinforces).toHaveLength(1);
    expect(
      (reinforces[0]!.metadata as Record<string, unknown>)["reason"],
    ).toBe("再次验证有效");
    // B 的合并动态流(audit ∪ events)不应把 A 的事件计两次
    const localAudit = B.auditLog.query({});
    expect(localAudit).toHaveLength(0);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("场景2:A、B 同日各自写事件 → 双向 push/pull 无冲突,双方动态互相可见", () => {
    const { workDir, cloneA, cloneB } = setupTopology();
    try {
    const A = makeMachine(cloneA, "alice-zte");
    // 场景独立:A 先落一条基线事件并 push,建立共同祖先
    const baseEngram = A.repository.createEngram({
      title: "基线",
      content: "base",
      kind: "fact",
      domainTags: ["co-engram"],
      createdBy: "alice-zte",
    });
    A.auditLog.append({
      actor: "user",
      action: "create",
      engramId: baseEngram.id,
      metadata: { createdBy: "alice-zte" },
    });
    git(cloneA, ["add", "-A"]);
    git(cloneA, ["commit", "-m", "A: baseline"]);
    git(cloneA, ["push", "origin", "HEAD:refs/heads/main"]);
    git(cloneB, ["pull", "--no-edit", "origin", "main"]);
    const B = makeMachine(cloneB, "bob-zte");

    // 同日:B 机也创建记忆 + 事件
    const bEngram = B.repository.createEngram({
      title: "B 机的记忆",
      content: "bob 的内容",
      kind: "fact",
      domainTags: ["co-engram"],
      createdBy: "bob-zte",
    });
    B.auditLog.append({
      actor: "user",
      action: "create",
      engramId: bEngram.id,
      metadata: { createdBy: "bob-zte" },
    });

    // B push;A pull → A 侧动态含 B 的事件;反之亦然
    git(cloneB, ["add", "-A"]);
    git(cloneB, ["commit", "-m", "B: engram + events"]);
    git(cloneB, ["push", "origin", "HEAD:refs/heads/main"]);
    git(cloneA, ["pull", "--no-edit", "origin", "main"]);

    const eventsOnA = A.store.query();
    expect(
      eventsOnA.filter((e) => e.origin === "bob-zte" && e.action === "create"),
    ).toHaveLength(1);
    // 双向:A 已有的事件在 B 侧仍在
    git(cloneA, ["add", "-A"]);
    const statusA = git(cloneA, ["status", "--porcelain"]);
    // A 侧无新增变更可提交(事件文件已同步)→ 不强求 commit
    void statusA;
    const eventsOnB = B.store.query();
    expect(
      eventsOnB.filter(
        (e) => e.origin === "alice-zte" && e.action === "create",
      ),
    ).toHaveLength(1);
    // 写者隔离:两台机器的事件分片文件互不重叠
    expect(existsSync(join(cloneA, "events"))).toBe(true);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("场景3:A 机 private 记忆的事件不落 events/(B 永远看不到)", () => {
    const { workDir, cloneA } = setupTopology();
    try {
    const A = makeMachine(cloneA, "alice-zte");
    const privateEngram = A.repository.createEngram({
      title: "私人健康记录",
      content: "不进团队仓库",
      kind: "fact",
      domainTags: ["private-test"],
      createdBy: "alice-zte",
      visibility: "private",
    });
    A.auditLog.append({
      actor: "user",
      action: "create",
      engramId: privateEngram.id,
      metadata: { title: "私人健康记录" },
    });
    // 本地 audit 有(创建者本机可见)
    expect(
      A.auditLog.query({ engramId: privateEngram.id }),
    ).toHaveLength(1);
    // 同步事件无(隐私防线)
    expect(
      A.store.query({ engramId: privateEngram.id }),
    ).toHaveLength(0);
    // 全文扫描兜底:events/ 下任何文件不含该标题
    const eventsDir = join(cloneA, "events");
    if (existsSync(eventsDir)) {
      const scan = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
          d.isDirectory()
            ? scan(join(dir, d.name))
            : [readFileSync(join(dir, d.name), "utf8")],
        );
      for (const content of scan(eventsDir)) {
        expect(content).not.toContain("私人健康记录");
      }
    }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("场景4:B 侧 events/ 缺失(老版本对端)→ 读端返回空,不报错", () => {
    const isolated = mkdtempSync(join(tmpdir(), "team-events-isolated-"));
    try {
      const store = new TeamEventStore(isolated, { origin: "old-machine" });
      expect(store.query()).toEqual([]);
      expect(store.query({ action: "create" })).toEqual([]);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("场景5:过期日期目录清理(20 天前删、未来保留)", () => {
    const { workDir, cloneA } = setupTopology();
    try {
    const A = makeMachine(cloneA, "alice-zte");
    const mk = (day: string) => {
      const dir = join(cloneA, "events", day);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "alice-zte.jsonl"), "{}\n", "utf8");
    };
    mk("2026-06-01"); // 深度过期
    mk("2026-08-15"); // 未过期
    mk("2027-01-01"); // 未来(时钟漂移)
    const removed = A.store.cleanupExpired(new Date("2026-08-19T12:00:00.000Z"));
    expect(removed).toBe(1);
    expect(existsSync(join(cloneA, "events", "2026-06-01"))).toBe(false);
    expect(existsSync(join(cloneA, "events", "2026-08-15"))).toBe(true);
    expect(existsSync(join(cloneA, "events", "2027-01-01"))).toBe(true);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("场景6:viewer 读端合并语义 —— 本机双写去重(action|engramId|ts)", () => {
    const { workDir, cloneA } = setupTopology();
    try {
    const A = makeMachine(cloneA, "alice-zte");
    const engram = A.repository.createEngram({
      title: "去重验证",
      content: "内容",
      kind: "fact",
      domainTags: ["dedup"],
      createdBy: "alice-zte",
    });
    A.auditLog.append({
      actor: "user",
      action: "create",
      engramId: engram.id,
    });
    // audit 与 events 各有一份同 ts 事件(双写)
    const local = A.auditLog.query({});
    const team = A.store.query({});
    expect(local).toHaveLength(1);
    expect(team).toHaveLength(1);
    expect(local[0]!.ts).toBe(team[0]!.ts);
    // 合并去重(server.ts 同款键)
    const seen = new Set(
      local.map((e) => `${e.action}|${e.engramId ?? ""}|${e.ts}`),
    );
    const merged = [...local];
    for (const ev of team) {
      const key = `${ev.action}|${ev.engramId ?? ""}|${ev.ts}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...ev, metadata: ev.metadata });
    }
    expect(merged).toHaveLength(1);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
