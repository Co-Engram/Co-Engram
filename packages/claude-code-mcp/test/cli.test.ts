import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = resolve(__dirname, "../dist/cli.js");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "co-engram-cli-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function runCli(
  args: string[],
  opts: { input?: string; env?: Record<string, string> } = {},
): {
  status: number;
  stdout: string;
  stderr: string;
} {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      input: opts.input ?? "",
      env: { ...process.env, ...opts.env },
      encoding: "utf-8",
      timeout: 10000,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

describe("co-engram init CLI", () => {
  it("--help 显示用法", () => {
    const { status, stdout } = runCli(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("Usage: co-engram init");
    expect(stdout).toContain("--path");
    expect(stdout).toContain("--language");
    expect(stdout).toContain("--created-by");
    expect(stdout).toContain("--no-git");
    expect(stdout).toContain("--force");
  });

  it("init 无参数 + --path + --language=en + --no-git(非交互)", () => {
    const target = join(tmpDir, "team-memory-en");
    const { status, stdout } = runCli([
      "init",
      "--path",
      target,
      "--language",
      "en",
      "--created-by",
      "alice",
      "--no-git",
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain("Done");
    expect(stdout).toContain("Happy remembering");

    // 配置文件已写入
    const configPath = join(target, ".co-engram", "config.json");
    expect(existsSync(configPath)).toBe(true);
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.language).toBe("en");
    expect(parsed.defaultCreatedBy).toBe("alice");
  });

  it("init --language=zh 写入中文配置", () => {
    const target = join(tmpDir, "team-memory-zh");
    const { status, stdout } = runCli([
      "init",
      "--path",
      target,
      "--language",
      "zh",
      "--created-by",
      "bob",
      "--no-git",
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain("完成");
    expect(stdout).toContain("记忆之旅");

    const configPath = join(target, ".co-engram", "config.json");
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.language).toBe("zh");
    expect(parsed.defaultCreatedBy).toBe("bob");
  });

  it("init 自动创建目录", () => {
    const target = join(tmpDir, "nested", "deep", "team-memory");
    const { status } = runCli([
      "init",
      "--path",
      target,
      "--language",
      "en",
      "--no-git",
    ]);
    expect(status).toBe(0);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(target, ".co-engram", "config.json"))).toBe(true);
  });

  it("init 默认 git init(空目录)", () => {
    const target = join(tmpDir, "with-git");
    const { status } = runCli(["init", "--path", target, "--language", "en"]);
    expect(status).toBe(0);
    expect(existsSync(join(target, ".git"))).toBe(true);
  });

  it("init 重复运行默认跳过(不覆盖)", () => {
    const target = join(tmpDir, "repeat");
    runCli(["init", "--path", target, "--language", "en", "--no-git"]);
    const firstRaw = readFileSync(
      join(target, ".co-engram", "config.json"),
      "utf-8",
    );
    const firstParsed = JSON.parse(firstRaw);
    expect(firstParsed.language).toBe("en");

    // 第二次用 zh 运行,不带 --force,应该不覆盖
    const { stdout } = runCli([
      "init",
      "--path",
      target,
      "--language",
      "zh",
      "--no-git",
    ]);
    expect(stdout).toContain("Config exists");
    const secondRaw = readFileSync(
      join(target, ".co-engram", "config.json"),
      "utf-8",
    );
    const secondParsed = JSON.parse(secondRaw);
    expect(secondParsed.language).toBe("en"); // 没变
  });

  it("init --force 覆盖已有配置", () => {
    const target = join(tmpDir, "force");
    runCli(["init", "--path", target, "--language", "en", "--no-git"]);

    const { stdout } = runCli([
      "init",
      "--path",
      target,
      "--language",
      "zh",
      "--no-git",
      "--force",
    ]);
    expect(stdout).toContain("配置已写入");

    const raw = readFileSync(
      join(target, ".co-engram", "config.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw);
    expect(parsed.language).toBe("zh");
  });

  it("init 接受 --flag=VALUE 语法(等价于 --flag VALUE)", () => {
    // 回归:之前 parseArgs 只识别 --flag VALUE,导致 --path=/foo --language=en
    // 被静默丢弃,falling through 到 interactive 模式提示用户输入。
    // 现代 CLI 工具两种语法都应支持。
    const target = join(tmpDir, "equals-syntax");
    const { status, stdout } = runCli([
      "init",
      `--path=${target}`,
      "--language=en",
      "--created-by=carol",
      "--no-git",
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain("Done");

    const raw = readFileSync(
      join(target, ".co-engram", "config.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw);
    expect(parsed.language).toBe("en");
    expect(parsed.defaultCreatedBy).toBe("carol");
  });

  it("init 混合 --flag VALUE 与 --flag=VALUE 都生效", () => {
    // 用户可能混用两种语法(--path 用空格,--language 用等号),都应识别
    const target = join(tmpDir, "mixed-syntax");
    const { status } = runCli([
      "init",
      "--path",
      target,
      "--language=zh",
      "--no-git",
    ]);
    expect(status).toBe(0);
    const raw = readFileSync(
      join(target, ".co-engram", "config.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw);
    expect(parsed.language).toBe("zh");
  });

  it("init 持久化的语言被 MCP 启动读取(端到端)", async () => {
    const target = join(tmpDir, "persist");
    runCli(["init", "--path", target, "--language", "zh", "--no-git"]);
    // 启动 MCP server(直接调用 register 而非 stdio,避免长进程)
    const { createCoEngramMcpServer } = await import("../src/register.js");
    const { Client } =
      await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } =
      await import("@modelcontextprotocol/sdk/inMemory.js");
    const { readTeamMemoryConfig, resolveLanguage } =
      await import("@co-engram/core");

    const persisted = await readTeamMemoryConfig(target);
    const language = resolveLanguage(undefined, persisted);
    expect(language).toBe("zh");

    const { server } = createCoEngramMcpServer({ dataRoot: target, language });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    try {
      const list = await client.listTools();
      const create = list.tools.find((t) => t.name === "engram_create");
      expect(create?.description).toContain("创建新记忆");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("未识别命令时退到 help", () => {
    const { status, stderr } = runCli(["unknown-cmd"]);
    expect(status).toBe(1);
    expect(stderr).toContain("Unknown command");
    // showHelp 输出到 stdout
  });
});
