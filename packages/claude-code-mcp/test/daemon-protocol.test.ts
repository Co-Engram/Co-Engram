import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultDaemonLockPath,
  defaultSocketPath,
  hashDataRoot,
  readDaemonLockfile,
  writeDaemonLockfile,
  removeDaemonLockfile,
  isPidAlive,
  DAEMON_PROTOCOL_VERSION,
} from "../src/daemon/protocol.js";
import { isDaemonDisabledByEnv } from "../src/daemon/launcher.js";

describe("daemon protocol", () => {
  describe("defaultDaemonLockPath", () => {
    it("路径落在 <dataRoot>/.co-engram/daemon.lock", () => {
      expect(defaultDaemonLockPath("/foo/bar")).toBe(
        join("/foo/bar", ".co-engram", "daemon.lock"),
      );
    });
  });

  describe("defaultSocketPath", () => {
    it("基于 dataRoot hash 生成稳定 socket 文件名", () => {
      const p1 = defaultSocketPath("/tmp/foo");
      const p2 = defaultSocketPath("/tmp/foo");
      const p3 = defaultSocketPath("/tmp/bar");
      expect(p1).toBe(p2);
      expect(p1).not.toBe(p3);
      expect(p1).toMatch(/daemon-[0-9a-f]{16}\.sock$/);
    });
  });

  describe("hashDataRoot", () => {
    it("返回 sha256 前 16 字符", () => {
      expect(hashDataRoot("/x")).toHaveLength(16);
      expect(hashDataRoot("/x")).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  describe("readDaemonLockfile / writeDaemonLockfile", () => {
    let dir: string;
    let lockPath: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "daemon-lock-test-"));
      // 预创建 .co-engram 父目录(writeFileSync 在测试场景里不会自动 mkdir,
      // 而 writeDaemonLockfile 内部会 mkdirSync recursive)
      mkdirSync(join(dir, ".co-engram"), { recursive: true });
      lockPath = defaultDaemonLockPath(dir);
    });
    afterEach(() => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it("round-trip:write 后 read 返回相同内容", () => {
      const now = new Date().toISOString();
      const content = {
        pid: process.pid,
        socketPath: "/tmp/test.sock",
        dataRootHash: hashDataRoot(dir),
        startedAt: now,
        heartbeatAt: now,
        version: DAEMON_PROTOCOL_VERSION,
      };
      writeDaemonLockfile(lockPath, content);
      const read = readDaemonLockfile(lockPath);
      expect(read).toEqual(content);
    });

    it("read 不存在的 lockfile 返回 undefined", () => {
      expect(readDaemonLockfile(join(dir, "nonexistent.lock"))).toBeUndefined();
    });

    it("read 损坏的 lockfile 返回 undefined", () => {
      writeFileSync(lockPath, "{ not valid json", "utf8");
      expect(readDaemonLockfile(lockPath)).toBeUndefined();
    });

    it("read 版本不匹配的 lockfile 返回 undefined", () => {
      const now = new Date().toISOString();
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: 1234,
          socketPath: "/tmp/x.sock",
          dataRootHash: "abc",
          startedAt: now,
          heartbeatAt: now,
          version: "0", // 旧版本
        }),
      );
      expect(readDaemonLockfile(lockPath)).toBeUndefined();
    });

    it("read 缺字段的 lockfile 返回 undefined", () => {
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: 1234 }), // 缺 socketPath / dataRootHash / version
      );
      expect(readDaemonLockfile(lockPath)).toBeUndefined();
    });

    it("removeDaemonLockfile 删除 lockfile(幂等)", () => {
      const now = new Date().toISOString();
      writeDaemonLockfile(lockPath, {
        pid: process.pid,
        socketPath: "/tmp/test.sock",
        dataRootHash: hashDataRoot(dir),
        startedAt: now,
        heartbeatAt: now,
        version: DAEMON_PROTOCOL_VERSION,
      });
      expect(existsSync(lockPath)).toBe(true);
      removeDaemonLockfile(lockPath);
      expect(existsSync(lockPath)).toBe(false);
      // 再次调用不抛错
      expect(() => removeDaemonLockfile(lockPath)).not.toThrow();
    });
  });

  describe("isPidAlive", () => {
    it("当前进程 pid 存活", () => {
      expect(isPidAlive(process.pid)).toBe(true);
    });

    it("pid=0 视为不存在", () => {
      expect(isPidAlive(0)).toBe(false);
    });

    it("负 pid 视为不存在", () => {
      expect(isPidAlive(-1)).toBe(false);
    });

    it("不存在的 pid 返回 false(ESRCH)", () => {
      // PID 上限是 4194304(Linux),用 999999 几乎肯定不存在
      expect(isPidAlive(999999)).toBe(false);
    });
  });
});

describe("isDaemonDisabledByEnv", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    // 恢复 env
    for (const k of Object.keys(process.env)) {
      if (!(k in origEnv)) delete process.env[k];
    }
    Object.assign(process.env, origEnv);
  });

  it("默认(env 未设)= 启用 daemon(返回 false)", () => {
    delete process.env.CO_ENGRAM_DAEMON;
    expect(isDaemonDisabledByEnv()).toBe(false);
  });

  it("CO_ENGRAM_DAEMON=0 禁用", () => {
    process.env.CO_ENGRAM_DAEMON = "0";
    expect(isDaemonDisabledByEnv()).toBe(true);
  });

  it("CO_ENGRAM_DAEMON=false / off / no 禁用(大小写不敏感)", () => {
    for (const v of ["false", "FALSE", "off", "OFF", "no", "No"]) {
      process.env.CO_ENGRAM_DAEMON = v;
      expect(isDaemonDisabledByEnv({ CO_ENGRAM_DAEMON: v } as NodeJS.ProcessEnv)).toBe(true);
    }
  });

  it("CO_ENGRAM_DAEMON=1 / true / yes 启用", () => {
    for (const v of ["1", "true", "yes", "on"]) {
      expect(isDaemonDisabledByEnv({ CO_ENGRAM_DAEMON: v } as NodeJS.ProcessEnv)).toBe(false);
    }
  });

  it("未识别值视为启用(fail-safe)", () => {
    expect(isDaemonDisabledByEnv({ CO_ENGRAM_DAEMON: "random" } as NodeJS.ProcessEnv)).toBe(false);
  });
});
