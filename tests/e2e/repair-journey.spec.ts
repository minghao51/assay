import { expect, test } from './support/fixture'
import type { Page } from '@playwright/test'
import { activateTask, openCustomersFixture } from './support/fixtures'
import { cell, editCell } from './support/grid'

/**
 * EW-04I — the column-repair journey on the real engine (DuckDB-WASM in the
 * worker), the real overlay SQL composer and the real publication path.
 *
 * Fixture: `customers.parquet` (5 rows) —
 *
 * ```text
 * customer_id country income signup_date
 * 1           SG      52000  2025-01-04
 * 2           US      61000  2025-01-11
 * 3           SG      NULL   2025-02-02
 * 4           DE      48000  2025-02-19
 * 5           US      75000  2025-03-01
 * ```
 *
 * What the legs prove, end to end and against the real engine:
 *
 * 1. **Counts + examples + Apply + history + undo/redo.** A mapping repair on
 *    `country` previews 5 scanned / 2 changed / 3 unchanged, shows the changed
 *    rows, applies as ONE history entry, and the grid changes in exactly the
 *    rows the preview counted — the differential check that pins the preview's
 *    predicate against the composer's actual wrap.
 * 2. **Trim (the explicit code-point set, never `String.prototype.trim()`).**
 *    A cell edited to `  sg  ` is trimmed to `sg` by the default set, and the
 *    mapping still applies to the exact `SG` rows: the passthrough is the
 *    *trimmed* value (EW-04D §1).
 * 3. **Refusal leg.** A non-text column and a dead mapping key are refused on
 *    the surface with the authored sentences; nothing is read.
 * 4. **U1 leg.** A plan that matches nothing previews 5/0/5, refuses Apply and
 *    appends no history entry.
 * 5. **U2 (stale) leg.** The app's document-level undo shortcut changes the
 *    session while the repair surface holds a preview: the preview is marked
 *    stale, Apply is refused, and no repair entry is appended.
 *
 * Privacy (ADR 0025): only schema and dataset text already on screen is
 * asserted; the picked file's name never renders (the shared open helper pins
 * it) and example rows are labelled with the anchor-free `base #n` grammar.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    } catch {
      // A non-configurable global is a Chromium change; the file-input
      // fallback below would fail loudly, which is what we want.
    }
  })
  await openCustomersFixture(page)
})

/** Reveal the editing surface (Change task) and open the repair dialog. */
async function openRepairSurface(page: Page): Promise<void> {
  await activateTask(page, 'change')
  const toggle = page.getByTestId('section-toggle-editing')
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await page.getByTestId('repair-open').click()
  await expect(page.getByTestId('repair')).toBeVisible()
  await expect(page.getByTestId('repair-scope')).toContainText('every row in the session')
}

/** Author a plan: column, optional default trim, and the mapping lines. */
async function authorPlan(
  page: Page,
  options: { readonly column: string; readonly mapping: string; readonly trim?: boolean },
): Promise<void> {
  await page.getByTestId('repair-column').selectOption(options.column)
  if (options.trim === true) {
    await page.getByTestId('repair-trim-mode').selectOption('default')
  }
  await page.getByTestId('repair-mapping').fill(options.mapping)
}

/** Read a preview: click Preview and wait for the counts to land. */
async function preview(page: Page): Promise<void> {
  await page.getByTestId('repair-preview').click()
  await expect(page.getByTestId('repair-count-affected')).toBeVisible({ timeout: 20_000 })
}

test('maps a column: complete counts, bounded examples, one history entry, undo/redo', async ({
  page,
}) => {
  await openRepairSurface(page)
  await authorPlan(page, { column: 'country', mapping: 'SG => Singapore' })

  // Nothing is applied while the plan is only a draft.
  await expect(page.getByTestId('history-empty')).toBeVisible()
  await preview(page)

  // Complete counts over the whole column (5 rows), from one engine scan.
  await expect(page.getByTestId('repair-count-scanned')).toHaveText('5')
  await expect(page.getByTestId('repair-count-affected')).toHaveText('2')
  await expect(page.getByTestId('repair-count-unaffected')).toHaveText('3')
  // The cap is stated with both numbers even when everything changed fits.
  await expect(page.getByTestId('repair-example-cap')).toHaveText('All 2 changed rows are shown.')

  // The bounded examples: anchor-free row labels + exact before/after text.
  await expect(page.getByTestId('repair-example-row')).toHaveText(['base #0', 'base #2'])
  await expect(page.getByTestId('repair-example-before')).toHaveText(['SG', 'SG'])
  await expect(page.getByTestId('repair-example-after')).toHaveText(['Singapore', 'Singapore'])

  await page.getByTestId('repair-apply').click()
  await expect(page.getByTestId('repair')).toHaveCount(0)

  // The engine applied the repair: exactly the previewed rows changed.
  await expect(cell(page, 0, 1)).toHaveText('Singapore')
  await expect(cell(page, 2, 1)).toHaveText('Singapore')
  await expect(cell(page, 1, 1)).toHaveText('US')
  await expect(cell(page, 4, 1)).toHaveText('US')
  await expect(cell(page, 3, 1)).toHaveText('DE')

  // One history entry, described by plan shape only (never a mapping entry).
  await expect(page.getByTestId('history-description')).toHaveText(
    'repair column "country" (1 mapping pairs)',
  )
  await expect(page.getByTestId('history-cursor')).toHaveText('Step 1 of 1 applied')
  await expect(page.getByTestId('pending-changes')).toContainText('1 column repair')

  // One undo step removes the whole repair (an exact refold at the cursor).
  await page.getByTestId('history-undo').click()
  await expect(page.getByTestId('history-cursor')).toHaveText('Step 0 of 1 applied')
  await expect(cell(page, 0, 1)).toHaveText('SG')
  await expect(cell(page, 2, 1)).toHaveText('SG')

  // Redo restores it: the same prefix folds to the same state.
  await page.getByTestId('history-redo').click()
  await expect(page.getByTestId('history-cursor')).toHaveText('Step 1 of 1 applied')
  await expect(cell(page, 0, 1)).toHaveText('Singapore')
})

test('trims with the explicit code-point set: the passthrough is the trimmed value', async ({
  page,
}) => {
  // A cell edit first: `  sg  ` (lower case, padded). It is a prefix value-op
  // the repair must see as its input.
  await editCell(page, 0, 1, '  sg  ')
  await expect(cell(page, 0, 1)).toHaveText('  sg  ')

  await openRepairSurface(page)
  await authorPlan(page, { column: 'country', mapping: 'SG => Singapore', trim: true })
  await preview(page)

  // `SG` rows map; `  sg  ` trims to `sg` (not the key, so it passes through
  // trimmed); `US`/`DE` are untouched.
  await expect(page.getByTestId('repair-count-affected')).toHaveText('2')
  const before = await page.getByTestId('repair-example-before').allTextContents()
  const after = await page.getByTestId('repair-example-after').allTextContents()
  expect(before).toEqual(['  sg  ', 'SG'])
  expect(after).toEqual(['sg', 'Singapore'])

  await page.getByTestId('repair-apply').click()
  await expect(page.getByTestId('repair')).toHaveCount(0)

  await expect(cell(page, 0, 1)).toHaveText('sg')
  await expect(cell(page, 2, 1)).toHaveText('Singapore')
  await expect(cell(page, 1, 1)).toHaveText('US')
})

test('refusal leg: a non-text column and a dead mapping key are refused on the surface', async ({
  page,
}) => {
  await openRepairSurface(page)

  // `income` is a BIGINT column: the domain refuses a non-text target.
  await authorPlan(page, { column: 'income', mapping: 'a => b' })
  await expect(page.getByTestId('repair-refusal')).toHaveText(
    'That column is not a text column, so a repair cannot target it: only VARCHAR, TEXT and STRING can be repaired. Character and ENUM columns are refused because a trim would re-declare their type.',
  )
  await expect(page.getByTestId('repair-preview')).toBeDisabled()
  await expect(page.getByTestId('repair-count-affected')).toHaveCount(0)

  // A mapping key whose own edge carries a trim-set member can never match:
  // the CASE operand is always the trimmed value (dead entry).
  await authorPlan(page, { column: 'country', mapping: ' SG => Singapore', trim: true })
  await expect(page.getByTestId('repair-refusal')).toHaveText(
    'A mapping value ends or begins with a character from the trim set, so that pair could never match — trimming happens before the mapping. Remove those characters from the pair, or change the trim set.',
  )
  await expect(page.getByTestId('repair-preview')).toBeDisabled()

  // Nothing was applied through either refusal.
  await expect(page.getByTestId('history-empty')).toBeVisible()
})

test('U1 leg: a plan that changes no row is refused and appends no entry', async ({ page }) => {
  await openRepairSurface(page)
  await authorPlan(page, { column: 'country', mapping: 'ZZ => Nowhere' })
  await preview(page)

  await expect(page.getByTestId('repair-count-scanned')).toHaveText('5')
  await expect(page.getByTestId('repair-count-affected')).toHaveText('0')
  await expect(page.getByTestId('repair-count-unaffected')).toHaveText('5')
  await expect(page.getByTestId('repair-examples-none')).toHaveText(
    'No row changes under this plan, so there is nothing to show.',
  )
  await expect(page.getByTestId('repair-apply')).toBeDisabled()
  await expect(page.getByTestId('repair-apply-blocked')).toHaveText(
    'No row changes under this plan, so nothing was applied and the history is unchanged.',
  )

  // No no-op entry, no undo step, no dirty state.
  await expect(page.getByTestId('history-empty')).toBeVisible()
  await expect(cell(page, 0, 1)).toHaveText('SG')
})

test('U2 leg: a session change behind the preview makes Apply refuse and append nothing', async ({
  page,
}) => {
  // One undoable step exists, so the shortcut below really changes the session.
  await editCell(page, 0, 1, 'ZZ')
  await expect(cell(page, 0, 1)).toHaveText('ZZ')

  await openRepairSurface(page)
  await authorPlan(page, { column: 'country', mapping: 'SG => Singapore' })
  await preview(page)
  await expect(page.getByTestId('repair-apply')).toBeEnabled()
  await expect(page.getByTestId('repair-preview-stale')).toHaveCount(0)

  // The app's document-level undo shortcut is not scoped to the surface: it
  // changes the session while the preview is on screen, which is exactly the
  // staleness the repair must refuse (the cast-path precedent).
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('repair-preview-stale')).toHaveText(
    'This preview is out of date: an edit, an undo or a different file version landed after it was read. Preview again before applying — nothing was applied.',
  )
  await expect(page.getByTestId('repair-apply')).toBeDisabled()

  // Still exactly the one (now undone) cell edit: no repair entry was written.
  await expect(page.getByTestId('history-item')).toHaveCount(1)
  await expect(page.getByTestId('history-cursor')).toHaveText('Step 0 of 1 applied')
  await expect(page.getByTestId('history-description')).toHaveText(
    /set "country" on row .* to "ZZ"/,
  )

  // Previewing again is the honest exit: a fresh capture is not stale.
  await preview(page)
  await expect(page.getByTestId('repair-preview-stale')).toHaveCount(0)
  await expect(page.getByTestId('repair-apply')).toBeEnabled()
})
