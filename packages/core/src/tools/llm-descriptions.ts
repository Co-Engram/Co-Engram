/**
 * LLM-facing tool description overrides (host-agnostic)
 *
 * Core 的 `tool.*` i18n 描述是给开发者看的(包含 FTS/LTP/Hebbian/RPE 等术语),
 * 对 LLM 决策不友好。本模块为 standard profile 暴露的工具提供 LLM-optimized 描述,
 * 结构统一:
 *
 *   1. 一句话总结(plain language)
 *   2. WHEN TO CALL:3-5 个触发模式,带用户原话示例
 *   3. WHEN NOT TO CALL:2-3 个反模式,避免过度调用
 *   4. RETURNS:结果形状 + 下一步动作
 *
 * 设计目标:让 LLM 看到 description 后能立即判断"现在该不该调",
 * 不需要看 instructions 或 CLAUDE.md。
 *
 * 本模块对所有 host 共享:MCP / OpenClaw / 未来 host 都走这里。
 *
 * @module @co-engram/core/tools
 */

import type { Language, Tool } from "../index.js";

/**
 * LLM-facing 描述字典
 *
 * key 是工具名,value 是 { en, zh } 双语描述。
 * 覆盖 standard profile 暴露的全部 16 个工具(含自愈 engram_doctor + 路径树 engram_list_paths)。
 */
export const LLM_TOOL_DESCRIPTIONS: Readonly<
  Record<string, { readonly en: string; readonly zh: string }>
> = {
  engram_search: {
    en: `Search team memory for past decisions, preferences, project context.

WHEN TO CALL:
- User references past work ("we decided", "previously", "last time we")
- User mentions preferences ("I prefer", "I always use", "I hate when")
- User asks about project history ("why does X exist", "who decided", "did we discuss")
- Encountering a bug that may have been seen before
- User explicitly says "remember" or "did we discuss"

WHEN NOT TO CALL:
- Pure code questions unrelated to team history
- General programming knowledge (use web search)
- Simple greetings or acknowledgments

RETURNS: Top N engrams (title + summary + score + tags). Use engram_get for full content.`,
    zh: `搜索团队记忆(过去的设计决策、偏好、项目上下文)。

何时调用:
- 用户引用过去的工作("我们之前决定"、"上次"、"以前我们")
- 用户提到偏好("我喜欢"、"我一直用"、"我讨厌")
- 用户问项目历史("X 为什么存在"、"谁决定的"、"我们讨论过...吗")
- 遇到可能之前见过的 bug
- 用户明确说"记住"或"我们讨论过"

何时不调用:
- 与团队历史无关的纯代码问题
- 通用编程知识(用 web search)
- 简单问候

返回:Top N 条 engram(标题 + 摘要 + 分数 + tags)。需要全文用 engram_get。`,
  },
  engram_get: {
    en: `Read full content of a single memory (engram) by ID.

WHEN TO CALL:
- After engram_search returned a hit you want to read in full
- User explicitly asks for details on a specific engram ID
- You need metadata (importance, tags, verification status) not shown in search summary

WHEN NOT TO CALL:
- You haven't called engram_search yet (search first)
- The engram ID is from an outdated conversation (re-search to verify)

RETURNS: Full content + metadata (createdAt, importance, truthScore, reinforcementCount) + related engram IDs (synapses).`,
    zh: `按 ID 读取单条记忆(engram)的完整内容。

何时调用:
- engram_search 返回的命中需要读全文
- 用户明确询问某个 engram ID 的详情
- 需要搜索摘要里没显示的元数据(重要性、tags、验证状态)

何时不调用:
- 还没调过 engram_search(先搜索)
- engram ID 来自过时的对话(重新搜索验证)

返回:完整内容 + 元数据(创建时间、重要性、truthScore、强化次数)+ 相关 engram ID 列表。`,
  },
  engram_create: {
    en: `Create a new memory (engram) for important team knowledge.

WHEN TO CALL:
- User explicitly states a preference ("from now on, use arrow functions")
- User makes a design decision with rationale ("we'll use PostgreSQL because X")
- User shares a bug lesson ("this failed because Y, remember to check Z")
- User corrects an outdated memory ("actually, we switched to X")

WHEN NOT TO CALL:
- For trivial / throwaway information ("the weather is nice")
- For information already in CLAUDE.md or project README
- For information the user is just asking about (use engram_search instead)

RETURNS: Created engram ID + version. Existing duplicates auto-detected.`,
    zh: `为重要的团队知识创建新记忆(engram)。

何时调用:
- 用户明确表达偏好("以后用 arrow function")
- 用户做出带理由的设计决策("我们用 PostgreSQL,因为 X")
- 用户分享 bug 教训("这个失败因为 Y,以后记得检查 Z")
- 用户纠正过时记忆("其实我们已经改用 X 了")

何时不调用:
- 琐碎/一次性信息("天气不错")
- CLAUDE.md 或项目 README 已有的信息
- 用户只是在询问的信息(用 engram_search)

返回:创建的 engram ID + 版本号。自动检测重复。`,
  },
  engram_update: {
    en: `Update an existing memory when its content needs refinement (not contradiction).

WHEN TO CALL:
- Adding details to an existing engram ("the migration also needs to handle X")
- Correcting a typo / imprecise wording in memory
- The user clarifies a previous memory ("what I meant was...")

WHEN NOT TO CALL:
- The new info contradicts the old (use engram_create + contradiction_resolve instead)
- The memory is fine as-is (don't update just to refresh timestamp)

RETURNS: Updated engram + new version number.`,
    zh: `当已有记忆的内容需要细化(不是矛盾)时更新。

何时调用:
- 给已有 engram 补充细节("迁移还要处理 X")
- 修正记忆里的笔误/不精确表述
- 用户澄清之前的记忆("我的意思是...")

何时不调用:
- 新信息和旧的矛盾(用 engram_create + contradiction_resolve)
- 记忆没问题(不要为了刷新时间戳而更新)

返回:更新后的 engram + 新版本号。`,
  },
  engram_list: {
    en: `Browse all memories (paginated), newest first.

WHEN TO CALL:
- User wants an overview of stored memories ("what do you know about me")
- You need to find a memory but don't have a precise search query
- Reviewing what's been captured recently

WHEN NOT TO CALL:
- You have a specific query (use engram_search instead — faster and more relevant)
- Just to check if a memory exists (search by content)

RETURNS: List of engram summaries (title, tags, updatedAt) + total count. Use cursor/limit for pagination.`,
    zh: `浏览所有记忆(分页),最新优先。

何时调用:
- 用户想看存储的记忆概览("你知道我什么")
- 需要找记忆但没精确查询词
- 回顾最近捕获的内容

何时不调用:
- 有明确查询(用 engram_search 更快更准)
- 只为检查记忆是否存在(按内容搜)

返回:engram 摘要列表(标题、tags、更新时间)+ 总数。支持分页。`,
  },
  synapse_create: {
    en: `Create a typed connection between two memories (synapse).

WHEN TO CALL:
- A new memory extends / contradicts / relates to an existing one
- User mentions causal or dependency relationship ("X happened because of Y")
- Connecting a decision to its rationale, or a bug to its fix

WHEN NOT TO CALL:
- The two memories are unrelated
- You're unsure of the relationship kind (use 'related_to' as default)

RETURNS: Synapse ID + from/to engram IDs. Common kinds: extends, contradicts, related_to, caused_by.`,
    zh: `在两条记忆之间创建有类型的连接(synapse)。

何时调用:
- 新记忆扩展/矛盾/关联已有记忆
- 用户提到因果或依赖关系("X 因为 Y 发生")
- 把决策链接到理由,或 bug 链接到修复

何时不调用:
- 两条记忆无关
- 不确定关系类型(默认用 'related_to')

返回:synapse ID + from/to engram ID。常见类型:extends、contradicts、related_to、caused_by。`,
  },
  engram_reinforce: {
    en: `Mark a memory as effectively used (positive reinforcement).

WHEN TO CALL:
- You cited an engram ID in your answer and the user accepted the result
- A retrieved memory directly contributed to solving the task
- After successfully completing a task that depended on a memory

WHEN NOT TO CALL:
- You didn't actually use the memory (just skimmed it)
- The task failed or the memory was wrong (use engram_report_failure instead)

RETURNS: Memory's strength score increased + effective-use count incremented.`,
    zh: `标记某条记忆被有效使用(正向强化)。

何时调用:
- 你在回答里引用了 engram ID 且用户接受了结果
- 取回的记忆直接帮助解决了任务
- 成功完成依赖某条记忆的任务后

何时不调用:
- 实际没用那条记忆(只是扫了一眼)
- 任务失败或记忆错了(用 engram_report_failure)

返回:记忆的强度分数增加 + 有效使用计数 +1。`,
  },
  engram_report_failure: {
    en: `Report a memory as wrong or outdated (negative reinforcement).

WHEN TO CALL:
- User says "that's not right" / "we changed that" / "outdated"
- A retrieved memory led to a wrong answer
- Code or reality contradicts the memory

WHEN NOT TO CALL:
- The memory is just incomplete (use engram_update)
- You're not sure (ask the user first)

RETURNS: Memory's failure count increased + strength score decreased. May trigger automatic refutation in a later maintenance cycle.`,
    zh: `报告某条记忆错误或过时(负向强化)。

何时调用:
- 用户说"不对"、"我们改了"、"过时了"
- 取回的记忆导致了错误答案
- 代码或现实和记忆矛盾

何时不调用:
- 记忆只是不完整(用 engram_update)
- 不确定(先问用户)

返回:记忆的失败次数增加 + 强度分数下降。可能在后续维护周期自动驳回。`,
  },
  engram_delete: {
    en: `Permanently delete a memory (use with caution).

WHEN TO CALL:
- User explicitly asks to delete ("remove that memory about X")
- Memory is duplicated and you're keeping only one
- Memory contains sensitive info that should not persist

WHEN NOT TO CALL:
- Memory is just outdated (use engram_report_failure, let maintenance refute it)
- User is ambiguous ("forget that" — confirm what they mean)
- For bulk cleanup (use CLI instead)

RETURNS: { deleted: true } or error if not found.`,
    zh: `永久删除一条记忆(谨慎使用)。

何时调用:
- 用户明确要删除("删掉关于 X 的那条记忆")
- 记忆重复了,只保留一条
- 记忆含敏感信息不应保留

何时不调用:
- 记忆只是过时(用 engram_report_failure,让维护 refute)
- 用户表述模糊("忘掉那个"— 确认含义)
- 批量清理(用 CLI)

返回:{ deleted: true } 或未找到错误。`,
  },
  close_learning_loop: {
    en: `Close the verification loop on a memory after confirming its correctness.

WHEN TO CALL:
- You used a memory, verified it works, and want to mark it as confirmed
- After positive feedback + user confirmation that the memory is accurate
- Completing the "retrieve → use → verify → confirm" cycle

WHEN NOT TO CALL:
- You haven't actually verified yet (wait until confirmation is solid)
- The memory turned out wrong (use engram_report_failure)

RETURNS: Updated verification status + closed loop metadata.`,
    zh: `确认记忆正确后,关闭验证回路。

何时调用:
- 使用了记忆,验证有效,想标记为已确认
- 正向反馈 + 用户确认记忆准确后
- 完成"取回 → 使用 → 验证 → 确认"循环

何时不调用:
- 还没实际验证(等确认扎实后再调)
- 记忆最终错了(用 engram_report_failure)

返回:更新后的验证状态 + 闭环元数据。`,
  },
  contradiction_resolve: {
    en: `Resolve a contradiction between two memories (old vs new).

WHEN TO CALL:
- A new memory explicitly contradicts an older one
- User confirms the old memory is wrong and should be refuted
- You need to mark which side wins in a contradiction synapse

WHEN NOT TO CALL:
- The two memories are just different perspectives (use synapse kind 'related_to')
- You're not sure which is right (ask the user)

RETURNS: Resolution record + updated verification status on both engrams.`,
    zh: `解决两条记忆之间的矛盾(旧 vs 新)。

何时调用:
- 新记忆明确矛盾旧记忆
- 用户确认旧记忆错了应该 refute
- 需要标记 contradiction synapse 里哪一方胜出

何时不调用:
- 两条记忆只是不同视角(用 synapse kind 'related_to')
- 不确定哪个对(问用户)

返回:resolution 记录 + 两条 engram 的验证状态更新。`,
  },
  engram_list_proposals: {
    en: `List pending memory proposals (implicit capture candidates awaiting review).

WHEN TO CALL:
- System prompt shows "N memory candidates pending"
- User asks "what proposals do you have" or "review pending memories"
- Periodically to triage captured but unconfirmed memories

WHEN NOT TO CALL:
- No pending proposals (system prompt will show 0)
- You just searched explicitly (use engram_search)

RETURNS: List of proposals (title, similarity, sample message, proposal ID).`,
    zh: `列出待处理的记忆候选(隐式捕获但待审批的)。

何时调用:
- 系统提示显示"N 个候选记忆待处理"
- 用户问"有什么候选"或"查看待处理记忆"
- 定期清理已捕获但未确认的记忆

何时不调用:
- 没有待处理候选(系统提示会显示 0)
- 刚刚显式搜索过(用 engram_search)

返回:候选列表(标题、相似度、样本消息、proposal ID)。`,
  },
  engram_accept_proposal: {
    en: `Accept a pending memory proposal (convert it to a real engram).

WHEN TO CALL:
- User confirms a proposal is valid ("yes, save that")
- You reviewed a proposal and it captures a real preference/decision

WHEN NOT TO CALL:
- The proposal is wrong or low quality (use engram_dismiss_proposal)
- You haven't reviewed it yet

RETURNS: Created engram ID + proposal marked as accepted.`,
    zh: `接受待处理的候选(转成真正的 engram)。

何时调用:
- 用户确认候选有效("对,保存那个")
- 你审核后认为候选捕获了真实偏好/决策

何时不调用:
- 候选错误或质量低(用 engram_dismiss_proposal)
- 还没审核

返回:创建的 engram ID + 候选标记为已接受。`,
  },
  engram_dismiss_proposal: {
    en: `Dismiss a pending memory proposal (reject the capture).

WHEN TO CALL:
- User says "no, that's not worth saving"
- Proposal is noisy / low quality / already covered
- After review, you decide it shouldn't become a memory

WHEN NOT TO CALL:
- You haven't reviewed the proposal content
- The proposal is borderline (accept + refine instead)

RETURNS: Proposal marked as dismissed + removed from pending list.`,
    zh: `驳回待处理的候选(拒绝捕获)。

何时调用:
- 用户说"不,不值得保存"
- 候选是噪声/低质量/已被覆盖
- 审核后决定不应成为记忆

何时不调用:
- 还没审核候选内容
- 候选处于边缘(改为接受 + 细化)

返回:候选标记为已驳回 + 从待处理列表移除。`,
  },
  engram_doctor: {
    en: `Run a self-healing scan over the memory repo and report findings.

Auto-fixes: moved files (index re-points), renamed titles (re-slug + rename), stale index entries (cleared). Reports for manual review: dangling synapse references and orphan markdown.

WHEN TO CALL:
- User says "my memory looks wrong" or "search misses entries I expected"
- User manually edited/renamed files under the data root
- After a Git merge that touched the data repo
- Periodic health check (once per session)

WHEN NOT TO CALL:
- No observed inconsistency
- User wants a specific engram (use engram_get)

RETURNS: started/finished timestamps, total counts, autoFixesApplied, pendingManualReview, and the full issues array (kind + path + message + autoFixed).`,
    zh: `对记忆仓库做一次自愈扫描。

自动修复:文件移动(索引重新指向)、标题重命名(重新生成 slug + 重命名)、过期索引项(清除)。仅报告:dangling synapse 引用、孤儿 markdown。

何时调用:
- 用户说"记忆看起来不对"或"搜索找不到该有的条目"
- 用户手动编辑/重命名了数据目录下的文件
- 触及数据仓库的 Git 合并之后
- 定期健康检查(每次会话一次)

何时不调用:
- 没观察到不一致
- 用户想看具体某条 engram(用 engram_get)

返回:开始/结束时间戳、总计数、自动修复数、待审核数,以及完整 issues 列表。`,
  },
  engram_list_paths: {
    en: `Show the physical directory tree of the memory repo so you can orient before searching.

Each node carries engramCount (cumulative for that subtree). Use it to see where memory is concentrated (which domains, which projects) before deciding what to search for.

WHEN TO CALL:
- Start of a session, before any engram_search, to map the landscape
- User asks "what do we have memories about" or "what areas does the team work on"
- You want to pick a more specific domain tag before searching

WHEN NOT TO CALL:
- You already know the query — go straight to engram_search
- User wants a specific engram (use engram_get)

RETURNS: Nested { path, engramCount, children } tree rooted at '/'. Optional maxDepth (1-10, default 5).`,
    zh: `展示记忆仓库的物理目录树,让你在搜索前先建立全局认知。

每节点带 engramCount(子树累计)。用它了解记忆集中在哪些领域、项目,再决定搜什么。

何时调用:
- 会话开始时,在 engram_search 之前建立全局观感
- 用户问"我们有哪些方面的记忆"或"团队做什么领域"
- 准备搜索但想先选更具体的 domain tag

何时不调用:
- 已知道具体查询——直接 engram_search
- 用户想要某条 engram(用 engram_get)

返回:嵌套 { path, engramCount, children } 树,根为 '/'。可选 maxDepth(1-10,默认 5)。`,
  },
};

/**
 * 被禁止的实现术语(出现则视为描述不 LLM-friendly)
 *
 * 这些是开发者视角的术语,LLM 看到反而困惑。
 */
const FORBIDDEN_TERMS: readonly string[] = [
  "FTS",
  "LTP",
  "Hebbian",
  "RPE",
  "reinforcementScore",
  "effectiveRetrievals",
  "failedUses",
  "engram_reinforce", // 不应在描述里引用其他工具的内部字段
  "truthScore", // 例外:engram_get 描述里可以保留作为字段名
];

/**
 * Resolve a tool's LLM-facing description.
 *
 * Resolution order:
 *   1. LLM_TOOL_DESCRIPTIONS (structured WHEN/RETURNS format, host-agnostic)
 *   2. fallback (caller-provided default, usually the core `tool.*` i18n string)
 *
 * 返回新对象,不修改入参。
 */
export function resolveLlmDescription<T extends Tool>(
  tool: T,
  language: Language,
  fallback?: string,
): string {
  const entry = LLM_TOOL_DESCRIPTIONS[tool.name];
  if (entry) {
    return language === "zh" ? entry.zh : entry.en;
  }
  return fallback ?? tool.description;
}

/**
 * Override 工具的 description
 *
 * 如果 tool.name 在 LLM_TOOL_DESCRIPTIONS 中,返回新的 tool(描述被替换);
 * 否则返回原 tool(保持 caller 注入的 description / core i18n 描述)。
 *
 * 不修改输入 tool(返回新对象)。
 */
export function overrideDescription<T extends Tool>(
  tool: T,
  language: Language,
): T {
  const entry = LLM_TOOL_DESCRIPTIONS[tool.name];
  if (!entry) return tool;
  const newDescription = language === "zh" ? entry.zh : entry.en;
  return { ...tool, description: newDescription };
}

/**
 * 批量 override(immutable,不修改输入数组)
 */
export function overrideDescriptions<T extends Tool>(
  tools: readonly T[],
  language: Language,
): readonly T[] {
  return tools.map((t) => overrideDescription(t, language));
}

/**
 * 检查描述质量(用于测试 / CI gate)
 *
 * 返回违规列表(空 = 合格)。
 * 'truthScore' 在 engram_get 的 RETURNS 段是允许的(作为字段名引用)。
 */
export function auditDescriptionQuality(
  name: string,
  language: Language,
): readonly string[] {
  const entry = LLM_TOOL_DESCRIPTIONS[name];
  if (!entry) return [`tool "${name}" has no LLM-facing description`];
  const text = language === "zh" ? entry.zh : entry.en;
  const violations: string[] = [];

  // 结构检查
  if (!text.includes("WHEN TO CALL") && !text.includes("何时调用")) {
    violations.push('missing "WHEN TO CALL" / "何时调用" section');
  }
  if (!text.includes("RETURNS") && !text.includes("返回")) {
    violations.push('missing "RETURNS" / "返回" section');
  }

  // 长度检查(中文信息密度高,阈值放宽)
  const minLength = language === "zh" ? 80 : 150;
  const maxLength = language === "zh" ? 500 : 800;
  if (text.length < minLength) {
    violations.push(
      `description too short (${text.length} < ${minLength} chars)`,
    );
  }
  if (text.length > maxLength) {
    violations.push(
      `description too long (${text.length} > ${maxLength} chars)`,
    );
  }

  // 禁止术语检查(truthScore 在 engram_get 例外)
  const isEngramGet = name === "engram_get";
  for (const term of FORBIDDEN_TERMS) {
    if (term === "truthScore" && isEngramGet) continue;
    if (text.includes(term)) {
      violations.push(`forbidden term "${term}"`);
    }
  }

  return violations;
}
