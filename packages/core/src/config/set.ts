/**
 * Programmatic config field setter
 *
 * 给 `co-engram config set <key> <value>` 提供 schema 驱动的写入逻辑：
 *   1. 用 {@link CONFIG_KEY_CATALOG} 校验 dotted key path
 *   2. 把 raw string 值按声明类型 coerce（boolean / number / object / string）
 *   3. 返回新 config 对象（不写盘——写盘由调用方用 writeTeamMemoryConfig）
 *
 * 失败模式（均抛 EngramToolError）：
 *   - VALIDATION：unknown key / type mismatch / 值不符合声明类型
 *   - CONFIG：intermediate path 缺失（config 不完整，需先 init）
 *
 * @module @co-engram/core/config
 */

import type { TeamMemoryConfig } from "./types.js";
import {
  CONFIG_KEY_CATALOG,
  getConfigKeyMeta,
  type ConfigKeyMeta,
} from "./keys.js";
import { validationError, configError } from "../tools/error-schema.js";

export interface ConfigSetResult {
  readonly key: string;
  readonly type: ConfigKeyMeta["type"];
  readonly previousValue: unknown;
  readonly newValue: unknown;
  readonly deprecated: boolean;
  readonly deprecatedReason?: string;
}

/**
 * 把 raw string 解析为声明类型的值。
 *
 * - boolean：'true' | 'false'（大小写不敏感）
 * - number：Number(rawValue)，要求 isFinite
 * - object：JSON.parse，要求解析结果为 object/array
 * - string：原样返回
 *
 * 解析失败抛 VALIDATION EngramToolError。
 */
export function coerceValue(
  type: ConfigKeyMeta["type"],
  rawValue: string,
): unknown {
  switch (type) {
    case "boolean": {
      const lower = rawValue.toLowerCase();
      if (lower === "true") return true;
      if (lower === "false") return false;
      throw validationError(
        `expected boolean for type='${type}', got '${rawValue}'`,
        {
          suggestion: "Boolean values: true / false (case-insensitive)",
          resourceId: rawValue,
        },
      );
    }
    case "number": {
      const n = Number(rawValue);
      if (!Number.isFinite(n)) {
        throw validationError(
          `expected number, got '${rawValue}'`,
          {
            suggestion: "Use numeric syntax: 42, 0.5, -1, 1e3",
            resourceId: rawValue,
          },
        );
      }
      return n;
    }
    case "object": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawValue);
      } catch (err) {
        throw validationError(
          `invalid JSON for type='object': ${
            err instanceof Error ? err.message : String(err)
          }`,
          {
            suggestion:
              'Use JSON syntax: \'{"key":"value"}\' or \'[1,2,3]\'',
            resourceId: rawValue,
          },
        );
      }
      if (parsed === null || typeof parsed !== "object") {
        throw validationError(
          `expected JSON object/array, got ${typeof parsed}`,
          {
            suggestion:
              'Use JSON syntax: \'{"key":"value"}\' or \'[1,2,3]\'',
            resourceId: rawValue,
          },
        );
      }
      return parsed;
    }
    case "string":
    default:
      return rawValue;
  }
}

/**
 * 在可变 target 上按 dotted path 写入值。
 *
 * 若 intermediate path 段不存在或不是 object：
 *   - undefined / null → 自动创建空对象（让 `config set necessityLlm.apiKey xxx` 无需预先 init necessityLlm）
 *   - 已存在但非 object → 抛 CONFIG 错误（如对 `language.foo.bar`，language 是 string）
 */
function setDottedPath(
  target: Record<string, unknown>,
  dottedKey: string,
  value: unknown,
): void {
  const parts = dottedKey.split(".");
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const next = cursor[part];
    if (next === undefined || next === null) {
      // 自动创建 intermediate object
      const created: Record<string, unknown> = {};
      cursor[part] = created;
      cursor = created;
    } else if (typeof next === "object") {
      cursor = next as Record<string, unknown>;
    } else {
      // 已存在但不是 object —— schema 设计错误，抛 CONFIG
      throw configError(
        `config.${parts.slice(0, i + 1).join(".")}`,
        `Intermediate path conflicts with existing non-object value (type=${typeof next}). The key path '${dottedKey}' is not writable.`,
      );
    }
  }
  const leaf = parts[parts.length - 1]!;
  cursor[leaf] = value;
}

/**
 * 按 dotted path 读取值（任意 intermediate 缺失返回 undefined）。
 */
function readDottedPath(
  source: Readonly<Record<string, unknown>>,
  dottedKey: string,
): unknown {
  const parts = dottedKey.split(".");
  let cursor: unknown = source;
  for (const part of parts) {
    if (cursor === null || cursor === undefined || typeof cursor !== "object") {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/**
 * 设置 config 的某个字段（不写盘）。
 *
 * @example
 *   const { config: next, result } = setConfigField(current, "language", "zh");
 *   const { config: next2 } = setConfigField(current, "audit.rotation.retentionDays", "180");
 *
 * @throws EngramToolError VALIDATION | CONFIG
 */
export function setConfigField(
  config: Readonly<TeamMemoryConfig>,
  dottedKey: string,
  rawValue: string,
): { config: TeamMemoryConfig; result: ConfigSetResult } {
  const meta = getConfigKeyMeta(dottedKey);
  if (!meta) {
    const validKeys = Object.keys(CONFIG_KEY_CATALOG)
      .filter((k) => !CONFIG_KEY_CATALOG[k]?.deprecated)
      .sort()
      .map((k) => `  ${k.padEnd(40)} ${CONFIG_KEY_CATALOG[k]?.type}`)
      .join("\n");
    throw validationError(
      `Unknown config key: '${dottedKey}'`,
      {
        suggestion: `Valid writable keys (use dotted path):\n${validKeys}`,
        resourceId: dottedKey,
      },
    );
  }

  if (meta.deprecated) {
    throw validationError(
      `Config key '${dottedKey}' is deprecated and cannot be set.`,
      {
        suggestion:
          meta.deprecatedReason ??
          "Use the documented replacement (see config schema docs).",
        resourceId: dottedKey,
      },
    );
  }

  const coerced = coerceValue(meta.type, rawValue);
  const previous = readDottedPath(
    config as unknown as Record<string, unknown>,
    dottedKey,
  );

  // 深拷贝 config 以避免修改入参（config 是 JSON-like，structuredClone 安全）
  const next = structuredClone(
    config as unknown as Record<string, unknown>,
  ) as Record<string, unknown>;
  setDottedPath(next, dottedKey, coerced);

  return {
    config: next as unknown as TeamMemoryConfig,
    result: {
      key: dottedKey,
      type: meta.type,
      previousValue: previous,
      newValue: coerced,
      deprecated: false,
    },
  };
}
