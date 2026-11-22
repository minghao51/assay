# B3 spec — diff B-side registry lifecycle (`profileComparison`/`closeTable`)

**Date:** 2026-11-21. **Status:** PROPOSED — spec deliverable; not implementation authority.
Nothing in this record is implemented; it defines a contract for a later implementation brief and
names the decisions the maintainer still owns. Subject: PT-H carry-over B3
([successor queue](20261121-successor-queue.md) §3 B3;
[post-MVP §6](../../product/04-post-mvp-track.md#6-pt-h--hardening--backlog-inventory-recorded-carry-overs)).

## 1. ADR 0047 check (verdict first)

**Verdict: the proposal below does not weaken [ADR 0047](../../adr/0047-web-session-replacement-retains-retired-tables.md),
as scoped.** Reasoning:

- ADR 0047 accepted **unbounded in-process table/file retention for the web session-replacement
  path** and declined to add a per-table release primitive "under this decision" (ADR 0047
  "Decision"). This spec never releases, and never schedules release of, the replacement-path or
  live-session population: the proposed `closeTable` identity rules refuse those handles
  ("wrong identity", §4.4), and the recommended migration removes the _manufacture_ of diff
  staging tables rather than reclaiming retained ones.
- The primary op, `profileComparison`, is not a release primitive at all — it profiles the staged
  comparison directly and deletes the transient `engine/open` call that leaks
  (`apps/web/src/sessions/useDiffSession.ts:129-133`). ADR 0047's accepted behaviour is untouched.
- ADR 0047 names the boundary explicitly: a release primitive that reclaims retired tables' memory
  on demand "would be a behaviour change: supersede this ADR rather than rewriting it"
  (ADR 0047 "Consequences/Negative"; "Alternatives considered" names `releaseTable`/`closeTable`
  as "the natural trigger for superseding this ADR"). **If the maintainer widens `closeTable` to
  close replacement-path retired tables, that is the supersession trigger and this spec stops for
  an ADR.** The scope below deliberately refuses that widening.
- Documentation consequence (not a weakening): ADR 0047's Context fact "the client exposes no
  per-table release" becomes partially outdated when a release op ships; the implementation PR
  must update the records that quote it (e.g.
  [WF-05 design](20261110-wf05-replacement-design.md) §5.2 B1) rather than editing the accepted
  ADR text.

The diff staging registry is a different population from the web session: the comparison scratch is
its own single-slot registry (`assay_diff_dN`, never `assay_tN` — see §2), and the leak is the
transient B-side open layered on top of it. This op set is about that transient layer only.

## 2. Verified current behaviour (at this revision)

| Fact                                                                                                                                                                                                                                                                                                                                   | Evidence                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Every comparison staging attempt opens the comparison file a **second** time as a regular table to obtain profile aggregates: "the engine profiles registered tables, and the comparison view is not one"                                                                                                                              | `apps/web/src/sessions/useDiffSession.ts:109-115` (comment), `:129-133` (`stageComparison` + `engineClient.open(source)` + `engineClient.profile(handleB)`)        |
| `engine/open` registers one `TableRegistry` entry per success: id `tN`, view `assay_tN` (`viewNameForTableId`), file registration named `tN`; ids are a monotonic counter                                                                                                                                                              | `packages/engine-duckdb/src/table-registry.ts:32-34`, `:46-58`; failed opens roll back their own entry only (`packages/engine-duckdb/src/csv-dispatch.ts:166-183`) |
| **Accumulation:** one orphaned `assay_tN` view + one file registration per staging attempt that reaches a successful `open` — including re-stages of a different file, retries after a failed stage, and superseded in-flight stages (the seq guard fires after `open` and drops the handle on the floor, `useDiffSession.ts:134-135`) | `apps/web/src/sessions/useDiffSession.ts:125-135`; unbounded across a worker lifetime                                                                              |
| **Nothing drops them** short of teardown: `engine/dispose` is the only release and clears the whole `TableRegistry` (view + file, best-effort), and the web calls it exactly once at `beforeunload`/`pagehide`                                                                                                                         | `packages/engine-duckdb/src/engine-executor.ts:1923-1932`; `packages/engine-duckdb/src/client.ts:1157-1240`; `apps/web/src/App.tsx:1150-1171`                      |
| The new-dataset reset drops only web refs (`comparisonRef.current = null`, both seq guards bumped) — no engine call                                                                                                                                                                                                                    | `apps/web/src/sessions/useDiffSession.ts:279-287`                                                                                                                  |
| The comparison scratch itself does **not** accumulate: `assay_diff_dN` is a single slot, replaced (old view dropped) on re-stage and dropped at dispose                                                                                                                                                                                | `packages/engine-duckdb/src/comparison-registry.ts:5-13`, `:62-71`; `packages/engine-duckdb/src/engine-executor.ts:1104-1109`, `:1933-1940`                        |
| The wire protocol has no release/close op of any kind (22 request types: init → dispose)                                                                                                                                                                                                                                               | `packages/engine-duckdb/src/protocol.ts:466-488`                                                                                                                   |
| The carry-over is recorded twice: AR-W5 ("the client has no `closeTable`/`profileComparison` op, so it cannot be released per-action without an engine change") and WF-05 §5.2 B1                                                                                                                                                      | `apps/web/src/App.tsx:1150-1157`; `.changeset/web-ar-2-correctness-batch.md:24-26`; [WF-05 design](20261110-wf05-replacement-design.md) §5.2 B1                    |
| Precedent for the same concern: pipeline gate runs memoize one handle per relation per run so runs cannot accumulate registrations                                                                                                                                                                                                     | `packages/engine-duckdb/src/client.ts:1030-1038` (comment + `handleFor`), pinned by `packages/engine-duckdb/src/client.test.ts:2309-2317`                          |

**Count and lifetime summary:** N staging attempts that reach a successful `open` leave up to N
orphaned `assay_tN` views and N file registrations alive for the whole worker lifetime (until tab
unload). The live session table and the ADR 0047 replacement-path retirements are separate
populations and are not counted here.

## 3. Proposed contract (PROPOSED; two ops)

All of §3–§6 is PROPOSED. The recommended shape is both ops; the maintainer may ship the primary
one alone (§8 open decisions).

### 3.1 `engine/profile-comparison` (primary — removes the leak at source)

- **Request:** `{ type: 'engine/profile-comparison', requestId: number, comparisonId: string }`.
- **Response:** `engine/profile-result` payload as-is (`EngineDatasetProfile` — the same shape
  `engine/profile` returns today, `packages/engine-duckdb/src/client.ts:646` ff.), so
  `toDiffProfile` and the diff model consume it unchanged.
- **Semantics:** profile the staged comparison view (`assay_diff_dN`) resolved through the
  `ComparisonRegistry` (`packages/engine-duckdb/src/comparison-registry.ts:62-64`) instead of
  requiring a `TableRegistry` handle. Web migration: `useDiffSession` calls `stageComparison` then
  `profileComparison(comparison.id)` and drops the `engineClient.open(source)` line entirely —
  zero `assay_tN` manufacture per comparison.
- **Lane:** query lane (profile-class scan — same class as `engine/profile`,
  `packages/engine-duckdb/src/engine-executor.ts:343-362`).

### 3.2 `engine/close-table` (companion — scoped release primitive)

- **Request:** `{ type: 'engine/close-table', requestId: number, tableId: string }`.
- **Response:** `{ type: 'engine/table-closed', requestId: number }`.
- **Semantics:** drop the entry's view (`DROP VIEW IF EXISTS`) and its file registration
  (best-effort, both halves swallowed on failure — the established release pattern,
  `packages/engine-duckdb/src/csv-dispatch.ts:295-318`), then remove the registry entry. Idempotent
  at the engine level (`IF EXISTS`, `dropFile` on a missing name does not throw), but the wire
  outcome distinguishes the refusal categories below.
- **Lane:** registry lane (registry-mutating, like `engine/open`/`engine/dispose`).

### 3.3 Table identity rules

- A handle is valid iff its `tableId` is present in the worker `TableRegistry` **and** was created
  by a transient open — `engine/open` gains an additive optional `transient: true` field
  (absent = today's behaviour, byte-identical wire for existing callers) and the registry tags the
  entry (`packages/engine-duckdb/src/table-registry.ts` bookkeeping extension). This flag is the
  only wire change in the contract.
- Handles are referenced by `tableId` only; `assay_tN` view names remain engine-generated and are
  never accepted from the wire (ADR 0025 posture unchanged).
- The comparison slot (`comparisonId`) and the preview slot are **not** table handles and are
  refused by `closeTable` (they keep their own lifecycles: comparison replaced on re-stage /
  dropped at dispose; preview released by next preview, any open, or dispose).

### 3.4 Refusal categories

| Refusal          | Condition                                                                                                                                       | Behaviour                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `unknown-handle` | tableId never existed, or the engine has no such entry                                                                                          | clean typed error (existing `requireTable` shape, `engine-executor.ts:1962-1967`)        |
| `already-closed` | tableId in the closed tombstone set (bounded; distinguishable from never-existed)                                                               | clean typed error, no state change                                                       |
| `wrong-identity` | entry exists but is untagged (live session table, ADR 0047 retired table, pipeline `registerView` handle), or the id is a comparison/preview id | clean typed error, handle stays registered                                               |
| `busy`           | an in-flight op references the handle (e.g. a query-lane profile still scanning it)                                                             | clean typed error; the caller retries after the op settles. Refuse, never silently defer |

All refusals fire **pre-execution** — before any DuckDB call (hostile-wire posture:
`parseEngineRequestDetailed`, `packages/engine-duckdb/src/protocol.ts:896` ff.).

### 3.5 Retention semantics

- `closeTable` drops the view and file registration at once (no retention window — a delayed drop
  would need its own timer and failure story for no benefit; the maintainer may select a window
  (§8) if e.g. a stale tab re-reads the handle).
- **Live result pages survive.** The diff result page and the B-side profile summary hold web-side
  snapshots (`EngineDatasetProfile`, `buildDiffPanelReport` output) and never re-query the closed
  handle. Re-running the diff addresses the staged comparison and the A-side session handle
  (`apps/web/src/sessions/useDiffSession.ts:160-176`) — neither is affected. An op issued against a
  closed handle gets `unknown-handle`/`already-closed`, never a crash (the registry contract
  already promises clean errors for released ids —
  `packages/engine-duckdb/src/table-registry.ts:7-9`).
- The staged comparison itself is never closed by these ops.

### 3.6 Cap / memory behaviour

- Recommended migration: **zero** transient tables manufactured per comparison; the comparison slot
  stays at ≤ 1 (§2). Registry size returns to its pre-comparison baseline after every cycle.
- If the transient-open variant is kept instead of (or alongside) `profileComparison`: close in a
  `finally` after profiling, so at most one live transient handle exists per in-flight stage; plus
  a hard worker-side cap K — a new transient `open` is refused while K unclosed transient handles
  exist — so no failure interleaving yields unbounded growth. K is an open decision (§8).
- A failed close leaves at most one table until dispose, surfaced as a typed close failure (never
  silent). Memory magnitudes are unmeasured in this record (§9).

### 3.7 Failure paths

- `profileComparison` failure mid-scan: typed error to the caller; no table existed, nothing to
  release; the comparison slot is unchanged; the panel's existing failed-staging state applies
  (`useDiffSession.ts:136-148`).
- Transient-open variant: `open` succeeds → profile fails → the `finally` close still runs; if the
  close also fails the bounded leak (§3.6) is the backstop, dispose is the final one.
- Close racing a consumer: `busy` refusal (§3.4), then retry; the consume op's own error handling
  is unchanged.
- Dispose racing anything: `engine/dispose` remains terminal and reclaims everything
  (`engine-executor.ts:1923-1950`); post-dispose calls fail-first with the typed disposal error
  (`packages/engine-duckdb/src/client.ts:371-378`).

## 4. Byte-invariance statement

**The preview payload, DCR and repair flows must not change bytes.** Concretely: the CSV preview
payload and its retention rules (ADR 0049) are untouched; the DCR artifact format (ADR 0046) is
untouched; the repair preview composition shape (ADR 0051) is untouched; the diff result wire
(`EngineRowDiffResult`) and `buildDiffPanelReport` output are untouched; `engine/profile-result`
keeps its exact shape. The only wire delta is the additive optional `transient` field on
`engine/open` (absent for every existing caller) plus the new request/response types.

## 5. Alternative considered and rejected: keep accumulation with a bound

Keep the transient opens and record the bound as "one `assay_tN` view + one file registration per
staging attempt, for the worker lifetime". Rejected as the recommendation: the accumulation is
user-triggered and unbounded within a session (re-staging is an ordinary action), the carry-over is
already recorded as needing the op (post-MVP §6; `.changeset/web-ar-2-correctness-batch.md:24-26`),
and ADR 0047's accepted retention was scoped to the replacement path — re-using it as cover for a
second unbounded population would extend an accepted decision without the maintainer. It remains
available as a zero-code fallback if the maintainer declines both ops.

## 6. Verification plan (for the implementation brief)

1. **Engine conformance scenario** (`packages/testing/src/engine-conformance.ts`): a
   `profile-comparison` scenario asserting the stats equal the same dataset's `profile()` output,
   and the leak scenario from §6.3 below as a scenario variant. The suite already exposes the
   registry probe `registeredTableCount` for exactly this class of assertion
   (`packages/testing/src/engine-conformance.ts:493-501`, used at `:2178-2213`).
2. **Hostile-wire / pre-execution refusals:** malformed `comparisonId`/`tableId`, unknown request
   types and extra fields refused at parse (`protocol.ts:896` ff.); `wrong-identity` close on the
   live session handle and on a comparison id refused before any DuckDB call; `busy` refused while
   a query-lane op holds the handle; `already-closed` distinguished from `unknown-handle`.
3. **Leak test:** stage N comparisons (N ≥ 3, including one failed stage and one superseded
   in-flight stage), then assert the registry size equals the pre-stage baseline
   (`TableRegistry.size`, `packages/engine-duckdb/src/table-registry.ts:101-103`) — "N comparisons
   then registry size back to baseline". Also assert the comparison slot count stays ≤ 1.
4. **Mutation drill:** delete the close-in-`finally` (or make `profileComparison` fall back to
   open+profile) → the leak test must fail; widen the `transient` identity check to accept any
   handle → the `wrong-identity` refusal test must fail.

## 7. Files reserved for a later implementation brief (nothing implemented)

| Path                                                                                                                                                                                                  | Role in the implementation                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `packages/engine-duckdb/src/protocol.ts`                                                                                                                                                              | new request/response types + parse paths; additive `transient` field     |
| `packages/engine-duckdb/src/client.ts`                                                                                                                                                                | `profileComparison` / `closeTable` client methods                        |
| `packages/engine-duckdb/src/engine-executor.ts`                                                                                                                                                       | dispatch cases, close bookkeeping, busy/tombstone tracking               |
| `packages/engine-duckdb/src/table-registry.ts`                                                                                                                                                        | transient tagging, tombstone set, cap K                                  |
| `packages/engine-duckdb/src/comparison-registry.ts`                                                                                                                                                   | comparison resolution for `profileComparison` (no shape change expected) |
| `apps/web/src/sessions/useDiffSession.ts`                                                                                                                                                             | caller switch: drop the transient `open`, adopt `profileComparison`      |
| `packages/engine-duckdb/src/{client,engine-executor,protocol}.test.ts`, `packages/testing/src/engine-conformance.ts`, web session/diff tests, `tests/e2e/engine-profile.spec.ts`/`diff-panel.spec.ts` | per §6                                                                   |
| changesets: `@assay/engine-duckdb` (minor — new ops), `@assay/web` (caller), `@assay/testing` if the conformance surface grows                                                                        | per repo policy                                                          |

## 8. Open decisions the maintainer owns

- **Op naming:** client/wire names (`profileComparison` vs `profileComparisonView`;
  `closeTable` vs `releaseTable` — ADR 0047 quotes both spellings).
- **Retention window:** immediate drop (recommended) vs a short grace window before the drop.
- **Refusal copy:** user-facing text for each refusal category (engine errors stay masked per the
  AR-2/R1 posture; copy is a selection, not a default).
- **Whether `closeTable` ships at all:** `profileComparison` alone fixes the leak at source;
  `closeTable` is the scoped release primitive for any remaining transient use.
- **Cap K** for unclosed transient handles (§3.6).
- **Scope confirmation:** that the web session-replacement population stays out of scope and ADR
  0047 is not reopened (§1) — if the maintainer wants replacement-path reclamation, this spec
  stops and an ADR supersedes 0047 instead.

## 9. What is NOT claimed

- **Nothing here is implemented.** This record authorizes no code, no wire change and no changeset.
- ADR 0047 is not reopened, weakened or superseded by this record (§1); its accepted retention
  stands unchanged until a separate decision.
- No bound is claimed for the ADR 0047 replacement-path population, the pipeline `registerView`
  population, or the preview slot — separate lifecycles, out of scope.
- No memory, wall-clock or bundle-size numbers are measured in this record (none measured = none
  claimed).
- No user-visible diff-panel behaviour change: results, copy, layout and the preview payload are
  unchanged (§4).

## 10. Authority and sources

- Authority order per [AGENTS.md](../../../AGENTS.md): accepted ADRs first; this record is dated
  queue/design tier and outranks nothing above it.
- [Successor queue](20261121-successor-queue.md) §3 B3 row (task statement + ADR-0047-check
  instruction); [post-MVP §6](../../product/04-post-mvp-track.md#6-pt-h--hardening--backlog-inventory-recorded-carry-overs)
  (carry-over inventory; "verify each item against today's tree" — §2 above is that verification).
- [ADR 0047](../../adr/0047-web-session-replacement-retains-retired-tables.md) (check target),
  [ADR 0040](../../adr/0040-two-op-lanes-in-engine-worker.md) (lane routing the ops join),
  ADR 0025/0046/0049/0051 posture as cited in §4.
- [WF-05 design](20261110-wf05-replacement-design.md) §5.2 B1; `.changeset/web-ar-2-correctness-batch.md`;
  `apps/web/src/App.tsx:1150-1157` — the two in-repo records of this carry-over.
- Code anchors as cited in §2, §3 and §6 (verified at this revision by read/grep of the named
  files; line numbers will drift and must be re-verified at implementation time).
