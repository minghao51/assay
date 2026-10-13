// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Harness-testable grid a11y audit (ptv1-4). The webview page is the only
 * place that can inspect its own DOM (the extension host cannot reach into a
 * webview), so the structural keyboard/a11y checks run HERE — against the
 * real mounted grid in the real VS Code webview — and report value-free
 * results to the host (the spike asserts them directly; the e2e asserts the
 * posted flag). This is "a11y checks to the extent harness-testable": DOM
 * structure and focus behavior, not a full axe run.
 *
 * What is asserted (each check value-free):
 *   grid-role          — the viewport carries role="grid" with an accessible name
 *   rowcount-attr      — aria-rowcount equals totalRows + 1 (header row)
 *   colcount-attr      — aria-colcount equals the schema column count
 *   columnheaders      — every column has a columnheader with a visible name
 *                        and a labeled sort toggle (aria-label + data-sort)
 *   roving-tabindex    — exactly one rendered body row is a tab stop
 *                        (tabindex="0"); every gridcell is tabindex="-1"
 *   bounded-dom        — the rendered row count stays within viewport +
 *                        overscan bounds (the virtualization proof: DOM is
 *                        bounded regardless of dataset size)
 *   cells-text-only    — every gridcell renders text (or the one NULL marker
 *                        span): no element children beyond that, no script/
 *                        style descendants (the textContent-only rule)
 *   buttons-named      — every button in the grid has an accessible name
 *   focus-style        — the injected stylesheet carries visible-focus rules
 *                        for rows and cells
 *   toolbar-labeled    — (when mounted) the filter controls carry labels
 */
export interface GridAuditCheck {
  readonly name: string
  readonly ok: boolean
  /** Value-free detail (counts only — never cell values). */
  readonly detail?: string
}

export interface GridDomAudit {
  readonly ok: boolean
  readonly checks: readonly GridAuditCheck[]
}

export interface GridAuditExpectations {
  /** The model's total row count (aria-rowcount = this + 1). */
  readonly totalRows: number
  /** The schema's column count (aria-colcount). */
  readonly columnCount: number
  /** Rendered-row bound: viewport rows + 2× overscan + slack. Default 64. */
  readonly maxRenderedRows?: number
  /** Whether the filter toolbar is expected. Default true. */
  readonly expectToolbar?: boolean
}

function check(name: string, ok: boolean, detail?: string): GridAuditCheck {
  return { name, ok, ...(detail === undefined ? {} : { detail }) }
}

/** Accessible name of an element: aria-label, else trimmed text content. */
function accessibleName(element: Element): string {
  const label = element.getAttribute('aria-label')
  if (label !== null && label.trim() !== '') return label
  return (element.textContent ?? '').trim()
}

/** Audit the mounted grid's DOM structure (see module doc for the checklist). */
export function auditGridDom(root: HTMLElement, expectations: GridAuditExpectations): GridDomAudit {
  const checks: GridAuditCheck[] = []
  const viewport = root.querySelector('[role="grid"]')
  checks.push(check('grid-role', viewport !== null))
  if (viewport === null) return { ok: false, checks }

  const ariaLabel = viewport.getAttribute('aria-label') ?? ''
  checks.push(check('grid-role', ariaLabel.trim() !== '', 'aria-label empty'))

  const ariaRowcount = viewport.getAttribute('aria-rowcount')
  checks.push(
    check(
      'rowcount-attr',
      ariaRowcount === String(expectations.totalRows + 1),
      `aria-rowcount=${String(ariaRowcount)}`,
    ),
  )
  const ariaColcount = viewport.getAttribute('aria-colcount')
  checks.push(
    check(
      'colcount-attr',
      ariaColcount === String(expectations.columnCount),
      `aria-colcount=${String(ariaColcount)}`,
    ),
  )

  const headers = [...viewport.querySelectorAll('[role="columnheader"]')]
  const toggles = [...viewport.querySelectorAll('button[data-sort]')]
  const headersOk =
    headers.length === expectations.columnCount &&
    headers.every((header) => (header.textContent ?? '').trim().length > 0) &&
    toggles.length === expectations.columnCount &&
    toggles.every((toggle) => accessibleName(toggle) !== '') &&
    toggles.every((toggle) =>
      ['asc', 'desc', 'none'].includes(toggle.getAttribute('data-sort') ?? ''),
    )
  checks.push(
    check(
      'columnheaders',
      headersOk,
      `headers=${String(headers.length)} toggles=${String(toggles.length)}`,
    ),
  )

  const bodyRows = [...viewport.querySelectorAll('[role="row"][data-row-index]')]
  const tabbable = bodyRows.filter((row) => row.getAttribute('tabindex') === '0')
  const cells = [...viewport.querySelectorAll<HTMLElement>('[role="gridcell"]')]
  const cellsRoving = cells.every((cell) => cell.getAttribute('tabindex') === '-1')
  checks.push(
    check(
      'roving-tabindex',
      (bodyRows.length === 0 && expectations.totalRows === 0) ||
        (tabbable.length === 1 && cellsRoving),
      `rows=${String(bodyRows.length)} tabbable=${String(tabbable.length)} cells=${String(cells.length)}`,
    ),
  )

  const maxRows = expectations.maxRenderedRows ?? 64
  checks.push(
    check(
      'bounded-dom',
      bodyRows.length <= maxRows,
      `rendered=${String(bodyRows.length)} bound=${String(maxRows)}`,
    ),
  )

  const textOnly = cells.every((cell) => {
    if (cell.querySelector('script, style') !== null) return false
    return (
      cell.childElementCount === 0 || (cell.childElementCount === 1 && cell.dataset.null === 'true')
    )
  })
  checks.push(check('cells-text-only', textOnly))

  const buttons = [...viewport.querySelectorAll('button')]
  checks.push(
    check(
      'buttons-named',
      buttons.every((button) => accessibleName(button) !== ''),
      `buttons=${String(buttons.length)}`,
    ),
  )

  const styleElement = document.getElementById('assay-grid-style')
  const styleText = styleElement?.textContent ?? ''
  checks.push(
    check(
      'focus-style',
      styleText.includes('.assay-grid-row:focus') && styleText.includes('.assay-grid-cell:focus'),
    ),
  )

  if (expectations.expectToolbar !== false) {
    const toolbar = root.querySelector('.assay-grid-toolbar')
    const select = root.querySelector('select.assay-filter-column')
    const input = root.querySelector('input.assay-filter-predicate')
    const buttons2 = [...root.querySelectorAll('.assay-grid-toolbar button')]
    const toolbarOk =
      toolbar !== null &&
      select !== null &&
      (select.getAttribute('aria-label') ?? '') !== '' &&
      input !== null &&
      (input.getAttribute('aria-label') ?? '') !== '' &&
      buttons2.length >= 2 &&
      buttons2.every((button) => accessibleName(button) !== '')
    checks.push(check('toolbar-labeled', toolbarOk))
  }

  return { ok: checks.every((entry) => entry.ok), checks }
}

export interface KeyboardProbeResult {
  /** The keyboard behavior held. */
  readonly ok: boolean
  /** Value-free detail (row/column indices only). */
  readonly detail: string
}

/**
 * Behavioral keyboard probe (spike harness): focus the grid's roving tab
 * stop, dispatch real keydown events, and verify the focus moves one row
 * down and one column right. Runs against the real DOM handlers.
 */
export function probeKeyboardNavigation(grid: {
  focusGrid(): void
  gridElement: HTMLElement
}): KeyboardProbeResult {
  grid.focusGrid()
  const startRow = document.activeElement
  if (startRow === null) return { ok: false, detail: 'no initial focus' }
  const startIndex = startRow.matches('[data-row-index]')
    ? Number((startRow as HTMLElement).dataset.rowIndex)
    : -1
  startRow.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
  )
  const afterDown = document.activeElement
  const downIndex =
    afterDown !== null && afterDown.matches('[data-row-index]')
      ? Number((afterDown as HTMLElement).dataset.rowIndex)
      : -1
  if (downIndex !== startIndex + 1) {
    return {
      ok: false,
      detail: `ArrowDown ${String(startIndex)} -> ${String(downIndex)}`,
    }
  }
  afterDown?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
  )
  const afterRight = document.activeElement
  const rightOk =
    afterRight !== null &&
    afterRight !== afterDown &&
    afterRight.matches('[role="gridcell"][data-col-index]')
  return {
    ok: rightOk,
    detail: `ArrowDown ${String(startIndex)}->${String(downIndex)} then cell=${String(rightOk)}`,
  }
}
