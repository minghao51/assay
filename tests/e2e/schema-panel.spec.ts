import path from 'node:path'
import { expect, test } from './support/fixture'
import type { Page } from '@playwright/test'
import { openFixture } from './support/fixtures'

// Task M1-6 proof (handoff §6 #6): the schema panel renders a navigable type
// tree for the committed nested fixture, and flat fixtures render as plain
// type badges. The app under test is the real composition root served at '/'
// by the first webServer in playwright.config.ts (apps/web/dist via vite
// preview): pickDataFile → engine open → schema() → SchemaPanel.
//
// Picker path (m1-5 pattern): Playwright's filechooser interception does NOT
// reach window.showOpenFilePicker, so an init script removes the FSA global
// and the app's capability detection takes the hidden-<input type="file">
// fallback, which the chooser event carries. Fixtures are the COMMITTED
// golden files on disk (setFiles by path — no copies).
//
// Assertions use roles/testids, not screenshots. Privacy (ADR 0025): the
// panel must never contain the picked file's name.

const FIXTURES_DIR = path.join(process.cwd(), 'fixtures', 'parquet')
const NESTED_FIXTURE = path.join(FIXTURES_DIR, 'nested.parquet')
const FLAT_FIXTURE = path.join(FIXTURES_DIR, 'customers.parquet')

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    } catch {
      // Non-configurable global would be a Chromium change; the fallback
      // would then be skipped and the test would fail loudly at the chooser.
    }
  })
})

/** A struct toggle button, addressed by role + accessible name (`<name> STRUCT`). */
function structToggle(scope: ReturnType<Page['getByTestId']>, name: string) {
  return scope.getByRole('button', { name: `${name} STRUCT` })
}

test('renders the nested schema tree for nested.parquet with expandable structs', async ({
  page,
}) => {
  await openFixture(page, NESTED_FIXTURE, { requireSchemaPanel: true })

  // Column count surfaced (id + payload), matching the engine's schema().
  await expect(page.getByTestId('schema-column-count')).toHaveText('2 columns')
  await expect(page.getByTestId('schema-column')).toHaveCount(2)

  // Flat column: id → BIGINT badge.
  const idColumn = page.locator('[data-testid="schema-column"][data-col-name="id"]')
  await expect(idColumn.getByTestId('schema-type-badge')).toHaveText('BIGINT')

  // Struct root: payload starts collapsed (aria-expanded, disclosure pattern).
  // The subtree holds more buttons once expanded, so address by name + role.
  const payloadToggle = page.getByRole('button', { name: 'payload STRUCT' })
  const payloadColumn = page.locator('[data-testid="schema-column"][data-col-name="payload"]')
  await expect(payloadToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(payloadColumn.getByTestId('schema-field')).toHaveCount(0)

  // Expand payload → four fields: "name" VARCHAR (DuckDB quotes the name in
  // DESCRIBE; the panel shows it unquoted), geo STRUCT, tags VARCHAR[],
  // scores STRUCT.
  await payloadToggle.click()
  await expect(payloadToggle).toHaveAttribute('aria-expanded', 'true')
  const payloadFields = payloadColumn.getByTestId('schema-field')
  await expect(payloadFields).toHaveCount(4)

  const nameField = payloadColumn.locator('[data-field-name="name"]')
  await expect(nameField.getByTestId('schema-type-badge')).toHaveText('VARCHAR')

  const tagsField = payloadColumn.locator('[data-field-name="tags"]')
  // List shows its element type (VARCHAR badge) plus the dimension suffix ([]).
  await expect(tagsField.getByTestId('schema-type-badge')).toHaveText('VARCHAR')
  await expect(tagsField.locator('.schema-dims')).toHaveText('[]')

  // Nested struct: expand geo → lat/lon DECIMAL(21,1) badges.
  const geoToggle = structToggle(page.getByTestId('schema-panel'), 'geo')
  await expect(geoToggle).toHaveAttribute('aria-expanded', 'false')
  await geoToggle.click()
  const geoField = payloadColumn.locator('[data-field-name="geo"]')
  const geoFields = geoField.getByTestId('schema-field')
  await expect(geoFields).toHaveCount(2)
  await expect(
    geoField.locator('[data-field-name="lat"]').getByTestId('schema-type-badge'),
  ).toHaveText('DECIMAL(21,1)')
  await expect(
    geoField.locator('[data-field-name="lon"]').getByTestId('schema-type-badge'),
  ).toHaveText('DECIMAL(21,1)')

  // Nested struct: expand scores → q1 DOUBLE, q2 INTEGER badges.
  const scoresToggle = structToggle(page.getByTestId('schema-panel'), 'scores')
  await scoresToggle.click()
  const scoresField = payloadColumn.locator('[data-field-name="scores"]')
  await expect(scoresField.getByTestId('schema-field')).toHaveCount(2)
  await expect(
    scoresField.locator('[data-field-name="q1"]').getByTestId('schema-type-badge'),
  ).toHaveText('DOUBLE')
  await expect(
    scoresField.locator('[data-field-name="q2"]').getByTestId('schema-type-badge'),
  ).toHaveText('INTEGER')

  // Collapse payload again → the whole subtree disappears, state flips back.
  await payloadToggle.click()
  await expect(payloadToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(payloadColumn.getByTestId('schema-field')).toHaveCount(0)

  // Privacy (ADR 0025): no file names in the panel — only schema content.
  await expect(page.getByTestId('schema-panel')).not.toContainText('.parquet')
})

test('renders flat columns as type badges with no struct toggles for customers.parquet', async ({
  page,
}) => {
  await openFixture(page, FLAT_FIXTURE, { requireSchemaPanel: true })

  await expect(page.getByTestId('schema-column-count')).toHaveText('4 columns')
  const columns = page.getByTestId('schema-column')
  await expect(columns).toHaveCount(4)

  const expected: Array<[string, string]> = [
    ['customer_id', 'BIGINT'],
    ['country', 'VARCHAR'],
    ['income', 'BIGINT'],
    ['signup_date', 'DATE'],
  ]
  for (const [name, type] of expected) {
    const column = page.locator(`[data-testid="schema-column"][data-col-name="${name}"]`)
    await expect(column.getByTestId('schema-type-badge')).toHaveText(type)
  }

  // Flat schema: nothing to expand.
  await expect(page.getByTestId('schema-struct-toggle')).toHaveCount(0)
  await expect(page.getByTestId('schema-panel')).not.toContainText('.parquet')
})

test('the panel toggle hides and shows the schema without losing expansion state', async ({
  page,
}) => {
  await openFixture(page, NESTED_FIXTURE, { requireSchemaPanel: true })

  const toggle = page.getByTestId('schema-toggle')
  const panel = page.getByTestId('schema-panel')

  // Default open; toggling collapses (aria-expanded drives the disclosure).
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(panel).toHaveCount(0)

  // Toggle back open; expansion state survives the hide/show round trip.
  await toggle.click()
  await expect(panel).toBeVisible()
  const payloadToggle = page.getByRole('button', { name: 'payload STRUCT' })
  await payloadToggle.click()
  await expect(page.getByTestId('schema-field')).toHaveCount(4)

  await toggle.click()
  await expect(panel).toHaveCount(0)
  await toggle.click()
  await expect(payloadToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('schema-field')).toHaveCount(4)
})
