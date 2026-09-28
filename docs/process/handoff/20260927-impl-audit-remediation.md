# AU-3 — Implementation audit (round 3): record + remediation queue

> **Arc record (2026-09-27).** Four-lane implementation audit — ENGINE
> (`engine-duckdb`+`domain`+`data-sources`), WEB (`apps/web`+`grid`),
> VALIDATION+CONTRACTS+DIFF, CLI+EXPORTS+TESTING — run by four independent
> reviewer agents with adversarial drills (live DuckDB 1.5.5 via `@duckdb/node-api`,
> hostile inputs, /tmp-only mutation), then orchestrator re-verification of **every**
> critical and should-fix by direct code-read + arithmetic. This file is the durable
> record + the queue; the [open-threads map](20260926-open-threads.md) and
> [handoff §6](../handoff.md) point here. Baseline: HEAD `e603bcf`, all six gates
> green (1866 unit / 144+1 e2e). **No code changed in this arc** — remediation is
> the queue below.
>
> Companion queue: AU-2 follow-ups (f-1…f-11, docs/QoL/refactor) live in
> [20260927-audit-remediation.md](20260927-audit-remediation.md). No overlap; see
> §4 sequencing.

## 1. Findings ledger (verified)

| ID   | Severity | One-line summary                                                                                                                                                                                                                                                                                 | Home                                                                                        |
| ---- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| C1   | Critical | CSV export **header row** bypasses the formula-injection guard: column named `=SUM(A2:A3)` exports raw as row 1 (values guarded, names verbatim via `COPY … HEADER true`)                                                                                                                        | `engine-duckdb/src/overlay-query.ts:427,987`                                                |
| C2   | Critical | Row-diff **compared** (non-key) columns have no type policy: VARCHAR→INTEGER drift compiles `ok: true`, then DuckDB throws a value-bearing `Conversion Error` at execution. Keys ARE gated (`keyTypesCompatible`, :663) — compared columns are not. Zero test coverage of drifted shared columns | `diff/src/row-diff-compile.ts:663,683,505,532`                                              |
| S1   | Should   | Formula-guard trigger set omits **LF** (`chr(10)`): leading-LF `=cmd` exports raw while tab/CR twins are prefixed (OWASP includes LF). Engine guard + web mirror both                                                                                                                            | `overlay-query.ts:427`, `apps/web/src/validation/report-export.ts:127-135`                  |
| S2   | Should   | `runExport` is the one overlay path whose engine errors cross the worker boundary **raw** (others wrap in `validationStep(OVERLAY_MATERIALIZATION_FAILURE)`) — a failing cast surfaces DuckDB's cell-content text                                                                                | `engine-duckdb/src/engine-executor.ts:1330-1360`                                            |
| S3   | Should   | `client.send()`: `pending.set(...)` then unguarded `postMessage` — uncloneable `File` (never client-side `instanceof`-checked) → raw TypeError + stale pending entry until an unrelated sweep                                                                                                    | `engine-duckdb/src/client.ts:918-927`                                                       |
| S4   | Should   | DOM-id collision class regression: `pathId`/`nodePathId` use the lossy `[^A-Za-z0-9_-]→-` mapping AR-W11 already fixed in FilterBar (`a.b`≡`a-b`); RecordInspector expansion key `path+'/'+key` ambiguous when a key contains `/`                                                                | `apps/web/src/schema/SchemaPanel.tsx:364`, `apps/web/src/record/RecordInspector.tsx:92,162` |
| S5   | Should   | ARIA grid pattern gap: rows are the only tab stops; no arrow-key/roving-tabindex cell navigation                                                                                                                                                                                                 | `apps/web/src/grid/DataGrid.tsx:453,461`                                                    |
| S6   | Should   | ExportDialog: document-level Escape unmounts during `working` while buttons are disabled → in-flight export still writes, no result line                                                                                                                                                         | `apps/web/src/export/ExportDialog.tsx:126-135,225,235`                                      |
| S7   | Should   | RE2 checker enforces per-quantifier ≤1000 but DuckDB 1.5.5 enforces the **product**: `(a{32}){32}` checker-valid, engine-throws                                                                                                                                                                  | `validation/src/re2.ts:114,311-335` (mirror: `contracts/src/re2-subset.ts:471`)             |
| S8   | Should   | `serializeContract` "total" claim falsifiable: `Object.create(null)` name / throwing getter / `{toString:null}` throw (pin feeds only tame garbage)                                                                                                                                              | `contracts/src/serialize.ts:31,139-140` (pin: `serialize.test.ts:226`)                      |
| S9   | Should   | pack-consumer-smoke runs only `--version/--help/profile` — `validate`/`diff`, `--format json`, non-zero exits never exercised through the installed bin                                                                                                                                          | `apps/cli/scripts/pack-consumer-smoke.mjs:217-227`                                          |
| Q-\* | QoL      | See §3 (oracle self-blindness ×2, 740 kB main bundle, no-BOM CSV, unversioned JSON reports, `-0` normalization, surrogate-range reasons, CLI edge consistency, engine misc, web misc)                                                                                                            | various                                                                                     |

**Verified-solid (do not re-audit cheaply):** `type-expr.ts` 3-layer closed validator
(defeated every injection attempt incl. comments/dollar-quotes/NUL-in-type-position);
identifier/literal escaping; `OpChannel` FIFO + cross-lane dispose barrier; containment
transactions (always-rolled-back, drop-only-what-we-created); prototype-pollution probes
pinned; **zero** `innerHTML`/`dangerouslySetInnerHTML`/network calls in `apps/web`; no
`new RegExp(` on contract input anywhere in validation/contracts/diff (ReDoS surface empty);
CLI exit-code/stderr/ANSI discipline pinned; node-executor reuses engine SQL (no fork);
`@assay/security` honest scaffold. Reviewer drills lived under `/tmp/vc-audit`,
`/tmp/engine-audit` (scratch — may not survive; repro recipes are embedded in the tasks).

## 2. Remediation queue (pick-up-cold; execute per the operating model)

### P0 — security/correctness closure

#### au3-1 — CSV export guard closure (C1 + S1) · **LANDED 2026-09-27, `9728666`** (worker → independent reviewer **approve**; live-DuckDB drills: all 7 trigger headers guarded through real COPY, benign CSV/jsonl byte-identical, rename-to-hostile + insert covered; conformance leg non-vacuous via `skipsCsvHeaderGuard` mutation). Rider docs: guarded-alias collision + read_csv CR/LF-header corner recorded in `csvHeaderGuardName` docs. Conformance leg covers the 4 leading triggers (read_csv cannot re-open CR/LF/tab headers — sniffer); all 7 pinned at composed-SQL level

- **Problem.** `formulaInjectionGuardSql` (`overlay-query.ts:427`) wraps cell _expressions_
  only; the CSV COPY projection (`composeOverlayExportSql` ~`:987`, `HEADER true`) writes
  column **names** verbatim. Drill (live `@duckdb/node-api` 1.5.5): fixture with a column
  literally named `=SUM(A2:A3)` → header row exports `dept,=SUM(A2:A3),+cmd,…` raw while the
  same run's _values_ were correctly prefixed. Trigger set is `'=','+','-','@',chr(9),chr(13)`
  — no `chr(10)`; drill: `␊=cmd` exports raw, `\t=tab`/`\r=cr` prefixed. Web mirror
  (`apps/web/src/validation/report-export.ts:127-135`) has the same narrow set.
- **Why.** AGENTS.md hard rule "formula-injection-safe CSV export"; SECURITY.md pt0-2; OWASP
  mitigation list includes LF; the header is row 1 of any spreadsheet. The conformance oracle
  cannot see it (fixtures have benign column names — `harness/conformance-subject.ts:287-291`).
- **Done-when.**
  1. Engine guard: add `chr(10)` to the `contains()` checks and trigger set; **CSV path only**:
     alias every projected column to its guarded name (same trigger logic applied to
     identifiers — apostrophe-prefix on trigger-leading/containing names) in base AND insert
     branches of `composeOverlayExportSelectSql`; json/jsonl/parquet/arrow outputs byte-identical
     (names are data keys there, not formulas — do NOT alias).
  2. Web mirror: same trigger-set fix (report-export text path).
  3. Conformance/e2e: bait-metadata fixture leg — column names `=SUM(..)`, `+x`, `-x`, `@x`,
     `\t=x`, `\r=x`, `\n=x` — pinned so exported **header row** is guarded (extend the existing
     sanitization non-vacuity precondition to headers).
  4. Goldens byte-diffs reviewed deliberately; changeset (patch, engine-duckdb + web).
- **Guardrails.** Don't alter cell-value semantics beyond LF; no new trigger vocabulary;
  aliasing must round-trip nothing (names are display-only in CSV); keep Arrow stream path
  untouched (it has no header row).
- **Boundary probe — OPEN follow-up (pick up with au3-3).** NUL-in-string, 4-byte emoji, lone surrogate
  through edit→materialize→export against the real wasm bundle (speculative lane-1 finding:
  `sqlStringLiteral` cannot escape `\u0000` — expected to fail loudly, verify it does).

#### au3-2 — row-diff compared-column type policy (C2) · **LANDED 2026-09-27, `d531658`** (worker → independent reviewer **approve**). Reviewer-verified judgment call: the JSON-compared-column tightening (from verbatim `keyTypesCompatible` reuse) is **accepted** — no surface ever offered JSON compared columns, and a live engine probe showed textual JSON equality yields false "changed" rows (`{"x":1,"y":2}` IS DISTINCT FROM `{"y":2,"x":1}` → true), so refusing is safer than the old silent behavior. Property pins recomputed 251/149 → 128/272, still non-vacuous both directions

- **Problem.** Keys get `keyTypesCompatible` (`row-diff-compile.ts:663`); shared non-key
  columns (:683) go straight to `changedSource` → `IS DISTINCT FROM` (:505,:532). Drill: side A
  `VARCHAR`, side B `INTEGER` on a compared column → plan `ok: true`; real DuckDB 1.5.5 throws
  `Conversion Error: Could not convert string 'x' to INT32` (value-bearing). The package's own
  doc justifies refusing JSON keys with exactly this asymmetry argument — compared columns were
  missed. No golden/property/wire test mentions drifted shared columns.
- **Done-when.**
  1. Classify both sides of **every** compared column with the existing `classifyColumnType`;
     refuse cross-family (and mismatched `'other'` spellings) as a new typed binding error
     `shared-column-type-mismatch`, message mirroring `key-type-mismatch` shape (names + types,
     value-free); **reuse `keyTypesCompatible` policy verbatim** (same-family numeric widening
     stays allowed) — do not invent a second policy.
  2. Goldens + one real-DuckDB wire/agreement test (compile-refused now, not execute-failed);
     property-suite case that drifted compared columns never produce `ok:true`.
  3. Changeset (patch, diff).
- **Guardrails.** Error attribution fields follow the existing taxonomy (side/column refs);
  no behavior change for same-family pairs (existing goldens must stay byte-identical).

#### au3-3 — export error value-free wrapping (S2) · **LANDED 2026-09-27, `eb094c1`** (worker → reviewer request-changes → fix round → **approve**). All four engine-touching steps (arrow drain, COPY, fallback count, wasm byte read) collapse to the fixed value-free `EXPORT_MATERIALIZATION_FAILURE`; composers stay OUTSIDE the wrap (typed errors reach the wire unchanged — the reviewer's one blocker, fixed in-round); `{cause}` deliberately NOT attached, matching the validationStep idiom's ADR 0025 policy (the brief's 'cause preserved' wording was wrong — the idiom wins). Hostile pins proven non-vacuous by reviewer mutation drill

- **Problem.** Every other overlay op wraps `conn.*` in
  `validationStep(OVERLAY_MATERIALIZATION_FAILURE)`; `runExport`'s `drainAllBatches`,
  `conn.query(copySql)`, and COPY-fallback count are unwrapped
  (`engine-executor.ts:1330-1360`); the only export-error test pins the raw passthrough
  (`engine-executor.test.ts:1878-1884`, `'wasm fs read failed'`).
- **Done-when.** Export engine steps wrapped in the fixed value-free class (q-8 idiom — "the
  view could not be exported"); dep-error path typed; hostile-value pin (pending failing cast →
  export error carries **no cell text**); the raw-passthrough pin updated deliberately.
  Changeset (patch, engine-duckdb).

### P1 — hardening

#### au3-4 — `client.send()` postMessage hardening (S3) · **LANDED 2026-09-27, `60f130d`** (worker → reviewer request-changes → fix round → **approve**). Reviewer taxonomy ruling adopted: all three new throws are `EngineOperationError` (main-thread request defect; wire-parity with the worker-side malformed-envelope path; matches the six sibling pre-send validations) — `EngineProtocolError` stays response-side-only. Pins mutation-proven (try/catch removed → pin fails; guard removed → posted+pending assertions fail)

- **Problem.** `pending.set(requestId, …)` then unguarded `worker.postMessage(request)`
  (`client.ts:918-927`). Drill: `open()` with an uncloneable `file` (fake worker throws from
  `postMessage`) → rejection with the raw `TypeError` AND `pending.size === 1` until an
  unrelated `crash()`/`dispose()` sweep. `open()`/`stageComparison()` never `instanceof File`
  client-side (the worker's `isFile` check never runs — the post failed).
- **Done-when.** try/catch around `postMessage` → `pending.delete` + typed
  `EngineProtocolError`; client-side `File` validation in `open()`/`stageComparison()`;
  throwing-worker unit test pinning rejection type + `pending.size === 0` after; AR-E3 comment
  updated. Changeset (patch, engine-duckdb).

#### au3-5 — DOM-id injective encoding + unambiguous tree paths (S4) · **LANDED 2026-09-27, `4635f16`** (worker → reviewer request-changes → fix round → **approve**). Shared `lib/dom-id.ts` (AR-W11 hex grammar, FilterBar unified); both grammars reviewer-proven injective. The reviewer's blocker — SchemaPanel expansion keys were still raw concat (`x/y` column vs child `y` of `x` state bleed, drill-proven) — fixed via `encodePath(segments)` mirroring RecordInspector; the new pin was mutation-proven to discriminate (raw keys → pin fails on the exact symptom). E2E grepped clean (no spec depends on the old id/path grammar)

- **Problem.** `pathId` (`SchemaPanel.tsx:364`) and `nodePathId` (`RecordInspector.tsx:92`)
  map through the lossy `[^A-Za-z0-9_-]→-` filter — `f('a.b') === f('a-b')` (verified) →
  duplicate DOM ids + mispointing `aria-controls` when siblings collide; this is the **exact**
  bug class AR-W11 fixed and documented in `FilterBar.tsx:16-22` (hex encoding, pinned in
  `FilterBar.test.tsx:29`). Separately, expansion state keys are raw
  `` `${path}/${child.key}` `` (`RecordInspector.tsx:162`) — a struct key containing `/` is
  indistinguishable from nesting.
- **Done-when.** Port the AR-W11 hex encoding to both call sites (shared `apps/web` helper or
  local copies — app-internal, dependency rules fine); expansion keys built from encoded
  segments; collision pins mirroring `FilterBar.test.tsx` (`a.b` vs `a-b`, key `x/y` vs child
  `y` of `x`); `aria-controls` uniqueness asserted. Changeset (patch, web).

#### au3-6 — pack-consumer-smoke coverage legs (S9) · **LANDED 2026-09-27, `ec5dc83`** (worker → reviewer **approve**; assertions byte-pinned to validate.ts/report.ts source behavior; three mutation drills — sabotaged fixture, wrong marker, wrong stderr byte — all fail loudly; smoke 6.5 s « 30 s)

- **Problem.** Smoke step 5/5 (`pack-consumer-smoke.mjs:217-227`) runs `--version`, `--help`,
  `profile` (exit 0 only). The flagship `validate`/`diff` pipelines, `--format json`, and every
  non-zero exit never run through the **installed** bin.
- **Done-when.** Add a `validate` leg over a dirty fixture (assert exit 1 + `report:` marker in
  stdout) and one exit-2 usage-error leg; smoke stays < 30 s in CI. No changeset (repo script).

#### au3-7 — RE2 nested-repetition product bound (S7) · **LANDED 2026-09-27, `97e777f`** (worker → reviewer **approve**). The drilled real DuckDB 1.5.5 bound: **product of repeat factors along one atom's expansion path ≤ 1000** ({n,m}→max, {n}/{n,}→n, */+/?→1, empty group→1, alternation→max branch, anchors count) — NOT 1024 and NOT a sum across sequences (`a{600}b{600}` stays accepted; over-refusal trap drilled). Both mirrored checkers fixed with byte-identical reasons; agreement pool 65→70 (accepted run in the gated real-CLI leg); +19 tests

- **Problem.** The checker enforces the per-quantifier limit (`{n},{n,m} ≤ 1000`) but DuckDB
  1.5.5 enforces the **product**: `(a{100}){10}` runs, `(a{32}){32}` (=1024) throws
  `invalid repetition size` — while `checkRe2Pattern('(a{1000}){1000}')` says `valid: true`.
  Drills: nested quantifiers absent from the 50-pattern agreement pool, so the pin can't see it.
  Both checkers need it: `validation/src/re2.ts:114,311-335` and
  `contracts/src/re2-subset.ts:471` (verify whether they're shared or mirrored before fixing).
- **Done-when.** Track each atom's repeat expansion during parse; refuse when a quantifier
  would push the product past 1000 (mirror the DuckDB bound, cite it in a comment); add
  nested-repeat patterns to the agreement pool (incl. the boundary `=1000` ok / `=1024`
  refused); permanent test from the drill. Changeset (patch, validation + contracts).

### P2 — quality backlog

#### au3-8 — grid keyboard conformance (S5) · worker+reviewer · 0.5–1 d

- **Problem.** `role="grid"` rows are the only tab stops; cells `tabIndex={-1}`; no
  Arrow/Home/End navigation, no roving tabindex (`DataGrid.tsx:453,461`) — fails the WAI-ARIA
  grid pattern the product otherwise follows (aria-rowcount/rowindex are correct).
- **Done-when.** Roving tabindex on rows + arrow-key cell reachability; Enter/Escape edit
  semantics unchanged; e2e keyboard-nav pin (+ axe if cheap). **Sequence with f-2** (both touch
  DataGrid rendering — land this first, or one session owns both).
  Changeset (patch, web).

#### au3-9 — ExportDialog working-state escape (S6) · **LANDED 2026-09-28, `335e401`** (worker → reviewer **approve**; ref currency drilled under worst-case synthetic event ordering; pins mutation-proven both directions — close-always/close-never/close-only-when-idle all discriminated)

- **Problem.** Document-level Escape closes (unmounts) the dialog during `working`
  (`ExportDialog.tsx:126-135`) while Close/Export buttons are disabled (:225,:235) — the
  in-flight `run()` still writes the export with no visible result line.
- **Done-when.** Escape ignored while `working` (or dialog stays mounted until settlement);
  pin: Escape during working → export completes + result line visible. Changeset (patch, web).

#### au3-10 — serializeContract totality + surrogate ranges (S8 + QoL) · **LANDED 2026-09-28, `3f5aadd`** (worker → reviewer **approve**). Total renderer mirrors compile.ts describeOptionValue; reviewer's zero-trap Proxy drill proved totality; REAL code-point fix (not reason-text fallback): `[😀-😄]` accepted, reversed ranges get true code-point reasons, lone-surrogate endpoints fail closed, cross-validated vs pinned DuckDB on six extra patterns; -0 note correctly skipped (docs already accurate)

- **Problem.** Module doc promises "degrades to deterministic plain output rather than a raw
  throw" — falsified by `metadata.name = Object.create(null)` (→ `TypeError: Cannot convert
object to primitive value`, the exact hazard `compile.ts` documents and guards elsewhere),
  a throwing getter, and `{toString:null}`; the pin (`serialize.test.ts:226`) feeds only tame
  garbage. Same hazard via `asText(column?.name)` (`:78`). Also: surrogate-pair class ranges
  are measured per code unit in both RE2 checkers (`re2.ts:528`, `re2-subset.ts:471`) →
  factually wrong "reversed range" reason for valid `[😀-😄]` (fail-closed, wrong message).
- **Done-when.** Total renderer for unknown shapes (never `String(obj)` on hostile input);
  widen the pin to the three throwing shapes; code-point-aware class ranges (or corrected
  reason text if strictness is kept deliberately). Changeset (patch, contracts + validation).

#### au3-11 — oracle de-hardcoding (systemic QoL) · worker+reviewer · 2–4 h

- **Problem.** Two places where the oracle cannot see new surface: (a)
  `testing/src/data-source-behavior.ts:~330-355` hardcodes the probed formats — the shipped
  adapter also detects `arrow`/`feather` (`data-sources/src/detect-format.ts:15`), verifiable
  only by unit tests, never by the mandated same-suite; (b)
  `tests/e2e/engine-conformance.spec.ts:19-41` hand-copies the scenario-name list — a new
  scenario missing from the copy silently never runs in e2e (:274's assertion is
  self-consistent with the copy, not the package export).
- **Done-when.** (a) format matrix subject-declared with a completeness precondition against
  the adapter's detect map (the suite's own non-vacuity idiom) + arrow/feather behavior cases;
  (b) e2e asserts against `engineConformanceScenarioNames` dynamically. Changeset (patch,
  testing + e2e).

#### au3-12 — QoL residue batch · mixed solo/worker · 0.5–1 d, split freely

- **Bundle:** dynamic-`import()` the below-fold panels (Validation/Diff/Profile/SQL);
  measure before/after (baseline: main 740 kB min / 207 kB gzip; engine/DuckDB workers already
  split correctly).
- **CSV BOM decision** (needs a one-line ruling: BOM for Excel double-click vs documented
  non-goal — fold the decision into the au3-1 guard doc or a tiny ADR if it grows).
- **CLI:** `reportVersion` field in `--format json` outputs; `validate` rejects extra
  positionals (match `profile`/`diff`); `FORCE_COLOR=''` vs `NO_COLOR` doc/code alignment
  (`apps/cli/src/style.ts:106-116`).
- **Engine misc:** `table-registry.ts:43` doc fix (`confirm()` → `remove()`); document or
  normalize `-0`→`+0` edit materialization (`edit-ops.ts:65` vs `overlay-query.ts:345`);
  dispose-racing-boot fail-first (`client.ts:806-820`); `streamFirstBatch` cancel-failure
  policy (`engine-executor.ts:1650-1658`).
- **Web misc:** inspector `close()` focus restore (`RecordInspector.tsx:256`);
  DiffPanel candidate key collision (`DiffPanel.tsx:564`); `handleUndo/Redo` read
  `historyRef.current` like the cast path (`App.tsx:526-537,489`).
- **Schema-side QoL (lane 3):** case-variant duplicate column-name guard in
  `diff/input-validation.ts:63-118` (cheap `toLowerCase` uniqueness).

#### au3-13 — lone-surrogate well-formedness guard at the cell-literal boundary · **LANDED 2026-09-27, `64b89cb`** (worker → reviewer **approve** first pass). All four risks honored; scan algorithm survived a 16-case adversarial drill (incl. the high+high trap); DEFECT pins flipped per the file's documented protocol; mutation drill: guard removed → 4 pins fail

- **Problem.** From the au3-1 boundary probe (verified by two independent workers + reviewer): a
  `cell-set` whose value contains an unpaired surrogate (`\uD800`) silently materializes AND
  exports as U+FFFD — silent data corruption, violating lossless-or-loud and the NUL precedent
  (same root-cause shape: the composer emits SQL the engine cannot faithfully take).
- **Done-when.** Reject unpaired surrogates **loudly and value-free** at the cell-literal entry
  (guard in `cellLiteralSql`/`cellLiteralRawSql` territory in `overlay-query.ts`, mirroring the
  existing non-finite-number guard ~:349 — NOT blanket inside `sqlStringLiteral`, which also
  encodes engine-generated destinations). Four reviewer-specified risks to honor:
  (1) guard **only user-entered literal values** — base-data passthrough stays unguarded (a
  U+FFFD already in a file is a legitimate character; the base-source NUL pin is the precedent);
  (2) the message names the defect, never echoes the cell text; (3) update the
  `export-boundary.test.ts` DEFECT pin in the same change (that file documents the protocol);
  (4) loud-and-actionable is the desired UX for surrogates pasted from broken sources — not a
  regression. Changeset (patch, engine-duckdb).

## 3. Systemic recommendation (adopt as convention)

**Adversarial fixtures must attack metadata, not just values.** C1 (column _names_ bypass the
guard), C2 (column _types_ bypass the policy), S9-blindness (benign fixture names), and au3-11
(hardcoded matrices) are one bug class wearing four hats. Convention: every new guard/policy
ships with a **bait-metadata fixture** (hostile names, drifted types, case-variant spellings)
alongside its hostile-value fixtures, and oracle matrices are declared by the subject, not
hand-copied by the oracle.

## 4. Sequencing notes (vs AU-2 f-queue and rulings)

- **au3-8 before/with f-2** (both restructure DataGrid rendering); au3-5 is independent of
  f-1 (different files). Everything else interleaves freely.
- P0 (au3-1…au3-3) is self-serve — no maintainer ruling blocks it. The CSV BOM question
  (au3-12) is the only new mini-ruling; C-pt0-1/D12/D13 remain the standing human queue.
- Remaining: **au3-8** (grid keyboard — sequence with the f-2 DataGrid session, do not start
  solo) and **au3-12** (QoL residue batch — fold in au3-11's residual hand-copy follow-up).
  Landed: au3-1…7, au3-9/10/11, au3-13 + boundary probe (2026-09-27/28; P0+P1 complete,
  P2 3/5). Unit baseline: **1941** (was 1866); e2e 144+1 unchanged; pack smoke covers
  validate/--format json/exit-1/exit-2 through the installed bin.
