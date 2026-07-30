/**
 * 目录树「点击内联展开」改造的端到端验证(2026-07)。
 *
 * 背景:viewer 「记忆」tab 目录视图原每个目录只有计数 + 「查看」按钮(切卡片视图)。
 * 改造后:点击目录内联展开「直属记忆文件 + 下一级子目录」(文件浏览器心智)。
 * 同时:① `+N here` 等文案 i18n;② 后端 `/api/path-tree?files=1` 增补 title/kind/...;
 * ③ forgotten(软删除)从目录树计数与 engramLocations 排除,与卡片视图口径一致。
 *
 * 三层覆盖(不引入 headless 浏览器,与 six-bugs.test.ts 同思路):
 *   - 后端 HTTP:真实 startViewerServer + curl /api/path-tree
 *   - 后端 repo:真实 EngramRepository 文件 IO(listPathTree 计数 + 异常)
 *   - 前端:静态校验 TABS_RUNTIME 含新代码 + 执行真实方法验证分组/溢出/XSS
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

import { EngramRepository } from "@co-engram/core";
import { startViewerServer } from "../src/index.js";
import { TABS_RUNTIME } from "../src/runtime/tabs.js";

// ---- HTTP helpers(同 six-bugs.test.ts)----
let portCounter = 31000;
function nextPort(): number {
  portCounter += 1;
  return portCounter;
}
function makeRequest(port: number, reqPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: reqPath, method: "GET", headers: { connection: "close" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
async function withViewer<T>(repository: EngramRepository, fn: (port: number) => Promise<T>): Promise<T> {
  const port = nextPort();
  const saved = process.env.CO_ENGRAM_VIEWER_PORT;
  process.env.CO_ENGRAM_VIEWER_PORT = String(port);
  try {
    const runtime = await startViewerServer({ repository }, {});
    try {
      return await fn(runtime.port);
    } finally {
      await runtime.stop();
    }
  } finally {
    if (saved === undefined) delete process.env.CO_ENGRAM_VIEWER_PORT;
    else process.env.CO_ENGRAM_VIEWER_PORT = saved;
  }
}

// ---- repo helpers ----
let tmpDir: string;
let repo: EngramRepository;
function create(opts: { title: string; pathHint: string; kind?: string; domainTags?: string[] }) {
  return repo.createEngram({
    title: opts.title,
    content: "c",
    kind: (opts.kind ?? "fact") as "fact",
    domainTags: opts.domainTags ?? [],
    createdBy: "tester",
    pathHint: opts.pathHint,
  });
}
function findNode(node: { path: string; engramCount: number; children?: unknown[] }, p: string): typeof node | null {
  if (node.path === p) return node;
  for (const c of node.children ?? []) {
    const r = findNode(c as typeof node, p);
    if (r) return r;
  }
  return null;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-path-tree-"));
  repo = new EngramRepository({ rootPath: tmpDir, language: "zh" });
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================
// 后端 HTTP:/api/path-tree
// ============================================================

describe("/api/path-tree ?files=1 增补", () => {
  it("files=1 时 engramLocations 增补 title/kind/domainTags", async () => {
    create({ title: "p1", pathHint: "python/py.md" });
    create({ title: "r1", pathHint: "root.md" });
    await withViewer(repo, async (port) => {
      const r = JSON.parse((await makeRequest(port, "/api/path-tree?files=1&maxDepth=10")).body);
      expect(r.enabled).toBe(true);
      expect(r.root.engramCount).toBe(2);
      expect(r.engramLocations).toHaveLength(2);
      for (const loc of r.engramLocations) {
        expect(typeof loc.title).toBe("string");
        expect(typeof loc.kind).toBe("string");
        expect(Array.isArray(loc.domainTags)).toBe(true);
      }
    });
  });

  it("无 files / files=0 时 engramLocations 仅 id/path(graph tab 路径不增补)", async () => {
    create({ title: "p1", pathHint: "python/py.md" });
    await withViewer(repo, async (port) => {
      const r2 = JSON.parse((await makeRequest(port, "/api/path-tree?maxDepth=10")).body);
      expect(r2.engramLocations.every((l: { title?: string }) => l.title === undefined)).toBe(true);
      const r3 = JSON.parse((await makeRequest(port, "/api/path-tree?files=0&maxDepth=10")).body);
      expect(r3.engramLocations.every((l: { title?: string }) => l.title === undefined)).toBe(true);
    });
  });
});

describe("/api/path-tree maxDepth 边界", () => {
  it("maxDepth=1 剪枝 root.children;999 被 cap;abc/缺省不崩", async () => {
    create({ title: "deep", pathHint: "a/b/c/d/e/deep.md" });
    await withViewer(repo, async (port) => {
      const d1 = JSON.parse((await makeRequest(port, "/api/path-tree?maxDepth=1&files=1")).body);
      expect(d1.root.children).toHaveLength(0);
      const dbig = JSON.parse((await makeRequest(port, "/api/path-tree?maxDepth=999&files=1")).body);
      expect(!!dbig.root).toBe(true);
      const dabc = JSON.parse((await makeRequest(port, "/api/path-tree?maxDepth=abc&files=1")).body);
      expect(!!dabc.root).toBe(true);
      const dnone = JSON.parse((await makeRequest(port, "/api/path-tree?files=1")).body);
      expect(!!dnone.root).toBe(true);
      // engramLocations 不受 maxDepth 影响(全量)
      expect(dnone.engramLocations).toHaveLength(1);
      expect(dnone.engramLocations[0].path).toBe("a/b/c/d/e/deep.md");
    });
  });
});

// ============================================================
// 后端 repo:listPathTree 计数 + 结构
// ============================================================

describe("listPathTree 计数与结构", () => {
  it("空库 root 计数 0、children []", () => {
    const t = repo.listPathTree();
    expect(t.engramCount).toBe(0);
    expect(t.children ?? []).toHaveLength(0);
  });

  it("根散落(path 无 /)不建子目录节点", () => {
    create({ title: "ra", pathHint: "root-a.md" });
    create({ title: "rb", pathHint: "root-b.md" });
    const t = repo.listPathTree();
    expect(t.engramCount).toBe(2);
    expect(t.children ?? []).toHaveLength(0);
  });

  it("嵌套目录累积计数逐级正确,直属 = 累积 - 子目录累积", () => {
    create({ title: "x1", pathHint: "top/a.md" });
    create({ title: "x2", pathHint: "top/sub/b.md" });
    create({ title: "x3", pathHint: "top/sub/inner/c.md" });
    create({ title: "x4", pathHint: "other/d.md" });
    const t = repo.listPathTree();
    expect(findNode(t, "top")!.engramCount).toBe(3);
    expect(findNode(t, "top/sub")!.engramCount).toBe(2);
    expect(findNode(t, "top/sub/inner")!.engramCount).toBe(1);
    expect(findNode(t, "other")!.engramCount).toBe(1);
    expect(t.engramCount).toBe(4);
  });
});

describe("listPathTree 异常场景", () => {
  it("ghost(index 有、磁盘 rm)不计入并触发清出", () => {
    const e = create({ title: "g", pathHint: "dir/g.md" });
    expect(repo.listEngramIndex()).toHaveLength(1);
    rmSync(join(tmpDir, "dir/g.md"));
    expect(repo.listPathTree().engramCount).toBe(0);
    repo.rebuildIndex();
    expect(repo.listEngramIndex()).toHaveLength(0);
  });

  it("非 .md 文件 / 损坏外部 .md 不计入", () => {
    create({ title: "m", pathHint: "d/m.md" });
    writeFileSync(join(tmpDir, "d/notes.txt"), "noise");
    writeFileSync(join(tmpDir, "d/data.json"), "{}");
    mkdirSync(join(tmpDir, "bad"), { recursive: true });
    writeFileSync(join(tmpDir, "bad/corrupt.md"), "无 frontmatter 的裸 md");
    expect(repo.listPathTree().engramCount).toBe(1);
    expect(repo.listEngramIndex()).toHaveLength(1);
  });

  it("空目录(磁盘有目录无文件)出现为 engramCount=0 节点", () => {
    mkdirSync(join(tmpDir, "emptydir"), { recursive: true });
    const t = repo.listPathTree();
    expect(findNode(t, "emptydir")?.engramCount).toBe(0);
  });
});

// ============================================================
// forgotten 排除(目录树与卡片视图口径一致)
// ============================================================

describe("forgotten 从目录树排除", () => {
  it("forget 后 listPathTree 计数排除,但 entry 保留(供 restore)", () => {
    const e = create({ title: "forg", pathHint: "d/forg.md" });
    expect(repo.listPathTree().engramCount).toBe(1);
    repo.updateLifecycle(e.id, "forgotten", "forgotten");
    expect(repo.listPathTree().engramCount).toBe(0);
    const entry = repo.listEngramIndex().find((x) => x.id === e.id);
    expect(entry?.status).toBe("forgotten");
    // forgotten engram 仍可读(restore 路径需要)
    expect(repo.readEngram(e.id).status).toBe("forgotten");
  });

  it("HTTP /api/path-tree 的 engramLocations 与计数都排除 forgotten", async () => {
    create({ title: "p1", pathHint: "python/py.md" });
    const fe = create({ title: "forg", pathHint: "d/forg.md" });
    repo.updateLifecycle(fe.id, "forgotten", "forgotten");
    await withViewer(repo, async (port) => {
      const r = JSON.parse((await makeRequest(port, "/api/path-tree?files=1&maxDepth=10")).body);
      expect(r.root.engramCount).toBe(1); // 非 2
      expect(r.engramLocations).toHaveLength(1);
      expect(r.engramLocations.find((l: { id: string }) => l.id === fe.id)).toBeUndefined();
    });
  });
});

// ============================================================
// 前端:TABS_RUNTIME 静态校验(含新方法/i18n/懒加载契约)
// ============================================================

describe("前端 TABS_RUNTIME 含内联展开实现", () => {
  it("请求带 files=1 & maxDepth=10", () => {
    expect(TABS_RUNTIME).toContain("/api/path-tree?maxDepth=10&files=1");
  });
  it("新增三个方法", () => {
    expect(TABS_RUNTIME).toContain("_buildEngramsByDir");
    expect(TABS_RUNTIME).toContain("_treeEngramRow");
    expect(TABS_RUNTIME).toContain("_fillTreeDirectFiles");
  });
  it("直属文件占位 + capture toggle 监听器(toggle 不冒泡)", () => {
    expect(TABS_RUNTIME).toContain('class="tree-direct-files"');
    expect(TABS_RUNTIME).toContain("data-dir=");
    expect(TABS_RUNTIME).toMatch(/addEventListener\(['"]toggle['"]/);
    expect(TABS_RUNTIME).toContain("_treeToggleBound"); // 幂等守卫
    expect(TABS_RUNTIME).toContain("details.tree-group[open]"); // 初始 open 主动填
  });
  it("引用新 i18n key(非硬编码 +N here)", () => {
    expect(TABS_RUNTIME).toContain("engrams.tree.directHere");
    expect(TABS_RUNTIME).toContain("engrams.tree.viewAllInCards");
    expect(TABS_RUNTIME).not.toContain("+ direct + ' here'"); // 旧硬编码已移除
  });
  it("累积计数 tooltip 走 T.t(非 tip() 死文案)", () => {
    expect(TABS_RUNTIME).toContain("T.t('engrams.tree.cumulativeCount')");
  });
});

// ============================================================
// 前端:执行真实方法(从 TABS_RUNTIME 求值 + Proxy 兜底浏览器全局)
// ============================================================

// 把 TABS_RUNTIME 当函数体执行,注入 mock 全局,取出 CO_ENGRAM_ENGRAMS。
// TABS_RUNTIME 是 export const 字符串字面量,可直接 new Function 执行其真实逻辑。
function loadRuntime() {
  const noop = () => undefined;
  const mockT = {
    t: (k: string, v?: Record<string, unknown>) => {
      let s = k;
      if (v) for (const kk in v) s = s.replaceAll("${" + kk + "}", String(v[kk]));
      return s;
    },
    enumLabel: (_cat: string, val: string) => val,
  };
  const realImpl = {
    escapeHtml: (s: unknown) =>
      String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;"),
    tip: () => "",
    relativeTime: () => "recent",
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const CO_ENGRAM: any = new Proxy({ ...realImpl }, {
    get(t, k) { return k in t ? (t as Record<string, unknown>)[k] : noop; },
    set(t, k, v) { (t as Record<string, unknown>)[k] = v; return true; },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const document: any = new Proxy({}, { get: () => noop, set: () => true });
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-explicit-any
  const fn = new Function("CO_ENGRAM", "CO_ENGRAM_T", "window", "document", TABS_RUNTIME + "\nreturn CO_ENGRAM_ENGRAMS;");
  return { CO_ENGRAM, EE: fn(CO_ENGRAM, mockT, globalThis, document) };
}

// 复刻服务端 ?files=1 转换(取 index entry 已有字段)
function locs(withFiles: boolean) {
  return repo.listEngramIndex().map((e) => ({
    id: e.id,
    path: e.path,
    ...(withFiles ? { title: e.title, kind: e.kind, domainTags: e.domainTags, createdAt: e.createdAt } : {}),
  }));
}
function directFilesHtml(EE: ReturnType<typeof loadRuntime>["EE"], CO_ENGRAM: ReturnType<typeof loadRuntime>["CO_ENGRAM"], dir: string) {
  CO_ENGRAM._engramsByDir = EE._buildEngramsByDir(locs(true));
  const ph = { _a: dir, getAttribute() { return this._a; }, setAttribute() {}, innerHTML: "" };
  EE._fillTreeDirectFiles(ph);
  return ph.innerHTML;
}

describe("前端 _buildEngramsByDir / _fillTreeDirectFiles 真实逻辑", () => {
  it("按 parent 目录分组,根散落 key=''", () => {
    create({ title: "p1", pathHint: "python/py-fundamentals.md" });
    create({ title: "a1", pathHint: "python/async/trio.md" });
    create({ title: "r1", pathHint: "rootscatter.md" });
    const { EE } = loadRuntime();
    const byDir = EE._buildEngramsByDir(locs(true));
    expect(byDir.get("python")).toHaveLength(1);
    expect(byDir.get("python/async")).toHaveLength(1);
    expect(byDir.get("")).toHaveLength(1);
  });

  it("渲染直属文件行(含 title),空目录不显示提示", () => {
    create({ title: "p1", pathHint: "python/py-fundamentals.md" });
    const { EE, CO_ENGRAM } = loadRuntime();
    const html = directFilesHtml(EE, CO_ENGRAM, "python");
    expect((html.match(/class="tree-file"/g) ?? []).length).toBe(1);
    expect(html).toContain("p1");
    const empty = directFilesHtml(EE, CO_ENGRAM, "不存在");
    expect(empty).toBe(""); // 空目录占位为空,不再显示「暂无记忆」提示
  });

  it(">50 条截断 50 + 溢出按钮", () => {
    for (let i = 0; i < 80; i++) create({ title: "f" + i, pathHint: `big/f${i}.md` });
    const { EE, CO_ENGRAM } = loadRuntime();
    CO_ENGRAM._engramsByDir = EE._buildEngramsByDir(locs(true));
    const ph = { _a: "big", getAttribute() { return this._a; }, setAttribute() {}, innerHTML: "" };
    EE._fillTreeDirectFiles(ph);
    expect((ph.innerHTML.match(/class="tree-file"/g) ?? []).length).toBe(50);
    expect(ph.innerHTML).toContain("tree-more");
  });

  it("XSS 标题被 escapeHtml 转义", () => {
    create({ title: '<script>alert(1)</script>"q"', pathHint: "x/x.md" });
    const { EE, CO_ENGRAM } = loadRuntime();
    const html = directFilesHtml(EE, CO_ENGRAM, "x");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;");
  });
});
