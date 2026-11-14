// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Spike webview main thread (ptv-1 harness; engine path re-wired by ptv1-1).
 * Collects the R4 evidence that must come from the webview origin itself
 * (cross-origin isolation, COOP/COEP resource headers, File System Access API
 * availability, OPFS reachability, main-thread heap) and drives the engine
 * through the REAL `@assay/engine-duckdb` adapter. Results are posted back to
 * the extension host, which writes them to the run's evidence JSON.
 *
 * ptv1-1 (the bundler-agnostic worker seam): the R4 spike's own engine boot
 * code is gone. The engine boot, the fixture open, the row count, the first
 * window, and the Parquet-extension probe all run through the real
 * `DuckDbEngineClient` and the real shared worker core
 * (`@assay/engine-duckdb/worker-core`, started injected by
 * `webview/worker.ts`). The host-side seam is exactly what production will use:
 * the extension worker bundle is fetched and re-exposed as a same-origin
 * `blob:` URL, the DuckDB glue + WASM likewise, and the blob URLs are posted
 * to the worker as one `engine/assets` control message BEFORE the client's
 * first `engine/init` (the factory below owns that ordering).
 *
 * ptv1-2 (vendored engine assets, local-first), R1-B (`eh` only): the vendored
 * `eh` glue worker is now bootstrapped from the COMMITTED vendored binary
 * (assets/duckdb/, checksum pinned by scripts/build.mjs) with a shim APPENDED
 * to the unmodified glue text — the pinned bytes are not altered. The shim
 * (a) after DuckDB instantiation takes the vendored extension bytes in hand
 * (fetched from the extension package over the local webview resource path)
 * and (b) answers the Q5b CDN autoload URL
 * (`extensions.duckdb.org/…/wasm_eh/parquet.duckdb_extension.wasm`) LOCALLY
 * from those bytes, refusing every other request to that host (a local 403
 * carrying `assay-netblock-refusal`) — so datasets open with ZERO network
 * fetches. (Registering the binary into the engine FS
 * + INSTALL/LOAD was tried first;
 * the extension loader's existence check does not see registered buffers in
 * 1.32.0 — see assets/duckdb/VENDORED_ASSETS.md.) Drill mode
 * (`ASSAY_SPIKE_DRILL=missing-extension`) ships no vendored bytes: the open
 * must then FAIL on the refused CDN autoload, reproducing the Q5b failure
 * mode under the block and proving the negative (a non-vendored asset WOULD
 * fetch — and be caught). DuckDB reports that failure itself
 * (`Extension https://extensions.duckdb.org/…/wasm_eh/parquet.duckdb_extension.wasm
 * is not available`), which is the drill's recorded evidence.
 *
 * Worker-loading finding baked in here: `new Worker(webview.asWebviewUri(...))`
 * throws a cross-origin error in a desktop webview (the resource is served from
 * `https://file+.vscode-resource.vscode-cdn.net` while the document origin is
 * `vscode-webview://…`). The harness records that failure and then uses the
 * documented workaround — fetch each script/WASM as a Blob and construct the
 * worker from a same-origin `blob:` URL. Both the failure and the workaround
 * are measured, not assumed.
 *
 * Everything here is spike-only and value-free: the only dataset-derived
 * values in the report are one fixture row's id/bucket/label shape check —
 * enough to prove a real window was returned, not a data dump.
 */
import { DuckDbEngineClient } from '@assay/engine-duckdb'
import type { EngineAssetsMessage } from '@assay/engine-duckdb/worker-core'
import { GridViewportModel } from '@assay/grid'
import { emptyHistory, overlayEdit, stateAtCursor } from '@assay/domain'
import type { OverlayBase, RowId } from '@assay/domain'
import { EditController } from '../src/pure/edit-controller'
import { overlaySnapshot } from '../src/pure/overlay-snapshot'
import { WebviewDataGrid } from './data-grid'
import { bootAdapter, buildShimmedGlueBlobUrl, createAdapterClient, toBlobUrl } from './engine-boot'
import type { WorkerDiagnostic } from './engine-boot'
import { EngineGridProvider } from './grid-provider'
import { auditGridDom, probeKeyboardNavigation } from './grid-audit'
import type { GridDomAudit, KeyboardProbeResult } from './grid-audit'

interface BundleUrls {
  readonly workerUrl: string
  readonly wasmUrl: string
}

interface SpikeConfig {
  readonly target: string
  readonly vscodeVersion: string
  readonly mainScriptUrl: string
  readonly workerScriptUrl: string
  readonly probeUrl: string
  /** R1-B: the shipped `eh` pair (the desktop surface boots nothing else). */
  readonly bundle: BundleUrls
  /** ptv1-2: the vendored Parquet extension served from the extension package. */
  readonly vendoredExtension: {
    readonly fileName: string
    readonly url: string
    readonly duckdbVersion: string
    /** The CDN URL path the shim serves locally (DuckDB-version specific). */
    readonly autoloadPath: string
  }
  /** ptv1-2: the CDN host the harness network-blocks (Q5b, pinned fixed). */
  readonly blockedExtensionHost: string
  /** ptv1-2 drill: skip the local install so the CDN path is exercised (and refused). */
  readonly drill: boolean
}

declare global {
  interface Window {
    __ASSAY_SPIKE_CONFIG__: SpikeConfig
  }
}

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
}

const config = window.__ASSAY_SPIKE_CONFIG__
const vscodeApi = acquireVsCodeApi()

const results: Record<string, unknown> = {
  target: config.target,
  vscodeVersion: config.vscodeVersion,
  startedAt: new Date().toISOString(),
  userAgent: navigator.userAgent,
}
const heap: Record<string, Record<string, number>> = { preBoot: heapSample() }
results['heap'] = heap

/** Raw worker progress/error lines, kept so a wedged boot is diagnosable. */
const diagnostics: Array<WorkerDiagnostic> = []
results['workerDiagnostics'] = diagnostics

function setStatus(message: string): void {
  const el = document.getElementById('status')
  if (el !== null) {
    el.textContent = message
  }
}

function heapSample(): Record<string, number> {
  // Force a GC when the launch flags expose it, so the sample reflects live
  // memory rather than the just-revoked blob allocations.
  const gc = (globalThis as { gc?: () => void }).gc
  if (typeof gc === 'function') {
    gc()
  }
  const memory = (
    performance as {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number }
    }
  ).memory
  return memory === undefined
    ? {}
    : {
        usedBytes: memory.usedJSHeapSize,
        totalBytes: memory.totalJSHeapSize,
        limitBytes: memory.jsHeapSizeLimit,
      }
}

async function step<T>(name: string, attempt: () => Promise<T>): Promise<T | undefined> {
  try {
    setStatus(name)
    return await attempt()
  } catch (error) {
    const errors = (results['errors'] ??= {}) as Record<string, string>
    errors[name] = error instanceof Error ? error.message : String(error)
    return undefined
  }
}

/** Same-origin fetch of a webview resource, read for the host's COOP/COEP headers. */
async function probeResourceHeaders(url: string): Promise<unknown> {
  try {
    const response = await fetch(url, { cache: 'no-store' })
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get('content-type'),
      crossOriginOpenerPolicy: response.headers.get('cross-origin-opener-policy'),
      crossOriginEmbedderPolicy: response.headers.get('cross-origin-embedder-policy'),
      crossOriginResourcePolicy: response.headers.get('cross-origin-resource-policy'),
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * ptv1-2: verify the vendored-asset serve state and record the evidence.
 * The shim answers the CDN autoload URL locally with the vendored bytes, so
 * there is nothing to INSTALL: the extension state after the open is the
 * Q5b signature (loaded=true, installed=false) — but earned with ZERO
 * network, which the drill run proves (no vendored bytes → the blocked
 * autoload is answered with a local 403 and the open fails on DuckDB's own
 * "Extension … is not available" error naming the refused `wasm_eh` URL).
 */
async function verifyVendoredServe(
  client: DuckDbEngineClient,
  config: SpikeConfig,
): Promise<Record<string, unknown>> {
  if (config.drill) {
    return {
      drill: 'missing-extension (no vendored bytes; CDN blocked — Q5b reproduced on open)',
      blockedHost: config.blockedExtensionHost,
      extensionFile: config.vendoredExtension.fileName,
      autoloadPath: config.vendoredExtension.autoloadPath,
    }
  }
  // The glue shim's own state, read back through DuckDB's statically linked
  // read_csv: proves the vendored bytes were fetched (from the local blob)
  // before any query ran.
  let shimState = 'unreadable'
  try {
    const stateTable = await client.query(
      "SELECT status, detail FROM read_csv('/assay-shim-state.csv', header = true)",
    )
    shimState = `${String(stateTable.batch.getChildAt(0)?.get(0))}: ${String(stateTable.batch.getChildAt(1)?.get(0))}`
  } catch (error) {
    shimState = `unreadable (${error instanceof Error ? error.message : String(error)})`
  }
  const probe = await client.query(
    "SELECT extension_name, loaded, installed FROM duckdb_extensions() WHERE extension_name = 'parquet'",
  )
  return {
    drill: false,
    extensionFile: config.vendoredExtension.fileName,
    autoloadPath: config.vendoredExtension.autoloadPath,
    duckdbVersion: config.vendoredExtension.duckdbVersion,
    blockedHost: config.blockedExtensionHost,
    // Two independent network-block layers; the vendored run must pass under both.
    networkBlock:
      'CSP connect-src excludes the host + in-worker fetch/XHR interceptor serves the vendored bytes locally' +
      ' (any other request to the host is answered with a local 403 whose body carries assay-netblock-refusal)',
    shimState,
    installed: Boolean(probe.batch.getChildAt(2)?.get(0)),
    loaded: Boolean(probe.batch.getChildAt(1)?.get(0)),
  }
}

/** Wait for the extension host to post the fixture bytes. */
function waitForFixture(): Promise<{ name: string; bytes: ArrayBuffer }> {
  return new Promise((resolve) => {
    window.addEventListener('message', (event) => {
      const data = event.data as { kind?: string; name?: string; bytes?: ArrayBuffer }
      if (data?.kind === 'fixture' && data.name !== undefined && data.bytes !== undefined) {
        resolve({ name: data.name, bytes: data.bytes })
      }
    })
  })
}

/** The open envelope metrics plus what the ptv1-4 grid phase reuses. */
interface OpenedFixture {
  readonly metrics: Record<string, unknown>
  /** The live engine handle (the grid phase mounts the surface over it). */
  readonly handle: Awaited<ReturnType<DuckDbEngineClient['open']>>
  /** performance.now() at open start (the grid TTFR's zero). */
  readonly openedAt: number
}

/**
 * Register the fixture bytes through the real adapter and time
 * open → count → first row (the Q5 envelope, same methodology as the R4
 * spike: pickerToFirstRowMs is the sum of the three engine phases).
 */
async function openFixtureThroughAdapter(
  client: DuckDbEngineClient,
  fixture: { name: string; bytes: ArrayBuffer },
): Promise<OpenedFixture> {
  const fixtureFile = new File([fixture.bytes], fixture.name)
  const bytes = fixture.bytes.byteLength

  const openStarted = performance.now()
  const handle = await client.open({
    name: fixture.name,
    getFile: () => Promise.resolve(fixtureFile),
  })
  const openMs = performance.now() - openStarted

  const countStarted = performance.now()
  const rows = await client.rowCount(handle)
  const rowCountMs = performance.now() - countStarted

  // Record the runtime extension dependency (`read_parquet` autoloads the
  // Parquet extension from extensions.duckdb.org in DuckDB-WASM 1.32.0) —
  // through the real adapter's SQL surface, same evidence as the R4 spike.
  let parquetExtension: unknown = null
  try {
    const extTable = await client.query(
      "SELECT extension_name, loaded, installed FROM duckdb_extensions() WHERE extension_name = 'parquet'",
    )
    parquetExtension = {
      name: String(extTable.batch.getChildAt(0)?.get(0) ?? ''),
      loaded: Boolean(extTable.batch.getChildAt(1)?.get(0)),
      installed: Boolean(extTable.batch.getChildAt(2)?.get(0)),
    }
  } catch (error) {
    parquetExtension = { error: error instanceof Error ? error.message : String(error) }
  }

  const firstRowStarted = performance.now()
  const windowTable = await client.fetchRange(handle, {
    startRow: 0,
    endRow: 1000,
    columns: ['id', 'bucket', 'label'],
  })
  const ttfrMs = performance.now() - firstRowStarted
  const firstRow = {
    id: String(windowTable.batch.getChildAt(0)?.get(0) ?? ''),
    bucket: String(windowTable.batch.getChildAt(1)?.get(0) ?? ''),
    label: String(windowTable.batch.getChildAt(2)?.get(0) ?? ''),
  }

  return {
    metrics: {
      bytes,
      rows,
      openMs,
      rowCountMs,
      ttfrMs,
      ttfrRows: windowTable.batch.numRows,
      firstRow,
      pickerToFirstRowMs: openMs + rowCountMs + ttfrMs,
      parquetExtension,
    },
    handle,
    openedAt: openStarted,
  }
}

/**
 * Poll the public model API until the row at `index` is served ready (the
 * deterministic settle for sort/filter/scroll epochs — no fixed sleeps).
 */
async function waitForReadyRowAt(
  model: GridViewportModel,
  index: number,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    if (model.getRow(index).status === 'ready') return
    if (performance.now() > deadline) {
      const stats = model.stats
      throw new Error(
        `grid row ${String(index)} not ready within ${String(timeoutMs)}ms ` +
          `(slot=${String(model.getRow(index).status)} fatalError=${String(stats.fatalError)} ` +
          `failedSpans=${String(stats.failedSpans)} fetchCalls=${String(stats.fetchCalls)} ` +
          `rowsRequested=${String(stats.rowsRequested)} rowsReceived=${String(stats.rowsReceived)})`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** Value-free probe outcomes (counts and indices only). */
interface GridPhaseEvidence {
  /** open start → first ready row's cells in the DOM (R4 envelope, boot excluded). */
  readonly firstRowVisibleMs: number
  readonly loadMs: number
  readonly totalRows: number
  readonly columnCount: number
  readonly editingPathMounted: boolean
  readonly audit: GridDomAudit
  readonly keyboard: KeyboardProbeResult
  readonly virtualization: { readonly ok: boolean; readonly detail: string }
  readonly sort: { readonly ok: boolean; readonly detail: string }
  readonly filter: { readonly ok: boolean; readonly detail: string }
  readonly stats: {
    readonly fetchCalls: number
    readonly rowsRequested: number
    readonly rowsReceived: number
    readonly cachedRows: number
    readonly maxSpanRows: number
  }
}

/**
 * The ptv1-4 grid phase: mount the REAL dataset surface (the same
 * `EngineGridProvider` + `WebviewDataGrid` modules the production webview
 * uses) over the opened 1M-row handle, and collect the row's evidence —
 * the TTFR envelope (open → first row visible), the harness-testable a11y
 * audit + keyboard probe, the virtualization (scroll-sweep bounded-DOM)
 * proof, and the sort/filter-lite contract wiring. Everything value-free.
 */
async function runGridPhase(
  client: DuckDbEngineClient,
  handle: Awaited<ReturnType<DuckDbEngineClient['open']>>,
  openedAt: number,
): Promise<GridPhaseEvidence> {
  const schema = await client.schema(handle)
  const base: OverlayBase = {
    baseAnchor: handle.id,
    overlayAnchor: crypto.randomUUID(),
    columns: schema.map((column) => ({ name: column.name, type: column.type })),
    baseRowCount: await client.rowCount(handle),
  }
  const provider = new EngineGridProvider(client, handle, overlaySnapshot(base, emptyHistory()))
  const model = new GridViewportModel(provider)
  const loadStart = performance.now()
  await model.load()
  const loadMs = performance.now() - loadStart
  const totalRows = model.totalRows ?? 0
  const columnCount = model.schema?.length ?? 0

  const host = document.createElement('div')
  document.body.appendChild(host)
  let grid: WebviewDataGrid | null = null
  const controller = new EditController(
    base,
    {
      preflight: (history) => provider.preflight(overlaySnapshot(base, history)),
      activate: async (history) => {
        provider.setOverlay(overlaySnapshot(base, history))
        await model.refresh()
      },
    },
    () => grid?.refreshEditingState(),
  )
  let dirtyHistory = controller.currentHistory
  let dirtyOverlay = stateAtCursor(base, dirtyHistory)
  const currentOverlay = () => {
    const history = controller.currentHistory
    if (history !== dirtyHistory) {
      dirtyHistory = history
      dirtyOverlay = stateAtCursor(base, history)
    }
    return dirtyOverlay
  }
  grid = new WebviewDataGrid(model, {
    ariaLabel: 'Assay spike dataset grid',
    editing: {
      state: () => ({
        busy: controller.snapshot.busy,
        dirty: controller.snapshot.history.cursor > 0,
        canUndo: controller.snapshot.history.cursor > 0,
        canRedo: controller.snapshot.history.cursor < controller.snapshot.history.entries.length,
      }),
      isDirty: (rowId: RowId, column: string) => {
        const overlay = currentOverlay()
        return (
          overlay.inserts.get(rowId)?.live === true || overlayEdit(overlay, rowId, column) !== null
        )
      },
      onInsert: () => void controller.insertRow(),
      onUndo: () => void controller.undo(),
      onRedo: () => void controller.redo(),
      onCommitCell: (rowId, column, value) => void controller.commitCell(rowId, column, value),
      onDeleteRow: (rowId) => void controller.deleteRow(rowId),
    },
  })
  grid.mount(host)
  await grid.whenFirstRowVisible()
  // TTFR (the row's envelope): client.open() start → first ready row's cells
  // in the grid DOM. Engine boot is excluded (booted earlier — the R4
  // methodology, bootMs reported separately); the raw 3-column probe fetch
  // the spike ran in between is INCLUDED, so the number is conservative.
  const firstRowVisibleMs = performance.now() - openedAt

  const audit = auditGridDom(grid.element, {
    totalRows,
    columnCount,
    expectToolbar: true,
  })
  const keyboard = probeKeyboardNavigation(grid)

  // Virtualization proof: a scroll sweep to the middle of the 1M-row dataset
  // must move the rendered window and keep the DOM bounded (never
  // materialized) — then the fetches settle through the model.
  const viewport = grid.gridElement
  const mid = Math.floor(totalRows / 2)
  const snapshot = (label: string, error: unknown): Error => {
    const rendered = [
      ...viewport.querySelectorAll<HTMLElement>('[role="row"][data-row-index]'),
    ].map((row) => Number(row.dataset.rowIndex))
    const stats = model.stats
    return new Error(
      `${label}: ${error instanceof Error ? error.message : String(error)} ` +
        `[scrollTop=${String(viewport.scrollTop)} clientHeight=${String(viewport.clientHeight)} ` +
        `scrollHeight=${String(viewport.scrollHeight)} totalRows=${String(model.totalRows)} ` +
        `sort=${JSON.stringify(model.sort)} filters=${JSON.stringify(model.filters)} ` +
        `fetchCalls=${String(stats.fetchCalls)} rowsRequested=${String(stats.rowsRequested)} ` +
        `fatal=${String(stats.fatalError)} rendered=${JSON.stringify(rendered.slice(0, 4))}..${JSON.stringify(rendered.slice(-4))}]`,
    )
  }
  const waitReady = async (index: number, label: string): Promise<void> => {
    try {
      await waitForReadyRowAt(model, index)
    } catch (error: unknown) {
      throw snapshot(label, error)
    }
  }
  grid.scrollToRow(mid)
  await grid.whenRendered()
  await waitReady(mid, 'virtualization.scroll')
  const renderedRows = [...viewport.querySelectorAll<HTMLElement>('[role="row"][data-row-index]')]
  const renderedIndexes = renderedRows.map((row) => Number(row.dataset.rowIndex))
  const minRendered = Math.min(...renderedIndexes)
  const maxRendered = Math.max(...renderedIndexes)
  const virtualization = {
    ok:
      renderedRows.length > 0 &&
      renderedRows.length <= 64 &&
      renderedRows.length < totalRows &&
      minRendered <= mid &&
      mid <= maxRendered,
    detail: `mid=${String(mid)} rendered=${String(renderedRows.length)} [${String(minRendered)}..${String(maxRendered)}]`,
  }

  // Sort (the real header-button path): cycle asc → desc → cleared.
  const firstToggle = viewport.querySelector<HTMLButtonElement>('button[data-sort]')
  if (firstToggle === null) throw new Error('grid phase: no sort toggle found')
  const sortColumn = firstToggle.dataset.colName ?? ''
  firstToggle.click()
  await grid.whenQuerySettled()
  await waitReady(mid, 'sort.asc')
  const ascOk =
    model.sort !== null && model.sort.column === sortColumn && model.sort.direction === 'asc'
  const ascAttrOk = firstToggle.dataset.sort === 'asc'
  firstToggle.click()
  await grid.whenQuerySettled()
  await waitReady(mid, 'sort.desc')
  const descOk = model.sort !== null && model.sort.direction === 'desc'
  const descAttrOk = firstToggle.dataset.sort === 'desc'
  firstToggle.click()
  await grid.whenQuerySettled()
  await waitReady(mid, 'sort.clear')
  const clearOk = model.sort === null && firstToggle.dataset.sort === 'none'
  const sort = {
    ok: ascOk && ascAttrOk && descOk && descAttrOk && clearOk,
    detail: `column=${sortColumn.length > 0 ? 'named' : 'unnamed'} asc=${String(ascOk && ascAttrOk)} desc=${String(descOk && descAttrOk)} cleared=${String(clearOk)}`,
  }

  // Filter-lite (the real toolbar path): the synthetic fixture's id column
  // holds the row ordinal, so `id <= 9` filters 1,000,000 rows to exactly 10
  // (a value-free COUNT assertion — no cell values cross the harness).
  const select = host.querySelector<HTMLSelectElement>('select.assay-filter-column')
  const input = host.querySelector<HTMLInputElement>('input.assay-filter-predicate')
  const apply = host.querySelector<HTMLButtonElement>('button.assay-filter-apply')
  const clear = host.querySelector<HTMLButtonElement>('button.assay-filter-clear')
  if (select === null || input === null || apply === null || clear === null) {
    throw new Error('grid phase: filter toolbar missing')
  }
  select.value = 'id'
  input.value = '<= 9'
  apply.click()
  await grid.whenQuerySettled()
  await waitReady(0, 'filter.apply')
  const filteredOk = model.filters.length === 1 && model.totalRows === 10
  const filteredRowsVisible = model.totalRows === 10
  clear.click()
  await grid.whenQuerySettled()
  // The 10-row epoch clamped scrollTop to 0 (correct browser behavior), so
  // the top window is what the refresh serves — settle on row 0, not mid.
  await waitReady(0, 'filter.clear')
  const clearedOk = model.filters.length === 0 && model.totalRows === totalRows
  const filter = {
    ok: filteredOk && filteredRowsVisible && clearedOk,
    detail: `filtered=${String(filteredOk)} (${String(model.filters.length)} active after clear) cleared=${String(clearedOk)}`,
  }

  const stats = model.stats
  return {
    firstRowVisibleMs,
    loadMs,
    totalRows,
    columnCount,
    editingPathMounted:
      provider.editingEnabled &&
      grid.element.querySelector('.assay-edit-insert') !== null &&
      grid.element.querySelector('.assay-edit-undo') !== null,
    audit,
    keyboard,
    virtualization,
    sort,
    filter,
    stats: {
      fetchCalls: stats.fetchCalls,
      rowsRequested: stats.rowsRequested,
      rowsReceived: stats.rowsReceived,
      cachedRows: stats.cachedRows,
      maxSpanRows: stats.maxSpanRows,
    },
  }
}

/** Diagnostic OPFS round-trip (the m4-2 export path needs OPFS). */
async function opfsProbe(): Promise<unknown> {
  const result: Record<string, unknown> = { available: false }
  try {
    if (typeof navigator.storage?.getDirectory !== 'function') {
      result['reason'] = 'navigator.storage.getDirectory is unavailable'
      result['storageManager'] = typeof navigator.storage
      return result
    }
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('assay-spike', { create: true })
    const handle = await dir.getFileHandle('probe.bin', { create: true })
    const writable = await handle.createWritable()
    await writable.write(new Uint8Array([1, 2, 3, 4]))
    await writable.close()
    const read = new Uint8Array(await (await handle.getFile()).arrayBuffer())
    result['available'] = true
    result['wroteBytes'] = read.byteLength
    result['roundTrip'] = read.byteLength === 4 && read[0] === 1 && read[3] === 4
    await dir.removeEntry('probe.bin')
    try {
      result['estimate'] = await navigator.storage.estimate()
    } catch {
      // estimate() is optional; its absence must not fail the probe.
    }
  } catch (error) {
    result['reason'] = error instanceof Error ? error.message : String(error)
  }
  return result
}

async function run(): Promise<void> {
  // Environment / capability probes that need no worker.
  results['environment'] = {
    origin: location.origin,
    protocol: location.protocol,
    crossOriginIsolated:
      (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    atomics: typeof Atomics !== 'undefined',
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGB: (navigator as { deviceMemory?: number }).deviceMemory,
    performanceMemory: typeof (performance as { memory?: unknown }).memory !== 'undefined',
    storageManager: typeof navigator.storage,
    storageGetDirectory: typeof navigator.storage?.getDirectory === 'function',
    workerConstructor: typeof Worker !== 'undefined',
  }
  results['fileSystemAccess'] = {
    showOpenFilePicker:
      typeof (window as { showOpenFilePicker?: unknown }).showOpenFilePicker === 'function',
    showSaveFilePicker:
      typeof (window as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function',
    showDirectoryPicker:
      typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function',
    fileSystemHandle:
      typeof (globalThis as { FileSystemHandle?: unknown }).FileSystemHandle !== 'undefined',
  }
  results['resourceHeaders'] = await probeResourceHeaders(config.probeUrl)

  const fixturePromise = waitForFixture()
  vscodeApi.postMessage({ kind: 'ready' })

  // Q1a: can a worker be constructed directly from an `asWebviewUri` script?
  const direct: Record<string, unknown> = { attempted: true }
  try {
    const worker = new Worker(config.workerScriptUrl, { type: 'module' })
    worker.terminate()
    direct['ok'] = true
  } catch (error) {
    direct['ok'] = false
    direct['error'] = error instanceof Error ? error.message : String(error)
  }
  results['workerDirectConstruction'] = direct

  // Q1b: blob-URL bootstrap for the REAL engine adapter's worker bundle.
  const workerUrl = await step('worker.blobUrl', () =>
    toBlobUrl(config.workerScriptUrl, 'text/javascript'),
  )
  if (typeof workerUrl !== 'string') {
    results['fixture'] = { blockedBy: 'worker.blobUrl' }
    results['opfs'] = { blockedBy: 'worker.blobUrl' }
    finish()
    return
  }
  results['workerBlobUrl'] = { ok: true }

  const bundles = (results['bundles'] = {}) as Record<string, unknown>

  // Q1c: the real adapter boots the shipped DuckDB bundle inside the webview —
  // the blob-URL asset injection the ptv1-1 seam exists for. The blob URLs are
  // revoked once instantiate() has consumed them (the spike's Q5 methodology:
  // the heap sample must reflect the dataset, not the workaround).
  // ptv1-2/R1-B: the glue worker is the vendored `eh` binary with the
  // vendored-asset shim appended (CDN block + local extension registration).
  // The DuckDB WASM itself stays a plain blob of the vendored bytes. R1-B
  // (ADR 0048 decision 3) removed the second `mvp` boot: the desktop package
  // ships the `eh` pair only, so every substantive probe below (boot, vendored
  // serve, fixture open, grid, OPFS, heap/TTFR) runs on this one engine.
  // The vendored extension is fetched HERE (main thread — the proven
  // toBlobUrl path) and re-exposed as a same-origin blob for the shim:
  // direct worker-side fetches of vscode-webview-resource URLs 404 (they
  // route differently), while blob: fetches inside the glue worker are
  // exactly how DuckDB instantiation consumes its WASM. Drill mode passes
  // no bytes at all — the stock CDN path must run (and hit the block).
  const extensionBlobUrl = config.drill
    ? undefined
    : await toBlobUrl(config.vendoredExtension.url, 'application/wasm')
  if (!config.drill && typeof extensionBlobUrl !== 'string') {
    results['fixture'] = { blockedBy: 'vendored.extensionBlobUrl' }
    results['opfs'] = { blockedBy: 'vendored.extensionBlobUrl' }
    finish()
    return
  }
  const glueBlobUrl = await step('glue.shimmedBlobUrl', () =>
    buildShimmedGlueBlobUrl(config.bundle.workerUrl, {
      blockedHost: config.blockedExtensionHost,
      extensionUrl: extensionBlobUrl ?? '',
      extensionPath: config.vendoredExtension.autoloadPath,
      drill: config.drill,
    }),
  )
  if (typeof glueBlobUrl !== 'string') {
    results['fixture'] = { blockedBy: 'glue.shimmedBlobUrl' }
    results['opfs'] = { blockedBy: 'glue.shimmedBlobUrl' }
    finish()
    return
  }
  const engineAssets: EngineAssetsMessage = {
    type: 'engine/assets',
    duckdbWorkerUrl: glueBlobUrl,
    duckdbWasmUrl: await toBlobUrl(config.bundle.wasmUrl, 'application/wasm'),
  }
  const engineClient = createAdapterClient(workerUrl, engineAssets, 'eh', diagnostics)
  const engineBoot = await step('boot.eh', () => bootAdapter(engineClient))
  bundles['eh'] = engineBoot ?? { ok: false, note: 'see errors["boot.eh"]' }
  URL.revokeObjectURL(engineAssets.duckdbWorkerUrl)
  URL.revokeObjectURL(engineAssets.duckdbWasmUrl)
  if (typeof extensionBlobUrl === 'string') {
    URL.revokeObjectURL(extensionBlobUrl)
  }
  heap['postBoot'] = heapSample()

  if (engineBoot !== undefined) {
    // ptv1-2: local-first extension serve (skipped in drill mode), BEFORE
    // the fixture open so read_parquet never needs the CDN.
    const vendored = await step('vendored.serve', () => verifyVendoredServe(engineClient, config))
    if (vendored !== undefined) {
      results['vendoredAssets'] = vendored
    }
    const fixture = await fixturePromise
    const opened = await step('open.million', () =>
      openFixtureThroughAdapter(engineClient, fixture),
    )
    if (opened !== undefined) {
      results['fixture'] = opened.metrics
      // ptv1-4: the headless-grid dataset surface over the SAME handle — the
      // row's perf envelope (TTFR picker→first-row) + a11y/virtualization/
      // sort-filter evidence. Heap sampled after the phase (steady state).
      const gridPhase = await step('grid.surface', () =>
        runGridPhase(engineClient, opened.handle, opened.openedAt),
      )
      if (gridPhase !== undefined) {
        results['grid'] = gridPhase
      } else {
        results['grid'] = { blockedBy: 'grid.surface' }
      }
    }
    heap['postFirstRow'] = heapSample()
  } else {
    results['fixture'] = { blockedBy: 'boot.eh' }
  }
  results['opfs'] = await step('opfs', () => opfsProbe())
  // ptv1-4: the live-heap sample for the grid budget — forced GC (the R4 Q5
  // methodology), taken with the grid mounted and swept (bounded cache +
  // window DOM = the surface's steady state).
  heap['postGrid'] = heapSample()
  await step('dispose.eh', () => engineClient.dispose())
  URL.revokeObjectURL(workerUrl)

  finish()
}

function finish(): void {
  results['finishedAt'] = new Date().toISOString()
  setStatus('done')
  vscodeApi.postMessage({ kind: 'results', results })
}

void run().catch((error: unknown) => {
  vscodeApi.postMessage({
    kind: 'error',
    message: error instanceof Error ? error.message : String(error),
  })
})

export {}
