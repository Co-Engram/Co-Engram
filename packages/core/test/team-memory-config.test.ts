import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readTeamMemoryConfig,
  writeTeamMemoryConfig,
  TEAM_MEMORY_CONFIG_FILENAME,
} from "../src/i18n/index.js";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "co-engram-i18n-"));
}

describe("team-memory config / writeTeamMemoryConfig", () => {
  it("写入 .co-engram/config.json(目录自动创建)", async () => {
    const dir = makeTmp();
    try {
      await writeTeamMemoryConfig(dir, {
        version: 1,
        language: "zh",
        defaultCreatedBy: "alice",
        createdAt: "2026-06-21T00:00:00.000Z",
        initializedBy: "test",
      });
      const configPath = join(dir, ".co-engram", TEAM_MEMORY_CONFIG_FILENAME);
      expect(existsSync(configPath)).toBe(true);
      const raw = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(1);
      expect(parsed.language).toBe("zh");
      expect(parsed.defaultCreatedBy).toBe("alice");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("覆盖已有文件", async () => {
    const dir = makeTmp();
    try {
      await writeTeamMemoryConfig(dir, { version: 1, language: "en" });
      await writeTeamMemoryConfig(dir, { version: 1, language: "zh" });
      const cfg = await readTeamMemoryConfig(dir);
      expect(cfg?.language).toBe("zh");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("支持自定义 fsWrite(测试注入)", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    await writeTeamMemoryConfig(
      "/fake",
      { version: 1, language: "en" },
      async (path, content) => {
        writes.push({ path, content });
      },
    );
    expect(writes.length).toBe(1);
    expect(writes[0]!.path).toContain("config.json");
    expect(writes[0]!.content).toContain('"language": "en"');
  });
});

describe("team-memory config / readTeamMemoryConfig", () => {
  it("读取已存在的配置", async () => {
    const dir = makeTmp();
    try {
      await writeTeamMemoryConfig(dir, {
        version: 1,
        language: "zh",
        defaultCreatedBy: "bob",
      });
      const cfg = await readTeamMemoryConfig(dir);
      expect(cfg).toBeDefined();
      expect(cfg?.version).toBe(1);
      expect(cfg?.language).toBe("zh");
      expect(cfg?.defaultCreatedBy).toBe("bob");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("文件不存在时返回 undefined", async () => {
    const dir = makeTmp();
    try {
      const cfg = await readTeamMemoryConfig(dir);
      expect(cfg).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("JSON 解析失败时返回 undefined", async () => {
    const dir = makeTmp();
    try {
      const cfg = await readTeamMemoryConfig(dir, async () => "{not json");
      expect(cfg).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("version !== 1 时返回 undefined", async () => {
    const dir = makeTmp();
    try {
      const cfg = await readTeamMemoryConfig(dir, async () =>
        JSON.stringify({ version: 99 }),
      );
      expect(cfg).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("支持自定义 fsRead(测试注入)", async () => {
    const cfg = await readTeamMemoryConfig("/fake", async () =>
      JSON.stringify({ version: 1, language: "zh" }),
    );
    expect(cfg?.language).toBe("zh");
  });
});
