# Multi-Agent Operating Model

> Component of the project handoff (the handoff's former §7, extracted verbatim 2026-09-22 —
> subsection numbering 7.1–7.6 preserved so existing "§7.x" references stay valid). The
> [project handoff](../handoff.md) and every queue file cite this document. Stable process — change rarely,
> with a changelog entry in the handoff.

This repository is designed to be worked by multiple agent sessions (or humans) without collisions. Three roles; a single agent may play one role per task — **never both implement and approve the same change**.

### 7.1 Roles

| Role                                     | Responsibilities                                                                                                                                             | Must                                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Orchestrator** (1 per session batch)   | Read this handoff + roadmap §3–§5; pick/queue tasks from §6; dispatch to workers; integrate results; update roadmap checkboxes, §2 state table, §9 changelog | own shared files (roadmap, handoff, CHANGELOG, root configs); enforce gates; not write feature code itself                                 |
| **Worker** (N, parallel)                 | Implement exactly **one** task from §6 within its package boundary; run the full gate suite; leave a Conventional Commit + changeset; report evidence        | stay inside the task's package column; not edit shared files (propose instead); not re-decide ledger items; check task-relevant ADRs first |
| **Reviewer** (independent of the worker) | Apply the §7.3 checklist to a completed task; verdict **approve** or **request-changes** (with specific items)                                               | be a different session/agent than the worker; verify by running commands, not by reading diffs alone                                       |

### 7.2 Task protocol (state machine)

```text
claim (orchestrator assigns, marks in-progress)
  → execute (worker: implement + self-verify all gates)
    → review (reviewer: §7.3 checklist; request-changes loops back to worker)
      → integrate (orchestrator: merge/commit, update roadmap + handoff §2/§9, close task)
```

- Claimed/completed state lives in the roadmap checkboxes + commit messages (`feat(m1-2): …` — prefix tasks with their §6 number).
- A task is **not done** until the reviewer approves and the orchestrator integrates.

### 7.3 Reviewer checklist (per task)

**Sync note:** [`AGENTS.md`](../../../AGENTS.md) "Hard rules" is authoritative; this checklist paraphrases it — update both together.

- [ ] All gates green with pasted command evidence (`lint/typecheck/test/build`; e2e if web-visible).
- [ ] Conventional Commit; changeset present if any package changed.
- [ ] No new `any` without an explanatory comment; `pnpm format:check` clean.
- [ ] Dependency direction intact: `domain` stays pure (no React/browser/engine imports); no package imports apps; `pipeline` free of dbt/SQLMesh/Dagster runtimes.
- [ ] ADR-conflict scan: nothing contradicts accepted ADRs; any new durable decision comes with a Proposed ADR.
- [ ] Privacy/telemetry: no dataset contents, filenames-where-sensitive, SQL results, or PII in any new telemetry/logging.
- [ ] Tests assert meaningful behavior (no stub-only or trivially-true tests); dataset-shape fixes include a golden fixture + regression test.
- [ ] Docs touched where the change alters described behavior.

### 7.4 Parallelism & conflict rules

- One worker per **package boundary** (the §6 "Package" column) at a time; `web` tasks serialize against anything that touches `grid`/`engine` APIs they consume.
- Shared files (§7.1 orchestrator-owned list) are never edited by workers.
- If a task discovers it must cross its boundary, it stops and reports to the orchestrator, who splits/reassigns.
- **Parallel-batch recipe (proven, m1-5/m1-8 and m1-6/m1-7):** for tasks with disjoint package columns, give each worker its own git worktree on a task branch (`git worktree add -b <task-id> ../<repo>-<task-id> main`); the e2e ports are env-overridable (`ASSAY_E2E_PORT_WEB/ENGINE/DS`, defaults 4173/4179/4180) so only one worktree runs default ports — the other(s) shift (+100). Reviewers verify inside the matching worktree; the orchestrator cherry-picks to `main`, runs the merged gates, then removes worktrees/branches. `DUCKDB=/tmp/duckdb` (v1.5.5) is needed locally for fixture-generating specs.
- When in doubt, serialize — this codebase is small; coordination cost exceeds parallelism gains below task 3.
- **Subagent dispatch mechanics (proven, T-batch):** delegate via the pi subagent extension — `worker` and `reviewer` agents (user scope; historical parenthetical — the T-batch-era default was `zai/glm-5.3-flash`; the current roster is pinned in §7.6 below). **Serialize subagent sessions** — two concurrent glm-5.3-flash sessions hit a provider 429 (§9 i). Write dispatch briefs to `/tmp`, never inside the repo. Worker briefs carry: the §6 task row verbatim + done-when; docs/ADRs to read first; deliverables; explicit pre-authorized boundary exceptions AND forbidden files; the six gates with paste-the-tails evidence (+ port assignment); the block protocol (stop, clean tree, commit nothing, report); a report format. Reviewer briefs carry: the §7.3 checklist adapted to the task, the worker's claims to scrutinize, 'verify by running commands, not diffs alone', read-only discipline, and a final `VERDICT: approve` / `VERDICT: request-changes` line with specific items. Subagent contexts are isolated (no persistent session): a request-changes verdict loops back as a NEW worker dispatch carrying the reviewer's exact required items + the original brief file path, then a fresh reviewer re-verification.

### 7.5 Operating modes (choose per batch of work)

| Mode                                            | When                                                                  | How                                                                                                                           |
| ----------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Solo** (single agent)                         | Doc-only changes, single small task, maintenance                      | One session does claim→execute, then self-reviews against §7.3 and integrates. Acceptable only for low-risk tasks.            |
| **Orchestrator + workers**                      | Several independent §6 tasks (e.g., 1, 3, 8 in parallel)              | §7.1–§7.4 as written; reviewer duties fold into the orchestrator.                                                             |
| **Orchestrator + workers + reviewer** (default) | Anything touching `engine*`, `grid`, `domain`, or adding dependencies | Full model; reviewer independence is mandatory for these packages.                                                            |
| **Architect escalation**                        | A task would violate or extend an accepted ADR                        | Worker halts; orchestrator spawns an architect pass: Proposed ADR first, decision per contributing.md, then re-plan the task. |

### 7.6 Dispatch runbook (orchestrator) — the concrete M2/M3-proven loop

The subagent pattern (worker → independent reviewer, serialized dispatches) is driven by the
orchestrator session using these artifacts. Everything is reproducible from this section; it was
exercised for M2 (7 tasks) and M3 (6 tasks) with 4 request-changes loops, 3 provider-429
interruptions, and zero lost work.

**Agents** (user scope, `~/.pi/agent/agents/`): `worker`, `reviewer`, plus the
repo-local `assay-luna-worker` (pinned to `openai-codex/gpt-6-luna`). **Current
roster (maintainer preference, recorded 2026-10-17; supersedes the 2026-09-28
pin):** implementer `zai/glm-5.3-flash` **first**, ideally reviewed by
`openai-codex/gpt-6-luna` as a fresh reviewer session; **fallback when the GLM
lane is unavailable** (Go-lane usage-limit 429s, current since 2026-10-17):
Luna implements via `assay-luna-worker` and the **parent orchestrator
independently reviews** (gates + temporary mutants, clean tree, never the
implementing session). The same model never both implements and reviews a
change. **Fallback for agents without a `model:` pin = `opencode-go/mimo-v2.6-pro`.**
Known provider limits: zai 5-hour 429 windows; OpenAI credit exhaustion;
OpenCode Go lane limits — check availability before dispatching. Dispatch one
subagent at a time (provider rate limits); parallel _tasks_ run in separate
git worktrees instead.
**Roster history:** GLM → `openai-codex/gpt-5.6-sol` → GLM (provider-diversity suspended 2026-09-19
after a Codex usage-limit block) → deepseek-v4.1-flash worker switch 2026-09-20 → reviewer
GLM-5.3-Flash → **MiMo-V2.6-Pro 2026-09-28** → Luna-worker/parent-reviewer episode roster
2026-10-14 (rm-3 through ptv2-4) → **GLM-first/Luna-reviewer preference with Luna-worker/
parent-reviewer fallback 2026-10-17**; per-episode rosters are recorded in this file's git history.

**Queue format (canonical):** queue files use the 3-column shape `| task | scope/done-when | status/narrative |` (the AR and doc queues); the M4–M6-era 4-column shape is historical.

**Per-task artifact set** (written by the orchestrator before dispatch, in `/tmp`):
`/tmp/mX-N-worker-brief.md` → on request-changes: `/tmp/mX-N-fix-brief.md` (exact reviewer
items, quoted) → reviews: `/tmp/mX-N-reviewer-brief.md`, then `/tmp/mX-N-rereview-brief.md`.
Brief skeleton: context + read-first list (AGENTS.md, the task's queue file + this document, relevant ADRs/sources) →
done-when (concrete) → constraints (scope tags = allowed paths; one Conventional Commit
`feat|fix|test|refactor(mX-N):`; changesets direct to `.changeset/`; **no `docs/**`** —
orchestrator owns paperwork; security/privacy lines: text-only rendering, no
`innerHTML`/`dangerouslySetInnerHTML`, ADR 0025 exclusions) → gates with exact commands →
report format.

**Worktree + port conventions**: `git worktree add ../dataworkbench-mX-N -b mX-N` +
`corepack pnpm install --prefer-offline`. Workers use shifted e2e ports
(`ASSAY_E2E_PORT_WEB=4273 …ENGINE=4279 …DS=4280`; second parallel lane 4373/4379/4380);
reviewers default ports. `DUCKDB=/tmp/duckdb` (CLI v1.5.5) for pin derivation.

**Controls baked into every review brief**: verdict line is exactly `VERDICT: approve` or
`VERDICT: request-changes` (numbered items); reviewer must re-run all six gates itself; at
least one mutation drill per load-bearing claim (apply mutant → paste failing output → revert →
tree clean); re-derive any measured/CLI-pinned numbers independently; scope grep (allowed paths
only); hygiene grep (`innerHTML`, telemetry, changeset format, commit discipline). **Drills that
mutate app source under e2e must `pnpm build` before re-running** — the e2e runner serves the
built `dist`, so a source-only mutation false-passes (proven and corrected in the pt0-4 review,
2026-09-24).

**Loop protocol**: worker report → reviewer (fresh session) → `request-changes` → orchestrator
writes fix brief quoting the items verbatim → NEW worker dispatch (may be a new session) →
fresh re-review of the fix commit only → approve. Integration: cherry-pick commits to `main` in
order → run full merged gates on `main` (default ports) → pasted evidence → paperwork (§6 row
✅ with outcome + carry-overs, §9 entry, §2 state rows, roadmap §4/§8, root CHANGELOG for
product-narrative changes) → remove worktree + branch → tree clean.

**Interrupted-session adoption** (429s hit mid-worker): successor worker is told exactly which
uncommitted artifacts exist; it verifies prior-session work itself (never blindly trusts or
discards), fixes defects, and proceeds; the reviewer audits the adoption explicitly.

**Baseline before any queue execution**: six gates green on `main` from a clean tree; counts
recorded so every round's merged deltas are accounted (M3 close: 484 unit / 71 e2e + 1 skip / 74
commits).
