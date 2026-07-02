import { describe, it, expect } from "vitest";
import vm from "node:vm";

import { APP_RUNTIME } from "../src/runtime/app.js";
import { TABS_RUNTIME } from "../src/runtime/tabs.js";
import { GRAPH_RUNTIME } from "../src/runtime/graph.js";
import { I18N_RUNTIME } from "../src/runtime/i18n.js";
import { DECAY_RUNTIME } from "../src/runtime/decay.js";

// 这组测试防御一个 sneaky bug:viewer 的 _RUNTIME 常量是 template literal
// 包裹的浏览器端 JS 源码字符串。template literal 会解析 `\X` 形式的转义
// (例如 `\/` → `/`、`\w` → `w`),如果源代码在 template literal 里写了
// regex 字面量或字符串字面量,template literal 解析可能破坏浏览器收到的
// 字符,导致 <script> 抛 SyntaxError,整个页面 JS 不执行。
//
// 历史上发生过(commit 62cb92e 引入的 ALLOWED_URI_REGEXP),源里写
// `/\/[\w-]/`,template literal 解析后浏览器收到 `/[w-]/`,JS 解析正则
// 字面量时在 `#/` 处提前闭合,后续字符触发 SyntaxError,viewer 整页
// 空白。viewer 的现有测试只 check HTML 字符串含/不含 marker,不实际
// eval inline script,所以这个 bug 没被抓到。
//
// 这里的策略:把 _RUNTIME 当成浏览器收到的 JS 源码字符串,做语法解析
// 测试 + 关键 regex 行为测试,任何 template literal 解析破坏都会立刻
// 暴露。
const RUNTIMES: Record<string, string> = {
  APP_RUNTIME,
  TABS_RUNTIME,
  GRAPH_RUNTIME,
  I18N_RUNTIME,
  DECAY_RUNTIME,
};

describe("viewer runtime inline-script syntax(防 template literal 转义破坏)", () => {
  for (const [name, code] of Object.entries(RUNTIMES)) {
    it(`${name} 解析后必须是合法 JS(vm.Script 不抛 SyntaxError)`, () => {
      // 模拟浏览器把 <script> 内容作为 JS 源码 eval 的第一步:语法解析。
      // 任何 \X 被错误剥离导致 regex/字符串字面量破裂,这里都会抛。
      expect(() => {
        // eslint-disable-next-line no-new
        new vm.Script(code, { filename: `${name}.js` });
      }).not.toThrow();
    });
  }

  it("APP_RUNTIME 中的 ALLOWED_URI_REGEXP 必须保留反斜杠 escape(防 markdown XSS 配置失效)", () => {
    // 直接从 APP_RUNTIME 提取 ALLOWED_URI_REGEXP: /.../i 字面量,
    // eval 后测试它在浏览器实际跑时的行为。如果 template literal 把
    // `\/[\w-]` 解析成 `/[w-]`,这里 regex 仍能 eval,但语义错(匹配
    // 字面 `[w-]` 而非 word char),`javascript:` 协议会漏过。
    const match = APP_RUNTIME.match(
      /ALLOWED_URI_REGEXP:\s*(\/\^[\s\S]+?\/[a-z]+),/,
    );
    expect(match).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const regex: RegExp = eval(match![1]!);

    // 白名单必须通过
    expect(regex.test("https://example.com/path")).toBe(true);
    expect(regex.test("mailto:foo@bar.com")).toBe(true);
    expect(regex.test("#/engrams-tab")).toBe(true);
    expect(regex.test("relative/path")).toBe(true);

    // 黑名单必须拒绝(高危:这些协议允许 XSS)
    expect(regex.test("javascript:alert(document.cookie)")).toBe(false);
    expect(regex.test("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(regex.test("vbscript:msgbox")).toBe(false);
    expect(regex.test("file:///etc/passwd")).toBe(false);
  });
});
