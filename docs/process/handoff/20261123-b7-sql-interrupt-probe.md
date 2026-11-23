# B7 SQL-interrupt probe — does `cancelSent()` stop a query that is still computing?

**Date:** 2026-11-23. **Row:** PT-H carry-over B7 (successor queue §3 B7; brief
[R-9](../../process/handoff/20261122-h2-technical-carry-briefs.md#r-9--b7-sql-true-interrupt);
decision request [B7](20261121-b7-sql-interrupt-decision.md) §1, §4, §6).
**Status:** probe complete — **interruption works**. No source, test, protocol, config,
dependency or copy change; the probe ran outside the repository (WF-01P precedent) and is not
committed. Three acceptance questions answered below in §3, verdict in §4.

**Authority:** the brief is the contract; this record is the evidence it asked for. It re-opens
nothing: option (c) remains the standing floor, the copy freeze stands, and option (b) still needs
an ADR before any code (the ADR this passing probe triggers is
[ADR 0052](../../adr/0052-cancel-is-an-out-of-band-query-lane-op-with-a-typed-cancelled-outcome.md)).

## 1. Environment

| Item            | Value                                                                                                                                                                                                                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node            | v24.13.0 (pnpm 11.26.0)                                                                                                                                                                                                                                                                                                                          |
| Runtime         | **real Chromium**, headless `HeadlessChrome/153.0.8010.12`, driven by the repository's own `@playwright/test` 1.63.0 (installed browser `chromium_headless_shell-1243`). Node was not used to host the engine.                                                                                                                                   |
| Bundle          | pinned `@duckdb/duckdb-wasm@1.32.0`, the **EH pair the app ships**, served only from local disk (no network request in the page; the whole run is offline)                                                                                                                                                                                       |
| Worker artefact | `duckdb-browser-eh.worker.js` — 772,759 B, sha256 `f8ab72b6b90b3ad83077d47426d4a99d5d9a4c7e07cba1a2be37d655adc7c1ab`                                                                                                                                                                                                                             |
| WASM artefact   | `duckdb-eh.wasm` — 34,242,586 B, sha256 `4c221bfa59c11f24dbd750e70c90b9252eca6eec5633936e6a2ec766e55fd879`                                                                                                                                                                                                                                       |
| Glue            | `duckdb-browser.mjs` — 31,977 B, sha256 `4f8c0bb3c23d1ec457a451cc27418597b9a40dd772cceacc436a2cb7b9a49c18`                                                                                                                                                                                                                                       |
| Engine          | `AsyncDuckDB.getVersion()` → **`v1.4.3`**                                                                                                                                                                                                                                                                                                        |
| Apache Arrow    | `apache-arrow@17.0.0` (the version `packages/engine-duckdb/package.json` pins), served as the package's own ESM tree (`Arrow.dom.mjs`), plus its pinned `tslib@2.8.1` and `flatbuffers@24.12.23` ESM builds, resolved through an HTML import map. Vite resolves those same specifiers in the app build; no arrow code was modified.              |
| Hosting         | a scratch Node static server on `127.0.0.1` (ephemeral port) serving `/tmp/b7-probe/public` plus the three ESM trees straight out of the repo's `.pnpm` store; `.wasm` served as `application/wasm`; byte-identical copies of the duckdb artefacts under `public/dist/` (`sha256sum` re-verified after copying). No network origin is contacted. |

**Why this runtime is faithful to the shipped bundle.** `packages/engine-duckdb/src/worker.ts`
boots the engine as `new Worker(duckdbWorkerUrl)` + `new duckdb.AsyncDuckDB(new duckdb.VoidLogger(),
worker)` + `await db.instantiate(duckdbWasmUrl)`, with the `eh` pair when the platform reports wasm
EH. The probe does exactly that, with the same three calls in the same order, on the same classic
(non-pthread) worker script and the same wasm bytes. The only difference is the specifier that
produced the URLs: the app's URLs come from bundler-resolved `?url` imports, the probe's are
same-origin paths. The package's **Node** entry (`duckdb-node.cjs` / `@duckdb/node-api`) was not
used, and no Node-hosted worker shim was involved — the code under test is the browser path.

**Probe location.** The scratch page, runner and captured output live under `/tmp/b7-probe/`
(`public/`, `run.mjs`, `final-A.txt`, `final-B.txt`, `final-C.txt`). They are **not** committed, per
the WF-01P precedent; this record is the artefact that survives.

## 2. Shape of the probe (re-runnable)

Driver: `run.mjs` starts the static server, launches Chromium with a fixed profile directory
(`/tmp/b7-probe/profile`), opens `/index.html`, waits for `window.__probeComplete`, and prints the
page's JSON result, the console verbatim, and the HTTP request log. While the page runs it samples
OS CPU time every ~50 ms from `/proc/<pid>/stat` (`utime` + `stime`, `CLK_TCK` = 100) summed over
**the browser process and every descendant** — the renderer that hosts the dedicated DuckDB worker,
plus gpu/utility processes — located by the browser's `--user-data-dir` and walked through
`/proc/<pid>/stat`'s `ppid`. That is the measurement that distinguishes "stopped" from "still
burning CPU".

The page (`public/probe.js`):

1. Boots one `AsyncDuckDB` with the pinned worker + wasm (measured boot: 531–738 ms), then opens
   **two connections** — the query-lane stand-in (`conn`) and an observer (`other`), mirroring
   `worker-core.ts`'s per-lane `bootSession`.
2. Calibrates a deliberately long query, `SELECT sum(i) AS s, count(*) AS c FROM range(N) t(i)`,
   from one 50 M-row run, then picks `N` for ~2 s. `N` landed at 1.11 × 10⁹, 1.00 × 10⁹ and
   9.62 × 10⁸ in runs A/B/C; the uncancelled duration measured 1.06–1.30 s.
3. **Baseline ×3:** `conn.query(SQL)`, timed.
4. **Idle CPU window:** 1000 ms of pure sleep, to measure what "nothing running" costs.
5. **CPU control ×2:** park `conn.send(SQL)`, sleep into the middle of the compute, record a 1 s CPU
   window, then let the query finish and read its first batch (1 row, as expected). This window is
   the reference for "a query really is computing".
6. **Cancel runs ×3:** `const sendP = conn.send(SQL)`; `sleep(300)`; `conn.cancelSent()`; then a
   **quiet ~0.9 s CPU window with nothing else issued**; then read how `sendP` settled (settlement
   time recorded eagerly when the promise settled, not when it was awaited), then a same-connection
   `SELECT 41` timed, then an observer `SELECT 42` on the other connection timed.
7. **Latency sweep, one run each (single-run, labelled):** the same cycle with the cancel issued at
   50 ms and at 1000 ms.
8. **Idle cancel, one run:** `cancelSent()` with no pending query.
9. **Post-cancel full query, one run:** the identical long query on the same connection, timed.

Each figure below states its repeat count. Timings are `performance.now()` deltas in the page; the
machine is shared, so run-to-run spread is reported rather than averaged away.

## 3. The three answers

### Q1 — Does the parked `send()` settle when `cancelSent()` is called mid-compute, and with what?

**Yes. It rejects with an engine error, verbatim `Error: query was canceled`, within ~1–3 ms of the
cancel.** `cancelSent()` itself resolves `true`.

Three runs (A/B/C), each with the query ~300 ms into a ~1.1 s compute, were identical in shape:

| Run | cancel issued at | `cancelSent()` resolved in | its value | parked `send()` settled at | outcome                               |
| --- | ---------------- | -------------------------- | --------- | -------------------------- | ------------------------------------- |
| A/1 | 300.3 ms         | 0.8 ms                     | `true`    | 301.7 ms                   | rejected, `Error: query was canceled` |
| A/2 | 300.2 ms         | 0.9 ms                     | `true`    | 301.3 ms                   | rejected, `Error: query was canceled` |
| A/3 | 300.2 ms         | 1.0 ms                     | `true`    | 301.4 ms                   | rejected, `Error: query was canceled` |
| B/1 | 300.1 ms         | 1.1 ms                     | `true`    | 301.8 ms                   | rejected, `Error: query was canceled` |
| B/2 | 300.1 ms         | 0.9 ms                     | `true`    | 301.2 ms                   | rejected, `Error: query was canceled` |
| B/3 | 300.2 ms         | 0.8 ms                     | `true`    | 301.2 ms                   | rejected, `Error: query was canceled` |
| C/1 | 300.1 ms         | 1.2 ms                     | `true`    | 302.0 ms                   | rejected, `Error: query was canceled` |
| C/2 | 300.1 ms         | 0.8 ms                     | `true`    | 301.3 ms                   | rejected, `Error: query was canceled` |
| C/3 | 300.2 ms         | 2.4 ms                     | `true`    | 303.0 ms                   | rejected, `Error: query was canceled` |

The error object's shape, as recorded: `name: "Error"`, `message: "query was canceled"`,
`String(e)`: `"Error: query was canceled"`. The worker also logged the same error itself, with the
throw site verbatim:

```text
Error: query was canceled
    at ha.pollPendingQuery (http://127.0.0.1:<port>/dist/duckdb-browser-eh.worker.js:1:739189)
    at xo.onMessage (http://127.0.0.1:<port>/dist/duckdb-browser-eh.worker.js:1:749915)
    at globalThis.onmessage (http://127.0.0.1:<port>/dist/duckdb-browser-eh.worker.js:1:772397)
```

Two boundary cases, one run each: cancel at **50 ms** → `cancelSent()` returned `true` after 50.3 ms
(it waited until the pending query existed) and the parked `send()` rejected at 100.7 ms; cancel at
**1000 ms** → `true` after 2.0 ms, rejection at 1002.4 ms. Cancel with **nothing pending** →
`false`, after 0.1 ms (run A; 0.2 ms run B; 0.1 ms run C). So the boolean means "a pending query was
cancelled", not "a cancel was requested".

It never settled with an empty or partial reader: `sendShape` (recorded from the control runs, where
the send completes normally) is an Arrow `RecordBatchReader` exposing `next`, `readAll`, `cancel`,
`return`, `toDOMStream` and friends — but no cancel run ever reached that point.

### Q2 — Is the compute actually interrupted, or merely abandoned?

**Interrupted.** The discriminator is OS CPU time over the browser process tree, not latency and not
the worker's responsiveness.

| Window (A/B/C, cores busy — 1.0 = one core saturated)  | A                  | B                  | C                  |
| ------------------------------------------------------ | ------------------ | ------------------ | ------------------ |
| idle (1000 ms, nothing running)                        | 0.06               | 0.06               | 0.07               |
| control: uncancelled query computing (1000 ms) ×2      | 1.04 / 1.03        | 1.02 / 1.03        | 1.03 / 1.03        |
| after cancel at 300 ms, quiet window (~0.87–0.96 s) ×3 | 0.03 / 0.02 / 0.10 | 0.02 / 0.05 / 0.09 | 0.03 / 0.06 / 0.03 |
| after cancel at 50 ms, quiet window (single run)       | 0.07               | 0.10               | 0.09               |
| after cancel at 1000 ms, quiet window (single run)     | 0.08               | 0.09               | 0.03               |

While the query computes, the process burns a full core (1.02–1.04). In the window that starts
100 ms after the cancel resolves — with nothing else issued — it returns to the idle baseline
(0.02–0.10). A merely abandoned query would have kept that core at ~1.0 for the remaining
~0.8 s of its ~1.1 s compute; it does not. Nine cancelled runs across three fresh browser sessions
show the same drop.

**The caveat that matters, recorded because the brief warned about it:** the worker's event loop
**does** answer other connections while a query computes — an observer `SELECT 42` on the second
connection returned in 1.1–2.9 ms _during_ the uncancelled control query too. So "the engine answered
another query promptly after Cancel" would have proved nothing about interruption, and this record
does not use it as proof. DuckDB-WASM 1.32 polls a pending query across separate worker messages
(`START_PENDING_QUERY` / `POLL_PENDING_QUERY` / `CANCEL_PENDING_QUERY` in the bundled worker), which
is exactly why a cancel message can be handled mid-compute. The CPU windows above are the evidence
that the work actually stopped.

### Q3 — Is the connection immediately reusable after a cancel?

**Yes.** On the same connection, immediately after the cancel and the quiet window:

- `SELECT 41 AS x` succeeded every time, in **0.6–2.7 ms** (9 runs across A/B/C; range across all
  runs 0.6–2.7 ms), no error.
- The identical long query run once more after all cancel cycles took **1219.2 ms (A), 1181.8 ms (B),
  1033.2 ms (C)**, against those runs' own uncancelled baselines of 1148.2–1210.2 ms,
  1061.8–1295.8 ms and 1072.3–1170.8 ms respectively (3 baseline runs each). One earlier run of the
  same probe measured 1242.5 ms after the cancel against a 1231.1–1253.2 ms baseline. No post-cancel
  slowdown is visible in any run; the baseline spread inside a single run is as large as the
  difference.
- No connection had to be replaced, and the session (two connections, same database) stayed up for
  the whole probe.

## 4. Verdict and the branch it triggers

**Verdict: interruption works.**

On the pinned `@duckdb/duckdb-wasm@1.32.0` EH bundle, in real Chromium, `cancelSent()` on a query
that is still computing **before the first batch**:

1. returns `true` within ~1–3 ms,
2. makes the parked `send()` reject with `Error: query was canceled` within ~1–3 ms,
3. **stops the compute** (CPU returns to the idle baseline), and
4. leaves the connection immediately usable (millisecond follow-ups; the next long query runs at its
   normal duration).

That is the **passing** branch of the brief: draft the ADR (cancel op + out-of-band dispatch to the
query-lane connection, ADR 0040 amendment, scope per Q2, typed `cancelled` outcome, copy unchanged
unless Q4 is selected) and get it **accepted before any code**. The ADR is
[ADR 0052](../../adr/0052-cancel-is-an-out-of-band-query-lane-op-with-a-typed-cancelled-outcome.md),
**accepted 2026-11-23** — which unblocks the implementing dispatch and the dependent row R-14, but
implements nothing itself. Option (c) is not deleted by this result: it remains the floor until code
lands and the Cancel copy stays byte-identical either way.

## 5. What this probe does not establish

- **Streaming / multi-batch queries.** The probe's query is a single-batch aggregate. A query whose
  first batch arrives early and whose tail is still streaming was not probed here; the in-repo
  post-first-batch `cancelSent()` use (`engine-executor.ts`, tail cleanup) is a different code path
  with a different result state (a reader already exists).
- **Write-shaped ops.** Cancelling an `export` (`COPY … TO` into the virtual filesystem), a pipeline
  materialisation or any other query-lane write was **not** probed. Its failure semantics (a
  half-written file, a partially materialised table) are unverified, which is why the ADR scopes
  cancellation to `engine/query` only.
- **The app's bundled build.** The probe loads the package's own ESM entry (`duckdb-browser.mjs`)
  through an import map, not the Vite-bundled chunk the web app ships. The three engine calls are
  identical and the worker/wasm bytes are byte-identical, but the bundling step itself was not
  exercised.
- **Memory.** No memory measurement of any kind was taken; nothing here supports or refutes a memory
  claim for any option (option (a)'s concurrent-scan risk stays unmeasured).
- **Performance.** Nothing here is a performance claim. Every timing above states its repeat count;
  single-run figures are labelled; the machine is shared and the baseline spread within a single run
  (e.g. 1061.8–1295.8 ms in run B) is reported rather than hidden.
- **Other load shapes and other platforms.** One query shape, one machine (16 logical CPUs), one
  Chromium build, one bundle pair (`eh`). Firefox/WebKit, the `mvp` pair, and the Node/`@duckdb/node-api`
  seam were not probed.
- **Client/protocol behaviour.** The probe used `AsyncDuckDBConnection` directly. Nothing about the
  worker's `OpChannel`, the client's `send()` waiter, or the OpChannel single-pending rule was
  exercised — those are the ADR's business, not this probe's.
