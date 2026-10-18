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
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveVSCodeRuntime } from './vscode-runtime.mjs'
import { cleanupCliConsumer, installCliConsumer } from './installed-cli-agreement.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(here, '..')
const dist = path.join(appRoot, 'dist')

/** The agreement helpers are bundled (from src/pure/cli-agreement.ts) for the runner. */
function requireCliAgreement() {
  const nodeRequire = createRequire(import.meta.url)
  return nodeRequire(path.join(dist, 'cli-agreement.cjs'))
}

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
// CSV, not JSONL: the vendored offline engine refuses to fetch DuckDB's json
// extension, so json/jsonl open needs a vendored-extension row of its own
// (recorded in the slice-2 queue). CSV reads with the built-in scanner.
const comparisonA = path.join(workspaceDir, 'comparison-a.csv')
const comparisonB = path.join(workspaceDir, 'comparison-b.csv')
// Decimal literals so DuckDB infers DOUBLE for `value` (edit-codec friendly;
// integer CSV columns arrive as BigInt cells in the grid projection).
const rowsA = Array.from({ length: 12 }, (_, index) => [index + 1, `${String(index * 10)}.0`])
const rowsB = Array.from({ length: 11 }, (_, index) => [
  index + 1,
  index === 0 ? '999.0' : `${String(index * 10)}.0`,
])
rowsB.push([13, '120.0'])
const csv = (rows) => `${['id,value', ...rows.map((row) => row.join(','))].join('\n')}\n`
writeFileSync(comparisonA, csv(rowsA))
writeFileSync(comparisonB, csv(rowsB))
// Agreement fixture classes (queue done-when): identical, schema-only,
// no-comparable, nested-presence — all staged against the SAME opened A.
writeFileSync(path.join(workspaceDir, 'comparison-identical.csv'), csv(rowsA))
writeFileSync(
  path.join(workspaceDir, 'comparison-schema.csv'),
  `${['id,value,score', ...rowsA.map((row) => [row[0], row[1], row[0]].join(','))].join('\n')}\n`,
)
writeFileSync(
  path.join(workspaceDir, 'comparison-onlykey.csv'),
  `${['id', ...rowsA.map((row) => String(row[0]))].join('\n')}\n`,
)
// Nested-presence pair: parquet with a list column (CSV cannot express one).
// id + tags only: with no shared non-key column the class asserts
// nested-typed schema flow without depending on cross-format value
// comparison (externally written parquet double columns showed an engine
// row-diff quirk — recorded in the queue notes). Generated with the repo's
// pinned DuckDB CLI (the Parquet golden-fixture binary; DUCKDB must point
// at it).
const duckdbBin = process.env['DUCKDB'] ?? '/tmp/duckdb'
if (!existsSync(duckdbBin)) {
  console.error(`nested fixture needs the DuckDB CLI at DUCKDB=${duckdbBin}`)
  process.exit(1)
}
execFileSync(
  duckdbBin,
  [
    '-c',
    `COPY (SELECT i AS id, [i, i * 2] AS tags FROM range(1, 13) t(i)) TO '${path.join(workspaceDir, 'comparison-nested.parquet')}' (FORMAT PARQUET)`,
  ],
  { stdio: 'pipe' },
)
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

// ptv2-6: the staged-diff scenario exported the desktop's baseline and
// edited reports plus the effective copy. Agreement with the INSTALLED CLI
// (packed consumer, the post-publication shape) is computed here, on common
// semantic fields only — mismatch messages carry field names, never values.
const stagedDiff = results.scenarios?.stagedDiff
if (
  typeof stagedDiff?.baselineReport !== 'string' ||
  typeof stagedDiff?.editedReport !== 'string' ||
  typeof stagedDiff?.exportedEffectiveCopy !== 'string' ||
  !existsSync(stagedDiff.baselineReport) ||
  !existsSync(stagedDiff.editedReport) ||
  !existsSync(stagedDiff.exportedEffectiveCopy)
) {
  console.error(
    'stagedDiff result is missing report/export paths; rebuild the VS Code extension and run e2e',
  )
  process.exit(1)
}
let baselineAgreed = false
let editedAgreed = false
let cliConsumer
try {
  cliConsumer = installCliConsumer()
  const agreement = requireCliAgreement()
  const desktopBaseline = JSON.parse(readFileSync(stagedDiff.baselineReport, 'utf8'))
  const desktopEdited = JSON.parse(readFileSync(stagedDiff.editedReport, 'utf8'))
  // The desktop reports must carry their own honesty flags: a session-only
  // baseline is base-view-only; the edited re-diff is not, and a freshly
  // re-run report is not stale.
  if (
    desktopBaseline.baseViewOnly !== true ||
    desktopEdited.baseViewOnly !== false ||
    desktopEdited.stale !== false
  ) {
    console.error(
      `desktop report honesty failed: baseline baseViewOnly=${String(desktopBaseline.baseViewOnly)} edited baseViewOnly=${String(desktopEdited.baseViewOnly)} stale=${String(desktopEdited.stale)}`,
    )
    failed = true
  } else {
    const cliBaseline = agreement.runCliDiffReport(
      cliConsumer.cliPath,
      comparisonA,
      comparisonB,
      'id',
    )
    const cliEdited = agreement.runCliDiffReport(
      cliConsumer.cliPath,
      stagedDiff.exportedEffectiveCopy,
      comparisonB,
      'id',
    )
    const baselineCheck = agreement.agreeSemantics(desktopBaseline, cliBaseline)
    // Edited leg: baseViewOnly is surface-only by construction (the desktop
    // marks side A as an edited view; the CLI diffs a plain exported file).
    // The CLI's own report proves the exported copy opens with the edited
    // effective view's shape (12 rows — the comparison fixture's width).
    const copyRowCount = (cliEdited.rowDiff ?? {}).rowCountA
    if (copyRowCount !== 12) {
      console.error(`edited effective copy shape via CLI: rows=${String(copyRowCount)}`)
      failed = true
    }
    // Edited leg exclusions, both by construction: `baseViewOnly` (the
    // desktop marks side A as an edited view; the CLI diffs a plain file)
    // and `columnDeltas` (profile aspects are base-only on the desktop —
    // the engine has no overlay profiling — while the CLI profiles the
    // exported copy, which contains the edit). Row-level agreement is the
    // point of this leg and stays fully compared.
    const editedCheck = agreement.agreeSemantics(desktopEdited, cliEdited, {
      excludeFields: ['baseViewOnly', 'columnDeltas'],
    })
    baselineAgreed = baselineCheck.agreed
    editedAgreed = editedCheck.agreed
    if (!baselineCheck.agreed) {
      console.error(
        `baseline CLI agreement mismatched fields: ${baselineCheck.mismatchedFields.join(', ')}`,
      )
      failed = true
    }
    if (!editedCheck.agreed) {
      console.error(
        `edited CLI agreement mismatched fields: ${editedCheck.mismatchedFields.join(', ')}`,
      )
      failed = true
    }
    // Fixture-class legs (queue done-when): identical, schema-only,
    // no-comparable, nested-presence — full common-field compare, no
    // exclusions (both sides diff base views).
    const classLegs = [
      ['identical', 'comparison-identical.csv', stagedDiff.identicalReport],
      ['schema-only', 'comparison-schema.csv', stagedDiff.schemaReport],
      ['no-comparable', 'comparison-onlykey.csv', stagedDiff.onlyKeyReport],
      ['nested', 'comparison-nested.parquet', stagedDiff.nestedReport],
    ]
    const classResults = []
    for (const [label, fixtureName, reportPath] of classLegs) {
      const desktop = JSON.parse(readFileSync(reportPath, 'utf8'))
      const cli = agreement.runCliDiffReport(
        cliConsumer.cliPath,
        comparisonA,
        path.join(workspaceDir, fixtureName),
        'id',
      )
      const check = agreement.agreeSemantics(desktop, cli)
      classResults.push(`${label}=${String(check.agreed)}`)
      if (!check.agreed) {
        console.error(
          `${label} CLI agreement mismatched fields: ${check.mismatchedFields.join(', ')}`,
        )
        failed = true
      }
      if (desktop.baseViewOnly !== true) {
        console.error(`${label} desktop report not base-view-only`)
        failed = true
      }
    }
    console.log(
      `CLI agreement: baseline=${String(baselineAgreed)} edited=${String(editedAgreed)} ${classResults.join(' ')} packages=${String(cliConsumer.packageCount)}`,
    )
  }
} catch (error) {
  console.error(`CLI agreement failed: ${error instanceof Error ? error.message : String(error)}`)
  failed = true
} finally {
  if (cliConsumer !== undefined) cleanupCliConsumer(cliConsumer.tempRoot)
}

const requiredDiffProof = [
  'unconfirmedRefused',
  'staleAfterEdit',
  'baseViewOnlyFalse',
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
if (!baselineAgreed || !editedAgreed) {
  console.error(
    `CLI agreement missing: baseline=${String(baselineAgreed)} edited=${String(editedAgreed)}`,
  )
  failed = true
}

rmSync(userDataDir, { recursive: true, force: true })
rmSync(extensionsDir, { recursive: true, force: true })
if (failed) process.exit(1)
console.log('e2e: PASS')
