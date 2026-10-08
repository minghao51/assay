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
report.harness = {
  fixturePath,
  duckdbCli: process.env['DUCKDB'] ?? 'duckdb',
  node: process.version,
  vscodeExecutable: findVSCodeExecutable() ?? 'downloaded-managed-build',
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
const headlineChecks = [
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
]
const failedChecks = headlineChecks.filter((check) => !check.ok)
if (failedChecks.length > 0) {
  console.error('\nheadline evidence: FAIL')
  for (const check of failedChecks) {
    console.error(`  missing/false: ${check.name} (got ${String(check.value)})`)
  }
  process.exitCode = 1
} else {
  console.log('headline evidence:      PASS (bundles.mvp.ok, fixture.rows, opfs.roundTrip)')
}
