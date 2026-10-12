// SPDX-License-Identifier: AGPL-3.0-or-later
/* global process, console */

/**
 * Spike runner (ptv-1) — the committed `run:spike` entry. One command that:
 *   1. re-execs under xvfb-run when headless (VS Code is an Electron GUI),
 *   2. generates the 1M-row on-demand fixture (unless DUCKDB is unavailable),
 *   3. builds the extension + webview + worker bundles,
 *   4. launches the real VS Code desktop extension host via @vscode/test-electron,
 *   5. merges the packaging artifact sizes and writes `dist/spike-results.json`,
 *   6. prints a value-free summary the reviewer can compare against the report,
 *   7. asserts the headline evidence is present and true and exits non-zero
 *      otherwise (a run that merely finishes is not a successful run).
 *
 * The reviewer's reproduction command is exactly:
 *   xvfb-run -a corepack pnpm --filter @assay/vscode run:spike
 * (`run:spike` adds xvfb-run itself when DISPLAY is unset, so the bare script
 * works too on a headless box).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

// Step 3: build.
execFileSync(process.execPath, [path.join(here, 'build.mjs')], { stdio: 'inherit' })

// Step 4: launch the real VS Code extension host.
const resultsPath = path.join(dist, 'spike-results.json')
const extensionDevelopmentPath = appRoot
const extensionTestsPath = path.join(dist, 'spike-test.cjs')
const { runTests } = await import('@vscode/test-electron')

function findVSCodeExecutable() {
  if (process.env['VSCODE_EXECUTABLE'] !== undefined) {
    return process.env['VSCODE_EXECUTABLE']
  }
  for (const candidate of ['/usr/share/code/code', '/usr/bin/code']) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return undefined // let @vscode/test-electron download a managed build
}

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
  ASSAY_SPIKE_DRILL: process.env['ASSAY_SPIKE_DRILL'] ?? '',
}

await runTests({
  vscodeExecutablePath: findVSCodeExecutable(),
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
const drillMode = extensionTestsEnv.ASSAY_SPIKE_DRILL === 'missing-extension'
report.harness = {
  fixturePath,
  duckdbCli: process.env['DUCKDB'] ?? 'duckdb',
  node: process.version,
  vscodeExecutable: findVSCodeExecutable() ?? 'downloaded-managed-build',
  // ptv1-2: the network block is IN-HARNESS (no proxy/hosts changes needed).
  networkBlocked: {
    blockedHost: 'extensions.duckdb.org',
    layers: [
      'CSP: connect-src excludes the host (browser refuses before the network)',
      'in-worker interceptor: the vendored glue shim refuses fetch/XHR to the host (assay-netblock-refusal)',
    ],
    drillMode,
  },
}
writeFileSync(resultsPath, JSON.stringify(report, null, 2) + '\n')

// Step 6: value-free summary.
const environment = report.environment ?? {}
const fixture = report.fixture ?? {}
const mvp = report.bundles?.mvp ?? {}
const eh = report.bundles?.eh ?? {}
console.log('\n=== ptv-1 spike summary ===')
console.log(
  `target:                 ${String(report.target)} (VS Code ${String(report.vscodeVersion)})`,
)
console.log(`origin:                 ${String(environment.origin)}`)
console.log(`crossOriginIsolated:    ${String(environment.crossOriginIsolated)}`)
console.log(`SharedArrayBuffer:      ${String(environment.sharedArrayBuffer)}`)
console.log(
  `mvp boot:               ok=${String(mvp.ok === true)} bootMs=${String(mvp.bootMs)} version=${String(mvp.version ?? '')}`,
)
console.log(`eh boot:                ok=${String(eh.ok === true)} ${String(eh.error ?? '')}`)
console.log(`engine adapter:         ${String(mvp.adapter ?? 'spike-local (ptv1-1 seam missing)')}`)
// ptv1-2: vendored assets, network block, package size.
const vendored = report.vendoredAssets ?? {}
const vendoredPin = report.vendoredAssetsPin
const mb = (bytes) => (Number(bytes) / (1000 * 1000)).toFixed(2)
if (vendoredPin !== undefined) {
  const total = vendoredPin.files.reduce((sum, f) => sum + Number(f.bytes), 0)
  const detail = vendoredPin.files.map((f) => `${f.name} ${mb(f.bytes)} MB`).join(', ')
  console.log(
    `vendored assets:        ${mb(total)} MB in ${vendoredPin.files.length} files (${detail}) — one mvp bundle + Parquet extension, zero network fetches`,
  )
  console.log(
    `version pin:            @duckdb/duckdb-wasm ${String(vendoredPin.duckdbWasmVersion)} / DuckDB ${String(vendoredPin.duckdbVersion)} / ${String(vendoredPin.extensionPlatform)} (license: ${String(vendoredPin.license)})`,
  )
}
console.log(
  `network block:          armed on extensions.duckdb.org (CSP connect-src excludes it + in-worker fetch/XHR refusal)${drillMode ? ' — DRILL MODE: missing-extension' : ''}`,
)
console.log(
  `parquet extension:      vendored local serve state=${String(vendored.shimState ?? 'n/a')} post-open loaded=${String(report.fixture?.parquetExtension?.loaded)} installed=${String(report.fixture?.parquetExtension?.installed)}${drillMode ? ' (drill: no vendored bytes)' : ''}`,
)
console.log(`fixture rows:           ${String(fixture.rows)} (${String(fixture.bytes)} bytes)`)
console.log(`ttfrMs:                 ${String(fixture.ttfrMs)}`)
console.log(`pickerToFirstRowMs:     ${String(fixture.pickerToFirstRowMs)}`)
const heap = report.heap?.postFirstRow ?? {}
console.log(
  `post-first-row heap:    ${String(heap.usedBytes)} bytes used / ${String(heap.limitBytes)} limit`,
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
  // extension probe reports it never left the machine (installed=false,
  // loaded=false). The refusal marker in the open error is the direct proof
  // that the CDN fetch was ATTEMPTED and refused; if the engine surfaces the
  // failure opaquely, the installed=false + open-failure pair still pins it.
  const openError = String(
    report.errors?.['open.million'] ?? report.fixture?.blockedBy ?? report.fixture?.error ?? '',
  )
  headlineChecks = [
    {
      name: 'bundles.mvp.ok',
      ok: report.bundles?.mvp?.ok === true,
      value: report.bundles?.mvp?.ok,
    },
    {
      name: 'drill.open.failed',
      ok: report.errors?.['open.million'] !== undefined,
      value: openError,
    },
    {
      name: 'drill.refusal.evidence',
      ok:
        openError.includes('assay-netblock-refusal') ||
        (report.fixture?.parquetExtension?.loaded === false &&
          report.vendoredAssets?.drill !== undefined),
      value: openError,
    },
  ]
} else {
  headlineChecks = [
    {
      name: 'bundles.mvp.ok',
      ok: report.bundles?.mvp?.ok === true,
      value: report.bundles?.mvp?.ok,
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
        typeof report.bundles?.mvp?.version === 'string' &&
        report.bundles.mvp.version.startsWith(
          String(report.vendoredAssetsPin?.duckdbVersion ?? 'v1.4.3'),
        ),
      value: report.bundles?.mvp?.version,
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
