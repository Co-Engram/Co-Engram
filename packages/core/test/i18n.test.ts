import { describe, it, expect } from "vitest";
import {
  t,
  parseLanguage,
  localizeToolDescription,
  pluralSuffix,
  resolveLanguage,
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  en,
  zh,
} from "../src/i18n/index.js";

describe("i18n / parseLanguage", () => {
  it("识别 en / english / EN", () => {
    expect(parseLanguage("en")).toBe("en");
    expect(parseLanguage("EN")).toBe("en");
    expect(parseLanguage("english")).toBe("en");
    expect(parseLanguage("English")).toBe("en");
  });

  it("识别 zh / zh-CN / chinese / cn", () => {
    expect(parseLanguage("zh")).toBe("zh");
    expect(parseLanguage("ZH")).toBe("zh");
    expect(parseLanguage("zh-CN")).toBe("zh");
    expect(parseLanguage("chinese")).toBe("zh");
    expect(parseLanguage("cn")).toBe("zh");
  });

  it("undefined / null / 未知值 fallback 到默认语言", () => {
    expect(parseLanguage(undefined)).toBe(DEFAULT_LANGUAGE);
    expect(parseLanguage(null)).toBe(DEFAULT_LANGUAGE);
    expect(parseLanguage("")).toBe(DEFAULT_LANGUAGE);
    expect(parseLanguage("fr")).toBe(DEFAULT_LANGUAGE);
  });
});

describe("i18n / constants", () => {
  it("DEFAULT_LANGUAGE 是 zh(中文团队优先)", () => {
    expect(DEFAULT_LANGUAGE).toBe("zh");
  });

  it("SUPPORTED_LANGUAGES 包含 en 和 zh", () => {
    expect(SUPPORTED_LANGUAGES).toContain("en");
    expect(SUPPORTED_LANGUAGES).toContain("zh");
    expect(SUPPORTED_LANGUAGES.length).toBe(2);
  });
});

describe("i18n / t()", () => {
  it("返回对应语言的字符串", () => {
    expect(t("en", "tool.engram_create")).toBe(en["tool.engram_create"]);
    expect(t("zh", "tool.engram_create")).toBe(zh["tool.engram_create"]);
  });

  it("中英文确实不同", () => {
    expect(t("en", "tool.engram_create")).not.toBe(
      t("zh", "tool.engram_create"),
    );
  });

  it("未识别语言 fallback 到英文", () => {
    // @ts-expect-error 测试运行时容错
    expect(t("xx" as any, "tool.engram_create")).toBe(en["tool.engram_create"]);
  });

  it("未知 key 返回 key 本身", () => {
    expect(t("en", "unknown.key.xyz")).toBe("unknown.key.xyz");
    expect(t("zh", "unknown.key.xyz")).toBe("unknown.key.xyz");
  });

  it("模板变量替换", () => {
    const enPrompt = t("en", "prompt.proposal_prompt", {
      count: 3,
      plural: "s",
    });
    expect(enPrompt).toContain("3 memory candidates");
    expect(enPrompt).toContain("topics seen");

    const zhPrompt = t("zh", "prompt.proposal_prompt", {
      count: 3,
      plural: "",
    });
    expect(zhPrompt).toContain("3 个候选记忆");
    expect(zhPrompt).not.toContain("${");
  });

  it("单数和复数都可以正确替换", () => {
    const enSingle = t("en", "prompt.proposal_prompt", {
      count: 1,
      plural: "",
    });
    expect(enSingle).toContain("1 memory candidate pending");
    expect(enSingle).toContain("topic seen");

    const enPlural = t("en", "prompt.proposal_prompt", {
      count: 5,
      plural: "s",
    });
    expect(enPlural).toContain("5 memory candidates pending");
    expect(enPlural).toContain("topics seen");
  });

  it("未提供的模板变量保留 ${name} 占位", () => {
    const s = t("en", "prompt.proposal_prompt", { count: 2 });
    expect(s).toContain("${plural}");
  });
});

describe("i18n / pluralSuffix", () => {
  it("英文 1 返回空串", () => {
    expect(pluralSuffix("en", 1)).toBe("");
  });

  it("英文 0 / 2+ 返回 s", () => {
    expect(pluralSuffix("en", 0)).toBe("s");
    expect(pluralSuffix("en", 2)).toBe("s");
    expect(pluralSuffix("en", 100)).toBe("s");
  });

  it("中文总是返回空串", () => {
    expect(pluralSuffix("zh", 1)).toBe("");
    expect(pluralSuffix("zh", 2)).toBe("");
    expect(pluralSuffix("zh", 0)).toBe("");
  });
});

describe("i18n / localizeToolDescription", () => {
  it("英文返回英文字典", () => {
    const s = localizeToolDescription("engram_create", "en");
    expect(s).toBe(en["tool.engram_create"]);
    expect(s).toContain("Create a new Engram");
  });

  it("中文返回中文字典", () => {
    const s = localizeToolDescription("engram_create", "zh");
    expect(s).toBe(zh["tool.engram_create"]);
    expect(s).toContain("创建一个新的 Engram");
  });

  it("未知工具 fallback 到原始 description", () => {
    expect(localizeToolDescription("xyz_unknown", "en", "fallback desc")).toBe(
      "fallback desc",
    );
  });

  it("未知工具 + 无 fallback 返回工具名", () => {
    expect(localizeToolDescription("xyz_unknown", "en")).toBe("xyz_unknown");
  });

  it("25 个工具在两个语言都有翻译", () => {
    const toolNames = [
      "engram_create",
      "engram_get",
      "engram_update",
      "engram_delete",
      "engram_search",
      "engram_list",
      "engram_reinforce",
      "engram_report_failure",
      "engram_archive",
      "engram_restore",
      "engram_forget",
      "engram_recompute_importance",
      "contradiction_resolve",
      "close_learning_loop",
      "upgrade_verification",
      "get_evolution_lineage",
      "synapse_create",
      "synapse_get",
      "synapse_delete",
      "synapse_list",
      "skill_get",
      "skill_invoke",
      "engram_list_proposals",
      "engram_accept_proposal",
      "engram_dismiss_proposal",
    ];
    for (const name of toolNames) {
      const enDesc = localizeToolDescription(name, "en");
      const zhDesc = localizeToolDescription(name, "zh");
      expect(enDesc, `${name} en description`).not.toBe(name);
      expect(zhDesc, `${name} zh description`).not.toBe(name);
      expect(enDesc).not.toBe(zhDesc);
    }
  });
});

describe("i18n / resolveLanguage", () => {
  it("env > persisted > default", () => {
    expect(resolveLanguage("zh")).toBe("zh");
    expect(resolveLanguage("en")).toBe("en");
    expect(resolveLanguage(undefined, { version: 1, language: "zh" })).toBe(
      "zh",
    );
    expect(resolveLanguage(undefined, { version: 1, language: "en" })).toBe(
      "en",
    );
    expect(resolveLanguage(undefined, undefined)).toBe(DEFAULT_LANGUAGE);
  });

  it("env 覆盖 persisted", () => {
    expect(resolveLanguage("en", { version: 1, language: "zh" })).toBe("en");
    expect(resolveLanguage("zh", { version: 1, language: "en" })).toBe("zh");
  });

  it("persisted.language 缺失时 fallback", () => {
    expect(resolveLanguage(undefined, { version: 1 })).toBe(DEFAULT_LANGUAGE);
  });

  it("未识别 env 值 fallback 到默认", () => {
    expect(resolveLanguage("fr")).toBe(DEFAULT_LANGUAGE);
  });
});

describe("i18n / dictionary completeness", () => {
  it("中英字典 key 数量一致", () => {
    const enKeys = Object.keys(en).sort();
    const zhKeys = Object.keys(zh).sort();
    expect(enKeys).toEqual(zhKeys);
  });

  it("字典没有空字符串值", () => {
    for (const [k, v] of Object.entries(en)) {
      expect(v, `en.${k} should not be empty`).toBeTruthy();
    }
    for (const [k, v] of Object.entries(zh)) {
      expect(v, `zh.${k} should not be empty`).toBeTruthy();
    }
  });

  it("所有 value 都是 string 类型", () => {
    for (const [k, v] of Object.entries(en)) {
      expect(typeof v, `en.${k} must be string`).toBe("string");
    }
    for (const [k, v] of Object.entries(zh)) {
      expect(typeof v, `zh.${k} must be string`).toBe("string");
    }
  });
});

describe("i18n / zh.ts 源码防回归 (Finding 141)", () => {
  it("zh.ts 源码无未转义双引号导致 tsc 编译失败", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const zhSrc = readFileSync(
      join(__dirname, "../src/i18n/zh.ts"),
      "utf8",
    );
    const lines = zhSrc.split("\n");
    const offenders: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed.startsWith('"')) continue;
      const colonIdx = trimmed.indexOf('":');
      if (colonIdx < 0) continue;
      const valueStart = trimmed.slice(colonIdx + 2).trimStart();
      if (!valueStart.startsWith('"')) continue;
      const valueBody = valueStart.slice(1);
      const closingIdx = valueBody.indexOf('"');
      if (closingIdx < 0) continue;
      const inner = valueBody.slice(0, closingIdx);
      const hasUnescapedDoubleQuote = /(?<!\\)"/.test(inner);
      if (hasUnescapedDoubleQuote) {
        offenders.push(`L${i + 1}: ${trimmed.slice(0, 80)}`);
      }
    }
    expect(
      offenders,
      `zh.ts 有未转义双引号,会导致 dist/i18n/zh.js 语法错误:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("dist/i18n/zh.js ESM 加载不抛 SyntaxError", async () => {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");
    const distPath = join(__dirname, "../dist/i18n/zh.js");
    let mod: unknown;
    try {
      mod = await import(pathToFileURL(distPath).href);
    } catch (e) {
      throw new Error(
        `dist/i18n/zh.js 加载失败 (Finding 141 回归): ${(e as Error).message}`,
      );
    }
    expect(mod).toBeTruthy();
    expect(typeof (mod as Record<string, unknown>).zh).toBe("object");
  });
});
