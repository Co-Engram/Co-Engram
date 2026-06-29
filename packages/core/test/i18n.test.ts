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
  type DescriptionLayer,
} from "../src/i18n/index.js";
import { listAgentDescribedTools } from "../src/tools/llm-descriptions.js";

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
    expect(s).toContain("Create a new memory");
  });

  it("中文返回中文字典", () => {
    const s = localizeToolDescription("engram_create", "zh");
    expect(s).toBe(zh["tool.engram_create"]);
    expect(s).toContain("创建一条新记忆");
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

describe("i18n / 三层描述拆分 (user/agent/technical)", () => {
  const TOOL_NAMES = [
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
    "engram_doctor",
    "engram_list_paths",
    "engram_synthesize",
    "memory_search",
    "memory_get",
  ] as const;

  it("localizeToolDescription 默认 layer=user(向后兼容)", () => {
    // 不传 layer 时等价于 layer='user',返回 tool.<name>
    const userDesc = localizeToolDescription("engram_create", "en");
    const explicitUser = localizeToolDescription(
      "engram_create",
      "en",
      undefined,
      "user",
    );
    expect(userDesc).toBe(explicitUser);
  });

  it("agent 层返回 tool.<name>.agent", () => {
    const agentDesc = localizeToolDescription(
      "engram_create",
      "en",
      undefined,
      "agent",
    );
    expect(agentDesc).toContain("WHEN TO CALL");
    expect(agentDesc).toContain("RETURNS");
  });

  it("technical 层返回 tool.<name>.technical", () => {
    const techDesc = localizeToolDescription(
      "engram_create",
      "en",
      undefined,
      "technical",
    );
    // technical 层允许实现术语,且应包含输入/副作用等契约信息
    expect(techDesc).toContain("Input:");
    expect(techDesc).toContain("Side effects:");
  });

  it("三层描述在 en/zh 都齐全(30 个工具)", () => {
    const enDict = en as Readonly<Record<string, string>>;
    const zhDict = zh as Readonly<Record<string, string>>;
    const missing: string[] = [];
    for (const name of TOOL_NAMES) {
      const layers = ["", ".agent", ".technical"] as const;
      for (const suffix of layers) {
        const key = `tool.${name}${suffix}`;
        if (!enDict[key]) missing.push(`en.${key}`);
        if (!zhDict[key]) missing.push(`zh.${key}`);
      }
    }
    expect(
      missing,
      `三层描述缺失:\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it("三层描述各有区分:user 简短、agent 结构化、technical 含契约", () => {
    const userDesc = localizeToolDescription("engram_reinforce", "en");
    const agentDesc = localizeToolDescription(
      "engram_reinforce",
      "en",
      undefined,
      "agent",
    );
    const techDesc = localizeToolDescription(
      "engram_reinforce",
      "en",
      undefined,
      "technical",
    );
    // 三层应该互不相同
    expect(userDesc).not.toBe(agentDesc);
    expect(agentDesc).not.toBe(techDesc);
    expect(userDesc).not.toBe(techDesc);
    // agent 层带 WHEN TO CALL
    expect(agentDesc).toContain("WHEN TO CALL");
    // technical 层带 Input/Side effects
    expect(techDesc).toContain("Input:");
    expect(techDesc).toContain("Side effects:");
  });

  it("agent 层不含禁止术语(FTS / LTP / Hebbian / RPE)", () => {
    const forbidden = [
      "FTS",
      "LTP",
      "Hebbian",
      "RPE",
      "reinforcementScore",
      "effectiveRetrievals",
      "failedUses",
    ];
    const violations: string[] = [];
    for (const name of TOOL_NAMES) {
      // truthScore 仅 engram_get 允许
      const isEngramGet = name === "engram_get";
      for (const lang of ["en", "zh"] as const) {
        const desc = localizeToolDescription(name, lang, undefined, "agent");
        for (const term of forbidden) {
          if (desc.includes(term)) {
            violations.push(`${name}.${lang}: forbidden term "${term}"`);
          }
        }
        if (!isEngramGet && desc.includes("truthScore")) {
          violations.push(`${name}.${lang}: forbidden term "truthScore"`);
        }
      }
    }
    expect(
      violations,
      `agent 层含禁止术语:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("technical 层允许实现术语(应包含 FTS/LTP/Hebbian 等至少一个)", () => {
    const allowed = ["FTS", "LTP", "Hebbian", "RPE"];
    const present = new Set<string>();
    for (const name of TOOL_NAMES) {
      const techDesc = localizeToolDescription(
        name,
        "en",
        undefined,
        "technical",
      );
      for (const term of allowed) {
        if (techDesc.includes(term)) present.add(term);
      }
    }
    // 至少应出现 3 种实现术语(覆盖 search/reinforce/synapse 等)
    expect(present.size).toBeGreaterThanOrEqual(3);
  });

  it("listAgentDescribedTools 覆盖所有 30 个工具", () => {
    const described = new Set(listAgentDescribedTools());
    for (const name of TOOL_NAMES) {
      expect(
        described.has(name),
        `tool "${name}" missing from listAgentDescribedTools`,
      ).toBe(true);
    }
  });
});
