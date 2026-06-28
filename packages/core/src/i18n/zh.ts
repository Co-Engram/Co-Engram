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
    '创建/更新记忆(engram_create / engram_update)时:createdBy 留空让系统自动用 git user.name 作为作者标识。**不要主动填 "claude-code" / "openclaw" / "AIOS" / "assistant" / "system" 等工具名或通用词**——团队里人人都用 Claude Code,标 "claude-code" 等于没标作者,audit log 失去追溯价值。createdBy 标记的是"人",不是"工具"。仅当用户明确要求特定作者标识(如团队名、外部系统名)时才显式传 createdBy。',
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
  "viewer.tab.merges": "合并",
  "viewer.search.placeholder": "全文检索记忆印迹...",
  "viewer.search.button": "搜索",
  "viewer.search.clear": "清空",
  "viewer.search.clear_title": "清空搜索结果,回到统计默认视图",
  "viewer.search.searching": "搜索中...",
  "viewer.search.noResults": "无匹配结果",
  "viewer.search.failed": "搜索失败:${err}",
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

  // ===== 扩展枚举(替代 viewer 旧 CO_ENGRAM_LABELS) =====
  "enum.status.dormant": "休眠",
  "enum.visibility.public": "公开",
  "enum.visibility.team": "团队",
  "enum.visibility.private": "私有",
  "enum.visibility.restricted": "受限",
  "enum.family.structural": "结构",
  "enum.family.causal": "因果",
  "enum.family.evidential": "证据",
  "enum.family.temporal": "时间",
  "enum.family.modulatory": "调节",
  "enum.synapseKind.extends": "扩展",
  "enum.synapseKind.part_of": "部分",
  "enum.synapseKind.similar_to": "相似",
  "enum.synapseKind.depends_on": "依赖",
  "enum.synapseKind.causes": "导致",
  "enum.synapseKind.follows": "顺承",
  "enum.synapseKind.derives_from": "派生",
  "enum.synapseKind.contradicts": "矛盾",
  "enum.synapseKind.exemplifies": "例证",
  "enum.synapseKind.supersedes": "取代",
  "enum.synapseKind.consolidates": "整合",
  "enum.synapseKind.contextualizes": "上下文",
  "enum.synapseDirection.directional": "单向",
  "enum.synapseDirection.bidirectional": "双向",
  "enum.resolution.pending": "待处理",
  "enum.resolution.auto_resolved": "已自动裁决",
  "enum.resolution.escalated": "已升级",
  "enum.resolution.contested": "有争议",
  "enum.resolution.resolved": "已解决",

  // ===== Stats 面板(viewer.stats.*) =====
  "viewer.stats.totalEngrams": "记忆印迹总数",
  "viewer.stats.totalSynapses": "记忆突触总数",
  "viewer.stats.pendingProposals": "待审提案",
  "viewer.stats.clickToViewAll": "点击查看全部",
  "viewer.stats.clickToViewGraph": "点击查看图谱",
  "viewer.stats.clickToHandle": "点击处理",
  "viewer.stats.kindDistribution": "记忆印迹 · 按类型分布",
  "viewer.stats.statusDistribution": "记忆印迹 · 按状态分布",
  "viewer.stats.synapseKindDistribution": "记忆突触 · 按类型分布",
  "viewer.stats.contributorRanking": "贡献者排名 · 印迹 + 突触合计",
  "viewer.stats.topTags": "高频领域标签",
  "viewer.stats.contributorCol": "贡献者",
  "viewer.stats.engramCol": "印迹",
  "viewer.stats.synapseCol": "突触",
  "viewer.stats.totalCol": "合计",
  "viewer.stats.empty": "暂无数据",
  "viewer.stats.synapsesEmpty": "暂无突触",

  // ===== Proposals 面板(viewer.proposals.*) =====
  "viewer.proposals.disabledHint":
    "提案引擎未启用。在配置面板打开 proposal 开关,或编辑 config.json 中的 proposals.enabled=true。",
  "viewer.proposals.status.pending": "待审",
  "viewer.proposals.status.accepted": "已采纳",
  "viewer.proposals.status.dismissed": "已驳回",
  "viewer.proposals.status.all": "全部",
  "viewer.proposals.empty": "没有 ${status} 提案",
  "viewer.proposals.convertedTo": "已转",
  "viewer.proposals.dismissedReason": "驳回",
  "viewer.proposals.detailTitle": "候选提案详情",
  "viewer.proposals.titleLabel": "标题",
  "viewer.proposals.titleLabelReadonly": "标题(只读)",
  "viewer.proposals.kindLabel": "类型",
  "viewer.proposals.kindLabelReadonly": "类型(只读)",
  "viewer.proposals.tagsLabel": "领域标签(逗号分隔)",
  "viewer.proposals.tagsLabelReadonly": "领域标签(逗号分隔,只读)",
  "viewer.proposals.tagsPlaceholder": "如:frontend, dark-mode, css",
  "viewer.proposals.contentLabel": "内容(转成记忆印迹的正文)",
  "viewer.proposals.contentLabelReadonly": "内容(只读)",
  "viewer.proposals.samples": "样本引用(${n} 次累积)",
  "viewer.proposals.noSamples": "(无样本)",
  "viewer.proposals.firstSeen": "首次见到:",
  "viewer.proposals.lastSeen": "最后见到:",
  "viewer.proposals.currentStatus": "该提案当前状态:",
  "viewer.proposals.createdEngram": "已创建记忆印迹:",
  "viewer.proposals.dismissedUntil": "驳回至:",
  "viewer.proposals.dismissBtn": "驳回",
  "viewer.proposals.acceptBtn": "采纳并保存",
  "viewer.proposals.notFound": "提案未找到:${id}",
  "viewer.proposals.titleRequired": "请填写标题",
  "viewer.proposals.contentRequired": "请填写内容",
  "viewer.proposals.acceptedToast": "✓ 已采纳",
  "viewer.proposals.createdEngramToast": "创建记忆印迹:${id}",
  "viewer.proposals.acceptFailed": "采纳失败:${err}",
  "viewer.proposals.dismissReasonPrompt": "驳回理由(可选):",
  "viewer.proposals.dismissDaysPrompt": "驳回 N 天(默认 30):",
  "viewer.proposals.dismissFailed": "驳回失败:${err}",

  // ===== Audit 面板(viewer.audit.*) =====
  "viewer.audit.filter.actor": "发起者",
  "viewer.audit.filter.category": "类别",
  "viewer.audit.filter.engramPlaceholder": "按记忆印迹编号过滤...",
  "viewer.audit.filter.actionChipTitle": "点击清除 action 过滤",
  "viewer.audit.actorAll": "全部",
  "viewer.audit.actorUser": "用户",
  "viewer.audit.actorLlm": "LLM",
  "viewer.audit.actorSystem": "系统",
  "viewer.audit.catAll": "全部",
  "viewer.audit.catState": "状态变更",
  "viewer.audit.catEffective": "有效性",
  "viewer.audit.catContradicted": "矛盾",
  "viewer.audit.catProposal": "提案",
  "viewer.audit.empty": "没有匹配的事件",
  "viewer.audit.disabledHint": "审计日志未启用。",
  "viewer.audit.kpi.total": "总计",
  "viewer.audit.kpi.state": "状态变更",
  "viewer.audit.kpi.effective": "有效性信号",
  "viewer.audit.kpi.contradicted": "矛盾",
  "viewer.audit.kpi.proposal": "提案",
  "viewer.audit.synapseChip": "突触",
  "viewer.audit.targetOpenEngram": "📄 打开印迹",
  "viewer.audit.targetOpenSourceEngram": "🌐 打开源印迹",
  "viewer.audit.targetGone": "目标已不存在:${id}",
  "viewer.audit.targetDeleted": "(已删除)",
  "viewer.audit.filterActionHint": " — 点击仅显示此类事件",
  "viewer.audit.metaEmpty": "—",
  "viewer.audit.noFieldChanges": "(无字段实际变化)",
  "viewer.audit.actorTip.user": "用户 (user):由人工触发的事件",
  "viewer.audit.actorTip.llm": "LLM (llm):由语言模型 agent 触发的事件",
  "viewer.audit.actorTip.system": "系统 (system):由后台维护/自愈流程触发的事件",
  "viewer.audit.actionTip.create": "create:创建新记忆印迹",
  "viewer.audit.actionTip.update": "update:修改已有印迹的字段",
  "viewer.audit.actionTip.update_lifecycle": "update_lifecycle:状态迁移(archived/forgotten)",
  "viewer.audit.actionTip.reinforce": "reinforce:强化(LTP)— 检索有效、闭环成功",
  "viewer.audit.actionTip.report_failure": "report_failure:负向反馈(LTD)— 检索不准、闭环失败",
  "viewer.audit.actionTip.forget": "forget:标记为 forgotten",
  "viewer.audit.actionTip.restore": "restore:从 forgotten/archived 恢复为 active",
  "viewer.audit.actionTip.sweep_to_trash": "sweep_to_trash:forgotten 满 30 天,文件移到 .trash/",
  "viewer.audit.actionTip.restore_from_trash": "restore_from_trash:从 .trash/ 物理恢复",
  "viewer.audit.actionTip.purge": "purge:硬删除(内容 + 元 + 关联突触)",
  "viewer.audit.actionTip.retrieve_hit": "retrieve_hit:搜索命中",
  "viewer.audit.actionTip.retrieve_effective": "retrieve_effective:命中后被实际采用",
  "viewer.audit.actionTip.retrieve_inconclusive": "retrieve_inconclusive:命中但不确定是否有效",
  "viewer.audit.actionTip.contradicted": "contradicted:检测到与其他印迹冲突,进入裁决流程",
  "viewer.audit.actionTip.propose": "propose:捕获到候选记忆",
  "viewer.audit.actionTip.accept": "accept:采纳候选,转化为正式印迹",
  "viewer.audit.actionTip.dismiss": "dismiss:驳回候选",

  // ===== Trash 面板(viewer.trash.*) =====
  "viewer.trash.empty": "回收站为空",
  "viewer.trash.titleCount": "回收站 · 共 ${n} 条",
  "viewer.trash.partitionLabel": "分区:",
  "viewer.trash.all": "全部",
  "viewer.trash.purgeAllBtn": "永久清空全部",
  "viewer.trash.colId": "ID",
  "viewer.trash.colPartition": "分区",
  "viewer.trash.colTrashedAt": "回收时间",
  "viewer.trash.previewBtn": "查看",
  "viewer.trash.restoreBtn": "恢复",
  "viewer.trash.previewTitle": "回收站预览",
  "viewer.trash.previewHint": "此记忆已被移出主索引,需先「恢复」才能再次编辑或召回。",
  "viewer.trash.partitionField": "分区:",
  "viewer.trash.trashedAtField": "回收时间:",
  "viewer.trash.creatorField": "创建者:",
  "viewer.trash.contentSection": "内容",
  "viewer.trash.restoreToMainBtn": "恢复到主索引",
  "viewer.trash.closeBtn": "关闭",
  "viewer.trash.restoreConfirm": "恢复 ${id} 到主索引?",
  "viewer.trash.restoreFailed": "恢复失败:${err}",
  "viewer.trash.purgeAllScopeAll": "全部(跨所有分区)",
  "viewer.trash.purgeAllScopePartition": "分区 ${p} 内",
  "viewer.trash.prescanFailed": "预扫描失败:${err}",
  "viewer.trash.purgeEmpty": "当前范围无内容可清空",
  "viewer.trash.purgeConfirm1":
    "即将永久删除 ${scope} 的 ${n} 条记忆。\n此操作不可撤销(物理 unlink),即使有 git 仓库也只能从历史 commit 恢复。\n\n确认继续?",
  "viewer.trash.purgeConfirm2": "二次确认:真的清空 ${scope} 的全部 ${n} 条?",
  "viewer.trash.purgeDone": "已永久删除 ${n} 条记忆。",
  "viewer.trash.purgeFailed": "清空失败:${err}",

  // ===== Merges 面板(viewer.merges.*) =====
  "viewer.merges.loading": "加载合并统计中",
  "viewer.merges.auditDisabledHint": "audit log 未启用,无合并数据。",
  "viewer.merges.title": "合并统计 · 最近 ${days} 天",
  "viewer.merges.kpi.totalMerges": "总合并",
  "viewer.merges.kpi.autoResolved": "自动解决",
  "viewer.merges.kpi.escalatedToMarkers": "升级到冲突标记",
  "viewer.merges.kpi.backupFailures": "Backup 失败",
  "viewer.merges.llmSection": "LLM 仲裁",
  "viewer.merges.llm.totalInvocations": "总调用",
  "viewer.merges.llm.arbitrated": "成功",
  "viewer.merges.llm.escalated": "升级",
  "viewer.merges.llm.failed": "失败",
  "viewer.merges.llm.successRate": "成功率",
  "viewer.merges.byStrategy": "解决策略分布(Top 8)",
  "viewer.merges.hotPaths": "冲突热点路径(Top 8)",
  "viewer.merges.byDay": "每日合并量(趋势)",
  "viewer.merges.anomalyBanner": "异常告警 · ${n} 条",

  // ===== Graph 工具栏(viewer.graph.*) =====
  "viewer.graph.loading": "加载图谱中...",
  "viewer.graph.reloading": "重新加载图谱中",
  "viewer.graph.fitBtn": "适应视图",
  "viewer.graph.physicsBtn": "物理引擎",
  "viewer.graph.resetBtn": "重置过滤",
  "viewer.graph.fitTip": "适应视图:自动缩放并居中,让所有节点都可见",
  "viewer.graph.physicsTip":
    "物理引擎:开启时节点按弹簧/斥力模型自动布局(会消耗 CPU 直到稳定);关闭时冻结当前位置,适合大图稳定后浏览",
  "viewer.graph.resetTip": "重置过滤:恢复所有类型/族勾选,并重新适应视图",
  "viewer.graph.synapseGroupTitle": "突触类型 · 按族分类",
  "viewer.graph.engramsGroupTitle": "记忆印迹类型",
  "viewer.graph.family.structural": "结构族",
  "viewer.graph.family.causal": "因果族",
  "viewer.graph.family.evidential": "证据族",
  "viewer.graph.family.temporal": "时间族",
  "viewer.graph.family.modulatory": "调节族",
  "viewer.graph.familyDesc.structural": "描述知识间的组成/扩展关系",
  "viewer.graph.familyDesc.causal": "描述触发/依赖关系",
  "viewer.graph.familyDesc.evidential": "描述来源/冲突关系",
  "viewer.graph.familyDesc.temporal": "描述版本/演化关系",
  "viewer.graph.familyDesc.modulatory": "描述情境上下文关系",
  "viewer.graph.kindDesc.fact": "被确认成立、可独立验证的客观陈述",
  "viewer.graph.kindDesc.observation": "一次性感知到的事实,可能尚未沉淀为稳定结论",
  "viewer.graph.kindDesc.pattern": "从多次观察归纳出的规律,可预测未来行为",
  "viewer.graph.kindDesc.procedure": "步骤序列,执行后可复现某结果",
  "viewer.graph.kindDesc.hypothesis": "待验证的猜测;在反例出现前可作工作假设",
  "viewer.graph.synapseDesc.extends": "A 在 B 基础上扩展,继承 B 的语义并新增维度",
  "viewer.graph.synapseDesc.part_of": "A 是 B 的组成部分(B has-a A)",
  "viewer.graph.synapseDesc.similar_to": "A 与 B 语义相近,可互换或互援",
  "viewer.graph.synapseDesc.depends_on": "A 的成立依赖 B(B 是 A 的前置条件)",
  "viewer.graph.synapseDesc.causes": "A 触发或产生 B(正向因果)",
  "viewer.graph.synapseDesc.follows": "A 在时间/逻辑上跟随 B(无强因果)",
  "viewer.graph.synapseDesc.derives_from": "A 从 B 推导而来(B 是依据)",
  "viewer.graph.synapseDesc.contradicts": "A 与 B 相互冲突,进入裁决流程",
  "viewer.graph.synapseDesc.exemplifies": "A 是 B 的具体实例/样本",
  "viewer.graph.synapseDesc.supersedes": "A 取代过时的 B(版本更迭)",
  "viewer.graph.synapseDesc.consolidates": "A 合并/精炼了 B 的内容",
  "viewer.graph.synapseDesc.contextualizes": "A 为 B 提供情境背景(非因果、非证据)",

  // ===== 详情面板 / Drawer(viewer.detail.*) =====
  "viewer.detail.editModeHint": "编辑模式 · 修改后点击「保存」提交",
  "viewer.detail.editEngramTitle": "编辑记忆印迹",
  "viewer.detail.editSynapseTitle": "编辑记忆突触",
  "viewer.detail.detailViewTitle": "详情视图",
  "viewer.detail.synapseDetailTitle": "突触详情",
  "viewer.detail.kindChangeHint":
    "提示:修改「类型」或「方向」会让突触 ID 重新计算(因 ID 派生自 from+to+kind+direction),旧 ID 将失效,但所有元数据(权重/证据/创建者)会迁移到新 ID。",
  "viewer.detail.titleLabel": "标题",
  "viewer.detail.kindLabel": "类型",
  "viewer.detail.importanceLabel": "重要性 (0-1,可拖动滑块)",
  "viewer.detail.confidenceLabel": "置信度 (0-1,可拖动滑块)",
  "viewer.detail.tagsLabel": "领域标签(逗号分隔)",
  "viewer.detail.ctxTagsLabel": "上下文标签(逗号分隔)",
  "viewer.detail.visibilityLabel": "可见性",
  "viewer.detail.contentLabel": "内容(Markdown)",
  "viewer.detail.weightLabel": "权重 (0-1,可拖动滑块)",
  "viewer.detail.evidenceDescLabel": "新增证据描述(可选,留空则不追加)",
  "viewer.detail.evidenceSourceLabel": "证据来源(可选)",
  "viewer.detail.evidenceDescPlaceholder": "如:通过 codegraph 验证...",
  "viewer.detail.evidenceSourcePlaceholder": "如:manual / ci / docs",
  "viewer.detail.weightField": "权重:",
  "viewer.detail.directionField": "方向:",
  "viewer.detail.familyField": "所属族:",
  "viewer.detail.resolutionField": "裁决状态:",
  "viewer.detail.sourceToTargetField": "源 → 目标:",
  "viewer.detail.evidenceCount": "证据 (${n})",
  "viewer.detail.noEvidence": "无证据",
  "viewer.detail.confidenceEvidence": "置信度 ${n}",
  "viewer.detail.dim.personal": "个人:",
  "viewer.detail.dim.team": "团队:",
  "viewer.detail.dim.project": "项目:",
  "viewer.detail.dim.network": "网络:",
  "viewer.detail.dim.temporal": "时间:",
  "viewer.detail.dim.composite": "复合:",
  "viewer.detail.searching": "Searching...",
  "viewer.detail.searchNoMatch": "无匹配结果",
  "viewer.detail.searchFailed": "Search failed: ${err}",

  // ===== 配置面板(viewer.config.*) =====
  "viewer.config.sectionPersisted": "配置(重启生效)",
  "viewer.config.sectionRuntime": "运行时开关(下次启动生效)",
  "viewer.config.sectionMetadata": "仓库信息",
  "viewer.config.pendingBanner":
    "↻ ${fields} 已保存,重启 ${host} 后生效",
  "viewer.config.runtimeHintPrefix": "(当前: ",
  "viewer.config.runtimeHintSuffix": ")",
  "viewer.config.runtimeNotSet": "(未设置)",
  "viewer.config.field.language": "语言",
  "viewer.config.field.language.desc":
    "UI / 工具描述 / 提示词所用语言",
  "viewer.config.field.defaultCreatedBy": "默认创建者",
  "viewer.config.field.defaultCreatedBy.desc":
    "新记忆印迹的默认 createdBy 字段;留空回退到 git 身份",
  "viewer.config.field.defaultCreatedBy.placeholder": "(留空使用 git 作者)",
  "viewer.config.field.toolsProfile": "工具 Profile",
  "viewer.config.field.toolsProfile.desc":
    "LLM 可见工具数量:minimal=最小 / standard=标准 / full=全部",
  "viewer.config.field.dataRoot": "数据根目录",
  "viewer.config.field.dataRoot.desc":
    "记忆印迹/突触/审计的实际落盘位置。修改方式:在终端运行 <code>co-engram config data-root &lt;新路径&gt;</code>。",
  "viewer.config.field.configVersion": "配置版本",
  "viewer.config.field.createdAt": "创建时间",
  "viewer.config.field.updatedAt": "最后更新",
  "viewer.config.runtimeSection.hint":
    "这些开关把「下次启动时期望的状态」持久化到 config.json。当前正在运行的实例不会受影响——重启 ${host} 后,新值才会生效。",
  "viewer.config.runtimeSection.openclawExtra":
    " OpenClaw 模式下请在终端运行 <code>openclaw gateway restart</code>。",
  "viewer.config.runtime.audit": "审计日志",
  "viewer.config.runtime.audit.desc": "记录所有 API / 工具调用事件",
  "viewer.config.runtime.proposals": "提案引擎",
  "viewer.config.runtime.proposals.desc": "隐式捕获候选记忆待审批",
  "viewer.config.runtime.maintenance": "维护服务",
  "viewer.config.runtime.maintenance.desc": "后台 light/deep/rem 三阶段维护",
  "viewer.config.runtime.search": "搜索器",
  "viewer.config.runtime.search.desc": "语义 + 关键词检索",
  "viewer.config.runtime.viewer": "Web 查看器",
  "viewer.config.runtime.viewer.desc":
    "本页面所在 HTTP 服务(不可关闭,否则 UI 失联)",
  "viewer.config.dataRootReadOnly":
    "数据根目录已改为 CLI 单一入口:运行 <code>co-engram config data-root &lt;path&gt;</code> 修改。",
  "viewer.config.dataRootSave": "保存",
  "viewer.config.dataRootEditableHint":
    "修改数据根目录后需重启宿主生效。也可在终端运行 <code>co-engram config data-root &lt;path&gt;</code>。",
  "viewer.config.dataRootUpdatedRestartRequired":
    "数据根目录已更新。重启 {host} 后生效。",
  "viewer.config.dataRootUpdateFailed": "更新失败:{error}",
  "viewer.config.dataRootRejectEmpty": "路径不能为空。",
  "viewer.config.dataRootRejectNonEngram":
    "目录非空且不是 co-engram 仓库。请选空目录或现有 co-engram 仓库;如需强制接管非空目录,使用 CLI:<code>co-engram config data-root &lt;path&gt; --force</code>。",
  "viewer.config.saveBar.reset": "重置",
  "viewer.config.saveBar.save": "保存配置",
  "viewer.config.saveSuccess": "✓ 配置已保存。",
  "viewer.config.saveSuccessWithRestart":
    "✓ 配置已保存。以下改动需重启 ${host} 才能生效:",
  "viewer.config.restartBtn": "立即重启生效",
  "viewer.config.restartConfirmTitle": "确认重启 ${host}?",
  "viewer.config.restartConfirmBody":
    "  • 工具会短暂断开(几秒内自动重连)\n  • 浏览器会失联,本页面会在服务恢复后自动刷新\n  • 已保存的配置和 engram 数据不会丢失",
  "viewer.config.restartOpenclawHint":
    "OpenClaw 模式不支持从 viewer 自动重启。请在终端运行 <code>openclaw gateway restart</code>。",
  "viewer.config.restartMask.title": "⟳ 正在重启 ${host}…",
  "viewer.config.restartMask.body":
    "服务正在退出并由 ${parent} 重新拉起。页面会在恢复后自动刷新。",
  "viewer.config.restartTimeout.title": "重启超时(30s)",
  "viewer.config.restartTimeout.body":
    "请手动刷新页面;若 ${host} 仍未恢复,请检查 ${parent} 状态。",
  "viewer.config.restartTimeout.refreshBtn": "手动刷新",
  "viewer.config.restartBtnTip":
    "点击后 ${host} 会优雅退出(退出码 0),由父进程 ${parent} 自动重启。\n\n影响范围:\n  • 工具会短暂断开(几秒内自动重连,不影响正在进行的对话)\n  • 浏览器会失联,本页面会在服务恢复后自动刷新\n  • 维护线程、proposal 引擎等后台任务会以新配置重新启动\n\n不会丢失:\n  • 已保存的配置(刚刚写入 config.json)\n  • 已存在的 engram / synapse 数据(落盘持久化)\n  • 当前对话历史(由 ${parent} 持有,与服务重启无关)",
  "viewer.config.pendingField.language": "语言",
  "viewer.config.pendingField.toolsProfile": "工具 Profile",
  "viewer.config.pendingField.defaultCreatedBy": "默认创建者",
  "viewer.config.pendingField.audit": "审计日志",
  "viewer.config.pendingField.proposals": "提案引擎",
  "viewer.config.pendingField.maintenance": "维护服务",

  // ===== 通用文案(viewer.common.*) =====
  "viewer.common.loading": "加载中...",
  "viewer.common.loadFailed": "加载失败:${err}",
  "viewer.common.empty": "暂无数据",
  "viewer.common.save": "保存",
  "viewer.common.cancel": "取消",
  "viewer.common.edit": "编辑",
  "viewer.common.delete": "删除",
  "viewer.common.close": "关闭",
  "viewer.common.reset": "重置",
  "viewer.common.preview": "预览",
  "viewer.common.previewMode": "预览模式",
  "viewer.common.editMode": "编辑模式",
  "viewer.common.enabled": "启用",
  "viewer.common.disabled": "禁用",
  "viewer.common.enabledState": "已启用",
  "viewer.common.disabledState": "未启用",
  "viewer.common.restartToApply": "重启后生效",
  "viewer.common.confirmDeleteTitle": "确定删除?",
  "viewer.common.confirmDeleteEngram":
    "确定要删除「${title}」?\n此操作不可撤销。",
  "viewer.common.confirmDeleteSynapse":
    "确定删除此记忆突触?\n此操作不可撤销。",
  "viewer.common.saveFailed": "保存失败:${err}",
  "viewer.common.deleteFailed": "删除失败:${err}",
  "viewer.common.unknown": "(未知)",
  "viewer.common.langZh": "中文",
  "viewer.common.langEn": "English",

  // ===== Help 面板(viewer.help.*) =====
  "viewer.help.title": "Co-Engram · 自进化的团队记忆",
  "viewer.help.intro":
    "Co-Engram 把团队工作中的对话、决策、踩过的坑沉淀为<em>记忆印迹(engram)</em>,用<em>记忆突触(synapse)</em>把它们连成可演化的知识网络。模型在后续任务里通过 <code>memory_search</code> 召回相关记忆,引用有效时调 <code>engram_reinforce</code> 强化,出错时调 <code>engram_report_failure</code> 弱化——这套闭环让高价值记忆自动浮现、过时记忆自动衰减。",
  "viewer.help.conceptsTitle": "核心概念",
  "viewer.help.conceptEngram":
    "<strong>记忆印迹(engram)</strong>",
  "viewer.help.conceptEngramDesc":
    "一条结构化的记忆条目,含标题/内容/类型/标签/重要性/置信度等字段。类型分 5 种:<code>fact(事实)</code> <code>observation(观察)</code> <code>pattern(模式)</code> <code>procedure(流程)</code> <code>hypothesis(假设)</code>。鼠标悬停字段可以看到该字段的解释。",
  "viewer.help.conceptSynapse":
    "<strong>记忆突触(synapse)</strong>",
  "viewer.help.conceptSynapseDesc":
    "连接两个 engram 的有向边,分 5 个族:<code>结构族</code>(extends/part_of/similar_to)、<code>因果族</code>(depends_on/causes/follows)、<code>证据族</code>(derives_from/contradicts/exemplifies)、<code>时间族</code>(supersedes/consolidates)、<code>调节族</code>(contextualizes)。<code>contradicts</code> 会进入裁决流程。",
  "viewer.help.conceptImportance":
    "<strong>重要性(importance)与置信度(confidence)</strong>",
  "viewer.help.conceptImportanceDesc":
    "两个独立的 0-1 数值。重要性由强化信号 + 时间衰减派生,影响召回权重;置信度反映该记忆成立的可信程度(元认知评分),与重要性解耦。",
  "viewer.help.conceptVector":
    "<strong>多维重要性向量(importanceVector)</strong>",
  "viewer.help.conceptVectorDesc":
    "把重要性拆解为 personal/team/project/network/temporal 5 个维度,便于精细化调控。查看 engram 详情时如果存在,会显示在专门的段落里。",
  "viewer.help.conceptLifecycle":
    "<strong>生命周期</strong>",
  "viewer.help.conceptLifecycleDesc":
    "<code>draft → active → archived → forgotten</code>。遗忘的文件仍在仓库,但默认不召回。维护周期会自动评估并迁移状态。",
  "viewer.help.tabsTitle": "各 tab 用途",
  "viewer.help.tabStats":
    "<strong>统计</strong>—总览仪表盘:按类型/状态/族分布,显示团队贡献者和 top 标签。顶部搜索框做全文检索。",
  "viewer.help.tabEngrams":
    "<strong>记忆印迹</strong>—全部 engram 的卡片/目录视图,支持按 tag/kind/status 过滤,点击进入详情(可编辑/删除/查看突触)。",
  "viewer.help.tabGraph":
    "<strong>记忆突触</strong>—知识图谱可视化。可按族/类型过滤边,按 engram 类型过滤节点。打开 engram 详情时图谱会高亮其邻居。",
  "viewer.help.tabProposals":
    "<strong>记忆提案</strong>—候选记忆审批队列。系统从对话中提取候选,由人工/LLM 采纳(engram_accept_proposal)或忽略(engram_dismiss_proposal)。",
  "viewer.help.tabAudit":
    "<strong>审计</strong>—操作时间线,记录 create/update/reinforce/report_failure 等所有状态变更,便于追溯\"谁在何时改了什么\"。",
  "viewer.help.tabTrash":
    "<strong>记忆回收站</strong>—被删除的 engram 暂存处。可恢复单个,或一键清空(支持按分区筛选,永久删除前会 dryRun 预扫描条数 + 二次确认)。",
  "viewer.help.tabConfig":
    "<strong>配置</strong>—数据根目录、维护周期、自进化参数等。改持久化配置后需重启宿主生效。",
  "viewer.help.evolutionTitle": "记忆怎么自动进化",
  "viewer.help.evo1":
    "<strong>检索</strong>:agent 调 <code>memory_search</code>,FTS + 三因子打分召回 top-N。",
  "viewer.help.evo2":
    "<strong>引用</strong>:agent 把相关记忆内容写进答案,用户据此决策。",
  "viewer.help.evo3":
    "<strong>强化</strong>:agent 自主判断引用是否有效——有效调 <code>engram_reinforce</code>,出错调 <code>engram_report_failure</code>。",
  "viewer.help.evo4":
    "<strong>扩散</strong>:强化通过突触按 Hebbian 比例扩散到邻居(contradicts 除外)。",
  "viewer.help.evo5":
    "<strong>衰减</strong>:每个 engram 有 <code>decayHalfLifeDays</code>,importance 按 lastEffectiveAt + 半衰期指数衰减。",
  "viewer.help.evo6":
    "<strong>维护</strong>:后台周期跑 light/deep/rem 三阶段,完成\"巩固强化 → 衰减遗忘 → REM 抽象模式 → 触发元认知评分\"。",
  "viewer.help.tipsTitle": "提示",
  "viewer.help.tip1":
    "字段名旁的 <code>?</code> 图标(鼠标悬停)有该字段的简短解释。",
  "viewer.help.tip2":
    "详情视图的\"价值评估/多维重要性/记忆产生情境\"段落仅在 engram 携带相应字段时显示。",
  "viewer.help.tip3":
    "配置 tab 的修改默认写入持久化文件,重启宿主后生效。数据根目录既可在配置 tab 直接编辑保存,也可用 CLI <code>co-engram config data-root &lt;path&gt;</code> 修改(后者支持 <code>--force</code> 接管非空目录)。",
  "viewer.help.tip4":
    "遇到仓库不一致,可在 agent 中调 <code>engram_doctor</code> 自愈扫描。",

  // ===== 端口与数据根目录 =====
  "viewer.help.opsTitle": "端口与数据根目录",
  "viewer.help.opsPorts":
    "<strong>查看器端口</strong>:Claude Code(MCP)默认 <code>18799</code>,OpenClaw(plugin)默认 <code>18899</code>——两宿主同机运行不冲突。环境变量 <code>CO_ENGRAM_VIEWER_PORT</code> 可同时覆盖两宿主。持久化配置里的 <code>viewer.port</code> 已废弃(两宿主共享持久化文件会抢端口)。",
  "viewer.help.opsDataRoot":
    "<strong>数据根目录</strong>:在配置 tab 直接输入路径并保存,或用 CLI <code>co-engram config data-root &lt;path&gt;</code>。两者都写同一份 <code>~/.co-engram/config.json</code> bootstrap 配置,修改后需重启当前宿主生效。UI 出于安全只接受空目录或现有 co-engram 仓库;要接管非空非 co-engram 目录请走 CLI 加 <code>--force</code>。",

  // ===== Graph 面板(viewer.graph.*) =====
  "viewer.graph.renderFailed": "渲染失败:${err}",
  "viewer.graph.visLoadFailed": "vis-network 加载失败",
  "viewer.graph.empty": "暂无记忆印迹",
  "viewer.graph.tagsLabel": "标签:",
  "viewer.graph.familySuffix": "族",
  "viewer.graph.weightLabel": "权重",
  "viewer.graph.evidenceLabel": "证据",
  "viewer.graph.resolutionLabel": "裁决:",
  "viewer.graph.directionLabel": "方向:",
  "viewer.graph.clickToEdit": "点击编辑此突触",
  "viewer.graph.nodeDetailTitle": "节点详情",
  "viewer.graph.editInEngrams": "在记忆印迹中编辑",
  "viewer.graph.importanceShort": "重要性",
  "viewer.graph.summaryTitle": "摘要",
  "viewer.graph.statsTitle": "统计",
  "viewer.graph.retrievalLabel": "检索:",
  "viewer.graph.effectiveLabel": "有效:",
  "viewer.graph.failedLabel": "失败:",
  "viewer.graph.outgoingSynapses": "发出突触",
  "viewer.graph.incomingSynapses": "接收突触",
  "viewer.graph.familyGroupStructural": "结构族",
  "viewer.graph.familyGroupCausal": "因果族",
  "viewer.graph.familyGroupEvidential": "证据族",
  "viewer.graph.familyGroupTemporal": "时间族",
  "viewer.graph.familyGroupModulatory": "调节族",
  "viewer.graph.toolbar.filters": "过滤",
  "viewer.graph.toolbar.kinds": "节点类型",
  "viewer.graph.toolbar.synapseKinds": "突触类型",
  "viewer.graph.toolbar.reset": "重置视图",
  "viewer.graph.toolbar.fit": "适应窗口",
  "viewer.graph.toolbar.physics": "物理引擎",
  "viewer.graph.toolbar.fitTitle": "适应视图:自动缩放并居中,让所有节点都可见",
  "viewer.graph.toolbar.physicsTitle": "物理引擎:开启时节点按弹簧/斥力模型自动布局(会消耗 CPU 直到稳定);关闭时冻结当前位置,适合大图稳定后浏览",
  "viewer.graph.toolbar.resetTitle": "重置过滤:恢复所有类型/族勾选,并重新适应视图",
  "viewer.graph.synapseKindsTitle": "突触类型 · 按族分类",
  "viewer.graph.engramKindsTitle": "记忆印迹类型",

  // ===== Synapses 面板 / 突触详情(viewer.synapses.*) =====
  "viewer.synapses.kindChangeHint":
    "提示:修改「类型」或「方向」会让突触 ID 重新计算(因 ID 派生自 from+to+kind+direction),旧 ID 将失效,但所有元数据(权重/证据/创建者)会迁移到新 ID。",
  "viewer.synapses.deleteConfirm": "确定删除此记忆突触?\\n此操作不可撤销。",
  "viewer.synapses.kindField": "类型:",
  "viewer.synapses.idField": "ID:",
  "viewer.synapses.creatorField": "创建者:",
  "viewer.synapses.timeField": "时间:",
  "viewer.synapses.reloadingGraph": "重新加载图谱中",
  "viewer.synapses.directionDefault": "单向",

  // ===== 宿主相关(host.*) =====
  "host.label.mcp": "Claude Code",
  "host.label.openclaw": "OpenClaw",
  "host.process.mcp": "Claude Code",
  "host.process.openclaw": "OpenClaw",
  "host.gateway.openclaw": "OpenClaw gateway",
  "host.gateway.mcp": "MCP server",

  // ===== Tooltip 文案(tip.*)—— viewer 运行时通过 T.tip(key) 查询 =====
  // 注意:这部分中文很长,但与 viewer 运行时挂载的 TOOLTIPS 对象一一对应。
  // viewer app.ts 中 TOOLTIPS 仍是固定中文对象,后续若要做 tooltip i18n 可读这里。
  "tip.kind.fact":
    "事实 (fact):被确认成立、可独立验证的客观陈述。例:「项目使用 PostgreSQL 14」。",
  "tip.kind.observation":
    "观察 (observation):一次性感知到的事实,可能尚未沉淀为稳定结论。例:「今天 CI 跑了 12 分钟」。",
  "tip.kind.pattern":
    "模式 (pattern):从多次观察归纳出的规律,可预测未来行为。例:「每周一早上构建时间会变长」。",
  "tip.kind.procedure":
    "流程 (procedure):步骤序列,执行后可复现某结果。例:「发布前需跑 pnpm check」。",
  "tip.kind.hypothesis":
    "假设 (hypothesis):待验证的猜测;在反例出现前可作工作假设。例:「慢查询可能源于缺失索引」。",
  "tip.status.active": "活跃 (active):近期被检索或强化,在召回池中权重高。",
  "tip.status.dormant": "休眠 (dormant):长期未被检索,权重已衰减但未遗忘。",
  "tip.status.forgotten":
    "已遗忘 (forgotten):维护阶段主动遗忘,文件仍在但默认不召回。",
  "tip.status.archived": "已归档 (archived):冷归档状态,仅用于历史回溯。",
  "tip.visibility.public": "公开 (public):所有人/所有 agent 可见。",
  "tip.visibility.team": "团队 (team):仅同团队可见。",
  "tip.visibility.private": "私有 (private):仅创建者可见。",
  "tip.visibility.restricted": "受限 (restricted):需特定权限才能查看。",
  "tip.emotionalValence.positive":
    "积极 (positive):该记忆编码时带有正向情绪(成功/赞赏/解决)。强化权重略高。",
  "tip.emotionalValence.negative":
    "消极 (negative):该记忆编码时带有负向情绪(失败/警告/反驳)。用于警示未来决策。",
  "tip.emotionalValence.neutral":
    "中性 (neutral):编码时无明显情绪倾向,纯陈述性记忆。",
  "tip.sourceType.firsthand": "一手 (firsthand):亲历/直接观测,可信度最高。",
  "tip.sourceType.secondhand": "二手 (secondhand):转述/文档/他人经验,需交叉验证。",
  "tip.sourceType.inferred": "推断 (inferred):从其他记忆归纳得出,无直接证据。",
  "tip.verification.unverified": "未验证 (unverified):新创建,尚未通过元认知评分。",
  "tip.verification.plausible":
    "貌似成立 (plausible):overall ≥ 0.4,初步通过但仍有不确定性。",
  "tip.verification.probable":
    "较可能 (probable):overall ≥ 0.6,经多次检索未出现反例。",
  "tip.verification.verified":
    "已验证 (verified):overall ≥ 0.8 或人工确认,可作为决策依据。",
  "tip.verification.refuted":
    "已反驳 (refuted):出现强反例或元认知评分极低,不应再作依据。",
  "tip.synapse.extends":
    "扩展 (extends) · 结构族:A 在 B 基础上扩展,继承 B 的语义并新增维度。",
  "tip.synapse.part_of": "部分 (part_of) · 结构族:A 是 B 的组成部分(B has-a A)。",
  "tip.synapse.similar_to":
    "相似 (similar_to) · 结构族:A 与 B 语义相近,可互换或互援。",
  "tip.synapse.depends_on":
    "依赖 (depends_on) · 因果族:A 的成立依赖 B(B 是 A 的前置条件)。",
  "tip.synapse.causes": "导致 (causes) · 因果族:A 触发或产生 B(正向因果)。",
  "tip.synapse.follows":
    "顺承 (follows) · 因果族:A 在时间/逻辑上跟随 B(无强因果)。",
  "tip.synapse.derives_from":
    "派生 (derives_from) · 证据族:A 从 B 推导而来(B 是依据)。",
  "tip.synapse.contradicts":
    "矛盾 (contradicts) · 证据族:A 与 B 相互冲突,进入裁决流程。",
  "tip.synapse.exemplifies":
    "例证 (exemplifies) · 证据族:A 是 B 的具体实例/样本。",
  "tip.synapse.supersedes": "取代 (supersedes) · 时间族:A 取代过时的 B(版本更迭)。",
  "tip.synapse.consolidates":
    "整合 (consolidates) · 时间族:A 合并/精炼了 B 的内容。",
  "tip.synapse.contextualizes":
    "上下文 (contextualizes) · 调节族:A 为 B 提供情境背景(非因果、非证据)。",
  "tip.family.structural": "结构族 (structural):描述知识间的组成/扩展关系。蓝色。",
  "tip.family.causal": "因果族 (causal):描述触发/依赖关系。橙色。",
  "tip.family.evidential":
    "证据族 (evidential):描述来源/冲突关系。绿色(矛盾单独标红)。",
  "tip.family.temporal": "时间族 (temporal):描述版本/演化关系。紫色。",
  "tip.family.modulatory": "调节族 (modulatory):描述情境上下文关系。灰色。",
  "tip.synapseDirection.directional": "单向 (directional):A → B,关系仅从源指向目标。",
  "tip.synapseDirection.bidirectional": "双向 (bidirectional):A ↔ B,关系对称适用。",
  "tip.resolution.pending": "待处理 (pending):已检测到矛盾,等待裁决。",
  "tip.resolution.auto_resolved": "已自动裁决 (auto_resolved):阶段 1,LLM 自动给出裁决。",
  "tip.resolution.escalated": "已升级 (escalated):阶段 2,升级到归属人裁决。",
  "tip.resolution.contested": "有争议 (contested):阶段 3,超时未响应,附警告。",
  "tip.resolution.resolved": "已解决 (resolved):人工或自动最终结案。",
  "tip.importance":
    "重要性 (importance):0-1 数值,越高在召回池中权重越大。由初始设置 + 强化信号 + 衰减综合得出。",
  "tip.confidence":
    "置信度 (confidence):0-1 数值,反映该记忆成立的可信程度(与重要性独立)。",
  "tip.retrievalCount": "检索次数 (retrievalCount):该记忆被搜索/召回命中的总次数。",
  "tip.effectiveRetrievals":
    "有效检索 (effectiveRetrievals):命中后被实际采用(非过滤掉)的次数。",
  "tip.failedUses":
    "失败使用 (failedUses):命中后被报告「无效/过时」的次数。失败过多会触发遗忘。",
  "tip.reinforcementScore": "强化分数 (reinforcementScore):累计的正向强化信号。",
  "tip.decayHalfLifeDays":
    "衰退半衰期 (decayHalfLifeDays):importance 每经过 N 天衰减一半。null 表示永不衰退。",
  "tip.lastEffectiveAt":
    "最近一次有效 (lastEffectiveAt):该记忆最后一次被实际采纳/强化成功的时间戳。",
  "tip.evidenceCount":
    "证据数量 (evidenceCount):支撑该记忆的独立证据条数(突触 + 元数据)。",
  "tip.encodingContext":
    "记忆产生情境 (encodingContext):记忆创建时的背景描述,用于情境依赖回忆。",
  "tip.perspective":
    "视角 (perspective):该记忆的观察视角标识(多视角保留机制,spec §5.3)。",
  "tip.importanceVector":
    "多维重要性 (importanceVector):把 importance 拆解为 5 个独立维度,便于精细化调控。",
  "tip.importanceDim.personal": "个人维度 (personal):对当前用户的工作关联度。",
  "tip.importanceDim.team": "团队维度 (team):对整个团队的协作价值。",
  "tip.importanceDim.project": "项目维度 (project):与当前项目目标的契合度。",
  "tip.importanceDim.network":
    "网络维度 (network):基于突触连接数派生,反映知识图谱中心性。",
  "tip.importanceDim.temporal":
    "时间维度 (temporal):基于 lastEffectiveAt + 半衰期派生,近期强化的得分高。",
  "tip.freshness.fresh":
    "鲜活 (fresh):ageDays ≤ halfLife,最近被有效强化过,在召回池中权重最高。",
  "tip.freshness.aging":
    "渐衰 (aging):halfLife < ageDays ≤ halfLife×2,权重正在下降,建议尽快强化。",
  "tip.freshness.stale":
    "过时 (stale):halfLife×2 < ageDays ≤ halfLife×4,长期未强化,候选遗忘对象。",
  "tip.freshness.forgotten":
    "遗忘 (forgotten):ageDays > halfLife×4,默认移出召回池(文件保留,Git 可追溯)。",
} as const satisfies Readonly<Record<string, string>>;
