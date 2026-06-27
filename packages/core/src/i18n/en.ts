/**
 * English translations
 *
 * @module @co-engram/core/i18n
 */

import type { TranslationDict } from "./types.js";

export const en: TranslationDict = {
  // ===== Engram tools (12) =====
  "tool.engram_create":
    "Create a new Engram (memory unit). Requires title / content / kind / domainTags / createdBy. Smart dedupe is on by default (dedupe=true): DUPLICATE reinforces the existing engram without creating a duplicate; UPDATE merges; NEW creates.",
  "tool.engram_get":
    "Read an Engram by disclosure tier (catalog / digest / content / meta / synapses / auto). auto picks a tier based on contextBudget.",
  "tool.engram_update":
    "Update Engram fields (content / title / importance / etc.).",
  "tool.engram_delete":
    "Delete an Engram (content + meta + synapses, all three files).",
  "tool.engram_search":
    "FTS full-text search (Chinese bigram + English word), with optional filters.",
  "tool.engram_list":
    "List Engrams by filter (no query — filter by metadata, reads latest state directly).",
  "tool.engram_reinforce":
    "Report an effective retrieval (LTP reinforcement + Hebbian neighbor boost). Updates effectiveRetrievals / reinforcementScore / importance (each += effectiveness × 0.02, clamped to [0,1]); neighbors get 50% boost (except contradicts).",
  "tool.engram_report_failure":
    "Report a failed use (LTD weakening). Updates failedUses / retrievalCount / importance (-0.03 per use, escalated ×1.5 after threshold). failedUses≥3 suggests archive, ≥5 suggests forget.",
  "tool.engram_archive":
    "Archive an engram (excluded from default retrieval, but data preserved and recoverable). Search excludes archived by default; use a filter to include.",
  "tool.engram_restore":
    "Restore from archived/forgotten to active (re-enters default retrieval). If the engram has been swept to .trash/, it is moved back first before restoring.",
  "tool.engram_forget":
    "Actively forget an engram (RIF retrieval-induced forgetting). Files remain (Git keeps history); the engram leaves all default retrieval immediately. A reason is required. Default pipeline: swept to .trash/ after 30 days (removed from main index), then physically deleted (rm) after another 365 days. Recover anytime via engram_restore or the viewer's Trash tab until purged; after purge, only git history can bring it back.",
  "tool.engram_recompute_importance":
    "Recompute the multi-dimensional importance of an engram (personal/team/project/network/temporal). network and temporal are system-derived (incomingSynapseCount + Ebbinghaus decay); the rest can be set via overrides. Result composite is written back to engram.importance.",

  // ===== Learning loop tools (4) =====
  "tool.contradiction_resolve":
    "Manually resolve a contradicts synapse (spec §3.9 phase 2 human intervention). Requires verdict + rationale + resolvedBy. The system marks synapse.resolutionState as resolved and appends to the evidence array.",
  "tool.close_learning_loop":
    "Close the learning loop (dopamine closure): feed usage outcome back to the system. success/partial → LTP reinforcement + Hebbian neighbor boost; failure → LTD weakening + demotion threshold check. Also triggers the provenance reward/punishment circuit if configured.",
  "tool.upgrade_verification":
    "Upgrade an engram verification status (unverified → plausible → probable → verified → refuted). Must provide evidence description + verifier. The system validates the state machine (no level skipping) + 3D evidence conditions (evidenceCount + cross-context domainTags + temporal stability days). force=true skips condition checks but keeps state machine validation (manual override scenario).",
  "tool.get_evolution_lineage":
    "Trace the evolution lineage of an engram (spec §12.7 scenario 6). Follows derives_from / consolidates / supersedes synapses both ways: ancestors = sources (observation etc.), descendants = evolution results (pattern/procedure etc.). Returns DAG nodes and edges for graph visualization. spec §4.6 acceptance: from a Skill you can trace back to the original observation chain.",

  // ===== Synapse tools (4) =====
  "tool.synapse_create":
    "Create a Synapse (connection) between two Engrams. Updates incoming/outgoing caches on both ends.",
  "tool.synapse_get": "Read a single Synapse (by from engramId + synapseId).",
  "tool.synapse_delete": "Delete a Synapse (updates both caches).",
  "tool.synapse_list":
    "List all Synapses of an Engram (outgoing / incoming / both).",

  // ===== Skill tools (2) =====
  "tool.skill_get":
    "Read Skill metadata (procedural memory). P0 reads from in-memory registry.",
  "tool.skill_invoke":
    "Invoke a Skill (procedural memory). P0 is a framework; concrete template execution (tool-sequence / prompt-template) lands in P1.",

  // ===== Proposal tools (3) =====
  "tool.engram_list_proposals":
    "List topic proposal candidates. When a topic is mentioned multiple times in conversation but has no matching engram, the system generates a pending proposal for confirmation. Returns pending only by default; pass includeAll=true to see accepted/dismissed history.",
  "tool.engram_accept_proposal":
    "Accept a proposal candidate → the system auto-creates the corresponding engram and marks the proposal as accepted. Future occurrences of the same topic will not generate duplicate proposals.",
  "tool.engram_dismiss_proposal":
    "Dismiss a proposal candidate. Suppressed for 30 days by default; override via dismissDays. Reason can be filled for meta-learning.",

  // ===== Repository health tools (2) =====
  "tool.engram_doctor":
    "Run a self-healing scan over the memory repo. Auto-fixes moved files, title renames, and stale index entries; reports dangling synapse references and orphan markdown for manual review.",
  "tool.engram_list_paths":
    "List the physical directory tree of the memory repo with cumulative engramCount per node, for progressive disclosure before searching.",

  // ===== OpenClaw-compatible memory tools (2) =====
  "tool.memory_search":
    "Search team memory (engrams) using natural language. Returns relevant memory snippets with relevance scores. Call this when the user asks about past decisions, preferences, people, dates, or project context.",
  "tool.memory_get":
    "Read full content of a single memory (engram) by ID. Returns content, metadata (importance, truthScore, reinforcementCount), and related memory IDs. Use after memory_search to dive into specifics.",

  // ===== System prompts (buildProposalPrompt) =====
  "prompt.proposal_prompt":
    "[co-engram] ${count} memory candidate${plural} pending (topic${plural} seen ≥3 times but not recorded). Use `engram_list_proposals` to view, `engram_accept_proposal` to record, or `engram_dismiss_proposal` to ignore.",

  // ===== Memory section prompts (OpenClaw registerMemoryCapability.promptBuilder) =====
  "prompt.memory.section_header": "## Memory Recall (co-engram)",
  "prompt.memory.when_to_search":
    'When to call memory_search: semantic retrieval — user asks "what do we know about X / did we discuss X / find memories about X". The query is a search keyword (e.g. "low-friction-defaults", "ADB debugging"), NOT a "list all" instruction — empty query throws. Run memory_search first, then memory_get for full content on specific hits.',
  "prompt.memory.when_to_list":
    'When to call engram_list (listing scenario): user asks "what memories do I have / list all memories / show my memory store / how many memories" — use the engram_list tool (paginated + filtered), NOT memory_search. memory_search ranks by keyword relevance; listing everything needs engram_list. Optional filters: domainTags, kind (fact/pattern/procedure/observation), status (active/archived).',
  "prompt.memory.when_not_to_search":
    "When NOT to call: general knowledge questions, pure code problems unrelated to team context, simple greetings. Avoid redundant searches for topics already answered in this conversation.",
  "prompt.memory.reading_results":
    "Reading results: each memory has a truthScore (0-1). Treat memories with truthScore < 0.4 cautiously — consider calling close_learning_loop after verification. Cite memories by engram ID (e.g. [engram_abc123]) when the user benefits from verifying the source.",
  "prompt.memory.writing":
    'When creating/updating memories (engram_create / engram_update): leave createdBy blank to let the system auto-resolve to git user.name or plugin config.defaultCreatedBy. **Do NOT fill in generic words like "AIOS" / "openclaw" / "assistant" / "system"** — these are not real authors and break audit log traceability. Only pass createdBy explicitly when the user requests a specific authorship tag (team name, external system name, etc.).',
  "prompt.memory.when_to_reinforce":
    "When to call engram_reinforce: use your **own judgment** — when a cited memory actually helped complete the task, was adopted into your answer, or successfully guided a decision, call engram_reinforce(id, effectiveness) on it. effectiveness: 1.0=fully useful, 0.7=mostly useful, 0.4=background reference only. Call engram_report_failure when the memory was wrong or stale. co-engram is a self-evolving system: your reinforcement signal is the primary input to importance scoring — call it proactively, do not wait for the user to prompt you. But **be honest**: do not give high scores for tangential references — over-reinforcing lets low-value memories drown out high-value ones.",
  "prompt.memory.proposal_reminder":
    "Pending proposals: ${count} memory candidate(s) awaiting review. Call engram_list_proposals to inspect, engram_accept_proposal to record, or engram_dismiss_proposal to suppress.",
  "prompt.memory.frequent_topics":
    "Frequent topics in this team-memory: ${tags}. These are domains where memory_search is most likely to return useful context.",
  "prompt.memory.missed_topics":
    "Recently missed topics (consider searching proactively): ${topics}. Past turns suggest these should have triggered memory_search but did not.",
  "prompt.memory.low_confidence_topics":
    "Low-confidence topics frequently retrieved: ${topics}. Consider close_learning_loop or upgrade_verification to strengthen these memories.",

  // ===== Viewer UI strings =====
  "viewer.title": "Co-Engram",
  "viewer.slogan": "Self-evolving team memory",
  "viewer.tab.stats": "Stats",
  "viewer.tab.engrams": "Engrams",
  "viewer.tab.graph": "Graph",
  "viewer.tab.proposals": "Proposals",
  "viewer.tab.audit": "Audit",
  "viewer.tab.trash": "Trash",
  "viewer.tab.config": "Config",
  "viewer.tab.help": "Help",
  "viewer.tab.merges": "Merges",
  "viewer.search.placeholder": "Full-text search engrams...",
  "viewer.search.button": "Search",
  "viewer.search.clear": "Clear",
  "viewer.search.clear_title":
    "Clear search results and return to default stats view",
  "viewer.auth.prompt": "This viewer requires a token.",
  "viewer.auth.placeholder": "Bearer token",
  "viewer.loading.stats": "Loading stats...",
  "viewer.loading.engrams": "Loading engrams...",
  "viewer.loading.graph": "Loading graph...",
  "viewer.loading.proposals": "Loading proposals...",
  "viewer.loading.audit": "Loading audit log...",
  "viewer.loading.trash": "Loading trash...",
  "viewer.loading.config": "Loading config...",
  "viewer.section.proposals": "Memory Proposals",
  "viewer.section.audit": "Audit Log",
  "viewer.section.trash": "Trash",
  "viewer.section.engrams": "Engrams",
  "viewer.section.graph": "Graph",
  "viewer.footer": "Co-Engram Viewer — loopback only (127.0.0.1)",

  // ===== CLI strings =====
  "cli.init.welcome":
    "Welcome to Co-Engram. Let's set up your team-memory repository.",
  "cli.init.data_root_prompt": "Where should team-memory live? (absolute path)",
  "cli.init.data_root_default": "Default: $HOME/team-memory",
  "cli.init.language_prompt":
    "Choose the language for tool descriptions, viewer UI, and system prompts:",
  "cli.init.language_option_en":
    "English (recommended for international teams)",
  "cli.init.language_option_zh": "简体中文 (recommended for Chinese teams)",
  "cli.init.created_by_prompt":
    "Default creator identifier for new engrams (e.g. your name):",
  "cli.init.dir_exists": "Directory exists, reusing.",
  "cli.init.dir_created": "Directory created.",
  "cli.init.git_initialized": "Git repository initialized.",
  "cli.init.git_skipped": "Already a Git repo, skipping git init.",
  "cli.init.config_written": "Wrote config to ${path}.",
  "cli.init.next_steps": "Next steps:",
  "cli.init.next_step_mcp":
    "  Wire to Claude Code: claude mcp add co-engram -e CO_ENGRAM_DATA_ROOT=${path} --scope user -- co-engram-mcp",
  "cli.init.next_step_openclaw":
    "  Wire to OpenClaw: install @co-engram/openclaw into extensions/ and set plugins.entries.co-engram.config.dataRoot=${path}",
  "cli.init.done": "Done. Happy remembering!",
  "cli.init.aborted": "Aborted.",
  "cli.init.invalid_language":
    "Invalid language choice, defaulting to English.",
  "cli.init.help_title": "Co-Engram init — initialize a team-memory repository",
  "cli.init.help_usage": "Usage: co-engram init [options]",
  "cli.init.help_path":
    "  --path <path>       Target directory (default: $HOME/team-memory)",
  "cli.init.help_language":
    "  --language <lang>   Language: en | zh (default: en, or skip flag for interactive)",
  "cli.init.help_created_by":
    "  --created-by <name> Default creator identifier (default: $USER)",
  "cli.init.help_no_git": "  --no-git            Skip git init",
  "cli.init.help_force":
    "  --force             Overwrite existing .co-engram/config.json",
  "cli.init.help_help": "  -h, --help          Show this help",
  "cli.init.language_set_env":
    "(You can override at runtime via CO_ENGRAM_LANGUAGE=zh|en)",

  // ===== Detail panel i18n (viewer runtime) =====
  // Enum display (enum.<category>.<value>)
  "enum.kind.observation": "Observation",
  "enum.kind.fact": "Fact",
  "enum.kind.pattern": "Pattern",
  "enum.kind.procedure": "Procedure",
  "enum.kind.hypothesis": "Hypothesis",

  "enum.freshness.fresh": "Fresh",
  "enum.freshness.aging": "Aging",
  "enum.freshness.stale": "Stale",
  "enum.freshness.forgotten": "Forgotten",

  "enum.status.draft": "Draft",
  "enum.status.active": "Active",
  "enum.status.archived": "Archived",
  "enum.status.forgotten": "Forgotten",

  "enum.sourceType.firsthand": "Firsthand",
  "enum.sourceType.secondhand": "Secondhand",
  "enum.sourceType.inferred": "Inferred",

  "enum.emotionalValence.positive": "Positive",
  "enum.emotionalValence.neutral": "Neutral",
  "enum.emotionalValence.negative": "Negative",

  "enum.verificationStatus.unverified": "Unverified",
  "enum.verificationStatus.plausible": "Plausible",
  "enum.verificationStatus.probable": "Probable",
  "enum.verificationStatus.verified": "Verified",
  "enum.verificationStatus.refuted": "Refuted",

  // Field labels (field.label.<name>)
  "field.label.id": "ID:",
  "field.label.title": "Title:",
  "field.label.domainTags": "Domain tags:",
  "field.label.contextTags": "Context tags:",
  "field.label.content": "Content",
  "field.label.stats": "Stats",
  "field.label.retrievals": "Retrievals:",
  "field.label.effective": "Effective:",
  "field.label.failures": "Failures:",
  "field.label.creator": "Creator:",
  "field.label.time": "Time:",
  "field.label.confidence": "Confidence:",
  "field.label.status": "Status:",
  "field.label.freshness": "Freshness:",
  "field.label.importance": "Importance:",
  "field.label.valueAssessment": "Value Assessment",
  "field.label.multiDimImportance": "Multi-dim Importance",
  "field.label.encodingContext": "Memory Formation Context",
  "field.label.encodingContextValue": "Memory formation context:",
  "field.label.perspective": "Perspective:",
  "field.label.decayProgress": "Decay Progress",
  "field.label.evidenceCount": "Evidence count:",
  "field.label.lastEffective": "Last effective:",
  "field.label.reinforcementScore": "Reinforcement score:",
  "field.label.emotionalValence": "Emotional valence:",
  "field.label.sourceType": "Source type:",
  "field.label.verificationStatus": "Verification status:",
  "field.label.decayHalfLife": "Decay half-life:",

  // Section titles (section.<name>)
  "section.content": "Content",
  "section.stats": "Stats",
  "section.valueAssessment": "Value Assessment",
  "section.multiDimImportance": "Multi-dim Importance",
  "section.encodingContext": "Memory Formation Context",

  // Action buttons (action.<name>)
  "action.edit": "Edit",
  "action.delete": "Delete",
  "action.close": "Close",
  "action.detailView": "Detail View",

  // Common strings (common.<name>)
  "common.none": "None",
  "common.never": "Never",
  "common.unknown": "Unknown",
  "common.totalCount": "${n} total",

  // Decay visualization (decay.<name>)
  "decay.daysToNext": "${days} days to next downgrade",
  "decay.forgotten": "Forgotten",
  "decay.neverDecays": "Never decays",
  "decay.neverDecaysTip":
    "This engram has decayHalfLifeDays=null; the system does not track its decay.",
  "decay.neverEffective": "Not yet effectively used",
  "decay.neverEffectiveTip":
    "This engram has not been positively reinforced (engram_reinforce / close_learning_loop success) since creation, so lastEffectiveAt is unset and decay cannot be computed. Tracking begins after the first effective use.",
  "decay.levelLabel": "Current: ${level}",

  // List view (engrams.<area>.<name>)
  "engrams.searchPlaceholder": "Search by title or tags...",
  "engrams.filter.kind": "Kind",
  "engrams.filter.kindAll": "All",
  "engrams.filter.sort": "Sort",
  "engrams.filter.sortNewest": "Newest first",
  "engrams.filter.sortOldest": "Oldest first",
  "engrams.filter.sortImportance": "Importance ↓",
  "engrams.filter.sortRetrievals": "Retrievals ↓",
  "engrams.view.card": "Card",
  "engrams.view.tree": "Tree",
  "engrams.countTotal": "${n} total",
  "engrams.countFiltered": "Showing ${shown} / ${total}",
  "engrams.empty": "No matching memories",
  "engrams.retrievalsCount": "Retrievals ${n}",
  "engrams.untagged": "Untagged",
};
