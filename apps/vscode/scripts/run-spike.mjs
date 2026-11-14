// SPDX-License-Identifier: AGPL-3.0-or-later
/* global process, console */

/**
 * Slice-1 exit harness (ptv1-5) — the committed `run:spike` entry, upgraded
 * from the ptv-1 spike runner into the PT-V slice-1 pass/fail gate. One
 * command that:
 *   1. re-execs under xvfb-run when headless (VS Code is an Electron GUI),
 *   2. generates the 1M-row on-demand SYNTHETIC fixture (unless DUCKDB is
 *      unavailable),
 *   3. builds the extension + webview + worker bundles,
 *   4. launches the real VS Code desktop extension host via @vscode/test-electron,
 *   5. merges the packaging artifact sizes and writes `dist/spike-results.json`,
 *   6. prints a value-free summary — including the R2 timing envelopes (shipped
 *      `eh` boot ms, the open envelope, TTFR picker→first-row, live-heap delta) —
 *      the reviewer can compare against the report,
 *   7. asserts the headline evidence — the ptv1-1…ptv1-4 claims (real adapter
 *      identity, vendored zero-network serve, the shipped `eh` boot, TTFR/heap
 *      envelopes, grid a11y/keyboard/virtualization/sort-filter) — is present
 *      and true, and exits non-zero otherwise (a run that merely finishes is
 *      not a successful run; a failed `eh` boot exits non-zero — the ptv-1
 *      review carry-over R1, which since R1-B covers the ONLY shipped bundle).
 *
 * R1-B (ADR 0048 decision 3): the desktop package ships the `eh` pair only, so
 * the harness boots one bundle. The former `mvp` boot probe and its summary/
 * invariant lines are gone; `bundles.eh.*` now names the shipped engine, and
 * every substantive probe (vendored serve, fixture open, grid, OPFS) runs on it.
 *
 * Drills (ASSAY_SPIKE_DRILL=…), each a pass/fail harness mode:
 *   - `missing-extension` (ptv1-2): no vendored Parquet bytes → the CDN
 *     autoload path runs into the network block (in-worker 403 carrying
 *     `assay-netblock-refusal`); the drill headline asserts the Q5b failure
 *     mode is REPRODUCED — the open error names the refused
 *     `…/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm` URL (the offline
 *     negative proof, with the refused URL as the observed evidence).
 *   - `eh-boot-failure` (ptv1-5, R1): sabotages the built shipped (`eh`) glue
 *     bundle, so the boot — and with it every probe — fails; the run must then
 *     exit NON-ZERO via the `bundles.eh.ok` headline check.
 *
 * The reviewer's clean-worktree runbook — the exact committed commands,
 * verified end-to-end from a fresh worktree — lives in
 * apps/vscode/README.md ("Slice-1 exit harness — clean-worktree runbook").
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveVSCodeRuntime } from './vscode-runtime.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(here, '..')
const dist = path.join(appRoot, 'dist')

// 1. Headless: re-exec under xvfb-run (checked before anything expensive).
if (process.env['DISPLAY'] === undefined && process.env['ASSAY_SPIKE_NO_XVFB'] !== '1') {
  const xvfb = spawnSync('xvfb-run', ['-a', process.execPath, fileURLToPath(import.meta.url)], {
    stdio: 'inherit',
    env: process.env,
  })
  if (xvfb.error !== undefined) {
    console.error(
      'xvfb-run not found; set DISPLAY or install xvfb (or ASSAY_SPIKE_NO_XVFB=1 to try anyway)',
    )
    process.exit(1)
  }
  process.exit(xvfb.status ?? 1)
}

/** Step 2: generate the on-demand fixture, tolerating a missing CLI. */
function ensureFixture() {
  try {
    const out = execFileSync(process.execPath, [path.join(here, 'generate-fixture.mjs')], {
      encoding: 'utf8',
      env: process.env,
    })
    return out.trim().split('\n').pop() ?? ''
  } catch (error) {
    console.error('fixture generation failed (Q5 will be reported as blocked):')
    console.error(error instanceof Error ? error.message : String(error))
    return ''
  }
}

const fixturePath = ensureFixture()

/**
 * ptv1-4 live-heap budget for the grid surface (pinned; see README
 * "ptv1-4 grid envelope"). Method note — this DIFFERS from R4's absolute
 * figure, deliberately: R4's 1.14 MB was the ABSOLUTE post-first-row
 * `performance.memory.usedJSHeapSize` (forced `window.gc()`, the harness
 * launching VS Code with `--js-flags=--expose-gc`) of the PRE-ptv1-1 spike
 * page. Since ptv1-2 the vendored-asset plumbing (blob bootstrap of the
 * engine worker + glue shim + vendored extension serve) lives on the main
 * thread too, and the absolute pre-grid baseline measured 2026-10-13 is
 * ~5.7 MB — ptv1-2 state, not grid state. The honest grid-attributable
 * measure is therefore the DELTA:
 *
 *     gridDelta = heap.postGrid.usedBytes - heap.postFirstRow.usedBytes
 *
 * both sampled with the SAME forced-GC methodology in the SAME run
 * (postFirstRow = pre-grid baseline; postGrid = after the grid phase's
 * scroll/sort/filter sweeps — the surface's bounded steady state). The
 * budget pins R4's 1.14 MB figure with an explicit ONE-DOUBLING headroom
 * policy: the grid renderer bundle plus the model's bounded LRU window cache
 * are new live state, bounded by construction (windows ≤ 1000 rows, cache
 * ≤ 10,000 rows), so the grid may add at most 2 × 1.14 MB = 2.28 MB of live
 * main-thread heap over the pre-grid baseline.
 */
const R4_LIVE_HEAP_BYTES = 1_140_000
const GRID_HEAP_DELTA_BUDGET_BYTES = 2 * R4_LIVE_HEAP_BYTES
/** ptv1-4 TTFR envelope: picker→first-row (open start → first row visible) < 1 s. */
const GRID_TTFR_BUDGET_MS = 1_000

// Step 3: build.
execFileSync(process.execPath, [path.join(here, 'build.mjs')], { stdio: 'inherit' })

// Harness drill modes (selected by ASSAY_SPIKE_DRILL, threaded to the webview
// through the extension host's webview config).
const drillArg = process.env['ASSAY_SPIKE_DRILL'] ?? ''
const drillMode = drillArg === 'missing-extension'
const ehDrillMode = drillArg === 'eh-boot-failure'

// R1 drill: corrupt the built shipped (`eh`) glue bundle (the vendored assets
// stay checksummed build output — build.mjs just verified them). The webview
// then records a CONTAINED boot failure (bundles.eh.ok=false), so the headline
// assertion below — not a crashed process — decides the exit code. Since R1-B
// the `eh` pair is the ONLY shipped bundle, and this is the pin that a boot
// failure exits non-zero (the ptv-1 review carry-over: before the ptv1-5
// hardening that scenario exited 0).
if (ehDrillMode) {
  writeFileSync(
    path.join(dist, 'webview', 'duckdb-browser-eh.worker.js'),
    'throw new Error("assay-eh-drill: injected eh boot failure (R1 exit-code pin)")\n',
  )
}

// Step 4: launch the real VS Code extension host.
const resultsPath = path.join(dist, 'spike-results.json')
const extensionDevelopmentPath = appRoot
const extensionTestsPath = path.join(dist, 'spike-test.cjs')
const { runTests } = await import('@vscode/test-electron')

let vscodeRuntime
try {
  vscodeRuntime = await resolveVSCodeRuntime()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
console.log(`run:spike: VS Code executable — ${vscodeRuntime.source}`)

const userDataDir = path.join(tmpdir(), `assay-spike-vscode-${String(process.pid)}`)
const extensionsDir = path.join(tmpdir(), `assay-spike-vscode-ext-${String(process.pid)}`)
mkdirSync(userDataDir, { recursive: true })
mkdirSync(extensionsDir, { recursive: true })

const extensionTestsEnv = {
  ASSAY_SPIKE_FIXTURE: fixturePath,
  ASSAY_SPIKE_RESULTS: resultsPath,
  // ptv1-2 drill: 'missing-extension' skips the local Parquet install so the
  // stock CDN autoload path runs into the network block — the harness then
  // asserts the Q5b failure mode is REPRODUCED (the negative-proof that a
  // non-vendored asset WOULD fetch and be caught).
  ASSAY_SPIKE_DRILL: drillArg,
}

await runTests({
  vscodeExecutablePath: vscodeRuntime.executable,
  extensionDevelopmentPath,
  extensionTestsPath,
  extensionTestsEnv,
  launchArgs: [
    '--disable-extensions',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    // Expose `window.gc()` so the harness can sample live heap after the
    // blob-URL workaround allocations are revoked.
    '--js-flags=--expose-gc',
    '--skip-welcome',
    '--skip-release-notes',
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extensionsDir}`,
  ],
}).catch((error) => {
  console.error('VS Code extension host failed:', error)
  process.exitCode = 1
})

if (!existsSync(resultsPath)) {
  console.error(`no evidence report at ${resultsPath}`)
  process.exit(1)
}

// Step 5: merge packaging sizes.
/** Read a JSON evidence file, failing with a clear message instead of a raw throw. */
function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (error) {
    console.error(
      `failed to read JSON evidence at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exit(1)
  }
}

const report = readJson(resultsPath)
const artifactsPath = path.join(dist, 'spike-artifacts.json')
if (existsSync(artifactsPath)) {
  report.packaging = readJson(artifactsPath)
}
// ptv1-2: the vendored-asset pin evidence emitted by the build (checksummed).
const vendoredAssetsPath = path.join(dist, 'vendored-assets.json')
if (existsSync(vendoredAssetsPath)) {
  report.vendoredAssetsPin = readJson(vendoredAssetsPath)
}
report.harness = {
  fixturePath,
  duckdbCli: process.env['DUCKDB'] ?? 'duckdb',
  node: process.version,
  vscodeExecutable: vscodeRuntime.executable,
  // ptv1-2: the network block is IN-HARNESS (no proxy/hosts changes needed).
  networkBlocked: {
    blockedHost: 'extensions.duckdb.org',
    layers: [
      'CSP: connect-src excludes the host (browser refuses before the network)',
      'in-worker interceptor: the vendored glue shim refuses fetch/XHR to the host (assay-netblock-refusal)',
    ],
    drillMode,
    ehDrillMode,
  },
}
writeFileSync(resultsPath, JSON.stringify(report, null, 2) + '\n')

// Step 6: value-free summary.
const environment = report.environment ?? {}
const fixture = report.fixture ?? {}
const eh = report.bundles?.eh ?? {}
console.log('\n=== ptv-1 spike summary ===')
console.log(
  `target:                 ${String(report.target)} (VS Code ${String(report.vscodeVersion)})`,
)
console.log(`origin:                 ${String(environment.origin)}`)
console.log(`crossOriginIsolated:    ${String(environment.crossOriginIsolated)}`)
console.log(`SharedArrayBuffer:      ${String(environment.sharedArrayBuffer)}`)
console.log(
  `engine boot (eh):       ok=${String(eh.ok === true)} bootMs=${String(eh.bootMs)} version=${String(eh.version ?? '')}`,
)
console.log(`engine adapter:         ${String(eh.adapter ?? 'spike-local (ptv1-1 seam missing)')}`)
// ptv1-2: vendored assets, network block, package size.
const vendored = report.vendoredAssets ?? {}
const vendoredPin = report.vendoredAssetsPin
const mb = (bytes) => (Number(bytes) / (1000 * 1000)).toFixed(2)
if (vendoredPin !== undefined) {
  const total = vendoredPin.files.reduce((sum, f) => sum + Number(f.bytes), 0)
  const detail = vendoredPin.files.map((f) => `${f.name} ${mb(f.bytes)} MB`).join(', ')
  console.log(
    `vendored assets:        ${mb(total)} MB in ${vendoredPin.files.length} files (${detail}) — one eh bundle + the wasm_eh Parquet/JSON extensions, zero network fetches`,
  )
  console.log(
    `version pin:            @duckdb/duckdb-wasm ${String(vendoredPin.duckdbWasmVersion)} / DuckDB ${String(vendoredPin.duckdbVersion)} / ${String(vendoredPin.extensionPlatform)} (license: ${String(vendoredPin.license)})`,
  )
}
console.log(
  `network block:          armed on extensions.duckdb.org (CSP connect-src excludes it + in-worker fetch/XHR interceptor answers non-vendored requests with a local 403 carrying assay-netblock-refusal)${drillMode ? ' — DRILL MODE: missing-extension' : ''}${ehDrillMode ? ' — DRILL MODE: eh-boot-failure (R1 pin: run must exit non-zero)' : ''}`,
)
console.log(
  `parquet extension:      vendored local serve state=${String(vendored.shimState ?? 'n/a')} post-open loaded=${String(report.fixture?.parquetExtension?.loaded)} installed=${String(report.fixture?.parquetExtension?.installed)}${drillMode ? ' (drill: no vendored bytes)' : ''}`,
)
console.log(`fixture rows:           ${String(fixture.rows)} (${String(fixture.bytes)} bytes)`)
console.log(`ttfrMs:                 ${String(fixture.ttfrMs)}`)
console.log(`pickerToFirstRowMs:     ${String(fixture.pickerToFirstRowMs)}`)
console.log(
  `open envelope (R2):     openMs=${String(fixture.openMs)} rowCountMs=${String(fixture.rowCountMs)} ttfrMs=${String(fixture.ttfrMs)} — sum = picker→first-row ${String(fixture.pickerToFirstRowMs)} ms`,
)
const heap = report.heap?.postFirstRow ?? {}
console.log(
  `post-first-row heap:    ${String(heap.usedBytes)} bytes used / ${String(heap.limitBytes)} limit`,
)
// ptv1-4: the headless-grid surface evidence.
const grid = report.grid ?? {}
const postGrid = report.heap?.postGrid ?? {}
console.log(
  `grid first row:         ${String(grid.firstRowVisibleMs)} ms (open→first row visible; budget ${String(GRID_TTFR_BUDGET_MS)} ms) · load ${String(grid.loadMs)} ms`,
)
const gridHeapDelta =
  typeof postGrid.usedBytes === 'number' && typeof heap.usedBytes === 'number'
    ? postGrid.usedBytes - heap.usedBytes
    : undefined
console.log(
  `grid heap:              ${String(postGrid.usedBytes)} bytes used (pre-grid ${String(heap.usedBytes)}; grid delta ${String(gridHeapDelta)}; budget delta ≤ ${String(GRID_HEAP_DELTA_BUDGET_BYTES)} = R4 1.14 MB × 2)`,
)
console.log(
  `grid a11y/keyboard:     audit ok=${String(grid.audit?.ok)} (${String(grid.audit?.checks?.length ?? 0)} checks) · keyboard ok=${String(grid.keyboard?.ok)} (${String(grid.keyboard?.detail ?? '')})`,
)
console.log(
  `grid virtualization:    ok=${String(grid.virtualization?.ok)} (${String(grid.virtualization?.detail ?? '')})`,
)
console.log(
  `grid sort/filter-lite:  sort ok=${String(grid.sort?.ok)} (${String(grid.sort?.detail ?? '')}) · filter ok=${String(grid.filter?.ok)} (${String(grid.filter?.detail ?? '')})`,
)
console.log(
  `grid model stats:       requests=${String(grid.stats?.fetchCalls)} rowsRequested=${String(grid.stats?.rowsRequested)} rowsReceived=${String(grid.stats?.rowsReceived)} cached=${String(grid.stats?.cachedRows)}`,
)
console.log(`opfs available:         ${String(report.opfs?.available)}`)
console.log(`showOpenFilePicker:     ${String(report.fileSystemAccess?.showOpenFilePicker)}`)
console.log(`errors:                 ${JSON.stringify(report.errors ?? {})}`)
for (const line of report.workerDiagnostics ?? []) {
  console.log(`diag[${String(line.source)}]: ${String(line.message)}`)
}
console.log(`report:                 ${resultsPath}`)

// Step 7: headline-evidence assertion. A run that finishes is not a run that
// succeeded: exit non-zero unless the evidence the report's headline claims
// depend on is present and true. Without this a wedged boot (or a CSP/blob
// regression) still exits 0 and looks green to CI.
let headlineChecks
if (drillMode) {
  // Drill (ptv1-2): the Q5b failure mode must be REPRODUCED under the block —
  // the boot succeeds (no extension needed), the fixture open FAILS, and the
  // open error must carry the identifiable evidence that the blocked CDN
  // autoload was ATTEMPTED (ptv1-5 carry b), not an unrelated boot/open error.
  //
  // What that evidence looks like on the shipped `eh` build (R1-B): the
  // in-worker interceptor answers the blocked request with a local 403 whose
  // body carries `assay-netblock-refusal`, and DuckDB's own autoload error
  // surfaces as
  //   Extension Autoloading Error: … required extension 'parquet':
  //   Extension https://extensions.duckdb.org/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm
  //   is not available
  // so the check accepts the marker body OR that refused URL (host + pinned
  // DuckDB version + the `wasm_eh` platform segment + the vendored extension
  // file). Both are literals here, not derived from the report, so a run that
  // merely fails for another reason cannot pass. (Before R1-B the shim THREW
  // from the intercepted call; on the `eh` JS-EH build that throw became
  // `function signature mismatch`, which is why the interceptor now answers
  // with the refusal instead of throwing it.)
  const openError = String(
    report.errors?.['open.million'] ?? report.fixture?.blockedBy ?? report.fixture?.error ?? '',
  )
  const REFUSED_AUTOLOAD_URL =
    'https://extensions.duckdb.org/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm'
  headlineChecks = [
    {
      // R1-B: this is the shipped engine's boot (the drill boots no second
      // bundle); a boot failure must fail the drill outright.
      name: 'bundles.eh.ok',
      ok: report.bundles?.eh?.ok === true,
      value: report.bundles?.eh?.ok,
    },
    {
      // Same real-adapter identity invariant as normal mode (ptv1-1 carry b):
      // the drill boots the real adapter too.
      name: 'bundles.eh.adapter',
      ok: report.bundles?.eh?.adapter === '@assay/engine-duckdb',
      value: report.bundles?.eh?.adapter,
    },
    {
      name: 'drill.open.failed',
      ok: report.errors?.['open.million'] !== undefined,
      value: openError,
    },
    {
      // ptv1-2 carry (b): the refusal evidence is REQUIRED — the open must have
      // failed because the blocked autoload was refused, not for any other
      // reason. (The pre-ptv1-5 fallback disjunct — `fixture.parquetExtension.loaded
      // === false && vendoredAssets.drill !== undefined` — was unreachable: the
      // open fails before any fixture evidence is recorded, so `report.fixture`
      // is unset in drill mode and a check passable without the marker was vacuous.)
      name: 'drill.refusal.evidence',
      ok: openError.includes('assay-netblock-refusal') || openError.includes(REFUSED_AUTOLOAD_URL),
      value: openError,
    },
  ]
} else {
  headlineChecks = [
    {
      // R1-B: the shipped bundle's boot. There is no second bundle to compare
      // against, so this check carries the ptv-1 review carry-over R1 on its
      // own: any boot failure exits non-zero. Demonstrate with
      // ASSAY_SPIKE_DRILL=eh-boot-failure (see the README runbook).
      name: 'bundles.eh.ok',
      ok: report.bundles?.eh?.ok === true,
      value: report.bundles?.eh?.ok,
    },
    {
      // ptv1-1 carry (b): the adapter IDENTITY is ASSERTED here, not merely
      // printed in the summary — `bootAdapter` stamps '@assay/engine-duckdb'
      // only when the boot ran through the real client's seam, so a
      // faked/spike-local engine that manages to boot must still fail this
      // headline check.
      name: 'bundles.eh.adapter',
      ok: report.bundles?.eh?.adapter === '@assay/engine-duckdb',
      value: report.bundles?.eh?.adapter,
    },
    {
      name: 'fixture.rows',
      ok: typeof report.fixture?.rows === 'number' && report.fixture.rows > 0,
      value: report.fixture?.rows,
    },
    {
      name: 'opfs.roundTrip',
      ok: report.opfs?.roundTrip === true,
      value: report.opfs?.roundTrip,
    },
    {
      // ptv1-2: the vendored serve — the shim holds the vendored bytes and
      // the fixture open LOADED parquet under the armed network block, i.e.
      // the Q5b CDN dependency is served locally, not fetched.
      name: 'vendored.parquet.servedLocally',
      ok:
        report.vendoredAssets?.drill === false &&
        String(report.vendoredAssets?.shimState ?? '').startsWith('ready') &&
        report.fixture?.parquetExtension?.loaded === true,
      value: `shim=${String(report.vendoredAssets?.shimState)} loaded=${String(report.fixture?.parquetExtension?.loaded)}`,
    },
    {
      // ptv1-2: the running engine must be the pinned DuckDB version the
      // vendored extension binary was built for.
      name: 'vendored.engineVersionPin',
      ok:
        typeof report.bundles?.eh?.version === 'string' &&
        report.bundles.eh.version.startsWith(
          String(report.vendoredAssetsPin?.duckdbVersion ?? 'v1.4.3'),
        ),
      value: report.bundles?.eh?.version,
    },
    {
      // ptv1-2 offline pin: the webview records the CDN host the block is
      // armed against and BOTH block layers (the CSP connect-src exclusion +
      // the in-worker fetch/XHR refusal). `vendored.parquet.servedLocally`
      // above is the operative zero-network proof; this pins the armed
      // block's identity, and the missing-extension drill is the negative
      // proof (a non-vendored asset WOULD fetch — and be caught).
      name: 'offline.blockedHostPinned',
      ok:
        report.vendoredAssets?.blockedHost === 'extensions.duckdb.org' &&
        String(report.vendoredAssets?.networkBlock ?? '').includes('CSP connect-src') &&
        String(report.vendoredAssets?.networkBlock ?? '').includes(
          'in-worker fetch/XHR interceptor',
        ),
      value: `host=${String(report.vendoredAssets?.blockedHost)} layers=${String(report.vendoredAssets?.networkBlock)}`,
    },
    // ptv1-4: the headless-grid dataset surface — the row's done-when pins.
    {
      name: 'grid.productionEditingPathMounted',
      ok: report.grid?.editingPathMounted === true,
      value: report.grid?.editingPathMounted,
    },
    {
      name: 'grid.firstRowVisible',
      ok:
        typeof report.grid?.firstRowVisibleMs === 'number' &&
        report.grid.firstRowVisibleMs >= 0 &&
        report.grid.firstRowVisibleMs < GRID_TTFR_BUDGET_MS,
      value: report.grid?.firstRowVisibleMs,
    },
    {
      name: 'grid.heapWithinBudget',
      ok:
        typeof report.heap?.postGrid?.usedBytes === 'number' &&
        typeof report.heap?.postFirstRow?.usedBytes === 'number' &&
        report.heap.postGrid.usedBytes - report.heap.postFirstRow.usedBytes <=
          GRID_HEAP_DELTA_BUDGET_BYTES,
      value: `delta ${String(report.heap?.postGrid?.usedBytes - report.heap?.postFirstRow?.usedBytes)} <= ${String(GRID_HEAP_DELTA_BUDGET_BYTES)}`,
    },
    // ptv1-4 review (drills 4/4b): the next two checks are COMPLEMENTARY —
    // each catches what the other misses — so future edits must keep BOTH in
    // this headline set. `grid.domAudit` pins STRUCTURE (the roving-tabindex
    // audit: exactly one rendered tab stop, tabindex="-1" cells,
    // roles/aria counts/labels, bounded DOM, text-only cells), while
    // `grid.keyboardNavigation` pins BEHAVIOR (real ArrowDown/ArrowRight
    // keydowns move the roving focus and scroll). A structurally-perfect
    // grid with a dead key handler fails only the probe; a probe that passes
    // without honoring the roving contract fails only the audit. Dropping
    // either weakens the slice-1 a11y pin.
    {
      name: 'grid.domAudit',
      ok: report.grid?.audit?.ok === true,
      value: (report.grid?.audit?.checks ?? [])
        .filter((c) => !c.ok)
        .map((c) => c.name)
        .join(','),
    },
    {
      name: 'grid.keyboardNavigation',
      ok: report.grid?.keyboard?.ok === true,
      value: report.grid?.keyboard?.detail,
    },
    {
      name: 'grid.virtualized',
      ok: report.grid?.virtualization?.ok === true,
      value: report.grid?.virtualization?.detail,
    },
    {
      name: 'grid.sortFilterLite',
      ok: report.grid?.sort?.ok === true && report.grid?.filter?.ok === true,
      value: `sort=${String(report.grid?.sort?.detail)} filter=${String(report.grid?.filter?.detail)}`,
    },
  ]
}
const failedChecks = headlineChecks.filter((check) => !check.ok)
if (failedChecks.length > 0) {
  console.error('\nheadline evidence: FAIL')
  for (const check of failedChecks) {
    console.error(`  missing/false: ${check.name} (got ${String(check.value)})`)
  }
  process.exitCode = 1
} else {
  console.log(`headline evidence:      PASS (${headlineChecks.map((c) => c.name).join(', ')})`)
}
