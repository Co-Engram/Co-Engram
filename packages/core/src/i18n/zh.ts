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
  // ===== Engram 工具(12 个) — user 层:plain language,无实现术语 =====
  "tool.engram_create":
    "创建一条新记忆。需要标题、内容、类型、领域标签和作者。默认开启智能去重:重复时强化原记忆而非新建,需更新时合并内容。",
  "tool.engram_get":
    "按需读取一条记忆的详情。可只看摘要,也可读完整内容;支持按 token 预算自动选择详略。",
  "tool.engram_update":
    "更新一条记忆的字段(内容、标题、重要性、标签等)。",
  "tool.engram_delete": "永久删除一条记忆(连同所有连接)。不可恢复。",
  "tool.engram_search": "用自然语言搜索记忆,可选按类型、标签、状态等过滤。",
  "tool.engram_list":
    "按过滤条件列出记忆(无关键词查询,按元数据筛选,读最新状态)。",
  "tool.engram_reinforce":
    "上报一次有效使用(正向强化)。提升记忆的强度分数和使用计数,并连带强化相关记忆。",
  "tool.engram_report_failure":
    "上报一次失败使用(负向强化)。降低记忆的强度分数;多次失败会建议归档或遗忘。",
  "tool.engram_archive":
    "归档一条记忆(移出默认搜索,但保留数据可恢复)。",
  "tool.engram_restore":
    "从归档或遗忘状态恢复一条记忆,重新进入默认搜索。",
  "tool.engram_forget":
    "主动遗忘一条记忆。文件保留(Git 可追溯),立即移出所有默认搜索。需要填写理由。后续会自动清理:30 天后进回收站,365 天后物理删除;物理删除前可随时恢复。",
  "tool.engram_recompute_importance":
    "重算一条记忆的多维重要性(个人/团队/项目/网络/时间)。网络和时间维度由系统派生,其余可手动设置。",

  // ===== 学习回路工具(4 个) =====
  "tool.contradiction_resolve":
    "人工裁决两条互相矛盾的记忆(旧 vs 新):决定保留哪一方、合并还是归档败方。需要给出裁决理由和裁决人。",
  "tool.close_learning_loop":
    "关闭验证回路:把使用结果反馈给系统。成功则正向强化,失败则负向弱化并触发降级检查。",
  "tool.upgrade_verification":
    "升级一条记忆的验证状态(未验证 → 似真 → 可信 → 已验证)。需要给出证据说明和验证人。系统校验状态机(不允许跳级)和证据条件;force=true 可跳过证据检查但保留状态机校验。",
  "tool.get_evolution_lineage":
    "追溯一条记忆的演化谱系(祖先和后代)。沿派生/合并/取代关系双向追溯,返回图谱节点和边,可用于可视化。",

  // ===== Synapse 工具(4 个) =====
  "tool.synapse_create":
    "在两条记忆之间创建一条 Synapse(有类型的连接,如扩展、矛盾、因果)。",
  "tool.synapse_get": "读取单条 Synapse 的详情。",
  "tool.synapse_delete": "删除一条 Synapse。",
  "tool.synapse_list": "列出某条记忆的所有 Synapse(出边 / 入边 / 双向)。",

  // ===== Skill 工具(2 个) =====
  "tool.skill_get":
    "读取 Skill 元信息(程序性记忆,即带参数的可调用模板)。",
  "tool.skill_invoke":
    "带参数调用一个 Skill(程序性记忆)。当前为框架;具体模板执行在后续版本实现。",

  // ===== 候选提案工具(3 个) =====
  "tool.engram_list_proposals":
    "列出待处理的记忆候选。当某主题在对话中被多次提及但无匹配记忆时,系统生成待确认提案。默认只返回待处理;传 includeAll=true 可查看历史。",
  "tool.engram_accept_proposal":
    "接受一个候选提案 → 系统自动创建对应记忆,并标记提案为已接受。后续相同主题不会再产生重复提案。",
  "tool.engram_dismiss_proposal":
    "驳回一个候选提案。默认永久不再提示;显式传 dismissDays > 0 时 N 天后可被新事件重新激活。审计日志始终保留。",
  "tool.engram_synthesize":
    "手工触发 REM:把多条已有记忆交给 LLM 综合成一条 pattern(模式)记忆,并自动为每个源连一条 derives_from(派生自)连接。需要配置 LLM。可选 dryRun 只看草稿不创建。",

  // ===== 仓库健康工具(2 个) =====
  "tool.engram_doctor":
    "对记忆仓库做一次自愈扫描。自动修复文件移动、标题重命名、过期索引项;报告悬空连接和孤儿文件供人工处理。",
  "tool.engram_list_paths":
    "列出记忆仓库的目录树,每节点带累计记忆数,用于搜索前先建立全局认知。",
  "tool.engram_sync":
    "手动触发记忆仓库的 pull → commit → push 全链路同步。让用户主动掌控提交时机(与系统自动标记脏数据相对)。冲突时不自动解决,清晰报告让用户决策。",
  "tool.engram_audit_query":
    "查询 audit 审计日志(团队记忆的事件历史,audit.jsonl)。把 AuditLog.query() 暴露给 LLM agent,无需离开对话即可查看任意 engram 或动作类的修改时间线。",

  // ===== OpenClaw 兼容 memory 工具(2 个) =====
  "tool.memory_search":
    "用自然语言搜索团队记忆。返回相关记忆片段及相关性分数。当用户询问过往决策、偏好、人名、日期或项目细节时调用。",
  "tool.memory_get":
    "按 ID 读取单条记忆的完整内容。返回内容、元数据和相关记忆 ID。在 memory_search 之后用来查看细节。",

  // ===== 工具描述:agent 层(LLM 友好,结构化 WHEN/RETURNS)=====
  // 从 LLM_TOOL_DESCRIPTIONS 迁移 + 13 个原未覆盖工具的新描述。
  // 禁止术语:FTS / LTP / Hebbian / RPE / reinforcementScore / effectiveRetrievals / failedUses。
  // truthScore 仅在 engram_get 中允许(字段名引用)。
  "tool.engram_search.agent": `搜索团队记忆(过去的设计决策、偏好、项目上下文)。

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
  "tool.engram_get.agent": `按 ID 读取单条记忆(engram)的完整内容。

何时调用:
- engram_search 返回的命中需要读全文
- 用户明确询问某个 engram ID 的详情
- 需要搜索摘要里没显示的元数据(重要性、tags、验证状态)

何时不调用:
- 还没调过 engram_search(先搜索)
- engram ID 来自过时的对话(重新搜索验证)

返回:完整内容 + 元数据(创建时间、重要性、truthScore、强化次数)+ 相关 engram ID 列表。

概念:{{concept:engram|userExplanation}}`,
  "tool.engram_create.agent": `为重要的团队知识创建新记忆(engram)。

何时调用:
- 用户明确表达偏好("以后用 arrow function")
- 用户做出带理由的设计决策("我们用 PostgreSQL,因为 X")
- 用户分享 bug 教训("这个失败因为 Y,以后记得检查 Z")
- 用户纠正过时记忆("其实我们已经改用 X 了")

何时不调用:
- 琐碎/一次性信息
- CLAUDE.md/README 已有的信息
- 用户只是在询问(用 engram_search)

⚠️ visibility='private' 用于个人凭据/路径/设备特定信息(ADB 序列号、token、本机偏好),落 private/ 子目录被 .gitignore 隔离,不入团队仓库。

⚠️ 不要写到 ~/.claude/projects/.../memory/ —— AutoMemorySyncEngine 会把该路径镜像成 **待审批 proposal**(仍需 accept,visibility 归属已丢失)。请直接用本工具。

**可见性**:若 content 含凭据 / 个人 / 内部 / 敏感信号(详见系统提示的「可见性风险识别」段),先询问是否 visibility: "private"。

返回:创建的 engram ID + 版本号。自动检测重复。`,
  "tool.engram_update.agent": `当已有记忆的内容需要细化(不是矛盾)时更新。

何时调用:
- 给已有 engram 补充细节("迁移还要处理 X")
- 修正记忆里的笔误/不精确表述
- 用户澄清之前的记忆("我的意思是...")

何时不调用:
- 新信息和旧的矛盾(用 engram_create + contradiction_resolve)
- 记忆没问题(不要为了刷新时间戳而更新)

⚠️ 改 visibility 触发文件路径迁移(private → private/<domainTags>/;其他 → <domainTags>/);原子性,冲突失败,stableId 不变。

**可见性**:新 content 含风险信号且当前为 public/team 时,update 前询问是否同时降级 private。

返回:更新后的 engram + 新版本号。`,
  "tool.engram_list.agent": `浏览所有记忆(分页),最新优先。

何时调用:
- 用户想看存储的记忆概览("你知道我什么")
- 需要找记忆但没精确查询词
- 回顾最近捕获的内容

何时不调用:
- 有明确查询(用 engram_search 更快更准)
- 只为检查记忆是否存在(按内容搜)

返回:engram 摘要列表(标题、tags、更新时间)+ 总数。支持分页。`,
  "tool.synapse_create.agent": `在两条记忆之间创建有类型的连接(synapse)。

何时调用:
- 新记忆扩展/矛盾/关联已有记忆
- 用户提到因果或依赖关系("X 因为 Y 发生")
- 把决策链接到理由,或 bug 链接到修复

何时不调用:
- 两条记忆无关
- 不确定关系类型(默认用 'related_to')

返回:synapse ID + from/to engram ID。常见类型:extends、contradicts、related_to、caused_by。

副作用(SIDE EFFECTS):
- kind="contradicts":自动给双方 engram 写 contradicted audit 事件(可被 engram_audit_query 查到),并触发矛盾解决流程。`,
  "tool.engram_reinforce.agent": `标记某条记忆被有效使用(正向强化)。

何时调用:
- 你在回答里引用了 engram ID 且用户接受了结果
- 取回的记忆直接帮助解决了任务
- 成功完成依赖某条记忆的任务后

何时不调用:
- 实际没用那条记忆(只是扫了一眼)
- 任务失败或记忆错了(用 engram_report_failure)

返回:记忆的强度分数增加 + 有效使用计数 +1。`,
  "tool.engram_report_failure.agent": `上报一次"召回后导致错误答案"的失败使用(LTD 累积式削弱)。

何时调用:
- 召回了某条记忆,但其内容导致你给出错误答案或走错路径
- 用户反馈"这条不对",但你不确定是这条记忆整体失效还是只是本次不适用

何时不调用:
- 代码/决策/约束已确定变更,记忆描述的事实已不成立 → 用 engram_delete(确定性失效,立即)
- 记忆只是不完整(用 engram_update)
- 不确定(先问用户)

机制说明:累积式负反馈 —— 单次调用只让 importance 下降一点(典型 −0.03),记忆仍在检索池里;多次累积后维护周期可能自动驳回。确定性事实失效不要走这条路,直接 engram_delete。

返回: { ok: true, importance, failureCount } + 审计已记录。`,
  "tool.engram_delete.agent": `永久删除一条记忆(立即失效,不可恢复)。

⚠️ 除非用户明确指示,调用前必须先确认。

何时调用:
- 用户明确要删除("删掉关于 X 的那条记忆")
- 记忆重复或含敏感信息
- 事实已确定失效(运行验证或用户陈述,非推测)—— 跳过累积式 engram_report_failure,直接 delete

何时不调用:
- 召回答案不准(用 engram_report_failure)
- 用户表述模糊("忘掉那个" — 确认含义)

返回:{ deleted: true } 或未找到错误。

⚠️ Fail-loud:删除后 post-check;若检测到 race / 不一致,抛"still exists"(跑 engram_doctor 自愈)。`,
  "tool.close_learning_loop.agent": `确认记忆正确后,关闭验证回路。

何时调用:
- 使用了记忆,验证有效,想标记为已确认
- 正向反馈 + 用户确认记忆准确后
- 完成"取回 → 使用 → 验证 → 确认"循环

何时不调用:
- 还没实际验证(等确认扎实后再调)
- 记忆最终错了(用 engram_report_failure)

返回:更新后的验证状态 + 闭环元数据。`,
  "tool.contradiction_resolve.agent": `解决两条记忆之间的矛盾(旧 vs 新)。

何时调用:
- 新记忆明确矛盾旧记忆
- 用户确认旧记忆错了应该 refute
- 需要标记 contradiction synapse 里哪一方胜出

何时不调用:
- 两条记忆只是不同视角(用 synapse kind 'related_to')
- 不确定哪个对(问用户)

返回:resolution 记录 + 两条 engram 的验证状态更新。`,
  "tool.engram_list_proposals.agent": `列出待处理的记忆候选(隐式捕获但待审批的)。

何时调用:
- 系统提示显示"N 个候选记忆待处理"
- 用户问"有什么候选"或"查看待处理记忆"

何时不调用:
- 没有待处理候选(系统提示会显示 0)
- 刚刚显式搜索过(用 engram_search)

返回:候选列表。每条带 \`source\`("conversation" = 对话聚类 / "auto-memory" = Claude Code auto-memory 文件 / "external-markdown" = dataRoot 下检测到的未追踪 .md);auto-memory 与 external-markdown 来源还带 \`proposedTitle\`/\`proposedContent\`/\`proposedDomainTags\`/\`proposedKind\`(accept 时落库的完整 payload),直接 accept 即可。`,
  "tool.engram_accept_proposal.agent": `接受待处理的候选(转成真正的 engram)。

何时调用:
- 用户确认候选有效("对,保存那个")
- auto-memory / external-markdown 来源:候选自带 payload,直接传 \`entityId\`(accept 前先审核 title/domainTags/kind)

何时不调用:
- 候选错误或质量低(用 engram_dismiss_proposal)
- 还没审核

注意:auto-memory / external-markdown 来源的 title/content/domainTags 可省略(走 payload 兜底);conversation 来源仍需显式传。

**可见性**:payload 含风险信号时,accept 前询问是否传 visibility: "private"。

返回:创建的 engram ID + 候选标记为已接受。`,
  "tool.engram_dismiss_proposal.agent": `驳回待处理的候选(拒绝捕获)。

何时调用:
- 用户说"不,不值得保存"
- 候选是噪声/低质量/已被覆盖
- 审核后决定不应成为记忆

何时不调用:
- 还没审核候选内容
- 候选处于边缘(改为接受 + 细化)

默认**永久驳回**:status=dismissed + dismissedUntil 留空,后续 watcher/observe 都不再重开此候选。若需"暂时屏蔽",传 dismissDays > 0 —— N 天后该候选可被新事件重新激活。审计日志始终保留(便于排查)。返回:候选标记为已驳回 + 从待处理列表移除。`,
  "tool.engram_synthesize.agent": `综合多条 engram 形成一条 pattern 记忆(手工触发的 REM)。

何时调用:
- 几条 engram 在同一主题下反复出现,组合起来能形成可复用经验
- 团队刚做完复盘,想从具体记忆提炼抽象模式
- REM 启发式置信度不够,但人判断是真 pattern
- 想给一组相关 engram 显式建立 derives_from 溯源

何时不调用:
- 只有一条 engram(改用 engram_update)
- 源 engram 主题无关(综合出垃圾)
- 想合并矛盾记忆(改用 contradiction_resolve)
- 想去重(engram_create 自带 dedupe)
- ctx.llmClient 未配置(会抛错带安装指引)

返回:patternEngramId + synapseIds(每源一条 derives_from)+ draft(含 title/content/summary/confidence/reason)。dryRun=true 时不创建,只返回 draft。`,
  "tool.engram_doctor.agent": `对记忆仓库做一次自愈扫描。

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
  "tool.engram_sync.agent": `手动触发记忆仓库的 pull → commit → push 同步。

流程:fetch → pull --rebase --autostash(冲突 abort + 报告清单)→ add -A + commit(无变更跳过)→ push(无 remote 降级为 commit-only)。缺失时自动创建 .gitignore 排除 .co-engram/。

何时调用:用户说"保存/提交/push 记忆";密集写入后显式落盘;dryRun=true 预览未提交变更。

返回:{ pulled:{ok,upToDate?,conflicts?}, committed:{ok,sha?,filesChanged,nothingToCommit?}, pushed:{ok,skipped?,reason?}, summary }。冲突时 pulled.ok=false + conflicts 数组,工具中止后续阶段。`,
  "tool.engram_list_paths.agent": `展示记忆仓库的物理目录树,让你在搜索前先建立全局认知。

每节点带 engramCount(子树累计)。用它了解记忆集中在哪些领域、项目,再决定搜什么。

何时调用:
- 会话开始时,在 engram_search 之前建立全局观感
- 用户问"我们有哪些方面的记忆"或"团队做什么领域"
- 准备搜索但想先选更具体的 domain tag

何时不调用:
- 已知道具体查询——直接 engram_search
- 用户想要某条 engram(用 engram_get)

返回:嵌套 { path, engramCount, children } 树,根为 '/'。可选 maxDepth(1-10,默认 5)。`,
  "tool.engram_audit_query.agent": `查询 audit 审计日志(audit.jsonl),返回匹配的事件。

何时调用:
- "这个 engram 的修改历史"(谁创建 / reinforce / contradicted)
- 调试 importance 异常(reinforce / report_failure 序列)
- 复盘 proposal 处理(propose → accept/dismiss)
- 排查 merge 冲突解决

何时不调用:
- 想看 engram 当前状态(用 engram_get)
- 想看有效性图表(打开 viewer 网页 UI)

返回:{ events: AuditEvent[], count }。按时间正序;每条含 ts / actor / action / engramId / metadata。`,
  // 13 个原未覆盖工具的 agent 描述
  "tool.engram_archive.agent": `归档记忆(移出默认检索,但保留数据可恢复)。

何时调用:
- 记忆不再活跃相关,但将来可能需要
- 用户要求"搁置"/"暂存"/"放一边"某条记忆
- 在不丢历史的前提下减少搜索噪声

何时不调用:
- 记忆是错的(用 engram_report_failure)
- 记忆应永久删除(用 engram_delete 或 engram_forget)
- 只是想刷新记忆(用 engram_update)

返回:{ archived: true } + 新状态。检索默认排除 archived,可用 filter 包含。`,
  "tool.engram_restore.agent": `从 archived/forgotten 恢复为 active,重新进入默认检索。

何时调用:
- 用户要求"找回"/"取消归档"/"恢复"某条记忆
- 之前归档的记忆又变相关了
- 从 viewer 回收站恢复

何时不调用:
- 记忆已被物理清除(只能从 git 历史恢复)
- 还没确认记忆仍准确(考虑先 engram_update)

返回:{ restored: true } + 新状态。立即重新进入默认检索。`,
  "tool.engram_forget.agent": `主动遗忘记忆(RIF 检索诱导遗忘)。

文件保留(Git 可追溯),立即移出所有默认检索。需要 reason。

何时调用:
- 用户明确说"忘掉这个"/"别再记这个"
- 记忆有误导性,不应在将来搜索中浮现
- 在考虑永久删除前的软移除

何时不调用:
- 只是召回后答案不准(用 engram_report_failure,累积式负反馈)
- 事实已确定失效(用 engram_delete,立即)
- 用户表述模糊(确认要遗忘什么)
- 想保持可搜索(用 engram_archive 代替)

返回:{ forgotten: true } + reason 已记录。默认清理流程:30 天后进 .trash/,再 365 天后物理删除。`,
  "tool.engram_recompute_importance.agent": `重算记忆的多维重要性分数。

何时调用:
- 检索/使用模式发生显著变化后(批量 reinforce 或 failure)
- 用户要求"重排"/"重算"/"刷新重要性"
- 调试异常搜索排名

何时不调用:
- 仅为刷新时间戳(用 engram_update)
- 作为常规操作(重要性在 reinforce/failure 时自动更新)

返回:重算的重要性向量(personal/team/project/network/temporal)+ 新 composite 分数,写回 engram.importance。`,
  "tool.upgrade_verification.agent": `升级记忆的验证状态(unverified → plausible → probable → verified)。

何时调用:
- 你验证了记忆准确,想标记为已确认
- 跨情境证据支持该记忆
- 在 close_learning_loop 成功且证据扎实后

何时不调用:
- 没有证据(先用 close_learning_loop 完成基础确认循环)
- 想降级(本工具只升级;refuted 是另一条路径)
- 不带 force=true 跳级(状态机校验会拒绝)

返回:新验证状态 + 证据记录。force=true 跳过证据检查但保留状态机校验。`,
  "tool.get_evolution_lineage.agent": `追溯记忆如何演化(祖先和后代)。

何时调用:
- 用户问"这个决策从哪来"/"这个 pattern 怎么形成的"
- 理解一个 pattern 或 procedure 的派生链
- 审查 observation 谱系是否支持某个 pattern 的有效性

何时不调用:
- 记忆没有演化关系(返回空图)
- 只想要相关记忆(用 engram_get 的 synapses tier)

返回:DAG 节点和边。ancestors = 来源(observation 等),descendants = 演化结果(pattern/procedure)。`,
  "tool.synapse_get.agent": `读取两条记忆之间的单条 synapse(连接)。

何时调用:
- 检查某个连接的元数据(weight、direction、evidence)
- 调试为什么两条记忆被关联
- 在 synapse_list 返回 synapse ID 后想看详情

何时不调用:
- 列出某记忆的所有 synapse(用 synapse_list)
- 检查是否存在连接(用 synapse_list + filter)

返回:Synapse 记录(id、from、to、kind、weight、direction、evidence、resolutionState)。`,
  "tool.synapse_delete.agent": `删除两条记忆之间的 synapse(连接)。

何时调用:
- 用户确认连接错误/不再相关
- 清理错误的 contradiction 或 derives_from 链接
- 合并后清理重复

何时不调用:
- 连接只是弱(用 synapse_create 调低 weight 代替)
- contradiction 已解决(用 contradiction_resolve,不要 delete)
- 没确认用户想移除连接

返回:{ deleted: true } + 双方 engram 缓存更新。`,
  "tool.synapse_list.agent": `列出某条记忆的所有 synapse(连接)。

何时调用:
- 在决定 update 或 delete 前审查记忆连接了什么
- 理解某主题周围的关系图
- 检查 contradiction 或 derivation

何时不调用:
- 只需要某条特定 synapse(用 synapse_get)
- 想看完整图视图(用 viewer 的 Graph tab)

返回:Synapse 列表(出边/入边/双向),含 kind、weight、direction。`,
  "tool.skill_get.agent": `读取 skill 元信息(程序性记忆)。

何时调用:
- 在 invoke 前检查已注册 skill 做什么
- 列出可用 skill(程序性模板)
- 调试 skill registry 问题

何时不调用:
- 想执行 skill(用 skill_invoke)
- 想读陈述性记忆(用 engram_search / engram_get)

返回:Skill 元信息(name、description、template kind、parameters)。`,
  "tool.skill_invoke.agent": `⚠ 实验性占位(EXPERIMENTAL STUB)——当前返回占位字符串,不真实执行技能;真正的模板执行在 P1 实现。

带参数调用一个 skill(程序性记忆)。

何时调用:
- 用户要求执行已知的程序性模板
- 在 skill_get 识别出正确 skill 后
- 运行 tool-sequence 或 prompt-template skill

何时不调用:
- 没有已注册 skill 的一次性任务
- 没先查 skill_get(可能没选对 skill)

返回:Skill 执行结果(取决于模板)。P0 阶段 output 字段形如 "[P0 stub] Skill X invoked with args: ..."。`,
  "tool.memory_search.agent": `用自然语言搜索团队记忆。返回相关记忆片段及相关性分数。

何时调用:
- 用户询问过往决策、偏好、人名、日期或项目细节
- 用户引用过去工作("我们决定"、"上次"、"以前")
- 需要当前代码或文档里没有的团队历史

何时不调用:
- 与团队历史无关的纯代码问题
- 通用编程知识(用 web search)
- 当前对话已答过的话题

返回:命中结果含 id、title、内容片段、score、metadata。用 memory_get 读全文。`,
  "tool.memory_get.agent": `按 ID 读取单条记忆的完整内容。

何时调用:
- memory_search 返回的命中需要读全文
- 用户明确询问某个 memory ID 的详情
- 需要搜索摘要里没显示的元数据(重要性、kind、tags)

何时不调用:
- 还没调过 memory_search(先搜索)
- 想列出所有记忆(用 engram_list)

返回:完整内容 + 元数据(重要性、tags、kind)+ 相关记忆 ID。`,

  // ===== 工具描述:technical 层(开发者/审计向,完整契约)=====
  // 允许实现术语(FTS / LTP / Hebbian / RPE)。记录参数语义、错误条件、副作用、不变量。
  // 用于技术文档、API 契约、debug。
  "tool.engram_search.technical": `FTS5 全文检索(中文 bigram tokenizer + 英文 word tokenizer)。
输入:{ query: string; filter?: { domainTags?, kind?, kinds?, status?, freshness?, emotionalValence?, createdBy?, createdAfter?, createdBefore?, minImportance? }; limit?: number }
副作用:无(只读)。不更新 lastRetrievedAt(用 engram_reinforce)。
错误条件:空 query 抛错;limit 钳到 [1, 100]。
不变量:archived engram 默认排除,除非 filter.status 包含 'archived'。
索引:读 digest.jsonl + FTS 索引;冷启动重建。`,
  "tool.engram_get.technical": `按披露层级读取 engram(渐进式披露,控制 token 成本)。
输入:{ id: EngramId; tier?: 'catalog' | 'digest' | 'content' | 'meta' | 'synapses' | 'auto'; contextBudget?: number }
- catalog:id + title + kind + tags(最小)
- digest:+ summary + importance + 时间戳
- content:+ 完整 body
- meta:+ frontmatter(全字段)
- synapses:+ 出/入边
- auto:按 contextBudget 自动选 tier(默认)
副作用:无。不更新 lastRetrievedAt(用 engram_reinforce)。
错误条件:未找到抛错;无效 tier 抛错。
truthScore 字段在此暴露(允许字段名引用)。`,
  "tool.engram_create.technical": `创建新 engram。输入:{ title, content, kind, domainTags, createdBy, summary?, contextTags?, importance?, confidence?, emotionalValence?, sourceType?, visibility?, decayHalfLifeDays?, dedupe?, encodingContext? }
kind 枚举:observation | fact | pattern | procedure | hypothesis。
Dedupe 模式(默认 true):DUPLICATE 强化已有(调 recordRetrievalSuccess);UPDATE 合并 content;NEW 创建。
副作用:写 engrams/<slug>.md + .meta.json + .synapses.json;append audit;mark repo dirty。
错误条件:缺必填字段抛错;无效 kind 抛错。
不变量:slug 唯一性强制;冲突加后缀。`,
  "tool.engram_update.technical": `更新 engram 字段。输入:{ id, title?, content?, summary?, importance?, domainTags?, contextTags?, emotionalValence?, decayHalfLifeDays?, visibility?, updatedBy, kinds? }
乐观锁:version 字段校验(Finding 231 — 待实现)。
副作用:重写 .md + .meta.json;append audit;增量更新 digest/graph 索引;mark dirty。
错误条件:未找到抛错;version 不匹配抛错(实现后)。
不变量:title 变更触发 re-slug + 文件重命名。`,
  "tool.engram_delete.technical": `硬删除 engram。输入:{ id }
副作用:删除 .md + .meta.json + .synapses.json;移除其他 engram 上的 incoming synapse;重建 digest/graph;append audit。
删除顺序(F3):先删 index → 再删文件 → 再删 synapse。任何中间步骤失败,失败模式都落在 doctor 能自愈的范畴(orphan_markdown / dangling_synapse),无 fail-silent 漏洞。
错误条件:未找到抛错;post-check 发现 engram 仍存在(race / 不一致)抛"still exists"错。
不变量:不可逆(vs engram_forget 保留文件)。Git 历史是唯一恢复途径。
警告:软移除优先用 engram_archive 或 engram_forget。`,
  "tool.engram_list.technical": `按 filter 列出 engram(无 query,纯元数据过滤,读最新状态)。
输入:{ filter?: 同 engram_search;limit?,cursor? }
副作用:无。
分页:cursor-based,opaque token。
不变量:读 engram-index.json(catalog);不读完整内容。比 engram_search 列举更快。`,
  "tool.engram_reinforce.technical": `上报有效检索(LTP)。输入:{ id, effectiveness: 0..1, note? }
更新:effectiveRetrievals += 1;reinforcementScore += effectiveness;importance += effectiveness × 0.02(clamp [0,1])。
Hebbian 强化:邻居 engram(经 synapse)得 50% delta,contradicts synapse kind 除外。
副作用:写目标 + 邻居的 .meta.json;append audit;append effectiveness signal。
错误条件:未找到抛错;effectiveness 越界抛错。
注意:此路径与 maintenance applyRpeUpdate 不同(Finding 124)— tool 路径增长 importance,maintenance 路径不增长。`,
  "tool.engram_report_failure.technical": `上报失败使用(LTD)。输入:{ id, reason, context? }
更新:failedUses += 1;retrievalCount += 1;importance -= 0.03(超阈值后 ×1.5 升级)。
自动建议:failedUses ≥ 3 → 建议 archive;≥ 5 → 建议 forget。
副作用:写 .meta.json;append audit;append effectiveness signal(failure)。
错误条件:未找到抛错;空 reason 抛错。`,
  "tool.engram_archive.technical": `归档 engram。输入:{ id, reason? }
状态转换:active → archived。
副作用:写 .meta.json(status);重建 digest(默认 FTS 排除 archived)。
错误条件:未找到抛错;已 archived 幂等。
不变量:数据保留;可通过 engram_restore 恢复。检索默认排除 archived,除非 filter.status='archived'。`,
  "tool.engram_restore.technical": `从 archived/forgotten 恢复。输入:{ id }
状态转换:archived|forgotten → active。
若 engram 已被 sweep 到 .trash/,先移回。
副作用:写 .meta.json;重建 digest;append audit。
错误条件:未找到抛错;物理清除抛错(不可恢复)。
不变量:立即重新进入默认检索。`,
  "tool.engram_forget.technical": `RIF 检索诱导遗忘。输入:{ id, reason }
状态:active|archived → forgotten。
文件保留(Git 跟踪)。立即移出所有默认检索。
清理流程(maintenance):forgotten → 30 天 → .trash/(主索引移除)→ 365 天 → 物理 rm。
副作用:写 .meta.json(status + forgottenAt);重建 digest;append audit。
错误条件:未找到抛错;空 reason 抛错。
恢复:物理清除前可随时 engram_restore;清除后只能 git 历史。`,
  "tool.engram_recompute_importance.technical": `重算多维重要性。输入:{ id, overrides?: { personal?, team?, project? } }
维度:personal / team / project(可设);network(incomingSynapseCount 派生);temporal(艾宾浩斯衰退)。
composite = 加权和(spec §8)。写回 engram.importance。
副作用:写 .meta.json(importance + importanceVector);append audit。
错误条件:未找到抛错。
不变量:network + temporal 始终系统派生;overrides 只影响其余三维。`,
  "tool.contradiction_resolve.technical": `裁决 contradicts synapse。输入:{ fromId, synapseId, verdict: 'keep_new' | 'keep_old' | 'merge' | 'archive', rationale, resolvedBy }
更新:synapse.resolutionState = 'resolved';append evidence[];verdict=archive 时,败方 engram status → archived。
副作用:写 synapse 文件 + .meta.json(若 archive);append audit。
错误条件:未找到抛错;非 contradicts synapse 抛错;已 resolved 抛错。
Spec:§3.9 phase 2 人工介入。`,
  "tool.close_learning_loop.technical": `闭合验证回路。输入:{ engramId, outcome: 'success' | 'failure' | 'partial', effectiveness?, reportedBy }
success/partial → LTP(engram_reinforce 路径)+ Hebbian 邻居强化。
failure → LTD(engram_report_failure 路径)+ 降级阈值检查(低于则 auto-archive)。
触发 provenance 奖惩回路(如配置)。
副作用:写 .meta.json(importance + verification status);append audit + effectiveness signal。
错误条件:未找到抛错;无效 outcome 抛错。`,
  "tool.upgrade_verification.technical": `升级验证状态。输入:{ id, evidenceDescription, verifier, force? }
状态机:unverified → plausible → probable → verified(不可跳级)。refuted 是独立路径。
三维证据条件:evidenceCount ≥ N + 跨情境 domainTags + 时间稳定天数。
force=true:跳过证据条件检查但保留状态机校验。
副作用:写 .meta.json(verificationStatus + evidence[]);append audit。
错误条件:未找到抛错;非法转换抛错;证据不足抛错(不带 force 时)。
Spec:§3.9 phase 1。`,
  "tool.get_evolution_lineage.technical": `追溯演化 DAG。输入:{ id, direction?: 'ancestors' | 'descendants' | 'both', maxDepth? }
沿 synapse kind:derives_from / consolidates / supersedes(双向)。
返回:{ nodes: Engram[], edges: Synapse[] }。
副作用:无(只读)。
不变量:ancestors = 来源(observation/hypothesis),descendants = 演化结果(pattern/procedure)。
Spec:§4.6 验收,§12.7 场景 6。`,
  "tool.synapse_create.technical": `创建 synapse。输入:{ from, to, kind, weight?, direction?, evidence?, createdBy?, sourceSemantic?, targetSemantic? }
kind 枚举:extends | part_of | similar_to | depends_on | causes | follows | derives_from | contradicts | exemplifies | supersedes | consolidates | contextualizes。
direction:'directional' | 'bidirectional'(默认 directional)。
副作用:写两端的 .synapses.json(outgoing + incoming 缓存);append audit。
错误条件:from/to 未找到抛错;自环抛错;重复抛错。
不变量:contradicts synapse 创建 contradiction 条目用于跟踪。`,
  "tool.synapse_get.technical": `读取单条 synapse。输入:{ from, synapseId }
返回:完整 synapse 记录(id、from、to、kind、weight、direction、evidence、resolutionState、createdAt)。
副作用:无。
错误条件:未找到抛错。`,
  "tool.synapse_delete.technical": `删除 synapse。输入:{ from, synapseId }
副作用:从两端 .synapses.json 移除;重建 graph 索引;append audit。
错误条件:未找到抛错。
不变量:contradicts synapse 删除也会清除 contradiction 条目(显式裁决用 contradiction_resolve 代替)。`,
  "tool.synapse_list.technical": `列出某 engram 的 synapse。输入:{ from, direction?: 'outgoing' | 'incoming' | 'both' }
返回:synapse 记录数组。
副作用:无。
不变量:outgoing = engram 作为源;incoming = engram 作为目标。均读自缓存的 .synapses.json。`,
  "tool.skill_get.technical": `读取 skill 元信息。输入:{ name }
P0:从内存 registry 读取(skill 启动时加载)。
返回:{ name, description, templateKind: 'tool-sequence' | 'prompt-template', parameters, version }。
副作用:无。
错误条件:未找到抛错。
注:P1 将加入文件系统支持的 skill 加载。`,
  "tool.skill_invoke.technical": `调用 skill。输入:{ name, parameters }
P0:仅框架——返回"skill invoked"不执行模板。
P1:tool-sequence 执行参数化工具链;prompt-template 渲染并返回 prompt。
副作用:取决于模板(tool-sequence 可能写 engram)。
错误条件:未找到抛错;参数校验抛错。
不变量:skill 执行记入 provenance 日志。`,
  "tool.engram_list_proposals.technical": `列出待处理提案。输入:{ includeAll?: boolean }
默认:只返回 pending。includeAll=true 返回 accepted/dismissed 历史。
提案引擎:对话中提及 ≥3 次但无匹配 engram 的主题生成 pending 提案。
副作用:无(只读)。
返回:{ proposalId, title, similarity, sampleMessage, status, createdAt } 数组。`,
  "tool.engram_accept_proposal.technical": `接受提案。输入:{ entityId, title?, content?, domainTags?, kind?, createdBy? }
副作用:创建 engram(内部调 engram_create);标记提案 status=accepted;抑制同主题未来重复提案;append audit。
错误条件:提案未找到抛错;已 accepted/dismissed 抛错。
不变量:默认 createdBy 回退链:explicit > ctx.defaultCreatedBy > 'unknown'。`,
  "tool.engram_dismiss_proposal.technical": `驳回提案。输入:{ entityId, reason?, dismissDays? }
默认 dismissDays=0(永久);reason 记入元学习。
副作用:标记提案 status=dismissed;dismissDays>0 时设置 dismissedUntil=N 天后,=0 时 dismissedUntil=undefined(永不重开);append audit。
错误条件:提案未找到抛错;已 accepted 抛错。
不变量:dismissed 状态的 proposal 不会被 proposeAutoMemory / observe 重开(即使源事件再次触发)。`,
  "tool.engram_synthesize.technical": `LLM 综合多条 engram 形成 pattern。输入:{ ids: string[2..20], createdBy?, domainTags?: string[1..5], synthesisHints?: string[≤500], dryRun?: boolean }
行为:读源 → 调 ctx.llmClient.complete(prompt, { maxTokens: 4000, temperature: 0.3 }) → 解析 JSON → createEngram(kind='pattern', sourceType='inferred', importance=0.7, confidence 来自 LLM) → 对每个源 addOutgoingSynapse(kind='derives_from', weight=0.8, directional, evidence 标注 synthesis 来源)。
domainTags 解析优先级:用户显式 > LLM 推断 > 源 tags 并集(取前 5)。
副作用:写新 engram 三件套 + N 条 synapse;append audit { target: 'pattern-via-synthesis', sourceIds, synapseIds };markDirty。
dryRun=true:只返回 draft,不写盘。
错误条件:llmClient 缺失抛错带安装指引;ids 去重后 < 2 抛错;任一源不存在抛错(列出缺失 id,不部分执行);LLM 返回非 string 抛错;JSON 解析失败抛错(不创建 engram,避免垃圾数据);LLM 调用抛错透传。
不变量:derives_from 方向永远是 pattern → source;synapse weight 固定 0.8;id 自动去重。`,
  "tool.engram_doctor.technical": `自愈扫描。输入:{ incremental?: boolean }
自动修复:文件移动(索引重新指向)、标题重命名(re-slug + rename)、过期索引项(清除)。
报告(人工审核):dangling synapse 引用、孤儿 markdown。
副作用:可能重写 .meta.json / .synapses.json / 索引文件;append audit log。
返回:{ startedAt, finishedAt, total, autoFixed, pendingManualReview, issues: [{ kind, path, message, autoFixed }] }。
incremental=true:只扫描自上次 mtime pass 以来变化的文件。`,
  "tool.engram_sync.technical": `手动 pull-commit-push。输入:{ message?: string(默认 "co-engram sync: YYYY-MM-DD"), dryRun?: boolean(默认 false), pull?: boolean(默认 true), push?: boolean(默认 true) }
副作用:execSync('git ...', { cwd: dataRoot }) —— 调用系统 git,继承用户 SSH/credentials/proxy;不硬编码任何主机/URL/refspec;不主动写 Change-Id(ZTE/Gerrit 的 commit-msg hook 若已装会自动加);尊重用户 .git/config 的 push 配置(Gerrit review 走 refs/for/* 由用户决定)。
.gitignore 兜底:缺失则创建,排除整个 .co-engram/ 目录(派生数据 + 行为缓存,均可重新生成)。
冲突:pullRepo 检测 rebase 冲突 → git rebase --abort → 返回 conflicts 数组(相对仓库根路径)→ 工具中止,不自动 resolve。
push 降级:hasRemote=false 时 push 阶段 skipped,不报错(支持纯本地仓库)。
幂等:无变更时 committed.nothingToCommit=true(跳过 commit);再次 pull 已是最新时 pulled.upToDate=true。
返回:{ repoPath, gitignoreCreated, changedFiles?(dryRun), pulled?, committed?, pushed?, summary }。`,
  "tool.engram_list_paths.technical": `带 engramCount 的目录树。输入:{ maxDepth?: 1..10(默认 5) }
直接读文件系统(非索引)。每节点:{ path, engramCount, children }。
副作用:无。
用途:渐进式披露——搜索前先建立全局观感。
不变量:engramCount 是子树累计(含子节点)。`,
  "tool.memory_search.technical": `engram_search 的 OpenClaw 兼容别名。同样 FTS5 后端,简化 schema。
输入:{ query, maxResults?, minScore? }
副作用:无。
返回:{ results: MemorySearchHit[], total }。MemorySearchHit 隐藏内部字段(emotionalValence、freshness、sourceType)。
不变量:maxResults 钳到 [1, 50];minScore 钳到 [0, 1]。`,
  "tool.memory_get.technical": `engram_get(content tier)的 OpenClaw 兼容别名。同样后端。
输入:{ id }
副作用:无。
返回:{ id, title, content, metadata: { importance, truthScore, reinforcementCount, tags, kind }, relatedIds }。
不变量:relatedIds 派生自 synapse(双向)。`,

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
    "何时调用 engram_reinforce:由你**自主判断**——当你引用的记忆确实帮助完成了任务、内容被实际采纳进答案、或成功指导了决策时,对该 engram 调 engram_reinforce(id, effectiveness) 强化。effectiveness 取值:1.0=完全有效、0.7=大部分有效、0.4=仅作为背景参考。引用错误时调 engram_report_failure(累积式负反馈);事实已确定变更时调 engram_delete(立即失效、不可恢复,默认先向用户确认)。co-engram 是自进化系统,你的强化信号是 importance 评分的关键输入——主动调用,不要等待用户提示。同时**诚实评估**:仅沾边不要给高分,过度强化会让低价值记忆淹没高价值记忆。",
  "prompt.memory.proposal_reminder":
    "待处理提案:${count} 条候选记忆待审阅。调用 engram_list_proposals 查看,engram_accept_proposal 入库,或 engram_dismiss_proposal 忽略。",
  "prompt.memory.frequent_topics":
    "当前 team-memory 的高频话题:${tags}。这些领域调用 memory_search 最有可能返回有用上下文。",
  "prompt.memory.missed_topics":
    "最近遗漏的话题(建议主动搜索):${topics}。历史对话显示这些话题本应触发 memory_search 但未触发。",
  "prompt.memory.low_confidence_topics":
    "频繁被检索但低置信度的话题:${topics}。可考虑 close_learning_loop 或 upgrade_verification 来强化这些记忆。",

  // ===== Prompt · 可见性风险识别(Task 5:LLM 风险信号契约) =====
  "prompt.visibilityRisk.title": "## 可见性风险识别",
  "prompt.visibilityRisk.guidance":
    "在调用 engram_create / engram_accept_proposal / engram_update 前,若 content 含以下风险信号,**必须先询问用户**是否设为 visibility: \"private\":",
  "prompt.visibilityRisk.credentials":
    "凭据:API key(ghp_*、sk-*、xoxb-*、npm_*、AKIA*、AIza*)、密码赋值(password=、pwd:)、JWT(eyJ...)、PEM 私钥头",
  "prompt.visibilityRisk.personal":
    "个人身份:邮箱、电话、身份证号、家庭住址",
  "prompt.visibilityRisk.internal":
    "内部信息:内网 IP(10.*、172.16-31.*、192.168.*)、内部域名(*.zte.intra)、内部项目代号",
  "prompt.visibilityRisk.sensitive":
    "敏感信息:人名(尤其负面评价)、客户代号、商业敏感(营收、用户数、未公开路线图)",
  "prompt.visibilityRisk.paths":
    "绝对路径中的用户名(/home/<用户名>/、/Users/<用户名>/、C:\\\\Users\\\\<用户名>\\\\)",
  "prompt.visibilityRisk.template":
    "询问模板:\"这条记忆含 [类别](示例:...)。建议设为 private(仅本地,不入团队仓库)。是否?\"",
  "prompt.visibilityRisk.principle":
    "**宁可多问,不可漏检**。不确定时默认询问。一次多余的询问代价远低于一次凭据泄漏。",

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
  "viewer.tab.merges": "团队记忆合并",
  "viewer.tab.health": "健康",
  "viewer.tab.stats.tip": "记忆库整体统计:印迹/突触数量、kind 与 status 分布、贡献者排名、热门 tag",
  "viewer.tab.engrams.tip": "浏览和搜索所有记忆印迹(卡片视图或按 domain/kind 分组的目录视图)",
  "viewer.tab.graph.tip": "记忆突触可视化图谱;按 family(结构/因果/证据/时序/调制)和 kind 着色与过滤",
  "viewer.tab.proposals.tip": "隐式捕获但尚未审批的候选记忆;接受则转为正式 engram,驳回则丢弃",
  "viewer.tab.merges.tip": "团队记忆合并:相似记忆去重、矛盾记忆(contradicts)三阶段解决工作流",
  "viewer.tab.audit.tip": "记忆变更时间线:创建/更新/删除/强化/矛盾解决的历史记录",
  "viewer.tab.trash.tip": "软删除的印迹与突触;可恢复或彻底清除",
  "viewer.tab.health.tip": "记忆仓库一致性自检:悬空 synapse 引用、孤儿文件、索引漂移;支持自愈",
  "viewer.tab.config.tip": "配置:dataRoot、端口、语言、维护计划(衰退/巩固/REM 周期)",
  "viewer.tab.help.tip": "使用说明:概念释义、端口与 dataRoot、Claude Code 与 OpenClaw 双宿主说明",

  // 记忆可见性徽章 / 过滤 / 提示
  "viewer.engram.visibilityBadge.private": "私有",
  "viewer.engram.visibilityBadge.public": "公开",
  "viewer.engram.visibilityBadge.team": "团队",
  "viewer.engram.visibilityBadge.restricted": "受限",
  "viewer.engram.visibilityBadge.public.tip": "公开 —— 入团队仓库,所有成员可见。",
  "viewer.engram.visibilityBadge.team.tip": "团队可见 —— 入团队仓库,仅团队成员可见。",
  "viewer.engram.visibilityBadge.private.tip": "仅本地 —— 不入仓库(通过 .gitignore 隔离),本机所有 agent 可索引。",
  "viewer.engram.visibilityBadge.restricted.tip": "受限 —— 需审批方可见。",
  "viewer.engram.filter.visibility": "可见性",
  "viewer.engram.filter.allVisibilities": "全部",
  "viewer.engram.filter.team": "团队可见",
  "viewer.engram.filter.private": "仅私有",
  "tip.engram.gitIsolation":
    "私有记忆(🔒)通过 .gitignore 隔离,不进团队 git 仓库;本机所有 agent 仍可索引/检索。",
  "tip.engram.gitIsolation.teamScope":
    "公开 / 团队 / 受限三类记忆都会进团队 git 仓库;选此项即显示这三类。",
  "tip.engram.visibilityEdit":
    "改 visibility 会触发文件路径迁移(public/team/restricted → <domainTags>/,private → private/<domainTags>/);路径冲突时失败,原文件不动。",

  "viewer.health.title": "仓库健康",
  "viewer.health.subtitle": "一眼诊断——把静默失败提前暴露出来。",
  "viewer.health.overall": "总体",
  "viewer.health.generatedAt": "生成时间",
  "viewer.health.dataRoot": "数据根目录",
  "viewer.health.checks": "检查项",
  "viewer.health.refresh": "刷新",
  "viewer.health.empty": "未配置数据根目录。运行 `co-engram init` 创建仓库。",
  "viewer.health.badge.ok": "正常",
  "viewer.health.badge.warn": "警告",
  "viewer.health.badge.error": "错误",
  "viewer.health.badge.info": "信息",
  "viewer.health.stats.total": "记忆总数",
  "viewer.health.stats.archived": "已归档",
  "viewer.health.stats.forgotten": "已遗忘",

  // 健康栏 warn/error 含义说明(viewer.health.why.<checkId>)
  "viewer.health.why.data_root_missing": "数据根目录不存在,co-engram 无法读写任何记忆。所有工具调用都会失败。",
  "viewer.health.why.data_root_not_warehouse": "目录存在但缺少 .co-engram/config.json,不是合法的 co-engram 仓库。需要先初始化。",
  "viewer.health.why.config_unreadable": ".co-engram/config.json 解析失败(JSON 语法错误或权限问题)。配置无法加载意味着默认值会接管,但持久化配置丢失。",
  "viewer.health.why.config_missing_fields": "language 或 defaultCreatedBy 缺失。language 缺失会回退到默认语言(可能与你团队的主语言不符);defaultCreatedBy 缺失会让每条新记忆的创建者无法回溯,影响团队归属和贡献者统计。",
  "viewer.health.why.index_missing": "索引文件(engram-index.json / digest.jsonl / graph.json)是检索加速缓存。缺失会让首次查询变慢(全量扫描重建),不影响数据完整性。",
  "viewer.health.why.proposals_pending_high": "待处理提案超过 5 条。proposal engine 在后台运行产生候选,长期不审核会累积成噪音,淹没真正值得固化的团队记忆。",
  "viewer.health.why.git_not_repo": "dataRoot 不是 git 仓库。co-engram 的记忆文件没有版本历史,误删、错误写入、合并冲突都无法恢复。",
  "viewer.health.why.git_dirty_high": "未提交变更超过 10 个。co-engram 不自动 commit,变更堆积增加丢失风险,也增加团队协作时的合并冲突面。",
  "viewer.health.why.merge_driver_missing": "git merge driver 未配置。多人协作合并分支时,engram 的 frontmatter + 派生段会引发文本冲突,需要手工逐条解决,容易丢失内容。",

  // 健康栏修复指引(viewer.health.fix.<checkId>.description)
  "viewer.health.fix.data_root_missing.description": "创建目录并初始化仓库:",
  "viewer.health.fix.data_root_not_warehouse.description": "在当前路径初始化 co-engram 仓库:",
  "viewer.health.fix.config_unreadable.description": "重新初始化生成合法 config.json:",
  "viewer.health.fix.config_missing_fields.description": "补齐缺失的配置项:",
  "viewer.health.fix.index_missing.description": "运行自愈扫描重建索引(或忽略,下次工具调用会自动重建):",
  "viewer.health.fix.proposals_pending_high.description": "调出待处理列表逐条审核(accept 固化 / dismiss 驳回):",
  "viewer.health.fix.git_not_repo.description": "初始化 git 仓库以获得版本历史:",
  "viewer.health.fix.git_dirty_high.description": "一键提交所有 engram 变更,或复制命令手动执行:",
  "viewer.health.fix.merge_driver_missing.description": "自动配置 git merge driver(幂等):",

  // 健康栏 UI 资源(展开/收起、复制命令、调工具、doctor 联动卡片)
  "viewer.health.check.why": "为什么",
  "viewer.health.check.howToFix": "怎么修",
  "viewer.health.check.copyCommand": "复制命令",
  "viewer.health.check.commandCopied": "已复制",
  "viewer.health.check.orCallTool": "或调用工具",
  "viewer.health.check.commitNow": "立即提交",
  "viewer.health.check.commitMessagePrompt": "请输入提交说明（可编辑后确认）",
  "viewer.health.check.commitDefaultMessage": "chore(memory): 同步 engram 变更",
  "viewer.health.check.commitSuccess": "已提交 {files} 个文件 · {branch}@{hash}",
  "viewer.health.check.commitNothing": "工作区已经是干净的,无需提交。",
  "viewer.health.check.commitFailed": "提交失败:{error}",
  "viewer.health.check.expand": "展开详情",
  "viewer.health.check.collapse": "收起",
  "viewer.health.doctor.title": "自愈扫描建议",
  "viewer.health.doctor.subtitle": "来自 engram_doctor 的结构化修复指引(若需深度排查)",
  "viewer.health.doctor.autoFixed": "自动修复",
  "viewer.health.doctor.pendingReview": "待人工审核",
  "viewer.health.doctor.empty": "扫描通过,无问题。",
  "viewer.health.doctor.runScan": "运行 doctor 扫描",
  "viewer.health.doctor.loading": "正在扫描...",
  "viewer.health.doctor.nextAction": "建议下一步",
  "viewer.health.doctor.noPending": "无待人工审核的问题。",
  "viewer.health.doctor.fixKind.index_rebuilt": "已重建派生索引",
  "viewer.health.doctor.fixKind.merge_driver_installed": "已配置 git merge driver",
  "viewer.health.doctor.fixKind.moved_file": "已修正文件路径",
  "viewer.health.doctor.fixKind.title_changed": "已根据新标题重命名",
  "viewer.health.doctor.fixKind.missing_file": "已清除失效索引项",
  "viewer.health.doctor.fixKind.obsidian_view_stale": "已同步 Obsidian 视图",
  "viewer.health.doctor.fixKind.dangling_index_reference": "已清理派生索引中对已删 engram 的悬空引用",
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
  "field.label.visibility": "可见性:",

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

  // 错误提示(error.<name>)—— user-visible 错误前缀与消息模板
  "error.prefix": "错误",
  "error.uri_missing_id": "URI 缺少 {id} 变量",
  "error.engram_not_found": "engram \"${id}\" 不存在",

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
  "viewer.proposals.visibility.label": "可见性",
  "viewer.proposals.visibility.hint": "默认公开;若 LLM 主动询问或你判断含敏感信息,请改 private。",
  "viewer.proposals.notFound": "提案未找到:${id}",
  "viewer.proposals.titleRequired": "请填写标题",
  "viewer.proposals.contentRequired": "请填写内容",
  "viewer.proposals.acceptedToast": "✓ 已采纳",
  "viewer.proposals.createdEngramToast": "创建记忆印迹:${id}",
  "viewer.proposals.acceptFailed": "采纳失败:${err}",
  "viewer.proposals.dismissConfirm": "确认驳回此提案?驳回后将不再出现,审计日志保留。",
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
  "viewer.detail.visibility.changeBtn": "切换可见性",
  "viewer.detail.visibility.confirm": "此操作会迁移记忆路径(如 public → private 时,文件移到 private/ 子目录),下次 sync 推送到远端。确认?",
  "viewer.detail.visibility.changed": "可见性已更新,路径已迁移",
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
  "viewer.scoreBand.high": "高",
  "viewer.scoreBand.medium": "中",
  "viewer.scoreBand.low": "低",
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
  // 首次设置 / non-engram 二次确认 UX(UI 弹此 banner 代替硬拒绝,免去走 CLI)
  "viewer.config.dataRootNonEngramConfirmTitle":
    "此目录已有其他文件",
  "viewer.config.dataRootNonEngramConfirmBody":
    "co-engram 只会在 <code>{path}</code> 中创建 <code>.co-engram/</code> 子目录,不会改动你已有的文件。",
  "viewer.config.dataRootNonEngramExistingList":
    "现有 {count} 项:{files}",
  "viewer.config.dataRootNonEngramMore": "……以及其他 {count} 项",
  "viewer.config.dataRootTakeOver": "接管此目录",
  "viewer.config.dataRootTakeOverConfirm":
    "接管 <code>{path}</code>?co-engram 会新建一个 <code>.co-engram/</code> 子目录,不影响你已有的文件。",
  "viewer.config.dataRootCancelled": "已取消接管。",
  // 首次用户引导(dataRoot=null 时显示)
  "viewer.config.dataRootWelcomeTitle": "欢迎使用 —— 先设置你的团队记忆位置",
  "viewer.config.dataRootWelcomeBody":
    "co-engram 把团队记忆存放在你选择的目录里。下面几个常用位置任选其一,或输入任意路径。co-engram 只会在目录里创建 <code>.co-engram/</code> 子目录,不会影响已有文件。",
  "viewer.config.dataRootWelcomeSuggestHome": "使用 ~/team-memory(推荐)",
  "viewer.config.dataRootWelcomeSuggestHidden": "使用 ~/.co-engram-data",
  "viewer.config.dataRootWelcomeCustom": "或输入自定义路径:",
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
  "viewer.help.rulesTitle": "强化机制与规则参数(默认值)",
  "viewer.help.rulesIntro":
    "记忆的 importance 分数会随使用反馈演化。下面是真实的默认参数(可在源码 ReinforcementConfig.DEFAULT_CONFIG / DEFAULT_WEIGHTS / DEFAULT_EFFECTIVENESS_WINDOWS / DEFAULT_VERIFICATION_CONFIG 找到),用 config.json 或对应配置项可覆盖。",
  "viewer.help.ruleLtp":
    "<strong>LTP(长时程增强)</strong>:每次有效检索(effective=1),importance += <code>ltpGain</code>(默认 <code>0.02</code>)。10 次有效检索约能把 0.5 提升到 0.7。",
  "viewer.help.ruleLtd":
    "<strong>LTD(长时程削弱)</strong>:每次失败使用,importance -= <code>ltdPenalty</code>(默认 <code>0.03</code>);累积失败超过 <code>failureThreshold</code>(默认 <code>3</code>)次后,按 <code>failureEscalation</code>(默认 <code>1.5</code>)倍率额外惩罚。",
  "viewer.help.ruleHebbian":
    "<strong>Hebbian 邻居扩散</strong>:强化一条记忆时,直接相连(通过 synapse)的邻居得到 <code>ltpGain × hebbianRatio</code>(默认 <code>hebbianRatio = 0.5</code>)的增益,contradicts 关系除外。",
  "viewer.help.ruleWeights":
    "<strong>三因子检索权重</strong>:score = α·relevance + β·recency + γ·importance(默认 α=0.5 / β=0.3 / γ=0.2)。recency 按 Ebbinghaus 半衰期 <code>0.5^(ageDays / decayHalfLifeDays)</code> 衰退。",
  "viewer.help.ruleWindows":
    "<strong>观察窗口(observation window)</strong>:engram 被检索命中后开启一段观察期;窗口期内回来 reinforce 计为有效(LTP),反馈 failure 计为失败(LTD),过期关闭则本次命中无效。按 kind 默认长度:observation 6h / fact 24h / pattern 48h / procedure 48h / hypothesis 7d。多 kind 取最长。",
  "viewer.help.stateMachineTitle": "验证状态机(5 档)",
  "viewer.help.stateMachineIntro":
    "记忆可信度的 5 档状态:未验证 → 似合理 → 较可能 → 已验证 → 已反驳。升级条件默认值见下;降级由 LTD 与失败累积触发。已反驳的记忆默认不参与检索。",
  "viewer.help.stateUnverified":
    "<strong>未验证</strong>(默认状态):新创建记忆从这里起步。",
  "viewer.help.statePlausible":
    "<strong>似合理</strong>:至少 <code>1</code> 条 evidence(derives_from synapse)。",
  "viewer.help.stateProbable":
    "<strong>较可能</strong>:至少 <code>2</code> 条 evidence 且来自 ≥2 个不同 domainTags。",
  "viewer.help.stateVerified":
    "<strong>已验证</strong>:至少 <code>3</code> 条 evidence、≥2 个 domainTags、且创建满 <code>7</code> 天(时间稳定性)。",
  "viewer.help.stateRefuted":
    "<strong>已反驳</strong>:被 contradiction_resolve 标记为失败方;默认从检索结果中排除。",
  "viewer.help.tabsTitle": "各 tab 用途",
  "viewer.help.tabStats":
    "<strong>统计</strong>—总览仪表盘:按类型/状态/族分布,显示团队贡献者和 top 标签。顶部搜索框做全文检索。",
  "viewer.help.tabEngrams":
    "<strong>记忆印迹</strong>—全部 engram 的卡片/目录视图,支持按 tag/kind/status 过滤,点击进入详情(可编辑/删除/查看突触)。",
  "viewer.help.tabGraph":
    "<strong>记忆突触</strong>—知识图谱可视化。可按族/类型过滤边,按 engram 类型过滤节点。打开 engram 详情时图谱会高亮其邻居。",
  "viewer.help.tabProposals":
    "<strong>记忆提案</strong>—候选记忆审批队列。来源:对话聚类(同一主题被提及≥3 次)、Claude Code auto-memory 文件、dataRoot 下检测到的未追踪 .md(例如用户拷贝进来的文件)。由人工/LLM 采纳(engram_accept_proposal)或忽略(engram_dismiss_proposal)。",
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
  "viewer.help.tip5":
    "<code>importance</code> / <code>effectiveness</code> / <code>reinforcementScore</code> 等数值字段会在 2 位小数原始值旁显示等级标签(高 / 中 / 低;阈值 ≥0.7 / ≥0.3 / <0.3)。等级在存储层语言中立,由 UI 本地化。",

  // ===== 记忆可见性 =====
  "viewer.help.visibilityTitle": "记忆可见性与风险识别",
  "viewer.help.visibilityBody":
    "每条记忆有 <code>visibility</code> 字段:<strong>public</strong>(默认,入团队仓库)、<strong>team</strong>(团队可见)、<strong>private</strong>(仅本地,<code>private/</code> 子目录被 <code>.gitignore</code> 隔离,不入仓库)、<strong>restricted</strong>(策略受限)。列表 / 详情 / 提案表单都有徽章和选择器,详情页可一键切换(co-engram 自动迁移文件路径并保持 stableId)。<strong>LLM 风险识别</strong>:LLM 在调用 <code>engram_create</code> / <code>engram_accept_proposal</code> / <code>engram_update</code> 前,若 content 含凭据(API key、密码、JWT、私钥)、个人身份、内网信息、敏感商业信息或绝对路径中的用户名,会主动询问是否设为 <code>private</code>。原则是<strong>宁可多问,不可漏检</strong> —— 一次多余询问的代价远低于一次凭据泄漏。",

  // ===== 端口与数据根目录 =====
  "viewer.help.opsTitle": "端口与数据根目录",
  "viewer.help.opsPorts":
    "<strong>查看器端口</strong>:Claude Code(MCP)默认 <code>18799</code>,OpenClaw(plugin)默认 <code>18899</code>——两宿主同机运行不冲突。环境变量 <code>CO_ENGRAM_VIEWER_PORT</code> 可同时覆盖两宿主。持久化配置里的 <code>viewer.port</code> 已废弃(两宿主共享持久化文件会抢端口)。",
  "viewer.help.opsDataRoot":
    "<strong>数据根目录</strong>:首次打开配置 tab 会看到欢迎卡片,点 <code>~/team-memory</code> 或 <code>~/.co-engram-data</code> 一键设置;也可输入任意自定义路径。若目录已有其他文件,UI 会列出这些文件并让你二次确认 —— co-engram 只在目录里创建 <code>.co-engram/</code> 子目录,不会改动你已有的文件。也可用 CLI <code>co-engram config data-root &lt;path&gt;</code>(加 <code>--force</code> 跳过二次确认)。修改后需重启当前宿主生效。",

  // ===== 工具 profile =====
  "viewer.help.profilesTitle": "工具 profile",
  "viewer.help.profilesBody":
    "<strong>三档 profile</strong> 按用途收缩 LLM 工具表面,数值来自源码中的 <code>PROFILE_TOOL_COUNTS</code>(经 <code>.size</code> 自动算出,不会漂移)。<strong>minimal(12)</strong>:核心读写 + proposal 处理三件套 + <code>engram_sync</code> —— 只做回忆和记录的 chat agent。<strong>standard(19,默认)</strong>:加上学习回路、矛盾仲裁、自愈(<code>engram_doctor</code>)、渐进式披露(<code>engram_list_paths</code>)、LLM 综合(<code>engram_synthesize</code>)与审计查询(<code>engram_audit_query</code>)。<strong>full(29)</strong>:全部原生工具,实验性的 <code>skill_invoke</code>(P0 占位)除外。切换:<code>CO_ENGRAM_TOOLS_PROFILE=minimal|standard|full</code>;无效值会告警并回退到 standard。",

  // ===== 保存与同步 =====
  "viewer.help.syncTitle": "保存与同步到远端",
  "viewer.help.syncBody":
    "记忆在写入时会自动标记仓库为脏,宿主在合适时机会落盘提交。<strong>想主动掌控时机</strong>?让 agent 调用 <code>engram_sync</code> 工具:它会先 <code>git fetch</code> + <code>pull --rebase --autostash</code> 合并远端,再 <code>commit</code> 本地变更,最后 <code>push</code> 到远端(无 remote 时自动降级为仅提交)。冲突时不自动解决,会清晰列出冲突文件让你决策。<strong>公司内外部通用</strong>:直接调用系统 <code>git</code>,继承你本机的 SSH/credentials/proxy;不硬编码任何主机或 URL;不主动写 Gerrit <code>Change-Id</code>(若装了 commit-msg hook 会自动加);尊重 <code>.git/config</code> 的 push 配置。首次同步时会自动创建 <code>.gitignore</code> 排除 <code>.co-engram/</code> 缓存目录。可用 <code>dryRun=true</code> 预览未提交变更。",

  // ===== Obsidian 集成 =====
  "viewer.help.obsidianTitle": "Obsidian 集成(graph view)",
  "viewer.help.obsidianBody":
    "数据根目录可直接作为 <strong>Obsidian vault</strong> 打开。突触(<code>extends</code> / <code>similar_to</code> / <code>contradicts</code> 等)产生或变更时,会在涉及的印迹正文末尾追加一段派生 wikilinks:<code>→ [[文件名|标题 · kind]]</code>(出边)与 <code>← [[文件名|标题 · kind]]</code>(入边)。wikilink target 用<strong>文件名</strong>(Obsidian 原生解析,不依赖 frontmatter aliases),display 含<strong>目标印迹标题 + kind</strong>,不跳转就能读懂关系。<code>contradicts</code> 边在派生段内置顶。权威源仍是 <code>synapses/*.yaml</code>;派生段是 denormalized 视图,可随时从 yaml 重建。<strong>图谱看起来不对?</strong>跑一次 <code>engram_doctor</code>,它会逐条校验派生段是否与权威源一致,漂移就重建(幂等,干净仓库报 0 修复)。",

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
