# EW-03D — CSV interpretation contract (typed options, exposure, ownership)

**Status: DESIGN ONLY — no runtime CSV row is authorized by this document.**
Delivered by the EW-03D design agent. This is a contract + decision/probe ledger, not an importer
implementation, not an approval, and not a claim that any proposed behavior ships. Recommendations in
§8 are **recommendations awaiting decision**; every row names its decision owner and status.

- **Review round 1** (independent Luna xhigh → REQUEST-CHANGES, one critical §4 finding): §4 now
  states two unambiguous lifecycles — (a) a preview that must register bytes to scan them
  (§4.1) and (b) a genuinely registration-free preview, marked unproven/ADR-gated (§4.2); §4.0
  narrows what probes M5/M7 actually prove (catalog-neutral ad-hoc scans _after_ harness
  registration — not candidate-file acquisition, abandonment or retention); §3 gate 2 and the
  §7.2 M5/M7 rows are corrected to match; D12 is amended (still **unresolved**). Everything else,
  including all probe evidence and the 15-row decision ledger, is unchanged.
- **Review round 2** (Luna xhigh, two findings, no churn elsewhere): (1) §4.1 resolves the retention
  contradiction in one direction — **retain-all** — with per-event Δ-retained accounting (§4.1,
  mirrored in §4.3): drop-before-restage is reclassified as unavailable today and ADR-gated (it needs
  the lifecycle op of D12 plus a registry-consistent drop); (2) D12's citation of the failed probe I4
  is replaced by M5 (its three `DROP VIEW` statements and restored-catalog capture). Design-only
  status, baseline block, all other sections and the 15 unresolved rows are unchanged.
- **Review round 3** (Luna xhigh, one warning, no other change): adoption is now stated in **one**
  path — the proposed case-(a) adopt is an exactly-once **promotion that reuses the candidate
  registration, Δ +0 new** (ADR-gated with D12, **not available today**), while today's fresh
  `engine/open` (**+1**, preview registration retained) is labelled **current-only behaviour** the
  promotion would replace. §4.1's Δ table, §4.3's phase table and the §4.3 closing sentence now use
  that same wording and delta. Design-only status, baseline and the 15 unresolved rows intact.

- **Source baseline (pinned, verified clean):** `c841fe4332a980ccd6a926b4e7520104068af70a`
  (`git rev-parse HEAD`, `git status --porcelain` → empty, main).
- **Repository access:** read-only. No repository source/test/config/fixture/lockfile/dependency/API
  change; no install; no push; no approval claim; no dataset upload; no real collector; telemetry env
  (`ASSAY_TELEMETRY_ENDPOINT/TOKEN/NO_TELEMETRY`) unset; all probes used synthetic `/tmp` data and
  `127.0.0.1` only.
- **Evidence files (all under `/tmp/assay-ew/`):** `ew03-probe/` (harness + fixtures),
  `ew03-probe/results.json` (final browser run, 73 steps), `ew03-probe-results-round1.json`
  (first browser run, 56 steps), `ew03-cli-control.sh` + `ew03-cli-control.txt` (native control),
  `ew03-gen-fixtures.mjs` (fixture generator).
- **Authority consulted:** `AGENTS.md`; `docs/process/handoff/20261113-essential-workbench-pickup.md`
  §1–§4.3 + "Design artifact ownership and permitted probes" + §6; `docs/product/16-...spec.md` §2/§5;
  `assests/svg/essential-workbench/README.md` §3 + board 03 (illustration; text wins); ADR 0003, 0012,
  0017, 0025, 0029, 0037, 0045, 0047.

**Return gate (spec §5):** no runtime CSV row until (a) browser exposure, (b) ownership/registration
lifecycle, (c) the meaning of a "complete check", and (d) the remaining policy decisions in §8 are
resolved and accepted, and any new protocol/format receives its own ADR. This document does not lift
that gate.

---

## 0. Environment, versions and projection limits

| Item                                 | Value                                                                                                                                                                  | How established                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Installed engine package             | `@duckdb/duckdb-wasm` **1.32.0** (`packages/engine-duckdb/package.json` dependency `^1.32.0`; resolved copy `packages/engine-duckdb/node_modules/@duckdb/duckdb-wasm`) | package.json                                                                       |
| DuckDB **inside the browser bundle** | **`v1.4.3`**                                                                                                                                                           | probe `boot.versions`: `db.getVersion()` → `v1.4.3`; `select version()` → `v1.4.3` |
| Bundle the app ships                 | **MVP**: `duckdb-browser-mvp.worker.js` (844,644 B) + `duckdb-mvp.wasm` (39,362,651 B), `featureFlags=16`, `crossOriginIsolated=false`                                 | `packages/engine-duckdb/src/worker.ts:27-28`; probe boot                           |
| Browser used for probes              | Chromium **153.0.8010.12** via installed Playwright **1.63.0** (`@playwright/test` from repo `node_modules`, no install)                                               | `drive.mjs` (`browser.version()`)                                                  |
| Native comparison control            | DuckDB CLI **v1.5.5 (Variegata) d8cdaa33fd** at `/tmp/duckdb`                                                                                                          | `duckdb --version`                                                                 |
| Runtime for harness                  | Node **v24.13.0**, localhost static server on `127.0.0.1:8731`                                                                                                         | `node --version`                                                                   |
| Arrow on the host                    | `apache-arrow` **17.0.0** (same as the app)                                                                                                                            | package copy used by the harness                                                   |

**Projection limits (honest):** single machine, single run per measurement (timings are orientation,
not a benchmark claim — spec §2 forbids new benchmark claims); JSON row capture capped at 12 rows per
query; **peak memory / wasm heap ceiling not measured**; no UI, keyboard/AT, cold-offline or
remote-CI evidence; **no application-runtime proof** — the repo harness (`packages/engine-duckdb/
harness`, served by `vite preview` in `playwright.config.ts`) was deliberately _not_ built, because a
build writes into `packages/engine-duckdb/dist/` inside the read-only checkout (see §7.4). Nothing
here is user/AT evidence (RD-T07 unchanged).

---

## 1. Current facts (source anchors, verbatim surfaces)

### 1.1 How CSV is opened and read today

1. **Format selection is extension-only, twice.** `@assay/data-sources` `detectFormatFromFileName`
   maps the last extension (`csv` → `'csv'`, `.gz` → `'unknown'`) and explicitly does _not_ read bytes
   (`packages/data-sources/src/detect-format.ts`). The engine repeats the policy with
   `detectFileFormat` (`packages/engine-duckdb/src/format-view.ts:28-46`); `null` →
   `'unsupported dataset format: this engine reads .parquet, .csv, .jsonl and .json files'`
   (`engine-executor.ts:477-483`, value-free per ADR 0025).
2. **The CSV scan is `read_csv(<engine-generated name>)` with zero options.**
   `fileScanSql` (`format-view.ts:62-77`) returns `read_csv('t1')`; `createViewSql`
   (`format-view.ts:79-84`) wraps it: `CREATE VIEW "assay_t1" AS SELECT * FROM read_csv('t1')`.
   There is **no** delimiter/header/type/null/date argument anywhere in the repository today
   (grep for `delimiter|all_varchar|header` in `packages/**` finds only DuckDB conformance tests and
   comments). Everything is therefore DuckDB's auto-sniffer decision, invisible to the UI.
3. **The relation is a lazy view, not a materialization.** Module header of `format-view.ts`:
   "An opened file becomes a DuckDB _view_ over a lazy reader table function — nothing is
   materialized at open time; every later range/schema query re-reads only the bytes it needs".
   Corroborated by probe J4 (`LIMIT 1000` window over the 4.2 MB / 200k-row fixture: 24 ms) versus J1
   (full `count(*)`: 142 ms) and J2 (full typed-column evaluation: 111 ms).

### 1.2 Who owns the relation

- **Worker-side `TableRegistry`** (`table-registry.ts`): `reserve(format)` (called _before_ file/view
  creation, paired with `remove()` on failure), `registerView` (pipeline relations), `list/clear`.
  Names are engine-generated: table id `t1…`, view `assay_t1`, registered file name `t1` — user file
  names never enter SQL (`format-view.ts`, `table-registry.ts` headers; ADR 0025).
- **`runOpen`** (`engine-executor.ts:476-500`): detect format → `registry.reserve` →
  `deps.registerFileHandle(entry.registeredFileName, file)` → `conn.query(createViewSql(...))` →
  `engine/open-result {tableId, format}`; any failure runs `registry.remove` + `dropFile` (rollback,
  no phantom entry).
- **File registration protocol:** `worker-core.ts:177-191` uses
  `database.registerFileHandle(name, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, false)`
  ("the bytes stay in the picked `File`; DuckDB slices it on demand … protocol case 2 of the 1.32.0
  worker bundle") and `database.dropFile(name)` for rollback/export cleanup.
- **Lifecycle end point:** only `engine/dispose` drops everything (`client.ts:1036-1069`, terminal,
  5 s timeout, `worker.terminate()` is the hard guarantee). **There is no per-table release op** —
  ADR 0047 records exactly this and accepts unbounded retention until teardown. `TableRegistry.remove`
  exists but is reachable only from the failed-open rollback path, not from any protocol request.
- **Web ownership** (`apps/web/src/App.tsx`): `openDataFile` (line 1596) owns acquisition →
  `engineClient.open({name, file})` (1680) → `schema` → `rowCount` → `OverlayBase` → provider/model →
  `setPhase('ready')`; `cancelOpen` (1591) bumps the shared session token and returns to idle —
  documented as "there is no engine interrupt in the protocol, so this does NOT abort the engine
  operation … Honest UI reset + token discard, never a claimed abort" (ug-21). Every await is followed
  by `datasetSession.tokenRef.current !== session` checks (1648, 1660, 1684, 1690, 1692, 1709, 1715, 1735) — that generation guard is today's late-response defense.
- **Source identity:** `BrowserFileSource` (`packages/data-sources/src/browser-file-source.ts`) — one
  immutable `crypto.randomUUID()` per pick, `open()` idempotent per instance, "re-picking the same
  file creates a _new_ source with a _new_ id"; no persistent cross-session file identity (ADR 0017).

### 1.3 What the browser engine exposes (verbatim)

**`DuckDbEngineClient` public methods** (`packages/engine-duckdb/src/client.ts`): `ensureReady` (358),
`query` (370), `open` (392), `schema` (414), `rowCount` (434), `fetchRange` (465), `profile` (519),
`overlaySchema` (558), `overlayRowCount` (584), `fetchOverlayRange` (620), `overlayCastCheck` (678),
`exportView` (732), `validate` (780), `stageComparison` (819), `diff` (853), `runPipeline` (900),
`registerPipelineRelation` (1014), `dispose` (1036).

**Protocol request types** (`protocol.ts`, verbatim set): `engine/init`, `engine/query`,
`engine/open`, `engine/schema`, `engine/range`, `engine/row-count`, `engine/profile`,
`engine/overlay-schema`, `engine/overlay-row-count`, `engine/overlay-range`, `engine/export`,
`engine/overlay-cast-check`, `engine/validate`, `engine/diff-stage`, `engine/diff`,
`engine/pipeline-source`, `engine/pipeline-materialize`, `engine/pipeline-handle`,
`engine/pipeline-execute`, `engine/pipeline-diff`, `engine/dispose`.
**There is no `engine/sniff`, no `engine/preview`, no `engine/cancel`, no `engine/release`,
no option field on `engine/open`** (`EngineOpenRequest` = `{type, requestId, name, file}`,
`protocol.ts:101-106`; `EngineOpenResultResponse` = `{tableId, format}`, `protocol.ts:480-486`).
`engine/query` accepts arbitrary SQL text (`protocol.ts:816-819`) — the only existing generic
escape hatch.

**Installed DuckDB-WASM browser API** (`dist/types/src/parallel/async_bindings.d.ts`,
`async_connection.d.ts`, `insert_options.d.ts` — package 1.32.0):
`AsyncDuckDB`: `instantiate(mainModuleURL, pthreadWorkerURL?)`, `open(config)`, `connect()`,
`getVersion()`, `getFeatureFlags()`, `runQuery`, `startPendingQuery/pollPendingQuery/fetchQueryResults`,
**`cancelPendingQuery`**, `registerFileText/URL/Buffer/Handle`, **`dropFile/dropFiles`**,
`copyFileToBuffer/Path`, `insertCSVFromPath(conn, path, CSVInsertOptions)`,
`insertArrowFromIPCStream`, `tokenize`, `getTableNames`, `terminate`.
`AsyncDuckDBConnection`: `query(sql)`, `send(sql, allowStreamResult?)`, **`cancelSent()`**,
`insertCSVFromPath(text, CSVInsertOptions)`, `prepare`, `insertArrowTable`.
`CSVInsertOptions` (typed surface): `{name, schema?, create?, header?, delimiter?, quote?, escape?,
skip?, detect?, dateFormat?, timestampFormat?, columns?|columnsFlat?}` — note it is a
**table-materializing import API** (probe M7: it created the user table `probe_import_m7`), not a
preview API.

`read_csv`/`sniff_csv` **named-parameter list as installed** (probe B3, `duckdb_functions()` in the
browser build): `col0, delim, dateformat, column_names, sep, hive_partitioning, header, escape,
allow_quoted_nulls, comment, maximum_line_size, new_line, columns, rejects_limit, force_not_null,
timestampformat, auto_detect, sample_size, auto_type_candidates, nullstr, encoding, normalize_names,
rejects_table, column_types, skip, types, max_line_size, quote, rejects_scan, ignore_errors,
compression, names, force_match, store_rejects, all_varchar, buffer_size, decimal_separator, parallel,
null_padding, dtypes, strict_mode, thousands, files_to_sniff, filename, union_by_name, hive_types,
hive_types_autocast`.
Functions present: `read_csv`, `read_csv_auto`, `sniff_csv` only (probe `boot.csv-function-inventory`).

### 1.4 Quick facts that constrain the design

- `sniff_csv` works in the browser and returns `Delimiter, Quote, Escape, NewLineDelimiter, Comment,
SkipRows, HasHeader, Columns[{name,type}], DateFormat, TimestampFormat, UserArguments, Prompt` —
  including a **`Prompt`** with a fully explicit, copyable `read_csv(...)` call (probe B1/B2/B9).
  This is the natural, already-installed "sample disclosure" payload.
- Quoting helpers already exist and are tested: `quotedIdentifier` (double-quote doubling) and
  `sqlStringLiteral` (single-quote doubling) in `format-view.ts:50-59`; type strings are validated
  client-side by `validateEngineTypeExpression` (`type-expr.ts`) before reaching SQL
  (`client.ts:678-700`, `overlay-query.ts:908-913`).
- Precedents to reuse, not reinvent: **typed conversion check** `composeOverlayCastCheckSql`
  (`overlay-query.ts:908-966`, `x IS NOT NULL AND TRY_CAST(x AS T) IS NULL … LIMIT 1`, boolean answer,
  no dataset values cross the boundary); **single-slot registration** `ComparisonRegistry`
  (`comparison-registry.ts`: one staged comparison, `DROP VIEW IF EXISTS` + `dropFile` before
  re-staging — `engine-executor.ts:1079-1098`); **scan budget** precedent in `profile-query.ts`.
- Bounds: `MAX_RANGE_ROWS = 1000` clamped client- and worker-side (`range-window.ts:20`);
  `rowCount` is metadata-only `count(*)` (`protocol.ts:27-29`, `client.ts:434-463`).
- Telemetry: only bucketed `dataset_opened` / `dataset_open_failed {reason_code}` exist
  (`App.tsx` open chain; ADR 0025/0037/0045). CSV interpretation must not add events, and no probe
  emitted any.

---

## 2. Proposed typed-option allowlist + SQL quoting

**Principle:** the engine composes SQL from a _fixed_ option vocabulary + engine-generated names +
validated type expressions. User text never becomes an identifier or an option name.

### 2.1 Allowlist (candidate — recommendation only)

| Option                                                                                                                                                                                                                                 | Allowed in              | Rationale / evidence                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `header` (bool, default `true` after sniff)                                                                                                                                                                                            | preview + open          | accepted in probe B4; explicit user choice or sniffed value, always disclosed                                                                                                                      |
| `delim` (alias `sep`) — single character/string                                                                                                                                                                                        | preview + open          | accepted (`delim=';'`, B4); **`delimiter`/`separator` are refused by the installed build** (B4/L7; native: `Binder Error: Invalid named parameter "delimiter"`)                                    |
| `quote`, `escape`                                                                                                                                                                                                                      | preview + open          | accepted (B4); must be echoed in disclosure (sniff reports them)                                                                                                                                   |
| `columns` / `types` map `{'name': '<engine type>'}`                                                                                                                                                                                    | preview + open          | accepted (B4 `columns={'v':'VARCHAR'}`, `types=…`); **each type value must pass `validateEngineTypeExpression`** before composition                                                                |
| `all_varchar` (bool)                                                                                                                                                                                                                   | preview + open          | accepted (B4); the lexeme-preserving default for the "read as text" mode (C1)                                                                                                                      |
| `nullstr` (string)                                                                                                                                                                                                                     | preview + open          | accepted (B4); decides the empty/NULL policy (§8-D6)                                                                                                                                               |
| `dateformat` (string)                                                                                                                                                                                                                  | preview + open          | accepted (B4); dates stay a _user-visible explicit_ choice (§8-D5)                                                                                                                                 |
| `comment`, `skip`                                                                                                                                                                                                                      | preview + open          | accepted (B4, `skip=1` → 5999 rows); disclosure required                                                                                                                                           |
| `sample_size` (≥ 0 or `-1`)                                                                                                                                                                                                            | preview only, disclosed | accepted (B4 `100`, `-1`; M1 `sample_size=10`); governs _inference_, never the complete check (§5)                                                                                                 |
| `strict_mode`, `null_padding`, `parallel`, `encoding`, `compression`, `max_line_size`, `buffer_size`, `decimal_separator`, `thousands`                                                                                                 | **deferred** (§8-D12)   | accepted syntactically (B4) but each changes parse semantics; no automatic locale inference is permitted, so `decimal_separator`/`thousands` may only ever be an explicit user setting if approved |
| `filename`, `union_by_name`, `hive_partitioning`, `hive_types*`, `files_to_sniff`, `column_names`, `names`, `normalize_names`, `force_match`, `auto_detect`, `auto_type_candidates`, `rejects_*`, `store_rejects`, **`ignore_errors`** | **refused**             | see §2.3                                                                                                                                                                                           |

### 2.2 Exact SQL construction and quoting rules

```text
scan        := read_csv(<lit:engineGeneratedName> [, <opt>=<lit|num|bool|map>]*)
view        := CREATE VIEW <quotedIdent:assay_tN> AS SELECT * FROM <scan>
describe    := DESCRIBE <quotedIdent:assay_tN>            -- existing runSchema path
sniff       := SELECT <cols> FROM sniff_csv(<lit:engineGeneratedName>)   -- proposed disclosure
complete    := SELECT count(*), count(*) FILTER (WHERE <col> IS NOT NULL
                 AND try_cast(<col> AS <validatedType>) IS NULL) … FROM <scan>
```

Rules:

1. **Identifiers**: only engine-generated (`t1`, `assay_t1`) or column names that came _from_ the
   engine (`sniff_csv.Columns[].name`, `DESCRIBE`), passed through `quotedIdentifier`
   (`"` → `""`). User-supplied display labels never enter SQL.
2. **String literals**: `sqlStringLiteral` (`'` → `''`) for file names and option string values.
3. **Option names**: drawn from the §2.1 vocabulary only — never from user input; an unknown name is
   refused _before_ dispatch (the installed build's message is opaque, §6.1).
4. **Type expressions**: `validateEngineTypeExpression` (`type-expr.ts`) on the main thread, then the
   same validation on the worker (boundary is untrusted) — identical to `overlayCastCheck`.
5. **Map literals** (`columns={'a':'VARCHAR'}`): keys are engine-reported column names, values are
   validated type expressions; both are re-validated worker-side before composition.
6. **No string interpolation of sniff output** other than through 1–5: `sniff_csv.Prompt` is
   _display_ evidence for the user, not a template to execute verbatim (it contains a file name and
   user-influenced option values).

### 2.3 Explicit refusals (with evidence)

| Refused                                                                                                                                                   | Why                                                                                                                                                        | Evidence                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ignore_errors=true`                                                                                                                                      | **silently drops rows** — hard rule "no silent skip-bad-row"                                                                                               | probe M3: forced-BIGINT read of the 120,000-row fixture with `ignore_errors=true` → `count(*) = 119999`, `count(v) = 119999` (one row gone, no error). Native control agrees. |
| `store_rejects=true` / `rejects_*`                                                                                                                        | **manufactures two user tables** (`reject_errors`, `reject_scans`, `internal=false`) and stores **raw CSV lines + error text** (dataset content, ADR 0025) | probes A0 (tables `[]` at boot) vs M8 (both tables present, `reject_errors` has 1 row with `csv_line`, `error_message`)                                                       |
| `delimiter` / `separator`                                                                                                                                 | not real parameters of this build; would always fail at runtime                                                                                            | B4/L7 browser; native `Binder Error: Invalid named parameter "delimiter"` with the candidate list                                                                             |
| `normalize_names`, `force_match`, `column_names`, `names`, `filename`, `hive_*`, `union_by_name`, `files_to_sniff`, `auto_detect`, `auto_type_candidates` | silent renaming / multi-file semantics / sniff control outside the reviewed scope                                                                          | installed parameter list (B3); not needed for a single local file                                                                                                             |
| `ignore_errors`-style _any_ row-skipping, any automatic locale inference, `.ndjson` alias/copy change                                                     | brief hard constraints                                                                                                                                     | — (`.ndjson` remains a separate proposed row; `jsonl`→`read_json_auto(format='newline_delimited')` unchanged, `format-view.ts:69-74`)                                         |

---

## 3. Quick-open vs advanced flow

**Quick open (unchanged, and the only path that may ship without new gates):**
picker/drop/example → `BrowserFileSource` → `engine/open {name,file}` → `read_csv('tN')` auto-sniff →
`schema`/`rowCount` → ready. It already preserves parse-time lexemes whenever the _sniffer_ chooses
VARCHAR (probe A1/A2: `id` came back `'0017'`, `'00042'`, `'007'`; L3: any leading-zero value forces
VARCHAR), and it never takes user CSV options. It must keep its current copy and states; EW-02D owns
the wording.

**Advanced flow (proposed, cannot ship before the gates below):**
a provisional, non-adopting review step that lets the user set delimiter/header/column types
(all-text vs typed), shows `sniff_csv` disclosure (delimiter, header, per-column types, date format,
sample size, and the resulting `Prompt`), shows a bounded preview, runs the §5 complete check, and only
then offers adoption.

**Why it cannot ship yet (gates):**

1. **No exposure**: `engine/open` carries no options (§1.3); adding options to the open request or a
   new `engine/preview` op is a **protocol change requiring its own ADR** (brief hard constraint).
2. **No registration-free preview of a candidate file**: the only reachable way to register bytes
   is `engine/open`, which also creates a view + registry entry (§4.1). Repeated previews must not
   manufacture registered tables (ADR 0047). Probe M5 shows ad-hoc scans are catalog-neutral **for a
   name that was already registered** — it does not establish candidate acquisition, abandonment or
   retention (§4.0), and no registration-free path for a fresh candidate exists in the protocol
   today (§4.2).
3. **Failure text is not usable yet** (§6.1): the installed MVP worker surfaces
   `ReferenceError: _setThrew is not defined` for every SQL error on both `query()` and `send()`
   paths, so "unsupported option", "conversion failure" and "missing file" are indistinguishable to
   the host today.
4. **Policy decisions open** (§8): empty/NULL, dates, sample disclosure wording, full-check meaning,
   adoption identity, cancellation/resource bounds.
5. **Return gate** (spec §5): browser exposure, ownership, complete-check meaning and remaining policy
   decisions must be _resolved and accepted_ first.

---

## 4. Ownership (source → registration → preview → adoption)

### 4.0 What the current protocol actually allows (source facts, no proposal)

- `EngineOpenRequest` is `{type, requestId, name, file}` (`protocol.ts:101-106`) — **no options and
  no "register without a view" flag**. `runOpen` (`engine-executor.ts:485-495`) always performs
  _reserve table id_ → `registerFileHandle(name, file)` → `CREATE VIEW "assay_tN" …`. Today,
  therefore, **registering a candidate's bytes is indistinguishable from manufacturing a registered
  view plus a registry entry**; only a failure inside `runOpen` rolls back
  (`registry.remove` + `dropFile`).
- The protocol exposes **no per-table release**: `TableRegistry.remove` is reachable only from that
  rollback; `DROP VIEW` is reachable only through raw `engine/query` SQL (which would desync the
  registry entry — a hazard, not a proposal); `dropFile` only from the worker API (probe I6). Only
  `engine/dispose` reclaims everything (ADR 0047).
- **Evidence scope (corrected in review round 1):** probe **M5** ran three ad-hoc `read_csv` scans
  over fixture names **the harness had already registered**, and showed the catalog did not grow
  (with `CREATE VIEW` / simulated-open legs showing what _does_ grow it). M5 therefore proves
  _scan-time catalog neutrality for an already-registered name only_. It does **not** exercise
  candidate-file acquisition, abandonment, supersession or retention. Probe **M7** proves
  `insertCSVFromPath` materializes a user table (`probe_import_m7`) and is unusable for previews; it
  establishes nothing about acquisition or abandonment either.

### 4.1 Case (a) — a preview that must register bytes to scan them (reachable today; costly)

| Step                                  | What happens                                                                                                                                                                                                                                                                                                                     | What is left behind                                                                                                                                                                                                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Acquire                               | one-shot pick (`BrowserFileSource`, new id per pick) → `File` held on the main thread; no bytes read                                                                                                                                                                                                                             | nothing (reference only)                                                                                                                                                                                                                                                               |
| Register                              | the only reachable path is `engine/open`-shaped: `reserve` + `registerFileHandle` + `CREATE VIEW`                                                                                                                                                                                                                                | **+1 table id, +1 registered file, +1 view** — created _before_ any preview query runs                                                                                                                                                                                                 |
| Scan                                  | ad-hoc `read_csv` under successive option sets against that **one** registered name (the M5 legs)                                                                                                                                                                                                                                | no further catalog growth while the name is reused                                                                                                                                                                                                                                     |
| Cancel / abandon _after_ registration | `cancelOpen` = session-token bump + idle (ug-21); no engine abort, no drop op                                                                                                                                                                                                                                                    | candidate view + file registration + registry entry **retained until `engine/dispose`** (ADR 0047)                                                                                                                                                                                     |
| Failure _after_ registration          | error surfaces opaquely (§6.1); `runOpen`'s rollback covers only failures inside `runOpen`                                                                                                                                                                                                                                       | retained (ADR 0047 consequence 2)                                                                                                                                                                                                                                                      |
| Supersede (a second candidate)        | **nothing is dropped**: the protocol has no release op, raw `DROP VIEW` via `engine/query` would desync `TableRegistry`, and `dropFile` has no op (§4.0)                                                                                                                                                                         | **+1 retained** (the previous registration stays until `engine/dispose`). The `ComparisonRegistry` drop-before-restage pattern (`engine-executor.ts:1079-1098`) would hold this at +0, **but only with the ADR-gated lifecycle op named in D12 — not available today and not claimed** |
| Adopt                                 | **today only:** a fresh `engine/open` (**+1** session table) while the preview registration stays retained — current behaviour; **proposed:** an exactly-once **promotion reusing the candidate registration (Δ +0 new)**, so the preview registration _becomes_ the session table — ADR-gated with D12, **not available today** | today: one adopted session table **plus every prior preview registration until teardown**; proposed: the candidate registration is re-purposed, nothing is released                                                                                                                    |

**Retention rule (resolved in one direction: retain-all).** No release primitive exists, so
_nothing_ is dropped between registration and `engine/dispose`. "Single slot" therefore means single
**live-candidate ownership** (one intent, one registration eligible for adoption) — **not** single
engine retention. Per-event accounting of retained registrations (view + file + registry entry),
released only by `engine/dispose` (ADR 0047):

| Event                                                                                  | Δ retained                                                                                                          |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| acquire / pick / open the preview UI (before registration)                             | **+0** — abandoning here leaves the engine untouched                                                                |
| register the candidate (case (a))                                                      | **+1**                                                                                                              |
| option change → re-scan of the same registered name                                    | **+0** (re-scans, never re-registrations)                                                                           |
| cancel / abandon _after_ registration                                                  | **+0 new**; the existing +1 stays retained (cumulative +1)                                                          |
| failure _after_ registration                                                           | **+0 new**; stays retained (cumulative +1)                                                                          |
| supersede with a second candidate file                                                 | **+1** (the previous registration cannot be released) → cumulative +2                                               |
| adopt — **today only** (fresh `engine/open`)                                           | **+1** session table, while the preview registration stays retained — current behaviour the promotion would replace |
| adopt — **proposed promotion** (case (a); ADR-gated with D12, **not available today**) | **+0 new** — the preview registration _becomes_ the session table (nothing is released; it is re-purposed)          |
| `engine/dispose`                                                                       | releases everything                                                                                                 |

So under case (a) an abandoned preview costs nothing **only when it is abandoned before
registration**; every registration-making event is retained until disposal. Drop-before-restage
(which would make _supersede_ +0) is **not available today** — it needs the ADR-gated lifecycle op in
D12 plus a drop that keeps `TableRegistry` in step — and is not claimed here. This retention is
ADR 0047's accepted consequence: disclosed in any future design, not optimised away — **no release
primitive is assumed**.

### 4.2 Case (b) — a genuinely registration-free preview (**not established**; unproven, ADR-gated)

Definition: the candidate's bytes are never registered — no view, no registry entry, nothing to
release; an abandoned preview leaves the engine byte-identical.

| Candidate mechanism using the installed API                              | Status                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ad-hoc `read_csv` over an **already-registered** name                    | **catalog-neutral proven (M5)**, but this is _reuse only_: a fresh candidate cannot obtain a name without case (a). Acquisition/abandonment untested.                                                                              |
| `registerFileBuffer` / `registerFileText` + ad-hoc scan with no `CREATE` | API exists (`async_bindings.d.ts`) but **unproven**: registering bytes without a view was never probed, and it still leaves a registered file until `dropFile`, which no protocol op reaches (I6). Any adoption needs its own ADR. |
| main-thread pre-scan of the `File` in JavaScript                         | not engine evaluation; cannot satisfy §5's complete check. Acceptable only as a clearly labelled bounded sample, never as proof.                                                                                                   |
| `engine/query` against an unregistered name                              | fails (probe L1, "missing registered file"). No path exists today.                                                                                                                                                                 |

**No registration-free preview of a candidate file is established by M5, M7 or any other probe.**
Reaching case (b) requires a separately approved protocol change (a new preview op, or options on
`engine/open` plus an explicit drop path) — see D12, unresolved and ADR-gated. Only if an ADR later
establishes case (b) does abandoning a preview before adoption cost nothing.

### 4.3 Adoption, cancel, late response, release (stated for both cases)

| Phase              | Owner today                                                                            | Proposed for CSV interpretation                                                                                                                                                                                                                                                                                                                 | Accounting required                                                                              |
| ------------------ | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Source acquisition | `App.openDataFile` + `BrowserFileSource` (one-shot, new id per pick)                   | unchanged                                                                                                                                                                                                                                                                                                                                       | picker cancel/refusal → idle, nothing opened (already true)                                      |
| Preview            | _does not exist_                                                                       | case (b) if an ADR establishes it; otherwise case (a) with **single live-candidate ownership + retain-all engine accounting (§4.1) and explicit retention disclosure**                                                                                                                                                                          | one pending intent at a time; per-event Δ retained exactly as the §4.1 table (ADR 0047 language) |
| Adoption           | `setPhase('ready')` + `openSourceRef` after full success                               | one-time **promotion that reuses the candidate registration — Δ +0 new** (ADR-gated with D12, **not available today**); identity = already-captured `baseAnchor` (size + mtime) + `sourceIdentityRef` FSA `isSameEntry`. Today's path is a fresh `engine/open` (**+1**, preview registration retained) and is what this promotion would replace | adoption idempotent-once (WF-06 lessons); Δ adopted **exactly as the §4.1 table**                |
| Cancel / abandon   | `cancelOpen` = session-token bump + idle (ug-21)                                       | same mechanism; **costless only under case (b), or before registration under case (a)**; after registration the candidate is retained until disposal                                                                                                                                                                                            | late results dropped by the token guard (§1.2); no abort claim                                   |
| Late response      | token checks after every await (App.tsx:1648–1735)                                     | unchanged; a preview result must carry the intent sequence and be discarded if stale                                                                                                                                                                                                                                                            | no engine `Cancel` promise (hard constraint)                                                     |
| Release            | `engine/dispose` only; `TableRegistry.remove` reachable only from failed-open rollback | unchanged — **no release primitive is assumed**; a per-table drop/release op would supersede ADR 0047 via its own ADR                                                                                                                                                                                                                           | unbounded retention stays honestly disclosed (ADR 0047)                                          |

**A single registered source is not enough by itself.** Even with one candidate slot, the design
still needs: cancel/abandon accounting (who owns a half-finished preview _and_ the registration it
may already have made), adoption accounting (exactly-once **promotion reusing the candidate
registration, Δ +0 new, ADR-gated with D12**; today's fresh `engine/open` is **+1** with the preview
registration retained),
failure accounting (a post-registration failure or abandonment retains that registration — ADR 0047
consequence 2), supersession accounting (**+1 retained per superseded candidate under retain-all**;
drop-before-restage only if D12's ADR grants a registry-consistent lifecycle op), and
late-response accounting (stale preview results must never be adopted).

---

## 5. Inference coverage vs full evaluation

### 5.1 What a "complete check" means (proposed definition — needs acceptance, §8-D8)

A candidate option set passes a **complete check** iff, over the **entire** relation (not the sniff
sample):

1. `count(*)` equals an independently computed total for that scan;
2. for **every** column `c` with intended type `T`: `count(*) FILTER (c IS NOT NULL AND
try_cast(c AS T) IS NULL) = 0` — the exact predicate already used by `composeOverlayCastCheckSql`
   (`overlay-query.ts:929-932`);
3. for columns intended to stay text, **lexeme invariants** hold (e.g. preserved length/prefix for
   leading-zero ids, see probe J2 `id_not_lexeme = 0`);
4. no row is skipped: the check runs with `ignore_errors`/`store_rejects` **absent** (§2.3).

The check is **per column, exhaustive, and separate from the sniff**. A `count(*)` alone is never
proof: probe A3/E3 show `count(*)` returning 4 and 6000 with no statement about conversion, and M3
shows `count(*) = 119999` while a row had been silently dropped by `ignore_errors=true`.

### 5.2 Typed-column evaluation, demonstrated (browser, not CLI)

```sql
-- E5 (6,000-row fixture, bad token at data row 5000)
select count(*) as n,
       count(*) filter (where v is not null and try_cast(v as bigint) is null) as bad_bigint,
       count(*) filter (where v is not null and try_cast(v as integer)   is null) as bad_int
from read_csv('t2', all_varchar=true);
-- browser result: n=6000, bad_bigint=1, bad_int=1

-- M3 (120,000-row fixture, bad token at row 110,000, beyond the sniff sample)
select count(*) as n, count(*) filter (where v is not null
       and try_cast(v as bigint) is null) as bad
from read_csv('t9', all_varchar=true);
-- browser result: n=120000, bad=1     (vs. default-typed read: hard failure, M2)

-- J2 (200,000 rows / 4.2 MB, leading-zero ids)
select count(*) as n,
       count(*) filter (where id is not null and try_cast(id as bigint) is null) as id_bad,
       count(*) filter (where length(id) <> 7) as id_not_lexeme,
       count(*) filter (where amount is not null and try_cast(amount as decimal(18,2)) is null) as amount_bad,
       count(*) filter (where label is null) as label_null
from read_csv('t8', all_varchar=true);
-- browser result: n=200000, id_bad=0, id_not_lexeme=0, amount_bad=0, label_null=0
```

Native CLI control reproduced `n=120000, bad=1` and `n=200000` with the same zeros (`ew03-cli-control.txt`),
but the **capability proof is the browser run**; CLI is comparison only.

### 5.3 Sample vs full, failure beyond the sample, lazy parsing

- The sniffer samples (native error context prints `sample_size = 20480`); `DESCRIBE`/schema reflect
  the **sample's** types, not the file's.
- **Failure beyond the sniff sample is real**: on the 120,000-row fixture the sniffer reported
  `BIGINT` (probe M2 `describe`) and the full read then failed at "CSV Error on Line: 110001"
  (native text; browser: opaque `ReferenceError`, §6.1). With `all_varchar=true` the same file reads
  cleanly and the typed check reports exactly one bad row.
- On the small (6,000-row) fixture the sniffer saw the whole file and chose `VARCHAR`
  (E2/E9: `Columns=[{"name":"v","type":"VARCHAR"}]`), so `count(*)` passed with **no** conversion at
  all — i.e. "no error" never implies "converted".
- **Lazy parsing**: view-over-reader (§1.1); J4 window read 24 ms vs full count 142 ms on the same
  file. Consequence: a `LIMIT`-bounded preview reads only the head; it is _not_ a full evaluation and
  must be labelled as a sample.
- **Quoted newlines/delimiters**: fixture with an embedded newline + comma inside quotes and an
  escaped quote read as **3 rows**, value `line1\nline2, with comma` (length 23), `say "hi"` (F1/F2,
  native-identical).
- **No silent skip**: enforced by refusing `ignore_errors`/`store_rejects` (§2.3) and by requiring
  §5.1(4).

---

## 6. Failures, cancellation, resource bounds

### 6.1 Failure surfacing (decisive, and currently a blocker)

Every SQL failure observed in the installed browser MVP bundle surfaced as
**`ReferenceError: _setThrew is not defined`**, on **both** client paths — `conn.query()` (probe L1,
7/7 cases) and `conn.send()` streaming (probe M1, 4/5 cases) — for: unknown relation, invalid SQL,
missing registered file, unknown named parameter (`delimiter`), invalid option value type, invalid
`columns` type, and strict-cast conversion failure. Cause: the prebuilt `duckdb-browser-mvp.worker.js`
references `_setThrew` in 369 `invoke_*` exception wrappers but never defines it (grep: no
`var/let/const/function/_setThrew=` anywhere in the file; the wasm binary contains no such export),
so a C++ exception unwinding through a JS wrapper throws before DuckDB's message is built.

Consequences for this contract:

- The host **cannot currently classify** "unsupported option" vs "conversion failure" vs "missing
  file" from `error.message`. Any refusal UI must therefore rely on _pre-validation_ (the §2.1
  allowlist checked in TypeScript, `validateEngineTypeExpression`, format detection) plus a
  value-free generic failure state — or on a separately approved fix/ADR. This is an unresolved
  decision (§8-D10), not something this design may paper over.
- Native CLI (1.5.5) shows the messages the browser does not (`Conversion Error: CSV Error on Line:
110001 … Could not convert string "abc" to 'BIGINT'`, `Binder Error: Invalid named parameter
"delimiter"`) — useful for _comparison_, never as browser capability proof.
- **I could not establish** whether the shipped web app shows the same masked text: that requires
  building/running the repo harness, which is outside this design-only boundary (§7.4).

### 6.2 Late response, cancel, abandon

- Late responses are discarded by the session-token guard (§1.2); `cancelOpen` never claims an abort.
- There is **no engine `Cancel` promise** in the protocol (hard constraint) and none is proposed.
  duckdb-wasm does expose `cancelPendingQuery`/`cancelSent` at the binding layer (`async_bindings.d.ts`,
  `async_connection.d.ts`) and the executor already uses `cancelSent()` to release a _pending/streamed_
  result — that is not a user-facing cancellation.
- **Probe K1 (cancellation observability) was attempted and abandoned as inconclusive**: a streamed
  `select count(*) from range(100000000000)` did not deliver a result header within 5 s, so
  `cancelSent()` was never reached; the harness reported `header-timeout`. No conclusion is drawn.

### 6.3 Resource bounds

- Row windows are clamped to `MAX_RANGE_ROWS = 1000` on both sides of the boundary; `rowCount` is
  metadata-only; nothing in the protocol can request full materialization (`range-window.ts`,
  `protocol.ts:24-29`).
- The complete check (§5) is a full scan by definition: measured 111 ms for 200k rows/4.2 MB on this
  machine (single run, orientation only). There is **no engine-provided memory/disk/timeout bound,
  no progress/cancel op, and no peak-memory measurement** — the wasm heap ceiling is unmeasured here.
  A future runtime row must set an explicit budget (profile-query's scan-budget precedent) and a
  refusal path when the budget is exceeded.
- Retention: `engine/dispose` (5 s timeout) is the only reclamation; per-table retention is unbounded
  (ADR 0047). Previews must not add to it (§4).

---

## 7. Probe transcript

### 7.1 Commands (exact)

```bash
# baseline
cd /home/howt/work/dataworkbench && git rev-parse HEAD && git status --porcelain
# → c841fe4332a980ccd6a926b4e7520104068af70a, clean

# disposable harness (only under /tmp/assay-ew/)
mkdir -p /tmp/assay-ew/ew03-probe/{duckdb,arrow,fixtures}
cp <repo>/packages/engine-duckdb/node_modules/@duckdb/duckdb-wasm/dist/{duckdb-browser.mjs,duckdb-mvp.wasm,duckdb-browser-mvp.worker.js} /tmp/assay-ew/ew03-probe/duckdb/
cp -r <repo>/node_modules/.pnpm/apache-arrow@17.0.0/node_modules/apache-arrow/. /tmp/assay-ew/ew03-probe/arrow/
cp -r <repo>/node_modules/.pnpm/flatbuffers@24.12.23/node_modules/flatbuffers/. /tmp/assay-ew/ew03-probe/flatbuffers/
node /tmp/assay-ew/ew03-gen-fixtures.mjs          # 8 synthetic CSVs (types/late/quoted/quotednl/dup/big/sep/perf)
# + inline: latebig.csv (120,000 rows, bad token at 110,000), z1..z3 leading-zero variants

# bundle the browser glue + arrow with the ALREADY INSTALLED esbuild (no install)
printf 'export * from "@duckdb/duckdb-wasm"\n' > entry.js
<repo>/node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/bin/esbuild entry.js \
  --bundle --format=esm --platform=browser --outfile=duckdb-vendor.js \
  --alias:@duckdb/duckdb-wasm=<repo>/packages/engine-duckdb/node_modules/@duckdb/duckdb-wasm/dist/duckdb-browser.mjs

# localhost-only server + Playwright driver (installed @playwright/test, no browsers installed)
node server.mjs 8731 &
node drive.mjs 8731            # 4 runs; final = ew03-probe/results.json (73 steps)
node debug2.mjs 8731 index.html  # diagnostics

# native comparison control
bash /tmp/assay-ew/ew03-cli-control.sh > /tmp/assay-ew/ew03-cli-control.txt
```

Harness shape: `index.html` loads `probe.js`, which mirrors `worker-core.ts` exactly —
`new Worker('/duckdb/duckdb-browser-mvp.worker.js')` → `new AsyncDuckDB(VoidLogger, worker)` →
`instantiate('/duckdb/duckdb-mvp.wasm')` → `open({})` → `connect()` — then registers each fixture as
a real `File` under an **extension-less engine name** (`t1`…`t9`) with
`DuckDBDataProtocol.BROWSER_FILEREADER` (all 9 registrations succeeded, ~1–30 ms each).

### 7.2 What the probes proved (browser, 1.4.3 / duckdb-wasm 1.32.0)

| #            | Probe                                                                    | Result                                                                                                                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1–A3        | current app SQL (`read_csv('t1')`, no options)                           | `id VARCHAR` (`'0017'` preserved), `amount DOUBLE` (`10.50`→`10.5`), `dob DATE` (crosses Arrow as epoch ms), `count(*)=4`                                                                                                                                                  |
| B1–B3        | `sniff_csv`                                                              | delimiter/header/columns/dateformat + copyable `Prompt`; `read_csv`,`read_csv_auto`,`sniff_csv` only; full named-parameter list                                                                                                                                            |
| B4           | 25-option accept/refuse matrix                                           | 22 accepted, `delimiter`, `separator`, `dateformat_iso`(invented) refused                                                                                                                                                                                                  |
| C1–C4        | lexemes                                                                  | `all_varchar`/`columns=` preserve `'0017'`; cast-back `'0017'→17→'17'` (`recovered_ok=false`) — **cast-back cannot restore a parse-time lexeme**                                                                                                                           |
| D1–D4, L4    | quoted empty vs NULL                                                     | default/`nullstr=''`/`null_padding`: quoted `""` **and** unquoted empty → NULL; `nullstr='NA'`: both → `''`; **no setting distinguishes them**; `'' is null = false`                                                                                                       |
| E1–E9, M2–M3 | failure beyond sample                                                    | small file sniffed as `VARCHAR` (no conversion); 120k file sniffed `BIGINT` → full read fails at line 110001; `all_varchar` + typed check finds `bad=1`; `ignore_errors` → 119,999 rows (silent drop)                                                                      |
| F1–F2        | quoted newline/delimiter                                                 | 3 rows, embedded `\n` + `,` and `""` escapes preserved                                                                                                                                                                                                                     |
| G1–G3        | duplicate/empty header names                                             | auto-renamed `id`, `column1`, `id_1` (no error)                                                                                                                                                                                                                            |
| H1–H4        | unsafe integers                                                          | `big.csv` sniffed `DOUBLE` → `9007199254740993`→`9007199254740992`, `9223372036854775807`→`9223372036854776000`, `99999999999999999999`→`1e20`; `cast(… as bigint)` crosses as JS `bigint` exactly (`numberCoercionSafe=false` for `Number(v)`)                            |
| M5           | catalog under ad-hoc scans (**after** harness registration of `t1`/`t9`) | 3 option scans over **already-registered** names → catalog unchanged; `CREATE VIEW` → +1; 2 simulated opens → +2; drops restored baseline. **Scope limit: scan-time catalog neutrality only — no candidate acquisition, abandonment, supersession or retention exercised** |
| M7           | typed `insertCSVFromPath`                                                | materializes a user table (`probe_import_m7`) → **not usable for previews**; nothing about candidate acquisition/abandonment                                                                                                                                               |
| A0/M8        | `store_rejects`                                                          | boot catalog has **no** tables; after `store_rejects=true`: `reject_errors` + `reject_scans` (non-internal), `reject_errors` holds the raw CSV line and error text; relation lost the row (`119999`)                                                                       |
| I6           | `dropFile`                                                               | after `dropFile('t1')`, `copyFileToBuffer('t1')` returns 1 byte instead of throwing — API-level, untested by any repo test; **no protocol op reaches it**                                                                                                                  |
| J1–J4        | bounds/laziness                                                          | full count 142 ms, full typed check 111 ms, `columns=` typed read 61 ms, `LIMIT 1000` window 24 ms (200k rows/4.2 MB; single run)                                                                                                                                          |
| L1/M1        | error text                                                               | `ReferenceError: _setThrew is not defined` for all error classes, both `query()` and `send()`                                                                                                                                                                              |
| K1           | cancellation                                                             | **abandoned, inconclusive** (no stream header within 5 s)                                                                                                                                                                                                                  |

### 7.3 Native CLI control (comparison only)

`ew03-cli-control.txt` reproduces, on the same fixtures with CLI 1.5.5: identical sniff types,
identical leading-zero behavior (z1/z3 → VARCHAR, z2 → BIGINT), identical quoted-empty → NULL,
identical `column1`/`id_1` renaming, identical `DOUBLE` precision loss, `ignore_errors` → 119999,
typed check `bad=1`, `sample_size=10` accepted, `delimiter` binder error with the full candidate
list, and the rich conversion error text the browser cannot show. **Divergences:** browser DuckDB is
**1.4.3** vs CLI **1.5.5**; CLI's `store_rejects=true` did **not** create `reject_errors`
(`Catalog Error: Table with name reject_errors does not exist!`) while the browser build did — so
CLI behavior must not be assumed to hold in the browser.

### 7.4 Probes stopped or limited (reported honestly)

1. **Repository harness not run.** `packages/engine-duckdb/harness` + `tests/e2e/engine-duckdb.spec.ts`
   are served from `packages/engine-duckdb/dist` via `vite preview`; producing that output writes into
   the read-only checkout, so the brief's stop rule applied. Nothing in the repo was built, and no
   application-runtime claim is made.
2. **K1 cancellation probe abandoned** (§6.2).
3. **Probe-script defects, superseded:** round-1 `duckdb_views()/duckdb_tables()` used a non-existent
   `table_name` column and `typeof(v)` in an aggregate (both invalid SQL) — steps I1–I5/L5/L6 failed
   with the masked error; they were corrected and re-run as M4–M8 (the superseding evidence is what
   this contract cites). Round-1 results are preserved in `ew03-probe-results-round1.json`.
4. **Not measured:** wasm heap/peak memory, multi-MB (100 MB+) files, cold cache, concurrent lanes,
   UI/AT behavior, and the shipped app's actual error text.

---

## 8. Decision ledger (recommendations are NOT acceptance)

Status vocabulary: `unresolved` (needs a decision before any runtime row), `accepted` (already fixed
by an accepted ADR — quoted for completeness), `rejected` (ruled out with evidence).
Decision owner: **M** = maintainer (product policy), **E** = maintainer + engine/protocol owner
(ADR-gated), **W** = workbench runtime owner (implementation detail once policy is set).

| ID  | Item                                       | Alternatives                                                                                                                                                                                                                                                                                                                                | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Evidence                                                                                                                                                                                                                               | Owner | Status                |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --------------------- |
| D1  | **Delimiter**                              | (a) auto only; (b) auto + explicit user override via `delim`/`sep`; (c) free-text option names                                                                                                                                                                                                                                              | (b): allow only `delim`/`sep`, always echo the effective delimiter from `sniff_csv`; refuse `delimiter`/`separator` pre-dispatch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | B1/B2 sniff `Delim`; B4 accept `delim`, refuse `delimiter`; native binder error                                                                                                                                                        | M     | unresolved            |
| D2  | **Header**                                 | (a) always sniffed; (b) sniffed + user toggle                                                                                                                                                                                                                                                                                               | (b): `header` is a first-class typed option, default = sniffed value, disclosed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | B4 `header=true` accepted; sniff `HasHeader`                                                                                                                                                                                           | M     | unresolved            |
| D3  | **Duplicate / empty column names**         | (a) accept DuckDB auto-renames (`column1`, `id_1`); (b) refuse the file; (c) rename in the UI with disclosure                                                                                                                                                                                                                               | (a) + explicit disclosure of the rename list before adoption                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | G1–G3 browser, CLI-identical                                                                                                                                                                                                           | M     | unresolved            |
| D4  | **Types / all-text**                       | (a) always auto; (b) auto + per-column override; (c) default all-text                                                                                                                                                                                                                                                                       | (b), with `all_varchar` as the one-click lexeme-safe mode; every type passes `validateEngineTypeExpression`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | B4 `columns`/`types`/`all_varchar` accepted; C1/C2 lexemes; H1/H3 default `DOUBLE` loss                                                                                                                                                | M     | unresolved            |
| D5  | **Dates**                                  | (a) sniffed `DATE`/`TIMESTAMP` + `dateformat` override; (b) always text                                                                                                                                                                                                                                                                     | (a): keep sniffed temporal types but expose `dateformat` and disclose it; **no locale/date-order inference**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | A1 (`dob DATE`, epoch ms across Arrow), B4 `dateformat` accepted, sniff `DateFormat=%Y-%m-%d`                                                                                                                                          | M     | unresolved            |
| D6  | **Quoted empty vs NULL**                   | (a) DuckDB default: both NULL; (b) `nullstr='NA'`: both `''`; (c) promise quoted-`""` = `''` and unquoted = NULL                                                                                                                                                                                                                            | **(c) is impossible in the installed build** — recommend (a) as default with (b) as an explicit user choice, and state in copy that empty and quoted-empty are both NULL by default                                                                                                                                                                                                                                                                                                                                                                                                                                     | D1–D4, L4: no setting separates them; `'' is null = false`                                                                                                                                                                             | M     | unresolved            |
| D7  | **Sample disclosure**                      | (a) none; (b) show `sniff_csv` (delimiter, header, per-column types, dateformat, sample size, `Prompt`); (c) new disclosure format                                                                                                                                                                                                          | (b): reuse the installed `sniff_csv`, bounded and local; disclose that inference uses a sample (`sample_size`), never claim full validation                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | B1/B2/B9, B3                                                                                                                                                                                                                           | M     | unresolved            |
| D8  | **Full-check definition**                  | (a) `count(*)`; (b) per-column `try_cast` filter over the whole relation + lexeme invariants + row-count equality; (c) sample-only check                                                                                                                                                                                                    | (b) — exactly §5.1; (a) is explicitly not proof, (c) is explicitly a sample                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | A3/E3/M3/J2/E5                                                                                                                                                                                                                         | M     | unresolved            |
| D9  | **Adoption identity**                      | (a) new id per adoption; (b) reuse `BrowserFileSource.id` + `baseAnchor` (size+mtime) + FSA `isSameEntry`                                                                                                                                                                                                                                   | (b): adoption reuses the already-captured source identity; no persistent cross-session identity (ADR 0017)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `browser-file-source.ts` contract; `App.tsx` `sourceIdentityRef`/`baseAnchor`                                                                                                                                                          | M     | unresolved            |
| D10 | **Failure/refusal text**                   | (a) show engine message (currently masked); (b) pre-validate options in TS + value-free generic failure + technical detail; (c) upstream/ADR fix for the masked error                                                                                                                                                                       | (b) now, (c) as a separate proposed row; never classify from `ReferenceError`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | L1/M1 (7/7 and 4/5 masked), worker glue grep                                                                                                                                                                                           | E     | unresolved            |
| D11 | **Cancellation / resource bounds**         | (a) add engine cancel; (b) keep token-guard discard + explicit check budget + refusal                                                                                                                                                                                                                                                       | (b): no `Cancel` promise (hard constraint); bound the complete check with a documented budget (profile precedent) and refuse over-budget; late results discarded by intent sequence                                                                                                                                                                                                                                                                                                                                                                                                                                     | §6.2–6.3, `MAX_RANGE_ROWS`, `profile-query.ts`                                                                                                                                                                                         | E     | unresolved            |
| D12 | **Registration reuse vs lifecycle change** | (a) registration-free candidate preview (new `engine/preview` op, or options on `engine/open` with no view); (b) single-slot _registering_ preview — **retain-all** today, drop-before-restage only if an ADR grants a registry-consistent lifecycle op; (c) per-preview `CREATE VIEW` + drop; (d) reuse of an already-registered name only | (a) stays the design target but is **unproven** — M5 covers scans over names the harness had already registered, M7 only shows `insertCSVFromPath` materializes, so candidate acquisition/abandonment/retention are unestablished; (b) is the honest fallback shaped like today's code: single **ownership** slot with retain-all engine accounting (+1 per registration-making event, released only by `engine/dispose`, §4.1 table) — the `ComparisonRegistry` drop-before-restage ordering becomes usable only with the ADR-gated op; (c) rejected; no release primitive assumed; **either route needs its own ADR** | M5 (scope-limited, §4.0 — including its three `DROP VIEW` statements and the restored-catalog capture), M7, A0/M8, I6 (`dropFile` is worker-only; no protocol op), `comparison-registry.ts` + `engine-executor.ts:1079-1098`, ADR 0047 | E     | unresolved            |
| D13 | **Row-skip / reject policy**               | (a) `ignore_errors`; (b) `store_rejects`; (c) refuse both, fail the preview on any conversion error                                                                                                                                                                                                                                         | (c) — plus `strict_mode` default as disclosed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | M3 (119,999), M8 (row dropped + raw line stored + 2 tables), A0                                                                                                                                                                        | M     | unresolved            |
| D14 | **Unsafe integers**                        | (a) let sniff pick `DOUBLE` (silent precision loss); (b) force `BIGINT`/`VARCHAR` when integers exceed 2^53; (c) disclose and let user choose                                                                                                                                                                                               | (c) with (b) as the recommended default for integer-looking columns: `DOUBLE` sniffing demonstrably corrupts values                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | H1/H3 (9007199254740993 → …992), H4 (`bigint` crosses exactly)                                                                                                                                                                         | M     | unresolved            |
| D15 | **Engine/CLI version divergence**          | (a) assume parity; (b) treat browser 1.4.3 as the only capability truth, CLI as control                                                                                                                                                                                                                                                     | (b) — every capability claim must be re-proven in-browser after any engine bump                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | §0; `store_rejects` divergence §7.3                                                                                                                                                                                                    | E     | unresolved            |
| D16 | `.ndjson` alias/copy                       | —                                                                                                                                                                                                                                                                                                                                           | **out of scope here**: a separate proposed row, no implicit format change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | brief hard constraint                                                                                                                                                                                                                  | —     | rejected-for-this-row |
| D17 | Per-table release primitive                | (a) add one (ADR supersession); (b) none                                                                                                                                                                                                                                                                                                    | keep (b) for now per **ADR 0047** (accepted) — CSV work must not assume it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | ADR 0047, `client.ts:1036`                                                                                                                                                                                                             | M/E   | accepted (ADR 0047)   |
| D18 | Telemetry                                  | any CSV option/preview event                                                                                                                                                                                                                                                                                                                | **none**: no new telemetry, no filenames, no option values, no error text (ADR 0025/0037/0045)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | existing bucketed events only                                                                                                                                                                                                          | M     | accepted (ADRs)       |

**Unresolved decisions blocking any runtime row: D1–D15 (15 rows).** D16 is excluded by the brief;
D17/D18 are already fixed by accepted ADRs.

---

## 9. Future files / fixtures / tests (hypothetical reservation — nothing created)

**None of these exist; they are a minimal reservation for a later, separately briefed runtime row.**

| Kind                                           | Hypothetical path                                                                                                                                                                                                                                                                        | Blocked by                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Option allowlist + SQL composer                | `packages/engine-duckdb/src/csv-options.ts` (+ `csv-options.test.ts`), reusing `format-view.ts` quoting                                                                                                                                                                                  | D1–D6, D13, D14                                       |
| Scan/sniff SQL                                 | extend `format-view.ts` (`fileScanSql(name, format, options?)`) or a sibling `csv-scan.ts`                                                                                                                                                                                               | D1, D2, D12                                           |
| Protocol                                       | options field on `engine/open` **or** a new `engine/preview`/`engine/sniff` request in `protocol.ts` (+ `protocol.test.ts`, `engine-executor.test.ts` legs)                                                                                                                              | **ADR required** (D12), D10                           |
| Worker/registry                                | preview path that registers bytes without `CREATE`, or single-slot preview registry modelled on `comparison-registry.ts`                                                                                                                                                                 | D12, ADR 0047 constraints                             |
| Web flow                                       | `apps/web/src/csv/` preview panel + wiring in `App.tsx` (inside a named reservation like spec §3.4)                                                                                                                                                                                      | D7–D11, EW-02D copy                                   |
| Fixtures (golden, synthetic, manifest-checked) | `fixtures/csv/leading-zeros.csv`, `quoted-empty.csv`, `late-bad-row.csv` (bad token beyond `sample_size`), `quoted-newline.csv`, `dup-header.csv`, `unsafe-int.csv`, `semicolon.csv` + `manifest.json` entries + `fixtures/csv/generate.sh`                                              | repository fixture rule (generator + checksums first) |
| Regression tests                               | complete-check predicate test (mirroring `composeOverlayCastCheckSql`), catalog-neutrality test (previews leave `duckdb_tables()/duckdb_views()` unchanged), no-silent-skip test (`ignore_errors` refused), lexeme test (`0017` survives), error-classification test once D10 is decided | D8, D10, D12                                          |

**Questions that block this reservation:** D12 (how a preview reaches the engine at all — protocol or
open-options), D10 (what the failure surface can honestly say), D8 (what "complete" means and its
budget, D11), D6/D5/D4/D1 (parse policy), D9/D13/D14. Per spec §5, **no runtime CSV row may start
until browser exposure, ownership, complete-check meaning and the remaining policy decisions are
resolved and accepted**, and any new protocol/format receives its own ADR.

---

## 10. Compliance statement

- Repository: read-only; verified clean at `c841fe4…` before and after (no source/test/config/fixture/
  lockfile/dependency/API change; no installs; no push).
- Probes: disposable, bounded, synthetic `/tmp` data; already-installed APIs only (duckdb-wasm 1.32.0,
  Playwright 1.63.0, esbuild 0.28.2, DuckDB CLI 1.5.5 as control); isolated probe engine only — never
  the user's live session, never real files; `127.0.0.1` only; telemetry env unset; no uploads.
- Hard constraints honored: no `.ndjson` alias/copy change, no silent skip-bad-row (and `ignore_errors`
  is refused on evidence), no automatic locale inference, no engine `Cancel` promise, no new
  protocol/format without separate ADR, no sample-as-full-validation claim, no `count(*)`-as-conversion
  claim, no release primitive assumed, no approval of this document by its author.
- Decision owner for the returned ledger: **maintainer** (policy rows) and **maintainer + engine
  owner** (ADR-gated rows). This document is delivered for independent review, not accepted.
