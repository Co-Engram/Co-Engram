import { describe, it, expect } from "vitest";
import {
  injectHooks,
  isHookInstalled,
  HOOK_MARKER,
  DEFAULT_VIEWER_URL,
} from "../src/hooks/installer.js";

const HOOK_PATH = "/dist/hooks/observe.py";
const ALT_HOOK_PATH = "/old/path/co-engram-observe.py";
const USER_VIEWER_URL = "http://127.0.0.1:18999";

describe("isHookInstalled", () => {
  it("空 settings → false", () => {
    expect(isHookInstalled({})).toBe(false);
    expect(isHookInstalled(null)).toBe(false);
    expect(isHookInstalled(undefined)).toBe(false);
  });

  it("有 observe.py 命令 → true", () => {
    const settings = {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: "/some/path/observe.py user",
                async: true,
              },
            ],
          },
        ],
      },
    };
    expect(isHookInstalled(settings)).toBe(true);
  });

  it("只有非 observe.py 命令 → false", () => {
    const settings = {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: "/usr/bin/other-hook.sh",
                async: false,
              },
            ],
          },
        ],
      },
    };
    expect(isHookInstalled(settings)).toBe(false);
  });
});

describe("injectHooks · 幂等性", () => {
  it("空 settings → 注入,changed=true", () => {
    const { settings, changed } = injectHooks(
      {},
      HOOK_PATH,
      DEFAULT_VIEWER_URL,
    );
    expect(changed).toBe(true);
    const s = settings as {
      hooks: { UserPromptSubmit: unknown[] };
      env: Record<string, string>;
    };
    expect(s.hooks.UserPromptSubmit).toHaveLength(1);
    expect(s.env.CO_ENGRAM_VIEWER_URL).toBe(DEFAULT_VIEWER_URL);
  });

  it("完全相同状态二次注入 → changed=false", () => {
    const first = injectHooks({}, HOOK_PATH, DEFAULT_VIEWER_URL);
    const second = injectHooks(first.settings, HOOK_PATH, DEFAULT_VIEWER_URL);
    expect(second.changed).toBe(false);
  });

  it("用户已有 env 块时,只追加 CO_ENGRAM_VIEWER_URL,不动其它", () => {
    const initial = { env: { OTHER_VAR: "keep-me", PATH: "/usr/bin" } };
    const { settings } = injectHooks(initial, HOOK_PATH, DEFAULT_VIEWER_URL);
    const env = (settings as { env: Record<string, string> }).env;
    expect(env.OTHER_VAR).toBe("keep-me");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.CO_ENGRAM_VIEWER_URL).toBe(DEFAULT_VIEWER_URL);
  });
});

describe("injectHooks · 路径迁移", () => {
  it("旧路径 observe.py → 新路径,自动清理旧条目", () => {
    const initial = {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: `${ALT_HOOK_PATH} user`,
                async: true,
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: `${ALT_HOOK_PATH} assistant`,
                async: true,
              },
            ],
          },
        ],
      },
    };
    const { settings, changed } = injectHooks(
      initial,
      HOOK_PATH,
      DEFAULT_VIEWER_URL,
    );
    expect(changed).toBe(true);
    const userCmds = (
      settings as {
        hooks: {
          UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }>;
        };
      }
    ).hooks.UserPromptSubmit.flatMap((e) =>
      e.hooks.map((h) => h.command),
    ).filter((c) => c.includes(HOOK_MARKER));
    expect(userCmds).toEqual([`${HOOK_PATH} user`]);
  });
});

describe("injectHooks · 用户自定义 hook 保留", () => {
  it("用户独立的 hook 条目不被动到", () => {
    const userCmd = "/usr/local/bin/prepend-jira.sh";
    const initial = {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: userCmd, async: false }] },
          {
            hooks: [
              { type: "command", command: `${HOOK_PATH} user`, async: true },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: `${HOOK_PATH} assistant`,
                async: true,
              },
            ],
          },
        ],
      },
      env: { CO_ENGRAM_VIEWER_URL: DEFAULT_VIEWER_URL },
    };
    const { settings, changed } = injectHooks(
      initial,
      HOOK_PATH,
      DEFAULT_VIEWER_URL,
    );
    // 已是期望状态(用户 hook + 我们的 hook + env 都对),不应 changed
    expect(changed).toBe(false);
    const userCmds = (
      settings as {
        hooks: {
          UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }>;
        };
      }
    ).hooks.UserPromptSubmit.flatMap((e) => e.hooks.map((h) => h.command));
    expect(userCmds).toContain(userCmd);
  });

  it("关键回归:用户 hook 和我们旧 observe.py 在同一 entry → 应只移除我们的 inner hook,保留用户的", () => {
    // 这是关键 bug 回归:用户曾把我们的 hook 和他们自己的 hook 合并到一个 entry 里,
    // 旧实现 removeAllMatching 会因 every() 检查失败而保留整个 entry,导致旧的
    // observe.py 调用残留 + 我们又追加新的 → 用户每次 prompt 触发 2 次 observe。
    const userCmd = "/usr/local/bin/prepend-jira.sh";
    const initial = {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              { type: "command", command: userCmd, async: false },
              {
                type: "command",
                command: `${ALT_HOOK_PATH} user`,
                async: true,
              },
            ],
          },
        ],
        Stop: [],
      },
    };
    const { settings, changed } = injectHooks(
      initial,
      HOOK_PATH,
      DEFAULT_VIEWER_URL,
    );
    expect(changed).toBe(true);
    const userEntries = (
      settings as {
        hooks: {
          UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }>;
        };
      }
    ).hooks.UserPromptSubmit;

    // 1. 用户的 hook 必须保留
    const allCommands = userEntries.flatMap((e) =>
      e.hooks.map((h) => h.command),
    );
    expect(allCommands).toContain(userCmd);

    // 2. 旧的 observe.py 调用必须不再出现(只允许新路径出现一次)
    const observeCalls = allCommands.filter((c) => c.includes(HOOK_MARKER));
    expect(observeCalls).toEqual([`${HOOK_PATH} user`]);
    expect(observeCalls.some((c) => c.includes(ALT_HOOK_PATH))).toBe(false);
  });

  it("关键回归:Stop 事件同样适用混合 entry 处理", () => {
    const userCmd = "/usr/local/bin/notify-done.sh";
    const initial = {
      hooks: {
        UserPromptSubmit: [],
        Stop: [
          {
            hooks: [
              { type: "command", command: userCmd, async: false },
              {
                type: "command",
                command: `${ALT_HOOK_PATH} assistant`,
                async: true,
              },
            ],
          },
        ],
      },
    };
    const { settings } = injectHooks(initial, HOOK_PATH, DEFAULT_VIEWER_URL);
    const stopCmds = (
      settings as {
        hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
      }
    ).hooks.Stop.flatMap((e) => e.hooks.map((h) => h.command));
    expect(stopCmds).toContain(userCmd);
    const observeCalls = stopCmds.filter((c) => c.includes(HOOK_MARKER));
    expect(observeCalls).toEqual([`${HOOK_PATH} assistant`]);
  });
});

describe("injectHooks · env 视图 URL 变更", () => {
  it("viewer 端口变更 → env 更新,changed=true", () => {
    const initial = injectHooks({}, HOOK_PATH, DEFAULT_VIEWER_URL).settings;
    const { settings, changed } = injectHooks(
      initial,
      HOOK_PATH,
      USER_VIEWER_URL,
    );
    expect(changed).toBe(true);
    expect(
      (settings as { env: { CO_ENGRAM_VIEWER_URL: string } }).env
        .CO_ENGRAM_VIEWER_URL,
    ).toBe(USER_VIEWER_URL);
  });
});
