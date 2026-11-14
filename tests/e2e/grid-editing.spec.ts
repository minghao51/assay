import { expect, test } from './support/fixture'
import type { Page } from '@playwright/test'
import { readGridStats } from './support/grid-stats'
import { activateTask, openCustomersFixture, openFilterBar } from './support/fixtures'
import { cell, openEditor, row, waitForReadyRow } from './support/grid'

// Task m4-3 proof (handoff §6): real cell editing + row ops + dirty state over
// the m4-1 domain overlay and the m4-2 engine surface. The app under test is
// the real composition root served at '/' by the first webServer in
// playwright.config.ts, opened on the committed golden fixture
// customers.parquet (5 rows; income of customer 3 is NULL):
//
//   customer_id country income     signup_date
//   1           SG      52000      2025-01-04
//   2           US      61000      2025-01-11
//   3           SG      NULL       2025-02-02
//   4           DE      48000      2025-02-19
//   5           US      75000      2025-03-01
//
// Requested pins (done-when):
//   1. edit → visibility → undo → clean (an edited cell shows the edit, is
//      marked dirty, and after undo shows the base value and is clean again);
//   2. typed-constraint rejections are readable and leave state unchanged;
//      a rejection the engine (not the client) makes — a bad DATE, an
//      out-of-range BIGINT — is refused *before activation* (the engine's
//      pre-commit value check), so nothing rolls back and the grid never
//      leaves the previous view (fix rounds m4-3/R1-C). rd-3c: the durable
//      alert lives in the Change-task Editing section, so the shell reveals
//      it automatically from any task — asserted here from the Explore
//      default, with a negative control that an applied edit and the
//      Enter-unchanged cancel never switch tasks;
//   3. NULL is a distinct affordance and a distinct rendering (never an empty
//      string, an unset editor, or an error);
//   4. insert/delete row journeys;
//   5. temporal cells open with a human-readable, engine-round-trippable
//      draft, so double-click + Enter unchanged cannot brick the grid (fix
//      round);
//   6. rapid epoch changes never leave a stale/in-flight window rendered.
//
// Privacy (ADR 0025): the picked file name and the opaque row anchors are
// never rendered; values are asserted as text only.

test.beforeEach(async ({ page }) => {
  // Take the hidden-<input type="file"> fallback (m1-5 pattern).
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    } catch {
      // Non-configurable global would be a Chromium change; fail loudly later.
    }
  })
  // rd-3c: record every programmatic `scrollIntoView` of a SECTION element.
  // At this desktop size the tool pane fits Change's three sections, so "the
  // message is in the viewport" alone cannot distinguish a reveal that
  // scrolled from one that did not (see the note in the engine-rejection
  // test); the recorded request can. Test-side instrumentation only — no
  // production hook.
  await page.addInitScript(() => {
    const recorded = window as unknown as {
      __assaySectionScrolls?: { id: string; block: string | null }[]
    }
    recorded.__assaySectionScrolls = []
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (
      this: Element,
      arg?: boolean | ScrollIntoViewOptions,
    ): void {
      recorded.__assaySectionScrolls?.push({
        id: this.id,
        block: typeof arg === 'object' && arg !== null ? (arg.block ?? null) : null,
      })
      if (arg === undefined) original.call(this)
      else original.call(this, arg)
    }
  })
})

/**
 * Ids (customer_id, column 0) of every READY row, in row order.
 *
 * ug-11: the row's first child is its 1-based row-number gutter, so schema
 * column 0 is `:nth-child(2)` (income, column 2, is `:nth-child(4)`).
 */
function expectCustomerOrder(page: Page, ids: string[]): Promise<void> {
  return expect(
    page.locator(
      '[data-testid="grid-row"][data-status="ready"] [data-testid="grid-cell"]:nth-child(2)',
    ),
  ).toHaveText(ids)
}

test('edit → visibility → undo → redo → undo → clean (the exit pin)', async ({ page }) => {
  await openCustomersFixture(page)
  // rd-3b: the History panel is a Change-task surface.
  await activateTask(page, 'change')
  const income = cell(page, 0, 2)
  await expect(income).toHaveText('52000')
  await expect(income).toHaveAttribute('data-dirty', 'false')

  // Commit an edit: it becomes visible immediately and the cell is dirty.
  await openEditor(page, 0, 2)
  const editor = page.getByTestId('grid-editor-input')
  await expect(editor).toHaveValue('52000')
  await editor.fill('99999')
  await editor.press('Enter')
  await expect(page.getByTestId('grid-cell-editor')).toHaveCount(0)
  await expect(income).toHaveText('99999')
  await expect(income).toHaveAttribute('data-dirty', 'true')
  await expect(row(page, 0)).toHaveAttribute('data-dirty', 'true')
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5') // a cell edit is not a row change

  // Undo → the base value stands again and the grid is clean (the pure fold
  // of the empty prefix is the initial state).
  await page.getByTestId('history-undo').click()
  await expect(income).toHaveText('52000')
  await expect(income).toHaveAttribute('data-dirty', 'false')
  await expect(row(page, 0)).toHaveAttribute('data-dirty', 'false')
  await expect(page.getByTestId('history-undo')).toBeDisabled()

  // Redo re-applies the logged op; undo again returns to clean.
  await page.getByTestId('history-redo').click()
  await expect(income).toHaveText('99999')
  await expect(income).toHaveAttribute('data-dirty', 'true')
  await page.getByTestId('history-undo').click()
  await expect(income).toHaveText('52000')
  await expect(income).toHaveAttribute('data-dirty', 'false')
  await expect(page.getByTestId('history-redo')).toBeEnabled()
})

test('typed constraints: a non-numeric input is rejected readably and leaves state unchanged', async ({
  page,
}) => {
  await openCustomersFixture(page)

  await openEditor(page, 0, 2) // income is BIGINT
  const editor = page.getByTestId('grid-editor-input')
  await editor.fill('abc')
  await editor.press('Enter')

  // Readable rejection, editor stays open, overlay untouched (the cell's
  // data-dirty stays false — the draft is not committed; the gridcell text
  // is currently the editor's own content, so the base value is asserted
  // after cancelling).
  await expect(page.getByTestId('grid-edit-error')).toBeVisible()
  await expect(page.getByTestId('grid-edit-error')).toContainText('not a number')
  await expect(page.getByTestId('grid-cell-editor')).toBeVisible()
  await expect(cell(page, 0, 2)).toHaveAttribute('data-dirty', 'false')

  // Escape cancels the editor; nothing changed and the alert cleared.
  await editor.press('Escape')
  await expect(page.getByTestId('grid-cell-editor')).toHaveCount(0)
  await expect(cell(page, 0, 2)).toHaveText('52000')
  await expect(cell(page, 0, 2)).toHaveAttribute('data-dirty', 'false')

  // A wide numeric accepts exact 64-bit text (the domain `text` kind).
  await openEditor(page, 0, 2)
  await page.getByTestId('grid-editor-input').fill('9007199254740993')
  await page.getByTestId('grid-editor-input').press('Enter')
  await expect(cell(page, 0, 2)).toHaveText('9007199254740993')

  // m4-4 carry-over: re-committing an unchanged draft is a cancel, not a
  // spurious no-op step — the editor closes, the value is untouched, and no
  // alert appears (the no-op surface is pinned in column-ops.spec.ts via a
  // cast-identity op instead).
  await openEditor(page, 0, 2)
  await page.getByTestId('grid-editor-input').fill('9007199254740993')
  await page.getByTestId('grid-editor-input').press('Enter')
  await expect(page.getByTestId('grid-cell-editor')).toHaveCount(0)
  await expect(cell(page, 0, 2)).toHaveText('9007199254740993')
  await expect(page.getByTestId('grid-edit-error')).toHaveCount(0)
})

test('engine rejection: an unconvertible typed value is refused before activation, so nothing rolls back', async ({
  page,
}) => {
  await openCustomersFixture(page)

  // rd-3c: the pane starts in Explore — the Editing section is `display: none`
  // — and is scrolled away from where that section will appear, so "the
  // message is on screen" below cannot be true by accident. (The tool pane is
  // its own scroll container at ≥1024px; scrolled to the bottom it is looking
  // at the last Explore section, not at Editing.)
  const pane = page.locator('.workbench-tools')
  await pane.evaluate((element) => {
    element.scrollTo({ top: element.scrollHeight })
  })
  expect(await pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expect(page.getByTestId('task-explore')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('section-toggle-editing')).not.toBeInViewport()

  // (Sensitivity note for the viewport assertion further down: measured at this
  // revision and size, once Explore's sections are hidden the pane's
  // `scrollHeight` collapses to its `clientHeight` (655px), so the Editing
  // section would sit inside the pane even if the reveal never scrolled. The
  // user-visible claim is still asserted; the fact that distinguishes a genuine
  // scroll is the recorded request below.)

  // Double-click the DATE column (signup_date, column 3). The client cannot
  // know the draft is invalid (temporal values defer to the engine), so the
  // engine's own refusal must surface readably — and, since R1-C, before
  // anything is activated. The probe is a quote-laden, SQL-shaped value — the
  // plain text field accepts it, and it is the most dangerous thing the alert
  // could echo.
  const hostileDraft = "not-a-date'; DROP TABLE x --"
  await openEditor(page, 0, 3)
  const editor = page.getByTestId('grid-editor-input')
  await expect(editor).toHaveValue('2025-01-04')
  await editor.fill(hostileDraft)
  // The user is editing inside the grid when the engine rejects the value.
  await expect(editor).toBeFocused()
  await editor.press('Enter')

  // R1-C: the refusal is deterministic and happens **before anything is
  // activated**. The app asks the engine's existing `overlayCastCheck` whether
  // the edited column's own effective type rejects the staged value, so the bad
  // overlay never reaches the view: there is no failed window, no retryable `!`
  // cell and no rollback. The alert carries the existing rejection framing and
  // the value-free class, never the raw engine text or the typed value.
  //
  // rd-3c: the durable alert lives in the Editing section (a Change-task
  // surface), so the shell reveals it automatically — the pane switches to
  // Change and the Editing section is expanded WITHOUT any task activation in
  // this test, and without moving focus out of the grid.
  await expect(page.getByTestId('task-change')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('task-explore')).toHaveAttribute('aria-checked', 'false')
  await expect(page.locator('.workbench-tools')).toHaveAttribute('data-task', 'change')
  await expect(page.getByTestId('section-toggle-editing')).toHaveAttribute('aria-expanded', 'true')
  // ... and the message is actually ON SCREEN, not merely un-hidden: a
  // programmatic reveal is not a link, so the seam asks for the scroll
  // explicitly and the Editing section lands inside the pane's viewport. This
  // starts from the Explore default, where the section was `display: none`.
  await expect(page.getByTestId('section-toggle-editing')).toBeInViewport()
  // The reveal actually asked the browser to scroll the SECTION element (not an
  // inner node), so `.workbench-section { scroll-margin-top }` keeps the pinned
  // nav off the heading — and it asked exactly once, for this error only.
  const sectionScrolls = await page.evaluate(
    () =>
      (window as unknown as { __assaySectionScrolls?: { id: string; block: string | null }[] })
        .__assaySectionScrolls ?? [],
  )
  expect(sectionScrolls.filter((call) => call.id === 'section-editing')).toEqual([
    { id: 'section-editing', block: 'start' },
  ])
  const alert = page.getByTestId('edit-error')
  await expect(alert).toBeVisible()
  await expect(alert).toBeInViewport()
  // The observed exact text: the pre-commit value refusal reuses the existing
  // rejection framing, so nothing new is said about the failure (and nothing
  // about the value).
  await expect(alert).toHaveText(
    "The engine rejected this edit: the column's type rejected the value. " +
      'The previous view is unchanged.',
  )
  await expect(alert).not.toContainText('_setThrew')
  await expect(alert).not.toContainText('not-a-date')
  await expect(alert).not.toContainText("'; DROP TABLE x --")

  // The client-side rejection surface is untouched: this refusal came from the
  // engine path, so the grid footer's own `grid-edit-error` stays empty.
  await expect(page.getByTestId('grid-edit-error')).toHaveCount(0)

  // q-3: the engine rejection is ALSO announced through the single polite
  // live region, and the announcement is the same value-free class (the raw
  // engine text and the hostile typed draft never leak, ADR 0025).
  const live = page.getByTestId('edit-live-region')
  await expect(live).toHaveText(
    "The engine rejected this edit: the column's type rejected the value. " +
      'The previous view is unchanged.',
  )
  await expect(live).not.toContainText('not-a-date')
  await expect(live).not.toContainText("'; DROP TABLE x --")

  // The reveal is scroll/visibility only: it carries no focus call and no DOM
  // move, so it can never hand focus to the pane (the commit's own
  // editor-unmount path is untouched by rd-3c).
  const focusAfterReveal = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null
    return {
      tagName: active === null ? null : active.tagName,
      testId: active === null ? null : active.getAttribute('data-testid'),
      inToolPane: active !== null && active.closest('.workbench-tools') !== null,
    }
  })
  // Contract: `document.activeElement` is NOT inside the tool pane. Observed
  // honestly: the commit closes the cell editor and focus falls to <body>
  // (pre-existing grid behaviour, unchanged by rd-3c) — the reveal itself
  // focuses nothing, so the task radio and the Editing toggle never take it.
  expect(
    focusAfterReveal.inToolPane,
    `the reveal must not move focus into the pane (focused: ${String(focusAfterReveal.tagName)}/${String(focusAfterReveal.testId)})`,
  ).toBe(false)

  // Refused before activation, so the view was never replaced: every row is
  // still ready, there is no failed window to retry (no `!` cells), the staged
  // operation count did not grow, and the edit is not in the history.
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  await expect(page.locator('[data-testid="grid-row"][data-status="ready"]')).toHaveCount(5)
  await expect(page.locator('[data-testid="grid-row"][data-status="loading"]')).toHaveCount(0)
  await expect(page.locator('[data-testid="grid-row"][data-status="error"]')).toHaveCount(0)
  await expect(page.getByTestId('grid-retry')).toHaveCount(0)
  await expect(cell(page, 0, 3)).toHaveAttribute('data-dirty', 'false')
  await expect(cell(page, 0, 3)).toHaveText('2025-01-04')
  await expect(page.getByTestId('pending-changes')).toHaveText('No pending changes.')
  await expect(page.getByTestId('history-list')).toHaveCount(0)
  await expect(page.getByTestId('history-undo')).toBeDisabled()
  await expect(page.getByTestId('view-error')).toHaveCount(0)
  // The hostile draft is never echoed into the rendered page (ADR 0025).
  await expect(page.locator('body')).not.toContainText(hostileDraft)

  // A subsequent valid edit still works and clears the alert (recovery).
  await openEditor(page, 0, 2)
  await page.getByTestId('grid-editor-input').fill('12345')
  await page.getByTestId('grid-editor-input').press('Enter')
  await expect(cell(page, 0, 2)).toHaveText('12345')
  await expect(page.getByTestId('edit-error')).toHaveCount(0)
  await expect(page.getByTestId('pending-changes')).toHaveText('1 pending change: 1 cell edit.')
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  await expect(page.getByTestId('grid-retry')).toHaveCount(0)
})

test('a successful edit and an Enter-unchanged no-op never switch tasks', async ({ page }) => {
  // rd-3c negative control: the reveal fires on the transition to a durable
  // edit error ONLY — an applied edit and the unchanged-draft cancel (which
  // never reaches the app at all) leave the user in Explore.
  await openCustomersFixture(page)
  await expect(page.getByTestId('task-explore')).toHaveAttribute('aria-checked', 'true')

  // 1. A successful typed edit: no durable error, no switch.
  await openEditor(page, 0, 2)
  await page.getByTestId('grid-editor-input').fill('12345')
  await page.getByTestId('grid-editor-input').press('Enter')
  await expect(cell(page, 0, 2)).toHaveText('12345')
  await expect(page.getByTestId('edit-error')).toHaveCount(0)
  await expect(page.getByTestId('task-explore')).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('.workbench-tools')).toHaveAttribute('data-task', 'explore')

  // 2. Enter unchanged on a temporal cell is a cancel, not an op: still Explore.
  await openEditor(page, 0, 3)
  await page.getByTestId('grid-editor-input').press('Enter')
  await expect(page.getByTestId('grid-cell-editor')).toHaveCount(0)
  await expect(page.getByTestId('edit-error')).toHaveCount(0)
  await expect(page.getByTestId('task-explore')).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('.workbench-tools')).toHaveAttribute('data-task', 'explore')
})

test('temporal editing: a human-readable draft round-trips, and Enter-unchanged does not brick', async ({
  page,
}) => {
  await openCustomersFixture(page)

  // The editor opens with `2025-01-04` (the engine's epoch-ms value formatted
  // honestly), not the raw `1735948800000` that would fail `CAST(... AS DATE)`.
  await openEditor(page, 0, 3)
  const editor = page.getByTestId('grid-editor-input')
  await expect(editor).toHaveValue('2025-01-04')

  // Enter unchanged commits the same date as engine-parseable text: the cast
  // succeeds, the editor closes, and the grid stays healthy (no alert, no
  // perpetual loading).
  await editor.press('Enter')
  await expect(page.getByTestId('grid-cell-editor')).toHaveCount(0)
  await expect(page.locator('[data-testid="grid-row"][data-status="ready"]')).toHaveCount(5)
  await expect(page.locator('[data-testid="grid-row"][data-status="loading"]')).toHaveCount(0)
  await expect(page.getByTestId('edit-error')).toHaveCount(0)
  // wf-01: the DATE cell now renders its calendar day instead of the engine's
  // epoch representation — a ready cell, not an error.
  await expect(cell(page, 0, 3)).toHaveText('2025-01-04')
})

test('NULL is a distinct affordance and rendering, never an empty string', async ({ page }) => {
  await openCustomersFixture(page)
  // rd-3b: the Undo button lives in the History panel (Change).
  await activateTask(page, 'change')
  const country = cell(page, 0, 1)

  // Set NULL through the dedicated button.
  await openEditor(page, 0, 1)
  await page.getByTestId('grid-editor-null').click()
  await expect(page.getByTestId('grid-cell-editor')).toHaveCount(0)
  await expect(country).toHaveAttribute('data-null', 'true')
  await expect(country.getByTestId('grid-cell-null')).toHaveText('NULL')
  await expect(country).toHaveAttribute('data-dirty', 'true')
  await expect(country).toHaveText('NULL')

  // Undo → the base string is back and the cell is not NULL.
  await page.getByTestId('history-undo').click()
  await expect(country).toHaveText('SG')
  await expect(country).not.toHaveAttribute('data-null', 'true')
  await expect(country.getByTestId('grid-cell-null')).toHaveCount(0)

  // An EMPTY STRING is a real value: it renders as an empty cell with no NULL
  // marker — visually and structurally distinct from NULL.
  await openEditor(page, 0, 1)
  await page.getByTestId('grid-editor-input').fill('')
  await page.getByTestId('grid-editor-input').press('Enter')
  await expect(country).toHaveText('')
  await expect(country.getByTestId('grid-cell-null')).toHaveCount(0)
  await expect(country).not.toHaveAttribute('data-null', 'true')
  await expect(country).toHaveAttribute('data-dirty', 'true')

  // Escape on a fresh editor leaves the value untouched (cancel ≠ commit).
  await openEditor(page, 0, 1)
  await page.getByTestId('grid-editor-input').fill('XX')
  await page.getByTestId('grid-editor-input').press('Escape')
  await expect(country).toHaveText('')
})

test('insert and delete row journeys are reversible', async ({ page }) => {
  await openCustomersFixture(page)
  // rd-3b: Insert row and Undo live in the Change task.
  await activateTask(page, 'change')

  // Insert: a new overlay row appears at the end (v1 placement), all NULL,
  // marked inserted.
  await page.getByTestId('edit-insert-row').click()
  await expect(page.getByTestId('grid-total-rows')).toHaveText('6')
  const insertedRow = row(page, 5)
  await expect(insertedRow).toHaveAttribute('data-inserted', 'true')
  await expect(insertedRow).toHaveAttribute('data-dirty', 'true')
  await expect(insertedRow.getByTestId('grid-cell').nth(0)).toHaveText('NULL')
  await expect(insertedRow.getByTestId('grid-cell').nth(1)).toHaveText('NULL')

  // The inserted row is editable like any other.
  await openEditor(page, 5, 1)
  await page.getByTestId('grid-editor-input').fill('ZZ')
  await page.getByTestId('grid-editor-input').press('Enter')
  await expect(row(page, 5).getByTestId('grid-cell').nth(1)).toHaveText('ZZ')

  // Delete another row: it leaves the effective view immediately.
  await row(page, 0).getByTestId('grid-row-delete').click()
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  await expectCustomerOrder(page, ['2', '3', '4', '5', 'NULL']) // id 1 gone; inserted row has NULL id

  // Undo the delete: the base row returns, in place.
  await page.getByTestId('history-undo').click()
  await expect(page.getByTestId('grid-total-rows')).toHaveText('6')
  await expectCustomerOrder(page, ['1', '2', '3', '4', '5', 'NULL'])

  // Undo the edit, then the insert → fully clean again.
  await page.getByTestId('history-undo').click() // undo the ZZ edit
  await expect(row(page, 5).getByTestId('grid-cell').nth(1)).toHaveText('NULL')
  await page.getByTestId('history-undo').click() // undo the insert
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  await expectCustomerOrder(page, ['1', '2', '3', '4', '5'])
  await expect(row(page, 0)).toHaveAttribute('data-dirty', 'false')
  await expect(page.getByTestId('history-undo')).toBeDisabled()
})

test('inspector freshness under edits: re-reads the same logical row, never a stale snapshot', async ({
  page,
}) => {
  await openCustomersFixture(page)

  // Open the inspector for row 0 (m3-3 click gesture), then edit a cell of the
  // very row it is inspecting. The pinned m4-3 policy: a value-only overlay
  // change re-reads the same logical row (the old snapshot never renders as
  // current); a later delete closes the panel (a structural shift).
  await waitForReadyRow(page, 0)
  await row(page, 0).click()
  const panel = page.getByTestId('record-inspector')
  await expect(panel).toBeVisible()
  const countryValue = panel.locator(
    "li[data-node-key='country'] > span.record-leaf > span[data-testid='record-node-value']",
  )
  await expect(countryValue).toHaveText('"SG"')

  await openEditor(page, 0, 1)
  await page.getByTestId('grid-editor-input').fill('ZZ')
  await page.getByTestId('grid-editor-input').press('Enter')
  // Reloaded from the fresh epoch — the edited value, not the stale 'SG'.
  await expect(page.getByTestId('record-inspector')).toBeVisible()
  await expect(countryValue).toHaveText('"ZZ"')

  // Deleting the inspected row changes the row count → the inspector closes.
  await waitForReadyRow(page, 0)
  await row(page, 0).getByTestId('grid-row-delete').click()
  await expect(page.getByTestId('record-inspector')).toHaveCount(0)
  await expect(page.getByTestId('grid-total-rows')).toHaveText('4')
})

test('rapid epoch changes settle consistently — no stale/in-flight window renders', async ({
  page,
}) => {
  await openCustomersFixture(page)

  // Interleave sort and filter changes without waiting between them: each
  // accepted change starts a fresh data epoch and the generation guard must
  // discard any page still in flight from the previous one. The final state
  // must reflect ONLY the last query, with no lingering loading placeholders.
  await page.locator('[data-testid="grid-sort-toggle"][data-col-name="income"]').click()
  await openFilterBar(page)
  // ug-18: the per-column SQL-fragment inputs live behind the `SQL predicates`
  // disclosure; open it to drive the same fragment path.
  const sqlDisclosure = page.getByTestId('filter-sql-disclosure')
  if ((await sqlDisclosure.getAttribute('open')) === null) {
    await sqlDisclosure.locator('summary').click()
  }
  await page.locator('[data-testid="filter-input"][data-col-name="country"]').fill("= 'US'")
  await page.locator('[data-testid="filter-apply"][data-col-name="country"]').click()
  await page.locator('[data-testid="grid-sort-toggle"][data-col-name="income"]').click() // desc

  await expect(page.getByTestId('grid-total-rows')).toHaveText('2')
  await expectCustomerOrder(page, ['5', '2']) // US by income desc
  await expect(
    page.locator(
      '[data-testid="grid-row"][data-status="ready"] [data-testid="grid-cell"]:nth-child(4)',
    ),
  ).toHaveText(['75000', '61000'])
  // The settled grid has no loading/error rows in the visible window and the
  // per-epoch fetch accounting is bounded (one window, never a rescan storm).
  await expect(page.locator('[data-testid="grid-row"][data-status="loading"]')).toHaveCount(0)
  const stats = await readGridStats(page)
  expect(stats.fetches).toBeGreaterThanOrEqual(1)
  expect(stats.requested).toBeLessThanOrEqual(10)

  // Clearing everything returns to natural order with all rows ready.
  await page.locator('[data-testid="filter-active-remove"][data-col-name="country"]').click()
  await page.locator('[data-testid="grid-sort-toggle"][data-col-name="income"]').click() // clear
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  await expectCustomerOrder(page, ['1', '2', '3', '4', '5'])
  await expect(page.locator('[data-testid="grid-row"][data-status="loading"]')).toHaveCount(0)
})

// AR-W1 (critical): a cell editor must not survive a data-epoch shift. Before
// the fix the editor held only `rowIndex`/`columnIndex` and resolved the
// logical row id at commit time, so an accepted sort/filter that renumbered
// rows redirected the commit to whatever record moved into the stale
// position — a wrong-row write. This drill is the reproduction: edit →
// invalid draft (the editor stays open) → epoch shift → corrected commit must
// land on the row the user began editing, never on the row that shifted into
// the old index.
//
test('AR-W1: a rejected edit cannot be redirected by an epoch shift', async ({ page }) => {
  await openCustomersFixture(page)

  // Begin editing customer 1 (row 0, income 52000) and produce a draft the
  // client rejects, so the editor deliberately stays open (m4-3 UX).
  await openEditor(page, 0, 2)
  const editor = page.getByTestId('grid-editor-input')
  await expect(editor).toHaveValue('52000')
  await editor.fill('not-a-number')
  await editor.press('Enter')
  await expect(page.getByTestId('grid-edit-error')).toBeVisible()
  await expect(page.getByTestId('grid-cell-editor')).toBeVisible()

  // Sort by income ascending: rows renumber. DuckDB default NULLS LAST puts
  // customer 4 (48000) at row 0 and moves customer 1 to row 1.
  await page.locator('[data-testid="grid-sort-toggle"][data-col-name="income"]').click()
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  await expectCustomerOrder(page, ['4', '1', '2', '5', '3'])

  // The editor follows the logical row captured when it opened: after the
  // reload it is visible again (on the pre-fix code it stayed on the stale
  // position, row 0 = customer 4).
  await expect(page.getByTestId('grid-cell-editor')).toBeVisible()

  // Correct the draft and commit.
  await page.getByTestId('grid-editor-input').fill('11111')
  await page.getByTestId('grid-editor-input').press('Enter')
  await expect(page.getByTestId('grid-cell-editor')).toHaveCount(0)

  // The edit changed the active sort key, so clear the sort and assert in
  // natural order: the value landed on customer 1 (base row 0), never on the
  // row that shifted into the stale position (customer 4, base row 3).
  const sortToggle = page.locator('[data-testid="grid-sort-toggle"][data-col-name="income"]')
  await sortToggle.click() // asc → desc
  await sortToggle.click() // desc → cleared
  await expectCustomerOrder(page, ['1', '2', '3', '4', '5'])
  await expect(cell(page, 0, 2)).toHaveText('11111')
  await expect(cell(page, 3, 2)).toHaveText('48000')
})
