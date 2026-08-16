/**
 * English translations
 *
 * @module @co-engram/core/i18n
 */

import type { TranslationDict } from "./types.js";

export const en: TranslationDict = {
  // ===== Engram tools (12) — user layer: plain language, no implementation terms =====
  "tool.engram_create":
    "Create a new memory. Requires title, content, kind, domain tags, and author. Smart dedupe is on by default: duplicates reinforce the existing memory instead of creating a new one; updates merge content.",
  "tool.engram_get":
    "Read a memory's details on demand. Choose a brief summary or full content; auto-selects detail level based on token budget.",
  "tool.engram_update":
    "Update a memory's fields (content, title, importance, tags, etc.).",
  "tool.engram_delete":
    "Permanently delete a memory (including all its connections). Irreversible.",
  "tool.engram_search":
    "Search memories using natural language, with optional filters by type, tags, status, etc.",
  "tool.engram_list":
    "List memories by filter (no keyword query — filter by metadata, reads latest state).",
  "tool.engram_reinforce":
    "Report an effective use (positive reinforcement). Increases the memory's strength score and use count, and boosts related memories.",
  "tool.engram_report_failure":
    "Report a failed use (negative reinforcement). Decreases the memory's strength score; repeated failures suggest archive or forget.",
  "tool.engram_archive":
    "Archive a memory (excluded from default search, but data preserved and recoverable).",
  "tool.engram_restore":
    "Restore a memory from frozen or forgotten state back to active, re-entering default search.",
  "tool.engram_forget":
    "Actively forget a memory. Files remain (Git-tracked); the memory leaves all default search immediately. A reason is required. Automatic cleanup follows: moved to trash after 30 days, physically deleted after another 365 days; recoverable until physical deletion.",

  // ===== Learning loop tools (4) =====
  "tool.contradiction_resolve":
    "Manually resolve a contradiction between two memories (old vs new): decide which side wins, merge, or archive the loser. Requires verdict, rationale, and resolver.",
  "tool.close_learning_loop":
    "Close the verification loop: feed usage outcome back to the system. Success reinforces positively; failure weakens and triggers demotion check.",
  "tool.upgrade_verification":
    "Upgrade a memory's verification status (unverified → plausible → probable → verified). Requires evidence description and verifier. The system validates the state machine (no level skipping) and evidence conditions; force=true skips evidence checks but keeps state machine validation.",
  "tool.get_evolution_lineage":
    "Trace a memory's evolution lineage (ancestors and descendants). Follows derivation/consolidation/supersession relationships both ways, returning graph nodes and edges for visualization.",

  // ===== Synapse tools (4) =====
  "tool.synapse_create":
    "Create a Synapse (typed connection, e.g. extends / contradicts / caused-by) between two memories.",
  "tool.synapse_get": "Read a single Synapse's details.",
  "tool.synapse_delete": "Delete a Synapse.",
  "tool.synapse_list":
    "List all Synapses of a memory (outgoing / incoming / both).",

  // ===== Skill tools (2) =====
  "tool.skill_get":
    "Read Skill metadata (procedural memory: a parameterized, invocable template).",
  "tool.skill_invoke":
    "Invoke a Skill with parameters (procedural memory). Currently a framework; concrete template execution lands in a later version.",

  // ===== Proposal tools (3) =====
  "tool.engram_list_proposals":
    "List pending memory proposals. When a topic is mentioned multiple times in conversation but has no matching memory, the system generates a pending proposal for confirmation. Returns pending only by default; pass includeAll=true to see history.",
  "tool.engram_accept_proposal":
    "Accept a proposal candidate → the system auto-creates the corresponding memory and marks the proposal as accepted. Future occurrences of the same topic will not generate duplicate proposals.",
  "tool.engram_dismiss_proposal":
    "Dismiss a proposal candidate. Default is permanent (never resurfaces); pass dismissDays > 0 to allow re-activation after N days. Audit log always retained.",
  "tool.engram_accept_proposals_by_source":
    "Batch-accept proposals by source (auto-memory or external-markdown). Only sources with built-in payload are supported — no LLM fill-in needed. Use to clear hundreds to thousands of candidates at once.",
  "tool.engram_dismiss_proposals_by_filter":
    "Batch-dismiss proposals filtered by source / domainTags / time window. Typical use: clear load-test conversation pollution in one shot, or dismiss by tag. reason is required (audit retention).",
  "tool.engram_synthesize":
    "Manually trigger REM: hand a set of existing memories to an LLM and synthesize a pattern memory; auto-creates a derives_from synapse per source. Requires an LLM client. Use dryRun=true to preview without writing.",

  // ===== Repository health tools (2) =====
  "tool.engram_doctor":
    "Run a self-healing scan over the memory repo. Auto-fixes moved files, title renames, and stale index entries; reports dangling connections and orphan files for manual review.",
  "tool.engram_list_paths":
    "List the memory repo's directory tree with cumulative memory count per node, for orienting before searching.",
  "tool.engram_sync":
    "Manually trigger a full memory sync: pull (rebase) → commit → push. Gives the user explicit control over when memories are persisted to the remote, as opposed to the automatic dirty-marking. Conflicts are reported, not auto-resolved. Degrades to commit-only when no remote is configured. Compatible with any git host (GitHub / GitLab / Gerrit / internal).",
  "tool.engram_audit_query":
    "Query the audit log (team memory event history, audit.jsonl). Surfaces AuditLog.query() to LLM agents so they can inspect the modification timeline of any engram or action class without leaving the chat.",

  // ===== OpenClaw-compatible memory tools (2) =====
  "tool.memory_search":
    "Search team memory using natural language. Returns relevant memory snippets with relevance scores. Call this when the user asks about past decisions, preferences, people, dates, or project context.",
  "tool.memory_get":
    "Read full content of a single memory by ID. Returns content, metadata, and related memory IDs. Use after memory_search to dive into specifics.",

  // ===== Tool descriptions: agent layer (LLM-facing, structured WHEN/RETURNS) =====
  // Migrated from LLM_TOOL_DESCRIPTIONS + 13 new entries for previously-uncovered tools.
  // Forbidden terms: FTS / LTP / Hebbian / RPE / reinforcementScore / effectiveRetrievals / failedUses.
  // truthScore allowed only in engram_get (field name reference).
  "tool.engram_search.agent": `Search team memory for past decisions, preferences, project context.

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
  "tool.engram_get.agent": `Read full content of a single memory (engram) by ID.

WHEN TO CALL:
- After engram_search returned a hit you want to read in full
- User explicitly asks for details on a specific engram ID
- You need metadata (importance, tags, verification status) not shown in search summary

WHEN NOT TO CALL:
- You haven't called engram_search yet (search first)
- The engram ID is from an outdated conversation (re-search to verify)

RETURNS: Full content + metadata (createdAt, importance, truthScore, reinforcementCount) + related engram IDs (synapses).

CONCEPT: {{concept:engram|userExplanation}}`,
  "tool.engram_create.agent": `Create a new memory (engram) for important knowledge.

WHEN TO CALL: durable preference, design decision with rationale, bug lesson, or correcting an outdated memory.

WHEN NOT TO CALL: trivial info / already in CLAUDE.md / just asking (use engram_search).

⚠️ visibility='private' for credentials/paths/device-specific info (gitignored under private/).

⚠️ This tool is the **single** durable memory write path this session. Do NOT write ~/.claude/projects/<cwd>/memory/*.md — AutoMemorySyncEngine mirrors it as pending proposals with visibility lost. All memories go through this tool.

RETURNS: engram ID + version. Duplicates auto-detected.`,
  "tool.engram_update.agent": `Update an existing memory when its content needs refinement (not contradiction).

WHEN TO CALL:
- Adding details to an existing engram ("the migration also needs to handle X")
- Correcting a typo / imprecise wording in memory
- The user clarifies a previous memory ("what I meant was...")

WHEN NOT TO CALL:
- The new info contradicts the old (use engram_create + contradiction_resolve instead)
- The memory is fine as-is (don't update just to refresh timestamp)

⚠️ Changing visibility migrates file path (private → private/<domainTags>/; other → <domainTags>/); atomic, fails on conflict, stableId preserved.

**Visibility**: if new content has risk signals and current is public/team, ask whether to downgrade to private.

RETURNS: Updated engram + new version number.`,
  "tool.engram_list.agent": `Browse all memories (paginated), newest first.

WHEN TO CALL:
- User wants an overview of stored memories ("what do you know about me")
- You need to find a memory but don't have a precise search query
- Reviewing what's been captured recently

WHEN NOT TO CALL:
- You have a specific query (use engram_search instead — faster and more relevant)
- Just to check if a memory exists (search by content)

RETURNS: List of engram summaries (title, tags, updatedAt) + total count. Use cursor/limit for pagination.`,
  "tool.synapse_create.agent": `Create a typed connection between two memories (synapse).

WHEN TO CALL:
- A new memory extends / contradicts / relates to an existing one
- User mentions causal or dependency ("X happened because of Y")
- Linking a decision to rationale, or a bug to its fix

WHEN NOT TO CALL:
- The two memories are unrelated
- Pick the closest of the 5 families; do not skip just because uncertain, do not force.

RETURNS: Synapse ID + from/to engram IDs. 12 kinds, 5 families: structural (extends/part_of/similar_to), causal (depends_on/causes/follows), evidential (derives_from/contradicts/exemplifies), temporal (supersedes/consolidates), modulatory (contextualizes).

SIDE EFFECTS:
- kind="contradicts": writes audit events (engram_audit_query), triggers resolution.`,
  "tool.engram_reinforce.agent": `Mark a memory as effectively used (positive reinforcement).

WHEN TO CALL:
- You cited an engram ID in your answer and the user accepted the result
- A retrieved memory directly contributed to solving the task
- After successfully completing a task that depended on a memory

WHEN NOT TO CALL:
- You didn't actually use the memory (just skimmed it)
- The task failed or the memory was wrong (use engram_report_failure instead)

RETURNS: Memory's strength score increased + effective-use count incremented.`,
  "tool.engram_report_failure.agent": `Report a retrieval that produced a wrong answer (cumulative LTD weakening).

WHEN TO CALL:
- A retrieved memory led you to a wrong answer or wrong path
- User says "this is wrong" but you're unsure if the memory itself is invalid or just didn't fit

WHEN NOT TO CALL:
- Fact definitively changed → use engram_delete (immediate)
- Memory is just incomplete (use engram_update)
- You're not sure (ask the user first)

Mechanism: cumulative negative feedback — one call drops importance by a fixed step (default −0.1, D1 dynamics); after several accumulations a maintenance cycle may auto-refute it. Deterministic invalidation should NOT go this route.

RETURNS: { ok: true, importance, failureCount } + audit recorded.`,
  "tool.engram_delete.agent": `Permanently delete a memory (immediate, irreversible).

⚠️ Confirm before calling unless user explicitly asked to delete.

WHEN TO CALL:
- User explicitly asks to delete ("remove that memory about X")
- Memory duplicated (keep one) or contains sensitive info
- Fact definitively invalid (verified by runtime or user statement, not speculation) — bypasses cumulative engram_report_failure

WHEN NOT TO CALL:
- Retrieval merely produced a wrong answer (use engram_report_failure)
- User is ambiguous ("forget that" — confirm what they mean)

RETURNS: { deleted: true } or error.

⚠️ Fail-loud: post-checks deletion; throws "still exists" on cross-process race / inconsistency (run engram_doctor).`,
  "tool.close_learning_loop.agent": `Feed a memory's usage outcome back to close the learning loop (reinforces importance/confidence).

WHEN TO CALL:
- You used a memory, verified it works, want to signal it was useful (raises importance/confidence)
- After positive feedback confirming the memory is accurate
- Completing the "retrieve → use → feedback" cycle

WHEN NOT TO CALL:
- Not verified yet (wait until confirmation is solid)
- Memory turned out wrong (use engram_report_failure)
- Upgrading verification status (unverified→plausible→probable→verified): use upgrade_verification; this tool does NOT change verificationStatus

RETURNS: closed-loop metadata (importance, importanceDelta, shouldArchive, shouldForget). Does NOT write verificationStatus — use upgrade_verification for upgrades.`,
  "tool.contradiction_resolve.agent": `Resolve a contradiction between two memories (old vs new).

WHEN TO CALL:
- A new memory explicitly contradicts an older one
- User confirms the old memory is wrong and should be refuted
- You need to mark which side wins in a contradiction synapse

WHEN NOT TO CALL:
- The two memories are just different perspectives (resolve as merge / archive; the replacement synapse should use similar_to or contextualizes, not contradicts)
- You're not sure which is right (ask the user)

RETURNS: Resolution record + updated verification status on both engrams.`,
  "tool.engram_list_proposals.agent": `List pending memory proposals (implicit capture candidates awaiting review).

WHEN TO CALL:
- System prompt shows "N memory candidates pending"
- User asks "what proposals do you have" or "review pending memories"
- Periodically to triage captured but unconfirmed memories

WHEN NOT TO CALL:
- No pending proposals (system prompt will show 0)
- You just searched explicitly (use engram_search)

RETURNS: List of proposals. Each carries \`source\` ("conversation" = chat clustering, "auto-memory" = Claude Code auto-memory file, "external-markdown" = untracked .md detected under dataRoot). Auto-memory and external-markdown proposals carry \`proposedTitle\`/\`proposedContent\`/\`proposedDomainTags\`/\`proposedKind\` (full payload to write on accept) — accept directly without re-typing.`,
  "tool.engram_accept_proposal.agent": `Accept a pending memory proposal (convert it to a real engram).

WHEN TO CALL:
- User confirms a proposal is valid ("yes, save that")
- Auto-memory / external-markdown source: payload already attached — call with just \`entityId\` (review title/domainTags/kind for sanity first)

WHEN NOT TO CALL:
- The proposal is wrong or low quality (use engram_dismiss_proposal)
- You haven't reviewed it yet

NOTE: title/content/domainTags optional for auto-memory / external-markdown (fallback to payload); conversation-source requires explicit title/content/domainTags.

**Visibility**: if payload contains risk signals, ask whether to pass visibility: "private" before accepting.

RETURNS: Created engram ID + proposal marked as accepted.`,
  "tool.engram_dismiss_proposal.agent": `Dismiss a pending memory proposal (reject the capture).

WHEN TO CALL:
- User says "no, that's not worth saving"
- Proposal is noisy / low quality / already covered
- After review, you decide it shouldn't become a memory

WHEN NOT TO CALL:
- You haven't reviewed the proposal content
- The proposal is borderline (accept + refine instead)

Default is **permanent dismiss**: status=dismissed with dismissedUntil unset; the watcher/observe pipeline will never reopen this candidate. To "temporarily suppress", pass dismissDays > 0 — the candidate can be re-activated by a new event after N days. Audit log always retained.

RETURNS: Proposal marked as dismissed + removed from pending list.`,
  "tool.engram_accept_proposals_by_source.agent": `Batch-accept proposals by source (convert to real engrams).

WHEN TO CALL:
- Dozens to thousands of auto-memory / external-markdown proposals accumulated; per-item accept is impractical
- Load-test produced many auto-memory files; after watcher converts them all to proposals, ingest in one shot

WHEN NOT TO CALL:
- Source is conversation (use single-shot engram_accept_proposal — LLM must fill title/content per item)
- You want to filter by specific domainTags (this tool only filters by source)

RETURNS: \`{ source, acceptedCount, dismissedCount (always 0), remainingCount, engramIds, failures }\`. Per-item accept failures do not abort the batch; they are recorded in the failures array. limit defaults to 200 (max 500); pending beyond the limit stays for the next call.`,
  "tool.engram_dismiss_proposals_by_filter.agent": `Batch-dismiss proposals by source / domainTags / time window filter.

WHEN TO CALL:
- Load-test produced thousands of conversation proposals; per-item dismiss is impractical
- All proposals under a given domainTag (e.g. 'load-test') must be cleared
- All proposals within a time window are noise and must be cleared in one shot

WHEN NOT TO CALL:
- Only a handful of proposals (use single-shot engram_dismiss_proposal so the LLM reviews each)
- Unsure of filter scope (run engram_list_proposals first to confirm)

RETURNS: \`{ dismissedCount, acceptedCount (always 0), remainingCount, dismissedIds, failures }\`. reason is required (audit retention). Default is permanent dismiss; pass dismissDays > 0 to allow re-activation after N days. limit defaults to 1000 (max 5000).`,
  "tool.engram_synthesize.agent": `Synthesize multiple engrams into a single pattern memory (manual REM).

WHEN TO CALL:
- Several engrams recur under one theme and combine into a reusable lesson
- After a retrospective, abstract a pattern from concrete memories
- REM's heuristic was too low-confidence, but human judgement says it's a real pattern
- You want explicit derives_from lineage links among related engrams

WHEN NOT TO CALL:
- Only one engram (use engram_update)
- Sources are unrelated (would produce garbage)
- You want to resolve conflicts (use contradiction_resolve)
- You want to deduplicate (engram_create has dedupe)
- ctx.llmClient is not configured (tool throws with setup guidance)

RETURNS: patternEngramId + synapseIds (one derives_from per source) + draft. dryRun=true returns the draft only.`,
  "tool.engram_doctor.agent": `Run a self-healing scan over the memory repo and report findings.

Auto-fixes: moved files (index re-points), renamed titles (re-slug), stale index entries, skill composes/relatedEngrams, skill utility/stats, skill contentHash. Reports for review: dangling synapses, orphan markdown, skill orphan/mismatch/duplicate/field issues — each with a nextAction.

WHEN TO CALL:
- "memory looks wrong" or search misses entries
- User edited/renamed data-root files
- After a Git merge on the repo
- Periodic health check (once per session)

WHEN NOT TO CALL: no inconsistency; for a specific engram use engram_get.

RETURNS: timestamps, counts, autoFixesApplied, pendingManualReview, issues[] (kind/path/message/autoFixed).`,
  "tool.incubation_create.agent": `Create an overnight-thinking (night) incubation entry: feed a question before sleep; the agent thinks deeply overnight; you harvest insights on waking.

WHEN TO CALL:
- User expresses night-thinking intent ("think about X overnight", "feed a question before sleep")
- User raises a question worth multi-round deep exploration that needs no immediate answer

WHEN NOT TO CALL:
- User wants an immediate answer (answer directly or use engram_search)
- One-off trivial questions

RETURNS: { id, status, question, rounds, schedule, nextRunAt }. schedule is the daily run time (HH:mm local, default 00:00); nextRunAt is non-null only for active entries (next anchor), else null. webResearchOptIn defaults to false — confirm before enabling (question summary goes to search engines).`,
  "tool.incubation_run.agent": `Run one night-thinking round immediately.

WHEN TO CALL:
- User says "think now" / "run night thinking now" (conversational entry, default mode=agent)
- Viewer/CLI async job or daily schedule (mode=auto)

WHEN NOT TO CALL:
- Entry already in-flight (30-min TTL auto-recovery)

RETURNS: mode=agent returns the fixed-protocol task package (question / seed digests / dream history / protocol) — execute inventory→plan→read-only work→incubation_report in the current session; mode=auto returns synchronously { level, proposals, cycleVetoed, rounds }.`,
  "tool.incubation_list.agent": `List night-thinking incubation entries.

WHEN TO CALL:
- User asks "my night-thinking entries", "which night are we on", "any paused entries"

RETURNS: { items: [{ id, question, status, rounds, webResearchOptIn, schedule, lastHatchedAt, nextRunAt, timelineRounds, timeline, finalAnswer? }], total }. status ∈ active|in-flight|suggested-resolve|resolved|paused. nextRunAt is non-null only for active entries (the next anchor) — null in any other status. timeline is a dream-timeline summary (lightweight fields kept in full; answerDraft full text only for the most recent 2 rounds); finalAnswer is the concluded answer, absent for unconcluded entries.`,
  "tool.incubation_resolve.agent": `Night-thinking resolve ritual: after an insight is accepted the entry becomes suggested-resolve; ask the user "did it answer your question?".

WHEN TO CALL:
- Entry status=suggested-resolve and the user has given a verdict

RETURNS: { id, status } — answered=true → resolved (dream timeline archived); false → the entry returns to active and the next scheduled anchor runs another round, which again awaits your verdict.`,
  "tool.incubation_report.agent": `Night-thinking write-back (the ONLY write path for the L2 agent).

WHEN TO CALL:
- Exactly once, after you complete inventory→plan→read-only work per the protocol returned by incubation_run (agent mode)

WHEN NOT TO CALL:
- Before executing the protocol; or when the round was already reported

RETURNS: { incubationId, proposals, cycleVetoed, rounds, status, note? }. Each insight is immediately mechanically validated + independently critiqued → rem-insight proposal (engram created only on user accept); duplicate insights are vetoed for the round (veto counts remain a diagnostic signal).`,
  "tool.incubation_conclude.agent": `Conclude a night-thinking entry: synthesize the full dream timeline into a final answer (finalAnswer) and set the entry to suggested-resolve.

WHEN TO CALL:
- The entry has accumulated enough rounds of insights to wrap up, or the user wants "the final answer to this question"

WHEN NOT TO CALL:
- Entry is still in early incubation (let nightly rounds continue)
- Deployment without llmClient injected (conclude fails loudly)

RETURNS: { id, status, finalAnswer, concludedAt }. Idempotent: may be called repeatedly, regenerating and overwriting finalAnswer; already resolved / paused entries keep their status, only finalAnswer is regenerated. Concluding does NOT auto-accept any proposal — whether the question was answered is still decided by the user via incubation_resolve.`,
  "tool.incubation_update.agent": `Rewrite the daily schedule time of a night-thinking entry.

WHEN TO CALL:
- User asks to shift the nightly run time ("think at 11pm instead", "move harvest to 6am")

WHEN NOT TO CALL:
- Entry is currently in-flight (schedule can only be rewritten outside a running round; the lock releases when the round ends or after the 30-min TTL recovery)

RETURNS: { id, schedule, nextRunAt }. schedule is HH:mm local time (default 00:00); nextRunAt is non-null only for active entries (the next anchor) — null in any other status (including suggested-resolve/paused/resolved).`,
  "tool.incubation_pause.agent": `Pause the automatic schedule of a night-thinking entry (sets paused; no more automatic runs when the anchor is due).

WHEN TO CALL:
- User says "stop running this for now" / "pause this entry"

WHEN NOT TO CALL:
- To resume (use incubation_resolve(id, false) to set the entry back to active)
- Resolved (archived) entries need no pause — they never run again

RETURNS: { id, status, nextRunAt }. nextRunAt is always null while paused (no longer scheduled); an in-flight round and concluding are unaffected; manual immediate night thinking is rejected while paused — resume first.`,
  "tool.incubation_delete.agent": `Delete a night-thinking entry itself (end of lifecycle).

WHEN TO CALL:
- User explicitly says "delete this night-thinking entry"
- The question is outdated and no longer needed

WHEN NOT TO CALL:
- Entry is currently in-flight (delete after the round ends or the 30-min TTL recovers)
- Just wants it to stop running (use incubation_pause, which keeps history)

RETURNS: { id }. Already-produced rem-insight proposals and audit records are kept (proposals go through their own accept/dismiss verdict flow); the dream timeline is removed together with the entry, unrecoverable. Confirm with the user before deleting.`,
  "tool.engram_sync.agent": `Manually trigger a full memory sync: pull → commit → push.

Flow: fetch → pull --rebase --autostash (abort + report on conflict) → add -A + commit (skip if nothing to commit) → push (auto-degrades to commit-only without remote). Creates .gitignore excluding .co-engram/ if missing.

WHEN TO CALL: user says "save/commit/push memories"; after dense authoring; dryRun=true to preview uncommitted changes.

RETURNS: { pulled:{ok,upToDate?,conflicts?}, committed:{ok,sha?,filesChanged,nothingToCommit?}, pushed:{ok,skipped?,reason?}, summary }. On conflict, pulled.ok=false + conflicts array; tool halts remaining phases.`,
  "tool.engram_list_paths.agent": `Show the physical directory tree of the memory repo so you can orient before searching.

Each node carries engramCount (cumulative for that subtree). Use it to see where memory is concentrated (which domains, which projects) before deciding what to search for.

WHEN TO CALL:
- Start of a session, before any engram_search, to map the landscape
- User asks "what do we have memories about" or "what areas does the team work on"
- You want to pick a more specific domain tag before searching

WHEN NOT TO CALL:
- You already know the query — go straight to engram_search
- User wants a specific engram (use engram_get)

RETURNS: Nested { path, engramCount, children } tree rooted at '/'. Optional maxDepth (1-10, default 5).`,
  "tool.engram_audit_query.agent": `Query the audit log (audit.jsonl) and return matching events (cursor pagination).

WHEN TO CALL:
- "modification history of this engram" (who created / reinforced / contradicted)
- Debugging importance anomalies (reinforce / report_failure sequence)
- Reviewing proposal triage (propose → accept/dismiss)
- Investigating merge conflict resolution

WHEN NOT TO CALL:
- Want current engram state (use engram_get)
- Want effectiveness charts (open viewer web UI)

RETURNS: { items: AuditEvent[], nextCursor: string|null }. limit required (1-1000);
pass nextCursor verbatim into the next call's cursor parameter to continue (mutually exclusive with until — cursor wins).
Items in chronological order; each has ts / actor / action / engramId / metadata.`,
  // 13 new agent descriptions for previously-uncovered tools
  "tool.engram_archive.agent": `Archive a memory (exclude from default retrieval, but preserve data).

WHEN TO CALL:
- Memory is no longer actively relevant but may be needed later
- User asks to "shelve" / "park" / "set aside" a memory
- Reducing noise in search results without losing history

WHEN NOT TO CALL:
- Memory is wrong (use engram_report_failure)
- Memory should be permanently removed (use engram_delete or engram_forget)
- You just want to refresh a memory (use engram_update)

RETURNS: { frozen: true } + new status. Search excludes frozen by default; use a filter to include.`,
  "tool.engram_restore.agent": `Restore an frozen or forgotten memory to active state.

WHEN TO CALL:
- User asks to "bring back" / "unarchive" / "restore" a memory
- A previously frozen memory becomes relevant again
- Recovering from the trash tab in the viewer

WHEN NOT TO CALL:
- The memory was permanently purged (only git history can recover it)
- You haven't verified the memory is still accurate (consider engram_update first)

RETURNS: { restored: true } + new status. Re-enters default retrieval immediately.`,
  "tool.engram_forget.agent": `Actively forget a memory (retrieval-induced forgetting).

Files remain (Git keeps history); the memory leaves all default retrieval immediately. A reason is required.

WHEN TO CALL:
- User explicitly says "forget this" / "stop remembering this"
- Memory is misleading and should not surface in future searches
- Soft removal before considering permanent deletion

WHEN NOT TO CALL:
- Retrieval merely produced a wrong answer (use engram_report_failure, cumulative)
- Fact definitively invalid (use engram_delete, immediate)
- User is ambiguous (confirm what they want forgotten)
- You want it still searchable (use engram_archive instead)

RETURNS: { forgotten: true } + reason recorded. Sweep: .trash/ after 30 days, physical delete after another 365 days.`,
  "tool.upgrade_verification.agent": `Upgrade a memory's verification status (unverified → plausible → probable → verified).

WHEN TO CALL:
- You verified a memory is accurate and want to mark it as confirmed
- After cross-context evidence supports the memory
- Following a successful close_learning_loop with strong evidence

WHEN NOT TO CALL:
- Without evidence (use close_learning_loop for the basic reinforcement cycle first, to accumulate effectiveness signal)
- To downgrade (this tool only upgrades; refuted is a separate path)
- Skipping levels without force=true (state machine validation will reject)

RETURNS: New verification status + evidence record. force=true skips evidence checks but keeps state machine validation.`,
  "tool.get_evolution_lineage.agent": `Trace how a memory evolved (ancestors and descendants).

WHEN TO CALL:
- User asks "where did this decision come from" / "how did this pattern emerge"
- Understanding the derivation chain of a pattern or procedure
- Reviewing whether an observation lineage supports a pattern's validity

WHEN NOT TO CALL:
- The memory has no evolution relationships (returns empty graph)
- You just want related memories (use engram_get with synapses tier)

RETURNS: DAG nodes and edges. Ancestors = sources (observations etc.), descendants = evolution results (patterns/procedures).`,
  "tool.synapse_get.agent": `Read a single synapse (connection) between two memories.

WHEN TO CALL:
- Inspecting a specific connection's metadata (weight, evidence)
- Debugging why two memories are linked
- After synapse_list returned a synapse ID you want details on

WHEN NOT TO CALL:
- To list all synapses of a memory (use synapse_list)
- To check if a connection exists (use synapse_list with filters)

RETURNS: Synapse record (id, from, to, kind, weight, evidence, resolutionState).`,
  "tool.synapse_delete.agent": `Delete a synapse (connection) between two memories.

WHEN TO CALL:
- User confirms a connection is wrong / no longer relevant
- Cleaning up an incorrect contradiction or derives_from link
- Resolving duplicates after a merge

WHEN NOT TO CALL:
- The connection is just weak (use synapse_create with lower weight instead)
- The contradiction is resolved (use contradiction_resolve, not delete)
- Without confirming the user wants the connection removed

RETURNS: { deleted: true } + both engrams' caches updated.`,
  "tool.synapse_list.agent": `List all synapses (connections) of a memory.

WHEN TO CALL:
- Reviewing what a memory connects to before deciding to update or delete
- Understanding the relationship graph around a topic
- Checking for contradictions or derivations

WHEN NOT TO CALL:
- You only need one specific synapse (use synapse_get)
- You want the full graph view (use the viewer's Graph tab)

RETURNS: List of synapses (outgoing / incoming / both) with kind, weight.`,
  "tool.skill_get.agent": `Read skill metadata (procedural memory).

WHEN TO CALL:
- Checking what a registered skill does before invoking it
- Listing available skills (procedural templates)
- Debugging skill registry issues

WHEN NOT TO CALL:
- To execute a skill (use skill_invoke)
- For declarative memory (use engram_search / engram_get)

RETURNS: Skill metadata (name, description, template kind, parameters).`,
  "tool.skill_invoke.agent": `Report a Skill usage result (success/effectiveness) and update utility + retention via Rescorla-Wagner. **This tool only records usage, does not execute the skill itself** — skill execution is done by the host (Claude Code/OpenClaw); agents call this after using a skill to report results, letting the skill's procedural memory imprint evolve with usage. Forgotten skills reject.

WHEN TO CALL:
- After executing a skill through the host, need to report results
- Skill succeeded: call with success=true + effectiveness
- Skill failed: call with success=false

WHEN NOT TO CALL:
- Before executing the skill (let host execute first)
- Just reading skill imprint (use skill_get)

RETURNS: Updated skill imprint (utility, retentionStage, successCount, failureCount).`,
  "tool.skill_create.agent": `Create a new skill (procedural memory) with parameters and policy.

WHEN TO CALL:
- User wants to save a reusable procedure or template
- After executing a task that should be remembered for future reuse
- Creating a new prompt template or tool sequence

WHEN NOT TO CALL:
- For one-time tasks without reuse value (use engram_create for declarative memory)
- Without clear skillId and policy information
- When the template is not yet stable

RETURNS: Created skill record with utility=0.5, acquisitionStage=draft, retentionStage=active.`,
  "tool.skill_list.agent": `List all skills with optional filtering by acquisition/retention stage.

WHEN TO CALL:
- User asks "what skills are available" / "show me all procedures"
- Reviewing procedural memory inventory
- Finding skills by stage (draft/compiled/tuned or active/aging/stale/forgotten)

WHEN NOT TO CALL:
- To read a specific skill's details (use skill_get)
- For declarative memory search (use engram_search)

RETURNS: Array of skills with metadata (utility, stages, invocation counts).`,
  "tool.skill_update.agent": `Update a skill's metadata (initiation set, termination, policy, visibility, or acquisition stage).

WHEN TO CALL:
- Improving a skill's trigger conditions or termination criteria
- Changing a skill's visibility (public/team/private)
- Moving a skill from draft→compiled→tuned (forward only, single step)

WHEN NOT TO CALL:
- To change skillId (immutable — create new skill instead)
- Backward transitions (tuned→compiled, compiled→draft are illegal)
- Without confirming the user wants the modification

RETURNS: Updated skill record with incremented version.`,
  "tool.skill_delete.agent": `Delete a skill's sidecar imprint (does not touch the SKILL.md file itself).

WHEN TO CALL:
- User confirms a skill is obsolete or wrong
- Cleaning up test/temporary skills
- Removing a skill that should never be invoked again

WHEN NOT TO CALL:
- To temporarily disable a skill (use skill_update to change visibility)
- Without confirming deletion (user should approve)
- When you might want to recover it later (deletion is permanent)

RETURNS: { id, deleted: true }. SKILL.md file unchanged; only sidecar removed.`,
  "tool.skill_compose_add.agent": `Add a compose link: skill A can be orchestrated into skill B's workflow (skill chaining). Deduplicates.

WHEN TO CALL: User wants one skill to be a step in another skill's larger workflow.

RETURNS: Updated skill record with the new compose target.`,
  "tool.skill_compose_remove.agent": `Remove a compose link from a skill.

WHEN TO CALL: A skill is no longer part of another skill's workflow, or the link was wrong.

RETURNS: Updated skill record with the target removed.`,
  "tool.skill_compose_list.agent": `List a skill's compose links (which workflows this skill can be orchestrated into).

WHEN TO CALL: User wants to see which skills this one can be composed into, or before adding/removing a compose link to inspect current state.

RETURNS: { composes: string[] } — the target skillIds this skill chains into.`,
  "tool.skill_related_engram_add.agent": `Link a skill to an engram (procedural ↔ declarative memory). Deduplicates.

WHEN TO CALL: A skill's rationale is captured in an engram and you want them findable together.

RETURNS: Updated skill record with the new relatedEngram.`,
  "tool.skill_related_engram_remove.agent": `Remove a skill↔engram link.

WHEN TO CALL: The engram was deleted or the link no longer applies.

RETURNS: Updated skill record with the engram removed.`,
  "tool.skill_related_engram_list.agent": `List the engrams linked to a skill (procedural ↔ declarative memory cross-links).

WHEN TO CALL: User wants the context/rationale engrams behind a skill, or before adding/removing a link to inspect current related engrams.

RETURNS: { relatedEngrams: string[] } — the linked engram ids.`,
  "tool.memory_search.agent": `Search team memory using natural language. Returns relevant memory snippets with relevance scores.

WHEN TO CALL:
- User asks about past decisions, preferences, people, dates, or project context
- User references prior work ("we decided", "previously", "last time")
- You need team history that may not be in the current code or docs

WHEN NOT TO CALL:
- Pure code questions unrelated to team history
- General programming knowledge (use web search)
- When you already know the answer from this conversation

RETURNS: Hits with id, title, content snippet, score, metadata. Use memory_get for full content.`,
  "tool.memory_get.agent": `Read full content of a single memory by ID.

WHEN TO CALL:
- After memory_search returned a hit you want to read in full
- User explicitly asks for details on a specific memory ID
- You need metadata (importance, kind, tags) not shown in search summary

WHEN NOT TO CALL:
- You haven't called memory_search yet (search first)
- To list all memories (use engram_list)

RETURNS: Full content + metadata (importance, tags, kind) + related memory IDs.`,

  // ===== Tool descriptions: technical layer (developer/audit-facing, full contract) =====
  // Allows implementation terms (FTS / LTP / Hebbian / RPE). Documents parameter semantics,
  // error conditions, side effects, and invariants. Used in technical docs, API contracts, debug.
  "tool.engram_search.technical": `FTS5 full-text search (Chinese bigram tokenizer + English word tokenizer).
Input: { query: string; filter?: { domainTags?, kind?, kinds?, status?, freshness?, createdBy?, createdAfter?, createdBefore?, minImportance? }; limit?: number }
Side effects: none (read-only). Does not update lastRetrievedAt (use engram_reinforce for that).
Error conditions: empty query throws; limit clamped to [1, 100].
Invariant: frozen engrams excluded unless filter.status includes 'frozen'.
Index: reads digest.jsonl + FTS index; cold-start rebuilds if missing.`,
  "tool.engram_get.technical": `Read engram by disclosure tier (progressive disclosure to control token cost).
Input: { id: EngramId; tier?: 'catalog' | 'digest' | 'content' | 'meta' | 'synapses' | 'auto'; contextBudget?: number }
- catalog: id + title + kind + tags (smallest)
- digest: + summary + importance + timestamps
- content: + full body
- meta: + frontmatter (all fields)
- synapses: + outgoing/incoming edges
- auto: picks tier based on contextBudget (default)
Side effects: none. Does NOT update lastRetrievedAt (use engram_reinforce).
Error conditions: not found throws; invalid tier throws.
truthScore field exposed here (field-name reference allowed).`,
  "tool.engram_create.technical": `Create new engram. Input: { title, content, kind, domainTags, createdBy, summary?, contextTags?, importance?, confidence?, sourceType?, visibility?, dedupe?, encodingContext? }
kind enum: observation | fact | pattern | procedure | hypothesis.
Dedupe mode (default true): DUPLICATE reinforces existing (calls recordRetrievalSuccess); UPDATE merges content; NEW creates.
Side effects: writes engrams/<slug>.md + .meta.json + .synapses.json; appends audit event; marks repo dirty.
Error conditions: missing required fields throws; invalid kind throws.
Invariant: slug uniqueness enforced; collision appends suffix.`,
  "tool.engram_update.technical": `Update engram fields. Input: { id, title?, content?, summary?, importance?, domainTags?, contextTags?, visibility?, updatedBy, kinds? }
Optimistic lock: version field checked (Finding 231 — pending impl).
Side effects: rewrites .md + .meta.json; appends audit; updates digest/graph index incrementally; marks dirty.
Error conditions: not found throws; version mismatch throws (when implemented).
Invariant: title change triggers re-slug + file rename.`,
  "tool.engram_delete.technical": `Hard delete engram. Input: { id }
Side effects: removes .md + .meta.json + .synapses.json; removes incoming synapses on other engrams; rebuilds digest/graph; appends audit.
Deletion order (F3): index first → file → synapses. Any mid-step failure lands in doctor-self-healable territory (orphan_markdown / dangling_synapse); no fail-silent gap.
Error conditions: not found throws; post-check detects engram still exists (race / inconsistency) throws "still exists".
Invariant: irreversible (vs engram_forget which keeps files). Git history is the only recovery.
Warning: prefer engram_archive or engram_forget for soft removal.`,
  "tool.engram_list.technical": `List engrams by filter (no query — pure metadata filter, reads latest state).
Input: { filter?: same as engram_search; limit: 1..500 (required); cursor?: string|null }
Returns: { items: [{id,title,kind,domainTags}], nextCursor: string|null }.
Side effects: none.
Pagination: cursor-based, opaque token; nextCursor=null means no more results. Sort: importance DESC, updatedAt DESC, id ASC.
Invariant: reads engram-index.json (catalog); does not read full content. Faster than engram_search for listing.`,
  "tool.engram_reinforce.technical": `Report effective retrieval (LTP). Input: { id, effectiveness: 0..1, note? }
Updates: effectiveRetrievals += 1; reinforcementScore += effectiveness; importance = dynamics.updateOnReinforce(current, effectiveness) (default +0.1, clamped [0,1]).
Hebbian boost: neighbor engrams (via synapses) get 50% delta, except contradicts synapse kind.
Side effects: writes .meta.json for target + neighbors; appends audit (action=importance_update, reason=reinforce); appends effectiveness signal.
Error conditions: not found throws; effectiveness out of range throws.
Note: this path is distinct from maintenance applyRpeUpdate (Finding 124) — tool path grows importance, maintenance path does not.`,
  "tool.engram_report_failure.technical": `Report failed use (LTD). Input: { id, reason, context? }
Updates: failedUses += 1; retrievalCount += 1; importance = dynamics.updateOnReportFailure(current) (default -0.1, fixed).
Auto-suggest: failedUses ≥ archiveThreshold (default 3) → suggest archive; ≥ forgetThreshold (default 5) → suggest forget.
Side effects: writes .meta.json; appends audit (action=importance_update, reason=report_failure); appends effectiveness signal (failure).
Error conditions: not found throws; empty reason throws.`,
  "tool.engram_archive.technical": `Archive engram. Input: { id, reason? }
Status transition: active → frozen.
Side effects: writes .meta.json (status); rebuilds digest (excludes frozen from default FTS).
Error conditions: not found throws; already frozen is idempotent.
Invariant: data preserved; recoverable via engram_restore. Search excludes frozen unless filter.status='frozen'.`,
  "tool.engram_restore.technical": `Restore from frozen/forgotten. Input: { id }
Status transition: frozen|forgotten → active.
If engram was swept to .trash/, moves files back first.
Side effects: writes .meta.json; rebuilds digest; appends audit.
Error conditions: not found throws; physically purged throws (irrecoverable).
Invariant: re-enters default retrieval immediately.`,
  "tool.engram_forget.technical": `RIF retrieval-induced forgetting. Input: { id, reason }
Status: active|frozen → forgotten.
Files preserved (Git-tracked). Leaves all default retrieval immediately.
Sweep pipeline (maintenance): forgotten → 30d → .trash/ (removed from main index) → 365d → physical rm.
Side effects: writes .meta.json (status + forgottenAt); rebuilds digest; appends audit.
Error conditions: not found throws; empty reason throws.
Recovery: engram_restore anytime before physical purge; after purge, only git history.`,
  "tool.contradiction_resolve.technical": `Resolve contradicts synapse. Input: { fromId, synapseId, verdict: 'keep_new' | 'keep_old' | 'merge' | 'archive', rationale, resolvedBy }
Updates: synapse.resolutionState = 'resolved'; appends to evidence[]; if verdict=archive, loser engram status → frozen.
Side effects: writes synapse file + .meta.json (if archive); appends audit.
Error conditions: not found throws; non-contradicts synapse throws; already resolved throws.
Spec ref: §3.9 phase 2 human intervention.`,
  "tool.close_learning_loop.technical": `Close verification loop. Input: { engramId, outcome: 'success' | 'failure' | 'partial', effectiveness?, reportedBy }
success/partial → LTP (engram_reinforce path) + Hebbian neighbor boost.
failure → LTD (engram_report_failure path) + demotion threshold check (auto-archive if below).
Triggers provenance reward/punishment circuit if configured.
Side effects: writes .meta.json (importance + confidence + reinforcementScore); appends audit + effectiveness signal. Does NOT write verificationStatus (use upgrade_verification for status upgrades).
Error conditions: not found throws; invalid outcome throws.`,
  "tool.upgrade_verification.technical": `Upgrade verification status. Input: { id, evidenceDescription, verifier, force? }
State machine: unverified → plausible → probable → verified (no skipping). refuted is separate path.
3D evidence conditions: evidenceCount ≥ N + cross-context domainTags + temporal stability days.
force=true: skip evidence condition checks but keep state machine validation.
Side effects: writes .meta.json (verificationStatus + evidence[]); appends audit.
Error conditions: not found throws; invalid transition throws; insufficient evidence throws (without force).
Spec ref: §3.9 phase 1.`,
  "tool.get_evolution_lineage.technical": `Trace evolution DAG. Input: { id, direction?: 'ancestors' | 'descendants' | 'both', maxDepth? }
Follows synapse kinds: derives_from / consolidates / supersedes (bidirectional).
Returns: { nodes: Engram[], edges: Synapse[] }.
Side effects: none (read-only).
Invariant: ancestors = sources (observation/hypothesis), descendants = evolution results (pattern/procedure).
Spec ref: §4.6 acceptance, §12.7 scenario 6.`,
  "tool.synapse_create.technical": `Create synapse. Input: { from, to, kind, weight?, evidence?, createdBy?, sourceSemantic?, targetSemantic? }
kind enum: extends | part_of | similar_to | depends_on | causes | follows | derives_from | contradicts | exemplifies | supersedes | consolidates | contextualizes.
Side effects: writes .synapses.json on both ends (outgoing + incoming caches); appends audit.
Error conditions: from/to not found throw; self-loop throws; duplicate throws.
Invariant: contradicts synapse creates a contradiction entry for resolution tracking.`,
  "tool.synapse_get.technical": `Read single synapse. Input: { from, synapseId }
Returns: full synapse record (id, from, to, kind, weight, evidence, resolutionState, createdAt).
Side effects: none.
Error conditions: not found throws.`,
  "tool.synapse_delete.technical": `Delete synapse. Input: { from, synapseId }
Side effects: removes from .synapses.json on both ends; rebuilds graph index; appends audit.
Error conditions: not found throws.
Invariant: contradicts synapse deletion also clears contradiction entry (use contradiction_resolve for explicit verdict instead).`,
  "tool.synapse_list.technical": `List synapses of an engram. Input: { from, direction?: 'outgoing' | 'incoming' | 'both' }
Returns: array of synapse records.
Side effects: none.
Invariant: outgoing = engram as source; incoming = engram as target. Both reads from cached .synapses.json.`,
  "tool.skill_get.technical": `Read skill metadata. Input: { name }
P0: reads from in-memory registry (skills loaded at startup).
Returns: { name, description, templateKind: 'tool-sequence' | 'prompt-template', parameters, version }.
Side effects: none.
Error conditions: not found throws.
Note: P1 will add filesystem-backed skill loading.`,
  "tool.skill_invoke.technical": `Invoke skill. Input: { name, parameters }
P0: framework only — returns "skill invoked" without executing template.
P1: tool-sequence executes parameterized tool chain; prompt-template renders and returns prompt.
Side effects: depends on template (tool-sequence may write engrams).
Error conditions: not found throws; parameter validation throws.
Invariant: skill execution is logged for provenance.`,
  "tool.engram_list_proposals.technical": `List pending proposals. Input: { includeAll?: boolean; limit: 1..500 (required); cursor?: string|null }
Default: returns only pending. includeAll=true returns accepted/dismissed history.
Returns: { items: [{entityId, occurrences, sampleQuotes, status, createdAt, source, ...proposed*}], nextCursor: string|null }.
Pagination: cursor-based, opaque token; sort order createdAt DESC, entityId ASC.
Proposal engine: topics mentioned ≥3 times in conversation without matching engram generate pending proposal.
Side effects: none (read-only).`,
  "tool.engram_accept_proposal.technical": `Accept proposal. Input: { entityId, title?, content?, domainTags?, kind?, createdBy? }
Side effects: creates engram (calls engram_create internally); marks proposal status=accepted; suppresses future duplicate proposals for same topic; appends audit.
Error conditions: proposal not found throws; already accepted/dismissed throws.
Invariant: default createdBy fallback chain: explicit > ctx.defaultCreatedBy > 'unknown'.
external-markdown source: adopts source file in place at payload.sourcePath (bare md rewritten with frontmatter; valid engram orphan indexed as-is) — no imported/ copy; falls back to derived path if source file missing.`,
  "tool.engram_dismiss_proposal.technical": `Dismiss proposal. Input: { entityId, reason?, dismissDays? }
Default dismissDays=0 (permanent). Reason recorded for meta-learning.
Side effects: marks proposal status=dismissed; dismissedUntil = now + N days when dismissDays>0, undefined when dismissDays=0 (never reopens); appends audit.
Error conditions: proposal not found throws; already accepted throws.
Invariant: a dismissed proposal is never reopened by proposeAutoMemory / observe, even when the source event recurs.`,
  "tool.engram_accept_proposals_by_source.technical": `Batch-accept proposals by source. Input: { source: 'auto-memory'|'external-markdown', createdBy?, visibility?, limit?: 1..500=200 }
Behavior: list pending proposals matching source, accept one-by-one (per-item failure does not abort batch; recorded in failures); each accept reuses the same path as engram_accept_proposal (payload fills title/content/domainTags).
Side effects: bulk engram creation + bulk status=accepted + audit × N.
Returns: { source, acceptedCount, dismissedCount=0, remainingCount (all sources), engramIds, failures[] }.
Error conditions: ctx.proposalEngine missing throws configError; source='conversation' is rejected at schema level (z.enum).`,
  "tool.engram_dismiss_proposals_by_filter.technical": `Batch-dismiss proposals by filter. Input: { source?, domainTags?, createdBefore?, createdAfter?, reason: string[1..500], dismissDays?: 0..365, limit?: 1..5000=1000 }
Behavior: list pending proposals matching filter, dismiss one-by-one (per-item failure does not abort batch; recorded in failures); reason required (audit).
Side effects: bulk status=dismissed + dismissedUntil + audit × N.
Returns: { dismissedCount, acceptedCount=0, remainingCount (all sources), dismissedIds, failures[] }.
Error conditions: ctx.proposalEngine missing throws configError; missing reason is rejected at schema level.`,
  "tool.engram_synthesize.technical": `LLM-synthesize multiple engrams into a pattern. Input: { ids: string[2..20], createdBy?, domainTags?: string[1..5], synthesisHints?: string[≤500], dryRun?: boolean }
Behavior: load sources → call ctx.llmClient.complete(prompt, { maxTokens: 4000, temperature: 0.3 }) → parse JSON → createEngram(kind='pattern', sourceType='inferred', importance=0.7, confidence from LLM) → for each source addOutgoingSynapse(kind='derives_from', weight=0.8, directional, evidence marks synthesis provenance).
domainTags resolution priority: user-explicit > LLM-inferred > union of source tags (first 5).
Side effects: writes new engram's three files + N synapses; appends audit { target: 'pattern-via-synthesis', sourceIds, synapseIds }; markDirty.
dryRun=true: returns draft only, no writes.
Error conditions: llmClient missing throws with setup guidance; ids after dedup < 2 throws; any source missing throws (lists missing ids, no partial execution); LLM returns non-string throws; JSON parse failure throws (no engram created, avoids garbage); LLM call error propagates.
Invariants: derives_from direction is always pattern → source; synapse weight fixed at 0.8; ids auto-deduped.`,
  "tool.engram_doctor.technical": `Self-healing scan. Input: { incremental?: boolean }
Auto-fixes: file moves (index re-points), title renames (re-slug + rename), stale index entries (cleared), skill composes/relatedEngrams dangling (removed), skill utility/stats out-of-range (clamped/reconciled), skill contentHash stale (recomputed).
Reports (manual review): dangling synapse references, orphan markdown, skill issues (orphan SKILL.md, dangling imprint, skillId mismatch, duplicate skillId, invalid enum/date, corrupt imprint.json) — each with nextAction (skill_create/update/delete).
Side effects: may rewrite .meta.json / .synapses.json / index files; appends audit log entry.
Returns: { startedAt, finishedAt, total, autoFixed, pendingManualReview, issues: [{ kind, path, message, autoFixed }] }.
Incremental=true: only scan files changed since last mtime pass.`,
  "tool.engram_sync.technical": `Manual pull-commit-push. Input: { message?: string (default "co-engram sync: YYYY-MM-DD"), dryRun?: boolean (default false), pull?: boolean (default true), push?: boolean (default true) }
Side effects: execSync('git ...', { cwd: dataRoot }) — invokes system git, inherits user SSH/credentials/proxy; no hardcoded host/URL/refspec; does not write Change-Id (ZTE/Gerrit commit-msg hook auto-adds if installed); respects user's .git/config push (Gerrit review via refs/for/* is user's choice).
.gitignore fallback: created if missing; excludes entire .co-engram/ directory (derived data + behavioral cache, all regenerable).
Conflicts: pullRepo detects rebase conflicts → git rebase --abort → returns conflicts array (paths relative to repo root) → tool halts, no auto-resolve.
Push fallback: when hasRemote=false, push phase is skipped, no error (supports local-only repos).
Idempotent: nothing to commit → committed.nothingToCommit=true (skip commit); pull when already up-to-date → pulled.upToDate=true.
Returns: { repoPath, gitignoreCreated, changedFiles? (dryRun), pulled?, committed?, pushed?, summary }.`,
  "tool.engram_list_paths.technical": `Directory tree with engramCount. Input: { maxDepth?: 1..10 (default 5) }
Reads filesystem directly (not index). Each node: { path, engramCount, children }.
Side effects: none.
Use case: progressive disclosure — orient before searching.
Invariant: engramCount is cumulative for subtree (includes children).`,
  "tool.memory_search.technical": `OpenClaw-compatible alias of engram_search. Same FTS5 backend, simplified schema.
Input: { query, maxResults?, minScore? }
Side effects: none.
Returns: { results: MemorySearchHit[], total }. MemorySearchHit hides internal fields (freshness, sourceType).
Invariant: maxResults clamped to [1, 50]; minScore clamped to [0, 1].`,
  "tool.memory_get.technical": `OpenClaw-compatible alias of engram_get (content tier). Same backend.
Input: { id }
Side effects: none.
Returns: { id, title, content, metadata: { importance, truthScore, reinforcementCount, tags, kind }, relatedIds }.
Invariant: relatedIds derived from synapses (both directions).`,

  // ===== System prompts (buildProposalPrompt) =====
  "prompt.proposal_prompt":
    "[co-engram] ${count} memory candidate${plural} pending (topic${plural} seen ≥3 times but not recorded). Use `engram_list_proposals` to view, `engram_accept_proposal` to record, or `engram_dismiss_proposal` to ignore.",

  // ===== Memory section prompts (OpenClaw registerMemoryCapability.promptBuilder) =====
  "prompt.memory.section_header": "## Memory Recall (co-engram)",
  "prompt.memory.when_to_search":
    'When to call memory_search: semantic retrieval — user asks "what do we know about X / did we discuss X / find memories about X". The query is a search keyword (e.g. "low-friction-defaults", "ADB debugging"), NOT a "list all" instruction — empty query throws. Run memory_search first, then memory_get for full content on specific hits.',
  "prompt.memory.when_to_list":
    'When to call engram_list (listing scenario): user asks "what memories do I have / list all memories / show my memory store / how many memories" — use the engram_list tool (paginated + filtered), NOT memory_search. memory_search ranks by keyword relevance; listing everything needs engram_list. Optional filters: domainTags, kind (fact/pattern/procedure/observation), status (active/frozen).',
  "prompt.memory.when_not_to_search":
    "When NOT to call: general knowledge questions, pure code problems unrelated to team context, simple greetings. Avoid redundant searches for topics already answered in this conversation.",
  "prompt.memory.reading_results":
    "Reading results: each memory has a truthScore (0-1). Treat memories with truthScore < 0.4 cautiously — consider calling close_learning_loop after verification. Cite memories by engram ID (e.g. [engram_abc123]) when the user benefits from verifying the source.",
  "prompt.memory.writing":
    'When creating/updating memories (engram_create / engram_update): leave createdBy blank to let the system auto-resolve to git user.name. **Do NOT fill in tool names or generic words like "claude-code" / "openclaw" / "AIOS" / "assistant" / "system"** — everyone on the team uses Claude Code, so tagging "claude-code" is no author at all and breaks audit log traceability. createdBy marks the *human*, not the *tool*. Only pass createdBy explicitly when the user requests a specific authorship tag (team name, external system name, etc.).',
  "prompt.memory.when_to_reinforce":
    "When to call engram_reinforce: use your **own judgment** — when a cited memory actually helped complete the task, was adopted into your answer, or successfully guided a decision, call engram_reinforce(id, effectiveness) on it. effectiveness: 1.0=fully useful, 0.7=mostly useful, 0.4=background reference only. Call engram_report_failure when the memory was wrong (cumulative negative feedback); call engram_delete when the fact has definitively changed (immediate, irreversible — confirm with the user first by default). co-engram is a self-evolving system: your reinforcement signal is the primary input to importance scoring — call it proactively, do not wait for the user to prompt you. But **be honest**: do not give high scores for tangential references — over-reinforcing lets low-value memories drown out high-value ones.",
  "prompt.memory.proposal_reminder":
    "Pending proposals: ${count} memory candidate(s) awaiting review. Call engram_list_proposals to inspect, engram_accept_proposal to record, or engram_dismiss_proposal to suppress.",
  "prompt.memory.frequent_topics":
    "Frequent topics in this team-memory: ${tags}. These are domains where memory_search is most likely to return useful context.",
  "prompt.memory.repo_overview":
    "Memory repo structure:\n${tree}\nCall engram_list_paths(maxDepth=N) for deeper levels.",
  "prompt.memory.missed_topics":
    "Recently missed topics (consider searching proactively): ${topics}. Past turns suggest these should have triggered memory_search but did not.",
  "prompt.memory.low_confidence_topics":
    "Low-confidence topics frequently retrieved: ${topics}. Consider close_learning_loop or upgrade_verification to strengthen these memories.",

  // ===== Prompt · Visibility risk recognition (Task 5: LLM risk-signal contract) =====
  "prompt.visibilityRisk.title": "## Visibility Risk Recognition",
  "prompt.visibilityRisk.guidance":
    'Before calling engram_create / engram_accept_proposal / engram_update, if content contains any of the following risk signals, **you MUST ask the user first** whether to set visibility: "private":',
  "prompt.visibilityRisk.credentials":
    "Credentials: API key (ghp_*, sk-*, xoxb-*, npm_*, AKIA*, AIza*), password assignment (password=, pwd:), JWT (eyJ...), PEM private key header",
  "prompt.visibilityRisk.personal":
    "Personal identity: email, phone, ID number, home address",
  "prompt.visibilityRisk.internal":
    "Internal info: intranet IP (10.*, 172.16-31.*, 192.168.*), internal domain (*.zte.intra), internal project codename",
  "prompt.visibilityRisk.sensitive":
    "Sensitive info: person names (esp. negative evaluations), customer codename, business-sensitive (revenue, user count, unreleased roadmap)",
  "prompt.visibilityRisk.paths":
    "Username in absolute paths (/home/<user>/, /Users/<user>/, C:\\\\Users\\\\<user>\\\\)",
  "prompt.visibilityRisk.template":
    'Template: "This memory contains [category] (example: ...). Suggest setting visibility: private (local-only, not in team repo). Approve?"',
  "prompt.visibilityRisk.principle":
    "**Better to over-ask than under-detect**. When uncertain, default to asking. One redundant ask costs far less than one credential leak.",

  // ===== Prompt · Exclusive memory store (Task: mechanism-layer enforcement of engram_create) =====
  "prompt.exclusivity.title": "## Exclusive memory store",
  "prompt.exclusivity.rule":
    "co-engram is the **single** memory write path this session. Do NOT write ~/.claude/projects/<cwd>/memory/*.md (Claude Code auto-memory) — it gets mirrored as pending proposals with visibility lost. Call engram_create directly.",

  // ===== Prompt · Skill catalog (deterministic injection, forgotten filtered) =====
  "prompt.skill.title": "## Team Skills",
  "prompt.skill.hint":
    "The following team skills are available on demand (skillId + trigger description; full usage in each skill's SKILL.md). Ordered by utility; expired skills excluded:",
  "prompt.skill.entry": "- ${skillId}: ${description}",

  // ===== Viewer UI strings =====
  "viewer.title": "Co-Engram",
  "viewer.slogan": "Self-evolving team memory",
  "viewer.nav.primary": "Browse",
  "engrams.tree.expandAll": "Expand all",
  "engrams.tree.collapseAll": "Collapse all",
  "viewer.nav.governance": "Governance",
  "viewer.tab.stats": "Stats",
  "viewer.tab.engrams": "Engrams",
  "viewer.tab.skills": "Skills",
  "viewer.tab.graph": "Graph",
  "viewer.tab.proposals": "Proposals",
  "viewer.tab.audit": "Audit",
  "viewer.tab.trash": "Trash",
  "viewer.page.trash.title": "Memory Trash",
  "viewer.page.trash.sub": "Auto-purged after the 30-day retention window · restored items return to the active pool with decay reset",
  "viewer.page.health.title": "Memory Health Check",
  "viewer.page.health.sub": "Index consistency / dangling synapses / orphan files / skill metadata / cache state · weekly recommended",
  "viewer.page.merges.title": "Team Memory Merges",
  "viewer.page.merges.sub": "Conflict stats and resolutions from multi-client sync (merge-driver audit aggregation)",
  "viewer.page.config.title": "Configuration",
  "viewer.page.config.sub": "Persisted config (dataRoot .co-engram/config.json)",
  "viewer.tab.config": "Config",
  "viewer.tab.help": "Help",
  "viewer.tab.merges": "Team Memory Merges",
  "viewer.tab.health": "Memory Health Check",
  "viewer.tab.maintenance": "Maintenance",
  "viewer.tab.more": "More",
  "viewer.tab.more.tip":
    "More tools: merges / audit / trash / health / config / help",
  "viewer.tab.stats.tip":
    "Memory repository overview: engram/synapse counts, kind & status distributions, top contributors, popular tags",
  "viewer.tab.engrams.tip":
    "Browse and search all memory engrams (card view or directory view grouped by domain/kind)",
  "viewer.tab.skills.tip":
    "Browse and search skill memories: acquisition depth, trigger conditions, statistics, and retention status",
  "viewer.tab.graph.tip":
    "Memory synapse visualization; filter and color by family (structural/causal/evidential/temporal/modulatory) and kind",
  "viewer.tab.proposals.tip":
    "Candidate memories implicitly captured but not yet approved; accept to promote to a real engram, dismiss to discard",
  "viewer.tab.merges.tip":
    "Team memory merges: deduplication of similar memories and the 3-phase resolution workflow for contradicts synapses",
  "viewer.tab.audit.tip":
    "Memory change timeline: create/update/delete/reinforce/contradiction-resolution history",
  "viewer.tab.maintenance.tip":
    "Maintenance stage status: REM (dream sleep, memory consolidation) / deep (cleanup) / light cycle and last artifacts",
  "viewer.tab.trash.tip":
    "Soft-deleted engrams and synapses; restore or permanently purge",

  // ===== Night-thinking lab (spec §4/§6) =====
  "viewer.tab.incubations": "Night Lab",
  "viewer.tab.incubations.tip": "Feed a question before sleep; the agent thinks overnight; harvest insights on waking",
  "viewer.proposals.insight.badge": "Deep insight",
  "viewer.proposals.insight.mode.integration": "Integration mode",
  "viewer.proposals.insight.mode.retrospective": "Retrospective mode",
  "viewer.proposals.insight.mode.inspiration": "Inspiration mode",
  "viewer.proposals.insight.criticTip": "Independent critic score (machine-subjective initial value, not ground truth)",
  "viewer.proposals.insight.incubationTip": "From a night-thinking entry",
  "viewer.incubations.title": "Night-thinking Lab",
  "viewer.incubations.intro": "Feed a question before sleep; the agent thinks deeply overnight; harvest insights on waking. Insights become proposals first and only turn into memories after approval.",
  "viewer.incubations.createTitle": "Seed a new question",
  "viewer.incubations.questionPlaceholder": "The question you want the agent to think through overnight…",
  "viewer.incubations.seedPlaceholder": "Seed memory ids (optional, comma-separated)",
  "viewer.incubations.webOptIn": "Allow web research",
  "viewer.incubations.webOptInHint": "Allow web research: the question summary is sent to search engines; turn off for fully offline thinking",
  "viewer.incubations.createBtn": "Seed",
  "viewer.incubations.l2BudgetNotice": "Night thinking calls an external LLM (may consume significant tokens). The L2 session process (plan/trace) is fully transparent; the web-research checkbox below is checked by default — uncheck it for fully offline thinking; when enabled, only the question and digest-level content are sent to the search engine.",
  "viewer.incubations.inFlightTip": "This entry is currently thinking; run again after it finishes",
  "viewer.incubations.lastRound": "Last round (R${round} · ${trigger})",
  "viewer.incubations.lastRoundNone": "No textual summary this round — see the timeline below",
  "viewer.incubations.inFlightSince": "Night thinking in progress · ${t}",
  "viewer.incubations.inFlightHint": "L2 session stages: plan → retrieval reading → critique → insight distillation. The dream timeline updates here on completion and insights surface as proposals; usually takes a few minutes — this page auto-refreshes every 30s.",
  "viewer.incubations.empty": "No incubation entries yet. Seed your first question and start tonight.",
  "viewer.incubations.loadFailed": "Failed to load: ${err}",
  "viewer.incubations.unavailable": "Night thinking is not enabled in this deployment (incubator not injected).",
  "viewer.incubations.status.active": "Incubating",
  "viewer.incubations.status.in-flight": "Thinking…",
  "viewer.incubations.status.suggested-resolve": "Confirm: did it answer your question?",
  "viewer.incubations.status.resolved": "Resolved",
  "viewer.incubations.status.paused": "Paused",
  "viewer.incubations.rounds": "Night ${n}",
  "viewer.incubations.level.L1": "L1 baseline thinking",
  "viewer.incubations.level.L2": "L2 agent orchestration",
  "viewer.incubations.runNow": "Run now",
  "viewer.incubations.running": "Night thinking in progress… (an L2 session takes minutes; refresh later)",
  "viewer.incubations.jobDone": "Done: ${proposals} insight proposals, level ${level}",
  "viewer.incubations.jobError": "Failed: ${err}",
  "viewer.incubations.resolvePrompt": "Did it answer your question?",
  "viewer.incubations.resolveYes": "Answered — archive",
  "viewer.incubations.resolveNo": "Not yet — keep incubating",
  "viewer.incubations.timeline": "Dream timeline",
  "viewer.incubations.timelineEmpty": "No nights recorded yet",
  "viewer.incubations.timelineRound": "Night ${round} · ${trigger}",
  "viewer.incubations.trigger.manual": "manual",
  "viewer.incubations.trigger.scheduled": "scheduled",
  "viewer.incubations.externalCalls": "${n} external call(s) (audited)",
  "viewer.incubations.note": "Note: ${note}",
  // Night-thinking T10: explainer / scheduler status / conclude & schedule / sown feedback / diagnosis
  "viewer.incubations.explainer.what": "Incubation is resource-maximal multi-night thinking: it mines the full memory graph, behavioral logs, and your skill catalog (web opt-in per entry).",
  "viewer.incubations.explainer.how": "Each night one round: draft insights pass three gates (reference check, dedup, independent critique) to become proposals; your accept/dismiss feedback feeds the next round.",
  "viewer.incubations.explainer.gain": "Every round produces a working answer draft (click a card to view); conclude anytime for the final answer; accepted insights enter the memory repo.",
  "viewer.incubations.schedulerOn": "Scheduler: running (rounds run on schedule)",
  "viewer.incubations.schedulerOff": "Scheduler: not running (missed rounds catch up on next session or daemon start)",
  "viewer.incubations.catchUpPending": "pending catch-up (scheduler not running)",
  "viewer.incubations.finalAnswer": "Final answer",
  "viewer.incubations.concludeBtn": "Conclude",
  "viewer.incubations.concludeConfirm": "Synthesize all rounds into a final answer (~1-2 min, possibly longer) and mark for resolve. Continue?",
  "viewer.incubations.concludePendingHint": "Request timed out or dropped; conclude may still be running in the background. Refresh later instead of retrying.",
  "viewer.incubations.concludeFailed": "Conclude failed: ${msg}",
  "viewer.incubations.editSchedule": "Schedule",
  "viewer.incubations.schedulePrompt": "Daily run time (HH:mm, default 00:00)",
  "viewer.incubations.sownTip": "Sown. First round at ${time} (or hit \"Run now\"); then daily at ${schedule}. Each round drafts an answer; conclude anytime.",
  "viewer.incubations.draftSkippedNoLlm": "Draft skipped: llmClient not configured",
  "viewer.incubations.diagnosis.drafts": "${n} drafts this round",
  "viewer.incubations.diagnosis.dup": "${n} vetoed as duplicates",
  "viewer.incubations.diagnosis.validate": "${n} failed reference check",
  "viewer.incubations.diagnosis.critic": "${n} rejected by critic review",
  "viewer.incubations.diagnosis.residual": "${n} others did not become proposals",
  "viewer.incubations.diagnosis.noLlm": "llmClient missing: proposals and drafts unavailable",
  "viewer.incubations.diagnosis.rejectReasons": "Rejection details (${n}; click to expand)",
  "viewer.maintenance.insightStats.title": "Insight quality metrics",
  "viewer.maintenance.insightStats.total": "${n} insight proposals",
  "viewer.maintenance.insightStats.acceptance": "Acceptance ${v}",
  "viewer.maintenance.insightStats.laterUse": "Later-use ${v}",
  "viewer.help.nightThinkingTitle": "Night Thinking (Overnight Thinking)",
  "viewer.help.nightThinkingDesc": "<strong>Night thinking</strong>: seed a question in More → Night Lab; the agent thinks it through night after night, insights appear as proposals and only become memories after approval; plans and traces are fully transparent.",
  "viewer.help.incubations.pace": "One round per entry per day, at 00:00 local by default; change it from the card's Schedule control.",
  "viewer.help.incubations.catchUp": "Missed rounds (no process running) catch up on the next session or daemon start; the header shows live scheduler status.",
  "viewer.help.incubations.draft": "Each round auto-drafts an interim answer (click the card to read it); Conclude produces the final answer anytime.",
  "viewer.help.incubations.runNow": "Run now triggers a round manually at any time (without consuming that night's scheduled round).",
  "viewer.help.incubations.resources": "Round resources: the full memory graph + activity logs + your skill library (web research is opt-in per entry).",
  "viewer.tab.health.tip":
    "Memory repository consistency check: dangling synapse references, orphan files, index drift; supports self-healing",
  "viewer.tab.config.tip":
    "Configuration: dataRoot, port, language, maintenance schedule (decay/consolidation/REM cycles)",
  "viewer.tab.help.tip":
    "Usage guide: concept glossary, ports and dataRoot, Claude Code and OpenClaw dual-host notes",

  // Engram visibility badges / filters / tips
  "viewer.engram.openDir": "Open directory",
  "viewer.engram.openDirOpened": "Opened the directory containing this engram",
  "viewer.engram.openDirFailed": "Failed to open directory: ${err}",
  "viewer.engram.openDirCopy": "Copy path",
  "viewer.engram.openDirCopied": "Copied",
  "viewer.engram.openDirCopyFailed": "Copy failed",
  "viewer.engram.openDirReason.no-desktop": "No desktop environment (SSH / container / headless) — can't launch the file manager. Copy the path below to locate it manually:",
  "viewer.engram.openDirReason.spawn-failed": "File manager command not found. Copy the path below to locate it manually:",
  "viewer.engram.openDirReason.dir-not-found": "This engram's directory no longer exists (may have been moved externally). Original path:",
  "viewer.engram.openDirReason.fallback": "Could not open the directory. Copy the path below to locate it manually:",
  "viewer.engram.visibilityBadge.private": "Private",
  "viewer.engram.visibilityBadge.public": "Public",
  "viewer.engram.visibilityBadge.team": "Team",
  "viewer.engram.visibilityBadge.restricted": "Restricted",
  "viewer.engram.visibilityBadge.public.tip":
    "Public — enters team repo, visible to all members.",
  "viewer.engram.visibilityBadge.team.tip":
    "Team-visible — enters team repo, restricted to team members.",
  "viewer.engram.visibilityBadge.private.tip":
    "Local-only — never enters repo (isolated via .gitignore); all local agents can index.",
  "viewer.engram.visibilityBadge.restricted.tip":
    "Restricted — requires approval to view.",
  "viewer.engram.filter.visibility": "Visibility",
  "viewer.engram.filter.allVisibilities": "All",
  "viewer.engram.filter.team": "Team-visible",
  "viewer.engram.filter.private": "Private only",
  "viewer.engram.synapses": "Synapses",
  "viewer.engram.noSynapses": "No synapses",
  "viewer.engram.outgoingSynapses": "Outgoing",
  "viewer.engram.incomingSynapses": "Incoming",
  "tip.engram.gitIsolation":
    "Private engrams (🔒) are isolated via .gitignore and never enter the team git repo; local agents can still index/search them.",
  "tip.engram.gitIsolation.teamScope":
    "Public / Team / Restricted engrams all enter the team git repo; this option shows all three.",
  "tip.engram.visibilityEdit":
    "Changing visibility triggers file path migration (public/team/restricted → <domainTags>/, private → private/<domainTags>/); fails on path conflict, original file untouched.",

  "viewer.health.title": "Warehouse Health",
  "viewer.health.subtitle":
    "One-glance diagnostic — surfaces silent failures before they bite.",
  "viewer.health.overall": "Overall",
  "viewer.health.generatedAt": "Generated",
  "viewer.health.dataRoot": "Data Root",
  "viewer.health.checks": "Checks",
  "viewer.health.refresh": "Refresh",
  "viewer.health.empty":
    "No data root configured. Run `co-engram init` to create a warehouse.",
  "viewer.health.badge.ok": "OK",
  "viewer.health.badge.warn": "WARN",
  "viewer.health.badge.error": "ERROR",
  "viewer.health.badge.info": "INFO",
  "viewer.health.stats.total": "Total engrams",
  "viewer.health.stats.frozen": "Frozen",
  "viewer.health.stats.forgotten": "Forgotten",
  "viewer.health.stats.totalTip":
    "Total engrams in the warehouse (active + frozen + forgotten). Shares the same data source as the Stats tab totalEngrams (/api/status -> computeStatus), so the numbers match. If you see different numbers on the two tabs it is usually a stale HTML in the browser cache (fixed via Cache-Control: no-store).",
  "viewer.health.stats.frozenTip":
    "Engrams in the frozen status: no longer participate in retrieval but can still be restored to active. Source: demoted via dismiss/contradiction or long without reinforcement, or explicitly via the engram_archive tool. Frozen is a true freeze — no decay, no reinforcement, no synthesis; data fully preserved.",
  "viewer.health.stats.forgottenTip":
    "Engrams in the forgotten status: equivalent to a soft delete, visible in the trash, restorable or purge-able. The web UI delete button writes this status (no immediate physical delete).",

  // Health-tab warn/error meaning (viewer.health.why.<checkId>)
  "viewer.health.why.data_root_missing":
    "Data root does not exist; co-engram cannot read or write any memory. Every tool call will fail.",
  "viewer.health.why.data_root_not_warehouse":
    "Directory exists but lacks .co-engram/config.json — not a valid co-engram warehouse. Initialize first.",
  "viewer.health.why.config_unreadable":
    ".co-engram/config.json failed to parse (JSON syntax error or permission issue). Defaults will take over but persisted config is lost.",
  "viewer.health.why.config_missing_fields":
    "language or defaultCreatedBy is missing. Missing language falls back to default (may not match your team's primary language); missing defaultCreatedBy means new memories cannot be attributed to a creator, breaking team attribution and contributor stats.",
  "viewer.health.why.index_missing":
    "Index files (engram-index.json / digest.jsonl / graph.json) are retrieval accelerators. Missing files slow the first query (full-scan rebuild) but do not affect data integrity.",
  "viewer.health.why.proposals_pending_high":
    "More than 5 pending proposals. The proposal engine generates candidates in the background; leaving them unreviewed turns them into noise that buries genuinely valuable team memories.",
  "viewer.health.why.git_not_repo":
    "dataRoot is not a git repository. Memory files have no version history — accidental deletes, wrong writes, or merge conflicts cannot be recovered.",
  "viewer.health.why.git_dirty_high":
    "More than 10 uncommitted changes. co-engram does not auto-commit; piled-up changes increase loss risk and broaden the merge-conflict surface during team collaboration.",
  "viewer.health.why.merge_driver_missing":
    "Git merge driver is not configured. When teammates merge branches, engram frontmatter + derived sections cause text conflicts that must be resolved by hand — easy to lose content.",

  // Health-tab fix guidance (viewer.health.fix.<checkId>.description)
  "viewer.health.fix.data_root_missing.description":
    "Create the directory and initialize the warehouse:",
  "viewer.health.fix.data_root_not_warehouse.description":
    "Initialize a co-engram warehouse at the current path:",
  "viewer.health.fix.config_unreadable.description":
    "Re-initialize to regenerate a valid config.json:",
  "viewer.health.fix.config_missing_fields.description":
    "Set the missing config fields:",
  "viewer.health.fix.index_missing.description":
    "Run a self-healing scan to rebuild indexes (or ignore — next tool call rebuilds them automatically):",
  "viewer.health.fix.proposals_pending_high.description":
    "List pending proposals and review each (accept to persist / dismiss to reject):",
  "viewer.health.fix.git_not_repo.description":
    "Initialize a git repository for version history:",
  "viewer.health.fix.git_dirty_high.description":
    "Commit all engram changes in one click, or copy the command to run manually:",
  "viewer.health.fix.merge_driver_missing.description":
    "Auto-configure the git merge driver (idempotent):",

  // Health-tab UI assets (expand/collapse, copy command, call tool, doctor card)
  "viewer.health.check.why": "Why",
  "viewer.health.check.howToFix": "How to fix",
  "viewer.health.check.copyCommand": "Copy command",
  "viewer.health.check.commandCopied": "Copied",
  "viewer.health.check.orCallTool": "Or call tool",
  "viewer.health.check.commitNow": "Commit now",
  "viewer.health.check.commitMessagePrompt":
    "Enter a commit message (editable)",
  "viewer.health.check.commitDefaultMessage":
    "chore(memory): sync engram updates",
  "viewer.health.check.commitSuccess":
    "Committed {files} file(s) · {branch}@{hash}",
  "viewer.health.check.commitNothing":
    "Working tree is clean, nothing to commit.",
  "viewer.health.check.commitFailed": "Commit failed: ${error}",
  "viewer.health.check.expand": "Show details",
  "viewer.health.check.collapse": "Collapse",
  "viewer.health.doctor.title": "Self-healing suggestions",
  "viewer.health.doctor.subtitle":
    "Structured fix guidance from engram_doctor (for deeper diagnostics)",
  "viewer.health.doctor.autoFixed": "Auto-fixed",
  "viewer.health.doctor.pendingReview": "Pending manual review",
  "viewer.health.doctor.empty": "Scan passed — no issues.",
  "viewer.health.doctor.runScan": "Run doctor scan",
  "viewer.health.doctor.loading": "Scanning...",
  "viewer.health.doctor.nextAction": "Suggested next step",
  "viewer.health.doctor.noPending": "No issues pending manual review.",
  "viewer.health.doctor.fixKind.index_rebuilt": "Rebuilt derived index",
  "viewer.health.doctor.fixKind.merge_driver_installed":
    "Configured git merge driver",
  "viewer.health.doctor.fixKind.moved_file": "Updated file path",
  "viewer.health.doctor.fixKind.title_changed": "Renamed to match new title",
  "viewer.health.doctor.fixKind.missing_file": "Cleared stale index entry",
  "viewer.health.doctor.fixKind.obsidian_view_stale": "Synced Obsidian view",
  "viewer.health.doctor.fixKind.dangling_index_reference":
    "Cleaned dangling refs to deleted engrams in derived indexes",
  "viewer.health.doctor.fixKind.invalid_frontmatter":
    "YAML syntax error in frontmatter",
  "viewer.health.doctor.fixKind.invalid_field_value":
    "Invalid frontmatter field value",
  "viewer.health.doctor.fixKind.derived_field_stale":
    "Recomputed stale derived field (content hash/size)",
  "viewer.search.placeholder": "Full-text search engrams...",
  "viewer.search.placeholderCount": "Search titles, tags & full text across ${n} memories",
  "viewer.search.button": "Search",
  "viewer.search.clear": "Clear",
  "viewer.search.clear_title":
    "Clear search results and return to default stats view",
  "viewer.search.searching": "Searching...",
  "viewer.search.noResults": "No matching results",
  "viewer.search.failed": "Search failed: ${err}",
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
  "viewer.buildTime": "Built",

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
  "enum.kind.skill": "Skill",
  // S6.x: enum.policyKind removed (co-engram does not execute skills)

  "enum.freshness.fresh": "Fresh",
  "enum.freshness.aging": "Aging",
  "enum.freshness.stale": "Stale",
  "enum.freshness.forgotten": "Forgotten",

  "enum.acquisitionStage.draft": "Cognitive",
  "enum.acquisitionStage.compiled": "Associative",
  "enum.acquisitionStage.tuned": "Autonomous",

  "enum.retentionStage.active": "Active",
  "enum.retentionStage.aging": "Aging",
  "enum.retentionStage.stale": "Stale",
  "enum.retentionStage.forgotten": "Forgotten",

  "enum.status.draft": "Draft",
  "enum.status.active": "Active",
  "enum.status.frozen": "Frozen",
  "enum.status.forgotten": "Forgotten",

  "enum.sourceType.firsthand": "Firsthand",
  "enum.sourceType.secondhand": "Secondhand",
  "enum.sourceType.inferred": "Inferred",

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
  "field.label.encodingContext": "Memory Formation Context",
  "field.label.encodingContextValue": "Memory formation context:",
  "field.label.perspective": "Perspective:",
  "field.label.decayProgress": "Decay Progress",
  "field.label.evidenceCount": "Evidence count:",
  "field.label.lastEffective": "Last effective:",
  "field.label.reinforcementScore": "Reinforcement score:",
  "field.label.sourceType": "Source type:",
  "field.label.verificationStatus": "Verification status:",
  "field.label.decayHalfLife": "Decay half-life:",
  "field.label.visibility": "Visibility:",

  // Section titles (section.<name>)
  "section.content": "Content",
  "section.stats": "Stats",
  "section.valueAssessment": "Value Assessment",
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

  // Error messages (error.<name>) — user-visible error prefix and message templates
  "error.prefix": "Error",
  "error.uri_missing_id": "URI missing {id} variable",
  "error.engram_not_found": 'engram "${id}" not found',

  // Decay visualization (decay.<name>)
  "decay.daysToNext": "${days} days to next downgrade",
  "decay.forgotten": "Forgotten",
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
  "engrams.synapsesCount": "Synapses ${n}",
  "engrams.filter.freshness": "Freshness",
  "engrams.filter.freshnessAll": "All",
  "engrams.filter.freshnessWeek": "New this week",
  "engrams.filter.freshnessMonth": "New this month",
  "engrams.filter.freshnessDormant": "Dormant (unused 30d)",
  "engrams.trend.tip": "Importance ${imp}; trend glyph derived from retrieval recency",
  "engrams.tree.rootName": "Team memory library",
  "engrams.tree.itemsUnit": "items",
  "engrams.tree.domainsUnit": "domains",
  "engrams.tree.recent": "recent ${t}",
  "engrams.untagged": "Untagged",
  "engrams.viewInCards": "View in cards",
  "engrams.tree.cumulativeCount":
    "Cumulative count (this folder + all descendants)",
  "engrams.tree.rootDirect": "Root-level (no folder)",
  "engrams.tree.directHere": "${n} direct here",
  "engrams.tree.viewAllInCards": "View all ${n} in cards (incl. subfolders)",
  "engrams.pager.prev": "« Prev",
  "engrams.pager.next": "Next »",
  "engrams.pager.pageInfo": "Page ${current} / ${total} (${itemTotal} items)",
  "engrams.pager.first": "« First",
  "engrams.pager.loadingHint": "Loading more…",

  // ===== Extended enums (replacing viewer's CO_ENGRAM_LABELS) =====
  "enum.status.dormant": "Dormant",
  "enum.visibility.public": "Public",
  "enum.visibility.team": "Team",
  "enum.visibility.private": "Private",
  "enum.visibility.restricted": "Restricted",
  "enum.family.structural": "Structural",
  "enum.family.causal": "Causal",
  "enum.family.evidential": "Evidential",
  "enum.family.temporal": "Temporal",
  "enum.family.modulatory": "Modulatory",
  "enum.synapseKind.extends": "extends",
  "enum.synapseKind.part_of": "part of",
  "enum.synapseKind.similar_to": "similar to",
  "enum.synapseKind.depends_on": "depends on",
  "enum.synapseKind.causes": "causes",
  "enum.synapseKind.follows": "follows",
  "enum.synapseKind.derives_from": "derives from",
  "enum.synapseKind.contradicts": "contradicts",
  "enum.synapseKind.exemplifies": "exemplifies",
  "enum.synapseKind.supersedes": "supersedes",
  "enum.synapseKind.consolidates": "consolidates",
  "enum.synapseKind.contextualizes": "contextualizes",
  "enum.synapseKind.related_to": "related to",
  "enum.synapseDirection.directional": "Directional",
  "enum.synapseDirection.bidirectional": "Bidirectional",
  "enum.resolution.pending": "Pending",
  "enum.resolution.auto_resolved": "Auto-resolved",
  "enum.resolution.escalated": "Escalated",
  "enum.resolution.contested": "Contested",
  "enum.resolution.resolved": "Resolved",

  // ===== Stats panel (viewer.stats.*) =====
  "viewer.stats.feedEmpty": "No activity yet",
  "viewer.stats.feedToday": "Today",
  "viewer.stats.feedYesterday": "Yesterday",
  "viewer.stats.feedView": "Open →",
  "viewer.stats.feedLoading": "Loading older activity…",
  "viewer.stats.feedGoAudit": "See full history in Audit →",
  "viewer.stats.feedExternalTag": "external edit",
  "viewer.stats.feedChangedFields": "changed fields: ${fields}",
  "viewer.stats.effectiveRateTip": "Retrieved rate = share of retrievals followed by reinforcement feedback within the observation window. Retrieves the agent never reported feedback for count as unclosed and lower the ratio — it measures feedback-loop closure, not retrieval quality.",
  "viewer.stats.updatesBarTip": "Bar height = memories created or content-updated that day (engrams/synapses/skills combined); click a bar for the day's details.",
  "viewer.stats.expandTip": "Click to expand TOP 20",
  "viewer.stats.weeklyNew": "↑${n} this week",
  "viewer.stats.pulseTitle": "Memory Updates",
  "viewer.stats.pulseSub": "created or content-updated (engrams/synapses/skills) · last 30 days · click a day",
  "viewer.stats.pulsePeak": "peak ${date} · ${n}",
  "viewer.stats.feedTitle": "Memory Activity",
  "viewer.stats.feedSub": "recent changes · source: audit events",
  "viewer.stats.retrievalTotal": "Engram Retrievals",
  "viewer.stats.effectiveRate": "${pct}% retrieved",
  "viewer.stats.skillInvocations": "Skill Invocations",
  "viewer.stats.skillInvocationsTip":
    "Cumulative skill invocations (success + failure); click to open the Skills tab",
  "viewer.stats.skillSuccessRate": "${pct}% success",
  "viewer.stats.domainHeat": "Domain Heat",
  "viewer.stats.domainHeatSub": "by engram count",
  "viewer.stats.monthlyHot": "Retrieval Hotspots",
  "viewer.stats.monthlyHotSub": "top by retrievals",
  "viewer.stats.monthlyCool": "Cooling Memories",
  "viewer.stats.monthlyCoolSub": "longest unretrieved · lowest importance",
  "viewer.stats.retrievalsShort": "${n} hits",
  "viewer.stats.daysAgo": "${n}d ago",
  "viewer.stats.neverRetrieved": "never retrieved",
  "viewer.stats.contributorRanking2": "Contribution Count",
  "viewer.stats.contributorHeat": "Contribution Heat",
  "viewer.stats.contributorHeatSub": "engram retrievals + skill invocations",
  "viewer.stats.heatRetrievalsShort": "${n} retrievals",
  "viewer.stats.heatSkillShort": "${n} invocations",
  "viewer.stats.dayPopupTitle": "Memory updates on ${date}",
  "viewer.stats.dayPopupEmpty": "No creations or content updates that day",
  "viewer.stats.itemEngram": "engram",
  "viewer.stats.itemSynapse": "synapse",
  "viewer.stats.itemSkill": "skill",
  "viewer.stats.itemCreated": "created",
  "viewer.stats.itemDeleted": "deleted memory",
  "viewer.stats.itemUpdated": "updated",
  "viewer.stats.weeklyRetrievals": "↑${n} retrievals this week",
  "viewer.stats.weeklyInvocations": "↑${n} invocations this week",
  "viewer.stats.totalEngrams": "Total engrams",
  "viewer.stats.totalEngramsTip":
    "Total = active + frozen + forgotten (all rows in main index). Restoring a forgotten/frozen item from trash increments active count but leaves total unchanged — the engram was already in the repository.",
  "viewer.stats.activeEngrams": "active",
  "viewer.stats.frozenCount": "frozen/forgotten",
  "viewer.stats.totalSynapses": "Total synapses",
  "viewer.stats.pendingProposals": "Pending proposals",
  "viewer.stats.clickToViewAll": "Click to view all",
  "viewer.stats.clickToViewGraph": "Click to view graph",
  "viewer.stats.clickToHandle": "Click to handle",
  "viewer.stats.kindDistribution": "Engrams · by kind",
  "viewer.stats.statusDistribution": "Engrams · by status",
  "viewer.stats.synapseKindDistribution": "Synapses · by kind",
  "viewer.stats.totalSkills": "Total skills",
  "viewer.stats.totalSkillsTip": "Procedural skill count; click to open the Skills tab",
  "viewer.stats.clickToViewSkills": "Click to view skills",
  "viewer.stats.skillAcquisitionDistribution": "Skills · by acquisition stage",
  "viewer.stats.skillRetentionDistribution": "Skills · by retention stage",
  "viewer.stats.contributorRanking": "Contributor ranking · engrams + synapses",
  "viewer.stats.topTags": "Top domain tags",
  "viewer.stats.contributorCol": "Contributor",
  "viewer.stats.engramCol": "Engrams",
  "viewer.stats.synapseCol": "Synapses",
  "viewer.stats.totalCol": "Total",
  "viewer.stats.empty": "No data yet",
  "viewer.stats.synapsesEmpty": "No synapses yet",

  // ===== Proposals panel (viewer.proposals.*) =====
  "viewer.proposals.disabledHint":
    "Proposal engine is disabled. Turn it on in the config panel, or set proposals.enabled=true in config.json.",
  "viewer.proposals.status.pending": "Pending",
  "viewer.proposals.status.accepted": "Accepted",
  "viewer.proposals.status.dismissed": "Dismissed",
  "viewer.proposals.status.all": "All",
  "viewer.proposals.empty": "No ${status} proposals",
  "viewer.proposals.emptyHint":
    "The system observes candidate memories in the background; new proposals will appear here automatically.",
  "viewer.proposals.pager.hasMoreHint": "${n} more — load on page turn",
  "viewer.proposals.card.occurrences": "${n} occurrences",
  "viewer.proposals.card.samples": "${n} samples",
  "viewer.proposals.card.inferred": "inferred",
  "viewer.proposals.card.inferredTip":
    "Title and kind are inferred from conversation snippets — click the card to review samples and correct them",
  "viewer.proposals.card.noPreview": "(no content preview)",
  // ===== REM proposal cards(viewer.proposals.rem.*) =====
  "viewer.proposals.rem.scene.refute": "REM·Refute",
  "viewer.proposals.rem.scene.verify": "REM·Verify",
  "viewer.proposals.rem.scene.pattern": "REM·Pattern",
  "viewer.proposals.rem.scene.synapse": "Dream·Synapse",
  "viewer.proposals.rem.scene.tagRefresh": "Dream·Tag refresh",
  "viewer.proposals.rem.tagRefresh.from": "Current tags",
  "viewer.proposals.rem.tagRefresh.to": "Refreshed tags",
  "viewer.proposals.rem.tagRefresh.accept": "Apply refresh",
  "viewer.proposals.rem.tagRefresh.drift": "Drift ${drift}",
  "viewer.proposals.rem.tagRefresh.driftTip": "Content drift ${drift} — significant content change triggered re-extraction",
  "viewer.proposals.rem.band.veryHigh": "Very high confidence",
  "viewer.proposals.rem.band.high": "High confidence",
  "viewer.proposals.rem.band.medium": "Medium confidence",
  "viewer.proposals.rem.band.low": "Low confidence",
  "viewer.proposals.rem.band.veryLow": "Very low confidence",
  "viewer.proposals.rem.bandTip": "Confidence ${score} / 1.0",
  "viewer.proposals.rem.reason.refute":
    "This memory lacks supporting evidence or is contradicted by others; suggest marking it refuted.",
  "viewer.proposals.rem.reason.verify":
    "This memory recurs across domains with solid evidence; suggest upgrading its verification level.",
  "viewer.proposals.rem.accept.refute": "Accept refute",
  "viewer.proposals.rem.accept.verify": "Accept upgrade",
  "viewer.proposals.rem.dismiss": "Keep as-is",
  "viewer.proposals.rem.applied": "Applied",
  "viewer.proposals.rem.kept": "Kept as-is",
  "viewer.proposals.rem.pattern.sourceCount": "from ${n} memories",
  "viewer.proposals.rem.pattern.sourceTip": "Pattern abstracted from these memories",
  "viewer.proposals.rem.synapse.op.add": "➕ Connect",
  "viewer.proposals.rem.synapse.op.delete": "🗑️ Remove",
  "viewer.proposals.rem.synapse.op.retype": "🔄 Retype",
  "viewer.proposals.rem.synapse.reason.add":
    "Dream detected two highly similar memories with no connection. Accept to create the synapse.",
  "viewer.proposals.rem.synapse.reason.delete":
    "Dream detected a connection whose endpoints are no longer related. Accept to remove it.",
  "viewer.proposals.rem.synapse.reason.retype":
    "Dream detected a connection that could be more precise. Accept to retype it.",
  "viewer.proposals.rem.synapse.between": "Connect: ${from} → ${to}",
  "viewer.proposals.rem.synapse.detail.title": "Synapse Operation Detail",
  "viewer.proposals.rem.synapse.detail.fromLabel": "Source memory",
  "viewer.proposals.rem.synapse.detail.toLabel": "Target memory",
  "viewer.proposals.rem.synapse.detail.kindLabel": "Synapse type",
  "viewer.proposals.rem.synapse.detail.confLabel": "Confidence",
  "viewer.proposals.rem.synapse.detail.reasonLabel": "Reason",
  "viewer.proposals.rem.synapse.detail.openMem": "Open",
  // ===== Proposal「source reason」display(viewer.proposals.sourceLine.* / why.*) =====
  "viewer.proposals.sourceLine.conversation": "Conversation cluster",
  "viewer.proposals.sourceLine.external": "External file",
  "viewer.proposals.sourceLine.autoMemory": "auto-memory",
  "viewer.proposals.sourceLine.skill": "Skill proposal",
  "viewer.proposals.skillBadge": "Skill",
  "viewer.proposals.skill.usage": "Usage",
  "viewer.proposals.skillIdLabel": "Skill ID",
  "viewer.proposals.sourceLine.times": "times",
  "viewer.proposals.why.title": "Why this was proposed",
  "viewer.proposals.why.source": "Source",
  "viewer.proposals.why.window": "Window",
  "viewer.proposals.why.necessity": "Why",
  "viewer.proposals.why.samples": "Sample quotes",
  "viewer.proposals.why.necessity.conversation": "Similar theme recurred; ${n} independent samples passed the necessity check",
  "viewer.proposals.why.necessity.fallback": "Similar content appeared multiple times",
  "viewer.proposals.why.necessity.external": "A new untracked .md file was detected in the memory vault; content is pre-filled and ready to accept",
  "viewer.proposals.why.necessity.skill": "An unregistered skill directory (SKILL.md) was detected under dataRoot; accepting creates a procedural-memory (skill) imprint.",
  "viewer.proposals.why.necessity.autoMemory": "The host agent (Claude Code / OpenClaw) auto-wrote a system memory file; content is pre-filled and ready to accept",
  "viewer.proposals.why.necessity.remPattern": "An abstract pattern distilled from multiple existing memories during REM sleep",
  "viewer.proposals.why.necessity.remVerification": "A verification status change suggested by REM meta-cognitive evaluation",
  "viewer.proposals.why.necessity.remTagRefresh": "REM detected this memory still carries a placeholder tag (imported/uncategorized) or its content has drifted; LLM re-extracted content-semantic tags pending approval",
  "viewer.proposals.why.sourceLabel.conversation": "Conversation cluster",
  "viewer.proposals.why.sourceLabel.skill": "Skill directory detection",
  "viewer.proposals.why.sourceLabel.external": "External file detected",
  "viewer.proposals.why.sourceLabel.autoMemory": "auto-memory · Claude Code / OpenClaw host system memory",
  "viewer.proposals.why.sourceLabel.remPattern": "REM pattern synthesis",
  "viewer.proposals.why.sourceLabel.remVerification": "REM meta-cognitive verification",
  "viewer.proposals.why.sourceLabel.remTagRefresh": "REM tag refresh",
  "viewer.proposals.why.window.within": "${n} occurrences within ${dur}",
  "viewer.proposals.why.window.minute": "min",
  "viewer.proposals.why.window.hour": "h",
  "viewer.proposals.why.window.day": "d",
  "viewer.proposals.why.advanced": "Advanced",
  "viewer.proposals.why.advancedReason": "Raw evaluation reason",
  "viewer.proposals.why.advancedRule": "Triggered rule",
  "viewer.proposals.rem.acceptFail": "REM accept failed",
  "viewer.proposals.rem.dismissFail": "REM dismiss failed",
  "viewer.proposals.convertedTo": "Converted to",
  "viewer.proposals.dismissedReason": "Dismissed",
  "viewer.proposals.detailTitle": "Proposal detail",
  "viewer.proposals.titleLabel": "Title",
  "viewer.proposals.titleLabelReadonly": "Title (read-only)",
  "viewer.proposals.kindLabel": "Kind",
  "viewer.proposals.kindLabelReadonly": "Kind (read-only)",
  "viewer.proposals.tagsLabel": "Domain tags (comma-separated)",
  "viewer.proposals.tagsLabelReadonly":
    "Domain tags (comma-separated, read-only)",
  "viewer.proposals.tagsPlaceholder": "e.g. frontend, dark-mode, css",
  "viewer.proposals.contentLabel": "Content (becomes engram body)",
  "viewer.proposals.contentLabelReadonly": "Content (read-only)",
  "viewer.proposals.samples": "Sample quotes (${n} cumulative)",
  "viewer.proposals.noSamples": "(no samples)",
  "viewer.proposals.sourceFile": "Source file",
  "viewer.proposals.firstSeen": "First seen:",
  "viewer.proposals.lastSeen": "Last seen:",
  "viewer.proposals.currentStatus": "Current proposal status:",
  "viewer.proposals.createdEngram": "Created engram:",
  "viewer.proposals.dismissedUntil": "Dismissed until:",
  "viewer.proposals.dismissBtn": "Dismiss",
  "viewer.proposals.acceptBtn": "Accept & save",
  "viewer.proposals.visibility.label": "Visibility",
  "viewer.proposals.visibility.hint":
    "Default public; switch to private if the LLM asked or you spot sensitive content.",
  "viewer.proposals.notFound": "Proposal not found: ${id}",
  "viewer.proposals.titleRequired": "Please fill in the title",
  "viewer.proposals.contentRequired": "Please fill in the content",
  "viewer.proposals.acceptedToast": "✓ Accepted",
  "viewer.proposals.createdEngramToast": "Created engram: ${id}",
  "viewer.proposals.acceptFailed": "Accept failed: ${err}",
  "viewer.proposals.dismissConfirm":
    "Dismiss this proposal? It will not resurface. Audit log retained.",
  "viewer.proposals.dismissFailed": "Dismiss failed: ${err}",
  "viewer.proposals.batch.acceptAll": "Accept all (${n})",
  "viewer.proposals.selectTip": "Check to batch accept / dismiss",
  "viewer.proposals.batch.acceptSelected": "Accept selected (${n})",
  "viewer.proposals.batch.dismissSelected": "Dismiss selected (${n})",
  "viewer.proposals.batch.clearSelection": "Clear selection",
  "viewer.proposals.batch.acceptSelectedConfirm":
    "Accept ${n} selected proposals? Engrams will be created — this cannot be undone.",
  "viewer.proposals.batch.dismissSelectedConfirm":
    "Dismiss ${n} selected proposals? Undo is available for 5 seconds.",
  "viewer.proposals.batch.acceptToast": "Accepted ${ok}, failed ${fail}",
  "viewer.proposals.batch.dismissToast": "Dismissed ${ok}, failed ${fail}",
  "viewer.proposals.batch.undo": "Undo (${n})",
  "viewer.proposals.batch.dismissAll": "Dismiss all (${n})",
  "viewer.proposals.batch.acceptAllConfirm":
    "Batch-accept ${n} loaded pending proposals?\n\nEach will create an engram (cannot be undone in one click). Proposals beyond the loaded range are not affected.",
  "viewer.proposals.batch.dismissAllConfirm":
    "Batch-dismiss ${n} loaded pending proposals?\n\nThey will not resurface. Proposals beyond the loaded range are not affected.",
  "viewer.proposals.batch.acceptAllToast":
    "Batch accept done: ${ok} succeeded, ${fail} failed",
  "viewer.proposals.batch.dismissAllToast":
    "Batch dismiss done: ${ok} succeeded, ${fail} failed",
  "viewer.proposals.batch.noPending":
    "No pending proposals in current view to batch-operate",
  "viewer.proposals.batch.purgeDismissed": "Purge dismissed (${n})",
  "viewer.proposals.batch.purgeConfirm":
    "Purge ${n} dismissed proposals?\n\nPermanently deleted from disk, cannot be undone (audit log retained). Only dismissed proposals are affected; pending / accepted are untouched.",
  "viewer.proposals.batch.purgeToast": "Purged ${n} dismissed proposals",
  "viewer.proposals.batch.purgeFailed": "Purge failed: ${err}",
  "viewer.proposals.batch.purgeNoDismissed": "No dismissed proposals to purge",
  "viewer.proposals.batch.purgeAccepted": "Purge accepted (${n})",
  "viewer.proposals.batch.purgeNoAccepted": "No accepted proposals to purge",
  "viewer.proposals.batch.purgeAcceptedConfirm":
    "Purge ${n} accepted proposal records?\n\nOnly clears adoption records from proposals.jsonl; engrams created during accept are kept.",
  "viewer.proposals.batch.purgeAcceptedToast": "Purged ${n} accepted proposals",

  // ===== Audit panel (viewer.audit.*) =====
  "viewer.audit.filter.actor": "Actor",
  "viewer.audit.filter.category": "Category",
  "viewer.audit.filter.engramPlaceholder": "Filter by engram id...",
  "viewer.audit.filter.time": "Time",
  "viewer.audit.timeAll": "All time",
  "viewer.audit.timeToday": "Today",
  "viewer.audit.time7d": "Last 7 days",
  "viewer.audit.time30d": "Last 30 days",
  "viewer.audit.filter.actionChipTitle": "Click to clear action filter",
  "viewer.audit.actorAll": "All",
  "viewer.audit.actorUser": "User",
  "viewer.audit.actorLlm": "LLM",
  "viewer.audit.actorSystem": "System",
  "viewer.audit.catAll": "All",
  "viewer.audit.catState": "State changes",
  "viewer.audit.catEffective": "Effectiveness",
  "viewer.audit.catContradicted": "Contradictions",
  "viewer.audit.catProposal": "Proposals",
  "viewer.audit.empty": "No matching events",
  "viewer.audit.disabledHint": "Audit log is disabled.",
  "viewer.audit.kpi.total": "Total",
  "viewer.audit.kpi.state": "State changes",
  "viewer.audit.kpi.effective": "Effectiveness signals",
  "viewer.audit.kpi.contradicted": "Contradictions",
  "viewer.audit.kpi.proposal": "Proposals",
  "viewer.audit.synapseChip": "synapse",
  "viewer.audit.targetOpenEngram": "📄 Open engram",
  "viewer.audit.targetOpenSourceEngram": "🌐 Open source engram",
  "viewer.audit.targetGone": "Target no longer exists: ${id}",
  "viewer.audit.targetDeleted": "(deleted)",
  "viewer.audit.filterActionHint": " — click to show only this action",
  "viewer.audit.metaEmpty": "—",
  "viewer.audit.noFieldChanges": "(no fields actually changed)",
  "viewer.audit.actorTip.user": "User: events triggered manually",
  "viewer.audit.actorTip.llm":
    "LLM: events triggered by a language-model agent",
  "viewer.audit.actorTip.system":
    "System: events triggered by background maintenance/self-healing",
  "viewer.audit.actionTip.create": "create: create a new engram",
  "viewer.audit.actionTip.update":
    "update: modify fields of an existing engram",
  "viewer.audit.actionTip.update_lifecycle":
    "update_lifecycle: lifecycle transition (frozen/forgotten)",
  "viewer.audit.actionTip.importance_update":
    "importance_update: importance score auto-adjusted (decay or maintenance calibration)",
  "viewer.audit.actionTip.reinforce":
    "reinforce: potentiation (LTP) — retrieval effective, loop succeeded",
  "viewer.audit.actionTip.report_failure":
    "report_failure: negative feedback (LTD) — retrieval inaccurate, loop failed",
  "viewer.audit.actionTip.learning_loop_success":
    "learning_loop_success: learning loop closed (retrieve → use → verify → confirm)",
  "viewer.audit.actionTip.forget": "forget: marked as forgotten",
  "viewer.audit.actionTip.restore":
    "restore: restored from forgotten/frozen back to active",
  "viewer.audit.actionTip.sweep_to_trash":
    "sweep_to_trash: forgotten after 30 days, file moved to .trash/",
  "viewer.audit.actionTip.restore_from_trash":
    "restore_from_trash: physically restored from .trash/",
  "viewer.audit.actionTip.purge":
    "purge: hard delete (content + meta + associated synapses)",
  "viewer.audit.actionTip.retrieve_hit": "retrieve_hit: search hit",
  "viewer.audit.actionTip.retrieve_effective":
    "retrieve_effective: hit and actually adopted",
  "viewer.audit.actionTip.retrieve_inconclusive":
    "retrieve_inconclusive: hit but unsure if effective",
  "viewer.audit.actionTip.contradicted":
    "contradicted: conflict with other engrams detected, entering resolution",
  "viewer.audit.actionTip.noise_filtered":
    "noise_filtered: observation cluster judged as noise, no candidate formed",
  "viewer.audit.actionTip.necessity_rejected":
    "necessity_rejected: candidate rejected by necessity evaluation",
  "viewer.audit.actionTip.propose": "propose: candidate memory captured",
  "viewer.audit.actionTip.accept":
    "accept: candidate adopted, converted to a formal engram",
  "viewer.audit.actionTip.dismiss": "dismiss: candidate rejected",
  "viewer.audit.actionTip.merge_resolved":
    "merge_resolved: cross-file merge conflict resolved",
  "viewer.audit.actionTip.merge_backup_failed":
    "merge_backup_failed: pre-merge backup failed, process aborted",
  "viewer.audit.actionTip.merge_conflict_escalated":
    "merge_conflict_escalated: merge conflict escalated, manual resolution required",
  "viewer.audit.actionTip.merge_llm_arbitrated":
    "merge_llm_arbitrated: LLM arbitrated merge conflict",
  "viewer.audit.actionTip.merge_llm_arbitrated_escalated":
    "merge_llm_arbitrated_escalated: LLM arbitration escalated, manual review required",
  "viewer.audit.actionTip.merge_llm_arbitrated_failed":
    "merge_llm_arbitrated_failed: LLM arbitration failed, manual intervention required",
  "viewer.audit.actionTip.maintenance_run":
    "maintenance_run: maintenance stage fired (rem), system-run memory consolidation",
  // Short action labels for timeline buttons. When translation missing,
  // _actionLabel falls back to the raw action string — but to keep the audit
  // timeline locale-consistent we cover every emitted action here.
  "viewer.audit.actionLabel.create": "Create",
  "viewer.audit.actionLabel.update": "Update",
  "viewer.audit.actionLabel.update_lifecycle": "Lifecycle",
  "viewer.audit.actionLabel.importance_update": "Importance",
  "viewer.audit.actionLabel.reinforce": "Reinforce",
  "viewer.audit.actionLabel.report_failure": "Decay",
  "viewer.audit.actionLabel.learning_loop_success": "Confirmed",
  "viewer.audit.actionLabel.forget": "Forget",
  "viewer.audit.actionLabel.restore": "Restore",
  "viewer.audit.actionLabel.sweep_to_trash": "Trash",
  "viewer.audit.actionLabel.restore_from_trash": "Recover",
  "viewer.audit.actionLabel.purge": "Purge",
  "viewer.audit.actionLabel.retrieve_hit": "Hit",
  "viewer.audit.actionLabel.retrieve_effective": "Effective",
  "viewer.audit.actionLabel.retrieve_inconclusive": "Inconclusive",
  "viewer.audit.actionLabel.contradicted": "Conflict",
  "viewer.audit.actionLabel.noise_filtered": "Filtered",
  "viewer.audit.actionLabel.necessity_rejected": "Rejected",
  "viewer.audit.actionLabel.propose": "Propose",
  "viewer.audit.actionLabel.accept": "Accept",
  "viewer.audit.actionLabel.dismiss": "Dismiss",
  "viewer.audit.actionLabel.merge_resolved": "Resolved",
  "viewer.audit.actionLabel.merge_backup_failed": "Backup Fail",
  "viewer.audit.actionLabel.merge_conflict_escalated": "Conflict",
  "viewer.audit.actionLabel.merge_llm_arbitrated": "LLM",
  "viewer.audit.actionLabel.merge_llm_arbitrated_escalated": "Escalated",
  "viewer.audit.actionLabel.merge_llm_arbitrated_failed": "LLM Fail",
  "viewer.audit.actionLabel.maintenance_run": "Maintenance",
  "viewer.audit.actionLabel.skill_create": "Create skill",
  "viewer.audit.actionLabel.skill_update": "Update skill",
  "viewer.audit.actionLabel.skill_delete": "Delete skill",
  "viewer.audit.actionLabel.skill_invoke": "Invoke skill",
  "viewer.audit.actionLabel.skill_compose_add": "Compose add",
  "viewer.audit.actionLabel.skill_compose_remove": "Compose remove",
  "viewer.audit.actionLabel.skill_related_engram_add": "Link memory",
  "viewer.audit.actionLabel.skill_related_engram_remove": "Unlink memory",
  "viewer.audit.actionTip.skill_create": "skill_create: create a new skill (procedural memory)",
  "viewer.audit.actionTip.skill_update": "skill_update: update skill fields (initiation/termination/policy)",
  "viewer.audit.actionTip.skill_delete": "skill_delete: delete skill sidecar imprint (SKILL.md untouched)",
  "viewer.audit.actionTip.skill_invoke": "skill_invoke: record skill use; Rescorla-Wagner updates utility + retention",
  "viewer.audit.actionTip.skill_compose_add": "skill_compose_add: add skill compose link (A into B's workflow)",
  "viewer.audit.actionTip.skill_compose_remove": "skill_compose_remove: remove skill compose link",
  "viewer.audit.actionTip.skill_related_engram_add": "skill_related_engram_add: link skill to engram (procedural ↔ declarative)",
  "viewer.audit.actionTip.skill_related_engram_remove": "skill_related_engram_remove: remove skill-engram link",
  // audit pager (bottom paginator of audit timeline; mirrors engrams.pager).
  // Long-missing — UI used to show raw key strings. Added 2026-07.
  "viewer.audit.pager.prev": "« Prev",
  "viewer.audit.pager.next": "Next »",
  "viewer.audit.pager.pageInfo":
    "Page ${current} / ${total} (${itemTotal} items)",
  "viewer.audit.pager.loadingHint": "Loading more…",

  // ===== Trash panel (viewer.trash.*) =====
  "viewer.trash.empty": "Trash is empty",
  "viewer.trash.titleCount": "Trash · ${n} items",
  "viewer.trash.partitionLabel": "Partition:",
  "viewer.trash.all": "All",
  "viewer.trash.purgeAllBtn": "Purge all permanently",
  "viewer.trash.colId": "ID",
  "viewer.trash.colPartition": "Partition",
  "viewer.trash.colTrashedAt": "Trashed at",
  "viewer.trash.previewBtn": "Preview",
  "viewer.trash.restoreBtn": "Restore",
  "viewer.trash.daysLeftUnit": " days until purge",
  "viewer.trash.previewTitle": "Trash preview",
  "viewer.trash.previewHint":
    'This memory has been removed from the main index. "Restore" it first to edit or recall it again.',
  "viewer.trash.partitionField": "Partition:",
  "viewer.trash.trashedAtField": "Trashed at:",
  "viewer.trash.creatorField": "Creator:",
  "viewer.trash.contentSection": "Content",
  "viewer.trash.restoreToMainBtn": "Restore to main index",
  "viewer.trash.closeBtn": "Close",
  "viewer.trash.restoreConfirm": "Restore ${id} to main index?",
  "viewer.trash.purgeBtn": "Purge",
  "viewer.trash.purgeTip": "Permanently delete this file from trash — unrecoverable",
  "viewer.trash.purgeConfirm": "Purge ${id}?\n\nThe file will be physically deleted from trash and cannot be recovered (unlike “purge all”, this deletes only this one item).",
  "viewer.trash.purgeFailed": "Purge failed: ${err}",
  "viewer.trash.restoreFailed": "Restore failed: ${err}",
  "viewer.trash.purgeAllScopeAll": "all items (across all partitions)",
  "viewer.trash.purgeAllScopePartition": "partition ${p}",
  "viewer.trash.prescanFailed": "Pre-scan failed: ${err}",
  "viewer.trash.purgeEmpty": "Nothing to purge in the current scope",
  "viewer.trash.purgeConfirm1":
    "About to permanently delete ${n} memories in ${scope}.\nThis is irreversible (physical unlink). Even with a git repo, recovery is only possible from historical commits.\n\nContinue?",
  "viewer.trash.purgeConfirm2":
    "Second confirmation: really purge all ${n} items in ${scope}?",
  "viewer.trash.purgeDone": "Permanently deleted ${n} memories.",
  "viewer.trash.colTitle": "Title",
  "viewer.trash.sourceSoft": "soft",
  "viewer.trash.sourceSwept": "swept",
  "viewer.trash.loadMore": "Load more (${loaded} / ${total} loaded)",
  "viewer.trash.allLoaded": "All loaded (${n} items)",
  "viewer.trash.partitionSoftSuffix": "(soft)",
  "viewer.trash.partitionSweptSuffix": "(swept)",
  "viewer.trash.partitionTipSoft":
    "Soft delete: engram remains in main index with status=forgotten/frozen; one-click restore.",
  "viewer.trash.partitionTipSwept":
    "Physical sweep: file moved to .trash/ directory; git history preserved, restore from .trash/.",

  // ===== Merges panel (viewer.merges.*) =====
  "viewer.merges.loading": "Loading merge stats",
  "viewer.merges.auditDisabledHint":
    "Audit log is disabled; no merge data available.",
  "viewer.merges.title": "Merge stats · last ${days} days",
  "viewer.merges.summaryLine": "last ${days} days · ${total} file merges · ${auto} auto-resolved by the merge driver (rate ${rate}) · ${esc} escalated to conflict markers",
  "viewer.merges.mgConflicts": "${n} conflicts · per-field adjudication in the Audit tab",
  "viewer.merges.mgShare": "share",
  "viewer.merges.kpi.totalMerges": "Total merges",
  "viewer.merges.kpi.autoResolved": "Auto-resolved",
  "viewer.merges.kpi.escalatedToMarkers": "Escalated to conflict markers",
  "viewer.merges.kpi.backupFailures": "Backup failures",
  "viewer.merges.llmSection": "LLM arbitration",
  "viewer.merges.llm.totalInvocations": "Total invocations",
  "viewer.merges.llm.arbitrated": "Arbitrated",
  "viewer.merges.llm.escalated": "Escalated",
  "viewer.merges.llm.failed": "Failed",
  "viewer.merges.llm.successRate": "Success rate",
  "viewer.merges.byStrategy": "Strategy distribution (Top 8)",
  "viewer.merges.hotPaths": "Conflict hot paths (Top 8)",
  "viewer.merges.byDay": "Daily merges (trend)",
  "viewer.merges.anomalyBanner": "Anomalies · ${n} alerts",

  // ===== Maintenance panel (viewer.maintenance.*) — plan A viewer tab =====
  "viewer.maintenance.loading": "Loading maintenance state",
  "viewer.maintenance.sleep.title": "Sleep report",
  "viewer.maintenance.sleep.sub": "deep (decay & consolidation) + rem (metacognition) stages · runs automatically every night",
  "viewer.maintenance.sleep.when": "Last run: ${t}",
  "viewer.maintenance.sleep.reinforce": "Reinforced (RPE)",
  "viewer.maintenance.sleep.decay": "Decayed (deep)",
  "viewer.maintenance.sleep.upgrade": "Verification upgrades (REM)",
  "viewer.maintenance.sleep.pattern": "Pattern distillation",
  "viewer.maintenance.sleep.archive": "Archived / forgotten",
  "viewer.maintenance.sleep.upgradeSub": "rem metacognition · verification transitions",
  "viewer.maintenance.sleep.reinforceSub": "RPE · positive feedback after retrieval",
  "viewer.maintenance.sleep.decaySub": "deep · auto soft-demotion after 30d unused (no deletion)",
  "viewer.maintenance.sleep.patternSub": "dream distillation · surfaces as proposals for approval",
  "viewer.maintenance.sleep.noise": "Noise rejected",
  "viewer.maintenance.sleep.noiseSub": "proposal engine Layer 1/2 noise filter · audit counts in the same window",
  "viewer.maintenance.sleep.contradict": "Contradictions pending",
  "viewer.maintenance.sleep.contradictSub": "contradicts synapse created · awaiting human adjudication",
  "viewer.maintenance.sleep.noiseItem": "${reason} · ${path}",
  "viewer.maintenance.sleep.contraItem": "contradicts ${by} · click to open",
  "viewer.maintenance.sleep.empty": "The latest maintenance run produced no memory changes",
  "viewer.maintenance.sleep.next": "Next maintenance: ${stage}, in about ${h} h",
  "viewer.maintenance.sleep.softening":
    "Rule: decay is a soft demotion — memories remain retrievable; only after several untouched cycles do they become trash candidates. Click an item to see the change details and source memory.",
  "viewer.maintenance.disabledHint":
    "Maintenance service not enabled or dataRoot unavailable.",
  "viewer.maintenance.title": "Dream State",
  "viewer.maintenance.intro":
    "Memory dreams run in the background on a schedule: 🌙 REM does memory consolidation and metacognition (clustering similar memories + abstracting patterns + verification upgrades), 🧠 deep memory cleanup, ⚡ light signal processing. Below shows each stage's last run time, artifacts, and cycle status.",
  "viewer.maintenance.never": "never run",
  "viewer.maintenance.justNow": "just now",
  "viewer.maintenance.minutesAgo": "${n} min ago",
  "viewer.maintenance.hoursAgo": "${n} h ago",
  "viewer.maintenance.daysAgo": "${n} d ago",
  "viewer.maintenance.lastWrite": "Last updated: ${at}",
  "viewer.maintenance.explainerTitle": "How to read these metrics",
  "viewer.maintenance.explainerBody":
    'REM is a low-frequency stage. Process restarts or holder switching can cause setInterval to never fire — the startup catch-up will immediately run overdue low-frequency stages. light/deep run frequently (5 min / 1 h), so setInterval naturally triggers them, and "never run" isn\'t abnormal. Status colors: green (healthy cycle), yellow (due soon), red (overdue, will catch up on next startup).',
  "viewer.maintenance.stage.rem": "REM (consolidation)",
  "viewer.maintenance.stage.deep": "Deep (cleanup)",
  "viewer.maintenance.stage.light": "Light (signals)",
  "viewer.maintenance.stageIcon.rem": "🌙",
  "viewer.maintenance.stageIcon.deep": "🧠",
  "viewer.maintenance.stageIcon.light": "⚡",
  "viewer.maintenance.stageSubtitle.rem":
    "Dream-sleep stage: cluster similar memories + abstract patterns + metacognition scoring, producing upgrade / refute / pattern proposals for approval",
  "viewer.maintenance.stageSubtitle.deep": "Memory cleanup: merge duplicates + archive/forget stale + trash sweep",
  "viewer.maintenance.stageSubtitle.light":
    "Signal processing: turn tool-call behavior flow into engram reinforce/decay (RPE additive)",
  "viewer.maintenance.stageTip.rem":
    "REM (Rapid Eye Movement) mirrors human dream sleep. Three jobs: ① cluster similar engrams; ② abstract patterns from them; ③ run metacognition scoring. These outputs (upgrades / refutes / new patterns) are not written automatically — they appear as proposals on the Proposals page and take effect only after you approve them. Default 1-day cycle.",
  "viewer.maintenance.stageTip.deep": "Deep stage: merge duplicates + freshness-driven archive/forget + trash sweep. Default 1h.",
  "viewer.maintenance.stageTip.light":
    "Light stage: drain tool-call event stream → extractSignals → applyRpeUpdate. High frequency (default 5 min), event-driven micro-tuning.",
  "viewer.maintenance.dreamBadge": "dream sleep",
  "viewer.maintenance.dreamBadgeTip":
    "REM borrows the human sleep-neuroscience metaphor: this stage acts like dream-state memory consolidation, reshaping scattered traces from the day into long-lived patterns.",
  "viewer.maintenance.remModifiedLabel": "Last REM modified",
  "viewer.maintenance.lightNoSignal":
    "No new memory-usage signals this cycle, so memories are unchanged (Light turns retrieval/usage behavior into reinforcement; with no new behavior, memories stay as-is).",
  "viewer.maintenance.lightModifiedLabel": "RPE boosted",
  "viewer.maintenance.deepModifiedLabel": "Modified",
  "viewer.maintenance.deepAction.forgotten": "forgotten",
  "viewer.maintenance.deepAction.archived": "archived",
  "viewer.maintenance.deepAction.merged": "merged",
  "viewer.maintenance.modCard.viewEngram": "View memory detail",
  "viewer.maintenance.modCard.remUpgrade":
    "This memory was evaluated during dream sleep (REM); its verification status rose from \"${before}\" to \"${after}\" — the system considers it more trustworthy.",
  "viewer.maintenance.modCard.remRefute":
    "This memory was judged low-confidence during dream sleep (REM) and marked \"refuted\". It is kept but clearly flagged as unreliable.",
  "viewer.maintenance.modCard.deepForgotten":
    "This memory was judged stale and forgotten during Deep (cleanup) after long disuse, lowering its retrieval priority.",
  "viewer.maintenance.modCard.deepArchived":
    "This memory was archived during Deep (cleanup); it is no longer active but remains in the store.",
  "viewer.maintenance.modCard.deepMerged":
    "This memory was merged into a similar one during Deep (cleanup) to deduplicate; its content moved into the target memory.",
  "viewer.maintenance.modCard.lightRpe":
    "This memory gained an RPE boost of ${delta} during Light (signal processing) because it was retrieved/used — used memories grow stronger.",
  "viewer.maintenance.patternLabel": "Pattern abstraction",
  "viewer.maintenance.remAction.evaluated": "evaluated",
  "viewer.maintenance.status.healthy": "in cycle",
  "viewer.maintenance.status.soon": "due soon",
  "viewer.maintenance.status.overdue": "overdue",
  "viewer.maintenance.status.never": "not triggered",
  "viewer.maintenance.statusTip.healthy": "Cycle healthy. Next trigger in ${n}",
  "viewer.maintenance.statusTip.soon":
    "Due soon (${pct}% of cycle used); next trigger will restore healthy state",
  "viewer.maintenance.statusTip.overdue":
    "Overdue by ${n}. Next startup will catch-up immediately (low-freq stages) or wait for next setInterval tick (high-freq stages)",
  "viewer.maintenance.statusTip.never":
    "This stage has never fired. Low-frequency stages (rem) will be triggered immediately by startup catch-up; high-frequency stages (light/deep) are scheduled by setInterval",
  "viewer.maintenance.progressBarTip":
    "Cycle progress: ${pct}% (${remain} to next trigger)",
  "viewer.maintenance.progressBarTipOverdue":
    "Overdue by ${pct}% of cycle (${remain} overdue)",
  "viewer.maintenance.resultLabel": "Last artifacts",
  "viewer.maintenance.errorLabel": "Last error",

  // ===== Graph toolbar (viewer.graph.*) =====
  "viewer.graph.loading": "Loading graph...",
  "viewer.graph.reloading": "Reloading graph",
  "viewer.graph.fitBtn": "Fit",
  "viewer.graph.physicsBtn": "Physics",
  "viewer.graph.resetBtn": "Reset filters",
  "viewer.graph.fitTip":
    "Fit view: auto-zoom and center so all nodes are visible",
  "viewer.graph.physicsTip":
    "Physics engine: when on, nodes auto-layout via spring/repulsion model (uses CPU until stable); when off, current positions are frozen — useful for browsing large graphs after they stabilize",
  "viewer.graph.resetTip":
    "Reset filters: restore all kind/family checkboxes and re-fit the view",
  "viewer.graph.synapseGroupTitle": "Synapse kinds · by family",
  "viewer.graph.engramsGroupTitle": "Engram kinds",
  "viewer.graph.family.structural": "Structural",
  "viewer.graph.family.causal": "Causal",
  "viewer.graph.family.evidential": "Evidential",
  "viewer.graph.family.temporal": "Temporal",
  "viewer.graph.family.modulatory": "Modulatory",
  "viewer.graph.familyDesc.structural": "Composition / extension relationships",
  "viewer.graph.familyDesc.causal": "Trigger / dependency relationships",
  "viewer.graph.familyDesc.evidential": "Source / conflict relationships",
  "viewer.graph.familyDesc.temporal": "Version / evolution relationships",
  "viewer.graph.familyDesc.modulatory": "Contextual relationships",
  "viewer.graph.kindDesc.fact":
    "A confirmed, independently verifiable objective statement",
  "viewer.graph.kindDesc.observation":
    "A one-off perceived fact, not yet distilled into a stable conclusion",
  "viewer.graph.kindDesc.pattern":
    "A rule归纳duced from repeated observations; can predict future behavior",
  "viewer.graph.kindDesc.procedure":
    "A sequence of steps that reproduces a result when executed",
  "viewer.graph.kindDesc.hypothesis":
    "An unverified guess; usable as a working hypothesis until counter-examples appear",
  "viewer.graph.synapseDesc.extends":
    "A extends B: inherits B's semantics and adds new dimensions",
  "viewer.graph.synapseDesc.part_of": "A is part of B (B has-a A)",
  "viewer.graph.synapseDesc.similar_to":
    "A is semantically close to B; interchangeable or mutually supportive",
  "viewer.graph.synapseDesc.depends_on":
    "A depends on B (B is a precondition of A)",
  "viewer.graph.synapseDesc.causes":
    "A triggers or produces B (positive causation)",
  "viewer.graph.synapseDesc.follows":
    "A follows B temporally/logically (no strong causation)",
  "viewer.graph.synapseDesc.derives_from":
    "A is derived from B (B is the basis)",
  "viewer.graph.synapseDesc.contradicts":
    "A conflicts with B; enters resolution flow",
  "viewer.graph.synapseDesc.exemplifies":
    "A is a concrete instance/sample of B",
  "viewer.graph.synapseDesc.supersedes":
    "A replaces outdated B (version transition)",
  "viewer.graph.synapseDesc.consolidates": "A merges/refines the content of B",
  "viewer.graph.synapseDesc.contextualizes":
    "A provides context for B (neither causal nor evidential)",

  // ===== Graph top filter bar (2026-07) =====
  "viewer.graph.filter.searchPlaceholder": "Search nodes by title/tag/id…",
  "viewer.graph.filter.searchPlaceholder2": "Filter nodes by title / tag text…",
  "viewer.graph.filter.pathBtn2": "Filter by path: all paths ▾",
  "viewer.graph.modes.title": "Node coloring",
  "viewer.graph.status.tip": "Filter nodes by memory status",
  "viewer.graph.modes.structure": "By kind (default)",
  "viewer.graph.modes.vitality": "By retrieval count",
  "viewer.graph.modes.conflict": "Contradiction highlight",
  "viewer.graph.modes.heat": "By retrieval recency",
  "viewer.graph.modes.heatTitle": "Color by last-retrieved time: warm within a week, orange within a month, gray beyond",
  "viewer.graph.legend.pickFilter": "click to filter",
  "viewer.graph.status.activeOnly": "Status: active only",
  "viewer.graph.status.all": "Status: incl. archived / superseded",
  "viewer.graph.status.contradictionsOnly": "Status: contradictions only",
  "viewer.graph.reading.title": "How to read",
  "viewer.graph.reading.hint": "Node size = importance<br>dashed outline = memory cluster (auto-grouped related memories)",
  "viewer.graph.countLine.items": "items",
  "viewer.graph.countLine.visible": "visible (importance ≥${imp})",
  "viewer.graph.countLine.clusters": "Louvain clusters",
  "viewer.graph.insp.skillNode": "Skill node (procedural memory)",
  "viewer.graph.insp.openFull": "Open full",
  "viewer.graph.insp.auditTrail": "Audit trail",
  "viewer.graph.insp.back": "Esc back",
  "viewer.graph.insp.retrieval": "Retrievals",
  "viewer.graph.insp.never": "never",
  "viewer.graph.insp.cluster": "Cluster",
  "viewer.graph.insp.degrees": "In / out edges",
  "viewer.graph.insp.neighborhood": "1-hop · ${n} (flowing edges)",
  "viewer.graph.insp.noNeighbors": "No neighbors",
  "viewer.graph.filter.impTitle": "Importance threshold",
  "viewer.graph.filter.visibleUnit": "visible",
  "viewer.graph.replay.title": "Time replay",
  "viewer.graph.replay.sub": "Grow by creation time · combines with importance threshold",
  "viewer.graph.replay.full": "All · ${n} visible",
  "viewer.graph.replay.noData": "No createdAt data",
  "viewer.graph.night.title": "Toggle light/dark canvas",
  "viewer.graph.night.enable": "Night",
  "viewer.graph.night.disable": "Day",
  "viewer.graph.filter.pathBtn": "📁 Filter by directory",
  "viewer.graph.filter.pathBtnTitle": "Filter graph by engram directory",
  "viewer.graph.filter.pathPickerTitle":
    "Pick a directory · only nodes within it and synapses between them are shown",
  "viewer.graph.filter.pathPick": "Show only this directory",
  "viewer.graph.filter.pathPickerEmpty": "No directory data available",
  "viewer.graph.filter.count": "Nodes ${nodes} · Synapses ${edges}",
  "viewer.graph.filter.countTip":
    'Format: "filtered / total". The stats bar\'s synapse total comes from /api/status (full count), while this graph only renders synapses whose both endpoint engrams exist (dangling synapses are auto-cleaned by doctor). Keyword/path/kind filters narrow the visible range further.',

  // ===== Detail panel / drawer (viewer.detail.*) =====
  "viewer.detail.editModeHint": 'Edit mode · click "Save" to submit changes',
  "viewer.detail.editEngramTitle": "Edit engram",
  "viewer.detail.editSynapseTitle": "Edit synapse",
  "viewer.detail.detailViewTitle": "Detail view",
  "viewer.detail.synapseDetailTitle": "Synapse detail",
  "viewer.detail.kindChangeHint":
    'Note: changing "kind" re-computes the synapse ID (ID derives from from+to+kind). The old ID becomes invalid, but all metadata (weight / evidence / creator) migrates to the new ID.',
  "viewer.detail.titleLabel": "Title",
  "viewer.detail.kindLabel": "Kind",
  "viewer.detail.importanceLabel": "Importance (0-1, drag the slider)",
  "viewer.detail.confidenceLabel": "Confidence (0-1, drag the slider)",
  "viewer.detail.tagsLabel": "Domain tags (comma-separated)",
  "viewer.detail.ctxTagsLabel": "Context tags (comma-separated)",
  "viewer.detail.visibilityLabel": "Visibility",
  "viewer.detail.visibility.changeBtn": "Change visibility",
  "viewer.detail.visibility.confirm":
    "This will migrate the engram file path (e.g., public → private moves the file to a private/ subdirectory); the next sync will push the change. Confirm?",
  "viewer.detail.visibility.changed": "Visibility updated, path migrated",
  "viewer.detail.contentLabel": "Content (Markdown)",
  "viewer.detail.weightLabel": "Weight (0-1, drag the slider)",
  "viewer.detail.evidenceDescLabel":
    "Add evidence description (optional, leave blank to skip)",
  "viewer.detail.evidenceSourceLabel": "Evidence source (optional)",
  "viewer.detail.evidenceDescPlaceholder": "e.g. verified via codegraph...",
  "viewer.detail.evidenceSourcePlaceholder": "e.g. manual / ci / docs",
  "viewer.detail.weightField": "Weight:",
  "viewer.detail.directionField": "Direction:",
  "viewer.detail.familyField": "Family:",
  "viewer.detail.resolutionField": "Resolution:",
  "viewer.detail.sourceToTargetField": "Source → Target:",
  "viewer.detail.evidenceCount": "Evidence (${n})",
  "viewer.detail.noEvidence": "No evidence",
  "viewer.detail.confidenceEvidence": "confidence ${n}",
  "viewer.scoreBand.high": "High",
  "viewer.scoreBand.medium": "Medium",
  "viewer.scoreBand.low": "Low",
  "viewer.importance.tooltip": "Current importance: ${value}",
  "viewer.detail.searching": "Searching...",
  "viewer.detail.searchNoMatch": "No matches",
  "viewer.detail.searchFailed": "Search failed: ${err}",

  // ===== Config panel (viewer.config.*) =====
  "viewer.config.sectionPersisted": "Configuration (restart required)",
  "viewer.config.sectionRuntime": "Runtime toggles (next launch)",
  "viewer.config.sectionMetadata": "Repository info",
  "viewer.config.pendingBanner":
    "${fields} saved — restart ${host} to take effect",
  "viewer.config.runtimeHintPrefix": "(current: ",
  "viewer.config.runtimeDiffHint": "running: ${val}; save and restart to apply",
  "viewer.config.saveBarHint": "writes the repo config.json; language / profile take effect after restart",
  "viewer.config.runtimeHintSuffix": ")",
  "viewer.config.runtimeNotSet": "(not set)",
  "viewer.config.field.language": "Language",
  "viewer.config.field.language.desc":
    "Language used for UI / tool descriptions / prompts",
  "viewer.config.field.defaultCreatedBy": "Default creator",
  "viewer.config.field.defaultCreatedBy.desc":
    "Default createdBy for new engrams; falls back to git identity if empty",
  "viewer.config.field.defaultCreatedBy.placeholder":
    "(leave blank to use git author)",
  "viewer.config.field.toolsProfile": "Tools profile",
  "viewer.config.field.toolsProfile.desc":
    "Tool count visible to the LLM: minimal / standard / full",
  "viewer.config.field.dataRoot": "Data root",
  "viewer.config.field.dataRoot.desc":
    "On-disk location of engrams / synapses / audit. To change it, run <code>co-engram config data-root &lt;new-path&gt;</code> in a terminal.",
  "viewer.config.field.configVersion": "Config version",
  "viewer.config.field.createdAt": "Created at",
  "viewer.config.field.updatedAt": "Last updated",
  "viewer.config.runtimeSection.hint":
    'These toggles persist the "desired state at next launch" to config.json. The currently running instance is unaffected — new values take effect only after restarting ${host}.',
  "viewer.config.runtimeSection.openclawExtra":
    " In OpenClaw mode, run <code>openclaw gateway restart</code> in a terminal.",
  "viewer.config.runtimeSection.mcpExtra":
    " In Claude Code mode, run <code>/mcp</code> in each session and choose to reconnect co-engram (or Reload Window). If multiple Claude Code windows are open, reconnect every session — new values take effect globally only after all sessions have reconnected.",
  "viewer.config.runtime.audit": "Audit log",
  "viewer.config.runtime.audit.desc":
    "Records all API / tool invocation events",
  "viewer.config.runtime.proposals": "Proposal engine",
  "viewer.config.runtime.proposals.desc":
    "Implicitly captures memory candidates for review",
  "viewer.config.runtime.maintenance": "Maintenance engine",
  "viewer.config.runtime.maintenance.desc":
    "Background light/deep/rem three-stage maintenance",
  "viewer.config.runtime.search": "Searcher",
  "viewer.config.runtime.search.desc": "Semantic + keyword retrieval",
  "viewer.config.runtime.viewer": "Web viewer",
  "viewer.config.runtime.viewer.desc":
    "HTTP server hosting this page (cannot be turned off, or this UI disconnects)",
  "viewer.config.dataRootReadOnly":
    "Data root is now a single CLI entry point: run <code>co-engram config data-root &lt;path&gt;</code> to change it.",
  "viewer.config.dataRootSave": "Save data root",
  "viewer.config.dataRootEditableHint":
    "Changing the data root requires restarting the host to take effect. Alternatively run <code>co-engram config data-root &lt;path&gt;</code> in a terminal.",
  "viewer.config.dataRootUpdatedRestartRequired":
    "Data root updated. Restart {host} to apply.",
  "viewer.config.dataRootUpdateFailed": "Update failed: ${error}",
  "viewer.config.dataRootRejectEmpty": "Path cannot be empty.",
  "viewer.config.dataRootRejectNonEngram":
    "Directory is non-empty and not a co-engram warehouse. Pick an empty dir or an existing co-engram warehouse; to force-takeover a non-empty dir, use CLI: <code>co-engram config data-root &lt;path&gt; --force</code>.",
  // 首次设置 / non-engram 二次确认 UX(UI 弹此 banner 代替硬拒绝,免去走 CLI)
  "viewer.config.dataRootNonEngramConfirmTitle":
    "This directory already has files",
  "viewer.config.dataRootNonEngramConfirmBody":
    "co-engram will only create a <code>.co-engram/</code> subfolder inside <code>{path}</code>; your existing files will not be touched.",
  "viewer.config.dataRootNonEngramExistingList":
    "Existing items ({count}): {files}",
  "viewer.config.dataRootNonEngramMore": "…and ${count} more",
  "viewer.config.dataRootTakeOver": "Take over this directory",
  "viewer.config.dataRootTakeOverConfirm":
    "Take over <code>{path}</code>? co-engram will add a <code>.co-engram/</code> subfolder; existing files stay untouched.",
  "viewer.config.dataRootCancelled": "Takeover cancelled.",
  // 首次用户引导(dataRoot=null 时显示)
  "viewer.config.dataRootWelcomeTitle":
    "Welcome — set your team memory location",
  "viewer.config.dataRootWelcomeBody":
    "co-engram stores team memory in a folder you choose. Pick one of the common locations below, or type any path. co-engram will create a <code>.co-engram/</code> subfolder; existing files in the directory are not touched.",
  "viewer.config.dataRootWelcomeSuggestHome": "Use ~/team-memory (recommended)",
  "viewer.config.dataRootWelcomeSuggestHidden": "Use ~/.co-engram-data",
  "viewer.config.dataRootWelcomeCustom": "Or type a custom path:",
  "viewer.config.saveBar.reset": "Reset changes",
  "viewer.config.saveBar.save": "Save all changes",
  "viewer.config.saveSuccess": "✓ Configuration saved.",
  "viewer.config.saveSuccessWithRestart":
    "✓ Configuration saved. The following changes require restarting ${host} to take effect:",
  "viewer.config.restartBtn": "Restart now",
  "viewer.config.restartConfirmTitle": "Confirm restart of ${host}?",
  "viewer.config.restartConfirmBody":
    "  • Tools will briefly disconnect (auto-reconnect within seconds)\n  • Browser will lose connection; this page auto-refreshes when the service returns\n  • Saved configuration and engram data will not be lost",
  "viewer.config.restartOpenclawHint":
    "OpenClaw mode does not support auto-restart from the viewer. Run <code>openclaw gateway restart</code> in a terminal.",
  "viewer.config.restartMask.title": "⟳ Restarting ${host}…",
  "viewer.config.restartMask.body":
    "The service is exiting and will be relaunched by ${parent}. This page will auto-refresh once it returns.",
  "viewer.config.restartTimeout.title": "Restart timed out (30s)",
  "viewer.config.restartTimeout.body":
    "Please refresh the page manually; if ${host} is still down, check ${parent} status.",
  "viewer.config.restartTimeout.refreshBtn": "Refresh manually",
  "viewer.config.restartBtnTip":
    "Click to gracefully exit ${host} (exit code 0); the parent process ${parent} will auto-restart it.\n\nImpact:\n  • Tools briefly disconnect (auto-reconnect in seconds, no impact on ongoing conversations)\n  • Browser disconnects; this page auto-refreshes when the service returns\n  • Background tasks (maintenance thread, proposal engine, etc.) restart with the new config\n\nNot lost:\n  • Saved configuration (just written to config.json)\n  • Existing engram / synapse data (persisted on disk)\n  • Current conversation history (held by ${parent}, independent of service restart)",
  "viewer.config.pendingField.language": "Language",
  "viewer.config.pendingField.toolsProfile": "Tools profile",
  "viewer.config.pendingField.defaultCreatedBy": "Default creator",
  "viewer.config.pendingField.audit": "Audit log",
  "viewer.config.pendingField.proposals": "Proposal engine",
  "viewer.config.pendingField.maintenance": "Maintenance engine",

  // ===== Common strings (viewer.common.*) =====
  "viewer.common.loading": "Loading...",
  "viewer.common.loadFailed": "Load failed: ${err}",
  "viewer.common.empty": "No data yet",
  "viewer.common.save": "Save",
  "viewer.common.cancel": "Cancel",
  "viewer.common.edit": "Edit",
  "viewer.common.delete": "Delete",
  "viewer.common.close": "Close",
  "viewer.common.reset": "Reset",
  "viewer.common.preview": "Preview",
  "viewer.common.previewMode": "Preview mode",
  "viewer.common.editMode": "Edit mode",
  "viewer.common.enabled": "On",
  "viewer.common.disabled": "Off",
  "viewer.common.enabledState": "Enabled",
  "viewer.common.disabledState": "Disabled",
  "viewer.common.restartToApply": "Applies after restart",
  "viewer.common.confirmDeleteTitle": "Confirm delete?",
  "viewer.common.confirmDeleteEngram":
    'Delete "${title}"?\nThis action is irreversible.',
  "viewer.common.confirmDeleteSynapse":
    "Delete this synapse?\nThis action is irreversible.",
  "viewer.common.saveFailed": "Save failed: ${err}",
  "viewer.common.restoreBtn": "Restore",
  "viewer.engram.restoreConfirm": "Restore this memory? This clears the forgotten lock and re-enters default retrieval.",
  "viewer.skill.restoreConfirm": "Restore this skill? This resets the last-used time; retention stage returns to active.",
  "viewer.common.deleteFailed": "Delete failed: ${err}",
  "viewer.common.unknown": "(unknown)",
  "viewer.common.langZh": "中文",
  "viewer.common.langEn": "English",

  // ===== Help panel (viewer.help.*) =====
  "viewer.help.title": "Co-Engram · Self-evolving team memory",
  "viewer.help.pageTitle": "Help",
  "viewer.help.pageSub": "Co-Engram Viewer guide",
  "viewer.help.whatTitle": "What is this page",
  "viewer.help.kbdTitle": "Keyboard shortcuts",
  "viewer.help.kbdSearch": "focus search",
  "viewer.help.kbdEsc": "back / close drawer / reset graph focus",
  "viewer.help.refTitle": "Learn more",
  "viewer.help.refIntro": "Deep reference (click to expand a section):",
  "viewer.help.moreTitle": "Operations & collaboration",
  "viewer.help.tabDreams": "Memory Dreams: nightly maintenance report",
  "viewer.help.intro":
    "Co-Engram distills team conversations, decisions and lessons into <em>engrams</em> and links them with <em>synapses</em> into an evolvable knowledge network. Models recall relevant memories via <code>memory_search</code>, reinforce effective ones with <code>engram_reinforce</code>, and weaken broken ones with <code>engram_report_failure</code> — this closed loop lets high-value memories surface and stale ones decay automatically.",
  "viewer.help.conceptsTitle": "Core concepts",
  "viewer.help.graphTitle": "Reading the Synapses (graph) tab",
  "viewer.help.graphDesc":
    "Node size = importance, colored by kind by default (switch to retrieval count / contradiction highlight / retrieval recency in the function bar above the stage); Louvain community detection draws breathing cluster hulls. Functional filters — search, path, status, importance threshold — live in the bar above the stage; the bottom slider replays the graph growing over creation time (combines with the threshold); 🌙 toggles the night canvas. Click a node to view its neighborhood (edges flow, non-neighbors fade; Esc returns).",
  "viewer.help.conceptEngram": "<strong>Engram</strong>",
  "viewer.help.conceptEngramDesc":
    "A structured memory entry with fields like title/content/kind/tags/importance/confidence. 5 kinds: <code>fact</code> <code>observation</code> <code>pattern</code> <code>procedure</code> <code>hypothesis</code>. Hover a field to see its description.",
  "viewer.help.conceptSynapse": "<strong>Synapse</strong>",
  "viewer.help.conceptSynapseDesc":
    "An edge between two engrams, grouped into 5 families: <code>structural</code> (extends/part_of/similar_to), <code>causal</code> (depends_on/causes/follows), <code>evidential</code> (derives_from/contradicts/exemplifies), <code>temporal</code> (supersedes/consolidates), <code>modulatory</code> (contextualizes). Most kinds are directional; <code>similar_to</code> / <code>contradicts</code> are symmetric (endpoints have no direction). <code>contradicts</code> enters the resolution flow.",
  "viewer.help.conceptImportance": "<strong>Importance & confidence</strong>",
  "viewer.help.conceptImportanceDesc":
    "Two independent 0-1 numbers. Importance is derived from reinforcement signals + time decay and affects retrieval weight; confidence reflects how trustworthy the memory is (a metacognition score) and is decoupled from importance.",
  "viewer.help.conceptVector": "<strong>Concept vector</strong>",
  "viewer.help.conceptVectorDesc":
    "A numeric vector produced by an embedding model for each engram, used for semantic similarity. Retrieval recalls by cosine similarity; conversation-flow clustering groups messages by similarity and promotes to a proposal once the threshold is met.",
  "viewer.help.conceptLifecycle": "<strong>Lifecycle</strong>",
  "viewer.help.conceptLifecycleDesc":
    "<code>draft → active → frozen → forgotten</code>. Forgotten files remain in the repo but are skipped by default retrieval. Maintenance cycles evaluate and transition states automatically.",
  "viewer.help.rulesTitle": "Reinforcement rules & default parameters",
  "viewer.help.rulesIntro":
    "Memory importance evolves with use feedback. Below are the real defaults (per-event deltas are governed by importance/dynamics.ts; other knobs live in ReinforcementConfig.DEFAULT_CONFIG / DEFAULT_WEIGHTS / DEFAULT_EFFECTIVENESS_WINDOWS / DEFAULT_VERIFICATION_CONFIG in source); override via config.json or the matching config keys.",
  "viewer.help.ruleLtp":
    "<strong>LTP (Long-Term Potentiation)</strong>: per effective retrieval (effective=1), importance += <code>0.1</code> (<code>dynamics.updateOnReinforce</code>). ~5 effective retrievals raise 0.5 to 1.0.",
  "viewer.help.ruleLtd":
    "<strong>LTD (Long-Term Depression)</strong>: per failed use, importance -= <code>0.1</code> (<code>dynamics.updateOnReportFailure</code>, fixed penalty). Cumulative failures reaching <code>archiveThreshold</code> (default <code>3</code>) suggest archive; reaching <code>forgetThreshold</code> (default <code>5</code>) suggest forget.",
  "viewer.help.ruleHebbian":
    "<strong>Hebbian neighbor spread</strong>: when a memory is reinforced, direct neighbors (via synapse) gain <code>importanceDelta × hebbianRatio</code> (default <code>hebbianRatio = 0.5</code>); contradicts edges excluded.",
  "viewer.help.ruleWeights":
    "<strong>Five-factor retrieval weights</strong>: score = α·relevance + β·recency + γ·importance + δ·strength + ε·hotness (defaults α=0.5 / β=0.15 / γ=0.25 / δ=0.05 / ε=0.05). recency follows Ebbinghaus half-life <code>0.5^(ageDays / deriveHalfLifeDays(importance))</code>, derived from importance (mechanism D). hotness (access heat) = <code>sigmoid(ln(1+retrievalCount)) × 0.5^(daysSinceLastRetrieval/7)</code> — boosts ranking by access frequency and recency without explicit reinforcement; tune via config.json <code>search.scoring.hotness</code> (set 0 to disable) and <code>search.scoring.hotnessHalfLifeDays</code> (default 7).",
  "viewer.help.ruleWindows":
    "<strong>Observation window</strong>: opened when an engram is retrieved; reinforce within window → effective (LTP); report failure → failed use (LTD); expiry closes the hit as inconclusive. Default length by kind: observation 6h / fact 24h / pattern 48h / procedure 48h / hypothesis 7d. Multi-kind uses max.",
  "viewer.help.stateMachineTitle": "Verification state machine (5 levels)",
  "viewer.help.stateMachineIntro":
    "Memory credibility: unverified → plausible → probable → verified → refuted. Default upgrade conditions below; downgrade driven by LTD and cumulative failures. Refuted memories are excluded from retrieval by default.",
  "viewer.help.stateUnverified":
    "<strong>unverified</strong> (default): new memories start here.",
  "viewer.help.statePlausible":
    "<strong>plausible</strong>: at least <code>1</code> evidence (derives_from synapse).",
  "viewer.help.stateProbable":
    "<strong>probable</strong>: at least <code>2</code> evidence from ≥2 distinct domainTags.",
  "viewer.help.stateVerified":
    "<strong>verified</strong>: at least <code>3</code> evidence, ≥2 domains, and created ≥ <code>7</code> days ago (temporal stability).",
  "viewer.help.stateRefuted":
    "<strong>refuted</strong>: marked as the losing side by contradiction_resolve; excluded from retrieval by default.",
  "viewer.help.tabsTitle": "Tabs",
  "viewer.help.tabStats":
    "<strong>Overview</strong> — core KPIs (engrams/synapses/skills/retrievals with weekly deltas) + 30-day memory pulse + memory activity feed (audit timeline) + right-column TOP cards (domain heat / retrieval hotspots / cooling memories / contributors; click a card to expand TOP 20). Top search box does full-text search. Navigation lives in the left sidebar: frequent entries on top, governance in the middle, health/merge/config/help collapsed into the bottom icon row.",
  "viewer.help.tabEngrams":
    "<strong>Engrams</strong> — card/tree view of all engrams with tag/kind/status/visibility/freshness (this week / this month / dormant 30d-unused) filters. Cards carry kind/visibility/verification badges, a summary, creator, retrieval and synapse counts, and an importance trend glyph (▲ recently retrieved · ▼ dormant decay · ▬ steady); click to open detail (edit/delete/show synapses). Tree view is a single tree rooted at the library root, folder rows show cumulative counts and average importance; click a row to expand/collapse, with expand/collapse-all at the top.",
  "viewer.help.tabSkills":
    "<strong>Skills</strong> — procedural-memory cards: browse by acquisition stage (draft/compiled/tuned) and retention stage (active/aging/stale/forgotten); shows utility, invocation counts and compose links. Skill directories detected under dataRoot enter the proposals queue for approval first.",
  "viewer.help.tabGraph":
    "<strong>Graph</strong> — knowledge-graph visualization. Filter edges by family/kind, nodes by engram kind; functional filters (search / path / status / importance threshold / node coloring) live in the bar above the stage; Louvain hulls mark community structure; 🌙 toggles the night canvas; click a node to view its neighborhood (edges flow, non-neighbors fade; Esc returns). See \"Reading the Synapses (graph) tab\" above.",
  "viewer.help.tabProposals":
    "<strong>Proposals</strong> — candidate-memory approval queue. Sources: conversation clustering (topics mentioned ≥3 times), Claude Code auto-memory files, and untracked .md detected under dataRoot (e.g., files copied in by the user). Humans/LLMs accept (engram_accept_proposal) or dismiss (engram_dismiss_proposal).",
  "viewer.help.tabAudit":
    "<strong>Audit</strong> — operation timeline recording create/update/reinforce/report_failure and every state change, for 'who changed what when' traceability.",
  "viewer.help.tabTrash":
    "<strong>Trash</strong> — staging for deleted engrams. Restore one, or purge all (filter by partition; dryRun count + double confirmation before permanent delete).",
  "viewer.help.tabConfig":
    "<strong>Config</strong> — data root, maintenance cycles, evolution parameters. Persisted edits take effect after restarting the host.",
  "viewer.help.evolutionTitle": "How memories evolve",
  "viewer.help.evo1":
    "<strong>Retrieve</strong>: the agent calls <code>memory_search</code>; FTS + 3-factor scoring recall top-N.",
  "viewer.help.evo2":
    "<strong>Cite</strong>: the agent writes relevant memory content into its answer; the user decides accordingly.",
  "viewer.help.evo3":
    "<strong>Reinforce</strong>: the agent judges whether the citation was effective — <code>engram_reinforce</code> if effective, <code>engram_report_failure</code> if not.",
  "viewer.help.evo4":
    "<strong>Spread</strong>: reinforcement propagates through synapses to neighbors by Hebbian proportion (except contradicts).",
  "viewer.help.evo5":
    "<strong>Decay</strong>: half-life is derived from <code>engram.importance</code> in real time (<code>deriveHalfLifeDays</code>); importance decays exponentially by lastEffectiveAt + half-life.",
  "viewer.help.evo6":
    "<strong>Maintenance</strong>: background cycles run light/deep/rem phases — 'consolidate reinforcement → decay & forget → REM abstract patterns → trigger metacognition scoring'. REM's upgrade / refute / pattern-abstraction / synapse operations (add/remove/retype) outputs appear as proposals on the Proposals page and take effect only after you approve them.",
  "viewer.help.tipsTitle": "Tips",
  "viewer.help.tip1":
    "The <code>?</code> icon next to field names (hover) gives a short description of that field.",
  "viewer.help.tip2":
    "Detail-view sections like 'value assessment / importance vector / source context' appear only when the engram carries the corresponding fields.",
  "viewer.help.tip3":
    "Config-tab edits write to the persisted file by default and take effect after restarting the host. Edit the data root directly in the Config tab, or via CLI <code>co-engram config data-root &lt;path&gt;</code> (the latter supports <code>--force</code> to take over a non-empty directory).",
  "viewer.help.tip4":
    "On repository inconsistency, call <code>engram_doctor</code> from the agent for a self-healing scan.",
  "viewer.help.tip5":
    "Numeric fields like <code>importance</code> / <code>effectiveness</code> / <code>reinforcementScore</code> show a band label (high / medium / low; thresholds ≥0.7 / ≥0.3 / <0.3) next to the raw 2-decimal value. The band is language-neutral in storage; the UI localizes it.",
  "viewer.help.tip6":
    'In the Proposals tab, "Dismiss all" and "Purge" are two different operations: <strong>dismiss</strong> marks candidates as dismissed (soft delete; proposals.json retains them; audit-traceable), while <strong>purge</strong> physically deletes all dismissed candidates from disk (irreversible; audit log retained). The counts on status buttons 「Accepted (N) / Dismissed (N) / All (N)」 reflect the live proposal-store composition.',
  "viewer.help.tip7":
    "The \"Open directory\" button at the top-right of the detail view opens the engram's physical folder in your system file manager, handy for browsing sibling memories in Obsidian. <strong>Note</strong>: this is a read-only browsing entry; if you bulk-edit the <code>.md</code> files manually afterwards, run <code>engram_doctor</code> from the agent to self-heal index / FTS drift. Under SSH-forwarded or container environments the file manager can't be launched, so the directory path is shown for copying instead.",

  // ===== Memory visibility =====
  "viewer.help.visibilityTitle": "Memory visibility & risk recognition",
  "viewer.help.visibilityBody":
    "Every memory has a <code>visibility</code> field: <strong>public</strong> (default, enters team repo), <strong>team</strong> (team-visible), <strong>private</strong> (local-only; <code>private/</code> subfolder is gitignored, never committed), <strong>restricted</strong> (policy-limited). List / detail / proposal forms all show a badge and picker; the detail page has a one-click switcher (co-engram migrates the file path atomically and preserves stableId). <strong>LLM risk recognition</strong>: before calling <code>engram_create</code> / <code>engram_accept_proposal</code> / <code>engram_update</code>, if content contains credentials (API key, password, JWT, private key), personal identity, intranet info, business-sensitive data, or a username in an absolute path, the LLM will proactively ask whether to set <code>private</code>. The principle is <strong>better to over-ask than under-detect</strong> — one redundant ask costs far less than one credential leak.",

  // ===== Ports & data root =====
  "viewer.help.opsTitle": "Ports & data root",
  "viewer.help.opsPorts":
    "<strong>Viewer port</strong>:both hosts (Claude Code MCP / OpenClaw plugin) share a single default <code>18899</code> since <code>2026-07</code> — bookmark one URL regardless of which host is the current holder. Env <code>CO_ENGRAM_VIEWER_PORT</code> overrides (use it when running two separate dataRoots). The persisted <code>viewer.port</code> is deprecated (both hosts share the persisted file and would race on the same port). Legacy host-specific defaults (MCP=18799 / OpenClaw=18899) are deprecated; users on the old ports should update bookmarks to <code>18899</code>.",
  "viewer.help.opsDataRoot":
    "<strong>Data root</strong>:the Config tab shows a welcome card on first open — click <code>~/team-memory</code> or <code>~/.co-engram-data</code> for a one-click setup, or type any custom path. If the directory already has files, the UI lists them and asks for confirmation — co-engram only creates a <code>.co-engram/</code> subfolder; your existing files stay untouched. CLI alternative: <code>co-engram config data-root &lt;path&gt;</code> (add <code>--force</code> to skip confirmation). Restart the current host to apply.",

  // ===== Tool profiles =====
  "viewer.help.profilesTitle": "Tool profiles",
  "viewer.help.profilesBody":
    "<strong>Three profiles</strong> scale the LLM tool surface by use case. Per-tier counts live in <code>PROFILE_TOOL_COUNTS</code> in source (computed via <code>.size</code>, cannot drift). <strong>minimal</strong>: core read/write + proposal triage + <code>engram_sync</code> — chat agents that just recall and record. <strong>standard (default)</strong>: adds learning loop, contradiction resolution, self-healing (<code>engram_doctor</code>), progressive disclosure (<code>engram_list_paths</code>), LLM synthesis (<code>engram_synthesize</code>), and audit query (<code>engram_audit_query</code>), plus batch proposal triage (<code>engram_accept_proposals_by_source</code> / <code>engram_dismiss_proposals_by_filter</code>). <strong>full (all tools)</strong>: all native tools. Switch via env <code>CO_ENGRAM_TOOLS_PROFILE=minimal|standard|full</code>; invalid values warn and fall back to standard.",

  // ===== Save & sync =====
  "viewer.help.syncTitle": "Save and sync to remote",
  "viewer.help.syncBody":
    "Memories mark the repo dirty on write; the host commits at appropriate moments. <strong>Want explicit control?</strong> Have the agent invoke the <code>engram_sync</code> tool: it runs <code>git fetch</code> + <code>pull --rebase --autostash</code> to merge remote first, then <code>commit</code>s local changes, then <code>push</code>es (auto-degrades to commit-only when no remote is configured). Conflicts are reported, not auto-resolved — the tool lists conflicting files for you to decide. <strong>Works across corporate and public git hosts</strong>: invokes system <code>git</code> directly, inheriting your local SSH/credentials/proxy; no hardcoded host or URL; does not write Gerrit <code>Change-Id</code> (the commit-msg hook adds it automatically if installed); respects your <code>.git/config</code> push settings. A <code>.gitignore</code> excluding the <code>.co-engram/</code> cache directory is auto-created on first sync. Use <code>dryRun=true</code> to preview uncommitted changes.",

  // ===== Obsidian integration =====
  "viewer.help.obsidianTitle": "Obsidian integration (graph view)",
  "viewer.help.obsidianBody":
    "Open the data root directly as an <strong>Obsidian vault</strong>. Whenever a synapse (<code>extends</code> / <code>similar_to</code> / <code>contradicts</code>, etc.) is created or changed, a derived wikilinks section is appended to the body of every touched engram: <code>→ [[filename|title · kind]]</code> (outgoing) and <code>← [[filename|title · kind]]</code> (incoming). The wikilink <strong>target is the filename</strong> (Obsidian resolves it natively — no frontmatter aliases needed); the <strong>display shows the target engram's title plus the kind</strong>, so the relationship is readable without navigation. <code>contradicts</code> edges are pinned to the top of the derived section. The authoritative source remains <code>synapses/*.yaml</code>; the derived section is a denormalized view that can always be rebuilt from yaml. <strong>Graph looks wrong?</strong> Run <code>engram_doctor</code> — it checks every engram's derived section against the authoritative source and regenerates any drift (idempotent; a clean repo reports zero fixes).",

  // ===== Skill memory (viewer.help.skill.*) =====
  "viewer.help.skillTitle": "Skill memory (procedural memory)",
  "viewer.help.skillIntro":
    "<strong>Skill memory</strong> is Co-Engram's <strong>procedural memory</strong> system — corresponding to 'knowing-how' in human memory, complementing engram's 'knowing-what' (declarative memory). Its scientific roots come from the <strong>ACT-R cognitive architecture</strong>, using a <strong>utility-retention-Options triplet</strong> to capture skill acquisition and usage.",
  "viewer.help.skill.conceptEngramVsSkill":
    "<strong>engram vs skill</strong>: engrams record static knowledge (facts, patterns, procedures); skills record callable dynamic capabilities (parameterized templates, inference chains). engrams are nouns; skills are verbs — when an agent needs to execute an action sequence, it calls <code>skill_invoke</code> with parameters; the skill returns execution results.",
  "viewer.help.skill.lifecycle":
    "<strong>Lifecycle</strong>: <code>detection (proposal) → accept (persist) → invoke (use) → decay → forgotten</code>. <code>detection</code>: scan <code>SKILL.md</code> directories and generate candidate proposals. <code>accept</code>: create Skill entity with acquisitionStage=draft, retentionStage=active. <code>invoke</code>: record usage count, update utility via <strong>Rescorla-Wagner rule</strong> (up on success, down on failure). <code>decay</code>: light maintenance cycles recalculate retention; persistently low utility drops retention from active to aging/stale. <code>forgotten</code>: long-unused or extremely low utility skills auto-forget.",
  "viewer.help.skill.acquisition":
    "<strong>Acquisition depth axis (acquisitionStage)</strong>: <code>draft (raw) → compiled (built) → tuned (refined)</code>. <code>draft</code>: newly accepted proposal, not yet fully validated. <code>compiled</code>: after a threshold of successful calls with stable high utility, enters compilation phase (ACT-R production compilation, from explicit reasoning to internalized pattern). <code>tuned</code>: long-term high-frequency usage with stable performance, manually or auto-optimized to expert level. Stage transitions are manual (or auto in future versions), reflecting the learning curve from 'conscious execution' to 'automatic'.",
  "viewer.help.skill.utility":
    "<strong>utility</strong>: 0-1 range, reflecting expected benefit of invoking the skill. Initial value 0.5. Each successful call (returning effective results) increases utility via Rescorla-Wagner; failures decrease it. High-utility skills are prioritized in同类 skill competition. Utility decays over Ebbinghaus curve — unused skills' utility automatically drops.",
  "viewer.help.skill.retention":
    "<strong>retention</strong>: reflects memory strength for the skill, 4 levels: <code>active (strong)</code>: recently used frequently, high retention. <code>aging (weakening)</code>: starting to forget but still recallable. <code>stale (weak)</code>: low retention, may need relearning. <code>forgotten (gone)</code>: removed from default skill pool, needs manual reactivation.",
  "viewer.help.skill.composes":
    "<strong>composes (skill chaining)</strong>: skills can declare dependencies on other skills, forming <code>Skill Chaining</code>. For example, a 'deploy' skill may compose three sub-skills: 'test', 'build', 'deploy'. Calling the parent skill automatically invokes sub-skills in dependency order, enabling complex task decomposition and reuse. Compose relationships are declared via the <code>composes</code> field.",
  "viewer.help.skill.sidecar":
    "<strong>sidecar storage</strong>: skill usage traces (call history, utility evolution, parameter patterns, etc.) are stored in <code><skill-dir>/.co-engram/imprint.json</code>, separate from <code>SKILL.md</code>. imprint.json is auto-maintained by the system; users should not edit manually — it preserves the full time series for utility calculation and retention decay. <code>SKILL.md</code> only holds the skill definition (inputs/outputs/parameters/examples), maintained by users. This separation decouples skill content from usage history, avoiding Git merge conflicts from imprint data.",
  "viewer.help.skill.d11":
    "<strong>D11 distribution rule</strong>: when a skill from team-memory repo is distributed to a host working directory, if the host already has a skill with the same name, the <strong>local skill takes priority</strong> and is not overwritten. The principle is 'local-first' — the working directory's skill is the version currently in use by the user; even if remote has updates, local edits are preserved. To sync remote changes, users must manually merge or explicitly accept the remote version. This prevents accidental overwrites of locally tuned skills and protects user personalization.",

  // ===== Graph panel (viewer.graph.*) =====
  "viewer.graph.renderFailed": "Render failed: ${err}",
  "viewer.graph.visLoadFailed": "vis-network failed to load",
  "viewer.graph.empty": "No engrams yet",
  "viewer.graph.tagsLabel": "tags:",
  "viewer.graph.familySuffix": " family",
  "viewer.graph.weightLabel": "weight",
  "viewer.graph.evidenceLabel": "evidence",
  "viewer.graph.resolutionLabel": "resolution:",
  "viewer.graph.directionLabel": "direction:",
  "viewer.graph.clickToEdit": "click to edit this synapse",
  "viewer.graph.nodeDetailTitle": "Node detail",
  "viewer.graph.editInEngrams": "Edit in engrams",
  "viewer.graph.importanceShort": "importance",
  "viewer.graph.summaryTitle": "Summary",
  "viewer.graph.statsTitle": "Stats",
  "viewer.graph.retrievalLabel": "retrievals:",
  "viewer.graph.effectiveLabel": "effective:",
  "viewer.graph.failedLabel": "failed:",
  "viewer.graph.outgoingSynapses": "Outgoing synapses",
  "viewer.graph.incomingSynapses": "Incoming synapses",
  "viewer.graph.familyGroupStructural": "Structural",
  "viewer.graph.familyGroupCausal": "Causal",
  "viewer.graph.familyGroupEvidential": "Evidential",
  "viewer.graph.familyGroupTemporal": "Temporal",
  "viewer.graph.familyGroupModulatory": "Modulatory",
  "viewer.graph.toolbar.filters": "Filters",
  "viewer.graph.toolbar.kinds": "Node kinds",
  "viewer.graph.toolbar.synapseKinds": "Synapse kinds",
  "viewer.graph.toolbar.reset": "Reset view",
  "viewer.graph.toolbar.fit": "Fit to window",
  "viewer.graph.toolbar.physics": "Physics",
  "viewer.graph.toolbar.fitTitle":
    "Fit view: auto-zoom and center so every node is visible",
  "viewer.graph.toolbar.physicsTitle":
    "Physics engine: when on, nodes auto-layout via spring/repulsion model (uses CPU until stable); off freezes positions — useful for browsing large graphs after they settle",
  "viewer.graph.toolbar.resetTitle":
    "Reset filters: restore every kind/family checkbox and re-fit the view",
  "viewer.graph.synapseKindsTitle": "Synapse kinds · by family",
  "viewer.graph.engramKindsTitle": "Engram kinds",

  // ===== Synapses panel / synapse detail (viewer.synapses.*) =====
  "viewer.synapses.kindChangeHint":
    "Tip: changing 'kind' re-derives the synapse id (id is computed from from+to+kind); the old id becomes invalid, but all metadata (weight/evidence/creator) migrates to the new id.",
  "viewer.synapses.deleteConfirm":
    "Delete this synapse?\\nThis action cannot be undone.",
  "viewer.synapses.kindField": "Kind:",
  "viewer.synapses.idField": "ID:",
  "viewer.synapses.creatorField": "Created by:",
  "viewer.synapses.timeField": "Time:",
  "viewer.synapses.reloadingGraph": "Reloading graph...",
  "viewer.synapses.directionDefault": "directional",

  // ===== Host terminology (host.*) =====
  "host.label.mcp": "Claude Code",
  "host.label.openclaw": "OpenClaw",
  "host.process.mcp": "Claude Code",
  "host.process.openclaw": "OpenClaw",
  "host.gateway.openclaw": "OpenClaw gateway",
  "host.gateway.mcp": "MCP server",

  // ===== Tooltip strings (tip.*) =====
  "tip.stats.topTagsTip":
    "Top domain tags: counts how often each domainTag appears across active engrams, top 10. Each engram usually has multiple domainTags (many-to-many), so the sum of all tag counts exceeds the total engram count — this is expected, not a bug.",
  "tip.kind.fact":
    'Fact: a confirmed, independently verifiable objective statement. Example: "The project uses PostgreSQL 14".',
  "tip.kind.observation":
    'Observation: a one-off perceived fact, not yet distilled into a stable conclusion. Example: "CI took 12 minutes today".',
  "tip.kind.pattern":
    'Pattern: a rule归纳duced from repeated observations; can predict future behavior. Example: "Build times get longer every Monday morning".',
  "tip.kind.procedure":
    'Procedure: a sequence of steps that reproduces a result when executed. Example: "Run pnpm check before release".',
  "tip.acquisitionStage.draft": "Cognitive (draft): newly accepted, not yet validated. Maps to Fitts-Posner cognitive stage — high conscious load, error-prone.",
  "tip.acquisitionStage.compiled": "Associative (compiled): validated through use, pattern stable. Maps to associative stage — fewer errors, more consistent.",
  "tip.acquisitionStage.tuned": "Autonomous (tuned): thoroughly used + tuned, expert-level. Maps to autonomous stage — automatic, parallelizable.",
  "tip.retentionStage.active": "Active: recently used, strong retention, high recall weight.",
  "tip.retentionStage.aging": "Aging: unused for a while, beginning to decay.",
  "tip.retentionStage.stale": "Stale: long unused, about to be forgotten.",
  "tip.retentionStage.forgotten": "Forgotten: marked as forgotten, can be restored.",
  "tip.kind.hypothesis":
    'Hypothesis: an unverified guess; usable as a working hypothesis until counter-examples appear. Example: "Slow queries may stem from missing indexes".',
  "tip.status.active":
    "Active: recently retrieved or reinforced; high weight in the recall pool.",
  "tip.status.dormant":
    "Dormant: long unretrieved; weight has decayed but not forgotten.",
  "tip.status.forgotten":
    "Forgotten: actively forgotten by maintenance; file remains but excluded from default recall.",
  "tip.status.frozen":
    "Frozen: fully frozen state — no decay, no reinforcement, no synthesis, no retrieval. Data fully preserved, restorable to active via engram_restore. Renamed from archived (2026-07) to match the actual code behavior.",
  "tip.visibility.public": "Public: visible to everyone / every agent.",
  "tip.visibility.team": "Team: visible only within the same team.",
  "tip.visibility.private": "Private: visible only to the creator.",
  "tip.visibility.restricted":
    "Restricted: requires specific permissions to view.",
  "tip.sourceType.firsthand":
    "Firsthand: directly experienced / observed; highest credibility.",
  "tip.sourceType.secondhand":
    "Secondhand: relayed / documented / others' experience; needs cross-validation.",
  "tip.sourceType.inferred":
    "Inferred: induced from other memories; no direct evidence.",
  "tip.verification.unverified":
    "Unverified: newly created; has not yet passed metacognitive scoring.",
  "tip.verification.plausible":
    "Plausible: overall ≥ 0.4; passes initial check but uncertainty remains.",
  "tip.verification.probable":
    "Probable: overall ≥ 0.6; retrieved multiple times with no counter-examples.",
  "tip.verification.verified":
    "Verified: overall ≥ 0.8 or human-confirmed; safe to use as a decision basis.",
  "tip.verification.refuted":
    "Refuted: strong counter-examples exist or metacognitive score is very low; do not rely on it.",
  "tip.synapse.extends":
    "extends (structural): A extends B, inheriting its semantics and adding new dimensions.",
  "tip.synapse.part_of":
    "part_of (structural): A is a component of B (B has-a A).",
  "tip.synapse.similar_to":
    "similar_to (structural): A is semantically close to B; interchangeable or mutually supportive.",
  "tip.synapse.depends_on":
    "depends_on (causal): A's validity depends on B (B is a precondition of A).",
  "tip.synapse.causes":
    "causes (causal): A triggers or produces B (positive causation).",
  "tip.synapse.follows":
    "follows (causal): A follows B temporally/logically (no strong causation).",
  "tip.synapse.derives_from":
    "derives_from (evidential): A is derived from B (B is the basis).",
  "tip.synapse.contradicts":
    "contradicts (evidential): A conflicts with B; enters resolution flow.",
  "tip.synapse.exemplifies":
    "exemplifies (evidential): A is a concrete instance/sample of B.",
  "tip.synapse.supersedes":
    "supersedes (temporal): A replaces an outdated B (version transition).",
  "tip.synapse.consolidates":
    "consolidates (temporal): A merges/refines the content of B.",
  "tip.synapse.contextualizes":
    "contextualizes (modulatory): A provides context for B (neither causal nor evidential).",
  "tip.synapse.related_to":
    "related_to — legacy kind outside the 5 neuroscience-derived families; no longer recommended for new data. Use a concrete kind (similar_to / contextualizes / etc.) instead. Kept only for front-end display compatibility.",
  "tip.family.structural":
    "Structural: composition / extension relationships. Blue.",
  "tip.family.causal": "Causal: trigger / dependency relationships. Orange.",
  "tip.family.evidential":
    "Evidential: source / conflict relationships. Green (contradictions flagged red).",
  "tip.family.temporal": "Temporal: version / evolution relationships. Purple.",
  "tip.family.modulatory": "Modulatory: contextual relationships. Gray.",
  "tip.synapseDirection.directional":
    "Directional: A → B; the relation points only from source to target.",
  "tip.synapseDirection.bidirectional":
    "Bidirectional: A ↔ B; the relation applies symmetrically.",
  "tip.resolution.pending":
    "Pending: a contradiction has been detected, awaiting resolution.",
  "tip.resolution.auto_resolved":
    "Auto-resolved (phase 1): LLM produced an automatic verdict.",
  "tip.resolution.escalated":
    "Escalated (phase 2): escalated to the owner for resolution.",
  "tip.resolution.contested":
    "Contested (phase 3): no response within the timeout, with a warning attached.",
  "tip.resolution.resolved": "Resolved: closed, manually or automatically.",
  "tip.importance":
    "Importance: 0-1; higher values mean more weight in the recall pool. Derived from initial setting + reinforcement signals + decay.",
  "tip.confidence":
    "Confidence: 0-1; reflects how credible this memory is (independent of importance).",
  "tip.retrievalCount":
    "Retrieval count: total times this memory has been hit by search/recall.",
  "tip.effectiveRetrievals":
    "Effective retrievals: times the hit was actually adopted (not filtered out).",
  "tip.failedUses":
    'Failed uses: times the hit was reported as "invalid/outdated". Too many failures trigger forgetting.',
  "tip.reinforcementScore":
    "Reinforcement score: cumulative positive reinforcement signal.",
  "tip.lastEffectiveAt":
    "Last effective at: timestamp of the most recent successful adoption/reinforcement.",
  "tip.evidenceCount":
    "Evidence count: verdict evidence accumulated via verification upgrades (upgrade_verification). Only counts [plausible/probable/verified/refuted]-prefixed entries on derives_from synapses; evidence carried by other synapse kinds (extends/exemplifies/causes etc.) is not included.",
  "tip.encodingContext":
    "Encoding context: background description when the memory was created; used for context-dependent recall.",
  "tip.perspective":
    "Perspective: observation viewpoint identifier (multi-perspective retention mechanism, spec §5.3).",
  "tip.freshness.fresh":
    "Fresh: ageDays ≤ halfLife; recently reinforced, top weight in the recall pool.",
  "tip.freshness.aging":
    "Aging: halfLife < ageDays ≤ halfLife×2; weight dropping, reinforce soon.",
  "tip.freshness.stale":
    "Stale: halfLife×2 < ageDays ≤ halfLife×4; long unreinforced, candidate for forgetting.",
  "tip.freshness.forgotten":
    "Forgotten: ageDays > halfLife×4; removed from default recall pool (file retained, recoverable via Git).",
  "viewer.skill.loading": "Loading skills",
  "viewer.skill.loadFailed": "Load failed: ${err}",
  "viewer.skill.openDir": "Open directory",
  "viewer.skill.openDirOpened": "Opened the directory containing this skill",
  "viewer.skill.openDirFailed": "Failed to open directory: ${err}",
  "viewer.skill.openDirCopy": "Copy path",
  "viewer.skill.openDirCopied": "Copied",
  "viewer.skill.openDirCopyFailed": "Copy failed",
  "viewer.skill.openDirReason.no-desktop": "No desktop environment (SSH / container / headless) — can't launch the file manager. Copy the path below to locate it manually:",
  "viewer.skill.openDirReason.spawn-failed": "File manager command not found. Copy the path below to locate it manually:",
  "viewer.skill.openDirReason.dir-not-found": "This skill's directory no longer exists (may have been moved externally). Original path:",
  "viewer.skill.openDirReason.fallback": "Could not open the directory. Copy the path below to locate it manually:",
  "skills.searchPlaceholder": "Search skill ID or source path",
  "skills.filter.acquisitionStage": "Acquisition Stage",
  "skills.filter.retentionStage": "Retention Stage",
  "skills.filter.allStages": "All Stages",
  "skills.filter.allRetentionStages": "All Retention Stages",
  "skills.filter.sort": "Sort",
  "skills.filter.sortNewest": "Newest Created",
  "skills.filter.sortOldest": "Oldest Created",
  "skills.filter.sortUtility": "Utility",
  "skills.filter.sortInvocations": "Invocations",
  "skills.empty": "No skills found",
  "skills.pager.prev": "Previous",
  "skills.pager.next": "Next",
  "skills.pager.pageInfo": "Page {{current}} / {{total}} ({{itemTotal}} total)",
  "skills.pager.loadingHint": "Loading in background",
  "skills.utility": "Utility",
  "skills.successCount.tip": "Success count",
  "skills.failureCount.tip": "Failure count",
  "skills.invocationCount.tip": "Invocation count",
  "skills.initiationSet": "Description",
  "skills.sourcePath": "Source path",
  "skills.allowedTools": "Allowed tools",
  "skills.license": "License",
  "skills.version": "Version",
  "skills.compatibility": "Compatibility",
  "skills.sourceIcon.openclaw": "OpenClaw skill (declared in compatibility)",
  "skills.sourceIcon.claude": "Claude skill (declared in compatibility)",
  "skills.sourceIcon.generic": "Generic skill (compatibility does not declare Claude/OpenClaw; cross-runtime)",
  "skills.composes.tip": "Number of composed sub-skills",
  "skills.composesInto": "composes into → ${first}",
  "skills.relatedEngrams": "Related engrams (procedural ↔ declarative)",
  "skills.relatedCount": "related memories ×${n}",
  "skills.successCountN": "success ${n}",
  "skills.failureCountN": "failure ${n}",
  "skills.successCount": "Success",
  "skills.failureCount": "Failure",
  "skills.invocationCount": "Invocations",
  "skills.successRate": "Success rate",
  "skills.successRate.tip": "successCount / (success + failure)",
  "skills.lowConfidence": "Low sample",
  "skills.lowConfidence.tip": "invocations < 3, utility is unreliable",
  "skills.decayRisk": "Decay risk",
  "skills.decayRisk.soonAging": "Unused for {days} days, about to decay",
  "skills.decayRisk.aging": "Aging, use soon to reinforce",
  "skills.decayRisk.stale": "Stale, consider review or forget",
  "skills.decayRisk.forgotten": "Forgotten (restorable)",
  "viewer.skill.detailTitle": "Skill Detail",
};
