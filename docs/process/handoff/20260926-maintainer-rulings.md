# Maintainer rulings queue — C-pt0-1, D12, D13

Authored 2026-09-26 when the agent-doable queues (PT-0, AR, docs, PT-Q) all closed. These three
decisions are **human-only**; nothing in the current queues can start new front-engineering work
until they are called. Each ruling below states what is being decided, the exact inputs to read,
what it unblocks, and where the ruling must be recorded once made.

Conventions (binding): decisions are recorded where this file says — never re-decided elsewhere;
durable/structural decisions get an ADR (copy `docs/adr/template.md`, next free number **0045** —
0043 landed 2026-09-27 as the changesets ledger, 0044 landed 2026-09-29 as the workbench-shell
Proposed ADR below); when a ruling lands, splice its close into `handoff.md` §9 and flip the
status cells in the authoritative rows linked below. ~15 minutes of maintainer time total
(D14 added 2026-09-29 — still short).

## How to record a ruling (per item)

1. Flip the status cell(s) in the authoritative row(s) linked below (decision + date).
2. If the decision is durable/structural: write the ADR (next free number, propose → accepted).
3. Add a one-line entry to `handoff.md` §9 (next letter in sequence).
4. If the ruling unblocks agent work: add/queue the task rows it names (product/04 §7 style,
   self-serve pickup protocol), then the orchestrator dispatches per the open-threads map.

## Ruling C-pt0-1 — approve (or amend) the telemetry design

- **Decide:** approve the authored telemetry design for implementation.
- **Read:** [`../../engineering/06-telemetry-design.md`](../../engineering/06-telemetry-design.md)
  (authored 2026-09-21: self-hosted minimal collector, allowlisted metadata-only events, sampling);
  guardrails are already decided — **never** dataset contents, filenames-where-sensitive, raw SQL
  results, cell values, or PII ([ADR 0025](../../adr/0025-telemetry-and-data-privacy-boundary.md)); telemetry is **opt-out**
  ([ADR 0037](../../adr/0037-telemetry-opt-out-consent.md)). Roadmap context: [decision D2 row, roadmap §7](../../product/03-execution-roadmap.md).
- **Unblocks:** the telemetry implementation task (pre-G0) — event-schema code, collector endpoint,
  opt-out path. The implementation itself is normal agent work once approved.
- **Record:** flip the D2 row + the `[~]` status at roadmap line ~103 to approved (date); write
  ADR 0043 (telemetry design adopted) since it binds the product's privacy posture; handoff §9.
- **Default if deferred:** nothing breaks — telemetry stays unimplemented; G0 stays open.

## Ruling D12 — first post-MVP engineering track: PT-V vs PT-P

- **Decide:** which track gets engineering first — **(a) PT-V** (VS Code surface, former M7) or
  **(b) PT-P** (pipeline foundation, P1–P2).
- **Read:** [post-MVP track §9](../../product/04-post-mvp-track.md) (both tracks' scope/entry
  conditions — PT-P's entry condition is recorded as **met**); [roadmap §7 row D12](../../product/03-execution-roadmap.md);
  sequencing context in the [open-threads map](20260926-open-threads.md). Note the two are not
  exclusive forever — this picks what's FIRST.
- **Unblocks:** the first post-MVP milestone queue (task rows authored after the call).
- **Record:** D12 row in roadmap §7 (choice + date); handoff §9; if the choice reorders the
  post-MVP track doc, update `product/04` in the same commit.
- **Default if deferred:** no new milestone queue; residue rows (q-14, q-7 slice 2, q-5b — see
  [product/04 §7](../../product/04-post-mvp-track.md)) and hardening fills remain available.

## Ruling D13 — fate of the `DataEngine` interface (`packages/engine`)

- **Decide:** keep-and-wire (someone implements `DataEngine` over `engine-duckdb`), keep-as-target
  (documented, unchanged), or retire (delete the orphaned package).
- **Read:** [architecture §7](../../architecture/01-architecture.md) — the interface exists, is
  **orphaned** (nothing implements or imports it; the real engine surface is the
  `@assay/engine-duckdb` client, pinned by the conformance suite); ADR 0042 records why
  `packages/engine` stays private.
- **Unblocks:** either the engine-abstraction track (if kept-and-wired) or a small deletion task +
  doc sweep (if retired). PT-V/PT-P planning may depend on this (VS Code and pipeline hosts both
  ask "what do they talk to?").
- **Record:** arch-01 §7 (decision + date); if retired: ADR + deletion task row; if kept-and-wired:
  ADR + task rows; handoff §9.
- **Default if deferred:** harmless — the package sits private and orphaned; the conformance suite
  pins the real client regardless.

## Ruling D14 — workbench-shell direction (ADR 0044) — added 2026-09-29 (ux-5)

- **Decide:** accept (or amend/reject) the grid-centric **two-pane workbench shell** —
  [ADR 0044](../../adr/0044-workbench-shell-two-pane.md) (Proposed). Folded into the same
  ruling: pane side (spec recommends tools-left), record-inspector dock (spec: bottom of the
  grid column), and the **1024×700 minimum supported viewport** (below it: single-column stack,
  scroll-never-clip; no phone breakpoints — an explicit non-goal).
- **Read:** the [workbench-shell spec](../../product/05-workbench-shell.md) (ux-5, 2026-09-29 —
  evidence, slice plan, acceptance lists); [audit UX-3](../../reviews/2026-09-29-interface-ux-audit.md)
  (the `[MEASURED]` finding); [ADR 0022](../../adr/0022-headless-grid-and-renderer-strategy.md) (rendering
  replaceability constraint the spec respects).
- **Unblocks:** **ux-6** (shell slice 1: collapsible sections + sticky nav + grid above the panel
  stack — UX queue, spec §4 acceptance) and **PT-Q q-15** (slice 2: the two-pane split). Slice 1
  is implementation-ready the moment the ruling lands; rejecting the two-pane direction leaves
  slice 1 as the whole UX-3 remediation and drops q-15.
- **Record:** flip ADR 0044 Proposed→Accepted (or record the rejection there — never renumber);
  flip the [UX queue](20260929-ux-queue.md) ux-6 row + [post-MVP track §7 q-15 / §9
  D14](../../product/04-post-mvp-track.md) rows; handoff §9.
- **Default if deferred:** ux-6 and q-15 stay blocked; the single-column stack (post ux-1…ux-4)
  remains workable but the audit's UX-3 stays open.

## Related human items (tracked in [manual-actions](../manual-actions.md), not re-listed here)

M1 (npm org — gates the [publish runbook](20260926-publish-runbook.md)), M4 (trademark/domain),
org transfer + public-flip (with the private-vulnerability-reporting checklist item there).
