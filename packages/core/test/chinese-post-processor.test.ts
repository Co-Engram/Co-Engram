/**
 * AI-6 中文 post-processor 单元测试
 *
 * 覆盖:
 *   - normalizeChinesePunctuation:CJK+CJK 空格消除 / CJK+Latin 保留 / 多空格压缩 / trim
 *   - normalizeDomainTags:trim / 内部空白折叠 / 大小写不敏感去重 / 空值跳过
 *   - normalizeProposalFields:整体 payload 规范化 / undefined 字段保持
 *
 * hyper-pattern 6(chinese-second-class citizen):LLM 生成的中文含 tokenizer artifact
 * (如"清 cache 时必须先 备份"),让仓库看起来粗糙。后处理把这些 artifact 在落盘前修掉。
 */
import { describe, it, expect } from "vitest";
import {
  normalizeChinesePunctuation,
  normalizeDomainTags,
  normalizeProposalFields,
} from "../src/observability/chinese-post-processor.js";

describe("normalizeChinesePunctuation", () => {
  it("删除两个 CJK 字符之间的 ASCII 空格", () => {
    expect(normalizeChinesePunctuation("清 cache 时必须先 备份")).toBe(
      "清 cache 时必须先备份",
    );
  });

  it("保留 CJK 与 Latin/数字边界的空格(中文排版规范)", () => {
    expect(normalizeChinesePunctuation("Node 22+ 发布")).toBe("Node 22+ 发布");
    expect(normalizeChinesePunctuation("启用 CO_ENGRAM_MAINTENANCE=1")).toBe(
      "启用 CO_ENGRAM_MAINTENANCE=1",
    );
  });

  it("连续 CJK+space 链完全消除", () => {
    // "中 中 中" 一次 replace 后变 "中中 中",需 loop until stable
    expect(normalizeChinesePunctuation("中 中 中 中")).toBe("中中中中");
  });

  it("多空格压成一个(Latin+Latin 边界)", () => {
    expect(normalizeChinesePunctuation("hello    world")).toBe("hello world");
  });

  it("CJK+CJK 之间的多空格全部删除(中文内部不用空格)", () => {
    // 文 + 3 spaces + 段 全是 CJK-CJK 边界,所有空格都该删
    expect(normalizeChinesePunctuation("中文   段落")).toBe("中文段落");
  });

  it("CJK + 多空格 + Latin 保留一个空格(排版规范)", () => {
    expect(normalizeChinesePunctuation("中文    Latin")).toBe("中文 Latin");
    expect(normalizeChinesePunctuation("Latin   中文")).toBe("Latin 中文");
  });

  it("首尾空白 trim", () => {
    expect(normalizeChinesePunctuation("  hello  ")).toBe("hello");
    expect(normalizeChinesePunctuation("\n\t标题\n")).toBe("标题");
  });

  it("纯 ASCII 段不变(无 CJK 触发条件)", () => {
    expect(normalizeChinesePunctuation("hello world")).toBe("hello world");
    expect(normalizeChinesePunctuation("co-engram-public")).toBe("co-engram-public");
  });

  it("空字符串 / null-ish 输入安全返回", () => {
    expect(normalizeChinesePunctuation("")).toBe("");
  });

  it("中英混排链:多个边界正确处理", () => {
    // "我 用 Node 22 写 代码" → "我用 Node 22 写 代码" → "我用 Node 22 写代码"
    expect(normalizeChinesePunctuation("我 用 Node 22 写 代码")).toBe(
      "我用 Node 22 写代码",
    );
  });

  it("幂等:对已规范化文本再次调用不变", () => {
    const clean = "清 cache 时必须先备份";
    expect(normalizeChinesePunctuation(clean)).toBe(clean);
    const once = normalizeChinesePunctuation("中 中 中");
    const twice = normalizeChinesePunctuation(once);
    expect(twice).toBe(once);
  });

  it("CJK 标点(U+3000..)不视为 CJK 字符,其间空格保留", () => {
    // 句号 U+3002 不是汉字,所以"中 。" 中的空格不会被删
    // (这种输入实际罕见,但本函数职责是只处理 CJK+CJK,边界要清晰)
    expect(normalizeChinesePunctuation("中 。 文")).toBe("中 。 文");
  });
});

describe("normalizeDomainTags", () => {
  it("trim 首尾空白", () => {
    expect(normalizeDomainTags(["  co-engram  ", "方法论"])).toEqual([
      "co-engram",
      "方法论",
    ]);
  });

  it("折叠内部空白为单个空格", () => {
    expect(normalizeDomainTags(["team   memory", "设计  原则"])).toEqual([
      "team memory",
      "设计 原则",
    ]);
  });

  it("大小写不敏感去重(保留首次出现形式)", () => {
    expect(
      normalizeDomainTags(["co-engram", "Co-Engram", "CO-ENGRAM", "方法论"]),
    ).toEqual(["co-engram", "方法论"]);
  });

  it("完全相同的 tag 去重", () => {
    expect(normalizeDomainTags(["schema", "schema", "graph"])).toEqual([
      "schema",
      "graph",
    ]);
  });

  it("空字符串 / 空白字符串 跳过", () => {
    expect(normalizeDomainTags(["", "  ", "real", "real"])).toEqual(["real"]);
  });

  it("空数组 / undefined 安全返回", () => {
    expect(normalizeDomainTags([])).toEqual([]);
    expect(normalizeDomainTags(undefined as never)).toBe(undefined);
  });

  it("不强制 lowercase(CJK 无大小写;ASCII 形式保留)", () => {
    expect(normalizeDomainTags(["PascalCase", "snake_case", "kebab-case"])).toEqual([
      "PascalCase",
      "snake_case",
      "kebab-case",
    ]);
  });
});

describe("normalizeProposalFields", () => {
  it("同时规范化 title / content / summary 的中文 artifact", () => {
    const result = normalizeProposalFields({
      title: "清 cache 时必须先 备份",
      content: "正文 内容 也 有 空格 问题",
      summary: "简短 描述",
      domainTags: ["协作 原则", "co-engram"],
    });
    // title: CJK+Latin 边界空格保留,CJK+CJK 空格删除
    expect(result.title).toBe("清 cache 时必须先备份");
    // content: 全是 CJK+CJK 链,所有空格都删除
    expect(result.content).toBe("正文内容也有空格问题");
    // summary: CJK+CJK 删除
    expect(result.summary).toBe("简短描述");
    // domainTags: 不走 normalizeChinesePunctuation,只折叠内部空白 + 去重
    // "协作 原则" 中间空格保留(单空格已是规范)
    expect(result.domainTags).toEqual(["协作 原则", "co-engram"]);
  });

  it("undefined 字段保持 undefined(不强行注入)", () => {
    const result = normalizeProposalFields({
      title: "标题",
      content: "内容",
      domainTags: ["tag1"],
    });
    expect(result.title).toBe("标题");
    expect(result.content).toBe("内容");
    expect(result.summary).toBeUndefined();
    expect(result.contextTags).toBeUndefined();
  });

  it("不可变:输入对象不被修改", () => {
    const input = {
      title: "原始 标题",
      content: "原始 内容",
      domainTags: ["原始 tag"],
    };
    const inputCopy = { ...input, domainTags: [...input.domainTags] };
    normalizeProposalFields(input);
    expect(input).toEqual(inputCopy);
  });

  it("AI-6 验证场景:LLM artifact 标题被修正", () => {
    // Plan 验证项:`engram_list_proposals` 的 proposedTitle 不再有"清 cache 时必须先 备份"错误空格
    const result = normalizeProposalFields({
      title: "清 cache 时必须先 备份",
      content: "...",
      domainTags: ["performance"],
    });
    expect(result.title).toBe("清 cache 时必须先备份");
    expect(result.title).not.toMatch(/先 备份/);
  });

  it("domainTags 大小写不敏感去重 + 内部空白折叠", () => {
    const result = normalizeProposalFields({
      title: "t",
      content: "c",
      domainTags: ["Team   Memory", "team memory", "方法论"],
      contextTags: ["Tag1", "tag1", "Tag2"],
    });
    expect(result.domainTags).toEqual(["Team Memory", "方法论"]);
    expect(result.contextTags).toEqual(["Tag1", "Tag2"]);
  });
});
