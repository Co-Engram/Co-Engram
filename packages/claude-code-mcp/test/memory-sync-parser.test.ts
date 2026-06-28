import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  parseAutoMemoryContent,
  parseAutoMemoryFile,
  isAutoMemoryFileName,
} from "../src/memory-sync/memory-parser.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("memory-parser: parseAutoMemoryContent", () => {
  it("解析合法 frontmatter + body", () => {
    const raw = `---
name: low-friction-defaults
description: "用户偏好"
metadata:
  node_type: memory
  type: feedback
  originSessionId: abc-123
---

新功能优先按"开箱即用"原则设计。
`;
    const result = parseAutoMemoryContent(raw, "/tmp/low-friction-defaults.md");
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("low-friction-defaults");
    expect(result!.description).toBe("用户偏好");
    expect(result!.type).toBe("feedback");
    expect(result!.body).toContain("开箱即用");
  });

  it("没有 frontmatter → null", () => {
    const result = parseAutoMemoryContent(
      "纯文本,无 frontmatter",
      "/tmp/foo.md",
    );
    expect(result).toBeNull();
  });

  it("YAML 损坏 → null(不抛错)", () => {
    const raw = `---
name: [invalid
  unclosed
---
body
`;
    const result = parseAutoMemoryContent(raw, "/tmp/broken.md");
    expect(result).toBeNull();
  });

  it("metadata.type 缺失 → 默认 'observation'", () => {
    const raw = `---
name: foo
description: "no type"
---

body
`;
    const result = parseAutoMemoryContent(raw, "/tmp/foo.md");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("observation");
  });

  it("metadata 字段缺失 → type 默认", () => {
    const raw = `---
name: foo
description: "no metadata block"
---

body
`;
    const result = parseAutoMemoryContent(raw, "/tmp/foo.md");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("observation");
  });

  it("name 缺失 → 用文件名(去 .md)做 slug", () => {
    const raw = `---
description: "no name"
metadata:
  type: fact
---

body
`;
    const result = parseAutoMemoryContent(raw, "/tmp/some-slug.md");
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("some-slug");
  });

  it("name + 文件名都缺失 → null", () => {
    // 实际场景下 basename 至少有 .md 之外的字符;此用例覆盖极端路径
    const raw = `---
description: "no name"
---

body
`;
    // 文件名就是 .md
    const result = parseAutoMemoryContent(raw, "/tmp/.md");
    expect(result).toBeNull();
  });

  it("multi-line description + body 含 markdown 链接", () => {
    const raw = `---
name: complex
description: "一个复杂的记忆"
metadata:
  type: pattern
---

正文段落。

> 引用块

看 [[other-memory]]。
`;
    const result = parseAutoMemoryContent(raw, "/tmp/complex.md");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("pattern");
    expect(result!.body).toContain("[[other-memory]]");
    expect(result!.body).toContain("引用块");
  });
});

describe("memory-parser: parseAutoMemoryFile", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "co-engram-parser-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("读取并解析真实文件", () => {
    const filePath = join(tmpDir, "test.md");
    writeFileSync(
      filePath,
      `---
name: test-slug
description: "测试"
metadata:
  type: fact
---

body content
`,
      "utf8",
    );
    const result = parseAutoMemoryFile(filePath);
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("test-slug");
    expect(result!.body).toBe("body content");
  });

  it("MEMORY.md 索引文件 → null", () => {
    const filePath = join(tmpDir, "MEMORY.md");
    writeFileSync(
      filePath,
      `- [foo](foo.md) — hook\n- [bar](bar.md) — hook\n`,
      "utf8",
    );
    expect(parseAutoMemoryFile(filePath)).toBeNull();
  });

  it("memory.md 小写索引 → null", () => {
    const filePath = join(tmpDir, "memory.md");
    writeFileSync(filePath, "- [x](x.md)\n", "utf8");
    expect(parseAutoMemoryFile(filePath)).toBeNull();
  });

  it("文件不存在 → null(不抛错)", () => {
    expect(parseAutoMemoryFile(join(tmpDir, "no-exist.md"))).toBeNull();
  });
});

describe("memory-parser: isAutoMemoryFileName", () => {
  it("接受 .md 但排除 MEMORY.md", () => {
    expect(isAutoMemoryFileName("foo.md")).toBe(true);
    expect(isAutoMemoryFileName("MEMORY.md")).toBe(false);
    expect(isAutoMemoryFileName("memory.md")).toBe(false);
    expect(isAutoMemoryFileName("foo.txt")).toBe(false);
    expect(isAutoMemoryFileName("README.md")).toBe(true);
  });
});
