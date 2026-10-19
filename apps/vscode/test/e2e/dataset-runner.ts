// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto'

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
import { gitContextFor } from '../../src/git-adapter'

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
  readonly validationProof?: {
    readonly baselineFailures: number
    readonly editedFailures: number
    readonly insertedFailures: number
    readonly deletedFailures: number
    readonly staleAfterEdit: boolean
    readonly logicalNavigation: boolean
  }
  /** ptv2-7: value-free git context rendered in the command-opened panel. */
  readonly gitContext?: {
    readonly state: string
    readonly hasBranch: boolean
  }
  /** ptv2-7: reduced compare-command proof (staged + refusal + baseline). */
  /** ptv2-8: value-free acceptance-chain proof (scenario 11 on desktop). */
  readonly acceptanceProof?: {
    readonly validatedCounts: readonly [number, number, number, number]
    readonly staleAfterEdit: boolean
    readonly unconfirmedRefused: boolean
    readonly diffCounts: readonly [number, number, number]
    readonly baseViewOnlyFalse: boolean
    readonly navigation: boolean
    readonly reportDelivered: boolean
    readonly copyDelivered: boolean
  }
  readonly diffCommandProof?: {
    readonly staged: boolean
    readonly unconfirmedRefused: boolean
    readonly baselineCounts: readonly [number, number, number]
  }
  readonly editProof?: {
    readonly cellIdentity: boolean
    readonly keyboardCancel: boolean
    readonly undoRedo: boolean
    readonly insertDelete: boolean
    readonly branchTruncation: boolean
    readonly queryStatePreserved: boolean
    readonly sessionWarningVisible: boolean
    readonly fullViewCastRefusal: boolean
  }
  /** ptv2-6: staged-diff proof from the comparison-fixture open (12 rows). */
  readonly diffProof?: {
    readonly unconfirmedRefused: boolean
    readonly staleAfterEdit: boolean
    readonly baseViewOnlyFalse: boolean
    readonly navigation: boolean
    readonly baselineCounts?: readonly [number, number, number]
    readonly editedChangedCount?: number
    readonly identicalCase?: boolean
    readonly schemaOnlyCase?: boolean
    readonly noComparableCase?: boolean
    readonly nestedCase?: boolean
  }
}

function safeProofFailure(message: string | undefined): string {
  const prefix = 'whole-view cast refusal invariant failed: '
  if (message?.startsWith(prefix)) return 'whole-view cast refusal invariant failed'
  if (message?.includes('test proof has no editable scalar column'))
    return 'no editable scalar codec'
  if (message?.includes('test proof column is unavailable')) return 'editable column missing'
  if (message?.includes('whole-view cast refusal')) return 'cast-refusal proof failed'
  if (message?.includes('Set NULL keyboard proof')) return 'Set NULL keyboard proof failed'
  if (message?.includes('test proof timed out')) return 'proof timed out'
  const stage =
    /^test-only open failure stage=(engine-start|engine-open|effective-view-load|first-row-render|edit-proof|proof-sort-filter|proof-editor-cancel|proof-identity-check|proof-cell-commit|proof-cell-await-row|proof-cell-await-editor-cell|proof-cell-editor-open|proof-cell-dispatch|proof-cell-await-commit|proof-cell-view-check|proof-undo-redo|proof-branch-and-null|proof-insert-delete|set-null-row-wait|set-null-editor-open|set-null-dispatch|set-null-await-commit|wide-clear-filters|wide-read-hidden-row|wide-filter-hidden-row|wide-candidate-preflight|wide-check-status|wide-check-history|wide-check-error|wide-check-count|wide-clear-filter-after|edit-proof-follow-up|set-null-keyboard|validation-contract-select|validation-baseline|validation-navigation|validation-edit|validation-insert|validation-delete-operation|validation-delete-run|validation-delete-assert|validation-delete-rowcount|validation-delete-failcount|validation-delete-check|acceptance-reset|acceptance-contract|acceptance-validate-baseline|acceptance-edit|acceptance-validate-edited|acceptance-undo|acceptance-redo|acceptance-stage|acceptance-refusal|acceptance-diff|acceptance-navigation|acceptance-report|acceptance-copy|diff-reset-overlay|diff-restage-primary|diff-case-identical|diff-case-schema|diff-case-onlykey|diff-case-nested|diff-unconfirmed-refusal|diff-comparison-select|diff-unconfirmed-keys|diff-baseline|diff-navigation|diff-export-baseline|diff-edit-stale|diff-edited|diff-export-edited|diff-export-copy)(?: category=(set-null-assertion|proof-timeout|proof-revision-timeout|candidate-cast-rejected|operation-rejected|operation-error|unknown|set-null-row-not-visible|set-null-cell-not-rendered|set-null-button-not-opened|set-null-operation-not-recorded|set-null-undo-did-not-restore-cursor))?$/.exec(
      message ?? '',
    )
  if (stage !== null) return `webview stage=${stage[1]}`
  return 'details withheld'
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
  const sourceDigestBefore = createHash('sha256')
    .update(await vscode.workspace.fs.readFile(fixtureUri))
    .digest('hex')
  const opened = await executeOpen(fixtureUri)
  const sourceDigestAfter = createHash('sha256')
    .update(await vscode.workspace.fs.readFile(fixtureUri))
    .digest('hex')
  const sourceImmutable = sourceDigestBefore === sourceDigestAfter
  assert(sourceImmutable, 'source fixture changed during session-only editing')
  assert(opened.outcome === 'opened', `command open did not open: ${JSON.stringify(opened)}`)
  assert(opened.rows === 5, `expected 5 rows, got ${String(opened.rows)}`)
  assert(
    opened.validationProof?.baselineFailures === 1,
    `validation baseline count mismatch: ${JSON.stringify(opened.validationProof)}`,
  )
  assert(opened.validationProof.editedFailures === 0, 'effective edited row was not validated')
  assert(opened.validationProof.insertedFailures === 2, 'effective inserted row was not validated')
  assert(
    opened.validationProof.deletedFailures === 0,
    'effective deleted row was not removed from validation',
  )
  assert(
    opened.validationProof.staleAfterEdit === true,
    'validation report did not become stale after edit',
  )
  assert(
    opened.validationProof.logicalNavigation === true,
    'validation sample did not navigate by logical row key',
  )
  scenarios['effectiveValidation'] = opened.validationProof
  assert(opened.columns === 4, `expected 4 columns, got ${String(opened.columns)}`)
  assert(opened.format === 'parquet', `expected parquet format, got ${String(opened.format)}`)
  assert((opened.byteLength ?? 0) > 0, 'byteLength must be positive')
  // ptv1-4: the grid rendered rows + the webview's DOM a11y audit held.
  assert(opened.gridRendered === true, `grid did not render: ${JSON.stringify(opened)}`)
  assert(opened.gridAuditOk === true, `grid a11y audit failed: ${JSON.stringify(opened)}`)
  assert(
    opened.editProof?.cellIdentity === true,
    'real DOM edit did not preserve logical row identity',
  )
  assert(opened.editProof.keyboardCancel === true, 'Escape did not cancel the cell edit')
  assert(opened.editProof.undoRedo === true, 'real DOM undo/redo assertions failed')
  assert(opened.editProof.insertDelete === true, 'real DOM insert/delete assertions failed')
  assert(opened.editProof.branchTruncation === true, 'real DOM branch truncation assertion failed')
  assert(
    opened.editProof.queryStatePreserved === true,
    'editing did not preserve sort/filter state',
  )
  assert(opened.editProof.sessionWarningVisible === true, 'session-only warning is not visible')
  assert(
    typeof opened.firstRowVisibleMs === 'number' && opened.firstRowVisibleMs >= 0,
    `firstRowVisibleMs missing: ${JSON.stringify(opened)}`,
  )
  scenarios['commandOpen'] = { ...opened, sourceImmutable }
  console.log(
    `[e2e] 1/5 OK rows=${String(opened.rows)} columns=${String(opened.columns)} validation=${String(opened.validationProof?.baselineFailures)}/${String(opened.validationProof?.editedFailures)}/${String(opened.validationProof?.insertedFailures)}/${String(opened.validationProof?.deletedFailures)} gridAuditOk=${String(opened.gridAuditOk)} firstRowVisibleMs=${String(opened.firstRowVisibleMs)}`,
  )

  // The test-only host provider is enabled only by the existing e2e gate.
  // Opening the result through the real production webview/engine verifies
  // the closed host file's format, schema and count rather than scratch alone.
  const exportedUri = vscode.Uri.file(`${workspace}/assay-export-proof-1.parquet`)
  const exportedBytes = await vscode.workspace.fs.readFile(exportedUri)
  assert(exportedBytes.byteLength > 0, 'completed export file was not created')
  const reopenedExport = await executeOpen(exportedUri)
  assert(
    reopenedExport.outcome === 'opened',
    'delivered export did not reopen through the real engine',
  )
  assert(reopenedExport.rows === opened.rows, 'export row count differs from the accepted view')
  assert(
    reopenedExport.columns === opened.columns,
    'export schema width differs from the accepted view',
  )
  scenarios['safeExport'] = {
    created: true,
    exportedEffectiveCopy: exportedUri.fsPath,
    reopened: true,
    rows: reopenedExport.rows,
    columns: reopenedExport.columns,
    bytes: exportedBytes.byteLength,
  }
  console.log(
    `[e2e] safe export OK reopened rows=${String(reopenedExport.rows)} columns=${String(reopenedExport.columns)} bytes=${String(exportedBytes.byteLength)}`,
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

  // Wide synthetic shape: the rejected cast is on the final logical row,
  // outside the sampled preflight window, and hidden by an active filter.
  console.log('[e2e] full-view cast refusal (synthetic 48-row CSV)…')
  const wideEditUri = vscode.Uri.file(`${workspace}/wide-edit.csv`)
  const wideLines = ['key,flag']
  for (let index = 1; index <= 48; index++) {
    wideLines.push(`${String(index)},${index === 48 ? 'hidden' : 'shown'}`)
  }
  await vscode.workspace.fs.writeFile(
    wideEditUri,
    new TextEncoder().encode(`${wideLines.join('\n')}\n`),
  )
  const wideEdit = await executeOpen(wideEditUri)
  assert(
    wideEdit.outcome === 'opened',
    `wide cast proof dataset failed (kind=${String(wideEdit.kind ?? 'unknown')}; ${safeProofFailure(wideEdit.message)})`,
  )
  assert(wideEdit.editProof?.fullViewCastRefusal === true, 'full-view cast refusal was not proven')
  scenarios['fullViewCastRefusal'] = { passed: true }
  console.log(
    '[e2e] full-view cast refusal OK (outside sample, filtered, previous state preserved)',
  )

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

  // 6. ptv2-6 staged diff: open the comparison A fixture; the webview
  //    harness drives stage → disclosure → confirm → diff → navigate →
  //    export → edit → stale → re-diff → export. The desktop's reports and
  //    effective copy land at fixed workspace paths; the node runner later
  //    checks them against the INSTALLED CLI on common semantic fields.
  console.log('[e2e] 6/6 staged diff (comparison-a.csv)…')
  const diffUri = vscode.Uri.file(`${workspace}/comparison-a.csv`)
  const diffOpened = await executeOpen(diffUri)
  assert(
    diffOpened.outcome === 'opened',
    `comparison fixture open failed: ${String(diffOpened.message)}`,
  )
  assert(diffOpened.rows === 12, `staged diff rows: ${String(diffOpened.rows)}`)
  assert(diffOpened.columns === 2, `staged diff columns: ${String(diffOpened.columns)}`)
  assert(
    diffOpened.diffProof?.unconfirmedRefused === true,
    'unconfirmed diff execution was not refused',
  )
  assert(
    diffOpened.diffProof.staleAfterEdit === true,
    'diff report did not become stale after edit',
  )
  assert(diffOpened.diffProof.baseViewOnlyFalse === true, 'edited diff kept baseViewOnly=true')
  assert(diffOpened.diffProof.navigation === true, 'diff sample navigation failed')
  assert(
    Array.isArray(diffOpened.diffProof.baselineCounts) &&
      diffOpened.diffProof.baselineCounts.join('/') === '1/1/1',
    `baseline counts: ${JSON.stringify(diffOpened.diffProof.baselineCounts)}`,
  )
  assert(
    diffOpened.diffProof.editedChangedCount === 2,
    `edited changed count: ${String(diffOpened.diffProof.editedChangedCount)}`,
  )
  assert(diffOpened.diffProof.identicalCase === true, 'identical-case agreement class failed')
  assert(diffOpened.diffProof.schemaOnlyCase === true, 'schema-only agreement class failed')
  assert(diffOpened.diffProof.noComparableCase === true, 'no-comparable agreement class failed')
  assert(diffOpened.diffProof.nestedCase === true, 'nested agreement class failed')
  const baselineReport = `${workspace}/assay-diff-report-1.json`
  const identicalReport = `${workspace}/assay-diff-report-2.json`
  const schemaReport = `${workspace}/assay-diff-report-3.json`
  const onlyKeyReport = `${workspace}/assay-diff-report-4.json`
  const nestedReport = `${workspace}/assay-diff-report-5.json`
  const editedReport = `${workspace}/assay-diff-report-6.json`
  for (const reportPath of [
    baselineReport,
    editedReport,
    identicalReport,
    schemaReport,
    onlyKeyReport,
    nestedReport,
  ]) {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(reportPath))
    assert(bytes.byteLength > 0, `diff report export missing: ${reportPath}`)
  }
  // The exercise's effective-copy export is the LAST assay-export-proof-*
  // artifact. It is not reopened through another engine session here (each
  // open keeps a webview + engine worker alive for the whole run; a sixth
  // session exhausted host resources in CI). The installed-CLI agreement
  // leg opens the copy for real and asserts its shape from the CLI report.
  const exportEntries = (await vscode.workspace.fs.readDirectory(vscode.Uri.file(workspace)))
    .map(([name]) => /^assay-export-proof-(\d+)\.parquet$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
  assert(exportEntries.length > 0, 'no assay-export-proof artifacts found')
  const exportedEffectiveCopy = `${workspace}/${exportEntries[exportEntries.length - 1]![0]}`
  results['diffProof'] = diffOpened.diffProof
  scenarios['stagedDiff'] = {
    baselineReport,
    editedReport,
    identicalReport,
    schemaReport,
    onlyKeyReport,
    nestedReport,
    exportedEffectiveCopy,
  }
  console.log(
    `[e2e] 6/6 OK staged diff baseline=1/1/1 editedChanged=2 navigation=${String(diffOpened.diffProof.navigation)}`,
  )

  // 7. ptv2-7 Git context: HOST-SIDE adapter asserts (no extra engine
  //    sessions — each open keeps a webview + worker alive for the whole
  //    run, and the resource ceiling is real). The runner script built a
  //    synthetic repository around the fixtures; every assertion is on the
  //    projected, value-free state words.
  console.log('[e2e] 7/7 git context (synthetic repository)…')
  const gitFixtures = {
    clean: `${workspace}/comparison-a.csv`,
    untracked: `${workspace}/comparison-b.csv`,
    dirty: `${workspace}/comparison-schema.csv`,
    outside: process.env['ASSAY_E2E_OUTSIDE_REPO'] ?? '',
  }
  assert(gitFixtures.outside.length > 0, 'ASSAY_E2E_OUTSIDE_REPO is not set')
  const digestOf = async (path: string): Promise<string> =>
    createHash('sha256')
      .update(await vscode.workspace.fs.readFile(vscode.Uri.file(path)))
      .digest('hex')
  const gitDigestsBefore = await Promise.all(Object.values(gitFixtures).map(digestOf))
  // The git extension discovers the workspace repository asynchronously
  // after the folder opens; poll the adapter (bounded) until it reports a
  // repository for the tracked fixture.
  const deadline = Date.now() + 15_000
  let discovered = false
  for (;;) {
    const probe = gitContextFor(vscode.Uri.file(gitFixtures.clean))
    if (probe.state !== 'no-git' && probe.state !== 'no-repository') {
      discovered = true
      break
    }
    if (Date.now() > deadline) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  assert(discovered, 'git extension did not discover the synthetic repository')
  const cleanContext = gitContextFor(vscode.Uri.file(gitFixtures.clean))
  const untrackedContext = gitContextFor(vscode.Uri.file(gitFixtures.untracked))
  const dirtyContext = gitContextFor(vscode.Uri.file(gitFixtures.dirty))
  const outsideContext = gitContextFor(vscode.Uri.file(gitFixtures.outside))
  const noRawPath = (context: ReturnType<typeof gitContextFor>): boolean =>
    Object.values(context)
      .filter((value): value is string => typeof value === 'string')
      .every((value) => !value.includes('/'))
  assert(cleanContext.state === 'clean', `clean fixture state: ${cleanContext.state}`)
  assert(
    untrackedContext.state === 'untracked',
    `untracked fixture state: ${untrackedContext.state}`,
  )
  assert(dirtyContext.state === 'dirty', `dirty fixture state: ${dirtyContext.state}`)
  assert(outsideContext.state === 'no-repository', `outside fixture state: ${outsideContext.state}`)
  assert(
    [cleanContext, untrackedContext, dirtyContext, outsideContext].every(noRawPath),
    'git context leaked a path-like string',
  )
  const gitDigestsAfter = await Promise.all(Object.values(gitFixtures).map(digestOf))
  const sourcesUnchanged = gitDigestsBefore.every(
    (digest, index) => digest === gitDigestsAfter[index],
  )
  assert(sourcesUnchanged, 'git context probing mutated a fixture')
  results['gitContextProof'] = {
    clean: cleanContext.state,
    untracked: untrackedContext.state,
    dirty: dirtyContext.state,
    outside: outsideContext.state,
    branchKind: typeof cleanContext.branch === 'string' ? 'string' : 'absent',
    noRawPath: true,
    sourcesUnchanged,
  }
  scenarios['gitContext'] = { passed: true }
  console.log('[e2e] 7/7 OK git context (clean/untracked/dirty/no-repository, no paths)')

  // 8. ptv2-7 dataset diff command: two explicit URIs reach the SAME
  //    confirmed-key controller — the panel opens, the comparison stages,
  //    and the in-open harness re-proves that nothing ran before explicit
  //    key confirmation. The command-opened panel also proves the webview
  //    renders the git context (tracked-clean fixture).
  console.log('[e2e] 8/8 dataset diff command (two URIs)…')
  const commandReport: unknown = await vscode.commands.executeCommand(
    'assay.dataset.diff',
    vscode.Uri.file(`${workspace}/comparison-a.csv`),
    vscode.Uri.file(`${workspace}/comparison-b.csv`),
  )
  const diffCommandOpened = commandReport as DatasetReport | undefined
  assert(
    diffCommandOpened !== undefined && diffCommandOpened.outcome === 'opened',
    `assay.dataset.diff did not open the dataset: ${JSON.stringify(commandReport)}`,
  )
  assert(
    diffCommandOpened.diffCommandProof?.staged === true,
    'compare command did not stage the comparison',
  )
  assert(
    diffCommandOpened.diffCommandProof.unconfirmedRefused === true,
    'compare command bypassed the key-confirmation gate',
  )
  assert(
    (diffCommandOpened.diffCommandProof.baselineCounts ?? []).join('/') === '1/1/1',
    `compare command baseline counts: ${JSON.stringify(
      diffCommandOpened.diffCommandProof.baselineCounts,
    )}`,
  )
  assert(
    diffCommandOpened.gitContext?.state === 'clean',
    `compare command panel git context: ${JSON.stringify(diffCommandOpened.gitContext)}`,
  )
  results['diffCommandProof'] = {
    opened: true,
    staged: diffCommandOpened.diffCommandProof.staged,
    unconfirmedRefused: diffCommandOpened.diffCommandProof.unconfirmedRefused,
    gitRendered: diffCommandOpened.gitContext.state,
  }
  scenarios['datasetDiffCommand'] = { passed: true }
  console.log('[e2e] 8/8 OK compare command (staged, unconfirmed refused, git rendered)')

  // 9. ptv2-8 acceptance (MVP scenario 11 on the desktop): ONE dataset
  //    through the whole chained workflow — validate -> edit -> undo ->
  //    redo -> confirmed-key diff -> report + copy delivery. The runner
  //    script later checks the delivered report and copy against the
  //    INSTALLED CLI (edited-view leg).
  console.log('[e2e] 9/9 acceptance chain (acceptance.csv)…')
  const acceptanceUri = vscode.Uri.file(`${workspace}/acceptance.csv`)
  const acceptanceDigestBefore = createHash('sha256')
    .update(await vscode.workspace.fs.readFile(acceptanceUri))
    .digest('hex')
  const acceptanceOpened = await executeOpen(acceptanceUri)
  assert(
    acceptanceOpened.outcome === 'opened',
    `acceptance open failed: ${safeProofFailure(acceptanceOpened.message)}`,
  )
  const acceptance = acceptanceOpened.acceptanceProof
  assert(acceptance !== undefined, 'acceptance chain produced no proof')
  assert(
    (acceptance.validatedCounts ?? []).join('/') === '1/0/1/0',
    `acceptance validation counts: ${JSON.stringify(acceptance.validatedCounts)}`,
  )
  assert(acceptance.staleAfterEdit === true, 'acceptance stale marking missing')
  assert(acceptance.unconfirmedRefused === true, 'acceptance diff bypassed confirmation')
  assert(
    (acceptance as unknown as { refusalKind?: string }).refusalKind === 'invalid-keys',
    'acceptance refusal not independently evidenced',
  )
  assert(
    (acceptance.diffCounts ?? []).join('/') === '1/1/1',
    `acceptance diff counts: ${JSON.stringify(acceptance.diffCounts)}`,
  )
  assert(acceptance.baseViewOnlyFalse === true, 'acceptance diff not effective-view')
  assert(acceptance.navigation === true, 'acceptance navigation failed')
  assert(acceptance.reportDelivered === true, 'acceptance report not delivered')
  assert(acceptance.copyDelivered === true, 'acceptance copy not delivered')
  const acceptanceDigestAfter = createHash('sha256')
    .update(await vscode.workspace.fs.readFile(acceptanceUri))
    .digest('hex')
  assert(
    acceptanceDigestBefore === acceptanceDigestAfter,
    'acceptance source fixture mutated during the chained workflow',
  )
  // The acceptance report/copy are the LAST artifacts of the run.
  const reportEntries = (await vscode.workspace.fs.readDirectory(vscode.Uri.file(workspace)))
    .map(([name]) => /^assay-diff-report-(\d+)\.json$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
  const exportEntries2 = (await vscode.workspace.fs.readDirectory(vscode.Uri.file(workspace)))
    .map(([name]) => /^assay-export-proof-(\d+)\.parquet$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
  assert(reportEntries.length > 0 && exportEntries2.length > 0, 'acceptance artifacts missing')
  const acceptanceReport = `${workspace}/${reportEntries[reportEntries.length - 1]![0]}`
  const acceptanceCopy = `${workspace}/${exportEntries2[exportEntries2.length - 1]![0]}`
  results['acceptanceProof'] = acceptance
  scenarios['acceptance'] = { acceptanceReport, acceptanceCopy }
  console.log(
    '[e2e] 9/9 OK acceptance chain (validate 1/0/1/0, diff 1/1/1, report + copy delivered)',
  )

  results['finishedAt'] = new Date().toISOString()
  await vscode.workspace.fs.writeFile(
    vscode.Uri.file(resultsPath),
    new TextEncoder().encode(JSON.stringify(results, null, 2) + '\n'),
  )
  console.log('[e2e] ALL SCENARIOS PASSED')
}
