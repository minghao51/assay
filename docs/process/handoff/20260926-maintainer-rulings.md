# Maintainer rulings queue — C-pt0-1, D12, D13

Authored 2026-09-26 when the agent-doable queues (PT-0, AR, docs, PT-Q) all closed. These three
decisions are **human-only**; nothing in the current queues can start new front-engineering work
until they are called. Each ruling below states what is being decided, the exact inputs to read,
what it unblocks, and where the ruling must be recorded once made.

Conventions (binding): decisions are recorded where this file says — never re-decided elsewhere;
durable/structural decisions get an ADR (copy `docs/adr/template.md`, next free number **0047** —
0043 landed 2026-09-27 (changesets ledger), 0044 landed 2026-09-29 (workbench shell; Accepted
same day via ruling D14), 0045 landed 2026-09-29 (telemetry design adopted, via ruling C-pt0-1),
**0046 Accepted 2026-10-02** (DCR artifact v1 — via ruling D17)); when a ruling lands, splice its close into `handoff.md` §9 and flip the
status cells in the authoritative rows linked below. ~15 minutes of maintainer time total
(D14 added 2026-09-29 — still short). **D15 + D16 ruled 2026-10-02** (PT-V GO via the R4 spike;
M9 scoping authorized) and **D17 + D18 ruled 2026-10-02** (DCR artifact format v1 accepted —
[ADR 0046](../../adr/0046-dcr-artifact-format-v1.md); PT-V slice 1 GO on the desktop-extension
webview); earlier rulings (C-pt0-1, D12–D14) ruled 2026-09-29. Records per the sections below; the
[open-threads map](20260926-open-threads.md) is re-pointed.

## How to record a ruling (per item)

1. Flip the status cell(s) in the authoritative row(s) linked below (decision + date).
2. If the decision is durable/structural: write the ADR (next free number, propose → accepted).
3. Add a one-line entry to `handoff.md` §9 (next letter in sequence).
4. If the ruling unblocks agent work: add/queue the task rows it names (product/04 §7 style,
   self-serve pickup protocol), then the orchestrator dispatches per the open-threads map.

## Ruling C-pt0-1 — approve (or amend) the telemetry design — ✅ RESOLVED 2026-09-29: approved with the §11 defaults; ADR 0045 written (the original "write ADR 0043" note was stale — 0043/0044 were taken); D2/roadmap/handoff rows flipped; implementation queued ([telemetry queue](20260929-telemetry-queue.md)).

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

## Ruling D12 — first post-MVP engineering track: PT-V vs PT-P — ✅ RESOLVED 2026-09-29: **PT-P first** (queue authored: [PT-P queue](20260929-ptp-queue.md)); PT-V follows (R4 spike first).

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

## Ruling D13 — fate of the `DataEngine` interface (`packages/engine`) — ✅ RESOLVED 2026-09-29: **keep-as-target** (recorded in [arch-01 §7](../../architecture/01-architecture.md); no ADR — the convention reserves ADRs for retire/keep-and-wire).

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

## Ruling D14 — workbench-shell direction (ADR 0044) — added 2026-09-29 (ux-5) — ✅ RESOLVED 2026-09-29: **ADR 0044 Accepted as written**.

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

## Ruling D15 — PT-V go/no-go — added 2026-10-02 (post q-15 closure) — ✅ RESOLVED 2026-10-02: **GO via the R4 spike** (spike approved as the next engineering dispatch; the PT-V **track commitment** is decoupled and follows the spike's evidence report).

- **Decide:** start PT-V now (a), hold with residue fills (b), or approve the **R4 webview
  feasibility spike** only (c) — track commitment deferred to the spike's evidence.
- **Ruled: (c).** The spike ([ptv-m9 queue](20261002-ptv-m9-queue.md) row **ptv-1**) answers the
  R4 questions empirically (worker boot per hosting target, OPFS/COOP-COEP constraints,
  file-access bridge, memory ceilings, packaging) and lands a GO / NO-GO / RE-SCOPE
  recommendation per hosting target (desktop extension vs vscode-web). Whether PT-V proper
  starts — and at which hosting target — is decided on that report (a follow-up ruling, not a
  re-decision of this one).
- **Read:** [post-MVP track §5](../../product/04-post-mvp-track.md) (scope + spike definition);
  [roadmap §3.1 M7 row](../../product/03-execution-roadmap.md); [ADR 0008](../../adr/0008-shared-core-web-vscode-cli.md),
  [ADR 0022](../../adr/0022-headless-grid-and-renderer-strategy.md); D12 (PT-P first — complete 2026-10-02, precondition satisfied).
- **Unblocks:** **ptv-1** (the spike) immediately; PT-V planning after the report. A NO-GO/RE-SCOPE
  result re-frames PT-V without sunk track cost — that is the point of decoupling.
- **Record:** roadmap §7 D15 row; product/04 §9 + §3/§5 status lines; handoff §9; this file.
- **Default if deferred:** n/a — ruled.

## Ruling D16 — M9 scoping go-ahead — added 2026-10-02 (post q-15 closure) — ✅ RESOLVED 2026-10-02: **authorized** (scoping proposal now; the DCR **format ruling** comes back after the proposal lands).

- **Decide:** whether to start scoping **M9 (local DCR generation)** now — P3 (DCR integration,
  roadmap §3.2) is blocked on it, and G3's evidence list requires "DCR artifact format stable
  (M9 done)".
- **Ruled: yes.** The scoping **proposal** (v1 field selection from ADR 0014's list; format
  discipline per the repo's canonical-serialization precedent; the local candidate-DatasetVersion
  definition; generation entry points; hosted concerns — comments/approvals/policy — explicitly
  out per ADR 0014's standalone-report consequence) is queue row **m9-1**: a spec + **Proposed
  ADR 0046**, authored by the next session, that comes BACK for the format ruling (requested as
  **D17**). Authoring ≠ deciding: nothing in the proposal binds until that ruling.
- **Read:** [roadmap §3.1 M9 row + §5 G3](../../product/03-execution-roadmap.md); [ADR 0014](../../adr/0014-dataset-change-request-model.md)
  (field list + standalone-report consequence); [ADR 0011](../../adr/0011-dataset-identity-and-versioning.md) (versioning);
  [ADR 0033](../../adr/0033-materialization-is-logical-and-backend-mapped.md)/[0035](../../adr/0035-data-quality-and-publish-gates-are-first-class-dag-nodes.md)
  (the publish boundary P3 will wire — publish-mode materialization refuses explicitly today).
- **Unblocks:** **m9-1** immediately; the **P3 queue** after the D17 format ruling.
- **Record:** roadmap §7 D16 row; product/04 §9; handoff §9; this file.
- **Default if deferred:** n/a — ruled.

## Ruling D17 — DCR artifact format v1 — added 2026-10-02 (post ptv-m9 closure) — ✅ RESOLVED 2026-10-02: **ACCEPTED** — [ADR 0046](../../adr/0046-dcr-artifact-format-v1.md) flips Proposed→Accepted; the spec §9 twelve questions are ruled as listed below (the spec's recommendations carried).

- **Decide:** rule on the canonical local **DCR artifact format v1** proposed by
  [`docs/product/06-dcr-artifact.md`](../../product/06-dcr-artifact.md) and [Proposed ADR 0046](../../adr/0046-dcr-artifact-format-v1.md):
  the **12 open questions in spec §9** — serialization choice + `format`/version stamp (Q1);
  concrete field schema and the ADR 0014 four-delta → M6 aspect mapping (Q2); embed vs reference
  payloads (Q3); local candidate-DatasetVersion identity (Q4); generation entry point(s) (Q5);
  local privacy-findings producer (Q6); row-diff key discipline (Q7); evaluations defer/reserve
  (Q8); reserved identifier/namespace prefix (Q9); the artifact's own identity/status (Q10);
  timestamps vs byte-stability (Q11); hosted round-trip/forward compatibility (Q12). The spec
  carried a recommendation per question; **nothing was decided by the proposal** (D16 discipline).
- **Ruled: ACCEPTED — the 12 spec-§9 outcomes:**
  - **Q1 — (a)** canonical YAML (the contracts/IR precedent), stamped `format: assay-dcr` + `version: 1`.
  - **Q2 — (a)** mirror M6's aspects (`schemaDrift` / `columnDeltas` / `rowDiff`); ADR 0014's four
    delta names map onto them. **Explicit confirmation recorded:** "profile delta" is satisfied by
    profile-derived nullability drift + distribution deltas; **no standalone profile diff in v1**.
  - **Q3 — (a)** fully embed the bounded v1 payloads (sample limits inherited from M6's C1/K
    discipline); **no reference mode in v1**.
  - **Q4 — (b)+(c)** local candidate-DatasetVersion identity = logical id + schema fingerprint +
    provenance **plus** a materialization reference (pipeline run node / export path); **no full
    content hash in v1** (connector-specific, infeasible for large/lazy outputs).
  - **Q5 — (c)** both entry points — CLI subcommand and web panel action off a gated run — sharing
    one pure artifact builder; if capacity forces one, **CLI first**.
  - **Q6 — (a)** privacy findings are **deferred**: v1 carries an explicit "not computed"
    disclosure for the field (no local producer exists; nothing invented).
  - **Q7 — (a)+(c)** row delta requires explicit keys (typed located error otherwise) and is
    **explicitly absent** when no keys were supplied; **no silent inference inside a DCR** (option
    (b)'s inference-disclosure carry is rejected).
  - **Q8 — (a)** evaluations omitted entirely from v1; deferral to M8 (G2) recorded — no reserved field.
  - **Q9 — (b)** reserve the `assay_dcr_*` identifier namespace. **[Delegated selection — flagged:]**
    the maintainer delegated the un-answered items ("go with your suggestion"); the orchestrator
    selected (b) over (c) because ADR 0046's format-discipline clause already states a reserved
    `assay_*`-style namespace (so (b) needs no ADR amendment) and it costs nothing while v1 has no
    user-keyed maps. Recorded as a delegated selection, not a maintainer call.
  - **Q10 — (c)** the artifact carries **no identity/status** — it is a standalone report file (the
    m5-3/m6-4 export precedent); hosted M10 owns workflow state. **Confirmed:** the local artifact
    is not expected to be byte-identical to the future hosted DCR.
  - **Q11 — (a)** no wall-clock anywhere in canonical bytes (provenance timestamps, if needed,
    live outside the canonical core).
  - **Q12 — (a)** v1 is an extensible superset the hosted layer extends; **additive-only within
    `v1` is an explicit constraint of this ruling** (non-additive change = STOP-and-report; version
    bump = maintainer-visible).
- **Read:** the [scoping spec §9](../../product/06-dcr-artifact.md) (the numbered list) +
  [Proposed ADR 0046](../../adr/0046-dcr-artifact-format-v1.md); [ADR 0014](../../adr/0014-dataset-change-request-model.md)
  (field list + standalone-report consequence); [ADR 0011](../../adr/0011-dataset-identity-and-versioning.md)/[0012](../../adr/0012-edit-overlay-and-transaction-semantics.md)
  (versioning/overlay); the canonical-serialization precedents (ADR 0013/0026/0030).
- **Unblocks:** authoring the **P3 queue** (DCR/publish integration, roadmap §3.2); G3's "DCR
  artifact format stable (M9 done)" evidence. (The M9 code slice follows P3 authoring.)
- **Record:** ADR 0046 flipped Proposed→Accepted (decision point 4 now carries the 12 outcomes);
  spec §9 annotated per question + §7/§10; roadmap §7 D17 row; product/04 §9/§3/§5 status lines;
  handoff §9 **ef**; this file.
- **Default if deferred:** n/a — ruled.

## Ruling D18 — PT-V track start (post-spike) — added 2026-10-02 (post ptv-m9 closure; code assigned by the closure session — maintainer to confirm) — ✅ RESOLVED 2026-10-02: **(a) PT-V slice 1 starts on the desktop-extension webview**; the code **D18** is confirmed (no renumber requested).

- **Decide:** whether/where **PT-V proper** starts, reading the delivered R4 report
  [`docs/engineering/08-vscode-webview-feasibility.md`](../../engineering/08-vscode-webview-feasibility.md):
  the spike's **desktop-extension webview GO** is the recommended target; **vscode-web is RE-SCOPE**
  (host-entry + OPFS policy unmeasured). Options: (a) start PT-V slice 1 on the desktop-extension
  webview; (b) hold PT-V and continue residue/hardening; (c) start a different post-MVP thread.
- **Ruled: (a)** — PT-V slice 1 starts on the **desktop-extension webview**. The maintainer
  expressed this as **"D15 a"** (start PT-V now); D15 itself was already resolved (GO via the
  spike), so it is recorded here as **D18(a)**. **vscode-web remains RE-SCOPE and uncommitted** — no
  track scope for it; a future `@vscode/test-web` spike may settle it. Slice 1 carries the report's
  mandatory items: **vendor the Parquet extension (local-first)** and **promote the blob-URL
  bootstrap + measured CSP into the engine's webview adapter**, plus the queue-§5 carry list
  (`eh`-failure exit-code hardening, secondary timing envelopes, coverage policy).
- **Read:** the [ptv-1 report](../../engineering/08-vscode-webview-feasibility.md); the
  [ptv-m9 queue §5 closure](20261002-ptv-m9-queue.md) (slice-1 carry list: blob-bootstrap/CSP pins,
  Parquet-extension vendoring, `eh`-failure exit-code hardening, secondary timing envelopes,
  coverage policy); [post-MVP track §5](../../product/04-post-mvp-track.md) (PT-V scope + spike
  definition); [roadmap §3.1 M7 row](../../product/03-execution-roadmap.md); D15 (GO via the spike).
- **Unblocks:** **PT-V slice-1 planning** (the next dispatchable work once its queue is authored).
- **Record:** roadmap §7 D18 row + product/04 §9/§3/§5; handoff §9 **ef**; this file.
- **Default if deferred:** n/a — ruled.

## Ruling D19 — P3 phase-doc §9 spec review (OQ-1…OQ-8) — added 2026-10-10 (post phase-doc 07 /

p3-1) — ✅ RESOLVED 2026-10-10: all eight questions ruled same day; the P3 queue is amended
accordingly (six rows — p3-1b inserted between p3-2 and p3-3).

- **Decide:** rule on the eight open spec questions in
  [`07-p3-dcr-integration.md` §9](../../product/07-p3-dcr-integration.md) — the v1 adversarial
  review opened with the phase document (2026-10-10), eight questions the landed p3-1
  implementation surfaced where the D17 rulings bound but did not fully settle the answer: enum
  closure vs additive-only (OQ-1); the `privacyFindings` disclosure-shape trap (OQ-2);
  cross-release byte-agreement scope (OQ-3); truncation disclosure for bounded payloads (OQ-4);
  materialization-reference mutability (OQ-5); schema-fingerprint stability (OQ-6); row-key
  re-diff stability (OQ-7); old-tool loud-fail on additive fields (OQ-8). Nothing here re-opens
  D17.
- **Ruled — the eight outcomes (maintainer quotes verbatim):**
  - **OQ-1 —** "optional keys is alright, however yes, any enum keys will need version bump, also
    the hash we need for prompts version needt o have the optinal keys in as well" → new
    **optional record keys are additive within v1**; **ANY new enum/discriminator member is a
    version bump** (maintainer-visible per Q12) — v1's enum spaces are closed. **Supplementary
    clause recorded VERBATIM (the quote's final segment), interpretation confirmed by maintainer
    2026-10-10:** any digest computed over a DCR artifact (e.g., future prompt-version pinning)
    runs over the FULL canonical serialization including optional keys — optional keys are never
    stripped from hashed content.
  - **OQ-2 — accept.** The tagged `privacyFindings` shape stands; a future "computed" evolution is
    a v2 union member that replaces the disclosure — a v2 concern only.
  - **OQ-3 — proceed as recommended.** Cross-release byte-stability is enforced by the **golden
    fixture corpus** (`fixtures/dcr/` — serializer changes surface as fixture failures;
    regeneration is deliberate + changeset-accompanied). The **tool-version stamp is REJECTED**
    (Q10 adjacency).
  - **OQ-4 —** "yup add the disclosure field" → the **truncation/bounding disclosure is authorized
    as v1-authoring** (additive optional key(s) disclosing when an embedded payload aspect hits
    its M6 bound — the bins precedent). Becomes new queue row **p3-1b**
    ([P3 queue](20261002-p3-queue.md)) — runs after p3-2, before p3-3 (p3-3's golden artifact
    depends on it).
  - **OQ-5 —** "refuse Loudly" → the **export-time liveness check**: exporting a DCR off a
    dangling materialization reference REFUSES with a typed error (refusal discipline); parse
    stays **dangling-tolerant** — the artifact is an evidence snapshot (unchanged v1 behavior).
    Pins appended to p3-3 + p3-4.
  - **OQ-6 —** "b)" → the **fingerprint-stability fixture joins p3-5's sweep**; the
    algorithm-names-frozen policy is NOT adopted (the maintainer picked only (b)).
  - **OQ-7 — accept.** Row-keys are stable **per-generation only** (evidence-snapshot semantics,
    consistent with Q10); re-diff determinism is the diff engine's contract (M6), not the artifact
    format's.
  - **OQ-8 —** "yup" → **loud-fail confirmed as intended product behavior**: strict unknown-key
    refusal + version-stamped rejection; never silently softened.
- **Read:** [phase doc 07 §9](../../product/07-p3-dcr-integration.md) (context/options/bounds per
  question); [ADR 0046](../../adr/0046-dcr-artifact-format-v1.md) + the
  [ruled spec §9](../../product/06-dcr-artifact.md) (the D17 boundaries each question cites).
- **Unblocks:** nothing was blocked (p3-2 was already dispatchable), but the outcomes de-risk the
  remaining rows and amend the queue: p3-1b queued (OQ-4); liveness-refusal pins on p3-3/p3-4
  (OQ-5); the fingerprint fixture in p3-5's sweep (OQ-6).
- **Record:** phase doc 07 §9 Ruled lines + §5/§6/§7 quoted queue cells synced; roadmap §7 D19
  row; the [P3 queue](20261002-p3-queue.md) amended (+p3-1b, appended pins); handoff §9 **ej**;
  this file.
- **Default if deferred:** n/a — ruled.

## Related human items (tracked in [manual-actions](../manual-actions.md), not re-listed here)

M1 (npm org — gates the [publish runbook](20260926-publish-runbook.md)), M4 (trademark/domain),
org transfer + public-flip (with the private-vulnerability-reporting checklist item there).
