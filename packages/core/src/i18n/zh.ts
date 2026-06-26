/**
 * 简体中文翻译
 *
 * 注意:本文件用 `as const satisfies Readonly<Record<string, string>>`,
 * **不**显式标注 TranslationDict 类型——这是为了让 i18n/types.ts
 * 反向推导 StringKey 联合类型(避免循环依赖)。新增 key 必须同步补 en.ts,
 * 否则 en.ts 的 TranslationDict 标注会让缺 key 在编译期失败。
 *
 * @module @co-engram/core/i18n
 */

export const zh = {
  // ===== Engram 工具(12 个) =====
  "tool.engram_create":
    "创建一个新的 Engram(记忆单元)。需要 title / content / kind / domainTags / createdBy。默认开启智能去重(dedupe=true):DUPLICATE 时强化原 engram 不重复创建;UPDATE 时合并;NEW 时正常创建。",
  "tool.engram_get":
    "按披露层级(catalog / digest / content / meta / synapses / auto)读取 Engram。auto 模式按 contextBudget 自动选 tier。",
  "tool.engram_update":
    "更新 Engram 的字段(content / title / importance / 等)。",
  "tool.engram_delete": "删除 Engram(content + meta + synapses 三文件一起删)。",
  "tool.engram_search": "FTS 全文检索(中文 bigram + 英文 word),可选过滤器。",
  "tool.engram_list":
    "按过滤器列出 Engram(无查询,按元数据过滤,直接读最新数据)。",
  "tool.engram_reinforce":
    "上报一次有效检索(LTP 强化 + Hebbian 关联强化)。更新 effectiveRetrievals / reinforcementScore / importance(每次 += effectiveness × 0.02,clamp [0,1]);邻居 engram 得到 50% 增益(contradicts 除外)。",
  "tool.engram_report_failure":
    "上报一次失败使用(LTD 削弱)。更新 failedUses / retrievalCount / importance(单次 -0.03,超阈值后 ×1.5 升级)。failedUses≥3 建议 archive,≥5 建议 forget。",
  "tool.engram_archive":
    "归档 engram(移出默认检索,但保留数据可恢复)。检索默认排除 archived,可用 filter 包含。",
  "tool.engram_restore":
    "从 archived/forgotten 恢复为 active,重新进入默认检索。若 engram 已被 sweep 到 .trash/,会先从回收站移回再恢复。",
  "tool.engram_forget":
    "主动遗忘 engram(RIF 检索诱导遗忘)。文件保留(Git 可追溯),立即移出所有默认检索。需要 reason。后续默认流程:forgotten 30 天后 sweep 到 .trash/ 回收站(主索引移除),再 365 天后物理删除(rm);任意时刻可通过 engram_restore 或 viewer 回收站恢复,物理删除后只能从 git 历史找回。",
  "tool.engram_recompute_importance":
    "重新计算 engram 的多维重要性(personal/team/project/network/temporal)。network 和 temporal 由系统派生(incomingSynapseCount + 艾宾浩斯衰退),其余可通过 overrides 手动设置。结果 composite 写回 engram.importance。",

  // ===== 学习回路工具(4 个) =====
  "tool.contradiction_resolve":
    "人工裁决一个 contradicts synapse(spec §3.9 阶段 2 人工介入)。必须给 verdict + rationale + resolvedBy。系统会自动把 synapse.resolutionState 标记为 resolved 并记录到 evidence 数组。",
  "tool.close_learning_loop":
    "闭合学习回路(多巴胺闭环):把使用结果反馈到系统。success/partial → LTP 强化 + Hebbian 邻居强化;failure → LTD 削弱 + 触发降级阈值检查。同步触发 Provenance 奖惩回路(如已配置)。",
  "tool.upgrade_verification":
    "升级 engram 的验证状态(unverified → plausible → probable → verified → refuted)。必须给出证据说明 + 验证人。系统会校验状态机(不允许跳级)+ 三维证据条件(evidenceCount + 跨情境 domainTags + 时间稳定天数)。force=true 可跳过条件检查但保留状态机校验(人工裁决场景)。",
  "tool.get_evolution_lineage":
    "追溯 engram 的进化血统(spec §12.7 场景 6)。沿 derives_from / consolidates / supersedes synapse 双向追溯:ancestors = 来源(observation 等),descendants = 演化结果(pattern/procedure 等)。返回 DAG 节点和边,可用于 Graph View 可视化。spec §4.6 验收:从 Skill 可反向追溯到原 observation 的完整链路。",

  // ===== Synapse 工具(4 个) =====
  "tool.synapse_create":
    "在两个 Engram 之间创建 Synapse(连接)。自动更新双方的 incoming/outgoing 缓存。",
  "tool.synapse_get": "读取单条 Synapse(通过 from engramId + synapseId)。",
  "tool.synapse_delete": "删除一条 Synapse(同步更新双方缓存)。",
  "tool.synapse_list": "列出某 Engram 的所有 Synapses(出边 / 入边 / 双向)。",

  // ===== Skill 工具(2 个) =====
  "tool.skill_get":
    "读取 Skill 元信息(程序性记忆)。P0 阶段从内存 registry 读取。",
  "tool.skill_invoke":
    "调用一个 Skill(程序性记忆)。P0 阶段是框架;具体模板执行(tool-sequence / prompt-template)在 P1 实现。",

  // ===== 候选提案工具(3 个) =====
  "tool.engram_list_proposals":
    "列出主题候选提案。当某主题在对话中被多次提及但无匹配 engram 时,系统会生成 pending 提案等待确认。默认只返回 pending;传 includeAll=true 可查看历史 accepted/dismissed。",
  "tool.engram_accept_proposal":
    "接受一个候选提案 → 系统自动创建对应 engram,并把提案标记为 accepted。后续相同主题不会再产生重复提案。",
  "tool.engram_dismiss_proposal":
    "拒绝一个候选提案。默认 30 天内不再提示;可通过 dismissDays 自定义冷却期。可填 reason 便于元学习。",

  // ===== 仓库健康工具(2 个) =====
  "tool.engram_doctor":
    "对记忆仓库做一次自愈扫描。自动修复文件移动、标题重命名、过期索引项;报告 dangling synapse 引用和孤儿 markdown 供人工处理。",
  "tool.engram_list_paths":
    "列出记忆仓库的物理目录树,每节点带累计 engramCount,用于搜索前的渐进式披露。",

  // ===== OpenClaw 兼容 memory 工具(2 个) =====
  "tool.memory_search":
    "用自然语言搜索团队记忆(engram)。返回相关记忆片段及相关性分数。当用户询问过往决策、偏好、人名、日期或项目细节时调用。",
  "tool.memory_get":
    "按 ID 读取单条记忆(engram)的完整内容。返回 content、metadata(含 importance、truthScore、reinforcementCount)和相关记忆 ID。在 memory_search 之后用来查看细节。",

  // ===== 系统提示词(buildProposalPrompt) =====
  "prompt.proposal_prompt":
    "[co-engram] ${count} 个候选记忆待处理(主题被提及 ≥3 次但尚未入库)。使用 `engram_list_proposals` 查看,`engram_accept_proposal` 入库,或 `engram_dismiss_proposal` 忽略。",

  // ===== Memory section 提示词(OpenClaw registerMemoryCapability.promptBuilder) =====
  "prompt.memory.section_header": "## 记忆召回 (co-engram)",
  "prompt.memory.when_to_search":
    '何时调用 memory_search:用户问"关于 X 的记忆 / 我们之前讨论过 X 吗 / 找一下 X"等语义检索场景。memory_search 的 query 是搜索词(如 "low-friction-defaults" "调试 ADB"),不是"列出所有"的指令——空 query 会报错。先调 memory_search,再按需调 memory_get 获取完整内容。',
  "prompt.memory.when_to_list":
    '何时调用 engram_list(列举场景):用户问"我有哪些记忆 / 列出所有记忆 / 显示我的记忆库 / 记忆总数"时,使用 engram_list 工具(分页+过滤),不要用 memory_search。memory_search 是按关键词召回相关性,列举全部需要 engram_list。可选 filter:domainTags(领域标签)、kind(fact/pattern/procedure/observation)、status(active/archived)。',
  "prompt.memory.when_not_to_search":
    "何时不调用:通用知识问题、与团队上下文无关的纯代码问题、简单问候。当前对话已回答过的话题不要重复搜索。",
  "prompt.memory.reading_results":
    "结果解读:每条记忆含 truthScore(0-1)。truthScore < 0.4 的记忆需谨慎对待,可考虑在验证后调用 close_learning_loop。回答中引用记忆时附上 engram ID(如 [engram_abc123])便于用户核查来源。",
  "prompt.memory.writing":
    '创建/更新记忆(engram_create / engram_update)时:createdBy 留空让系统自动用 git user.name 或 plugin config.defaultCreatedBy 作为作者标识。**不要主动填 "AIOS" / "openclaw" / "assistant" / "system" 等通用词**——这些不是真实作者,会让 audit log 失去追溯价值。仅当用户明确要求特定作者标识(如团队名、外部系统名)时才显式传 createdBy。',
  "prompt.memory.when_to_reinforce":
    "何时调用 engram_reinforce:由你**自主判断**——当你引用的记忆确实帮助完成了任务、内容被实际采纳进答案、或成功指导了决策时,对该 engram 调 engram_reinforce(id, effectiveness) 强化。effectiveness 取值:1.0=完全有效、0.7=大部分有效、0.4=仅作为背景参考。引用错误或过时时调 engram_report_failure。co-engram 是自进化系统,你的强化信号是 importance 评分的关键输入——主动调用,不要等待用户提示。同时**诚实评估**:仅沾边不要给高分,过度强化会让低价值记忆淹没高价值记忆。",
  "prompt.memory.proposal_reminder":
    "待处理提案:${count} 条候选记忆待审阅。调用 engram_list_proposals 查看,engram_accept_proposal 入库,或 engram_dismiss_proposal 忽略。",
  "prompt.memory.frequent_topics":
    "当前 team-memory 的高频话题:${tags}。这些领域调用 memory_search 最有可能返回有用上下文。",
  "prompt.memory.missed_topics":
    "最近遗漏的话题(建议主动搜索):${topics}。历史对话显示这些话题本应触发 memory_search 但未触发。",
  "prompt.memory.low_confidence_topics":
    "频繁被检索但低置信度的话题:${topics}。可考虑 close_learning_loop 或 upgrade_verification 来强化这些记忆。",

  // ===== 查看器 UI =====
  "viewer.title": "Co-Engram",
  "viewer.slogan": "自进化的团队记忆",
  "viewer.tab.stats": "统计",
  "viewer.tab.engrams": "记忆印迹",
  "viewer.tab.graph": "记忆突触",
  "viewer.tab.proposals": "记忆提案",
  "viewer.tab.audit": "审计",
  "viewer.tab.trash": "记忆回收站",
  "viewer.tab.config": "配置",
  "viewer.tab.help": "帮助",
  "viewer.search.placeholder": "全文检索记忆印迹...",
  "viewer.search.button": "搜索",
  "viewer.search.clear": "清空",
  "viewer.search.clear_title": "清空搜索结果,回到统计默认视图",
  "viewer.auth.prompt": "此查看器需要 token。",
  "viewer.auth.placeholder": "Bearer token",
  "viewer.loading.stats": "加载统计中...",
  "viewer.loading.engrams": "加载记忆印迹中...",
  "viewer.loading.graph": "加载图谱中...",
  "viewer.loading.proposals": "加载提案中...",
  "viewer.loading.audit": "加载审计日志中...",
  "viewer.loading.trash": "加载记忆回收站中...",
  "viewer.loading.config": "加载配置中...",
  "viewer.section.proposals": "候选提案",
  "viewer.section.audit": "审计日志",
  "viewer.section.trash": "记忆回收站",
  "viewer.section.engrams": "记忆印迹",
  "viewer.section.graph": "图谱",
  "viewer.footer": "Co-Engram 查看器 — 仅本机回环 (127.0.0.1)",

  // ===== CLI =====
  "cli.init.welcome": "欢迎使用 Co-Engram。让我们初始化你的 team-memory 仓库。",
  "cli.init.data_root_prompt": "team-memory 放在哪里?(绝对路径)",
  "cli.init.data_root_default": "默认:$HOME/team-memory",
  "cli.init.language_prompt":
    "请选择工具描述、查看器界面和系统提示词使用的语言:",
  "cli.init.language_option_en": "English (推荐国际团队使用)",
  "cli.init.language_option_zh": "简体中文 (推荐中文团队使用)",
  "cli.init.created_by_prompt": "新建 engram 的默认作者标识(例如你的名字):",
  "cli.init.dir_exists": "目录已存在,复用。",
  "cli.init.dir_created": "目录已创建。",
  "cli.init.git_initialized": "已初始化 Git 仓库。",
  "cli.init.git_skipped": "已是 Git 仓库,跳过 git init。",
  "cli.init.config_written": "配置已写入 ${path}。",
  "cli.init.next_steps": "下一步:",
  "cli.init.next_step_mcp":
    "  接入 Claude Code:claude mcp add co-engram -e CO_ENGRAM_DATA_ROOT=${path} --scope user -- co-engram-mcp",
  "cli.init.next_step_openclaw":
    "  接入 OpenClaw:把 @co-engram/openclaw 装到 extensions/,并设置 plugins.entries.co-engram.config.dataRoot=${path}",
  "cli.init.done": "完成。开始你的记忆之旅吧!",
  "cli.init.aborted": "已取消。",
  "cli.init.invalid_language": "无效的语言选择,默认使用英文。",
  "cli.init.help_title": "Co-Engram init — 初始化 team-memory 仓库",
  "cli.init.help_usage": "用法:co-engram init [选项]",
  "cli.init.help_path":
    "  --path <路径>       目标目录(默认:$HOME/team-memory)",
  "cli.init.help_language":
    "  --language <语言>   语言:en | zh(默认:en,或省略此参数进入交互式)",
  "cli.init.help_created_by": "  --created-by <名字> 默认作者标识(默认:$USER)",
  "cli.init.help_no_git": "  --no-git            跳过 git init",
  "cli.init.help_force":
    "  --force             覆盖已有的 .co-engram/config.json",
  "cli.init.help_help": "  -h, --help          显示此帮助",
  "cli.init.language_set_env":
    "(运行时可通过 CO_ENGRAM_LANGUAGE=zh|en 临时覆盖)",

  // ===== 详情面板 i18n(viewer runtime 使用) =====
  // 枚举显示(enum.<分类>.<值>)
  "enum.kind.observation": "观察",
  "enum.kind.fact": "事实",
  "enum.kind.pattern": "模式",
  "enum.kind.procedure": "流程",
  "enum.kind.hypothesis": "假设",

  "enum.freshness.fresh": "鲜活",
  "enum.freshness.aging": "渐衰",
  "enum.freshness.stale": "过时",
  "enum.freshness.forgotten": "遗忘",

  "enum.status.draft": "草稿",
  "enum.status.active": "激活",
  "enum.status.archived": "归档",
  "enum.status.forgotten": "遗忘",

  "enum.sourceType.firsthand": "一手",
  "enum.sourceType.secondhand": "二手",
  "enum.sourceType.inferred": "推断",

  "enum.emotionalValence.positive": "正向",
  "enum.emotionalValence.neutral": "中性",
  "enum.emotionalValence.negative": "负向",

  "enum.verificationStatus.unverified": "未验证",
  "enum.verificationStatus.plausible": "似真",
  "enum.verificationStatus.probable": "较可能",
  "enum.verificationStatus.verified": "已验证",
  "enum.verificationStatus.refuted": "已驳回",

  // 字段标签(field.label.<name>)
  "field.label.id": "ID:",
  "field.label.title": "标题:",
  "field.label.domainTags": "领域标签:",
  "field.label.contextTags": "上下文标签:",
  "field.label.content": "内容",
  "field.label.stats": "统计",
  "field.label.retrievals": "检索:",
  "field.label.effective": "有效:",
  "field.label.failures": "失败:",
  "field.label.creator": "创建者:",
  "field.label.time": "时间:",
  "field.label.confidence": "置信度:",
  "field.label.status": "状态:",
  "field.label.freshness": "新鲜度:",
  "field.label.importance": "重要性:",
  "field.label.valueAssessment": "价值评估",
  "field.label.multiDimImportance": "多维重要性",
  "field.label.encodingContext": "记忆产生情境",
  "field.label.encodingContextValue": "记忆产生情境:",
  "field.label.perspective": "视角:",
  "field.label.decayProgress": "衰退进度",
  "field.label.evidenceCount": "证据数:",
  "field.label.lastEffective": "最近有效:",
  "field.label.reinforcementScore": "强化分数:",
  "field.label.emotionalValence": "情感极性:",
  "field.label.sourceType": "来源类型:",
  "field.label.verificationStatus": "验证状态:",
  "field.label.decayHalfLife": "衰退半衰期:",

  // 区段标题(section.<name>)
  "section.content": "内容",
  "section.stats": "统计",
  "section.valueAssessment": "价值评估",
  "section.multiDimImportance": "多维重要性",
  "section.encodingContext": "记忆产生情境",

  // 动作按钮(action.<name>)
  "action.edit": "编辑",
  "action.delete": "删除",
  "action.close": "关闭",
  "action.detailView": "详情视图",

  // 通用文案(common.<name>)
  "common.none": "无",
  "common.never": "从未",
  "common.unknown": "未知",
  "common.totalCount": "共 ${n} 条",

  // 衰退可视化(decay.<name>)
  "decay.daysToNext": "距下次降级还剩 ${days} 天",
  "decay.forgotten": "已遗忘",
  "decay.neverDecays": "永不衰退",
  "decay.neverDecaysTip":
    "该记忆 decayHalfLifeDays=null,系统不跟踪其衰退进度。",
  "decay.neverEffective": "尚未被有效使用",
  "decay.neverEffectiveTip":
    "该记忆自创建以来未触发过正向强化(engram_reinforce / close_learning_loop success),系统暂无 lastEffectiveAt 时间戳,无法计算衰退进度。被有效使用后将自动开始跟踪。",
  "decay.levelLabel": "当前:${level}",

  // 列表视图(engrams.<area>.<name>)
  "engrams.searchPlaceholder": "按标题或标签搜索...",
  "engrams.filter.kind": "类型",
  "engrams.filter.kindAll": "全部",
  "engrams.filter.sort": "排序",
  "engrams.filter.sortNewest": "最新优先",
  "engrams.filter.sortOldest": "最早优先",
  "engrams.filter.sortImportance": "重要性 ↓",
  "engrams.filter.sortRetrievals": "检索次数 ↓",
  "engrams.view.card": "卡片",
  "engrams.view.tree": "目录",
  "engrams.countTotal": "共 ${n} 条",
  "engrams.countFiltered": "显示 ${shown} / ${total} 条",
  "engrams.empty": "没有匹配的记忆",
  "engrams.retrievalsCount": "检索 ${n}",
  "engrams.untagged": "未分类",
} as const satisfies Readonly<Record<string, string>>;
