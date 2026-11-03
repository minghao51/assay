# Assay UX/UI Demo Rehearsal

**Status:** rehearsal record, **not** a publication, benchmark or new dataset. Authored 2026-11-03
for row **uxv-5** (R-13) of the [visual queue](../process/handoff/20261026-ux-ui-execution-queue.md);
requirements and honesty rules are in the
[implementation spec](09-ux-ui-implementation-spec.md) §5.

**Rehearsed commit:** `b40e37a` (clean tree). **Host:** Linux; Node v24.13.0, pnpm 11.26.0, DuckDB
CLI 1.5.5 (`DUCKDB=/tmp/duckdb`), Playwright 1.63.0 / Chromium 153. Both `ASSAY_TELEMETRY_ENDPOINT`
and `ASSAY_TELEMETRY_TOKEN` were unset (stock, collector-free build) and `ASSAY_NO_TELEMETRY` was
unset too, so the disclosure/opt-out was in its default state.

This document exists so a person can rehearse the shipped product cold, in two chapters, without
authoring data: Chapter 1 uses the only **committed** demo input; Chapter 2 derives its inputs from
the existing M5/M6 exit journeys on the fly. Every number below was **observed** in the run recorded
in [§7](#7-evidence-and-how-to-reproduce) — none was copied from the spec or from the journey
sources. Where a step did not reproduce, or a claim could not be checked, it is stated in
[§5](#5-what-this-does-not-claim) and [§6](#6-known-gaps) rather than smoothed over.

## 1. How the rehearsal ran

- `pnpm build` under the stock environment exits 0 but is entirely turbo cache hits; to rehearse
  output actually produced for this revision, the build was re-run with
  `pnpm exec turbo run build --force` (exit 0, 12/12 tasks executed).
- The built web bundle was served with
  `pnpm --filter @assay/web exec vite preview --port 4273 --strictPort` (HTTP 200).
- Browser walks ran in real Chromium through a Playwright driver script (evidence, not a product
  change). Like the committed journey specs, the Chapter 2 driver removes
  `window.showOpenFilePicker`/`showSaveFilePicker`, so its opens ride the hidden
  `<input type="file">` fallback and its exports ride the anchor-download fallback; Chapter 1 needs no
  picker at all (the example builds an in-memory `File`). The real File System Access picker path was
  therefore **not** exercised (§6).
- Light/dark were driven with `prefers-color-scheme` emulation at 1440×900, the same mechanism the
  committed theme specs use. Screenshots are artifacts for human review, never pixel baselines.

## 2. Chapter 1 — the bundled nested example (committed fixture)

The only committed demo input in this document is **`fixtures/jsonl/nested.jsonl`** (12 lines).
`Try with example data` (`IDLE_EXAMPLE_ACTION`) builds an in-memory `File` from that fixture's raw
text (`apps/web/src/App.tsx` imports it with `?raw`), so this chapter needs no picker and no
generated data.

### 2.1 Steps

1. Open `/`. The idle screen reads `No file open`, offers `Try with example data`, and states
   `Powered by DuckDB-WASM · local query execution` and
   `Dataset contents are processed locally. Edits are staged; export writes a copy.`
2. Activate `Try with example data`. The open reaches `ready`; the header reads
   **`Dataset · 12 rows · 10 columns`**, the grid shows 12 ready rows and the schema panel reads
   `10 columns`.
3. Inspect the schema: 10 first-class columns — `id, kind, label, score, deep, meta, tags, events,
hole, weird "quoted" key`. `tags` is a `VARCHAR` LIST offering `Explode list column tags`; expanding
   the `meta` STRUCT discloses `src` and `ver`.
4. Open a record: activating row 1 opens the inspector region `Record inspector — row 1`
   (`data-row-index="0"`; the dock's visible number is 1-based).
5. Activate `Explode list column tags`. The SQL panel reaches `done`, the editor holds the composed
   statement verbatim, and the result surface renders **20 rows × 11 columns** with headers
   `id, kind, label, score, deep, meta, events, hole, weird "quoted" key, tags, tags.pos`.

The composed statement as observed in the editor (wrapped for display; the `assay_t1` view name is
runtime-generated for the open):

```sql
SELECT "assay_t1"."id", "assay_t1"."kind", "assay_t1"."label", "assay_t1"."score",
       "assay_t1"."deep", "assay_t1"."meta", "assay_t1"."events", "assay_t1"."hole",
       "assay_t1"."weird ""quoted"" key", "_assay_explode"."tags" AS "tags",
       "_assay_explode"."tags.pos" AS "tags.pos"
FROM "assay_t1", UNNEST(CASE WHEN "assay_t1"."tags" IS NULL THEN [NULL] ELSE "assay_t1"."tags" END)
WITH ORDINALITY AS "_assay_explode"("tags", "tags.pos")
```

### 2.2 Observed counts (re-derived, not copied)

| Observation                     | Light | Dark | Independent cross-check (native `/tmp/duckdb` 1.5.5, same file) |
| ------------------------------- | ----- | ---- | --------------------------------------------------------------- |
| ready rows                      | 12    | 12   | `SELECT count(*)` → 12                                          |
| ready columns                   | 10    | 10   | `DESCRIBE` → 10                                                 |
| Explode result rows             | 20    | 20   | same statement → 20                                             |
| Explode result columns          | 11    | 11   | 11 projected columns                                            |
| distinct `(id, tags, tags.pos)` | 20    | 20   | `count(DISTINCT …)` → 20                                        |

The 20 rows are the honest UNNEST semantics of this fixture: `tags` contributes `2+0+3+1+2+4+1+2+0+1+2+2`
rows, empty lists contribute zero and each of the two NULL lists contributes one NULL row.

### 2.3 Keyboard-only pass (light and dark)

From `document.body`, Tab-only navigation completed the whole path in both schemes with identical
results:

| Landmark (accessible name)       | Tabs from previous landmark | Cumulative |
| -------------------------------- | --------------------------- | ---------- |
| `Try with example data`          | 3                           | 3          |
| `meta STRUCT` disclosure         | 13                          | 16         |
| `Explode list column tags`       | 6                           | 22         |
| first grid row (roving tab stop) | 18                          | 40         |
| `Close` in the record inspector  | 18                          | 58         |

- Open, struct disclosure, Explode, record inspector and closing the inspector all work with **no
  pointer**; the keyboard Explode result is byte-identical to the pointer pass.
- **Gap:** after Enter opens the inspector, focus stays on the grid row, so `Escape` does **not**
  close it (the handler lives on the inspector section); closing costs 18 further Tabs, past the 12
  per-row `Delete row N` buttons and the Keyboard/Diagnostics disclosures.

## 3. Chapter 2 — the M5/M6 journeys on generated inputs

### 3.1 Inputs: generated per run, never committed

Reproduced exactly as spec §5 documents, from the repository root:

```bash
node --experimental-strip-types --input-type=module -e '
import { writeValidationDatasetA } from "./tests/e2e/support/validation-datasets.ts";
import { writeExitJourneyPair } from "./tests/e2e/support/diff-datasets.ts";
console.log(JSON.stringify({ validation: writeValidationDatasetA(), diff: writeExitJourneyPair() }));
'
# exit 0, stderr empty
```

This manual run emitted:

```text
{"validation":{"dataPath":"/tmp/assay-m5-3-a-<run>/orders-dirty-a.jsonl",
               "contractPath":"/tmp/assay-m5-3-a-<run>/orders-basic.contract.yaml"},
 "diff":{"aPath":"/tmp/assay-m6-5-journey-<run>/orders-a.jsonl",
         "bPath":"/tmp/assay-m6-5-journey-<run>/orders-b.jsonl"}}
```

The recorded run's suffixes were **`A769De`** for the M5 dataset/contract and **`vw887E`** for the M6
pair (the automated leg generated its own, different suffixes — see §3.2 and §7). `<run>` below stands
for whichever per-run suffix a reader's own generation produces.

Shapes were verified on disk, not from comments: dataset A is **7 JSONL lines / 7 rows** with
`order_id, region, amount`; the contract is `orders-basic` **v1** declaring **9 rules**; the M6 pair
is **5 rows per side** with the documented drift (`amount` BIGINT→DOUBLE, `legacy` removed, `region`
added, `note` nullable in B). The M6 pair is a **separate** per-run pair — not dataset A, and not
the repaired M5 export.

### 3.2 The automated journey leg

```bash
env -u CI ASSAY_E2E_PORT_WEB=4273 ASSAY_E2E_PORT_ENGINE=4279 ASSAY_E2E_PORT_DS=4280 \
  DUCKDB=/tmp/duckdb pnpm exec playwright test tests/e2e/m5-exit-journey.spec.ts tests/e2e/m6-exit-journey.spec.ts
# exit 0 — 4 passed (11.8s)
```

`m5-exit-journey.spec.ts` ran 1 leg; `m6-exit-journey.spec.ts` ran 3 (main pair, identical
zero-state, >K partial selection). The automated leg generates **its own** fresh inputs: a
before/after snapshot of the temp directories showed exactly two new directories created by the run,
different from the manual run's paths. The specs do not print those paths, so the directory diff is
the provenance for that statement (§6 records it as inference-plus-observation, not a printed log).

### 3.3 Manual walk: failure → staged repair → fresh validation → copy export

1. **Open** `orders-dirty-a.jsonl` → ready at **`Dataset · 7 rows · 3 columns`**.
2. **Import the contract** `orders-basic.contract.yaml` → panel shows
   `contract orders-basic version 1 · 9 rules · Basic quality rules for the orders sample`.
3. **Failure.** `Validate` → **`4 of 9 rules fail (7 rows checked).`**, 9 rule rows, 4 failing:
   `columns[0].unique` (`2 of 7 rows (29%)`, samples `base #0`/`base #5`, both `1001`),
   `columns[0].required` (`1 of 7`, `base #6` NULL), `columns[1].allowed-values` (`1 of 7`,
   `base #2` = `emea`), `columns[2].max` (`1 of 7`, `base #1` = `999`). No stale banner.
4. **Export the pre-fix report** → `Exported the failure report (9 rules) as JSON …`; the JSON is
   `assay-validation-report`, `valid: false`, `stale: false`, `datasetRows: 7`, contract
   `orders-basic` v1, all 9 rules with failing rules first.
5. **Staged repair** through the real editing UI, each violation reached by its sample's
   `Show row` channel (the editor was verified to open on the offending cell before typing):
   `base #5` `1001→1006`, `base #6` NULL→`1009`, `base #2` `emea→EMEA`, `base #1` `999→450`.
   The verdict stays `4 of 9 rules fail` and the stale banner appears; row count stays 7 (edits are
   staged, not inserts).
6. **Fresh validation** → **`Valid: 0 violations across 9 rules (7 rows checked).`**, stale banner
   gone, 0 failing rows.
7. **Fresh report export** → `valid: true`, `stale: false`, `datasetRows: 7`, every `failCount: 0`.
8. **Copy export** → the dialog states
   `Writes a new file with the current edited view. The opened file is not changed — Assay never
rewrites the source.`, view `7 rows`, and `Includes 4 staged changes — review in History`.
   `JSON Lines` → `Exported 7 rows as JSON Lines (324 B) … The opened file is unchanged.` The
   download contains exactly the four repaired values (`1002/APAC/450`, `1003/EMEA/80`,
   `1006/EMEA/40`, `1009/APAC/75`) plus three untouched rows, and the opened raw file's SHA-256 was
   identical before and after the walk — the source was never rewritten (ADR 0012).

### 3.4 CLI continuity (inside Chapter 2)

Run from `apps/cli` as the journey specs do (`node --import tsx src/index.ts …`; no published binary):

```bash
# the SAME raw dataset + contract the browser opened
node --import tsx src/index.ts validate <dataPath> --contract <contractPath> --format json --sample-limit 100   # exit 1
node --import tsx src/index.ts validate <dataPath> --contract <contractPath>                                    # exit 1
# the explicitly exported repaired copy
node --import tsx src/index.ts validate <exportedCopy.jsonl> --contract <contractPath> --format json --sample-limit 100   # exit 0, valid: true, 7 rows
```

Observed agreement, stated exactly:

- **Web pre-fix export vs CLI on the same raw files: 0 differences** across all 9 `ruleId`s,
  `failCount`, frozen `failPercent`, sample bookkeeping, `datasetRows`, `valid`, and the
  `(rowKey, value)` sample multisets. The CLI's two JSON runs were byte-identical. This is
  matching-raw-file agreement — the allowed kind.
- **CLI after the staged repair** still reports `INVALID — 4 of 9` on the raw file: that is the
  documented **base-view-only** behaviour (the CLI has no editing session), not a disagreement with
  the panel's post-fix verdict.
- **Explicitly exported copy:** the exported JSONL validates `VALID` in the CLI against the same
  contract — the only post-repair CLI statement made here. The browser round trip of that exported
  file was not walked (§6).
- Privacy: web exports carry no temp paths, file names or `fv-` tokens; the CLI human report names
  the dataset by basename only and never the directory; happy-path CLI stderr was empty.

### 3.5 Manual walk: confirmed-key comparison on the separate M6 pair

1. Open side A → **`Dataset · 5 rows · 5 columns`**; stage side B through the comparison control →
   comparison info shows **`5 rows`**.
2. **Disclosure order** observed: schema drift → column deltas → key selection.
3. **Schema drift: 4 findings** — `amount` type changed (same family) BIGINT→DOUBLE; `legacy`
   removed; `note` nullability changed (null share A 0 → B 0.2); `region` added.
4. **Profile deltas: 4 columns** — `id` mean shift 0.505964; `name` total variation 0.6 (new
   `a6,a7,b2`; vanished `a2,a4,a5`); `amount` mean shift 0.613482; `note` total variation 0.4
   (new `n6`; vanished `n4,n5`).
5. **Key proposal**: 3 candidates (`id`, `name`, `amount`), `id` checked as top candidate and
   disclosed unique/non-null on both sides. The panel states inference is a proposal.
6. **Confirm and run** → **`2 added, 2 removed, 2 changed — rows 5 → 5 (keys: id, inferred).`**
   `b #3`/`b #4` are report-only with **0** jump affordances; `base #3`/`base #4` removed with 2 jump
   affordances; `base #1` changed (`name, amount`) and `base #2` (`amount`).
7. **Export the diff report** → `assay-diff-report`, `baseViewOnly: true`, `stale: false` (web-only
   field), `keys: ["id"]`, `keySource: "inferred"`, sample limit 100/100; file names are omitted by
   design.

### 3.6 CLI continuity on the same M6 pair

```bash
node --import tsx src/index.ts diff <aPath> <bPath> --infer --sample-limit 100 --format json   # exit 1
```

After removing only the fields each surface legitimately omits (the CLI's `a`/`b`/`reportVersion`,
the web's `stale`), the two envelopes were **equal, 0 differences** — confirmed-key agreement on
matching raw files, not on an invisible overlay.

## 4. Inputs and provenance

| Chapter | Input                      | Committed?                                | Source                                                                    | Path shape (recorded suffixes in §3.1/§7)                        |
| ------- | -------------------------- | ----------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1       | nested JSONL example       | **Yes — the only committed demo fixture** | `fixtures/jsonl/nested.jsonl` via `?raw` in `apps/web/src/App.tsx`        | in-memory `File('nested.jsonl')`                                 |
| 2 M5    | dataset A (7 rows)         | No — per-run temp                         | `writeValidationDatasetA()` in `tests/e2e/support/validation-datasets.ts` | `/tmp/assay-m5-3-a-<run>/orders-dirty-a.jsonl`                   |
| 2 M5    | contract `orders-basic` v1 | No — per-run temp                         | same function                                                             | `/tmp/assay-m5-3-a-<run>/orders-basic.contract.yaml`             |
| 2 M6    | comparison pair (5+5)      | No — per-run temp                         | `writeExitJourneyPair()` in `tests/e2e/support/diff-datasets.ts`          | `/tmp/assay-m6-5-journey-<run>/orders-a.jsonl`, `orders-b.jsonl` |
| 2 auto  | M5/M6 inputs               | No — per-run temp                         | the journey specs call the generators                                     | fresh directories created by the automated leg                   |

The M6 pair is **separate** from dataset A and is **not** the repaired M5 export; no same-dataset or
repaired-export agreement is claimed anywhere in this document.

## 5. What this does not claim

- **Not a publication or a benchmark.** No new dataset, contract or fixture is introduced, nothing is
  uploaded, and the only timing mentioned (11.8 s for the two journey specs) is a wall-clock
  observation on one host, not a performance claim.
- **"Processed locally" is not "zero network requests".** The data never leaves the machine, but on
  this build loading a JSONL dataset (including the bundled example) issues a real
  `GET https://extensions.duckdb.org/v1.4.3/wasm_mvp/json.duckdb_extension.wasm` (HTTP 200) — the
  DuckDB-WASM extension autoload. The base host and the versioned path template are compiled into the
  shipped engine binary; the concrete platform/filename segment is composed at runtime, so the exact
  URL is not a literal in the bundle. No collector host was contacted, and the endpoint-free build
  contains no collector string. Anyone rehearsing offline should pre-warm or block that fetch.
- **CLI agreement is base-view only** unless stated otherwise: agreement is claimed for matching raw
  files (the pre-fix report and the M6 pair) and for the explicitly exported, reopened copy (the
  post-repair validation). It is never claimed for an invisible browser editing session.
- **Browser runs WASM; the CLI runs the native Node seam.** Their agreement is evidence of shared
  contract semantics, not of identical execution environments.
- **Telemetry caveats stand:** this rehearsal used a collector-free build with the disclosure/opt-out
  in its default state; the opt-out path itself was not opened (§6).
- **Input-format limits** are the product's: the rehearsal used JSONL (datasets, example) and YAML
  (contracts) only; Parquet/CSV paths were not re-rehearsed here.
- **Overlay/export boundary:** the source file is never modified; every statement about repaired data
  refers to the staged view or to an exported copy.
- **Human approval still gates the public surface.** This document rehearses the shipped product
  locally; new public demo-data curation, publication and any live telemetry collector remain
  maintainer decisions (see the [manual actions](../process/manual-actions.md) list).

## 6. Known gaps

- **File System Access picker path not exercised.** The driver removes the FSA globals (as the
  committed specs do), so opens/exports rode the hidden-input and anchor-download fallbacks.
- **Telemetry Settings disclosure/opt-out not opened** during the rehearsal; "no collector traffic"
  is observed on this endpoint-free build only.
- **Chapter 2 is not keyboard-only end to end.** Chapter 1 was (both schemes, §2.3); opening a
  dataset in Chapter 2 uses the same controls the committed a11y suite drives, but the full chapter-2
  path was pointer-driven.
- **M6 zero-state and >K legs** were covered by the automated run, not walked manually.
- **M6 profile deltas** were read from the running UI and CLI (which agreed field-for-field) rather
  than re-derived from scratch with native SQL; row counts were independently re-derived.
- **The automated leg's temp paths are inferred, not printed.** The journey specs do not print the
  directories they generate, so "the automated leg used different inputs" rests on a before/after
  snapshot of `/tmp/assay-m5-3-a-*` and `/tmp/assay-m6-5-journey-*` (exactly two new directories
  appeared, neither matching the manual run's), not on a logged path.
- **The exported copy was not reopened in the browser** — only in the CLI.
- **One unexplained console warning** (`Buffering missing file: assay-export-1`) appeared once during
  the M5 copy export.
- **Observed copy quirk, not asserted as a defect:** the clean validation's export success line still
  calls the payload a "failure report" even when the report is `valid: true`.
- **Keyboard gap** recorded in §2.3: `Escape` does not close the record inspector after Enter opens
  it; closing costs 18 Tabs to `Close`.

## 7. Evidence and how to reproduce

Recorded evidence (logs, screenshots, exported artifacts) lives outside the repository under
`/tmp/assay-ux-uxv5-worker-logs/` for this run; it is not committed. The recorded run generated
`/tmp/assay-m5-3-a-A769De/` (dataset A, 7 rows, plus the 9-rule contract) and
`/tmp/assay-m6-5-journey-vw887E/` (the 5+5 comparison pair); the automated leg created
`/tmp/assay-m5-3-a-5FivBD/` and `/tmp/assay-m6-5-journey-alUVT6/` (from the before/after snapshot in
§6). To reproduce:

```bash
# 1. build and serve the shipped UI (stock, telemetry-unset environment)
env -u ASSAY_TELEMETRY_ENDPOINT -u ASSAY_TELEMETRY_TOKEN -u ASSAY_NO_TELEMETRY \
  pnpm exec turbo run build --force
pnpm --filter @assay/web exec vite preview --port 4273 --strictPort

# 2. generate the Chapter 2 inputs (per-run temp files; nothing is committed)
node --experimental-strip-types --input-type=module -e '
import { writeValidationDatasetA } from "./tests/e2e/support/validation-datasets.ts";
import { writeExitJourneyPair } from "./tests/e2e/support/diff-datasets.ts";
console.log(JSON.stringify({ validation: writeValidationDatasetA(), diff: writeExitJourneyPair() }));
'

# 3. prove the two journeys still pass end to end
env -u CI ASSAY_E2E_PORT_WEB=4273 ASSAY_E2E_PORT_ENGINE=4279 ASSAY_E2E_PORT_DS=4280 \
  DUCKDB=/tmp/duckdb pnpm exec playwright test tests/e2e/m5-exit-journey.spec.ts tests/e2e/m6-exit-journey.spec.ts
```

A plain `pnpm build` is often a full turbo cache hit; force it (or delete `apps/web/dist`) before
claiming built-output evidence. The M5/M6 UI paths themselves are pinned by the two specs above and
by the validation/diff component pins; this document adds the human rehearsal, not new tests.

## 8. Sources this document cites

- Requirements and honesty rules: [implementation spec](09-ux-ui-implementation-spec.md) §5; row
  [uxv-5](../process/handoff/20261026-ux-ui-execution-queue.md) of the visual queue.
- Journeys: `tests/e2e/m5-exit-journey.spec.ts`, `tests/e2e/m6-exit-journey.spec.ts`.
- Input generators: `tests/e2e/support/validation-datasets.ts` (`writeValidationDatasetA`),
  `tests/e2e/support/diff-datasets.ts` (`writeExitJourneyPair`).
- Committed fixture: `fixtures/jsonl/nested.jsonl`.
- Decisions: [ADR 0012](../adr/0012-edit-overlay-and-transaction-semantics.md) (overlay edits),
  [ADR 0025](../adr/0025-telemetry-and-data-privacy-boundary.md) (privacy boundary),
  [ADR 0037](../adr/0037-telemetry-opt-out-consent.md) (opt-out),
  [ADR 0044](../adr/0044-workbench-shell-two-pane.md) (shell).
