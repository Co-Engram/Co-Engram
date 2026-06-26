/**
 * 列举记忆意图检测
 *
 * 用于 before_prompt_build hook:当用户 prompt 明显是"列举我的记忆"场景时,
 * 通过 appendSystemContext 直接注入实际的 engram 列表(markdown),与
 * workspace MEMORY.md 平等竞争——避免 agent 因为看到 workspace MEMORY.md
 * 现成内容而绕开 co-engram 工具调用。
 *
 * 检测策略:保守正则匹配。只在非常明确的列举意图下触发,避免对正常
 * query 误注入(那样会污染 prompt + 损 prompt cache)。
 *
 * @module @co-engram/openclaw/list-intent
 */

const LIST_INTENT_PATTERNS: readonly RegExp[] = [
  // 中文:列举/显示/列出 + 记忆/记忆库/记忆库
  /我有哪些记忆/,
  /列出.*记忆/,
  /列出.*engram/,
  /显示.*记忆/,
  /显示.*engram/,
  /列举.*记忆/,
  /列举.*engram/,
  /查看.*记忆库/,
  /看看.*记忆/,
  /记忆库.*有什么/,
  /记忆库.*有哪些/,
  /记忆库.*内容/,
  /记忆总数/,
  /多少.*记忆/,
  /所有记忆/,
  // 英文
  /\bwhat.*memor(y|ies)\b.*(?:do i have|have|i)\b/i,
  /\blist.*memor(y|ies)\b/i,
  /\bshow.*memor(y|ies)\b/i,
  /\ball memori?es?\b/i,
  /\bhow many memori?es?\b/i,
];

/**
 * 检测 prompt 是否为列举记忆意图
 *
 * @returns true 如果是明确的列举场景
 */
export function isListMemoryIntent(prompt: string): boolean {
  if (!prompt || typeof prompt !== "string") return false;
  // 只看 prompt 的前 500 字符(避免长 prompt 触发误判)
  const head = prompt.slice(0, 500);
  return LIST_INTENT_PATTERNS.some((re) => re.test(head));
}
