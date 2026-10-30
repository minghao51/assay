import path from 'node:path'
import { expect, test } from '@playwright/test'
import { openFixture, openSection } from './support/fixtures'
import { cell, editCell } from './support/grid'

/**
 * R-16 (ug-10) — profile honesty journey over the real stack:
 *
 * open fixture → stage one cell edit → expand Profile → the standing hint and
 * the singular staged-changes note are visible → compute → both still there on
 * the results → undo → the note is gone and the hint remains.
 *
 * Copy is byte-pinned (em dash included). The panel keeps describing the file
 * as opened — `profile(handle)` is base-only — and adds no stale/re-run banner:
 * there is no re-run-for-edits path in the engine. Privacy (ADR 0025): the
 * copy is value-free and the picked file name never renders.
 */

const CUSTOMERS_FIXTURE = path.join(process.cwd(), 'fixtures', 'parquet', 'customers.parquet')

const HINT = 'Statistics describe the file as opened — staged changes are not included.'
const NOTE_ONE =
  '1 staged change is not reflected here — the grid uses the edited view. Validation must be run explicitly against the edited view.'

test.beforeEach(async ({ page }) => {
  // Hidden-<input type="file"> fallback (the m1-5 pattern).
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    } catch {
      // Non-configurable global would be a Chromium change; fail loudly later.
    }
  })
})

test('staged edit is labeled honestly before and after computing the profile; undo clears only the note', async ({
  page,
}) => {
  // Keep the shell defaults so the journey really expands Profile itself.
  await openFixture(page, CUSTOMERS_FIXTURE, { expandSections: false })

  // Stage one cell edit (income of the first customer).
  await editCell(page, 0, 2, '99999')
  await expect(cell(page, 0, 2)).toHaveText('99999')

  // Expand Profile: the standing hint and the singular note are visible.
  await page.getByTestId('profile-toggle').click()
  await expect(page.getByTestId('profile-toggle')).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('profile-section')).toHaveAttribute('data-state', 'idle')
  await expect(page.getByTestId('profile-standing-hint')).toHaveText(HINT)
  await expect(page.getByTestId('profile-staged-note')).toHaveText(NOTE_ONE)
  // The idle explanatory body (and the element other specs read) is intact.
  await expect(page.getByTestId('profile-table-id')).toBeVisible()

  // Compute: the label does not change — the statistics still describe the
  // file as opened, and the staged edit is still flagged as not reflected.
  await page.getByTestId('profile-run').click()
  await expect(page.getByTestId('profile-section')).toHaveAttribute('data-state', 'done', {
    timeout: 30_000,
  })
  await expect(page.getByTestId('profile-rowcount-value')).toHaveText('5')
  await expect(page.getByTestId('profile-standing-hint')).toHaveText(HINT)
  await expect(page.getByTestId('profile-staged-note')).toHaveText(NOTE_ONE)

  // Undo back to zero active operations: the note disappears, the hint stays.
  await openSection(page, 'history')
  await page.getByTestId('history-undo').click()
  await expect(cell(page, 0, 2)).toHaveText('52000')
  await expect(page.getByTestId('profile-staged-note')).toHaveCount(0)
  await expect(page.getByTestId('profile-standing-hint')).toHaveText(HINT)

  // Privacy (ADR 0025): no picked file name in the panel copy.
  await expect(page.getByTestId('profile-section')).not.toContainText('customers.parquet')
})
