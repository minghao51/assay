// SPDX-License-Identifier: AGPL-3.0-or-later
/* global process, console */

/**
 * ptv1-3 e2e runner — the committed entry for the row's done-when
 * verification. One command that:
 *   1. re-execs under xvfb-run when headless (VS Code is an Electron GUI),
 *   2. builds the extension + webview + e2e bundles (scripts/build.mjs),
 *   3. stages the committed synthetic fixtures into a temp workspace dir,
 *   4. resolves the VS Code executable: the CANONICAL CACHE first
 *      (`~/.vscode-test/vscode-linux-x64-<pinned>` — downloaded ONCE, then
 *      this runs fully offline), falling back to the system VS Code only if
 *      the download fails,
 *   5. launches the real VS Code extension host via @vscode/test-electron and
 *      runs test/e2e/dataset-runner.ts (dist/e2e-test.cjs),
 *   6. prints a value-free summary and exits non-zero on any failure.
 *
 * Run (reviewer-reproducible):
 *   xvfb-run -a corepack pnpm --filter @assay/vscode run e2e
 * (`run e2e` adds xvfb-run itself when DISPLAY is unset, so the bare script
 * works too on a headless box). The pinned version matches the one cached by
 * this script; override the executable with VSCODE_EXECUTABLE=/path/to/code.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveVSCodeRuntime } from './vscode-runtime.mjs'
import {
  cleanupCliConsumer,
  installCliConsumer,
  writeExpectedReports,
} from './installed-cli-agreement.mjs'

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

// 2. Build (extension host, webview bundles incl. dataset.js, e2e test entry).
execFileSync(process.execPath, [path.join(here, 'build.mjs')], { stdio: 'inherit' })

// 3. Stage the committed synthetic fixtures into a fresh workspace dir.
const workspaceDir = path.join(tmpdir(), `assay-e2e-workspace-${String(process.pid)}`)
const fixturesDir = path.join(appRoot, 'test', 'fixtures')
mkdirSync(workspaceDir, { recursive: true })
for (const name of ['synthetic-smoke.parquet', 'empty.csv']) {
  copyFileSync(path.join(fixturesDir, name), path.join(workspaceDir, name))
}
const comparisonA = path.join(workspaceDir, 'comparison-a.jsonl')
const comparisonB = path.join(workspaceDir, 'comparison-b.jsonl')
const rowsA = Array.from({ length: 12 }, (_, index) => ({ id: index + 1, value: index * 10 }))
const rowsB = Array.from({ length: 11 }, (_, index) => ({
  id: index + 1,
  value: index === 0 ? 999 : index * 10,
}))
rowsB.push({ id: 13, value: 120 })
writeFileSync(comparisonA, `${rowsA.map((row) => JSON.stringify(row)).join('\n')}\n`)
writeFileSync(comparisonB, `${rowsB.map((row) => JSON.stringify(row)).join('\n')}\n`)
writeFileSync(
  path.join(workspaceDir, 'validation-contract.yaml'),
  [
    'format: v1',
    'name: desktop-validation-proof',
    'version: 1',
    'columns:',
    '  - name: value_maybe_null',
    '    required: true',
    '',
  ].join('\n'),
)

// 4. Resolve the pinned runtime through the shared cache/download policy.
let vscodeRuntime
try {
  vscodeRuntime = await resolveVSCodeRuntime()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
console.log(`e2e: VS Code executable — ${vscodeRuntime.source}`)

// 5. Launch the real VS Code extension host and run the scenarios.
const resultsPath = path.join(dist, 'e2e-results.json')
const { runTests } = await import('@vscode/test-electron')
const userDataDir = path.join(tmpdir(), `assay-e2e-vscode-${String(process.pid)}`)
const extensionsDir = path.join(tmpdir(), `assay-e2e-vscode-ext-${String(process.pid)}`)
mkdirSync(userDataDir, { recursive: true })
mkdirSync(extensionsDir, { recursive: true })

let failed = false
await runTests({
  vscodeExecutablePath: vscodeRuntime.executable,
  extensionDevelopmentPath: appRoot,
  extensionTestsPath: path.join(dist, 'e2e-test.cjs'),
  extensionTestsEnv: {
    ASSAY_E2E_WORKSPACE: workspaceDir,
    ASSAY_E2E_RESULTS: resultsPath,
    ASSAY_E2E_EDIT_PROOF: '1',
  },
  launchArgs: [
    '--disable-extensions',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extensionsDir}`,
  ],
}).catch((error) => {
  failed = true
  console.error('VS Code extension host failed:', error)
})

// 6. Value-free summary + exit code.
if (!existsSync(resultsPath)) {
  console.error(`no e2e results at ${resultsPath}`)
  process.exit(1)
}
let results
try {
  results = JSON.parse(readFileSync(resultsPath, 'utf8'))
} catch (error) {
  console.error(
    `failed to parse ${resultsPath}: ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exit(1)
}
console.log('\n=== ptv1-3 e2e summary ===')
console.log(`vscode:        ${String(results.vscodeVersion)}`)
for (const [name, detail] of Object.entries(results.scenarios ?? {})) {
  console.log(`${name.padEnd(18)} ${JSON.stringify(detail)}`)
}
console.log(`extension host: ${failed ? 'FAILED' : 'exited cleanly'}`)

rmSync(userDataDir, { recursive: true, force: true })
rmSync(extensionsDir, { recursive: true, force: true })

// C2a runner-side reports are generated from the packed CLI runtime closure.
// This intentionally verifies the same installed-consumer shape used after publication.
const safeExport = results.scenarios?.safeExport
const exportedEffectiveCopy = safeExport?.exportedEffectiveCopy
if (typeof exportedEffectiveCopy !== 'string' || !existsSync(exportedEffectiveCopy)) {
  console.error(
    'safeExport result is missing exportedEffectiveCopy; rebuild the VS Code extension and run e2e',
  )
  process.exit(1)
}
let cliConsumer
try {
  cliConsumer = installCliConsumer()
  writeExpectedReports({
    cliPath: cliConsumer.cliPath,
    workspaceDir,
    comparisonA,
    comparisonB,
    editedPath: exportedEffectiveCopy,
  })
  console.log(
    `CLI expected reports written (baseline + edited); packages=${cliConsumer.packageCount}`,
  )
} catch (error) {
  console.error(
    `CLI diff report generation failed: ${error instanceof Error ? error.message : String(error)}`,
  )
  failed = true
} finally {
  if (cliConsumer !== undefined) cleanupCliConsumer(cliConsumer.tempRoot)
}

const requiredDiffProof = [
  'baselineAgreed',
  'editedAgreed',
  'baseViewOnlyFalse',
  'staleAfterEdit',
  'unconfirmedRefused',
  'navigation',
]
const diffProof = results.diffProof
const missingDiffProof = requiredDiffProof.filter(
  (field) => typeof diffProof !== 'object' || diffProof === null || diffProof[field] !== true,
)
if (missingDiffProof.length > 0) {
  console.error(`diffProof missing or false fields: ${missingDiffProof.join(', ')}`)
  failed = true
}

rmSync(userDataDir, { recursive: true, force: true })
rmSync(extensionsDir, { recursive: true, force: true })
if (failed) process.exit(1)
console.log('e2e: PASS')
