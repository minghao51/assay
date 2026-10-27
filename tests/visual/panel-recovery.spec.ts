// SPDX-License-Identifier: AGPL-3.0-or-later

import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { PANEL_CRASH_CHANGE_EVENT, PANEL_CRASH_STORAGE_KEY } from './panel-recovery/injection'

const CUSTOMER_FIXTURE = path.join(process.cwd(), 'fixtures/csv/customers.csv')
const LOCAL_PORTS = new Set([
  Number(process.env['ASSAY_E2E_PORT_WEB'] ?? 4473),
  Number(process.env['ASSAY_E2E_PORT_ENGINE'] ?? 4479),
  Number(process.env['ASSAY_E2E_PORT_DS'] ?? 4480),
])

/** Open a committed synthetic fixture through App's real picker and stage real edits. */
async function openWithStagedEdits(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'idle')
  const chooserEvent = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  await (await chooserEvent).setFiles(CUSTOMER_FIXTURE)
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'ready', {
    timeout: 90_000,
  })

  await page.getByTestId('section-toggle-editing').click()
  await page.getByTestId('section-toggle-history').click()
  await page.getByTestId('edit-insert-row').click()
  await page.getByTestId('edit-insert-row').click()
  await expect(page.getByTestId('pending-changes')).toHaveText('2 pending changes: 2 row inserts.')
  await expect(page.getByTestId('history-item')).toHaveCount(2)
}

/** Use native Tab navigation to reach retry after nav reopens a retained fallback. */
async function tabTo(page: Page, testId: string): Promise<void> {
  for (let index = 0; index < 120; index += 1) {
    const activeTestId = await page.evaluate(
      () => document.activeElement?.getAttribute('data-testid') ?? null,
    )
    if (activeTestId === testId) return
    await page.keyboard.press('Tab')
  }
  throw new Error(`keyboard Tab traversal did not reach ${testId}`)
}

test.beforeEach(async ({ page }) => {
  // Block every non-local request (including any unexpected telemetry target)
  // while leaving the real app and its bundled worker assets available.
  await page.context().route('**/*', async (route) => {
    const requestUrl = new URL(route.request().url())
    const local =
      (requestUrl.hostname === '127.0.0.1' || requestUrl.hostname === 'localhost') &&
      LOCAL_PORTS.has(Number(requestUrl.port))
    if (local || requestUrl.protocol === 'data:' || requestUrl.protocol === 'blob:') {
      await route.continue()
    } else {
      await route.abort()
    }
  })
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    } catch {
      // A non-configurable picker would make the shared filechooser unusable.
    }
  })
})

for (const scenario of [
  { section: 'filters', label: 'inner-disclosure Filters', closeKey: 'Space' },
  { section: 'history', label: 'managed History', closeKey: 'Enter' },
] as const) {
  test(`real keyboard recovers ${scenario.label} without restarting the staged session`, async ({
    page,
  }) => {
    await openWithStagedEdits(page)

    // Harness-only storage/event injection makes the REAL panel entry throw;
    // App, ErrorBoundary, section state, nav, grid and engine stay unmocked.
    await page.evaluate(
      ({ storageKey, eventName, section }) => {
        window.localStorage.setItem(storageKey, section)
        window.dispatchEvent(new Event(eventName))
      },
      {
        storageKey: PANEL_CRASH_STORAGE_KEY,
        eventName: PANEL_CRASH_CHANGE_EVENT,
        section: scenario.section,
      },
    )

    const body = page.locator(`#section-${scenario.section}-content`)
    const fallback = body.getByTestId('error-boundary-panel')
    const targetPanel = page.getByTestId(
      scenario.section === 'filters' ? 'filter-bar' : 'history-panel',
    )
    await expect(fallback).toBeVisible()
    await expect(fallback).toContainText('This section could not render')
    await expect(fallback).not.toContainText('test-only panel crash')
    await expect(page.getByTestId('error-boundary-app')).toHaveCount(0)
    await expect(targetPanel).toHaveCount(0)
    await expect(page.getByTestId('grid')).toBeVisible()
    await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'ready')
    await expect(page.getByTestId('pending-changes')).toHaveText(
      '2 pending changes: 2 row inserts.',
    )
    if (scenario.section !== 'history')
      await expect(page.getByTestId('history-item')).toHaveCount(2)
    await expect(fallback).toBeFocused()

    const retry = fallback.getByTestId('error-boundary-retry')
    const close = fallback.getByTestId('error-boundary-close')
    // In the recovery interaction, native Tab/Shift+Tab and Enter/Space
    // activate the actual buttons; close, reopen and retry use no click calls.
    await page.keyboard.press('Tab')
    await expect(retry).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(close).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(retry).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(close).toBeFocused()
    await page.keyboard.press(scenario.closeKey)

    const navLink = page.getByTestId(`section-nav-${scenario.section}`)
    await expect(body).toBeHidden()
    await expect(navLink).toBeFocused()
    await expect(fallback).toHaveCount(1)

    // Leave the crash persistent through close/reopen: nav activation must
    // reveal the same fallback, not silently retry it.
    await page.keyboard.press('Enter')
    await expect(body).toBeVisible()
    await expect(fallback).toBeVisible()
    await expect(targetPanel).toHaveCount(0)
    await expect(page.getByTestId('pending-changes')).toHaveText(
      '2 pending changes: 2 row inserts.',
    )

    // Clear only the injected fault, then reach the explicit retry through
    // actual Tab traversal from the existing nav link.
    await page.evaluate(
      ({ storageKey, eventName }) => {
        window.localStorage.removeItem(storageKey)
        window.dispatchEvent(new Event(eventName))
      },
      { storageKey: PANEL_CRASH_STORAGE_KEY, eventName: PANEL_CRASH_CHANGE_EVENT },
    )
    await tabTo(page, 'error-boundary-retry')
    await page.keyboard.press('Enter')

    await expect(fallback).toHaveCount(0)
    await expect(targetPanel).toBeVisible()
    await expect(page.getByTestId('grid')).toBeVisible()
    await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'ready')
    await expect(page.getByTestId('pending-changes')).toHaveText(
      '2 pending changes: 2 row inserts.',
    )
    await expect(page.getByTestId('history-item')).toHaveCount(2)
    await expect(navLink).toHaveAttribute('href', `#section-${scenario.section}`)
  })
}
