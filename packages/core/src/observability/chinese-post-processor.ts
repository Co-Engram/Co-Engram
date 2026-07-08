/**
 * 中文 LLM artifact 后处理(AI-6)
 *
 * hyper-pattern 6(chinese-second-class citizen)的核心保护层。
 *
 * 背景:LLM(尤其英文主导训练的)生成中文时,tokenizer 常在 CJK 字符之间或
 * CJK-Latin 边界插入 ASCII 空格,产生诸如"清 cache 时必须先 备份"这样的破碎标题。
 * 这些 artifact 在 LLM 决策时无明显问题,但在 UI 渲染 / 用户审批 / 文件命名时
 * 显得粗糙,长期累积让仓库看起来像"机器生成"而非"人工整理"。
 *
 * 修正策略:
 *   1. 两个 CJK 字符之间的 ASCII 空格 → 删除(CJK 内部不用 ASCII 空格分词)
 *   2. CJK 与 Latin/数字边界 → 保留一个空格(符合中文排版规范 + CLAUDE.md STRICT)
 *   3. 连续多空格 → 压成一个
 *   4. 首尾空白 → trim
 *
 * 不改动:
 *   - 纯 Latin 段(英文 / 代码块 / 标识符)
 *   - 标点符号(只处理 ASCII space,不动其他)
 *
 * @module @co-engram/core/observability
 */

/**
 * CJK 统一表意符号范围(基本汉字 + 扩展 A)。
 *
 * 不含:
 *   - CJK 标点(U+3000..U+303F)— 它们与汉字之间的空格应当保留 / 由标点语义决定
 *   - 全角 ASCII(U+FF00..U+FFEF)— 用户输入应保留,LLM 一般不生成
 *   - 扩展 B-F — 罕见字,正则匹配代价高,暂不处理
 */
const CJK_RANGE = "[一-鿿㐀-䶿]";
const CJK_BOUNDARY = new RegExp(`(${CJK_RANGE}) +(${CJK_RANGE})`, "g");

/**
 * 修正中文文本中的 LLM tokenizer artifact。
 *
 * 触发场景:LLM 生成"清 cache 时必须先 备份"这种 CJK+CJK 之间被插入空格的破碎文本。
 * 修正后:"清 cache 时必须先备份"(CJK+Latin 边界的空格保留,符合 CLAUDE.md STRICT)。
 *
 * 不修正:
 *   - "Node 22+" — 纯 Latin/数字段不动
 *   - "github-push-zte-proxy" — kebab-case 标识符不动
 *   - "中。文。" — CJK 标点之间的空格不动(应由 punct 规范处理,非本函数职责)
 *
 * 幂等:对已规范化的文本再次调用不会改变结果。
 */
export function normalizeChinesePunctuation(text: string): string {
  if (!text) return text;
  let result = text;
  // 循环消除 CJK+space+CJK 链:
  //   一次 replace 只能匹配相邻 3 字符,长链 "中 中 中 中" 一次后变 "中中 中中",
  //   需要二次 replace 才能完全消除。loop until stable。
  let prev: string;
  do {
    prev = result;
    result = result.replace(CJK_BOUNDARY, "$1$2");
  } while (result !== prev);
  // 多空格压成一个(CJK-Latin / Latin-CJK 边界偶尔多空格)
  result = result.replace(/ {2,}/g, " ");
  return result.trim();
}

/**
 * 规范化 domainTags / contextTags 数组。
 *
 * 处理:
 *   1. trim + 折叠内部空白(避免 "协作原则 " 与 "协作原则" 被当作两个 tag)
 *   2. 大小写不敏感去重("co-engram" 与 "Co-Engram" 视为相同,保留首次出现形式)
 *
 * 不处理(故意):
 *   - 不强制 lowercase(CJK 无大小写;ASCII tag 大小写在某些场景有意义,如版本号)
 *   - 不改 kebab/snake/Pascal 转换(命名风格属 AI-10 domainTags 排序规范的范畴)
 *   - 不删非字符串元素(类型层已保证,运行时防御性跳过)
 */
export function normalizeDomainTags(
  tags: readonly string[],
): readonly string[] {
  if (!tags || tags.length === 0) return tags;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== "string") continue;
    const normalized = raw.replace(/\s+/g, " ").trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

/**
 * 对 proposal payload 做整体后处理。
 *
 * 一次性修正 title / content / summary 的中文 artifact + domainTags / contextTags
 * 命名规范。供 proposal-engine 的 proposeAutoMemory / proposeExternalMarkdown
 * 在写入前调用,保证落盘内容是规范化的。
 *
 * 返回新对象(不可变输入),undefined 字段保持 undefined 不强行注入。
 */
export function normalizeProposalFields<
  T extends {
    readonly title?: string;
    readonly content?: string;
    readonly summary?: string;
    readonly domainTags?: readonly string[];
    readonly contextTags?: readonly string[];
  },
>(input: T): T {
  return {
    ...input,
    ...(input.title !== undefined
      ? { title: normalizeChinesePunctuation(input.title) }
      : {}),
    ...(input.content !== undefined
      ? { content: normalizeChinesePunctuation(input.content) }
      : {}),
    ...(input.summary !== undefined
      ? { summary: normalizeChinesePunctuation(input.summary) }
      : {}),
    ...(input.domainTags !== undefined
      ? { domainTags: normalizeDomainTags(input.domainTags) }
      : {}),
    ...(input.contextTags !== undefined
      ? { contextTags: normalizeDomainTags(input.contextTags) }
      : {}),
  };
}
