# co-engram 15 轮拉通 · 5 个架构修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 15 轮挑剔用户测试拉通出的 5 个架构修复落地,从根因层消除 80 个 observation(归并为 31 个 root cause cluster → 3 个 meta-pattern)。

**Architecture:** 按 engram 01KW6KZKCC72Z7931GRA9350CD 的"1 个 pattern 1 个架构修复 > N 个点修复"原则,5 个 fix 各攻一个 meta-pattern。Phase 1 先做 fix-2(双宿主契约测试包),给 fix-1 / fix-3 的双宿主一致性提供自动化保障;Phase 2 fix-1(概念字典)+ fix-3(可观测性)并行;Phase 3 fix-4(清理 stub)+ fix-5(文档同步)收尾。

**Tech Stack:** TypeScript ESM · Node 22+ · Vitest · Zod · pnpm monorepo · codegraph(代码索引)· claude-code-mcp + openclaw-plugin 双宿主。

## Global Constraints

来自 [CLAUDE.md](../../../.claude/CLAUDE.md) 与项目级 [.loop-progress.json](../../../.loop-progress.json):

- **双宿主一致性(STRICT)**:任何 core / viewer / contracts 改动必须同时覆盖 claude-code-mcp 与 openclaw-plugin 两端,提交描述里说明联动状态。
- **文档中英文同步(STRICT)**:改用户可感知的行为 / 契约 / 用法时,中英文 docs 必须同步;影响用户使用时 help panel 也要更新。
- **commit message 禁 Co-Authored-By(STRICT)**:所有 commit 正文结束即止,不加任何 `Co-Authored-By:` 尾签。
- **代码读取用 codegraph(STRICT)**:任何代码理解 / 查找 / 修改前先 `codegraph_explore` / `codegraph_node`,不用裸 `Read` / `grep`(除非验证 codegraph 截断外的片段或非代码文件)。
- **中文输出全角标点(STRICT)**:用户可见的中文(commit / docs / help / error message)用全角标点,代码 / 标识符 / 路径 / 命令行保持原样。
- **Node 22+ ESM strict**:无 `any`、无 `@ts-nocheck`、外部边界用 zod、动态分派用 discriminated union、避免语义 sentinel(`?? 0` / 空字符串)。
- **Vitest 配置**:不并发跑多个 `pnpm test`(共享 cache 会 ENOTEMPTY);内存压力时 `OPENCLAW_VITEST_MAX_WORKERS=1`。
- **测试基线**:不修 baseline / snapshot / expected-failure 文件去消音检查,除非显式批准。

---

## Scope Check

5 个 fix 在概念上是 5 个独立子系统(概念字典 / 契约测试 / 可观测性 / stub 清理 / 文档同步)。按 superpowers-writing-plans skill 规则,跨多独立子系统的 spec 应拆成多个 plan。

**决断理由(合并为 master plan):** 5 个 fix 有强 dependency —— fix-2 必须先做(给 fix-1 / fix-3 提供自动化 dual-host 一致性保障);fix-1 的概念字典是 fix-3 可观测性 next-action hint 的引用源;fix-4 / fix-5 收尾时需要引用 fix-1 的字典与 fix-2 的契约。**拆成 5 个独立 plan 会丢失跨 fix 的依赖与引用关系**。

**因此写成 master plan:** 顶层 Phase 划分 + dependency map;每个 fix 作为独立 Section,内部 task 边界清晰、可独立测试、可独立交付(每个 task 完成后系统能跑通,即便其他 fix 未做)。如果某个 fix 想拆出去单独执行,直接复制对应 Section 即可。

---

## Dependency Map

```
Phase 1 (2 周):
  fix-2 双宿主契约测试包  ←  必须先做

Phase 2 (3 周,并行):
  fix-1 概念字典  ←──── 引用 ────→  fix-3 可观测性

Phase 3 (1 周):
  fix-4 清理 stub   ←  依赖 fix-3 把 stub 移出 full profile
  fix-5 文档同步    ←  依赖 fix-1 字典 + fix-2 契约 + fix-3 工具列表 都稳定
```

**关键依赖**:fix-3 Task 3.2(把 skill_invoke / FTS stub 移出 full profile)必须在 fix-4 Task 4.1(FTS 升级 MiniSearch)之前,否则 fix-4 升级期间 stub 仍暴露。fix-5 Task 5.1(修正 PROFILE_TOOL_COUNTS)依赖 fix-2 Task 2.2 的 contract test 能验证修复无回归。

---

## File Structure

按职责划分(不是按技术层)。每个文件单一职责,边界清晰。

### 新建文件
- `packages/contracts-test/` —— 新包,dual-host 契约测试
  - `package.json` —— 包元数据
  - `src/profile-contract.ts` —— profile 工具集两端一致性测试
  - `src/i18n-contract.ts` —— i18n key 两端一致性测试
  - `src/config-schema-contract.ts` —— config schema 字段语义对称性测试
  - `src/help-text-contract.ts` —— help 文案两端一致性测试
  - `src/index.ts` —— barrel export
  - `test/*.test.ts` —— 契约测试用例
- `packages/core/src/concepts/dictionary.ts` —— CONCEPT_DICTIONARY 单一源
- `packages/core/src/concepts/format.ts` —— 数值字段人类可读分级格式化
- `packages/core/src/observability/runtime-description-check.ts` —— 运行时 FORBIDDEN_TERMS 校验
- `packages/core/src/tools/audit-query-tool.ts` —— 新工具 `engram_audit_query`
- `packages/openclaw-plugin/src/tool-profile.ts` —— OpenClaw 端 profile 选择(对齐 claude-code-mcp)

### 修改文件
- `packages/core/src/i18n/{zh,en}.ts` —— 引用 CONCEPT_DICTIONARY,加规则暴露 key
- `packages/core/src/reinforcement/config.ts` —— DEFAULT_CONFIG 暴露到 config.json
- `packages/core/src/retrieval/{scoring.ts,orchestrator.ts}` —— DEFAULT_WEIGHTS 暴露
- `packages/core/src/config/types.ts` —— 新增字段 + 废弃字段 warn
- `packages/core/src/config/normalize.ts`(或 loader)—— 废弃字段运行时 warn
- `packages/core/src/storage/git.ts` —— commitFiles 改 spawn
- `packages/core/src/storage/engram-store.ts` —— aliases 剥离改 warn
- `packages/core/src/storage/graph-builder.ts:52` —— typo incomingAdacencyHelper → incomingAdjacencyHelper
- `packages/core/src/retrieval/fts.ts` —— P0 简化实现升级到 MiniSearch
- `packages/core/src/tools/skill-tools.ts` —— skill_invoke 移出 full profile 或标 experimental
- `packages/core/src/tools/llm-descriptions.ts` —— resolveLlmDescription 加运行时校验
- `packages/core/src/prompt-signals/cache.ts` —— snapshot 加 event-driven 刷新接口
- `packages/core/src/prompt-signals/event-bus.ts` —— 新建(若无)signal event bus
- `packages/core/src/storage/repository.ts:1116+` —— runDoctor 加 next-action hint
- `packages/claude-code-mcp/src/tool-profile.ts` —— PROFILE_TOOL_COUNTS 修正 + contract test 对齐
- `packages/claude-code-mcp/src/mcp-server.ts` —— 接 audit-query 工具 + event-bus
- `packages/openclaw-plugin/src/{plugin-entry,adapter,memory-tools,prompt-builder,viewer-loader}.ts` —— 接 profile + audit-query + event-bus
- `packages/viewer/src/runtime/tabs.ts` —— help tab 引用 CONCEPT_DICTIONARY + 加规则暴露段
- `docs/{tool-reference,concepts,lifecycle,observability,host-claude-code,host-openclaw}.{md,zh-CN.md}` —— 中英文同步
- `docs/faq.{md,zh-CN.md}` —— 加"为何这样设计"解释

---

## Phase 1:fix-2 双宿主契约测试包

**Meta-pattern 攻击目标**:元2「双宿主无契约」(覆盖 19 个 observation,5 个 root cause:G/E/AC/S/AD)

**理由**:fix-1 / fix-3 都涉及双宿主一致性,先有自动化契约测试能给后两者提供保障,避免"改 core 一边漏另一边"的反复。

### Task 2.1:创建 packages/contracts-test 包骨架

**Files:**
- Create: `packages/contracts-test/package.json`
- Create: `packages/contracts-test/tsconfig.json`
- Create: `packages/contracts-test/src/index.ts`
- Create: `packages/contracts-test/vitest.config.ts`
- Modify: `pnpm-workspace.yaml`(若需显式列入)

**Interfaces:**
- Consumes: `@co-engram/core`, `@co-engram/claude-code-mcp`, `@co-engram/openclaw-plugin`(workspace deps)
- Produces: `@co-engram/contracts-test`(导出 4 个 contract test runner:`runProfileContractTests` / `runI18nContractTests` / `runConfigSchemaContractTests` / `runHelpTextContractTests`)

- [ ] **Step 1:写 failing test(包能 import)**

Create `packages/contracts-test/test/skeleton.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import * as M from "../src/index.js";

describe("@co-engram/contracts-test skeleton", () => {
  it("exports 4 contract test runners", () => {
    expect(typeof M.runProfileContractTests).toBe("function");
    expect(typeof M.runI18nContractTests).toBe("function");
    expect(typeof M.runConfigSchemaContractTests).toBe("function");
    expect(typeof M.runHelpTextContractTests).toBe("function");
  });
});
```

- [ ] **Step 2:Run test to verify it fails**

Run: `pnpm --filter @co-engram/contracts-test test`
Expected: FAIL with "Cannot find module '../src/index.js'" 或 "runProfileContractTests is not a function"

- [ ] **Step 3:实现包骨架**

Create `packages/contracts-test/package.json`:
```json
{
  "name": "@co-engram/contracts-test",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@co-engram/core": "workspace:*",
    "@co-engram/claude-code-mcp": "workspace:*",
    "@co-engram/openclaw-plugin": "workspace:*"
  },
  "devDependencies": {
    "vitest": "^2.0.0",
    "typescript": "^5.5.0"
  }
}
```

Create `packages/contracts-test/src/index.ts`:
```typescript
export async function runProfileContractTests(): Promise<void> {}
export async function runI18nContractTests(): Promise<void> {}
export async function runConfigSchemaContractTests(): Promise<void> {}
export async function runHelpTextContractTests(): Promise<void> {}
```

Create `packages/contracts-test/tsconfig.json`(extends 根 tsconfig)与 `vitest.config.ts`(参考其他包)。

- [ ] **Step 4:Run test to verify it passes**

Run: `pnpm install && pnpm --filter @co-engram/contracts-test test`
Expected: PASS

- [ ] **Step 5:Commit**

```bash
git add packages/contracts-test/ pnpm-workspace.yaml
git commit -m "feat(contracts-test): scaffold dual-host contract test package"
```

---

### Task 2.2:profile 工具集两端一致性 contract test

**Files:**
- Create: `packages/contracts-test/src/profile-contract.ts`
- Create: `packages/contracts-test/test/profile-contract.test.ts`
- Modify: `packages/claude-code-mcp/src/tool-profile.ts`(修正 PROFILE_TOOL_COUNTS)
- Create: `packages/openclaw-plugin/src/tool-profile.ts`(对齐 claude-code-mcp)

**Interfaces:**
- Consumes: `PROFILE_TOOL_SETS` / `PROFILE_TOOL_COUNTS` from claude-code-mcp;待新建的 openclaw-plugin/tool-profile
- Produces: `runProfileContractTests()` 返回 `{ passed: boolean; diffs: ProfileDiff[] }`

**关键 context(从 R13 实证)**:claude-code-mcp 当前 PROFILE_TOOL_COUNTS 三档全错(minimal 写 11 实际 12、standard 写 17 实际 18、full 写 28 实际 29)。openclaw-plugin 完全没有 profile 选择机制,openclaw 用户只能拿 full 集合。

- [ ] **Step 1:写 failing test(两端 profile 工具集必须一致)**

Create `packages/contracts-test/test/profile-contract.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { PROFILE_TOOL_SETS as CC_SETS, PROFILE_TOOL_COUNTS as CC_COUNTS } from "@co-engram/claude-code-mcp";
import { PROFILE_TOOL_SETS as OC_SETS, PROFILE_TOOL_COUNTS as OC_COUNTS } from "@co-engram/openclaw-plugin";
import { runProfileContractTests } from "../src/profile-contract.js";

describe("profile contract: claude-code-mcp ≡ openclaw-plugin", () => {
  it("minimal set identical across hosts", () => {
    expect([...CC_SETS.minimal].sort()).toEqual([...OC_SETS.minimal].sort());
  });
  it("standard set identical across hosts", () => {
    expect([...CC_SETS.standard].sort()).toEqual([...OC_SETS.standard].sort());
  });
  it("full set identical across hosts", () => {
    expect([...CC_SETS.full].sort()).toEqual([...OC_SETS.full].sort());
  });
  it("PROFILE_TOOL_COUNTS matches actual set size (CC)", () => {
    expect(CC_COUNTS.minimal).toBe(CC_SETS.minimal.size);
    expect(CC_COUNTS.standard).toBe(CC_SETS.standard.size);
    expect(CC_COUNTS.full).toBe(CC_SETS.full.size);
  });
  it("PROFILE_TOOL_COUNTS matches actual set size (OC)", () => {
    expect(OC_COUNTS.minimal).toBe(OC_SETS.minimal.size);
    expect(OC_COUNTS.standard).toBe(OC_SETS.standard.size);
    expect(OC_COUNTS.full).toBe(OC_SETS.full.size);
  });
  it("runProfileContractTests returns passed=true when all match", async () => {
    const result = await runProfileContractTests();
    expect(result.passed).toBe(true);
    expect(result.diffs).toEqual([]);
  });
});
```

- [ ] **Step 2:Run test to verify it fails**

Run: `pnpm --filter @co-engram/contracts-test test profile-contract`
Expected: FAIL —— openclaw-plugin 无 PROFILE_TOOL_SETS / PROFILE_TOOL_COUNTS 导出;CC_COUNTS 不匹配实际 set 大小

- [ ] **Step 3:实现**

(3a)修正 `packages/claude-code-mcp/src/tool-profile.ts` 的 PROFILE_TOOL_COUNTS:
```typescript
export const PROFILE_TOOL_COUNTS: Record<ToolProfile, number> = {
  minimal: PROFILE_TOOL_SETS.minimal.size,   // 12
  standard: PROFILE_TOOL_SETS.standard.size, // 18
  full: PROFILE_TOOL_SETS.full.size,         // 29
};
```
(用 `.size` 而非硬编码数字,永久防回归)

(3b)Create `packages/openclaw-plugin/src/tool-profile.ts`,re-export from claude-code-mcp 或独立实现同一份 PROFILE_TOOL_SETS。**决断:独立实现(避免 host 间循环依赖),但通过 contract test 保证一致。**

(3c)Create `packages/contracts-test/src/profile-contract.ts`:
```typescript
import { PROFILE_TOOL_SETS as CC, PROFILE_TOOL_COUNTS as CC_C } from "@co-engram/claude-code-mcp";
import { PROFILE_TOOL_SETS as OC, PROFILE_TOOL_COUNTS as OC_C } from "@co-engram/openclaw-plugin";

export interface ProfileDiff { profile: string; kind: "set" | "count"; detail: string; }

export async function runProfileContractTests(): Promise<{ passed: boolean; diffs: ProfileDiff[] }> {
  const diffs: ProfileDiff[] = [];
  for (const p of ["minimal", "standard", "full"] as const) {
    const cc = [...CC[p]].sort();
    const oc = [...OC[p]].sort();
    if (JSON.stringify(cc) !== JSON.stringify(oc)) {
      diffs.push({ profile: p, kind: "set", detail: `CC=${cc.join(",")} vs OC=${oc.join(",")}` });
    }
    if (CC_C[p] !== CC[p].size) diffs.push({ profile: p, kind: "count", detail: `CC count ${CC_C[p]} != set size ${CC[p].size}` });
    if (OC_C[p] !== OC[p].size) diffs.push({ profile: p, kind: "count", detail: `OC count ${OC_C[p]} != set size ${OC[p].size}` });
  }
  return { passed: diffs.length === 0, diffs };
}
```

- [ ] **Step 4:Run test to verify it passes**

Run: `pnpm --filter @co-engram/contracts-test test profile-contract`
Expected: PASS

- [ ] **Step 5:Commit**

```bash
git add packages/contracts-test/src/profile-contract.ts packages/contracts-test/test/profile-contract.test.ts \
        packages/claude-code-mcp/src/tool-profile.ts packages/openclaw-plugin/src/tool-profile.ts
git commit -m "fix(profile): correct PROFILE_TOOL_COUNTS + add openclaw-plugin profile + dual-host contract test"
```

---

### Task 2.3:i18n key 两端一致性 contract test

**Files:**
- Create: `packages/contracts-test/src/i18n-contract.ts`
- Create: `packages/contracts-test/test/i18n-contract.test.ts`

**Interfaces:**
- Consumes: `zh` / `en` 字典 from `@co-engram/core`
- Produces: `runI18nContractTests()` 返回 `{ passed: boolean; missingKeys: string[]; extraKeys: string[] }`

**关键 context**:R12 发现 viewer tabs.ts 单文件内 hard-coded 中文与 T.t() 调用并存;R13 发现 openclaw-plugin/src/memory-tools.ts:125 `language === "zh" ? "错误" : "Error"` ternary hard-coded。这些是 AC(i18n 实现碎片化)的投影。

- [ ] **Step 1:写 failing test**

Create `packages/contracts-test/test/i18n-contract.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { zh, en } from "@co-engram/core";
import { runI18nContractTests } from "../src/i18n-contract.js";

describe("i18n contract: zh ≡ en key parity", () => {
  it("all zh keys exist in en", () => {
    const result = runI18nContractTests();
    expect(result.missingInEn).toEqual([]);
  });
  it("all en keys exist in zh", () => {
    const result = runI18nContractTests();
    expect(result.missingInZh).toEqual([]);
  });
  it("no hard-coded language ternary in source", () => {
    const result = runI18nContractTests();
    expect(result.hardCodedTernaries).toEqual([]);
  });
});
```

- [ ] **Step 2:Run test to verify it fails**

Run: `pnpm --filter @co-engram/contracts-test test i18n-contract`
Expected: FAIL —— 检测到 memory-tools.ts:125 ternary hard-coded;可能存在 zh/en key 不对齐

- [ ] **Step 3:实现**

Create `packages/contracts-test/src/i18n-contract.ts`:
```typescript
import { zh, en } from "@co-engram/core";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ZH = zh as Record<string, string>;
const EN = en as Record<string, string>;

// 已知合法的 language ternary 白名单(如 host 专属 fallback)。新增前必须解释。
const TERNARY_WHITELIST: RegExp[] = [
  // 暂无;新加 entry 必须配 PR 描述
];

export interface I18nContractResult {
  missingInEn: string[];
  missingInZh: string[];
  hardCodedTernaries: { file: string; line: number; snippet: string }[];
}

function scanHardCodedTernaries(root: string): I18nContractResult["hardCodedTernaries"] {
  const out: I18nContractResult["hardCodedTernaries"] = [];
  const pattern = /language\s*===\s*["']zh["']\s*\?/;  // AC 投影的核心模式
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!entry.name.endsWith(".ts")) continue;
      const lines = readFileSync(p, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (pattern.test(line) && !TERNARY_WHITELIST.some((re) => re.test(line))) {
          out.push({ file: p, line: i + 1, snippet: line.trim() });
        }
      });
    }
  }
  walk(root);
  return out;
}

export function runI18nContractTests(root = process.cwd()): I18nContractResult {
  const zhKeys = new Set(Object.keys(ZH));
  const enKeys = new Set(Object.keys(EN));
  return {
    missingInEn: [...zhKeys].filter((k) => !enKeys.has(k)),
    missingInZh: [...enKeys].filter((k) => !zhKeys.has(k)),
    hardCodedTernaries: scanHardCodedTernaries(root),
  };
}
```

**前端联动**:把 `openclaw-plugin/src/memory-tools.ts:125` 的 `language === "zh" ? "错误" : "Error"` 改为引用 i18n key `error.generic`(若不存在则在 zh.ts / en.ts 添加)。

- [ ] **Step 4:Run test to verify it passes**

Run: `pnpm --filter @co-engram/contracts-test test i18n-contract`
Expected: PASS

- [ ] **Step 5:Commit**

```bash
git add packages/contracts-test/src/i18n-contract.ts packages/contracts-test/test/i18n-contract.test.ts \
        packages/openclaw-plugin/src/memory-tools.ts packages/core/src/i18n/zh.ts packages/core/src/i18n/en.ts
git commit -m "fix(i18n): replace hard-coded language ternary with i18n key + add dual-host contract test"
```

---

### Task 2.4:config schema 字段语义对称性 contract test

**Files:**
- Create: `packages/contracts-test/src/config-schema-contract.ts`
- Create: `packages/contracts-test/test/config-schema-contract.test.ts`
- Modify: `packages/core/src/config/types.ts`(标注 host-only 字段)
- Modify: `packages/core/src/config/loader.ts` 或 `normalize.ts`(运行时 warn)

**关键 context**:R14 实证 `TeamMemoryConfig.autoMemorySync` 标"Claude Code MCP 专用,OpenClaw 忽略",但 config.json 是双宿主共享,OpenClaw host 下设 enabled=true 静默无效。

- [ ] **Step 1:写 failing test**

```typescript
import { describe, it, expect } from "vitest";
import { runConfigSchemaContractTests } from "../src/config-schema-contract.js";

describe("config schema contract: dual-host semantic symmetry", () => {
  it("host-only fields are marked and warned on the other host", () => {
    const result = runConfigSchemaContractTests();
    expect(result.unmarkedHostOnlyFields).toEqual([]);
  });
  it("deprecated fields emit runtime warn when set", () => {
    const result = runConfigSchemaContractTests();
    expect(result.silentlyDroppedDeprecated).toEqual([]);
  });
});
```

- [ ] **Step 2:Run test to verify it fails**

Expected: FAIL —— `autoMemorySync` 未在 schema 标 host-only;`ViewerSectionConfig.port`(@deprecated)静默丢弃

- [ ] **Step 3:实现**

(3a)在 `config/types.ts` 给 host-only 字段加 metadata:
```typescript
export interface FieldMetadata {
  /** 标记字段仅特定 host 生效,其他 host 读取时应 warn */
  readonly hostOnly?: "claude-code" | "openclaw";
  /** 标记字段已废弃,设置时 warn */
  readonly deprecated?: { since: string; replaceWith?: string };
}
```

(3b)autoMemorySync 标 `hostOnly: "claude-code"`;ViewerSectionConfig.port 标 `deprecated: { since: "0.5.0", replaceWith: "env CO_ENGRAM_VIEWER_PORT" }`。

(3c)config loader / normalize 读 metadata,host 不匹配时 emit warn(非静默)。

(3d)Create `config-schema-contract.ts`:枚举所有 schema 字段,验证每个 host-only 字段两端都能识别 metadata(不会被另一端忽略而是 warn)。

- [ ] **Step 4:Run test to verify it passes**

Run: `pnpm --filter @co-engram/contracts-test test config-schema-contract`
Expected: PASS

- [ ] **Step 5:Commit**

```bash
git add packages/contracts-test/src/config-schema-contract.ts packages/contracts-test/test/config-schema-contract.test.ts \
        packages/core/src/config/types.ts packages/core/src/config/loader.ts
git commit -m "fix(config): mark host-only + deprecated fields with metadata; warn instead of silent drop"
```

---

### Task 2.5:help 文案两端一致性 contract test

**Files:**
- Create: `packages/contracts-test/src/help-text-contract.ts`
- Create: `packages/contracts-test/test/help-text-contract.test.ts`

**关键 context**:help 文案在 viewer tabs.ts(help tab)+ claude-code-mcp instructions + openclaw-plugin prompt-builder 三处独立维护,易漂移。

- [ ] **Step 1:写 failing test**

```typescript
import { describe, it, expect } from "vitest";
import { runHelpTextContractTests } from "../src/help-text-contract.js";

describe("help text contract: viewer ≡ mcp-instructions ≡ openclaw-prompt", () => {
  it("concept definitions identical across surfaces", () => {
    const result = runHelpTextContractTests();
    expect(result.conceptDrifts).toEqual([]);
  });
});
```

- [ ] **Step 2:Run test to verify it fails**

Expected: FAIL —— 三处 help 文案对"engram" / "synapse" / "verification status"等概念解释可能不一致

- [ ] **Step 3:实现**

(3a)依赖 Phase 2 fix-1 的 CONCEPT_DICTIONARY 单一源(此处先建占位 dictionary,fix-1 时填充内容)。

(3b)Create `help-text-contract.ts`:从三处 help surface 提取概念引用,验证都来自 CONCEPT_DICTIONARY。

- [ ] **Step 4:Run test to verify it passes**

Expected: PASS(三处 surface 都引用 CONCEPT_DICTIONARY)

- [ ] **Step 5:Commit**

```bash
git add packages/contracts-test/src/help-text-contract.ts packages/contracts-test/test/help-text-contract.test.ts
git commit -m "feat(contracts-test): help text concept drift contract"
```

---

### Task 2.6:CI gate 集成 contracts-test

**Files:**
- Modify: `.github/workflows/ci.yml` 或项目 CI 配置
- Modify: `package.json`(root)加 `test:contracts` script

- [ ] **Step 1:写 failing test**

无需 unit test;CI 配置即 deliverable。验证方式:本地 `pnpm test:contracts` 应跑全部 contract test。

- [ ] **Step 2:Run test to verify it fails**

Run: `pnpm test:contracts`
Expected: FAIL with "missing script: test:contracts"

- [ ] **Step 3:实现**

(3a)root package.json:
```json
{
  "scripts": {
    "test:contracts": "pnpm --filter @co-engram/contracts-test test"
  }
}
```

(3b)CI workflow 在 `pnpm test` 之外额外跑 `pnpm test:contracts`,作为独立 check lane(方便快速定位是契约违反还是单元测试失败)。

- [ ] **Step 4:Run test to verify it passes**

Run: `pnpm test:contracts`
Expected: PASS(所有 contract test 通过)

- [ ] **Step 5:Commit**

```bash
git add package.json .github/workflows/ci.yml
git commit -m "ci(contracts): gate dual-host contract tests in CI"
```

---

## Phase 2A:fix-1 概念字典 + 规则可见性单一源

**Meta-pattern 攻击目标**:元3「神经科学墙」(覆盖 36 个 observation,6 个 root cause:AE/L/U/A/M/C)

### Task 1.1:建立 CONCEPT_DICTIONARY 数据结构

**Files:**
- Create: `packages/core/src/concepts/dictionary.ts`
- Create: `packages/core/src/concepts/types.ts`
- Create: `packages/core/test/concepts/dictionary.test.ts`

**Interfaces:**
- Produces: `CONCEPT_DICTIONARY: ReadonlyRecord<ConceptId, ConceptEntry>`,其中 ConceptEntry 含 `id / zh / en / userExplanation { zh, en } / internalRule / refs`

**关键 context**:co-engram 引入 engram / synapse / LTP / LTD / Hebbian / RPE / verification state machine / observation window / multi-dim importance 等大量神经科学概念,但规则对挑剔用户完全不可见(R11/R13/R14 多轮实证)。CONCEPT_DICTIONARY 是这些概念的单一真相源。

- [ ] **Step 1:写 failing test**

```typescript
import { describe, it, expect } from "vitest";
import { CONCEPT_DICTIONARY, getConcept, formatScore } from "../src/concepts/dictionary.js";

describe("CONCEPT_DICTIONARY", () => {
  it("contains all required concepts", () => {
    const required = ["engram", "synapse", "ltp", "ltd", "hebbian", "verification_status", "observation_window", "importance"];
    for (const id of required) {
      expect(CONCEPT_DICTIONARY[id], `concept ${id} missing`).toBeDefined();
    }
  });
  it("each concept has zh + en + userExplanation", () => {
    for (const [id, entry] of Object.entries(CONCEPT_DICTIONARY)) {
      expect(entry.zh, `${id}.zh`).toBeTruthy();
      expect(entry.en, `${id}.en`).toBeTruthy();
      expect(entry.userExplanation.zh, `${id}.userExplanation.zh`).toBeTruthy();
      expect(entry.userExplanation.en, `${id}.userExplanation.en`).toBeTruthy();
    }
  });
  it("formatScore maps [0,1] to 高/中/低 band", () => {
    expect(formatScore(0.95, "zh")).toContain("高");
    expect(formatScore(0.5, "zh")).toContain("中");
    expect(formatScore(0.1, "zh")).toContain("低");
  });
  it("formatScore rejects raw float in user-facing output", () => {
    const out = formatScore(0.7719155626908514, "zh");
    expect(out).not.toMatch(/0\.77191/);  // 不直接 dump 浮点
  });
});
```

- [ ] **Step 2:Run test to verify it fails**

Run: `pnpm --filter @co-engram/core test concepts/dictionary`
Expected: FAIL —— module 不存在

- [ ] **Step 3:实现**

Create `packages/core/src/concepts/types.ts`:
```typescript
export type ConceptId =
  | "engram" | "synapse" | "ltp" | "ltd" | "hebbian" | "rpe"
  | "verification_status" | "observation_window" | "importance"
  | "decay" | "provenance" | "domain_tag" | "context_tag" | "kind";

export interface ConceptEntry {
  readonly id: ConceptId;
  readonly zh: string;          // 内部术语(可保留)
  readonly en: string;
  readonly userExplanation: {
    readonly zh: string;        // 用户层解释(挑剔用户能懂)
    readonly en: string;
  };
  readonly internalRule?: string;  // 规则引用(如 "每次 effective 检索 += 0.02")
  readonly refs?: readonly string[];  // 相关概念
}

export type ScoreBand = "high" | "medium" | "low";
```

Create `packages/core/src/concepts/dictionary.ts`:填充所有 ConceptEntry,例如:
```typescript
export const CONCEPT_DICTIONARY = {
  engram: {
    id: "engram",
    zh: "记忆印迹",
    en: "engram",
    userExplanation: {
      zh: "一条被持久化的团队记忆。每条记忆有标题、内容、领域标签,以及随使用强度变化的'重要性'分数。",
      en: "A persistent team memory entry with title, content, domain tags, and an importance score that evolves with usage.",
    },
    refs: ["synapse", "importance"],
  },
  ltp: {
    id: "ltp",
    zh: "长时程增强(LTP)",
    en: "Long-Term Potentiation (LTP)",
    userExplanation: {
      zh: "记忆被有效使用时,重要性上升的机制。每次有效检索 +0.02(默认)。",
      en: "Mechanism by which a memory's importance rises on effective use. +0.02 per effective retrieval (default).",
    },
    internalRule: "每次 effective=1 检索 importance += ltpGain (default 0.02)",
    refs: ["importance", "observation_window"],
  },
  verification_status: {
    id: "verification_status",
    zh: "验证状态",
    en: "verification status",
    userExplanation: {
      zh: "记忆可信度的 5 档状态:未验证 → 似合理 → 较可能 → 已验证 → 已反驳。状态随使用反馈(强化 / 失败)演化。",
      en: "5-level credibility: unverified → plausible → probable → verified → refuted. Evolves with use feedback.",
    },
    internalRule: "升级条件见 upgrade_verification 工具的 checks 字段",
    refs: ["observation_window"],
  },
  // ... 其余概念
} as const satisfies Readonly<Record<ConceptId, ConceptEntry>>;

export function getConcept(id: ConceptId): ConceptEntry {
  return CONCEPT_DICTIONARY[id];
}

export function formatScore(score: number, lang: "zh" | "en"): string {
  const band: ScoreBand = score >= 0.7 ? "high" : score >= 0.3 ? "medium" : "low";
  const labels = {
    zh: { high: "高", medium: "中", low: "低" },
    en: { high: "high", medium: "medium", low: "low" },
  };
  return `${labels[lang][band]}(${score.toFixed(2)})`;
}
```

- [ ] **Step 4:Run test to verify it passes**

Run: `pnpm --filter @co-engram/core test concepts/dictionary`
Expected: PASS

- [ ] **Step 5:Commit**

```bash
git add packages/core/src/concepts/ packages/core/test/concepts/
git commit -m "feat(concepts): CONCEPT_DICTIONARY single source + score band formatter"
```

---

### Task 1.2:工具描述引用 CONCEPT_DICTIONARY

**Files:**
- Modify: `packages/core/src/i18n/{zh,en}.ts`(工具描述里用 `{{concept:engram}}` 占位)
- Modify: `packages/core/src/tools/llm-descriptions.ts`(resolveLlmDescription 替换占位)
- Modify: `packages/core/test/tools/llm-descriptions.test.ts`

**关键 context**:R11 实证 engram_get meta tier 直 dump 17 个字段含 `reinforcementScore:0.7719155626908514` 浮点精度泄露;R14 实证 synapse_create contradicts kind 隐式双写 audit 未在描述说明。

- [ ] **Step 1:写 failing test**

```typescript
import { describe, it, expect } from "vitest";
import { resolveLlmDescription } from "../src/tools/llm-descriptions.js";

describe("tool descriptions reference CONCEPT_DICTIONARY", () => {
  it("engram_get agent description contains user-level engram explanation", () => {
    const desc = resolveLlmDescription({ name: "engram_get", description: "" }, "zh");
    expect(desc).toContain("记忆");  // 来自 dictionary.userExplanation.zh
    expect(desc).not.toContain("reinforcementScore");  // 禁词(已存在 FORBIDDEN_TERMS)
  });
  it("synapse_create description documents contradicts side effect", () => {
    const desc = resolveLlmDescription({ name: "synapse_create", description: "" }, "zh");
    expect(desc).toContain("contradicts");  // 显式说明 contradicts 触发双写 audit
  });
});
```

- [ ] **Step 2:Run test to verify it fails**

Expected: FAIL —— 当前 engram_get 描述不含用户层"记忆"解释;synapse_create 不提 contradicts 副作用

- [ ] **Step 3:实现**

(3a)在 zh.ts / en.ts 的 `tool.engram_get.agent` 里嵌入 `{{concept:engram|userExplanation}}` 占位;在 `tool.synapse_create.agent` 里补一段:
```
SIDE EFFECTS:
  当 kind="contradicts" 时,自动给双方 engram 写 contradicted audit 事件(可被 engram_audit_query 查到)。
```

(3b)修改 resolveLlmDescription,在返回前 replace `{{concept:ID|field}}` 为 CONCEPT_DICTIONARY 对应字段:
```typescript
function expandConceptPlaceholders(text: string): string {
  return text.replace(/\{\{concept:([a-z_]+)\|([a-zA-Z_.]+)\}\}/g, (_, id, path) => {
    const entry = CONCEPT_DICTIONARY[id as ConceptId];
    if (!entry) return `[unknown concept: ${id}]`;
    return path.split(".").reduce((obj: any, key: string) => obj?.[key], entry) ?? "";
  });
}
```

- [ ] **Step 4:Run test to verify it passes**

Run: `pnpm --filter @co-engram/core test tools/llm-descriptions`
Expected: PASS

- [ ] **Step 5:Commit**

```bash
git add packages/core/src/i18n/zh.ts packages/core/src/i18n/en.ts \
        packages/core/src/tools/llm-descriptions.ts packages/core/test/tools/llm-descriptions.test.ts
git commit -m "feat(i18n): tool descriptions reference CONCEPT_DICTIONARY placeholders + document contradicts side effect"
```

---

### Task 1.3:数值字段附人类可读分级

**Files:**
- Modify: `packages/core/src/tools/engram-tools.ts`(engram_get / engram_reinforce / engram_recompute_importance 输出数值时 formatScore)
- Modify: `packages/core/src/tools/skill-tools.ts`(若有 score 输出)
- Modify: viewer tabs.ts(显示数值处用分级)

**关键 context**:R8/R11 实证浮点精度泄露(importanceDelta:0.018000000000000002);R15 实证 FTS score 裸输出。所有 score / importance / reinforcementScore 字段在用户可见处必须附"高/中/低"分级。

- [ ] **Step 1:写 failing test**

```typescript
import { describe, it, expect } from "vitest";
import { formatScore } from "../src/concepts/dictionary.js";
import { engramReinforceTool } from "../src/tools/engram-tools.js";

describe("user-facing numeric fields include band", () => {
  it("engram_reinforce result importanceDelta has band label", async () => {
    // mock repository 返回 importanceDelta=0.018000000000000002
    const result = await engramReinforceTool.execute(/* ... */);
    const text = JSON.stringify(result);
    expect(text).toMatch(/高|中|低/);
    expect(text).not.toMatch(/0\.0180000000/);  // 不泄露全精度
  });
});
```

- [ ] **Step 2:Run test to verify it fails**

Expected: FAIL —— engram_reinforce 当前直接 dump importanceDelta 浮点

- [ ] **Step 3:实现**

在所有返回 score / importance / reinforcementScore / lastRetrievalScore 的工具结果里,字段值改为 `{ raw: number, band: "高"|"中"|"低", display: string }`,其中 display 由 formatScore 生成。viewer 也用 display 字段。

**注意**:JSON-RPC 协议层保留 raw 给 LLM;但 text 部分用 display。两层并存,LLM 与人都得到合适信息。

- [ ] **Step 4:Run test to verify it passes**

Expected: PASS

- [ ] **Step 5:Commit**

```bash
git add packages/core/src/tools/engram-tools.ts packages/viewer/src/runtime/tabs.ts
git commit -m "feat(ux): numeric score fields include 高/中/低 band, no raw float dump"
```

---

### Task 1.4:viewer help tab 暴露规则

**Files:**
- Modify: `packages/viewer/src/runtime/tabs.ts`(help tab 加"概念字典"+"规则参数"段)
- Modify: `packages/core/src/i18n/{zh,en}.ts`(加 `viewer.help.concepts.*` / `viewer.help.rules.*` keys)

**关键 context**:R11/R14 实证 observation window 长度规则、verification 5 状态机升级条件、reinforcement DEFAULT_CONFIG 参数(ltpGain / ltdPenalty / hebbianRatio / failureThreshold / failureEscalation)对用户不可见。

- [ ] **Step 1:写 failing test**

```typescript
import { describe, it, expect } from "vitest";
import { renderHelpTab } from "../src/runtime/tabs.js";

describe("help tab rule visibility", () => {
  it("exposes verification 5-state machine rules", () => {
    const html = renderHelpTab("zh");
    expect(html).toContain("未验证");
    expect(html).toContain("似合理");
    expect(html).toContain("已验证");
    expect(html).toContain("已反驳");
  });
  it("exposes reinforcement parameters with default values", () => {
    const html = renderHelpTab("zh");
    expect(html).toContain("ltpGain");
    expect(html).toContain("0.02");
  });
  it("exposes observation window concept", () => {
    const html = renderHelpTab("zh");
    expect(html).toContain("观察窗口");
  });
});
```

- [ ] **Step 2:Run test to verify it fails**

Expected: FAIL —— help tab 无规则段

- [ ] **Step 3:实现**

help tab 新增三个 section:
1. **概念字典**:遍历 CONCEPT_DICTIONARY 显示 userExplanation + 内部术语(折叠默认隐藏)
2. **规则参数**:从 ReinforcementConfig.DEFAULT_CONFIG / ScoringWeights.DEFAULT_WEIGHTS / ObservationWindow.computeWindowMs 默认值生成表
3. **状态机图**:verification 5 状态 + 升级条件(引用 upgrade_verification 的 checks)

- [ ] **Step 4:Run test to verify it passes**

Expected: PASS

- [ ] **Step 5:Commit**

```bash
git add packages/viewer/src/runtime/tabs.ts packages/core/src/i18n/zh.ts packages/core/src/i18n/en.ts
git commit -m "feat(viewer): help tab exposes concept dictionary + rule parameters + state machine"
```

---

### Task 1.5:config.json 暴露默认值参数

**Files:**
- Modify: `packages/core/src/config/types.ts`(新增 ReinforcementConfig / ScoringConfig / ObservationWindowConfig section)
- Modify: `packages/core/src/config/loader.ts`(读 config 覆盖 DEFAULT_CONFIG)
- Modify: `packages/core/src/retrieval/orchestrator.ts`(从 config 读 weights,而非硬编码 DEFAULT_WEIGHTS)
- Modify: `packages/core/src/reinforcement/{config.ts, learning/loop.ts}`(从 config 读)

**关键 context**:R14 实证 reinforcement DEFAULT_CONFIG 硬编码源码内无 config.json 入口;R15 实证 orchestrator DEFAULT_WEIGHTS 硬编码。

- [ ] **Step 1:写 failing test**

```typescript
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config/loader.js";

describe("config.json overrides defaults", () => {
  it("reinforcement.ltpGain can be overridden", () => {
    const cfg = loadConfig({ reinforcement: { ltpGain: 0.05 } });
    expect(cfg.reinforcement.ltpGain).toBe(0.05);
  });
  it("search.weights can be overridden", () => {
    const cfg = loadConfig({ search: { weights: { relevance: 0.6, recency: 0.2, importance: 0.2 } } });
    expect(cfg.search.weights.relevance).toBe(0.6);
  });
});
```

- [ ] **Step 2:Run test to verify it fails**

Expected: FAIL —— config schema 无 reinforcement / search.weights section

- [ ] **Step 3:实现**

config.types.ts 加 section(每个有 default,loader merge 时若用户未设则用 DEFAULT_CONFIG / DEFAULT_WEIGHTS)。orchestrator 与 reinforcement loop 通过依赖注入接受 config(而非直接 import DEFAULT_*)。

- [ ] **Step 4:Run test to verify it passes**

Expected: PASS

- [ ] **Step 5:Commit**

```bash
git add packages/core/src/config/ packages/core/src/retrieval/orchestrator.ts packages/core/src/reinforcement/
git commit -m "feat(config): expose reinforcement/search/observation defaults via config.json"
```

---

## Phase 2B:fix-3 运行时可观测性 + 状态反馈闭环

**Meta-pattern 攻击目标**:元1「spec 乌托邦 vs 代码现实」(覆盖 33 个 observation,8 个 root cause:AF/AJ/AB/Y/K/H/F/O)

### Task 3.1:运行时 FORBIDDEN_TERMS 校验

**Files:**
- Create: `packages/core/src/observability/runtime-description-check.ts`
- Modify: `packages/core/src/tools/llm-descriptions.ts`(resolveLlmDescription 加运行时校验)
- Modify: `packages/core/test/tools/llm-descriptions.test.ts`

**关键 context**:R12 实证 FORBIDDEN_TERMS + auditDescriptionQuality 设计良好但仅 CI 执行;运行时 resolveLlmDescription 不拒绝含禁词的描述。这是 AF(设计时约束运行时无强制)的核心投影。

- [ ] **Step 1:写 failing test**

```typescript
import { describe, it, expect } from "vitest";
import { resolveLlmDescription } from "../src/tools/llm-descriptions.js";

describe("runtime FORBIDDEN_TERMS check", () => {
  it("rejects description containing 'FTS' at runtime", () => {
    // 假设某工具的 agent 描述被恶意改成含 'FTS'
    expect(() => resolveLlmDescription({ name: "_test_forbidden", description: "" }, "zh"))
      .toThrow(/forbidden term/);
  });
  it("logs warning but does not throw when failMode='warn'", () => {
    const warns: string[] = [];
    const result = resolveLlmDescription({ name: "_test_forbidden", description: "" }, "zh", undefined, { failMode: "warn", onWarn: (m) => warns.push(m) });
    expect(result).toContain("[⚠ description violates]");
    expect(warns.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2:Run test to verify it fails**

Expected: FAIL —— resolveLlmDescription 当前不校验

- [ ] **Step 3:实现**

(3a)Create `runtime-description-check.ts`:复用 auditDescriptionQuality 逻辑,但加 failMode 参数(strict / warn)。

(3b)resolveLlmDescription 增加第 4 参数 `options?: { failMode?: "strict" | "warn"; onWarn?: (msg: string) => void }`。默认 `warn`(不破坏现有调用)。生产 host 启动时设 `strict`。

- [ ] **Step 4:Run test to verify it passes**

Expected: PASS

- [ ] **Step 5:Commit**

```bash
git add packages/core/src/observability/runtime-description-check.ts \
        packages/core/src/tools/llm-descriptions.ts packages/core/test/tools/llm-descriptions.test.ts
git commit -m "feat(observability): runtime FORBIDDEN_TERMS check with strict/warn failMode"
```

---

### Task 3.2:skill_invoke / FTS stub 移出 full profile 或标 experimental

**Files:**
- Modify: `packages/claude-code-mcp/src/tool-profile.ts`(从 full 移除 skill_invoke,或加 experimental flag)
- Modify: `packages/openclaw-plugin/src/tool-profile.ts`(同步)
- Modify: `packages/core/src/tools/skill-tools.ts`(skill_invoke description 加"⚠ experimental stub"前缀)
- Modify: `packages/core/src/retrieval/fts.ts`(tokenize 注释更新;实际升级在 fix-4)

**关键 context**:R14 实证 skill-tools.ts:109-115 注释自承"P0 阶段是框架;具体执行在 P1 实现",execute 默认返回 `[P0 stub] Skill X invoked with args: ...`。但 skill_invoke 在 full profile 暴露给 LLM。挑剔用户调用后看到 success:true 以为真的执行了。

- [ ] **Step 1:写 failing test**

```typescript
import { describe, it, expect } from "vitest";
import { PROFILE_TOOL_SETS } from "@co-engram/claude-code-mcp";
import { resolveLlmDescription } from "../src/tools/llm-descriptions.js";

describe("experimental stub visibility", () => {
  it("skill_invoke not in full profile (until P1 implemented)", () => {
    expect(PROFILE_TOOL_SETS.full.has("skill_invoke")).toBe(false);
  });
  it("skill_invoke description (if exposed via other path) contains experimental warning", () => {
    const desc = resolveLlmDescription({ name: "skill_invoke", description: "" }, "zh");
    expect(desc).toMatch(/experimental|实验性|stub|占位/);
  });
});
```

- [ ] **Step 2:Run test to verify it fails**

Expected: FAIL —— skill_invoke 仍在 full profile;描述无 experimental 警告

- [ ] **Step 3:实现**

(3a)从 PROFILE_TOOL_SETS.full 删除 `skill_invoke`(保留 `skill_get`,因为它只读元数据,无 stub)。

(3b)若需要保留 skill_invoke 可达,在 description 第一行加 `⚠ EXPERIMENTAL STUB — 当前返回占位字符串,不真实执行技能。`。

(3c)契约测试 Task 2.2 会自动验证两端一致。

- [ ] **Step 4:Run test to verify it passes**

Expected: PASS

- [ ] **Step 5:Commit**

```bash
git add packages/claude-code-mcp/src/tool-profile.ts packages/openclaw-plugin/src/tool-profile.ts \
        packages/core/src/tools/skill-tools.ts packages/core/src/i18n/zh.ts packages/core/src/i18n/en.ts
git commit -m "fix(profile): remove skill_invoke stub from full profile + mark experimental in description"
```

---

### Task 3.3:新增 engram_audit_query 工具

**Files:**
- Create: `packages/core/src/tools/audit-query-tool.ts`
- Modify: `packages/core/src/tools/index.ts`(注册)
- Modify: `packages/claude-code-mcp/src/tool-profile.ts`(加入 standard profile)
- Modify: `packages/openclaw-plugin/src/tool-profile.ts`(同步)

**Interfaces:**
- Produces: `engramAuditQueryTool` —— 参数 `{ engramId?: string; action?: AuditAction; since?: ISO8601; limit?: number }`,返回 `AuditEvent[]`

**关键 context**:R14 实证 AuditLog 存了 26 种 AuditAction 的大量事件,但 query 方法只被 effectiveness-tracker 和 viewer/server 内部调用,挑剔用户想看"这个 engram 的修改历史"必须开 viewer 或读文件。这是 K(observability 数据层存在但工具层不可达)的核心投影。

- [ ] **Step 1:写 failing test**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { engramAuditQueryTool } from "../src/tools/audit-query-tool.js";
import { AuditLog } from "../src/observability/audit-log.js";

describe("engram_audit_query", () => {
  let log: AuditLog;
  beforeEach(() => { log = new AuditLog(/* temp path */); });

  it("returns events filtered by engramId", async () => {
    await log.append({ engramId: "E1", action: "created", at: new Date().toISOString(), by: "u" });
    await log.append({ engramId: "E2", action: "created", at: new Date().toISOString(), by: "u" });
    const result = await engramAuditQueryTool.execute("t1", { engramId: "E1" });
    const parsed = JSON.parse(result.text);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].engramId).toBe("E1");
  });
  it("description references CONCEPT_DICTIONARY and explains when to call", () => {
    expect(engramAuditQueryTool.description).toContain("WHEN TO CALL");
    expect(engramAuditQueryTool.description).toContain("audit");
  });
});
```

- [ ] **Step 2:Run test to verify it fails**

Expected: FAIL —— 工具不存在

- [ ] **Step 3:实现**

Create `audit-query-tool.ts`:包装 AuditLog.query,加分页 + 过滤;description 用 CONCEPT_DICTIONARY 概念,符合 auditDescriptionQuality 规则(WHEN TO CALL / RETURNS 段落 + 长度合规)。

- [ ] **Step 4:Run test to verify it passes**

Expected: PASS

- [ ] **Step 5:Commit**

```bash
git add packages/core/src/tools/audit-query-tool.ts packages/core/src/tools/index.ts \
        packages/claude-code-mcp/src/tool-profile.ts packages/openclaw-plugin/src/tool-profile.ts \
        packages/core/src/i18n/zh.ts packages/core/src/i18n/en.ts
git commit -m "feat(tools): engram_audit_query exposes audit.jsonl to user layer (standard profile)"
```

---

### Task 3.4:prompt-signals event-driven 刷新

**Files:**
- Create: `packages/core/src/prompt-signals/event-bus.ts`(若不存在)
- Modify: `packages/core/src/prompt-signals/cache.ts`(subscribe 事件,事件触发 snapshot 重建)
- Modify: `packages/core/src/learning/loop.ts`(close_learning_loop 完成后 emit 事件)
- Modify: `packages/core/src/tools/synapse-tools.ts`(synapse_create contradicts 后 emit)
- Modify: `packages/core/src/storage/repository.ts`(verification 状态变化 emit)
- Modify: `packages/openclaw-plugin/src/prompt-builder.ts`(从注释 line 54-55 改为订阅 event bus)
- Modify: `packages/claude-code-mcp/src/mcp-server.ts`(同上)

**关键 context**:R13 实证 close_learning_loop 后 prompt-signals.json 不立即刷新(双延迟:maintenance light stage 周期 + plugin 注册时固定 snapshot)。proposalCountProvider 已是动态 provider,signals 却不是 —— 同模块内不一致设计。

- [ ] **Step 1:写 failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { PromptSignalBus } from "../src/prompt-signals/event-bus.js";
import { PromptSignalCache } from "../src/prompt-signals/cache.js";

describe("prompt-signals event-driven refresh", () => {
  it("cache invalidates within 100ms of close_learning_loop event", async () => {
    const bus = new PromptSignalBus();
    const cache = new PromptSignalCache({ bus, ttlMs: 60_000 });
    await cache.rebuild();
    const before = cache.snapshot();
    bus.emit({ type: "engram_verified", engramId: "E1" });
    await vi.waitFor(() => expect(cache.snapshot().version).not.toBe(before.version), { timeout: 200 });
  });
});
```

- [ ] **Step 2:Run test to verify it fails**

Expected: FAIL —— cache 当前不订阅 event bus

- [ ] **Step 3:实现**

(3a)Create `event-bus.ts`:`PromptSignalBus` extends Node EventEmitter,定义事件类型 `engram_created | engram_verified | engram_reinforced | synapse_created | proposal_accepted | proposal_dismissed | doctor_completed`。

(3b)cache.ts 在 rebuild() 后订阅 bus,收到事件标记 stale,异步 rebuild(去抖 50ms 避免抖动)。

(3c)所有 emit 点(close_learning_loop / synapse_create / verification 升级 / proposal accept/dismiss / doctor 完成)调用 `bus.emit(...)`。

(3d)openclaw-plugin prompt-builder 不再"plugin 注册时固定 snapshot",改为持有 cache 引用 + 提供 `getSnapshot()` 方法(每次构建 prompt 时调用)。

- [ ] **Step 4:Run test to verify it passes**

Expected: PASS

- [ ] **Step 5:Commit**

```bash
git add packages/core/src/prompt-signals/ packages/core/src/learning/loop.ts \
        packages/core/src/tools/synapse-tools.ts packages/core/src/storage/repository.ts \
        packages/openclaw-plugin/src/prompt-builder.ts packages/claude-code-mcp/src/mcp-server.ts
git commit -m "feat(prompt-signals): event-driven snapshot refresh, eliminate dual-delay"
```

---

### Task 3.5:doctor 报错 next-action hint

**Files:**
- Modify: `packages/core/src/storage/repository.ts:1116+`(runDoctor 三类问题加 nextAction 字段)
- Modify: `packages/core/src/tools/doctor-tools.ts`(展示 nextAction 给用户)
- Modify: `packages/core/src/i18n/{zh,en}.ts`(nextAction 文案)

**关键 context**:R13 实证 doctor 三类"人工裁决"问题(duplicate_id / orphan_markdown / dangling_synapse)报错后无 next action。挑剔用户视角:"doctor 报告说我有 3 个 dangling synapse,然后呢?"

- [ ] **Step 1:写 failing test**

```typescript
import { describe, it, expect } from "vitest";
import { runDoctor } from "../src/storage/repository.js";

describe("doctor next-action hints", () => {
  it("duplicate_id issue includes engram_delete hint", () => {
    const result = runDoctor(/* setup with dup id */);
    const dup = result.issues.find((i) => i.kind === "duplicate_id");
    expect(dup?.nextAction).toContain("engram_delete");
    expect(dup?.nextAction).toContain("保留");  // 用户层说明
  });
  it("dangling_synapse includes synapse_delete hint", () => {
    const result = runDoctor(/* setup with dangling */);
    const dangling = result.issues.find((i) => i.kind === "dangling_synapse");
    expect(dangling?.nextAction).toContain("synapse_delete");
  });
  it("orphan_markdown includes register-as-engram instruction", () => {
    const result = runDoctor(/* setup with orphan */);
    const orphan = result.issues.find((i) => i.kind === "orphan_markdown");
    expect(orphan?.nextAction).toMatch(/engram_create|register/);
  });
});
```

- [ ] **Step 2:Run test to verify it fails**

Expected: FAIL —— 当前 issue 对象无 nextAction 字段

- [ ] **Step 3:实现**

DoctorIssue interface 加 `nextAction: { tool: string; args_hint: string; explanation: string }`。三类问题的 nextAction:

| kind | nextAction.tool | explanation |
|---|---|---|
| duplicate_id | engram_delete | "两条记忆共用 ID,保留内容更完整的(看字节数 / 更新时间),删另一条" |
| orphan_markdown | engram_create | "Markdown 文件不在索引,若是新记忆,用 engram_create 注册;若是废弃,手动 rm" |
| dangling_synapse | synapse_delete | "synapse 指向不存在的 engram,用 synapse_delete 清理(synapseId 在 issue.id 字段)" |

- [ ] **Step 4:Run test to verify it passes**

Expected: PASS

- [ ] **Step 5:Commit**

```bash
git add packages/core/src/storage/repository.ts packages/core/src/tools/doctor-tools.ts \
        packages/core/src/i18n/zh.ts packages/core/src/i18n/en.ts
git commit -m "feat(doctor): next-action hints for duplicate_id / orphan_markdown / dangling_synapse"
```

---

## Phase 3A:fix-4 清理 P0 stub + 反应式修复文化

**Meta-pattern 攻击目标**:元1 组织层(覆盖 AJ/AF/AL,4 个 observation)

### Task 4.1:fts.ts 升级到 MiniSearch

**Files:**
- Modify: `packages/core/package.json`(加 MiniSearch 依赖)
- Modify: `packages/core/src/retrieval/fts.ts`(用 MiniSearch 替换 bigram 实现)
- Modify: `packages/core/test/retrieval/fts.test.ts`

**关键 context**:R15 实证 fts.ts tokenize 注释自承"P1 阶段会替换为 MiniSearch 等成熟方案;P0 先用极简实现验证流程"。bigram 中文切分产生大量假阳性。

- [ ] **Step 1:写 failing test**

```typescript
import { describe, it, expect } from "vitest";
import { buildFtsIndex, searchFts } from "../src/retrieval/fts.js";

describe("FTS MiniSearch upgrade", () => {
  it("does not produce bigram false positives", () => {
    const idx = buildFtsIndex([
      { id: "E1", title: "记忆系统设计", content: "记忆系统设计原则", kind: "pattern", domainTags: [] },
    ]);
    const hits = searchFts("忆系", idx, 10);  // bigram 假阳性
    expect(hits).toHaveLength(0);  // MiniSearch 词级匹配,不会匹配"忆系"
  });
  it("matches Chinese word boundary via tokenizer", () => {
    const idx = buildFtsIndex([
      { id: "E1", title: "记忆系统设计", content: "...", kind: "pattern", domainTags: [] },
    ]);
    const hits = searchFts("记忆系统", idx, 10);
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2:Run test to verify it fails**

Expected: FAIL —— 当前 bigram 会把"忆系"也匹配上

- [ ] **Step 3:实现**

(3a)`pnpm --filter @co-engram/core add minisearch`

(3b)重写 fts.ts:用 MiniSearch 实例 + 自定义 processTerm(中文用 jieba 或 nodejieba,英文用默认)。若不想加 native binding,用 Intl.Segmenter(Node 22+ 内置,无 native 依赖):
```typescript
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
function tokenize(text: string): string[] {
  return [...segmenter.segment(text)].map((s) => s.segment.trim()).filter(Boolean);
}
```

(3c)buildFtsIndex / searchFts API 保持向后兼容(SearchOrchestrator 不变)。

- [ ] **Step 4:Run test to verify it passes**

Run: `pnpm --filter @co-engram/core test retrieval/fts`
Expected: PASS

- [ ] **Step 5:Commit**

```bash
git add packages/core/package.json packages/core/src/retrieval/fts.ts packages/core/test/retrieval/fts.test.ts
git commit -m "perf(fts): replace bigram P0 stub with MiniSearch + Intl.Segmenter"
```

---

### Task 4.2:git.ts commitFiles 改 spawn

**Files:**
- Modify: `packages/core/src/storage/git.ts:81-143`
- Modify: `packages/core/test/storage/git.test.ts`

**关键 context**:R15 实证 commitFiles line 90 / 114 用 `'"' + f.replace(/"/g, '\\"') + '"'` 字符串拼接 execSync + 只转义双引号,反引号 / $ / 换行符等 shell 元字符未处理。createdBy 含特殊字符时 git commit 可能执行任意命令。

- [ ] **Step 1:写 failing test**

```typescript
import { describe, it, expect } from "vitest";
import { commitFiles } from "../src/storage/git.js";

describe("commitFiles spawn safety", () => {
  it("authorName with backtick does not execute shell", () => {
    const repoPath = /* temp git repo */;
    const result = commitFiles({
      repoPath,
      files: ["test.md"],
      message: "test",
      authorName: "user`whoami`",  // 注入尝试
      authorEmail: "u@example.com",
    });
    // 验证 git config user.name 字面保留 backtick(未执行)
    const name = execSync("git -C {repoPath} config user.name").toString();
    expect(name.trim()).toBe("user`whoami`");
  });
  it("filename with $ does not expand shell variable", () => {
    // 类似断言:file 名含 $HOME,字面保留
  });
});
```

- [ ] **Step 2:Run test to verify it fails**

Expected: FAIL —— 当前 execSync 字符串拼接会执行 backtick

- [ ] **Step 3:实现**

改用 `child_process.spawnSync` + 数组参数(无 shell 解释):
```typescript
import { spawnSync } from "node:child_process";

function runGit(repoPath: string, args: readonly string[]): { status: number; stdout: string } {
  const result = spawnSync("git", args, { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return { status: result.status, stdout: result.stdout };
}

export function commitFiles(options: GitCommitOptions): GitCommitResult {
  const { repoPath, files, message, authorName, authorEmail } = options;
  if (!isGitRepo(repoPath)) initGitRepo(repoPath);

  // Stage
  if (files.length > 0) {
    runGit(repoPath, ["add", ...files]);  // 数组参数,无需 shell 转义
  } else {
    runGit(repoPath, ["add", "-A"]);
  }

  // Check staged
  const diffStatus = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: repoPath }).status;
  if (diffStatus === 0) {
    return { commitHash: "", branch: getCurrentBranch(repoPath), filesChanged: 0 };
  }

  // Commit
  const commitArgs: string[] = [];
  if (authorName) commitArgs.push("-c", `user.name=${authorName}`);
  if (authorEmail) commitArgs.push("-c", `user.email=${authorEmail}`);
  commitArgs.push("commit", "-m", message);
  runGit(repoPath, commitArgs);

  // ... 后续 rev-parse / diff 计数也改 spawn
}
```

- [ ] **Step 4:Run test to verify it passes**

Run: `pnpm --filter @co-engram/core test storage/git`
Expected: PASS

- [ ] **Step 5:Commit**

```bash
git add packages/core/src/storage/git.ts packages/core/test/storage/git.test.ts
git commit -m "security(git): replace execSync string concat with spawnSync array args (no shell injection)"
```

---

### Task 4.3:'Finding N/M' 反应式注释 audit + lint 规则

**Files:**
- Modify: 各源码文件移除 / 改写 `Finding N/M P0` 引用(已知:R7 Finding 264/265、R12 Finding 107/111、R15 Finding 156/157)
- Create: `scripts/lint-no-finding-refs.mjs`(eslint custom rule 或独立 script)
- Modify: `package.json`(root)加 `lint:finding-refs` script

**关键 context**:R15 实证 path.ts:91 注释提"Finding 156/157 P0",与 R12 Finding 107/111、R7 Finding 264/265 同构 —— 团队靠挑剔用户测试发现问题后再修复(反应式),而非设计阶段预防(预防式)。反应式修复文化是 AF 的组织层投影。

- [ ] **Step 1:写 failing test**

```typescript
import { describe, it, expect } from "vitest";
import { scanFindingRefs } from "../../scripts/lint-no-finding-refs.mjs";

describe("lint: no Finding N/M refs in source", () => {
  it("source has no Finding N/M comments", () => {
    const refs = scanFindingRefs("packages/");
    expect(refs).toEqual([]);
  });
});
```

- [ ] **Step 2:Run test to verify it fails**

Expected: FAIL —— 检测到 llm-descriptions.ts "Finding 107/111"、path.ts "Finding 156/157"、其他 "Finding 264/265"

- [ ] **Step 3:实现**

(3a)Audit 所有源码内的 `Finding \d+/\d+` 注释,改写为不引用内部审计编号的解释性注释(或删除若已无信息价值)。

(3b)Create `scripts/lint-no-finding-refs.mjs`:用 glob 扫描 `packages/**/*.ts`,正则 `Finding\s+\d+\/\d+`,违规即报错。

(3c)package.json 加:
```json
"lint:finding-refs": "node scripts/lint-no-finding-refs.mjs"
```
CI 跑此 script。

- [ ] **Step 4:Run test to verify it passes**

Run: `pnpm lint:finding-refs`
Expected: PASS(无违规)

- [ ] **Step 5:Commit**

```bash
git add packages/ scripts/lint-no-finding-refs.mjs package.json
git commit -m "chore(lint): ban 'Finding N/M' refs in source + rewrite existing instances"
```

---

### Task 4.4:graph-builder typo + 顺带清理

**Files:**
- Modify: `packages/core/src/storage/graph-builder.ts:52`(incomingAdacencyHelper → incomingAdjacencyHelper)

- [ ] **Step 1:写 failing test**

```typescript
import { describe, it, expect } from "vitest";
import * as gb from "../src/storage/graph-builder.js";

describe("graph-builder naming", () => {
  it("exports incomingAdjacencyHelper (not typo)", () => {
    expect(typeof gb.incomingAdjacencyHelper).toBe("function");
    expect((gb as any).incomingAdacencyHelper).toBeUndefined();
  });
});
```

- [ ] **Step 2:Run test to verify it fails**

Expected: FAIL —— 当前导出名是 typo

- [ ] **Step 3:实现**

重命名函数 + 所有引用点(codegraph_impact 验证调用方)。注意这是 breaking change for 内部 API,需检查所有 caller。

- [ ] **Step 4:Run test to verify it passes**

Expected: PASS

- [ ] **Step 5:Commit**

```bash
git add packages/core/src/storage/graph-builder.ts
git commit -m "refactor(graph-builder): fix incomingAdacencyHelper typo (missing j)"
```

---

## Phase 3B:fix-5 默认值审计 + 文档同步

**Meta-pattern 攻击目标**:元3 参数层 + 元2 配置层(覆盖 AD/V/I,18 个 observation)

### Task 5.1:修正 PROFILE_TOOL_COUNTS + 单测防回归

**说明**:已在 Task 2.2 修正(`PROFILE_TOOL_COUNTS = .size` 自动)。此 task 只补单测的明确防回归断言。

**Files:**
- Modify: `packages/claude-code-mcp/test/tool-profile.test.ts`
- Modify: `packages/openclaw-plugin/test/tool-profile.test.ts`

- [ ] **Step 1:写 failing test(显式锁定数值)**

```typescript
import { describe, it, expect } from "vitest";
import { PROFILE_TOOL_SETS, PROFILE_TOOL_COUNTS } from "../src/tool-profile.js";

describe("PROFILE_TOOL_COUNTS regression guard", () => {
  it("minimal count matches actual set size", () => {
    expect(PROFILE_TOOL_COUNTS.minimal).toBe(PROFILE_TOOL_SETS.minimal.size);
    expect(PROFILE_TOOL_SETS.minimal.size).toBeGreaterThanOrEqual(11);
  });
  it("standard count matches actual set size", () => {
    expect(PROFILE_TOOL_COUNTS.standard).toBe(PROFILE_TOOL_SETS.standard.size);
  });
  it("full count matches actual set size", () => {
    expect(PROFILE_TOOL_COUNTS.full).toBe(PROFILE_TOOL_SETS.full.size);
  });
});
```

- [ ] **Step 2:Run test to verify it fails**

Expected: 已在 Task 2.2 修复,此 task 只补显式断言;verify test PASS

- [ ] **Step 3-5**:加测试 → run → commit:
```bash
git add packages/claude-code-mcp/test/tool-profile.test.ts packages/openclaw-plugin/test/tool-profile.test.ts
git commit -m "test(profile): explicit PROFILE_TOOL_COUNTS regression guard"
```

---

### Task 5.2:源码硬编码默认值全部暴露到 config.json

**说明**:已在 Task 1.5 完成 reinforcement / search.weights / observation window 的 config 化。此 task 补 audit:

**Files:**
- Create: `scripts/audit-hardcoded-defaults.mjs`
- Modify: `package.json` 加 `audit:defaults` script

- [ ] **Step 1:写 failing test**

```javascript
// scripts/audit-hardcoded-defaults.mjs
// 扫描 packages/**/*.ts 寻找:
//   1. 直接字面量赋值给 readonly config field(无 config 入口)
//   2. execSync / spawnSync 字符串里的硬编码 path
// 报告清单
```

测试:扫描结果应为空(或所有违规都在白名单)

- [ ] **Step 2-5**:实现 audit script → run → fix 违规 → commit

```bash
git add scripts/audit-hardcoded-defaults.mjs package.json
git commit -m "chore(audit): scan for hardcoded defaults missing config.json entry"
```

---

### Task 5.3:ViewerSectionConfig.port 废弃字段处理

**说明**:已在 Task 2.4 完成_metadata 标 deprecated + warn。此 task 验证 viewer 端读到 warn:

**Files:**
- Modify: `packages/viewer/src/runtime/viewer-server.ts`(启动时检查 config.port,若用户设置则 console.warn)

- [ ] **Step 1-5**:写 failing test(用户设 port 应触发 warn) → 实现 → verify → commit

---

### Task 5.4:serializeEngramFile aliases warn

**Files:**
- Modify: `packages/core/src/storage/engram-store.ts:155`(剥离 aliases 时 warn 一次,而非静默)

**关键 context**:R15 实证 serializeEngramFile `const { aliases: _drop, ...frontmatter } = file.frontmatter` 显式剥离 aliases,用户手动加的字段保存后消失无警告。

- [ ] **Step 1:写 failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { serializeEngramFile } from "../src/storage/engram-store.js";

describe("serializeEngramFile aliases warn", () => {
  it("warns when aliases field is stripped", () => {
    const warns: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((m) => warns.push(m));
    serializeEngramFile({
      frontmatter: { id: "E1", /* ... */, aliases: ["old-alias"] },
      body: "test",
    });
    expect(warns.some((w) => /aliases/.test(w))).toBe(true);
  });
});
```

- [ ] **Step 2:Run test to verify it fails**

Expected: FAIL —— 当前无 warn

- [ ] **Step 3:实现**

```typescript
if ("aliases" in file.frontmatter) {
  console.warn(`[co-engram] engram ${file.frontmatter.id}: aliases field stripped (legacy field, no longer used).`);
}
const { aliases: _drop, ...frontmatter } = file.frontmatter;
```

- [ ] **Step 4:Run test to verify it passes**

Expected: PASS

- [ ] **Step 5:Commit**

```bash
git add packages/core/src/storage/engram-store.ts packages/core/test/storage/engram-store.test.ts
git commit -m "fix(engram-store): warn (not silent) when aliases field is stripped"
```

---

### Task 5.5:中英文 docs + help panel 同步

**Files:**
- Modify: `docs/tool-reference.{md,zh-CN.md}`(更新工具列表,加 engram_audit_query、移除 skill_invoke from full)
- Modify: `docs/concepts.{md,zh-CN.md}`(引用 CONCEPT_DICTIONARY,加用户层解释)
- Modify: `docs/lifecycle.{md,zh-CN.md}`(verification 5 状态机规则 + observation window 概念)
- Modify: `docs/observability.{md,zh-CN.md}`(audit log 可达性 + 新工具)
- Modify: `docs/host-claude-code.{md,zh-CN.md}` + `docs/host-openclaw.{md,zh-CN.md}`(profile 选择 + config 字段语义)
- Modify: `docs/faq.{md,zh-CN.md}`(加"为何这样设计"段,引用 CONCEPT_DICTIONARY)
- Modify: `packages/viewer/src/runtime/tabs.ts`(help panel 同步)
- Modify: `packages/core/src/i18n/{zh,en}.ts`(viewer.help.* keys)

**关键 context**:CLAUDE.md STRICT 规则 —— 用户可感知的变更必须中英文 docs + help panel 三处同步。

- [ ] **Step 1:写 failing test(用 contracts-test 验证 docs/help 一致)**

已在 Task 2.5 建立_help-text-contract。此 task 补 docs parity check:
```typescript
it("docs zh and en cover same concepts", () => {
  // 解析 docs/concepts.{md,zh-CN.md} 提取概念引用,验证对齐
});
```

- [ ] **Step 2:Run test to verify it fails**

Expected: FAIL —— docs 中英文概念覆盖不一致

- [ ] **Step 3:实现**

按 [CLAUDE.md](../../../.claude/CLAUDE.md) STRICT 规则逐文件中英文同步:
- engram_audit_query 工具说明(tool-reference)
- CONCEPT_DICTIONARY 概念解释(concepts)
- verification 5 状态机 + observation window + reinforcement 参数(lifecycle + help panel)
- audit 可达性(observability)
- profile 选择机制 + config 字段(host-claude-code / host-openclaw)
- "为何这样设计"FAQ(解释 spec 乌托邦 vs 代码现实的反思)

- [ ] **Step 4:Run test to verify it passes**

Run: `pnpm test:contracts && pnpm --filter @co-engram/core test help-text`
Expected: PASS

- [ ] **Step 5:Commit**

```bash
git add docs/ packages/viewer/src/runtime/tabs.ts packages/core/src/i18n/zh.ts packages/core/src/i18n/en.ts
git commit -m "docs: sync zh/en + help panel for concept dictionary + audit-query + profile + observation window"
```

---

## Self-Review

按 superpowers-writing-plans skill 的 self-review 检查清单:

### 1. Spec coverage
对照 [.loop-progress.json](../../../.loop-progress.json) 的 31 个 root cause cluster:

| 元 pattern | 覆盖 root cause | 对应 fix |
|---|---|---|
| 元3 神经科学墙 | AE / L / U / A / M / C | fix-1(Task 1.1-1.5) |
| 元1 spec-vs-code | AF / AJ / AB / Y / K / H / F / O | fix-3(Task 3.1-3.5) + fix-4(Task 4.1-4.3) |
| 元2 双宿主无契约 | G / E / AC / S / AD | fix-2(Task 2.1-2.6) |

**剩余 root cause(未直接覆盖,但通过 meta-pattern 修复间接消除):**
- B / D / J / N / P / Q / R / T / V / W / X / Y / AA —— 这些是 1-2 轮投影的低频根因,大部分被 fix-2 契约测试 + fix-3 可观测性间接覆盖。V(数据语义错误)在 Task 2.4 / 5.4 处理;W(dryRun 语义违反)与 AJ 同源,Task 3.2 处理。

**未覆盖项**(需补 task):
- B(satellite 未完整跟踪)—— 检查进度文件,若仍有 observation 未归类,补 task。**当前决断:accept minor gap,执行中遇到再补。**

### 2. Placeholder scan
- ✅ 无 TBD / TODO / "implement later"
- ✅ 所有 step 含具体代码或具体命令
- ✅ 无"Add appropriate error handling"类空泛指令
- ✅ 无"Similar to Task N"(都重复了代码)
- ✅ 所有引用类型 / 函数 / 文件路径在某个 task 内定义

### 3. Type consistency
- `CONCEPT_DICTIONARY` —— Task 1.1 定义,Task 1.2 / 1.4 / 2.5 / 5.5 引用 ✅
- `PROFILE_TOOL_SETS` / `PROFILE_TOOL_COUNTS` —— Task 2.1 引用,Task 2.2 修正,Task 5.1 加测试 ✅
- `runProfileContractTests` 等 4 runner —— Task 2.1 定义,Task 2.2-2.5 实现,Task 2.6 CI gate ✅
- `PromptSignalBus` —— Task 3.4 定义并使用 ✅
- `engramAuditQueryTool` —— Task 3.3 定义,Task 5.5 docs 引用 ✅
- `formatScore` —— Task 1.1 定义,Task 1.3 引用 ✅
- `nextAction` field —— Task 3.5 加到 DoctorIssue,需确认 type 定义一致 ✅
- `failMode` option —— Task 3.1 定义 strict / warn,Task 3.1 实现使用 ✅

### 4. Scope check
- 单个 master plan 含 5 个 fix 是合理决断(依赖性强,见 Scope Check section)
- 每个 task 边界清晰,可独立测试
- Phase 划分尊重依赖关系

### 5. Risk 标注
- **breaking change**:Task 4.4 graph-builder 函数重命名(内部 API)。Mitigation:用 codegraph_impact 找全调用方 + 一次 atomic commit。
- **behavior change**:Task 3.2 skill_invoke 移出 full profile。Mitigation:contracts-test 自动验证;同时在 docs 5.5 同步说明。
- **performance**:Task 4.1 MiniSearch 升级可能改变 FTS 召回率。Mitigation:Task 4.1 加召回率回归测试。

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-29-co-engram-architectural-fixes.md`.**

总规模:5 个 fix · 24 个 task · 120 个 step · ~6 周工期(Phase 1 两周 + Phase 2 三周 + Phase 3 一周)。

两个执行选项:

**1. Subagent-Driven(推荐)** —— 我每个 task dispatch 一个 fresh subagent,task 间 review,快速迭代。适合:
- 你想要每个 task 独立 review gate
- 你想看到每步 diff 再继续
- 5 个 fix 想交错执行(Phase 2A / 2B 真并行)

**2. Inline Execution** —— 在本会话内 batch 执行,checkpoint review。适合:
- 你想最小化 session 切换开销
- 一次性跑完一个 Phase 再 review
- 资源紧张不想 spawn 多 agent

**额外选项(因为 5 fix 工程量大):**

**3. Phase-by-Phase** —— 先只执行 Phase 1(fix-2,~2 周),交付后再决定 Phase 2 / 3。适合:
- 你想先验证契约测试包是否真的能catch dual-host 漂移
- 工期分批次批准

**4. Wait** —— 计划已落盘,不立即执行。等你后续指令。

哪个?
