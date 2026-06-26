import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  serializeEngramFile,
  parseEngramFile,
  readEngramFile,
  writeEngramFile,
  deleteEngramFile,
  isEngramFile,
  type EngramFile,
} from "../src/storage/engram-store.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-engram-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const SAMPLE_FILE: EngramFile = {
  frontmatter: {
    id: "01KVNJ9RN190DVHBKFB7NHDF9Q",
    title: "操作系统内存优化",
    kind: "observation",
    tags: ["性能", "优化"],
    domainTags: ["操作系统", "内存管理"],
    createdBy: "alice",
    createdAt: "2026-06-22T10:00:00Z",
    updatedBy: "alice",
    updatedAt: "2026-06-22T15:30:00Z",
    version: 1,
  },
  content: "本文讨论操作系统层面的内存优化策略...",
};

describe("engram-store — round-trip", () => {
  it("serialize + parse 还原原始数据", () => {
    const raw = serializeEngramFile(SAMPLE_FILE);
    const parsed = parseEngramFile(raw);
    expect(parsed.frontmatter.id).toBe(SAMPLE_FILE.frontmatter.id);
    expect(parsed.frontmatter.title).toBe(SAMPLE_FILE.frontmatter.title);
    expect(parsed.frontmatter.kind).toBe("observation");
    expect(parsed.content).toBe(SAMPLE_FILE.content);
  });

  it("serialize(英文模式) 输出以 --- 开头", () => {
    const raw = serializeEngramFile(SAMPLE_FILE, "en");
    expect(raw.startsWith("---\n")).toBe(true);
  });

  it("serialize 包含 closing ---", () => {
    const raw = serializeEngramFile(SAMPLE_FILE);
    expect(raw.indexOf("\n---\n", 4)).toBeGreaterThan(0);
  });

  it("parse 拒绝缺 id 的文件", () => {
    const malformed = `---
title: 没id
kind: observation
---
content
`;
    expect(() => parseEngramFile(malformed)).toThrow(/id/);
  });

  it("parse 拒绝缺 closing delimiter 的文件", () => {
    const malformed = `---
title: foo
kind: observation
no closing
`;
    expect(() => parseEngramFile(malformed)).toThrow(/closing/);
  });

  it("parse 拒绝既无顶部 --- 也无底部 meta marker 的文件", () => {
    expect(() => parseEngramFile("just text")).toThrow(/missing frontmatter/);
  });

  it("serialize 去除 content 首尾空白", () => {
    const file: EngramFile = {
      frontmatter: SAMPLE_FILE.frontmatter,
      content: "\n\nhello\n\n",
    };
    const raw = serializeEngramFile(file);
    const parsed = parseEngramFile(raw);
    expect(parsed.content).toBe("hello");
  });
});

describe("engram-store — 文件 I/O", () => {
  it("writeEngramFile 自动创建父目录", () => {
    const path = join(tmpDir, "a", "b", "c", "engram.md");
    writeEngramFile(path, SAMPLE_FILE);
    expect(existsSync(path)).toBe(true);
  });

  it("readEngramFile 读回写入的数据", () => {
    const path = join(tmpDir, "engram.md");
    writeEngramFile(path, SAMPLE_FILE);
    const read = readEngramFile(path);
    expect(read.frontmatter.title).toBe(SAMPLE_FILE.frontmatter.title);
  });

  it("deleteEngramFile 删除存在的文件", () => {
    const path = join(tmpDir, "engram.md");
    writeEngramFile(path, SAMPLE_FILE);
    deleteEngramFile(path);
    expect(existsSync(path)).toBe(false);
  });

  it("deleteEngramFile 不存在的文件不报错", () => {
    const path = join(tmpDir, "missing.md");
    expect(() => deleteEngramFile(path)).not.toThrow();
  });

  it("支持中文路径", () => {
    const path = join(tmpDir, "项目管理", "需求管理", "操作系统内存优化.md");
    writeEngramFile(path, SAMPLE_FILE);
    expect(existsSync(path)).toBe(true);
    const read = readEngramFile(path);
    expect(read.frontmatter.title).toBe("操作系统内存优化");
  });
});

describe("isEngramFile", () => {
  it("合法 engram 文件识别为 true", () => {
    const raw = serializeEngramFile(SAMPLE_FILE);
    expect(isEngramFile(raw)).toBe(true);
  });

  it("无 frontmatter 的普通 markdown 识别为 false", () => {
    expect(isEngramFile("# Title\n\nbody")).toBe(false);
  });

  it("损坏的 frontmatter 识别为 false", () => {
    expect(isEngramFile("---\nbroken yaml:::\n---\nbody")).toBe(false);
  });

  it("实际文件检测", () => {
    const path = join(tmpDir, "engram.md");
    writeEngramFile(path, SAMPLE_FILE);
    const raw = readFileSync(path, "utf8");
    expect(isEngramFile(raw)).toBe(true);
  });

  it("普通笔记文件不被误判", () => {
    const path = join(tmpDir, "note.md");
    writeFileSync(path, "# 我的笔记\n\n今天天气不错\n");
    const raw = readFileSync(path, "utf8");
    expect(isEngramFile(raw)).toBe(false);
  });
});

describe("engram-store — frontmatter 锁定行为", () => {
  it("显式 slug 字段保留", () => {
    const file: EngramFile = {
      frontmatter: {
        ...SAMPLE_FILE.frontmatter,
        slug: "custom-locked-slug",
      },
      content: "x",
    };
    const raw = serializeEngramFile(file);
    const parsed = parseEngramFile(raw);
    expect(parsed.frontmatter.slug).toBe("custom-locked-slug");
  });

  it("显式 domainTags 字段保留", () => {
    const file: EngramFile = {
      frontmatter: {
        ...SAMPLE_FILE.frontmatter,
        domainTags: ["自定义", "标签"],
      },
      content: "x",
    };
    const raw = serializeEngramFile(file);
    const parsed = parseEngramFile(raw);
    expect(parsed.frontmatter.domainTags).toEqual(["自定义", "标签"]);
  });

  it("未知扩展字段保留(round-trip)", () => {
    const file = {
      frontmatter: {
        ...SAMPLE_FILE.frontmatter,
        customField: "custom value",
        nestedData: { a: 1, b: "x" },
      },
      content: "x",
    } as unknown as EngramFile;
    const raw = serializeEngramFile(file);
    const parsed = parseEngramFile(raw);
    expect((parsed.frontmatter as { customField: string }).customField).toBe(
      "custom value",
    );
  });
});

describe("engram-store — 双语双位置(zh 模式)", () => {
  it("zh 模式:正文在上 + 中文 frontmatter 在下", () => {
    const raw = serializeEngramFile(SAMPLE_FILE, "zh");
    // 正文开头(不是 ---)
    expect(raw.startsWith("本文讨论操作系统层面的内存优化策略")).toBe(true);
    // 含底部 marker
    expect(raw.indexOf("<!-- co-engram-meta:zh -->")).toBeGreaterThan(0);
    // frontmatter 在 marker 之后
    const markerIdx = raw.indexOf("<!-- co-engram-meta:zh -->");
    expect(raw.indexOf("标识:")).toBeGreaterThan(markerIdx);
    expect(raw.indexOf("标题:")).toBeGreaterThan(markerIdx);
    expect(raw.indexOf("类型: observation")).toBeGreaterThan(markerIdx);
  });

  it("zh 模式:YAML keys 全部中文化", () => {
    const raw = serializeEngramFile(SAMPLE_FILE, "zh");
    expect(raw).toContain("标识:");
    expect(raw).toContain("标题:");
    expect(raw).toContain("类型:");
    expect(raw).toContain("领域标签:");
    expect(raw).toContain("创建者:");
    expect(raw).toContain("创建时间:");
    expect(raw).toContain("版本:");
    // 不应包含英文字段名(除了枚举值,如 observation)
    expect(raw).not.toMatch(/^title:/m);
    expect(raw).not.toMatch(/^kind:/m);
    expect(raw).not.toMatch(/^domainTags:/m);
  });

  it("zh 模式:__语言: zh 标记存在", () => {
    const raw = serializeEngramFile(SAMPLE_FILE, "zh");
    expect(raw).toMatch(/__语言:\s*zh/);
  });

  it("zh 模式:枚举值保持英文(类型系统约束)", () => {
    const raw = serializeEngramFile(SAMPLE_FILE, "zh");
    expect(raw).toContain("类型: observation");
  });

  it("zh 模式 round-trip:数据无损还原", () => {
    const raw = serializeEngramFile(SAMPLE_FILE, "zh");
    const parsed = parseEngramFile(raw);
    expect(parsed.frontmatter.id).toBe(SAMPLE_FILE.frontmatter.id);
    expect(parsed.frontmatter.title).toBe(SAMPLE_FILE.frontmatter.title);
    expect(parsed.frontmatter.kind).toBe("observation");
    expect(parsed.frontmatter.tags).toEqual(SAMPLE_FILE.frontmatter.tags);
    expect(parsed.frontmatter.domainTags).toEqual(
      SAMPLE_FILE.frontmatter.domainTags,
    );
    expect(parsed.content).toBe(SAMPLE_FILE.content);
    // __语言 标记不进入运行时对象
    expect(
      (parsed.frontmatter as Record<string, unknown>)["__语言"],
    ).toBeUndefined();
    expect(
      (parsed.frontmatter as Record<string, unknown>)["__lang"],
    ).toBeUndefined();
  });

  it("向后兼容:旧英文顶部文件 parse 正常", () => {
    const legacyRaw = `---
id: ${SAMPLE_FILE.frontmatter.id}
title: ${SAMPLE_FILE.frontmatter.title}
kind: observation
createdBy: alice
createdAt: 2026-06-22T10:00:00Z
updatedBy: alice
updatedAt: 2026-06-22T15:30:00Z
version: 1
---

legacy content here`;
    const parsed = parseEngramFile(legacyRaw);
    expect(parsed.frontmatter.id).toBe(SAMPLE_FILE.frontmatter.id);
    expect(parsed.frontmatter.title).toBe(SAMPLE_FILE.frontmatter.title);
    expect(parsed.frontmatter.kind).toBe("observation");
    expect(parsed.content).toBe("legacy content here");
  });

  it("混合 fixture:正文含 --- 不误判(底部 marker 解析)", () => {
    const file: EngramFile = {
      frontmatter: SAMPLE_FILE.frontmatter,
      content: "段落一\n\n---\n\n段落二(水平线分隔)",
    };
    const raw = serializeEngramFile(file, "zh");
    const parsed = parseEngramFile(raw);
    expect(parsed.content).toBe("段落一\n\n---\n\n段落二(水平线分隔)");
    expect(parsed.frontmatter.id).toBe(SAMPLE_FILE.frontmatter.id);
  });

  it("isEngramFile 识别 zh 模式(底部 marker)文件", () => {
    const raw = serializeEngramFile(SAMPLE_FILE, "zh");
    expect(isEngramFile(raw)).toBe(true);
  });

  it("isEngramFile 识别英文 legacy 文件", () => {
    const raw = serializeEngramFile(SAMPLE_FILE, "en");
    expect(isEngramFile(raw)).toBe(true);
  });

  it("isEngramFile 拒绝无 frontmatter 的普通 markdown", () => {
    expect(isEngramFile("just plain text\nno frontmatter")).toBe(false);
  });

  it("detectEngramFileLanguage:英文文件返回 en", async () => {
    const { detectEngramFileLanguage } =
      await import("../src/storage/engram-store.js");
    const raw = serializeEngramFile(SAMPLE_FILE, "en");
    expect(detectEngramFileLanguage(raw)).toBe("en");
  });

  it("detectEngramFileLanguage:中文文件返回 zh", async () => {
    const { detectEngramFileLanguage } =
      await import("../src/storage/engram-store.js");
    const raw = serializeEngramFile(SAMPLE_FILE, "zh");
    expect(detectEngramFileLanguage(raw)).toBe("zh");
  });
});
