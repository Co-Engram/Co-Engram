import { describe, it, expect } from "vitest";

import { slugify, inferDomainTagsFromPath } from "../src/types/slugify.js";

describe("slugify — unicode 保留", () => {
  it("ASCII title 转小写 + 空格转 dash", () => {
    expect(slugify("React Hooks Best Practices")).toBe(
      "react-hooks-best-practices",
    );
  });

  it("中文 title 保留 unicode", () => {
    expect(slugify("操作系统内存优化")).toBe("操作系统内存优化");
  });

  it("中英混合保留中文,ASCII 转小写", () => {
    expect(slugify("React Hooks 最佳实践")).toBe("react-hooks-最佳实践");
  });

  it("非法路径字符替换为 dash", () => {
    expect(slugify("A/B:C?D*E")).toBe("a-b-c-d-e");
  });

  it("连续空格合并为单个 dash", () => {
    expect(slugify(" 多余   空格 ")).toBe("多余-空格");
  });

  it("首尾 dash 裁剪", () => {
    expect(slugify("--foo--")).toBe("foo");
  });

  it("空字符串回退 untitled", () => {
    expect(slugify("")).toBe("untitled");
  });

  it("纯空白回退 untitled", () => {
    expect(slugify("   ")).toBe("untitled");
  });

  it("仅特殊字符回退 untitled", () => {
    expect(slugify("//??**")).toBe("untitled");
  });

  it("反斜杠按非法字符处理", () => {
    expect(slugify("A\\B")).toBe("a-b");
  });

  it("Tab 合并为 dash", () => {
    expect(slugify("a\tb\tc")).toBe("a-b-c");
  });
});

describe("inferDomainTagsFromPath — 路径推断", () => {
  it("从多层目录路径推断", () => {
    expect(
      inferDomainTagsFromPath("项目管理/需求管理/操作系统内存优化.md"),
    ).toEqual(["项目管理", "需求管理"]);
  });

  it("单层目录", () => {
    expect(inferDomainTagsFromPath("技术笔记/react-hooks.md")).toEqual([
      "技术笔记",
    ]);
  });

  it("根目录文件返回空数组", () => {
    expect(inferDomainTagsFromPath("react-hooks.md")).toEqual([]);
  });

  it("Windows 路径分隔符规范化", () => {
    expect(inferDomainTagsFromPath("a\\b\\c.md")).toEqual(["a", "b"]);
  });

  it("忽略空段(连续斜杠)", () => {
    expect(inferDomainTagsFromPath("a//b/c.md")).toEqual(["a", "b"]);
  });

  it("保留 unicode 目录名", () => {
    expect(inferDomainTagsFromPath("中文目录/子目录/file.md")).toEqual([
      "中文目录",
      "子目录",
    ]);
  });

  it("深层目录全部保留", () => {
    expect(inferDomainTagsFromPath("a/b/c/d/e.md")).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });
});
