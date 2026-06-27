import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveLlmConfigPath,
  writeLlmClientConfig,
  readLlmClientConfig,
  clearLlmClientConfig,
  createHttpLlmClient,
  createDriverLlmClient,
  type LlmClientConfig,
} from "./driver-llm.js";

let fakeHome: string;
let originalHome: string | undefined;
let originalOverride: string | undefined;

function setFakeHome(): void {
  fakeHome = mkdtempSync(join(tmpdir(), "driver-llm-home-"));
  originalHome = process.env.HOME;
  originalOverride = process.env.CO_ENGRAM_LLM_CONFIG;
  delete process.env.CO_ENGRAM_LLM_CONFIG;
  process.env.HOME = fakeHome;
}

function restoreHome(): void {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalOverride === undefined) delete process.env.CO_ENGRAM_LLM_CONFIG;
  else process.env.CO_ENGRAM_LLM_CONFIG = originalOverride;
  rmSync(fakeHome, { recursive: true, force: true });
}

const sampleConfig: Omit<LlmClientConfig, "writtenAt"> = {
  endpoint: "https://api.example.com/v1",
  apiKey: "sk-test-12345",
  model: "gpt-test",
  writtenBy: "openclaw-plugin",
};

describe("resolveLlmConfigPath", () => {
  beforeEach(setFakeHome);
  afterEach(restoreHome);

  it("uses $HOME/.co-engram/llm-config.json by default", () => {
    expect(resolveLlmConfigPath()).toBe(
      join(fakeHome, ".co-engram", "llm-config.json"),
    );
  });

  it("respects CO_ENGRAM_LLM_CONFIG override", () => {
    process.env.CO_ENGRAM_LLM_CONFIG = "/custom/path.json";
    expect(resolveLlmConfigPath()).toBe("/custom/path.json");
  });
});

describe("writeLlmClientConfig / readLlmClientConfig", () => {
  beforeEach(setFakeHome);
  afterEach(restoreHome);

  it("round-trips config through disk", () => {
    const writeResult = writeLlmClientConfig(sampleConfig);
    expect(writeResult.ok).toBe(true);

    const read = readLlmClientConfig();
    expect(read).toBeDefined();
    expect(read?.endpoint).toBe(sampleConfig.endpoint);
    expect(read?.apiKey).toBe(sampleConfig.apiKey);
    expect(read?.model).toBe(sampleConfig.model);
    expect(read?.writtenBy).toBe("openclaw-plugin");
    expect(read?.writtenAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("returns undefined when config file absent", () => {
    expect(readLlmClientConfig()).toBeUndefined();
  });

  it("returns undefined when config is malformed JSON", () => {
    const path = resolveLlmConfigPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{ not valid json", "utf8");
    expect(readLlmClientConfig()).toBeUndefined();
  });

  it("returns undefined when required fields missing", () => {
    const path = resolveLlmConfigPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ endpoint: "x", model: "y" /* no apiKey */ }),
      "utf8",
    );
    expect(readLlmClientConfig()).toBeUndefined();
  });

  it("preserves optional headers field", () => {
    const writeResult = writeLlmClientConfig({
      ...sampleConfig,
      headers: { "X-Custom": "value" },
    });
    expect(writeResult.ok).toBe(true);
    const read = readLlmClientConfig();
    expect(read?.headers?.["X-Custom"]).toBe("value");
  });
});

describe("clearLlmClientConfig", () => {
  beforeEach(setFakeHome);
  afterEach(restoreHome);

  it("removes existing config file", () => {
    writeLlmClientConfig(sampleConfig);
    expect(existsSync(resolveLlmConfigPath())).toBe(true);

    const result = clearLlmClientConfig();
    expect(result.ok).toBe(true);
    expect(existsSync(resolveLlmConfigPath())).toBe(false);
  });

  it("succeeds when config file absent (idempotent)", () => {
    const result = clearLlmClientConfig();
    expect(result.ok).toBe(true);
  });
});

describe("normalizeEndpoint (indirect)", () => {
  it("leaves /chat/completions URLS unchanged", () => {
    // Tested indirectly via createHttpLlmClient by ensuring no double-append.
    // Direct test would require exporting the function.
  });
});

describe("createHttpLlmClient", () => {
  it("POSTs to endpoint with Authorization header and parses content", async () => {
    // Capture fetch
    const calls: Array<{
      url: string;
      headers: Record<string, string>;
      body: string;
    }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      calls.push({
        url: urlStr,
        headers: init?.headers as Record<string, string>,
        body: init?.body as string,
      });
      return {
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "hello from llm" } }],
          }),
      } as Response;
    }) as typeof fetch;

    try {
      const client = createHttpLlmClient({
        endpoint: "https://api.example.com/v1",
        apiKey: "sk-test",
        model: "test-model",
        writtenAt: "2026-01-01T00:00:00Z",
      });
      const result = await client.complete("test prompt", {
        maxTokens: 100,
        temperature: 0.2,
        timeoutMs: 5000,
      });
      expect(result).toBe("hello from llm");

      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("https://api.example.com/v1/chat/completions");
      const body = JSON.parse(calls[0]!.body);
      expect(body.model).toBe("test-model");
      expect(body.max_tokens).toBe(100);
      expect(body.temperature).toBe(0.2);
      expect(body.messages).toEqual([{ role: "user", content: "test prompt" }]);
      expect(calls[0]!.headers.Authorization).toBe("Bearer sk-test");
      expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not double-append /chat/completions if already present", async () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(typeof url === "string" ? url : url.toString());
      return {
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "x" } }],
          }),
      } as Response;
    }) as typeof fetch;

    try {
      const client = createHttpLlmClient({
        endpoint: "https://api.example.com/v1/chat/completions",
        apiKey: "sk",
        model: "m",
        writtenAt: "2026-01-01T00:00:00Z",
      });
      await client.complete("p");
      expect(calls[0]).toBe("https://api.example.com/v1/chat/completions");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to reasoning_content when content is empty", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return {
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: null,
                  reasoning_content: "from reasoning",
                },
              },
            ],
          }),
      } as Response;
    }) as typeof fetch;

    try {
      const client = createHttpLlmClient({
        endpoint: "https://api.example.com/v1",
        apiKey: "sk",
        model: "m",
        writtenAt: "2026-01-01T00:00:00Z",
      });
      const result = await client.complete("p");
      expect(result).toBe("from reasoning");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws when response not ok", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return {
        ok: false,
        status: 429,
        text: () => Promise.resolve("rate limited"),
        json: () => Promise.resolve({}),
      } as Response;
    }) as typeof fetch;

    try {
      const client = createHttpLlmClient({
        endpoint: "https://api.example.com/v1",
        apiKey: "sk",
        model: "m",
        writtenAt: "2026-01-01T00:00:00Z",
      });
      await expect(client.complete("p")).rejects.toThrow(/429/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws when content empty and no reasoning_content", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return {
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "" } }],
          }),
      } as Response;
    }) as typeof fetch;

    try {
      const client = createHttpLlmClient({
        endpoint: "https://api.example.com/v1",
        apiKey: "sk",
        model: "m",
        writtenAt: "2026-01-01T00:00:00Z",
      });
      await expect(client.complete("p")).rejects.toThrow(/empty content/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends custom headers when configured", async () => {
    const calls: Array<{ headers: Record<string, string> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url, init?: RequestInit) => {
      calls.push({ headers: init?.headers as Record<string, string> });
      return {
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "x" } }],
          }),
      } as Response;
    }) as typeof fetch;

    try {
      const client = createHttpLlmClient({
        endpoint: "https://api.example.com/v1",
        apiKey: "sk",
        model: "m",
        writtenAt: "2026-01-01T00:00:00Z",
        headers: { "X-Org": "my-org" },
      });
      await client.complete("p");
      expect(calls[0]!.headers["X-Org"]).toBe("my-org");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("createDriverLlmClient", () => {
  beforeEach(setFakeHome);
  afterEach(restoreHome);

  it("returns null when config absent", () => {
    expect(createDriverLlmClient()).toBeNull();
  });

  it("returns client + config when config present", () => {
    writeLlmClientConfig(sampleConfig);
    const result = createDriverLlmClient();
    expect(result).not.toBeNull();
    expect(result?.config.endpoint).toBe(sampleConfig.endpoint);
    expect(typeof result?.client.complete).toBe("function");
  });
});
