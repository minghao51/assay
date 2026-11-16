# EW-03I prerequisite — CSV candidate acquisition, abandonment and supersession probe (ADR 0049)

**Date:** 2026-11-16. **Row:** EW-03I's first prerequisite — [ADR 0049](../../adr/0049-csv-options-preview-and-retention.md)
acceptance resolutions **3** ("`registerFileHandle` on a freshly picked `File` is the first path to prove,
in a named probe row, before any protocol row") and **4** ("a fresh-candidate acquire → abandon →
supersede probe with `duckdb_tables()`/`duckdb_views()` deltas is required before any web wiring").

**Status:** probe complete. **Read-only row:** no source, test, fixture, dependency or protocol change; no
install; nothing pushed. Probes, fixtures and transcripts live under `/tmp/assay-csv-acq/`; this record is
the only repository path created. Every measurement below is quoted from a saved run of that harness.

**Authority:** ADR [0049](../../adr/0049-csv-options-preview-and-retention.md) (route, slot-owned release,
evidence standard), ADR [0047](../../adr/0047-web-session-replacement-retains-retired-tables.md) (no
per-table release; `dispose` is terminal), ADR
[0048](../../adr/0048-engine-bundle-selection-and-honest-error-text.md) (the shipped `eh` pair; error text
is bundle-dependent), [EW-03D CSV contract](20261113-ew03-csv-contract.md) §4.0–§4.3, §6.2–§6.3, §7
(probe method and limits), and the
[post-R1 acceptance record](20261114-post-r1-decisions-accepted.md) (D12 opened, not implemented).

---

## 0. Baseline, artifacts and what is and is not claimed

```bash
cd /home/howt/work/dataworkbench && git rev-parse HEAD && git status --porcelain
# → 1757c79124cf9fb3616d1453892ac889cc22169d
# → (empty)   … clean
```

The brief named `3adf7cf`; `HEAD` is **`1757c79`**, one **docs-only** commit ahead of it
("docs(handoff): point the pickup at the accepted ADRs and the dispatched rows"). `git status` was empty
before the row and the only file this row creates is this record.

| Artifact (all under `/tmp/assay-csv-acq/`) | What it is                                                                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `acq.js`                                   | The probe: 32 steps, `eh` bundle, single-slot preview registry mirroring ADR 0049 decision 4                                                 |
| `duckdb/duckdb-browser-eh.worker.js`       | `eh` worker, sha256 `f8ab72b6b90b3ad8…`, 772,759 B — the acceptance pair                                                                     |
| `duckdb/duckdb-eh.wasm`                    | `eh` wasm, sha256 `4c221bfa59c11f24…`, 34,242,586 B, DuckDB `v1.4.3`                                                                         |
| `duckdb-vendor.js`                         | `@duckdb/duckdb-wasm` 1.32.0 glue + `apache-arrow` 17.0.0, bundled by the EW-03D row with the repo's installed esbuild (reused, not rebuilt) |
| `fixtures/cand_{a,b,c}.csv`                | Synthetic 4/3/6-row CSVs (83 / 69 / 116 B)                                                                                                   |
| `fixtures/cand_big.csv`                    | Synthetic 200,000-row / 5,064,906 B CSV (lazy-reader + mid-scan work)                                                                        |
| `server.mjs`, `index.html`, `drive.mjs`    | Localhost-only static server (`127.0.0.1:8741`), page shell, Playwright driver (installed `@playwright/test` 1.63.0)                         |
| `results.json`, `results-run2/3/4.json`    | Three saved runs of this harness (`results.json` is run 4); they differ only in timings — see §6 and §7                                      |

**Bundle actually used:** the `eh` pair, instantiated exactly as `packages/engine-duckdb/src/worker-core.ts`
does it (`new Worker(worker.js)` → `new AsyncDuckDB(VoidLogger, worker)` → `instantiate(eh.wasm)` →
`open({})` → `connect()`). Observed: `getVersion()` → `v1.4.3`, `select version()` → `v1.4.3`,
`getFeatureFlags()` → **17** (the EW-03D contract recorded **16** for `mvp`), Chromium
**153.0.8010.12**, `crossOriginIsolated=false`, `typeof WebAssembly.Exception === 'function'` (so the EH
pair is the valid choice on this browser). Every error string quoted below is what the `eh` build actually
returns; the masked `_setThrew` class recorded in EW-03D §6.1 for `mvp` did **not** occur once.

**Not claimed:** no repository build, unit test, browser suite, application runtime, UI/AT evidence, heap
or peak-memory measurement, no protocol or option-carrier change, no telemetry, no native-CLI control (the
CLI is not evidence under ADR 0049 item 8). Fixtures are synthetic `/tmp` bytes only; no user data, no
filename in any engine name.

---

## 1. The exact acquisition path on the shipped build (brief item 1)

**Answer: `AsyncDuckDB.registerFileHandle(name, file, DuckDBDataProtocol.BROWSER_FILEREADER, false)` is the
one API that registers a freshly picked `File`** — the same call the shipped worker already uses
(`packages/engine-duckdb/src/worker-core.ts:177-190`), here issued against a `File` that has never been
seen by any `TableRegistry`, with no `CREATE VIEW` and no protocol op.

```js
// the whole acquisition, verbatim from acq.js step A1
await db.registerFileHandle(
  'preview_p1',
  freshFile,
  duckdb.DuckDBDataProtocol.BROWSER_FILEREADER,
  false,
)
```

Observed at acquisition (catalog read back immediately after the call):

| Observation                    | Value                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Call result                    | resolved, `0.9–1.4 ms` for the 83 B candidate; `0.2–0.3 ms` for the 5,064,906 B one (3 saved runs)                                                                                   |
| `duckdb_tables()` user entries | **0**                                                                                                                                                                                |
| `duckdb_views()` user entries  | **0** (baseline was 0; 46 internal system views before and after)                                                                                                                    |
| `TableRegistry` entry          | **none** — the harness keeps no registry; the name is engine-generated (`preview_p1`)                                                                                                |
| Session SQL issued             | **none** (`createViewSql: null`)                                                                                                                                                     |
| Bytes read from the `File`     | **no read observed** — registration cost does not grow with file size (`0.2–0.3 ms` for 5 MB vs `0.9–1.4 ms` for 83 B). _Inference from timing: this build exposes no read counter._ |

The candidate is then scannable **with no view, no registry entry and no session table**:

```sql
select count(*) as n from read_csv('preview_p1')                                   -- 4
select * from read_csv('preview_p1') limit 3                                      -- 0017 | 10.5 | alpha
describe select * from read_csv('preview_p1')                                     -- id VARCHAR, amount DOUBLE, label VARCHAR
select Delimiter, Quote, Escape, HasHeader, SkipRows from sniff_csv('preview_p1')  -- "," | (empty) | (empty) | true | 0
```

`CREATE VIEW` is **not** required for a preview scan. When the slot does create its own view
(`CREATE VIEW "assay_preview_pN" AS SELECT * FROM read_csv('preview_pN')`), that view costs
`99.5–158.2 ms` on the 5 MB candidate (the sniffer reads a sample) versus `0.2–0.3 ms` for that candidate's
registration, and it is the **only** catalog object the preview ever adds.

**The M5/M7 gap this closes.** Probe **M5** proved catalog neutrality only for names the EW-03D harness had
_already registered at boot_, so nothing about a fresh candidate; probe **M7** proved
`insertCSVFromPath` materializes a user table (`probe_import_m7`) and therefore cannot serve a preview. This
probe exercises the missing leg end to end: **a genuinely fresh, never-registered `File` is registered,
scanned, superseded and dropped, with `duckdb_tables()`/`duckdb_views()` captured at every step** — and it
shows the acquisition is catalog-invisible (0/0), which is stronger than the ADR's accounting assumed
(§4 item 5's "one slot: file, view, registry entry").

**The other two registration APIs, for the record** (same fresh `File`, same session):

| API                                                                  | Registers a picked `File`?                                         | Cost                                                             | Catalog |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------- | ------- |
| `registerFileHandle(name, File, BROWSER_FILEREADER, false)`          | **yes — the `File` itself**                                        | `0.9–1.4 ms` (83 B) / `0.2–0.3 ms` (5 MB), no byte copy in JS    | 0/0     |
| `registerFileHandle(…, directIO = true)`                             | yes (variant)                                                      | `0.1–0.3 ms`; scans identically (`n = 4`)                        | 0/0     |
| `registerFileBuffer(name, new Uint8Array(await file.arrayBuffer()))` | yes, but the bytes are **moved**                                   | buffer is **detached by the call**: `byteLength` 83 → **0**      | 0/0     |
| `registerFileText(name, await file.text())`                          | yes, but the bytes are **materialized as a JS string** and decoded | `83` chars copied; a non-UTF-8 file cannot ride this path at all | 0/0     |

So the buffer/text paths are usable but they copy (or move) the candidate's bytes into the wasm heap on
the main thread before DuckDB ever sees them — precisely the "materializing" cost ADR 0049 route (b) is
supposed to avoid for a review that may be abandoned. `registerFileHandle` is the only path that leaves
the bytes in the picked `File` and lets DuckDB slice it lazily.

**Name-reuse semantics (matters for supersession):** ignoring the ADR's drop-before-restage rule,
`registerFileHandle('preview_p1', otherFile)` on a **live** name succeeds silently (`0.5–0.8 ms`, no error) and
the later reads return the **new** bytes (`n = 3`, `first_id = 0030`). A view, by contrast, refuses a
duplicate name loudly (`Catalog Error: View with name "assay_t1" already exists!`; §5). So file names
degrade silently on reuse and view names fail loudly — the two halves of the slot need different care.

---

## 2. Catalog deltas for the scripted sequence (brief item 2)

Deltas are `duckdb_tables()` / `duckdb_views()` filtered to `not internal` (a constant **46** internal
system views are present at every step and never move). Each row is a live snapshot taken immediately
after the event.

| #   | Event (scripted order)                                                               | user tables | user views | state                                                |
| --- | ------------------------------------------------------------------------------------ | ----------- | ---------- | ---------------------------------------------------- |
| 0   | baseline, fresh instance (4 synthetic `File`s fetched and constructed, unregistered) | 0           | 0          | clean                                                |
| 1   | **acquire** candidate A → `registerFileHandle('preview_p1', File)`                   | 0           | 0          | file registration only                               |
| 2   | scan with `read_csv('preview_p1')` + `sniff_csv` (no view, no registry)              | 0           | 0          | unchanged                                            |
| 3   | option change → re-scan (`all_varchar=true`, `delim=';'`)                            | 0           | 0          | unchanged (no re-registration)                       |
| 4   | re-register the same live name with candidate B (no drop)                            | 0           | 0          | unchanged (bytes replaced)                           |
| 5   | `directIO=true` variant on a probe-only name, then `dropFile`                        | 0           | 0          | unchanged                                            |
| 6   | `registerFileBuffer` path, scan, `dropFile`                                          | 0           | 0          | unchanged                                            |
| 7   | `registerFileText` path, scan, `dropFile`                                            | 0           | 0          | unchanged                                            |
| 8   | **abandon** the registered slot (`dropFile` only; no view existed)                   | 0           | 0          | back to baseline; scan → `IO Error: No files found…` |
| 9   | acquire candidate C + **slot's own view** `assay_preview_p2`                         | 0           | **1**      | +1 view                                              |
| 10  | **supersede**: stage slot `p3` while `p2` is still live                              | 0           | **2**      | both candidates live                                 |
| 11  | release the superseded slot — `DROP VIEW IF EXISTS` **then** `dropFile`              | 0           | **1**      | net 0 for the supersede                              |
| 12  | wrong-order hazard: fresh `p4` view, then `dropFile` **before** `DROP VIEW`          | 0           | 1 †        | post-cleanup snapshot; hazard moment was 0/2 (†)     |
| 13  | re-stage the same slot names (`p3`) after release                                    | 0           | 1          | net 0; new bytes (`n = 6, 0100`)                     |
| 14  | `dropFile` on a name that was never registered                                       | 0           | 1          | **no error thrown** (§2.2)                           |
| 15  | `DROP VIEW IF EXISTS` (ok) / `DROP VIEW` (throws) on a non-existent view             | 0           | 1          | unchanged                                            |
| 16  | **failed release** path: `CREATE VIEW` against a missing target → naive release      | 0           | 1          | file registration **retained** (§2.2)                |
| 17  | stage the 5 MB candidate into slot `p6` + view                                       | 0           | 1          | +1 view                                              |
| 18  | `DROP VIEW IF EXISTS` issued while a scan over that view is **in flight**            | 0           | **0**      | applied; scan completed correctly                    |
| 19  | `dropFile` issued while a scan over that file is **in flight**                       | 0           | 0          | waited for the scan, then applied                    |
| 20  | supersede the **same name** while a scan is in flight                                | 0           | 0          | in-flight result intact, new bytes for later scans   |
| 21  | abandon with an in-flight scan (intent-token bump, no cancel)                        | 0           | 0          | slot released after the scan drained                 |
| 22  | session open in the quick-open shape (`t1` file + `assay_t1` **view**)               | 0           | **1**      | `assay_t1`, not a table                              |
| 23  | preview slot `p8` beside the session view, then released                             | 0           | 1          | `assay_t1` untouched and scannable                   |
| 24  | duplicate `CREATE VIEW "assay_t1"` attempt                                           | 0           | 1          | loud `Catalog Error`                                 |
| 25  | retained state before dispose                                                        | 0           | 1          | session view only                                    |
| 26  | after `worker.terminate()` → fresh instance                                          | 0           | 0          | empty; old names unreachable                         |

† Row 12 is the **post-cleanup** snapshot, not the hazard moment. At the hazard moment the catalog held
**2** user views — `assay_preview_p3` (still live from steps 10–11) plus the left-behind
`assay_preview_p4` — and the probe took no snapshot at that instant, so the 2 is reconstructed from the step
order rather than measured. That p4's view still existed is shown behaviourally: the re-scan is
`IO Error: No files found that match the pattern "preview_p4"` (the view resolved and failed on its missing
file) rather than `Catalog Error: … does not exist`, and the following `DROP VIEW IF EXISTS` succeeded
(`C4.dropViewAfter.ok = true`).

**No preview step created a `t1`/`assay_t1` name.** No ledger snapshot before step 22 contains either name,
and no preview step inserts into a session registry (the harness has none). `t1`/`assay_t1` first appear in
the explicit session-open step 22; from then on a session view is deliberately live **beside** a preview —
step 23's snapshot taken while the preview was staged is 0 tables / **2** views
(`assay_preview_p8` + `assay_t1`) — and releasing `preview_p8` leaves `assay_t1` present and scannable
(`n = 4`, back to 0/1). `duckdb_tables()` **never** grew in any step, including the session open — quick open
creates a **view** (`createViewSql`, `format-view.ts`), so the ADR's "+1 session tables" is really "+1
session view".

### 2.1 What the drops actually release

- `DROP VIEW IF EXISTS "assay_preview_pN"` removes exactly one catalog view and nothing else: after it,
  `duckdb_views()` returns to baseline, and the `SELECT` that named it fails with
  `Catalog Error: Table with name assay_preview_p2 does not exist! Did you mean "assay_preview_p3"?`
- `dropFile('preview_pN')` removes the file registration and nothing else: after it, every `read_csv`
  naming it fails with `IO Error: No files found that match the pattern "preview_p2"`. It does not touch a
  view — dropping the file first leaves the view alive and failing with the same `IO Error` (step 12) —
  which is exactly why `runDiffStage` drops the view first (`engine-executor.ts:1099-1101`).
- Independence is proven in the other direction too: when a release **aborts at the `DROP VIEW`** (step 16),
  the `dropFile` never runs and the candidate is still scannable (`n = 6`) — so it is the `dropFile`, not
  the `DROP VIEW`, that removes the bytes.

### 2.2 A failed drop is silent or loud depending on which half fails — and both retain the slot

1. **Loud, and it retains:** if the slot's view was never created (a failed `CREATE VIEW`), a release written
   as `DROP VIEW` (no `IF EXISTS`) throws
   `Catalog Error: View with name assay_preview_p2 does not exist! Did you mean "assay_preview_p3"?`, the
   `dropFile` is never reached, and the candidate stays registered and scannable (`n = 6`). This is the
   ADR's "failure after the slot registered → +1 until the next slot event or `engine.dispose`" row, made
   concrete. The best-effort form (`DROP VIEW IF EXISTS` + `dropFile`, both swallowed —
   `engine-executor.ts:1099-1101`) releases it cleanly (scan then fails with `No files found`).
2. **Silent, and undetectable:** `dropFile('preview_never_registered')` resolved with no error in every
   observed run (`0.1–0.2 ms`; D1 passed in all five runs of this harness, three of them saved). **A missing
   release therefore cannot be detected by exception**, on this evidence. "No error" is not proof of release;
   the only reliable presence oracle on this build is a following scan (a `read_csv` that fails with
   `No files found` is released; one that reads rows is not).
3. **`copyFileToBuffer` poisons the release** (the sharpest new finding). A/B on two probe-only names:
   - release a handle-registered file **without** ever reading its bytes back → clean:
     `read_csv` → `IO Error: No files found that match the pattern "preview_q1"`;
   - `copyFileToBuffer` once **before** the drop (116 B), then `dropFile`, then `copyFileToBuffer` again →
     it returns **1 byte**, and `read_csv` on that name still _resolves_ (it read 0 rows this time; an
     earlier revision of the same leg failed instead with a `CSV Error on Line: 1` — "Invalid unicode (byte
     sequence mismatch)" — so the stub's shape is not stable, but its existence is).

   So `copyFileToBuffer` converts the lazy handle into an engine-side buffer that `dropFile` replaces with a
   1-byte stub rather than removing. This reproduces EW-03D probe **I6** exactly (1 byte where a throw or a
   clean miss was expected) and explains it: **a preview slot must never read the candidate's bytes back**,
   and a slot that does cannot claim its release. (The shipped export path uses `copyFileToBuffer`
   deliberately — `worker-core.ts` `copyExportBytes` — on export stems, never on a candidate.)

---

## 3. Retention accounting for the single slot (brief item 3)

The slot is exactly the ADR's: own id sequence (`p1…`), own view name (`assay_preview_pN`), own file name
(`preview_pN`), never a `TableRegistry` entry, and a slot-owned best-effort release. Measured against
ADR 0049's item-5 table:

| Event                                         | ADR 0049 (expected)                      | Measured on the shipped `eh` build                                                                                                                                                                                                         |
| --------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| pick / acquire, before any preview dispatch   | 0 — engine untouched                     | **0** — the 4 constructed `File`s change nothing; baseline stays 0/0                                                                                                                                                                       |
| preview registers the candidate               | +1 (file, view, registry entry)          | **0 catalog objects** — only a DuckDB file-registry entry, invisible to `duckdb_tables()`/`duckdb_views()`; `+1 view` only if the slot creates one                                                                                         |
| option change → re-scan of the same slot      | 0 (re-scans, never re-registrations)     | **0** — three option sets scanned against one registration, catalog byte-identical before/after                                                                                                                                            |
| abandon / cancel while the slot is live       | −1 attempted; 0 net if the drop succeeds | **0 net**: file-only slot → back to 0/0 (`dropFile` in `0.1–0.3 ms`); view+file slot → view dropped, file dropped, 0/0                                                                                                                     |
| supersede with a second candidate             | 0 net (+1 new, −1 old)                   | **exactly 0 net**: 0/1 → 0/2 → 0/1, with the old view and file both gone (`No files found`, `Table … does not exist`)                                                                                                                      |
| failure after the slot registered             | +1 until the next slot event or dispose  | **+1 retained**, confirmed twice: the aborted `DROP VIEW` release leaves the file scannable; an undetectable `dropFile` leaves whatever it was asked to remove                                                                             |
| adoption (fresh `engine.open` + slot release) | −1 attempted; 0 net; +1 session          | not wired (no protocol op exists); the shape was simulated: the preview names release to baseline and the session view (`assay_t1`) stays present and scannable — a session relation is a **view**, so `duckdb_tables()` still never grows |
| `engine.dispose`                              | releases everything                      | **releases everything**: terminate → new instance 0/0, old names unreachable (`No files found` for both `t1` and `preview_p8`)                                                                                                             |

**What remains until `engine.dispose`:** the file registration (bytes stay in the picked `File`; nothing is
copied into the engine), the slot's own view if it made one, and any candidate that a failed or undetectable
release did not remove. Nothing else — no `TableRegistry` entry, no session table, no persistent file. What
the pair does **not** release is engine memory: the wasm heap ceiling and peak use are **unmeasured here**
(EW-03D §6.3), and the 1-byte stub shows that `dropFile` after a byte read-back leaves engine-side state
behind.

**No host-reachable release claim.** There is no `engine/release`/`engine/drop` op, no protocol path to
`DROP VIEW` or `dropFile` except raw SQL on `engine/query` (which would desync the registry), and this probe
adds none. The release exercised here is worker-internal, on the slot's own names, exactly as ADR 0049
decision 4 and resolution 2 allow. ADR 0047 stands unchanged: for `TableRegistry` tables there is still no
per-table release, and `engine/dispose` is still the only whole-engine reclamation (`client.ts:1036-1069`;
the graceful half of it, `runDispose` at `engine-executor.ts:1904-1941`, performs the same `DROP VIEW` +
`dropFile` sweep that the slot performs for itself).

---

## 4. Slot naming and collision (brief item 4)

- Preview names are `p1…` (id), `assay_preview_pN` (view), `preview_pN` (registered file). Session names are
  `tN` (id and registered file) and `assay_tN` (view). No overlap by construction, and none observed: the
  session-shaped step created `t1` + `assay_t1`, the preview step `preview_p8` + `assay_preview_p8`, and
  each was independently scannable (`n = 4` and `n = 6`) while the other was live.
- **Superseded while a preview view exists:** measured twice. With a _second id_ (step 10) both views are
  live simultaneously — the old one still scans correctly (`n = 6`, `0100`) until it is dropped; nothing is
  silently rebound. With the _same_ names re-staged after release (step 13) the names are freely reusable
  and the reads return the new candidate (`n = 6`, `0100`) — the view name only becomes unusable if the
  release is skipped, and then the failure is loud (`View with name "assay_preview_p3" already exists!`).
- **Collision is loud, not silent.** A duplicate `CREATE VIEW` on a live name throws
  `Catalog Error: View with name "assay_t1" already exists!` — so an id-sequence bug that emitted a session
  name from the preview registry would fail the stage rather than silently attach a preview to a session
  relation. The residue risk ADR 0049 lists ("distinct prefixes make a collision unlikely, not impossible")
  is therefore detectable at stage time on this build, but it is **not impossible by construction** — one
  catalog, two registries, no namespace enforcement. A test must pin the name shapes (§7).

---

## 5. Cancellation and abandonment honesty (brief item 5)

- **There is no engine `Cancel`, and none was used.** `AsyncDuckDB.cancelPendingQuery` is exposed by the
  binding layer (`typeof … === 'function'`), but nothing in `packages/engine-duckdb/src` calls it — the only
  cancel in the package is `conn.cancelSent()`, which frees a _streamed_ result's tail
  (`engine-executor.ts:1985-1992`), not a user-facing abort. No `engine/cancel` request exists.
- **An abandoned scan runs to completion.** Measured with a genuinely in-flight scan (still pending at the
  observation point in every run, verified by a completion flag, not by timing luck): intent token bumped at
  `250.3 ms`, the scan kept going and returned its **complete** result (`30,430,017,900`) at `780.6 ms`.
- **Late results are dropped by the token guard, not by the engine.** `lateResultAdopted: false` in every
  run — the harness mirrors `cancelOpen`'s token bump (`App.tsx:1710`: `datasetSession.beginSession()` then
  idle) and the guard it relies on: the session-token claim at `App.tsx:166` (`createSqlRequestLedger`,
  claim seam 154–168), plus the post-await `tokenRef.current !== session` comparisons at `App.tsx:2151-2238`.
- **Dropping the slot while a scan is in flight is safe on this build.** `DROP VIEW IF EXISTS` issued from a
  second connection while a scan ran over that view returned after `218–362 ms` and `dropFile` after
  `217–342 ms` (the three saved runs) — in both cases it waited for the running scan instead of applying at
  once. In every run the in-flight scan still returned its complete, correct result and the catalog ended at
  baseline — no abort, no partial result, no error leak into the running query.
- **Superseding the same name mid-scan does not corrupt the running scan.** Released the name and
  re-registered a different candidate while a scan was in flight: the in-flight scan returned the old
  candidate's complete result (`3,343,335,300`), and the next scan read the new candidate (`n = 6`, `0100`).
- **What the user sees** is unchanged by this probe and worth restating: "stopped reviewing"/idle, never
  "operation aborted"; the slot release is best-effort and, if it fails, invisible until `engine.dispose`.

---

## 6. Verdict (brief item 6)

**The ADR's route holds on the shipped build**, with three corrections a runtime row must absorb:

1. **Acquisition is proven, and cheaper than the ADR priced it.** `registerFileHandle` on a freshly picked
   `File` registers, scans, supersedes and drops with **zero catalog objects** and no `TableRegistry` entry.
   Route (b) is real: the slot can exist with a file registration alone, and `read_csv` + `sniff_csv` over
   that name give the whole preview payload. Creating `assay_preview_pN` is an _option_, not a requirement,
   and it is the only thing that makes the preview visible in `duckdb_views()`.
2. **The slot-owned release works, but only on the clean path.** `DROP VIEW IF EXISTS` → `dropFile` returns
   the catalog to baseline and the name to "no files found". It is **silent on failure** (`dropFile` on a
   missing name did not throw in any observed run), so the accounting must assume the `+1` whenever it cannot
   verify; and a slot that ever reads its bytes back (`copyFileToBuffer`) leaves a 1-byte file behind, so
   that call must never touch a preview name.
3. **Nothing here is a per-table release.** No protocol op was added or implied; ADR 0047's boundary is
   intact, and `engine.dispose` is still the only whole-engine reclamation.

Route (a) — a genuinely registration-free preview — remains **unproven and unnecessary**: this probe shows a
_registration-only_ preview is available, so the choice between "registration-free" and "registering" no
longer decides whether an abandoned preview can leave a `.csv` readable by the engine. Retain-all is not
needed either, because the release was granted and works; it stays the documented fallback if a future
bundle refuses it.

**Honest limits of that verdict:** `eh` only (ADR 0048 makes error text and possibly behaviour bundle- and
browser-dependent); a constructed `File`, not one from a live file picker or File System Access handle; one
machine, one browser, no heap measurement; three saved runs of this harness, structurally identical (every
boolean, catalog count and error class) with only timings moving.

---

## 7. What a future EW-03I row must pin, and what stays unproven (brief item 7)

**Pin in tests/literals (named):**

| What                                           | Suggested pin                                                                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The acquisition call itself                    | a test asserting the preview path calls `registerFileHandle(name, file, BROWSER_FILEREADER, false)` — the only handle-based path                                                      |
| Preview names never collide with session names | literals: `p1` → `preview_p1` / `assay_preview_p1`; `t1` → `t1` / `assay_t1`; a unit test on the id→name functions, plus an assertion that no preview op inserts into `TableRegistry` |
| Release order and best-effort form             | `DROP VIEW IF EXISTS` **then** `dropFile`, both swallowed — same shape as `engine-executor.ts:1099-1101`; a test that a failed `DROP VIEW` still reaches `dropFile`                   |
| A release is never a `copyFileToBuffer`        | an assertion/fake that the preview slot never calls `copyFileToBuffer`/`copyBytes` on its candidate name (this probe's 1-byte residue)                                                |
| Catalog neutrality of acquire/scan/re-scan     | `duckdb_tables()`/`duckdb_views()` (filtered `not internal`) before/after = identical, optional-view case = exactly one extra view and back                                           |
| Abandon honesty                                | no cancel call; token bump only; the scan is allowed to finish; late result discarded by the intent token                                                                             |
| Single-slot behaviour                          | supersede leaves exactly one slot's view and one registration; re-staging the same names is legal and returns the new bytes                                                           |
| Retention disclosure                           | the record/UI statement must match §3's rows: what the slot releases, what survives until `engine.dispose`                                                                            |

**Still unproven (do not claim):**

1. **Heap/peak memory and repeated-cycle growth** — no measurement at all; the 1-byte stub proves engine-side
   state can survive `dropFile`, but whether N supersede cycles leak was not tested past a handful.
2. **A real picker / File System Access `FileSystemFileHandle`** — a constructed `File` only. FSA handles and
   `directIO` combinations were not part of the acceptance path.
3. **Non-EH browsers and the `mvp` bundle** — not probed here; ADR 0048 governs, and EW-03D's masked-error
   finding still stands for `mvp`.
4. **The graceful `engine/dispose` sweep** (`runDispose`) — not exercised; only `worker.terminate()` was.
5. **A worker/engine that dies mid-preview** (a release that cannot run at all) — not induced.
6. **Concurrency across lanes** — the preview was probed on one connection plus a second for DDL; ADR 0040's
   query-lane behaviour under grid traffic was not exercised.
7. **Any protocol or option-carrier behaviour** — there is no `engine/csv-preview`, no options on
   `engine/open`; none of that exists and none was simulated.

---

## 8. Transcript (bounded)

```bash
# baseline
cd /home/howt/work/dataworkbench && git rev-parse HEAD && git status --porcelain
# → 1757c79124cf9fb3616d1453892ac889cc22169d, clean

# disposable harness (only under /tmp/assay-csv-acq/)
mkdir -p /tmp/assay-csv-acq/{duckdb,fixtures}
cp packages/engine-duckdb/node_modules/@duckdb/duckdb-wasm/dist/\
{duckdb-browser.mjs,duckdb-browser-eh.worker.js,duckdb-eh.wasm} /tmp/assay-csv-acq/duckdb/
cp -r node_modules/.pnpm/apache-arrow@17.0.0/node_modules/apache-arrow/. /tmp/assay-csv-acq/arrow/
cp -r node_modules/.pnpm/flatbuffers@24.12.23/node_modules/flatbuffers/. /tmp/assay-csv-acq/flatbuffers/
# glue: the EW-03D row's esbuild bundle of the same 1.32.0 dist/duckdb-browser.mjs, reused as-is
cp /tmp/assay-ew/ew03-probe/duckdb-vendor.js /tmp/assay-csv-acq/

node /tmp/assay-csv-acq/gen-fixtures.mjs            # cand_a/b/c.csv + cand_big.csv (200,000 rows, 5.1 MB)
node /tmp/assay-csv-acq/server.mjs 8741 &           # 127.0.0.1 only
node /tmp/assay-csv-acq/drive.mjs 8741              # 32 steps → /tmp/assay-csv-acq/results.json
```

Abridged run 4 output (all 32 steps `ok: true`, `fatal: null`):

```text
boot.instantiate:eh                      ok     867.3 ms   eh worker + eh.wasm, v1.4.3, featureFlags 17
boot.versions                            ok      31.3 ms   getVersion/select version() = v1.4.3; featureFlags 17
catalog.baseline                         ok      82.3 ms   0 user tables / 0 user views (46 internal system views)
A1 acquire registerFileHandle            ok      16.8 ms   catalog 0/0, no TableRegistry entry, no SQL (the call itself 1.4 ms)
A2 scan with no view                     ok      73.4 ms   n=4; id:VARCHAR amount:DOUBLE label:VARCHAR; delim ","
A3 option change → re-scan               ok      41.1 ms   catalog unchanged (all_varchar, delim=; legs)
A4 re-register live name, no drop        ok      15.1 ms   silent; reads the NEW bytes (n=3, first_id 0030)
A6 registerFileBuffer                    ok      12.8 ms   caller buffer 83 B → 0 B (detached)
A7 registerFileText                      ok      16.5 ms   83 chars
B1 abandon (dropFile only)               ok        55 ms   IO Error: No files found that match the pattern "preview_p1"
C1 acquire + own view                    ok      29.8 ms   catalog 0/1
C2 supersede (second slot live)          ok      23.3 ms   catalog 0/2, both scans correct
C3 release old (view then file)          ok      12.9 ms   catalog 0/1, both names unusable
C4 file dropped before its view          ok      18.9 ms   view left failing: IO Error: No files found … "preview_p4"
C5 re-stage the same names               ok      17.1 ms   catalog 0/1, new bytes (n=6, 0100)
D1 dropFile(never registered)            ok       5.7 ms   no exception → "released" is not observable
D3 copyFileToBuffer A/B                  ok      17.9 ms   clean release vs 1-byte residue (116 B → 1 B)
D4 failed view creation + naive release  ok      18.2 ms   DROP VIEW throws; file retained (n=6) until dropFile
E1 stage 5 MB candidate + view           ok     285.5 ms   register 0.3 ms / CREATE VIEW 158.2 ms / scan 44.2 ms
E2 DROP VIEW during an in-flight scan    ok       868 ms   drop returned after 361.6 ms; scan returned 30430017900
E3 dropFile during an in-flight scan     ok     851.4 ms   drop returned after 341.5 ms; rescan → No files found
E4 supersede the same name mid-scan      ok     382.3 ms   in-flight result intact (3343335300); fresh scan reads new bytes
F1 abandon mid-scan                      ok     817.6 ms   bump at 250.3 ms, scan completed 780.6 ms, not adopted
G1 session open (t1 + assay_t1)          ok      19.4 ms   catalog 0/1 (a VIEW, not a table)
G2 preview beside the session view       ok      41.7 ms   0/2 during → 0/1 after; assay_t1 still scans
G3 duplicate view name                   ok      17.6 ms   Catalog Error: View with name "assay_t1" already exists!
H2 dispose (terminate)                   ok       0.1 ms   worker.terminate()
H3 fresh instance after dispose          ok    1077.5 ms   new instance 0/0; t1 and preview_p8 unreachable

```

---

## 9. Compliance statement

- Repository: read-only. Baseline `1757c79`, `git status --porcelain` empty before the row; this record is
  the **only** file created. No source, test, fixture, configuration, lockfile, dependency, bundle, protocol
  or format change; no install; nothing pushed.
- Probes: disposable, localhost-only (`127.0.0.1:8741`), synthetic `/tmp` fixtures, telemetry env unset and
  no sink in the harness page; the installed `@duckdb/duckdb-wasm@1.32.0` `eh` pair and the installed
  Playwright Chromium only; an isolated probe engine, never a live user session, never a real file.
- Constraints honoured: no engine `Cancel` promise (none exists, none used), no silent skip-bad-row, no
  automatic locale inference, no sample-as-validation claim, no `count(*)`-as-conversion claim, no release
  primitive assumed for session tables, no protocol change, no approval of this record by its author.
- Owner of any decision this record informs: **maintainer + engine/protocol owner** (EW-03I scope). This
  record reports measurements; it does not accept, amend or supersede ADR 0047/0048/0049.
