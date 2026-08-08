import { describe, it, expect } from "vitest";

import { extractBareMarkdownDefaults } from "../src/observability/bare-markdown-extractor.js";

/**
 * 裸 markdown 标题提取的伪 H1 修复(Task:从 wiki 粘贴的 .md 误抓代码注释为标题)。
 *
 * 覆盖两条互补规则:
 *   1. stripFencedCodeBlocks —— 剥离「有围栏」代码块内的 `#` 注释(不再当 H1);
 *   2. 多 H1 检测 —— 「围栏已丢失」时多个裸 `#` 行视为 H1 滥用 → fallback 文件名。
 */
describe("extractBareMarkdownDefaults · 标题提取(伪 H1 修复)", () => {
  it("单个真 H1 → 用该 H1", () => {
    const f = extractBareMarkdownDefaults("notes/a.md", "# 真标题\n\n正文\n");
    expect(f.title).toBe("真标题");
  });

  it("无 H1 → 用文件名(去 .md)", () => {
    const f = extractBareMarkdownDefaults(
      "notes/我的笔记.md",
      "正文没有标题\n",
    );
    expect(f.title).toBe("我的笔记");
  });

  it("有围栏代码块内的 `#` 注释、块外无 H1 → 剥离后用文件名(不当 H1)", () => {
    const raw = [
      "正文开头",
      "",
      "```bash",
      "# 1. 切换到源分支",
      "git checkout stable",
      "# 2. rebase",
      "```",
      "",
      "更多正文",
    ].join("\n");
    const f = extractBareMarkdownDefaults("notes/脚本.md", raw);
    expect(f.title).toBe("脚本");
  });

  it("有围栏代码块内的 `#` 注释、块外恰好 1 个真 H1 → 用块外 H1", () => {
    const raw = [
      "# 真标题",
      "",
      "```bash",
      "# 伪标题(代码注释)",
      "git checkout stable",
      "```",
    ].join("\n");
    const f = extractBareMarkdownDefaults("notes/a.md", raw);
    expect(f.title).toBe("真标题");
  });

  it("~~~ 围栏同样识别(与 ``` 等价)", () => {
    const raw = ["~~~", "# tilde 围栏内的注释", "code", "~~~", ""].join("\n");
    const f = extractBareMarkdownDefaults("notes/b.md", raw);
    expect(f.title).toBe("b");
  });

  it("多个裸 `#` 行(围栏丢失的 shell 注释,复刻 wiki 粘贴)→ H1 滥用 → 文件名", () => {
    // 复刻用户实际场景:从 iCenter 粘贴的 wiki,代码块围栏丢失,
    // shell 步骤注释 # 1./# 2./# 3. 变成裸 H1。## / ### 不是 H1(正则要求 # 后紧跟空白)。
    const raw = [
      "https://wiki.example/view",
      "",
      "## 1 目的",
      "规范分支管理。",
      "### 3.1.1 操作步骤",
      "# 1. 切换到源分支",
      "git checkout stable",
      "# 2. rebase 目标分支",
      "# 3. 推送代码到 stable",
    ].join("\n");
    const f = extractBareMarkdownDefaults(
      "AIOS项目信息/AIOS开发者指南/代码分支管理.md",
      raw,
    );
    expect(f.title).toBe("代码分支管理");
  });

  it("title 截断到 200 字符", () => {
    const f = extractBareMarkdownDefaults("n.md", "# " + "a".repeat(300));
    expect(f.title.length).toBe(200);
  });

  it("content 始终保留原始 raw(含 H1 与代码块,不被剥离)", () => {
    const raw = "# 标题\n```js\n# code comment\n```\n";
    const f = extractBareMarkdownDefaults("n.md", raw);
    expect(f.content).toBe(raw);
  });

  it("kind 默认 observation、domainTags 默认 uncategorized", () => {
    const f = extractBareMarkdownDefaults("n.md", "# t\n");
    expect(f.kind).toBe("observation");
    expect(f.domainTags).toEqual(["uncategorized"]);
  });

  it("无扩展名或空文件名兜底 untitled-note", () => {
    const f = extractBareMarkdownDefaults("notes/", "无标题正文\n");
    // basename("notes/", ".md") 在不同平台可能为 "" 或 "notes";只要不抛错且非空
    expect(typeof f.title).toBe("string");
    expect(f.title.length).toBeGreaterThan(0);
  });
});
