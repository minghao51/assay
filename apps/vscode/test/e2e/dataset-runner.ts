// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ptv1-3 e2e, extended by ptv1-4 (the rows' done-when verification): a REAL
 * VS Code (`@vscode/test-electron`, launched by `scripts/run-e2e.mjs`) opens
 * workspace files end-to-end through the production surface — activation, the
 * `assay.dataset.open` command + the `assay.datasetViewer` custom editor, the
 * `workspace.fs` → webview bytes bridge, the vendored engine boot (ptv1-1/2
 * seam), the typed error paths surfaced IN the webview (each error is
 * only reported once the webview acknowledged having rendered it), and —
 * since ptv1-4 — the headless-grid dataset surface: the webview reports that
 * the grid mounted, the first row rendered, and its own DOM-structure a11y
 * audit held (the host cannot reach into a webview, so the page audits
 * itself; see `webview/grid-audit.ts`).
 *
 * Framework-free like the spike runner: ordered scenarios, an `assert` that
 * throws with the trail, a value-free results JSON, and a non-zero exit on
 * any failure. Fixtures are the committed synthetic set
 * (`test/fixtures/`, staged into a temp dir by the runner script).
 *
 * Privacy: every assertion and the results file carry counts and error kinds
 * only — never file contents or names beyond the synthetic fixture names.
 */
import * as vscode from 'vscode'

interface DatasetReport {
  readonly outcome: 'opened' | 'error'
  readonly format?: string
  readonly byteLength?: number
  readonly rows?: number
  readonly columns?: number
  readonly kind?: string
  readonly message?: string
  readonly shownInWebview?: boolean
  /** ptv1-4: the grid mounted and the first row rendered (webview-reported). */
  readonly gridRendered?: boolean
  /** ptv1-4: the webview's own DOM-structure a11y audit held. */
  readonly gridAuditOk?: boolean
  /** ptv1-4: open (bytes in hand) → first grid row visible, ms. */
  readonly firstRowVisibleMs?: number
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`e2e assertion failed: ${message}`)
  }
}

function isDatasetReport(value: unknown): value is DatasetReport {
  return typeof value === 'object' && value !== null && 'outcome' in value
}

async function executeOpen(uri: vscode.Uri): Promise<DatasetReport> {
  const report: unknown = await vscode.commands.executeCommand('assay.dataset.open', uri)
  assert(isDatasetReport(report), `assay.dataset.open returned no report for ${uri.path}`)
  return report
}

/** Poll `assay.dataset.lastReport` until the custom editor's bridge resolves. */
async function waitForLastReport(timeoutMs: number): Promise<DatasetReport | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const report: unknown = await vscode.commands.executeCommand('assay.dataset.lastReport')
    if (isDatasetReport(report)) {
      return report
    }
    if (Date.now() > deadline) {
      return undefined
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

export async function run(): Promise<void> {
  const workspace = process.env['ASSAY_E2E_WORKSPACE']
  const resultsPath = process.env['ASSAY_E2E_RESULTS']
  assert(workspace !== undefined && workspace.length > 0, 'ASSAY_E2E_WORKSPACE is not set')
  assert(resultsPath !== undefined && resultsPath.length > 0, 'ASSAY_E2E_RESULTS is not set')

  const results: Record<string, unknown> = {
    target: 'desktop-extension-host-e2e',
    vscodeVersion: vscode.version,
    scenarios: {},
  }
  const scenarios = results['scenarios'] as Record<string, unknown>

  // 1. Command happy path: activation + workspace.fs read + bytes bridge +
  //    vendored engine boot + real open — counts asserted, values never.
  console.log('[e2e] 1/5 command open (synthetic-smoke.parquet)…')
  const fixtureUri = vscode.Uri.file(`${workspace}/synthetic-smoke.parquet`)
  const opened = await executeOpen(fixtureUri)
  assert(opened.outcome === 'opened', `command open did not open: ${JSON.stringify(opened)}`)
  assert(opened.rows === 5, `expected 5 rows, got ${String(opened.rows)}`)
  assert(opened.columns === 4, `expected 4 columns, got ${String(opened.columns)}`)
  assert(opened.format === 'parquet', `expected parquet format, got ${String(opened.format)}`)
  assert((opened.byteLength ?? 0) > 0, 'byteLength must be positive')
  // ptv1-4: the grid rendered rows + the webview's DOM a11y audit held.
  assert(opened.gridRendered === true, `grid did not render: ${JSON.stringify(opened)}`)
  assert(opened.gridAuditOk === true, `grid a11y audit failed: ${JSON.stringify(opened)}`)
  assert(
    typeof opened.firstRowVisibleMs === 'number' && opened.firstRowVisibleMs >= 0,
    `firstRowVisibleMs missing: ${JSON.stringify(opened)}`,
  )
  scenarios['commandOpen'] = opened
  console.log(
    `[e2e] 1/5 OK rows=${String(opened.rows)} columns=${String(opened.columns)} gridAuditOk=${String(opened.gridAuditOk)} firstRowVisibleMs=${String(opened.firstRowVisibleMs)}`,
  )

  // 2. Custom editor surface: the same file through the contributed read-only
  //    editor (vscode.openWith), tab visible, bridge resolves via lastReport.
  console.log('[e2e] 2/5 custom editor (assay.datasetViewer)…')
  await vscode.commands.executeCommand('vscode.openWith', fixtureUri, 'assay.datasetViewer')
  const editorReport = await waitForLastReport(240_000)
  assert(
    editorReport !== undefined && editorReport.outcome === 'opened',
    `custom editor did not open: ${JSON.stringify(editorReport)}`,
  )
  assert(editorReport.rows === 5, `custom editor rows: ${String(editorReport.rows)}`)
  // ptv1-4: the persistent surface — grid rendered + audit held here too.
  assert(
    editorReport.gridRendered === true && editorReport.gridAuditOk === true,
    `custom editor grid did not render cleanly: ${JSON.stringify(editorReport)}`,
  )
  const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs)
  const viewerTab = tabs.find(
    (tab) =>
      tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'assay.datasetViewer',
  )
  assert(viewerTab !== undefined, 'no assay.datasetViewer tab found in tab groups')
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
  scenarios['customEditor'] = {
    outcome: editorReport.outcome,
    rows: editorReport.rows,
    gridRendered: editorReport.gridRendered,
    gridAuditOk: editorReport.gridAuditOk,
  }
  console.log('[e2e] 2/5 OK (tab found, bridge opened, grid rendered)')

  // 3. Typed error: missing file — surfaces IN the webview (acknowledged).
  console.log('[e2e] 3/5 missing file…')
  const missing = await executeOpen(vscode.Uri.file(`${workspace}/does-not-exist.parquet`))
  assert(
    missing.outcome === 'error',
    `missing file unexpectedly opened: ${JSON.stringify(missing)}`,
  )
  assert(missing.kind === 'missing-file', `expected missing-file, got ${String(missing.kind)}`)
  assert(missing.shownInWebview === true, 'missing-file error was not acknowledged by the webview')
  scenarios['missingFile'] = { kind: missing.kind, shownInWebview: missing.shownInWebview }
  console.log('[e2e] 3/5 OK (missing-file surfaced in webview)')

  // 4. Typed error: unsupported format — validated before any I/O (the file
  //    does not exist, proving format checking comes first).
  console.log('[e2e] 4/5 unsupported format…')
  const unsupported = await executeOpen(vscode.Uri.file(`${workspace}/notes.txt`))
  assert(
    unsupported.outcome === 'error' && unsupported.kind === 'unsupported-format',
    `expected unsupported-format, got ${JSON.stringify(unsupported)}`,
  )
  assert(
    unsupported.shownInWebview === true,
    'unsupported-format error was not acknowledged by the webview',
  )
  scenarios['unsupportedFormat'] = {
    kind: unsupported.kind,
    shownInWebview: unsupported.shownInWebview,
  }
  console.log('[e2e] 4/5 OK (unsupported-format surfaced in webview)')

  // 5. Typed error: empty file (committed 0-byte synthetic CSV).
  console.log('[e2e] 5/5 empty file…')
  const empty = await executeOpen(vscode.Uri.file(`${workspace}/empty.csv`))
  assert(
    empty.outcome === 'error' && empty.kind === 'empty-file',
    `expected empty-file, got ${JSON.stringify(empty)}`,
  )
  assert(empty.shownInWebview === true, 'empty-file error was not acknowledged by the webview')
  scenarios['emptyFile'] = { kind: empty.kind, shownInWebview: empty.shownInWebview }
  console.log('[e2e] 5/5 OK (empty-file surfaced in webview)')

  results['finishedAt'] = new Date().toISOString()
  await vscode.workspace.fs.writeFile(
    vscode.Uri.file(resultsPath),
    new TextEncoder().encode(JSON.stringify(results, null, 2) + '\n'),
  )
  console.log('[e2e] ALL SCENARIOS PASSED')
}
