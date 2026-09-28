import path from 'node:path'
import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * Shared picker-path fixture opens (q-5, AR-F4). Every surface opens the
 * committed golden fixtures through the hidden-`<input type="file">` fallback
 * the specs arm in `beforeEach`; the open flow itself is identical, so it has
 * one definition here. The optional ready-frame extras (schema panel visible,
 * picked name hidden) are options so each call keeps its exact assertions.
 */

/** The committed customers fixture (5 rows) opened by three grid specs. */
const CUSTOMERS_FIXTURE = path.join(process.cwd(), 'fixtures', 'parquet', 'customers.parquet')

/** Ready-frame assertions some surfaces add on top of the shared open flow. */
export interface OpenFixtureOptions {
  /** Also assert the schema panel rendered (schema-panel's ready bar). */
  readonly requireSchemaPanel?: boolean
  /** Also assert the picked name never renders in `table-info` (ADR 0025). */
  readonly assertFileNameHidden?: boolean
}

/** Open a fixture through the app's real picker path and wait until ready. */
export async function openFixture(
  page: Page,
  fixturePath: string,
  options: OpenFixtureOptions = {},
): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'idle', {
    timeout: 20_000,
  })
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  const chooser = await chooserPromise
  await chooser.setFiles(fixturePath)
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'ready', {
    timeout: 20_000,
  })
  if (options.requireSchemaPanel === true) {
    await expect(page.getByTestId('schema-panel')).toBeVisible()
  }
  if (options.assertFileNameHidden === true) {
    await expect(page.getByTestId('table-info')).not.toContainText(path.basename(fixturePath))
  }
}

/**
 * Open customers.parquet and pin the ready-frame facts shared by the
 * column-ops / grid-editing / grid-filter-sort specs: 5 total rows and a
 * privacy-safe `table-info` (never the picked file's name, ADR 0025).
 */
export async function openCustomersFixture(
  page: Page,
  fixturePath: string = CUSTOMERS_FIXTURE,
): Promise<void> {
  await openFixture(page, fixturePath, { assertFileNameHidden: true })
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
}

/**
 * Open a fixture and return the engine-generated table id (SQL pane). Pins
 * the pane's privacy contract too (ADR 0025): the SQL pane never renders the
 * picked file's path. The id is read from the SQL pane hint (`sql-table-id`)
 * because the ux-2 info line no longer exposes the engine handle; the pane
 * keeps rendering the `assay_t…` view name that SQL specs need.
 */
export async function openFixtureAndGetTableId(page: Page, fixturePath: string): Promise<string> {
  await openFixture(page, fixturePath)
  await expect(page.getByTestId('sql-panel')).not.toContainText(fixturePath)
  return page.getByTestId('sql-table-id').innerText()
}

/**
 * Open the collapsible filter bar (ux-4; collapsed by default). Idempotent:
 * a programmatic `setFilters` (e.g. the validation panel's "Show only failing
 * rows" bridge) auto-opens it, so a spec that only needs the SQL-fragment
 * escape hatch or a built filter can call this unconditionally.
 */
export async function openFilterBar(page: Page): Promise<void> {
  const toggle = page.getByTestId('filter-toggle')
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click()
  }
  await expect(page.getByTestId('filter-body')).toBeVisible()
}
