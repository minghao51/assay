import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { openFixture } from './support/fixtures'
import { renameColumn } from './support/grid'

/**
 * ug-16 — profile stats click-to-act journey over the real stack:
 *
 * 1. open customers.parquet → run the profile → click a top-k bar → the
 *    existing FilterBar shows the builder-compiled chip and the grid narrows
 *    (country = 'SG' → 2 of 5 rows);
 * 2. click a null-count stat → the `IS NULL` chip appears and the grid shows
 *    the single NULL income row;
 * 3. stage a rename → click a BASE-derived top-k value → the byte-exact
 *    renamed-column refusal renders, no chip is created and the grid stays
 *    unfiltered (no silent remap; design 20261030-ug16-renamed-column-design).
 *
 * Copy is byte-pinned (em dash U+2014, straight quotes). The profile itself is
 * base-derived (R-16) and stays untouched; `profile(handle)` is unchanged.
 */

const CUSTOMERS_FIXTURE = path.join(process.cwd(), 'fixtures', 'parquet', 'customers.parquet')

const RENAMED =
  'This column is now "nation" in the edited view. The profile still uses the file\'s original name, "country" — use "nation" in Filters instead.'

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

async function runProfile(page: Page): Promise<void> {
  await page.getByTestId('profile-run').click()
  await expect(page.getByTestId('profile-section')).toHaveAttribute('data-state', 'done', {
    timeout: 30_000,
  })
  await expect(page.getByTestId('profile-rowcount-value')).toHaveText('5')
}

test('top-k value click filters the grid and shows the existing FilterBar chip', async ({
  page,
}) => {
  await openFixture(page, CUSTOMERS_FIXTURE)
  await runProfile(page)
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')

  // The row is a real control, named with the column and the action.
  await page.getByRole('button', { name: 'Filter country to SG' }).click()

  // The chip is the existing FilterBar rendering of the applied predicate
  // (the chip element also carries its remove button, so pin the predicate
  // text itself).
  const chip = page.getByTestId('filter-chip')
  await expect(chip).toHaveAttribute('data-col-name', 'country')
  await expect(chip.locator('code')).toHaveText("country = 'SG'")
  await expect(page.getByTestId('grid-total-rows')).toHaveText('2')
  await expect(page.getByTestId('profile-filter-refusal')).toHaveCount(0)
})

test('null-count click applies IS NULL and narrows the grid to the null row', async ({ page }) => {
  await openFixture(page, CUSTOMERS_FIXTURE)
  await runProfile(page)

  await page.getByRole('button', { name: 'Filter income where null' }).click()

  const chip = page.getByTestId('filter-chip')
  await expect(chip).toHaveAttribute('data-col-name', 'income')
  await expect(chip.locator('code')).toHaveText('income IS NULL')
  await expect(page.getByTestId('grid-total-rows')).toHaveText('1')
})

test('a base-derived click on a renamed column refuses byte-exactly and applies no filter', async ({
  page,
}) => {
  await openFixture(page, CUSTOMERS_FIXTURE)
  await runProfile(page)

  // Stage the rename AFTER profiling: the profile still describes the file as
  // opened and therefore still names `country`.
  await renameColumn(page, 'country', 'nation')
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')

  await page.getByRole('button', { name: 'Filter country to SG' }).click()

  const refusal = page.getByTestId('profile-filter-refusal')
  await expect(refusal).toHaveAttribute('role', 'status')
  await expect(refusal).toHaveText(RENAMED)
  // No filter applied, no chip, grid unchanged — and the R-16 hint/note and
  // the idle table-id element survive.
  await expect(page.getByTestId('filter-chip')).toHaveCount(0)
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  await expect(page.getByTestId('profile-standing-hint')).toHaveText(
    'Statistics describe the file as opened — staged changes are not included.',
  )
  await expect(page.getByTestId('profile-staged-note')).toHaveText(
    '1 staged change is not reflected here — the grid uses the edited view. Validation must be run explicitly against the edited view.',
  )
  await expect(page.getByTestId('profile-section')).not.toContainText('customers.parquet')
})
