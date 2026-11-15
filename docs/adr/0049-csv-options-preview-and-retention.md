# ADR 0049: CSV options ride a typed allowlist on a preview op that owns its own registration

## Status

Proposed

## Date

Proposed 2026-11-15

## Deciders

- Maintainer (product policy owner for the CSV decision ledger, EW-03D §8)
- Maintainer + engine/protocol owner (protocol-carrier and lifecycle rows)

## Context

**Nothing today carries a CSV option.** Format selection is extension-only twice
(`@assay/data-sources` `detectFormatFromFileName` and the engine's `detectFileFormat`), and the scan is
`read_csv(<engine-generated name>)` with zero arguments (`packages/engine-duckdb/src/format-view.ts`
`fileScanSql`/`createViewSql`). Delimiter, header, quoting, types, nulls and dates are therefore
DuckDB's own sniffer decision, invisible to the user. The protocol has no place to put them:
`EngineOpenRequest` is `{type, requestId, name, file}` and `EngineOpenResultResponse` is
`{tableId, format}`; there is no `engine/preview`, `engine/sniff`, `engine/cancel` or `engine/release`,
and the only generic escape hatch is arbitrary SQL text on `engine/query`
(`packages/engine-duckdb/src/protocol.ts`). Registering a candidate's bytes is likewise
indistinguishable from manufacturing a registered view plus a `TableRegistry` entry, because
`runOpen` always performs _reserve → registerFileHandle → `CREATE VIEW "assay_tN"`_
(`packages/engine-duckdb/src/engine-executor.ts`).

The [EW-03D CSV interpretation contract](../process/handoff/20261113-ew03-csv-contract.md) settled the
evidence: a workable option vocabulary exists (§2.1), the installed build accepts `delim` but refuses
`delimiter`/`separator` (B4/L7), `ignore_errors` silently drops rows (M3: `count(*) = 119999`),
`store_rejects` manufactures two user tables holding raw CSV lines (A0/M8), and `sniff_csv` already
returns the whole disclosure payload — delimiter, quote, escape, newline, comment, skip rows, header,
per-column types, date format and a copyable `Prompt` (B1/B2/B9). Its review rounds fixed the
lifecycle facts: **route (a)**, a genuinely registration-free candidate preview, is **unproven** —
probe M5 proved catalog neutrality only for names the harness had _already registered_, and M7 only
showed that `insertCSVFromPath` materializes a user table; neither exercised candidate acquisition,
abandonment or retention (§4.0, §4.2). **Route (b)**, a single-slot registering preview, is the honest
fallback shaped like today's code, and it is _retain-all_ unless an ADR grants a registry-consistent
lifecycle (§4.1) — because [ADR 0047](0047-web-session-replacement-retains-retired-tables.md) records
that `@assay/engine-duckdb` has **no per-table release**: `dispose()` is terminal and reclaims the
whole instance, `TableRegistry.remove` is reachable only from the failed-open rollback, and `dropFile`
has no protocol op at all (probe I6: after `dropFile`, `copyFileToBuffer` returned 1 byte instead of
throwing; no repo test covers it).

Two accepted decisions bound this one. [ADR 0048](0048-engine-bundle-selection-and-honest-error-text.md)
made engine error text honest on wasm-EH-capable browsers, which removed the classification blocker
(D10) but kept every capability claim bundle-dependent. And the
[post-R1 acceptance record](../process/handoff/20261114-post-r1-decisions-accepted.md) accepted the
EW-03D ledger **as a block** while keeping **D12 separate**: no protocol or option-carrier work before
D12 has its own ADR, and the D12 row exists to settle the route, not to implement it. This is that ADR.
It records what can be decided on the evidence the contract actually has, and it names what cannot.

**Evidence limits of this ADR.** No browser run, probe, build or test was executed to write it; every
measurement cited here is quoted from the EW-03D contract, not re-measured. Nothing in it is implemented
or approved.

## Decision

1. **Option carrier.** CSV interpretation options travel as one typed, closed-vocabulary `CsvOptions`
   object on **two** request shapes: a new `engine/csv-preview` request (non-adopting review), and an
   optional options field on `engine/open` (adoption of an already-reviewed set). Nothing else carries
   CSV options: `engine/query` stays free SQL text and is never the CSV path, and no option string,
   `SET` statement or interpolated SQL fragment crosses the boundary. Both request shapes are protocol
   changes; this ADR authorizes their design, not their implementation.
2. **Allowlist.** The vocabulary is closed and compiled into the engine package (a `csv-options` module
   beside `format-view.ts`) as the single source of truth, imported by the web surface rather than
   duplicated there:
   - **Accepted:** `header`, `delim` (alias `sep`), `quote`, `escape`, `columns`/`types`, `all_varchar`,
     `nullstr`, `dateformat`, `comment`, `skip`; `sample_size` accepted for **inference only**.
   - **Deferred (refused until a separate decision):** `strict_mode`, `null_padding`, `parallel`,
     `encoding`, `compression`, `max_line_size`, `buffer_size`, `decimal_separator`, `thousands`. The
     last two may only ever be explicit user settings — never inferred from a locale.
   - **Refused always:** `ignore_errors`, `store_rejects`/`rejects_*`, `delimiter`/`separator`,
     `filename`, `union_by_name`, `hive_*`, `files_to_sniff`, `column_names`, `names`,
     `normalize_names`, `force_match`, `auto_detect`, `auto_type_candidates`, and any key not in the
     vocabulary.
3. **Validation and composition.** Options are validated **twice** — on the main thread and again in
   the worker, because the main thread is untrusted — and an unknown or out-of-vocabulary key is
   refused **before dispatch**, never passed to DuckDB to fail opaquely. Type values (in `columns`
   maps and elsewhere) pass `validateEngineTypeExpression` in both passes. SQL composition reuses the
   existing quoting helpers (`quotedIdentifier`, `sqlStringLiteral`) and engine-generated names only:
   **user text never becomes an identifier or an option name**, and `sniff_csv`'s `Prompt` is display
   evidence, never a template to execute. The contract's §2.2 rules 1–6 are adopted as this ADR's
   composition rule.
4. **Preview is non-adopting, and the preview slot owns its own registration.** `engine/csv-preview` is
   served by a worker-side **single-slot `PreviewRegistry`** modelled on
   `ComparisonRegistry` — its own id sequence (`p1…`), view name (`assay_preview_p1`) and file name
   (`preview_p1`), and it **never inserts into `TableRegistry`**. It registers the candidate's bytes and
   may create its own preview view, and it **drops its own previous view and file before re-staging and
   on abandonment**, the same ordering `runDiffStage` already uses for a staged comparison
   (`engine-executor.ts`). A preview never creates a session table, never sets a ready phase, never
   adopts, and never touches a `TableRegistry` name. **No host-reachable release op is added**: this is
   a preview-owned registration lifecycle, not a per-table release for session tables.
5. **Retention accounting.** Under this route, retained preview state is bounded by the single slot and
   is released by the slot itself; `engine/dispose` remains the only whole-engine reclamation
   (ADR 0047 stands unchanged).

   | Event                                            | Δ retained preview state                                 | Δ session tables |
   | ------------------------------------------------ | -------------------------------------------------------- | ---------------- |
   | pick / acquire, before any preview dispatch      | 0 — abandoning here leaves the engine untouched          | 0                |
   | preview registers the candidate                  | +1 (one slot: file, view, registry entry)                | 0                |
   | option change → re-scan of the same slot         | 0 (re-scans, never re-registrations)                     | 0                |
   | abandon / cancel while the slot is live          | −1 attempted; 0 net if the drop succeeds, +1 if it fails | 0                |
   | supersede with a second candidate                | 0 net (+1 new, −1 old)                                   | 0                |
   | failure after the slot registered                | +1 until the next slot event or `engine/dispose`         | 0                |
   | adoption (fresh `engine/open` with reviewed set) | −1 (slot released)                                       | +1               |
   | `engine/dispose`                                 | releases everything                                      | —                |

   **Honest fallback if the slot's own release is not granted** (open question 2): retain-all per
   EW-03D §4.1 — **+1 for every registration-making event**, held until `engine/dispose`, so an
   abandoned preview costs nothing only when abandoned _before_ registration and every superseded
   candidate costs a permanent +1. This ADR assumes no release primitive beyond the worker-side
   `DROP VIEW` + `deps.dropFile` pair that `runDiffStage` already performs.

6. **Sniff disclosure, and a sample is never a check.** A preview returns (a) the `sniff_csv` payload —
   effective delimiter, quote, escape, newline, comment, skip rows, header, per-column name/type, date
   format, and the `Prompt` as copyable display text — (b) the effective option set actually composed,
   and (c) a bounded row sample with its row cap stated. It must never present the sample as
   validation: no "validated", "checked" or "verified" wording, no success state, and `sample_size`
   governs _inference only_. A failure beyond the sniff sample is expected and normal — the 120,000-row
   fixture was sniffed as `BIGINT` and failed at line 110001 (M2/E-series) — so a green preview is a
   statement about a sample, and `count(*)` is never evidence of conversion.
7. **Cancellation and abandonment.** There is **no engine `Cancel` promise** and none is added; no new
   cancel op is part of this decision. The shipped web behaviour stands and is extended to preview
   intents: `cancelOpen` bumps the session/intent token and returns to idle, and abandonment also
   best-effort releases the preview slot. Abandonment never claims a mid-scan abort — a scan already
   queued on a connection runs to completion — and what the user sees is "stopped reviewing"/idle, not
   "operation aborted". Late preview results are dropped by the intent/session token guard, never
   adopted. Adoption is exactly-once, requires the live token, and has no partial state.
8. **Browser-vs-CLI version boundary (D15, standing rule).** The **browser** engine — DuckDB `v1.4.3`
   inside `@duckdb/duckdb-wasm` 1.32.0 — is the only capability truth. The native CLI (1.5.5) is a
   comparison control and is never evidence; it already diverges visibly (`store_rejects` created
   `reject_errors` in the browser build and failed in the CLI, §7.3). Every capability claim this
   decision depends on — which option names are accepted or refused, whether error text is classifiable,
   and what a drop does — must be **re-proven in-browser after any engine bump**, so the allowlist in
   item 2 is a property of the shipped browser build, not of DuckDB in the abstract.
9. **Carried unchanged.** The no-silent-skip rule (item 2's refusals), the no-locale-inference rule, and
   "a sample is never a full check" are **not re-decided here** — they are carried from the contract. No
   telemetry event, field, filename, option value or error text is added (ADR
   [0025](0025-telemetry-and-data-privacy-boundary.md)/[0037](0037-telemetry-opt-out-consent.md)).

## Consequences

### Positive

- The CSV gate's central unknown becomes a written route with a priced lifecycle instead of an
  inference from a design summary.
- A preview can be honest without a release primitive and without superseding ADR 0047: the slot's
  retention is bounded and its release happens inside the owner that created it.
- Quick open keeps its exact current behaviour, so the review path can be added beside it rather than
  rewiring the only shipped acquisition path.
- Option refusal becomes a host decision (pre-dispatch validation) instead of a hope about engine
  message text, which is what makes refusal copy writable on a non-EH browser.
- The D15 rule is stated once, so a future duckdb-wasm bump cannot silently re-derive CSV capability
  from CLI output.

### Negative / risks

- This is a real protocol change — two request shapes, an executor path, a second worker-side registry,
  and conformance tests. Nothing in it is implemented, and it is the largest thing D12 was gating.
- **The acquisition mechanism is unproven.** No probe registered a _fresh_ picked candidate without a
  view; `registerFileHandle(name, file, BROWSER_FILEREADER)` is proven only on the open path, and `dropFile`
  is API-level with untested post-drop semantics (I6). The slot route therefore needs a probe before any
  web wiring.
- A second registry shares DuckDB's single catalog. Distinct prefixes (`p1`/`assay_preview_p1` vs
  `t1`/`assay_tN`) plus tests make a collision unlikely, not impossible by construction.
- Release on abandonment is best-effort: a terminated worker, an engine error, or a failed drop retains
  the slot until `engine/dispose` — ADR 0047's consequence, reduced but not removed.
- Preview scans read the user's real bytes; the wasm heap ceiling is unmeasured and there is no
  progress or timeout op (contract §6.3), so a budget and a refusal path are still owed by the runtime
  row.
- With no telemetry, abandonment frequency and retained bytes are invisible: the retention is disclosed
  in documents, not observed in the field.
- Error classification is still bundle-dependent (ADR 0048): on a non-EH browser a preview failure
  carries no usable engine text, so refusal and failure copy must not depend on it.

### Neutral

- Quick open is byte-identical: `engine/open` without options still runs `read_csv('tN')` over
  extension-detected format into `assay_tN`.
- No engine version, dependency, extension-platform, bundle or lockfile change; no `.ndjson` alias; no
  format-detection change.
- Output formats (validation, diff, pipeline, report, DCR, export) are untouched; preview rows use the
  existing Arrow batch transport and the existing 1000-row window clamp (ADR
  [0020](0020-arrow-as-interchange-format.md), ADR 0040's lane model unchanged).
- ADR 0047 still holds: no per-table release for `TableRegistry` tables, and `engine/dispose` is still
  the only whole-engine reclamation.

## Open questions for the maintainer

1. **Route confirmation.** Accept this route — a registering preview whose slot owns its own release —
   as the target, or hold route (a) (registration-free preview) as a mandatory precondition, or fall
   back to retain-all per EW-03D §4.1? The contract could not prove (a); this ADR does not claim it.
2. **Preview-owned release under ADR 0047.** Is a preview-owned `DROP VIEW` + `dropFile` on its _own_
   slot acceptable, or must previews stay retain-all until dispose? If it is accepted, the ADR should
   say so in the superseding/amending terms the maintainer prefers.
3. **Acquisition mechanism and its probe.** Which registration path must be proven first —
   `registerFileHandle` on the picked `File`, or `registerFileBuffer`/`registerFileText` — and is a
   named probe row required before the protocol row?
4. **Evidence standard for the M5/M7 gap.** Must the implementation row capture a fresh-candidate
   acquire → abandon → supersede probe with catalog deltas (`duckdb_tables()`/`duckdb_views()`
   before/after) _before_ any web wiring, given M5's already-registered-name scope and M7's
   materializing import?
5. **Adoption accounting.** Is the chosen adoption — a fresh `engine/open` carrying the reviewed options
   (+1 session table, preview slot released) — acceptable, or is the contract's exactly-once promotion
   (+0, re-purposing the candidate registration) required? Promotion would hand a preview registration
   into `TableRegistry`, a session-table ownership change that ADR 0047's accounting would have to
   price.
6. **Deferred options.** Keep the deferred list (`strict_mode`, `null_padding`, `parallel`, `encoding`,
   `compression`, `max_line_size`, `buffer_size`, `decimal_separator`, `thousands`) refused, with the
   last two allowed only as explicit user settings and never inferred?
7. **Carrier granularity.** Does disclosure need its own op (a `sniff`-shaped request with no sample
   scan), or is one preview op with an optional bounded sample enough?
8. **Budget and lane ownership.** Who sets the preview/sample scan budget and the over-budget refusal
   (D8/D11 — this ADR sets no numbers), and does preview work sit on the query lane like `runDiffStage`
   or need a third lane (ADR 0040 explicitly leaves that undecided)?

## What this ADR does not decide

- **No runtime row, no implementation.** It does not authorize EW-03I: the post-R1 record allows EW-03I
  only after D12's ADR is _accepted_, and this one is Proposed.
- **No option UI, panel, copy, keyboard/AT design.** D3/D5/D6 wording stays maintainer-owned, and
  EW-02D owns open-path wording.
- **No telemetry** — no event, field, counter, timing or retained-bytes metric (ADR 0025/0037/0045).
- **No dependency, bundle or engine change**: no duckdb-wasm upgrade, no extension-platform change, no
  revisiting of ADR 0048.
- **No `.ndjson` alias, no format-detection change**, no implicit format change of any kind.
- **No change to the no-silent-skip, no-locale-inference or sample-is-not-a-check rules** — they are
  carried, not re-decided.
- **No per-table release primitive and no supersession of ADR 0047**; a host-reachable `engine/release`
  remains out of scope and would be the natural trigger to supersede 0047 instead.
- **No complete-check definition (D8) and no resource budget (D11)**; both stay unresolved in the
  contract.
- **No evidence claim.** M5/M7 establish neither candidate acquisition nor abandonment nor retention,
  K1 cancellation was inconclusive, and this ADR ran no probe of its own.

## Alternatives considered

- **Options only on `engine/open`, no preview op.** Smallest protocol delta, but every option change
  either manufactures a session table or leaves a retained view, so a non-adopting review cannot exist
  and the accounting becomes retain-all by construction.
- **A `sniff`-only op.** Discloses the inferred settings but cannot apply a user option override or show
  a sample, so the user would still adopt blind on the field that matters (`delim`, `header`, types).
- **Registration-free preview as a hard precondition (route a).** Still the ideal outcome and the
  contract's design target, but no probe established that a fresh candidate's bytes reach DuckDB without
  a view; choosing it now would rest the decision on unproven engine behaviour.
- **Per-preview `CREATE VIEW` + raw `DROP VIEW` through `engine/query` (route c).** Rejected: raw DDL
  over a `TableRegistry`-owned name desyncs the registry, which is the hazard D12 exists to avoid.
- **Reuse of an already-registered name (route d).** That is quick open, not a preview: it cannot review
  a different option set for a candidate that has not been adopted.
- **A host-reachable `engine/release`/`dropTable`.** Rejected for now — ADR 0047 priced it and the
  preview slot does not need it — but it stays the better long-term primitive and the natural trigger
  for superseding 0047 if retention ever becomes observable.
