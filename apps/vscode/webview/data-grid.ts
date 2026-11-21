// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The webview dataset grid (ptv1-4): a dependency-free virtualized DOM
 * renderer over the headless `GridViewportModel` (`@assay/grid`, ADR 0022 —
 * rendering is replaceable; this is the VS Code surface's renderer twin of
 * the web app's TanStack `DataGrid`, kept deliberately React-free because
 * the webview bundle is a plain esbuild module).
 *
 * Division of labor (ADR 0022/0008): the MODEL owns windowed fetching, the
 * bounded LRU cache, placeholder semantics and query state; this renderer
 * owns only the DOM projection — a fixed-row-height window (viewport +
 * overscan) absolutely positioned in a spacer, so DOM nodes stay bounded
 * regardless of dataset size (the 1M-row envelope is the proof; the dataset
 * is never materialized in UI state).
 *
 * Keyboard/a11y basics mirror the web app's standards (`apps/web/src/grid/
 * DataGrid.tsx`): `role="grid"` on the scroll viewport with `aria-rowcount`
 * /`aria-colcount`; header rowgroup/row/columnheader with per-column sort
 * toggle buttons (accessible names, `data-sort`, `aria-sort`); body rows
 * with `aria-rowindex` and a ROVING TABINDEX (exactly one rendered row is a
 * tab stop; cells are `tabindex=-1` and arrow-addressable); visible focus
 * outlines; a labeled filter-lite toolbar; value-free stats footer. Dataset
 * values are untrusted content: every cell renders through `textContent`
 * (no `innerHTML` anywhere) — same hard rule as the rest of the surface
 * (engineering/04 §6).
 */
import type { CellValue, RowId } from '@assay/domain'
import type { GridViewportModel, SortSpec } from '@assay/grid'
import { parseCellDraft, supportsCellDraft } from '../src/pure/cell-input'
import { filterFailureCopy } from '../src/pure/filter-failure'
import type { FilterFailureRecovery } from '../src/pure/filter-failure'

/** Fixed row height for the DOM renderer (the web app's `GRID_ROW_HEIGHT_PX`). */
export const GRID_ROW_HEIGHT_PX = 28
/** Fixed header-row height (single-line; CSS enforces it). */
export const GRID_HEADER_HEIGHT_PX = 28
/** DOM rows rendered beyond the visible window so scrolling stays ahead of paint. */
const OVERSCAN_ROWS = 6
/** Default viewport height (px); the audit derives its DOM bound from the real clientHeight. */
const DEFAULT_VIEWPORT_HEIGHT_PX = 480

/**
 * The sort spec after one click on `column`'s header toggle: unsorted (or
 * sorted on another column) → ascending, ascending → descending,
 * descending → cleared. Duplicated deliberately from the web app's
 * `apps/web/src/grid/query-state.ts` (apps cannot import apps; the cycle is
 * six lines and pinned by the harness's sort probe).
 */
export function nextSortSpec(current: SortSpec | null, column: string): SortSpec | null {
  if (current === null || current.column !== column) return { column, direction: 'asc' }
  if (current.direction === 'asc') return { column, direction: 'desc' }
  return null
}

export interface WebviewDataGridOptions {
  /** Accessible name for the grid viewport. Default 'Dataset grid'. */
  readonly ariaLabel?: string
  /** Viewport height in px. Default 480. */
  readonly viewportHeightPx?: number
  /** Render the filter-lite toolbar (the spike harness mounts it too). Default true. */
  readonly showToolbar?: boolean
  readonly editing?: {
    readonly state: () => {
      readonly busy: boolean
      readonly dirty: boolean
      readonly canUndo: boolean
      readonly canRedo: boolean
    }
    readonly isDirty: (rowId: RowId, column: string) => boolean
    readonly onInsert: () => void
    readonly onUndo: () => void
    readonly onRedo: () => void
    readonly onCommitCell: (rowId: RowId, column: string, value: CellValue) => void
    readonly onDeleteRow: (rowId: RowId) => void
  }
}

/**
 * Format one cell value for display (total: every input maps to a short,
 * deterministic string). The webview-lite twin of the web app's
 * `formatCell`: scalars verbatim, Dates ISO, binary as a byte count, and
 * nested structures through a bounded JSON preview (nested inspection is
 * the record view's job in later slices). NULL is the caller's concern (the
 * renderer shows the distinct `NULL` marker, never an empty cell).
 */
export function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return `<${String(value.length)} bytes>`
  if (typeof value === 'object') {
    // Bounded, total nested preview (struct records, list slices): capped
    // length, bigint members stringified — nested inspection stays the
    // record view's job in later slices. JSON.stringify on an object root
    // cannot throw for the shapes the engine projects.
    const text = JSON.stringify(value, (_key, nested: unknown) =>
      typeof nested === 'bigint' ? String(nested) : nested,
    )
    return text.length <= 160 ? text : `${text.slice(0, 159)}…`
  }
  return String(value)
}

function isNativeControl(target: Element): boolean {
  return target.closest('input, button, select, textarea, [contenteditable="true"]') !== null
}

const STYLE_ID = 'assay-grid-style'

/** One-time style injection (textContent — never innerHTML; CSP-legal inline style). */
function injectStyle(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.assay-grid-root { font: 12px/1.4 var(--vscode-font-family, sans-serif); color: var(--vscode-foreground, inherit); }
.assay-grid-toolbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 0 0 6px 0; }
.assay-grid-toolbar input, .assay-grid-toolbar select, .assay-grid-toolbar button {
  font: inherit; color: inherit; background: var(--vscode-input-background, transparent);
  border: 1px solid var(--vscode-input-border, #666); border-radius: 2px; padding: 2px 6px; }
.assay-grid-toolbar button { cursor: pointer; background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); border: none; }
.assay-grid-viewport { overflow: auto; height: ${String(DEFAULT_VIEWPORT_HEIGHT_PX)}px; border: 1px solid var(--vscode-panel-border, #444); background: var(--vscode-editor-background, transparent); }
.assay-grid-header { position: sticky; top: 0; z-index: 2; background: var(--vscode-editor-background, inherit); }
.assay-grid-header-row, .assay-grid-row { display: grid; height: ${String(GRID_ROW_HEIGHT_PX)}px; }
.assay-grid-header-row { border-bottom: 1px solid var(--vscode-panel-border, #444); }
.assay-grid-header-cell { display: flex; align-items: center; gap: 4px; padding: 0 6px; min-width: 0; border-right: 1px solid var(--vscode-panel-border, #333); font-weight: 600; }
.assay-grid-header-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.assay-grid-sort-toggle { flex: 0 0 auto; border: none; background: transparent; color: inherit; cursor: pointer; padding: 0 2px; font: inherit; }
.assay-grid-row { position: absolute; left: 0; top: 0; }
.assay-grid-row:focus, .assay-grid-cell:focus { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: -2px; }
.assay-grid-cell { display: flex; align-items: center; padding: 0 6px; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; border-right: 1px solid var(--vscode-panel-border, #222); }
.assay-grid-cell[data-dirty="true"] { border-bottom: 2px solid var(--vscode-editorWarning-foreground, #cca700); }
.assay-grid-row[data-status="loading"] .assay-grid-cell { color: var(--vscode-editorGhostText-foreground, #888); }
.assay-grid-row[data-status="error"] .assay-grid-cell { color: var(--vscode-errorForeground, #f66); }
.assay-grid-null-marker { color: var(--vscode-editorGhostText-foreground, #888); }
.assay-grid-footer { margin-top: 4px; color: var(--vscode-descriptionForeground, #999); }
.assay-grid-filter-status { color: var(--vscode-descriptionForeground, #999); }
.assay-grid-command-error { color: var(--vscode-errorForeground, #f66); }
.assay-visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
`
  document.head.appendChild(style)
}

/** Sort indicator glyph per state (decorative; the aria-label carries meaning). */
function sortGlyph(direction: 'asc' | 'desc' | null): string {
  if (direction === 'asc') return '▲'
  if (direction === 'desc') return '▼'
  return '↕'
}

interface RenderedRow {
  readonly element: HTMLElement
  /** Model version the row's cells were last painted at (staleness marker). */
  paintedAtVersion: number
  /** Slot status the row was last painted with. */
  paintedStatus: 'ready' | 'loading' | 'error'
}

export class WebviewDataGrid {
  private readonly model: GridViewportModel
  private readonly options: Required<Omit<WebviewDataGridOptions, 'editing'>> &
    Pick<WebviewDataGridOptions, 'editing'>
  private readonly rows = new Map<number, RenderedRow>()
  private readonly unsubscribe: () => void
  private readonly renderWaiters: Array<() => void> = []
  private firstRowVisibleWaiters: Array<() => void> = []
  private querySettled: Promise<void> = Promise.resolve()
  private renderQueued = false
  private lastRange: { readonly first: number; readonly last: number } = { first: 0, last: -1 }
  /** The row that owns the grid's single tab stop (null = not yet entered). */
  private focusedRowIndex: number | null = null
  /** A focus move parked until the virtualizer renders the target row. */
  private parkedFocus: { readonly rowIndex: number; readonly columnIndex: number | null } | null =
    null

  private root: HTMLElement | null = null
  private viewport: HTMLElement | null = null
  private body: HTMLElement | null = null
  private footer: HTMLElement | null = null
  private headerCells: HTMLElement[] = []
  private sortButtons: HTMLElement[] = []
  private filterColumnSelect: HTMLSelectElement | null = null
  private filterInput: HTMLInputElement | null = null
  private filterStatus: HTMLElement | null = null
  private commandError: HTMLElement | null = null
  private commandErrorAction: HTMLButtonElement | null = null
  private editButtons: {
    readonly undo: HTMLButtonElement
    readonly redo: HTMLButtonElement
    readonly insert: HTMLButtonElement
    readonly deleteRow: HTMLButtonElement
  } | null = null
  private sessionWarning: HTMLElement | null = null

  constructor(model: GridViewportModel, options: WebviewDataGridOptions = {}) {
    this.model = model
    this.options = {
      ariaLabel: options.ariaLabel ?? 'Dataset grid',
      viewportHeightPx: options.viewportHeightPx ?? DEFAULT_VIEWPORT_HEIGHT_PX,
      showToolbar: options.showToolbar ?? true,
      ...(options.editing === undefined ? {} : { editing: options.editing }),
    }
    this.unsubscribe = model.subscribe(() => {
      this.scheduleRender()
      this.updateFooter()
      this.updateFilterStatus()
      this.updateSortIndicators()
    })
  }

  /** The mounted root (toolbar + viewport + footer) — the audit's subject. */
  get element(): HTMLElement {
    if (this.root === null) throw new Error('WebviewDataGrid: mount() first')
    return this.root
  }

  /** The scroll viewport (role="grid") — the audit and probes address this. */
  get gridElement(): HTMLElement {
    if (this.viewport === null) throw new Error('WebviewDataGrid: mount() first')
    return this.viewport
  }

  /** Resolves once a READY row's cells are in the DOM (or the dataset is empty). */
  whenFirstRowVisible(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.firstRowVisibleWaiters.push(resolve)
      this.checkFirstRowVisible()
    })
  }

  /**
   * Resolves when the last sort/filter query has settled (either way — the
   * rejection is surfaced in the UI, not to this promise). The harness
   * awaits this after clicking the sort/filter controls.
   */
  whenQuerySettled(): Promise<void> {
    return this.querySettled
  }

  /** Resolves after the next render pass (the virtualization probe uses it). */
  whenRendered(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.renderWaiters.push(resolve)
      this.scheduleRender()
    })
  }

  /** Mount the grid into `container` (post-`model.load()`; schema is required). */
  mount(container: HTMLElement): void {
    if (this.root !== null) throw new Error('WebviewDataGrid: already mounted')
    if (!this.model.loaded || this.model.schema === null) {
      throw new Error('WebviewDataGrid: mount after model.load() (schema required)')
    }
    injectStyle()

    const root = document.createElement('div')
    root.className = 'assay-grid-root'
    if (this.options.showToolbar) root.appendChild(this.buildToolbar())

    const viewport = document.createElement('div')
    viewport.className = 'assay-grid-viewport'
    viewport.style.height = `${String(this.options.viewportHeightPx)}px`
    viewport.setAttribute('role', 'grid')
    viewport.setAttribute('aria-label', this.options.ariaLabel)
    viewport.setAttribute('aria-rowcount', String((this.model.totalRows ?? 0) + 1))
    viewport.setAttribute('aria-colcount', String(this.model.schema.length))
    viewport.addEventListener('scroll', () => this.scheduleRender())
    viewport.addEventListener('keydown', (event) => this.onKeyDown(event))

    viewport.appendChild(this.buildHeader())
    const body = document.createElement('div')
    body.setAttribute('role', 'rowgroup')
    body.style.position = 'relative'
    body.style.width = '100%'
    this.body = body
    viewport.appendChild(body)

    const footer = document.createElement('div')
    footer.className = 'assay-grid-footer'
    this.footer = footer

    root.appendChild(viewport)
    root.appendChild(footer)
    container.appendChild(root)
    this.root = root
    this.viewport = viewport

    this.updateFooter()
    this.updateFilterStatus()
    this.updateSortIndicators()
    if ((this.model.totalRows ?? 0) === 0) {
      this.resolveFirstRowVisible() // an empty dataset shows the empty grid immediately
    }
    this.scheduleRender()
  }

  /** Remove listeners and DOM (harness teardown; the page dies with the panel). */
  dispose(): void {
    this.unsubscribe()
    this.root?.remove()
    this.root = null
    this.viewport = null
    this.body = null
    this.rows.clear()
  }

  /** Focus the grid's roving tab stop (the tabbable row). */
  focusGrid(): void {
    const tabbable = this.tabbableRowIndex()
    if (tabbable === null) return
    const row = this.rows.get(tabbable)
    if (row !== undefined) {
      row.element.focus()
      return
    }
    this.scrollRowTo(tabbable)
    this.parkedFocus = { rowIndex: tabbable, columnIndex: null }
    this.scheduleRender()
  }

  /** Scroll the viewport so `rowIndex` is visible (no focus side effects). */
  scrollToRow(rowIndex: number): void {
    this.scrollRowTo(rowIndex)
    this.scheduleRender()
  }

  // ----- construction helpers -------------------------------------------------

  private buildToolbar(): HTMLElement {
    const toolbar = document.createElement('div')
    toolbar.className = 'assay-grid-toolbar'

    const select = document.createElement('select')
    select.className = 'assay-filter-column'
    select.setAttribute('aria-label', 'Filter column')
    for (const column of this.model.schema ?? []) {
      const option = document.createElement('option')
      option.value = column.name
      option.textContent = column.name
      select.appendChild(option)
    }
    this.filterColumnSelect = select

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'assay-filter-predicate'
    input.setAttribute('aria-label', 'Filter predicate (engine SQL fragment, e.g. > 100)')
    input.placeholder = 'e.g. > 100'
    this.filterInput = input

    const apply = document.createElement('button')
    apply.type = 'button'
    apply.className = 'assay-filter-apply'
    apply.textContent = 'Apply filter'
    apply.addEventListener('click', () => this.applyFilter())

    const clear = document.createElement('button')
    clear.type = 'button'
    clear.className = 'assay-filter-clear'
    clear.textContent = 'Clear filters'
    clear.addEventListener('click', () => this.clearFilters())

    const status = document.createElement('span')
    status.className = 'assay-grid-filter-status'
    status.setAttribute('role', 'status')
    this.filterStatus = status

    const error = document.createElement('span')
    error.className = 'assay-grid-command-error'
    error.setAttribute('role', 'alert')
    error.hidden = true
    this.commandError = error

    // C02c: the one recovery action a failed apply can offer (Retry the
    // reload, or the explicit Clear-filters counterpart of the unknown-list
    // state). Hidden unless a phase names it.
    const action = document.createElement('button')
    action.type = 'button'
    action.className = 'assay-grid-command-action'
    // Kept in the DOM (hidden unless a phase offers it) with a permanent
    // accessible name: the harness audits every toolbar button's name and
    // does not special-case `hidden`.
    action.textContent = 'Filter recovery'
    action.setAttribute('aria-label', 'Filter recovery')
    action.hidden = true
    this.commandErrorAction = action

    toolbar.append(select, input, apply, clear, status, error, action)
    const editing = this.options.editing
    if (editing !== undefined) {
      const insert = document.createElement('button')
      insert.type = 'button'
      insert.className = 'assay-edit-insert'
      insert.textContent = 'Insert row'
      insert.disabled = editing.state().busy
      insert.addEventListener('click', editing.onInsert)
      const deleteRow = document.createElement('button')
      deleteRow.type = 'button'
      deleteRow.className = 'assay-edit-delete'
      deleteRow.textContent = 'Delete row'
      deleteRow.disabled = editing.state().busy
      deleteRow.addEventListener('click', () => {
        const selected = this.focusedRowIndex ?? this.tabbableRowIndex()
        if (selected === null) return
        const slot = this.model.getRow(selected)
        if (slot.status === 'ready' && slot.key !== undefined)
          editing.onDeleteRow(slot.key as RowId)
      })
      const undo = document.createElement('button')
      undo.type = 'button'
      undo.className = 'assay-edit-undo'
      undo.textContent = 'Undo'
      undo.disabled = editing.state().busy || !editing.state().canUndo
      undo.addEventListener('click', editing.onUndo)
      const redo = document.createElement('button')
      redo.type = 'button'
      redo.className = 'assay-edit-redo'
      redo.textContent = 'Redo'
      redo.disabled = editing.state().busy || !editing.state().canRedo
      redo.addEventListener('click', editing.onRedo)
      const warning = document.createElement('span')
      warning.className = 'assay-session-warning'
      warning.setAttribute('role', 'note')
      warning.textContent =
        'Source is immutable. Unexported edits are session-only and lost when this view closes.'
      this.editButtons = { insert, undo, redo, deleteRow }
      this.sessionWarning = warning
      toolbar.append(insert, deleteRow, undo, redo, warning)
      this.refreshEditingState()
    }
    return toolbar
  }

  private buildHeader(): HTMLElement {
    const schema = this.model.schema ?? []
    const headerGroup = document.createElement('div')
    headerGroup.setAttribute('role', 'rowgroup')
    headerGroup.className = 'assay-grid-header'
    const headerRow = document.createElement('div')
    headerRow.setAttribute('role', 'row')
    headerRow.className = 'assay-grid-header-row'
    this.applyGridColumns(headerRow)
    this.headerCells = []
    this.sortButtons = []
    for (const column of schema) {
      const cell = document.createElement('div')
      cell.setAttribute('role', 'columnheader')
      cell.className = 'assay-grid-header-cell'
      cell.dataset.colName = column.name
      cell.title = `${column.name}: ${column.type}`

      const name = document.createElement('span')
      name.className = 'assay-grid-header-name'
      name.textContent = column.name

      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.className = 'assay-grid-sort-toggle'
      toggle.dataset.colName = column.name
      toggle.dataset.sort = 'none'
      toggle.setAttribute('aria-label', `Sort by ${column.name}`)
      toggle.title = `Sort by ${column.name}`
      const glyph = document.createElement('span')
      glyph.setAttribute('aria-hidden', 'true')
      glyph.textContent = sortGlyph(null)
      toggle.appendChild(glyph)
      toggle.addEventListener('click', () => {
        this.applySort(column.name)
      })
      this.sortButtons.push(toggle)

      cell.append(name, toggle)
      headerRow.appendChild(cell)
      this.headerCells.push(cell)
    }
    headerGroup.appendChild(headerRow)
    return headerGroup
  }

  /** Shared deterministic track floor: wide stretches equally, narrow pans (web app pattern). */
  private applyGridColumns(row: HTMLElement): void {
    const count = this.model.schema?.length ?? 0
    row.style.gridTemplateColumns = `repeat(${String(count)}, minmax(9rem, 1fr))`
    row.style.minWidth = `calc(${String(count)} * 9rem)`
  }

  // ----- query state ----------------------------------------------------------

  /** The header sort button's path (the harness clicks the button itself). */
  private applySort(column: string): void {
    this.trackQuery(this.model.setSort(nextSortSpec(this.model.sort, column)))
  }

  private applyFilter(): void {
    const column = this.filterColumnSelect?.value ?? ''
    const predicate = (this.filterInput?.value ?? '').trim()
    if (column === '') return
    if (predicate === '') {
      this.showCommandError('enter a predicate (engine SQL fragment, e.g. > 100)')
      return
    }
    this.trackQuery(this.model.setFilters([{ column, predicate }]))
  }

  private clearFilters(): void {
    if (this.filterInput !== null) this.filterInput.value = ''
    this.trackQuery(this.model.setFilters([]))
  }

  /** Run one query-state mutation: errors surface in the alert, never here. */
  private trackQuery(query: Promise<void>): void {
    this.hideCommandError()
    const settled = query.then(
      () => undefined,
      (error: unknown) => {
        // C02c: map the model's value-free phase to copy — never print the
        // raw engine message (C01 §7). The model owns any restoration.
        this.showFilterFailure(error)
      },
    )
    this.querySettled = settled
  }

  /** Render one failed apply from its phase (`FilterApplyError`). */
  private showFilterFailure(error: unknown): void {
    const copy = filterFailureCopy(error)
    this.showCommandError(copy.message, copy.recovery)
  }

  private showCommandError(message: string, recovery: FilterFailureRecovery = null): void {
    if (this.commandError === null) return
    this.commandError.textContent = message
    this.commandError.hidden = false
    this.renderCommandAction(recovery)
  }

  /** Keep the one optional recovery control in step with the rendered copy. */
  private renderCommandAction(recovery: FilterFailureRecovery): void {
    const action = this.commandErrorAction
    if (action === null) return
    action.onclick = null
    if (recovery === null) {
      action.hidden = true
      action.textContent = 'Filter recovery'
      action.setAttribute('aria-label', 'Filter recovery')
      action.removeAttribute('data-action')
      return
    }
    const label = recovery.kind === 'retry' ? 'Retry' : 'Clear filters'
    action.hidden = false
    action.dataset.action = recovery.kind
    action.textContent = label
    action.setAttribute('aria-label', label)
    action.onclick = () => {
      if (recovery.kind === 'retry') {
        // Case (b) recovery is the model's own reload, never a second filter
        // write: the accepted list stays in effect.
        this.trackQuery(this.model.refresh())
      } else {
        // Restore-failed recovery: the documented Clear-filters affordance
        // (a successful `setFilters([])` also clears `filtersUnknown`).
        this.clearFilters()
      }
    }
  }

  private hideCommandError(): void {
    if (this.commandError === null) return
    this.commandError.hidden = true
    this.commandError.textContent = ''
    if (this.commandErrorAction !== null) {
      this.commandErrorAction.hidden = true
      this.commandErrorAction.textContent = 'Filter recovery'
      this.commandErrorAction.setAttribute('aria-label', 'Filter recovery')
      this.commandErrorAction.removeAttribute('data-action')
      this.commandErrorAction.onclick = null
    }
  }

  private updateSortIndicators(): void {
    const sort = this.model.sort
    for (const cell of this.headerCells) {
      const name = cell.dataset.colName ?? ''
      const active = sort !== null && sort.column === name ? sort.direction : null
      cell.setAttribute(
        'aria-sort',
        active === null ? 'none' : active === 'asc' ? 'ascending' : 'descending',
      )
    }
    for (const button of this.sortButtons) {
      const name = button.dataset.colName ?? ''
      const active = sort !== null && sort.column === name ? sort.direction : null
      button.dataset.sort = active ?? 'none'
      const label =
        active === null
          ? `Sort by ${name}`
          : `Sort by ${name} (currently ${active === 'asc' ? 'ascending' : 'descending'})`
      button.setAttribute('aria-label', label)
      button.title = label
      const glyph = button.firstElementChild
      if (glyph !== null) glyph.textContent = sortGlyph(active)
    }
  }

  private updateFilterStatus(): void {
    if (this.filterStatus === null) return
    const parts: string[] = []
    const sort = this.model.sort
    if (sort !== null) parts.push(`sorted by ${sort.column} (${sort.direction})`)
    for (const filter of this.model.filters) {
      parts.push(`filter: ${filter.column} ${filter.predicate}`)
    }
    parts.push(`${String(this.model.totalRows ?? 0)} rows`)
    this.filterStatus.textContent = parts.join(' · ')
  }

  private updateFooter(): void {
    if (this.footer === null) return
    const stats = this.model.stats
    const showing =
      this.lastRange.last >= this.lastRange.first
        ? `showing ${String(this.lastRange.first + 1)}–${String(this.lastRange.last + 1)}`
        : 'showing none'
    this.footer.textContent =
      `${String(this.model.totalRows ?? 0)} rows · ${showing} · cached ${String(stats.cachedRows)} rows · ` +
      `engine requests ${String(stats.fetchCalls)} (${String(stats.rowsRequested)} rows requested)`
    this.footer.dataset.fetchCalls = String(stats.fetchCalls)
  }

  // ----- virtualization -------------------------------------------------------

  private scheduleRender(): void {
    if (this.renderQueued || this.viewport === null) return
    this.renderQueued = true
    requestAnimationFrame(() => {
      this.renderQueued = false
      this.renderWindow()
      const waiters = this.renderWaiters.splice(0, this.renderWaiters.length)
      for (const waiter of waiters) waiter()
    })
  }

  /** Recompute the visible window, sync the DOM, and tell the model. */
  private renderWindow(): void {
    const viewport = this.viewport
    const body = this.body
    if (viewport === null || body === null) return
    const total = this.model.totalRows ?? 0
    body.style.height = `${String(Math.max(total, 1) * GRID_ROW_HEIGHT_PX)}px`
    if (total === 0) {
      this.syncRows(0, -1)
      this.lastRange = { first: 0, last: -1 }
      this.updateFooter()
      return
    }
    const scrollTop = viewport.scrollTop
    const first = Math.max(0, Math.floor((scrollTop - GRID_HEADER_HEIGHT_PX) / GRID_ROW_HEIGHT_PX))
    const visibleCount = Math.ceil(viewport.clientHeight / GRID_ROW_HEIGHT_PX) + 1
    const last = Math.min(total - 1, first + visibleCount - 1)
    const renderFirst = Math.max(0, first - OVERSCAN_ROWS)
    const renderLast = Math.min(total - 1, last + OVERSCAN_ROWS)
    this.lastRange = { first, last }
    this.syncRows(renderFirst, renderLast)
    this.applyRovingTabIndex()
    this.completeParkedFocus()
    this.model.observeViewport(renderFirst, renderLast)
    this.updateFooter()
    this.checkFirstRowVisible()
  }

  /** Create/update/prune the rendered row elements for [first, last]. */
  private syncRows(first: number, last: number): void {
    for (const [index, row] of [...this.rows]) {
      if (index < first || index > last) {
        row.element.remove()
        this.rows.delete(index)
      }
    }
    for (let index = first; index <= last; index++) {
      let row = this.rows.get(index)
      const version = this.model.getVersion()
      const slot = this.model.getRow(index)
      if (row === undefined) {
        row = { element: this.buildRow(index), paintedAtVersion: -1, paintedStatus: 'loading' }
        this.rows.set(index, row)
        this.body?.appendChild(row.element)
      }
      if (row.paintedAtVersion === version && row.paintedStatus === slot.status) continue
      this.paintRow(row.element, index, slot)
      row.paintedAtVersion = version
      row.paintedStatus = slot.status
    }
  }

  private buildRow(index: number): HTMLElement {
    const row = document.createElement('div')
    row.setAttribute('role', 'row')
    row.className = 'assay-grid-row'
    row.dataset.rowIndex = String(index)
    row.setAttribute('aria-rowindex', String(index + 2))
    row.tabIndex = -1
    row.style.transform = `translateY(${String(index * GRID_ROW_HEIGHT_PX)}px)`
    this.applyGridColumns(row)
    row.addEventListener('focus', () => {
      // Row-level focus (not a bubbled cell focus) drops the carried column.
      if (document.activeElement === row) this.focusedRowIndex = index
    })
    if (this.options.editing !== undefined) {
      row.addEventListener('keydown', (event) => {
        if (event.key !== 'Delete' || !(event.target instanceof Element)) return
        if (isNativeControl(event.target)) return
        const slot = this.model.getRow(index)
        if (slot.status !== 'ready' || slot.key === undefined) return
        event.preventDefault()
        this.options.editing?.onDeleteRow(slot.key as RowId)
      })
    }
    return row
  }

  /** (Re)paint one row's cells for its current slot state. */
  private paintRow(
    row: HTMLElement,
    index: number,
    slot: ReturnType<GridViewportModel['getRow']>,
  ): void {
    row.dataset.status = slot.status
    if (slot.status === 'ready' && slot.key !== undefined) {
      row.dataset.rowId = slot.key
    } else {
      row.removeAttribute('data-row-id')
      row.removeAttribute('data-dirty')
    }
    row.replaceChildren()
    if (slot.status === 'error') {
      row.title = slot.message
    } else {
      row.removeAttribute('title')
    }
    const schema = this.model.schema ?? []
    for (let columnIndex = 0; columnIndex < schema.length; columnIndex++) {
      const cell = document.createElement('div')
      cell.setAttribute('role', 'gridcell')
      cell.className = 'assay-grid-cell'
      cell.dataset.colIndex = String(columnIndex)
      cell.dataset.colName = schema[columnIndex]?.name ?? ''
      cell.tabIndex = -1
      cell.addEventListener('focus', () => {
        if (document.activeElement === cell) this.focusedRowIndex = index
      })
      if (slot.status === 'ready') {
        const value = slot.row[columnIndex]
        if (!supportsCellDraft(schema[columnIndex]?.type ?? '')) {
          cell.title = 'Read-only: this value has no lossless editor in this view.'
        }
        if (this.options.editing !== undefined && slot.key !== undefined) {
          cell.dataset.dirty = this.options.editing.isDirty(
            slot.key as RowId,
            schema[columnIndex]?.name ?? '',
          )
            ? 'true'
            : 'false'
        }
        if (
          this.options.editing !== undefined &&
          slot.key !== undefined &&
          supportsCellDraft(schema[columnIndex]?.type ?? '')
        ) {
          cell.setAttribute('aria-label', `Edit ${schema[columnIndex]?.name ?? 'cell'}`)
          cell.addEventListener('dblclick', () => this.beginCellEdit(cell, index, columnIndex))
          cell.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === 'F2') {
              event.preventDefault()
              this.beginCellEdit(cell, index, columnIndex)
            }
          })
        }
        if (value === null || value === undefined) {
          cell.dataset.null = 'true'
          const marker = document.createElement('span')
          marker.className = 'assay-grid-null-marker'
          marker.textContent = 'NULL'
          cell.appendChild(marker)
        } else {
          cell.textContent = formatCellValue(value)
        }
      } else {
        cell.textContent = slot.status === 'loading' ? '…' : '!'
      }
      row.appendChild(cell)
    }
    if (slot.status === 'ready' && this.options.editing !== undefined) {
      row.dataset.dirty = row.querySelector('[data-dirty="true"]') === null ? 'false' : 'true'
    }
  }

  /** Refresh history controls and dirty markers after an accepted transition. */
  refreshEditingState(): void {
    const editing = this.options.editing
    const buttons = this.editButtons
    if (editing === undefined || buttons === null) return
    const state = editing.state()
    buttons.insert.disabled = state.busy
    buttons.deleteRow.disabled = state.busy
    buttons.undo.disabled = state.busy || !state.canUndo
    buttons.redo.disabled = state.busy || !state.canRedo
    if (this.sessionWarning !== null) {
      this.sessionWarning.dataset.dirty = state.dirty ? 'true' : 'false'
      this.sessionWarning.textContent = state.dirty
        ? 'Source is immutable. Unexported edits are session-only and lost when this view closes.'
        : 'Source is immutable. Edits are session-only; closing this view loses unexported changes.'
    }
    for (const row of this.rows.values()) row.paintedAtVersion = -1
    this.scheduleRender()
  }

  private beginCellEdit(cell: HTMLElement, rowIndex: number, columnIndex: number): void {
    const editing = this.options.editing
    const slot = this.model.getRow(rowIndex)
    const column = this.model.schema?.[columnIndex]
    if (
      editing === undefined ||
      editing.state().busy ||
      slot.status !== 'ready' ||
      slot.key === undefined ||
      column === undefined
    )
      return
    if (!supportsCellDraft(column.type)) {
      this.showCommandError('Nested values are not editable in this view.')
      return
    }
    const original = slot.row[columnIndex]
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'assay-cell-editor'
    input.setAttribute('aria-label', `Edit ${column.name}`)
    input.value = original === null || original === undefined ? '' : formatCellValue(original)
    let finished = false
    const finish = (value: CellValue | null): void => {
      if (finished) return
      finished = true
      if (value !== null) editing.onCommitCell(slot.key as RowId, column.name, value)
      this.scheduleRender()
      cell.focus()
    }
    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Escape') {
        event.preventDefault()
        const rendered = this.rows.get(rowIndex)
        if (rendered !== undefined) rendered.paintedAtVersion = -1
        this.scheduleRender()
        requestAnimationFrame(() => {
          const row = this.rows.get(rowIndex)
          if (row !== undefined) this.focusInRow(row.element, columnIndex)
        })
      } else if (event.key === 'Enter') {
        event.preventDefault()
        const parsed = parseCellDraft(column.type, input.value)
        if (!parsed.ok) {
          this.showCommandError(parsed.message)
          return
        }
        this.hideCommandError()
        finish(parsed.value)
      }
    })
    const nullButton = document.createElement('button')
    nullButton.type = 'button'
    nullButton.className = 'assay-cell-set-null'
    nullButton.textContent = 'Set NULL'
    nullButton.setAttribute('aria-label', `Set ${column.name} to NULL`)
    nullButton.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        finish({ kind: 'null' })
      }
    })
    nullButton.addEventListener('click', (event) => {
      event.stopPropagation()
      finish({ kind: 'null' })
    })
    cell.replaceChildren(input, nullButton)
    input.focus()
    input.select()
  }

  private resolveFirstRowVisible(): void {
    const waiters = this.firstRowVisibleWaiters.splice(0, this.firstRowVisibleWaiters.length)
    for (const waiter of waiters) waiter()
  }

  private checkFirstRowVisible(): void {
    if (this.firstRowVisibleWaiters.length === 0) return
    for (const row of this.rows.values()) {
      if (row.paintedStatus === 'ready') {
        this.resolveFirstRowVisible()
        return
      }
    }
  }

  // ----- keyboard / roving focus ---------------------------------------------

  private onKeyDown(event: KeyboardEvent): void {
    const target = event.target
    if (!(target instanceof Element) || isNativeControl(target)) return
    // Row navigation only when the keydown originates in a BODY row (the
    // header's buttons keep native keyboard semantics).
    const rowElement = target.closest<HTMLElement>('[data-row-index]')
    if (rowElement === null || !rowElement.dataset.rowIndex) return
    const rowIndex = Number(rowElement.dataset.rowIndex)
    const cellElement = target.closest<HTMLElement>('[data-col-index]')
    const columnIndex =
      cellElement !== null && cellElement.dataset.colIndex !== undefined
        ? Number(cellElement.dataset.colIndex)
        : null
    const total = this.model.totalRows ?? 0
    const lastColumn = (this.model.schema?.length ?? 1) - 1
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        this.moveFocus(Math.min(rowIndex + 1, total - 1), columnIndex)
        return
      case 'ArrowUp':
        event.preventDefault()
        this.moveFocus(Math.max(rowIndex - 1, 0), columnIndex)
        return
      case 'ArrowRight':
        event.preventDefault()
        this.moveFocus(rowIndex, columnIndex === null ? 0 : Math.min(columnIndex + 1, lastColumn))
        return
      case 'ArrowLeft':
        event.preventDefault()
        this.moveFocus(rowIndex, columnIndex === null ? lastColumn : Math.max(columnIndex - 1, 0))
        return
      case 'Home':
        event.preventDefault()
        this.moveFocus(event.ctrlKey || event.metaKey ? 0 : rowIndex, 0)
        return
      case 'End':
        event.preventDefault()
        this.moveFocus(event.ctrlKey || event.metaKey ? total - 1 : rowIndex, lastColumn)
        return
      default:
        return
    }
  }

  /** The effective roving tab stop: the focused row while rendered, else the first rendered row. */
  private tabbableRowIndex(): number | null {
    if (this.focusedRowIndex !== null && this.rows.has(this.focusedRowIndex)) {
      return this.focusedRowIndex
    }
    const first = [...this.rows.keys()].sort((a, b) => a - b)[0]
    return first ?? null
  }

  private applyRovingTabIndex(): void {
    const tabbable = this.tabbableRowIndex()
    for (const [index, row] of this.rows) {
      row.element.tabIndex = index === tabbable ? 0 : -1
    }
  }

  /** Roving-focus move (web app `moveGridFocus` twin); parks until rendered. */
  private moveFocus(rowIndex: number, columnIndex: number | null): void {
    const total = this.model.totalRows ?? 0
    if (total === 0) return
    const targetRow = Math.max(0, Math.min(rowIndex, total - 1))
    const schemaLength = this.model.schema?.length ?? 0
    const targetColumn =
      columnIndex === null || schemaLength === 0
        ? null
        : Math.max(0, Math.min(columnIndex, schemaLength - 1))
    this.focusedRowIndex = targetRow
    this.applyRovingTabIndex()
    const row = this.rows.get(targetRow)
    if (row === undefined) {
      // `auto`-style: scroll only when the target is outside the viewport.
      this.scrollRowTo(targetRow)
      this.parkedFocus = { rowIndex: targetRow, columnIndex: targetColumn }
      this.scheduleRender()
      return
    }
    this.focusInRow(row.element, targetColumn)
  }

  private focusInRow(rowElement: HTMLElement, columnIndex: number | null): void {
    let target: HTMLElement = rowElement
    if (columnIndex !== null) {
      const cells = rowElement.querySelectorAll<HTMLElement>('[data-col-index]')
      target = cells[columnIndex] ?? rowElement
    }
    target.focus()
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  /** Completes a parked focus move once the target row exists (AR-W2 twin). */
  private completeParkedFocus(): void {
    const parked = this.parkedFocus
    if (parked === null) return
    const total = this.model.totalRows ?? 0
    if (parked.rowIndex >= total) {
      this.parkedFocus = null // a superseded positional request must not steal focus
      return
    }
    const row = this.rows.get(parked.rowIndex)
    if (row === undefined) return
    this.parkedFocus = null
    this.focusInRow(row.element, parked.columnIndex)
  }

  /** Minimal scroll so the row is visible just below the sticky header. */
  private scrollRowTo(rowIndex: number): void {
    const viewport = this.viewport
    if (viewport === null) return
    const top = rowIndex * GRID_ROW_HEIGHT_PX
    const bottom = top + GRID_ROW_HEIGHT_PX
    if (top < viewport.scrollTop) {
      viewport.scrollTop = top
    } else if (bottom > viewport.scrollTop + viewport.clientHeight) {
      viewport.scrollTop = bottom - viewport.clientHeight
    }
  }
}
