import path from 'node:path'
import { expect, test } from '@playwright/test'
import { openFixture } from './support/fixtures'
import { waitForReadyRow } from './support/grid'

// UI-RD-01 / rd-3 — task framing in a real browser.
//
// The task strip groups the twelve sections into four user goals. This spec
// pins what the component/unit suites cannot: the real layout, keyboard
// roving on the real radios, the context bar's neutral facts, and the narrow
// stack staying unfiltered (ADR 0044). It deliberately does NOT pin task
// visibility of panels: the first slice keeps every section reachable and
// only marks the active task's sections (conditional visibility is a
// separately reviewed follow-up).

const CUSTOMERS = path.join(process.cwd(), 'fixtures', 'parquet', 'customers.parquet')

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    } catch {
      /* non-configurable global would fail the open flow loudly */
    }
  })
})

async function openCustomers(page: import('@playwright/test').Page): Promise<void> {
  await openFixture(page, CUSTOMERS, { assertFileNameHidden: true, expandSections: false })
  await waitForReadyRow(page, 0)
}

test('task framing opens the task tools and keeps the grid mounted', async ({ page }) => {
  await openCustomers(page)

  // Four single-select radios, Explore by default.
  const radios = page.getByRole('radio')
  await expect(radios).toHaveCount(4)
  await expect(page.getByTestId('task-explore')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('task-check')).toHaveAttribute('aria-checked', 'false')

  // Check opens its own shell-managed sections.
  await page.getByTestId('task-check').click()
  await expect(page.getByTestId('task-check')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('section-toggle-validation')).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await expect(page.getByTestId('section-toggle-compare')).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('task-purpose')).toContainText('quality issues')

  // Change opens review + delivery.
  await page.getByTestId('task-change').click()
  for (const id of ['editing', 'history', 'export']) {
    await expect(page.getByTestId(`section-toggle-${id}`)).toHaveAttribute('aria-expanded', 'true')
  }

  // The grid is the persistent center: still mounted, still ready, same rows.
  await expect(page.getByTestId('grid')).toBeVisible()
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
})

test('the task strip is a keyboard radio group with roving tabindex', async ({ page }) => {
  await openCustomers(page)
  await expect(page.getByTestId('task-explore')).toHaveAttribute('tabindex', '0')
  await expect(page.getByTestId('task-check')).toHaveAttribute('tabindex', '-1')

  await page.getByTestId('task-explore').focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('task-check')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('task-check')).toBeFocused()
  await expect(page.getByTestId('task-check')).toHaveAttribute('tabindex', '0')

  await page.keyboard.press('End')
  await expect(page.getByTestId('task-prepare')).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Home')
  await expect(page.getByTestId('task-explore')).toHaveAttribute('aria-checked', 'true')
})

test('the context bar states neutral facts and one real action', async ({ page }) => {
  await openCustomers(page)

  const bar = page.getByTestId('dataset-context')
  await expect(bar).toBeVisible()
  await expect(bar).toContainText('Current dataset view')
  await expect(bar).toContainText('5 rows × 4 columns')
  await expect(bar).toContainText('No staged operations')
  // No filename, no copied verdict count.
  await expect(bar).not.toContainText('customers.parquet')
  await expect(page.getByTestId('context-state')).toHaveAttribute('role', 'status')
  await expect(page.getByTestId('context-state')).toHaveText('No contract loaded')

  // The action reveals the Validation tool and lands focus on its existing
  // control — it does not open a second picker or run anything.
  await page.getByTestId('context-action').click()
  await expect(page.getByTestId('section-toggle-validation')).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await expect(page.getByTestId('validation-open-contract')).toBeFocused()
})

test('below 1024px the same sections stack and every section stays reachable', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 })
  await openCustomers(page)

  await expect(page.getByTestId('task-nav')).toBeVisible()
  await expect(page.getByTestId('section-nav').locator('a')).toHaveCount(12)

  const yOf = async (id: string): Promise<number> => {
    const box = await page.locator(`#section-${id}`).boundingBox()
    if (box === null) throw new Error(`missing box for ${id}`)
    return box.y
  }
  // Documented slice-1 order: schema → grid → editing … (no task filtering).
  expect(await yOf('schema')).toBeLessThan(await yOf('grid'))
  expect(await yOf('grid')).toBeLessThan(await yOf('editing'))

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth)
})
