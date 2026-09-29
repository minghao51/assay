import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import path from 'node:path'
import { row } from './support/grid'

// Task m3-3 (handoff §6): the record inspector — a row-level panel showing the
// ENTIRE record as a JSON disclosure tree, at every depth. The grid cell
// deliberately shows only a capped, depth-aware preview (m3-2); this spec
// pins the full-value layer against the committed
// `fixtures/jsonl/nested.jsonl` golden fixture (m3-1), derived from the
// fixture + the m3-1 worker-boundary contract (`normalizeArrowCell`: structs
// as records, lists positionally, 64-bit ints as bigint, timestamps as
// epoch-ms numbers) and cross-checked against the DuckDB CLI (v1.5.5):
//
//   /tmp/duckdb -c "SELECT id, deep, meta, tags FROM read_json_auto(
//     'fixtures/jsonl/nested.jsonl', format='newline_delimited') WHERE id = 1;"
//   → deep {'a': {'b': {'c': 1}}} · meta {'src': sensor-a, 'ver': 1} · tags [x, y]
//   /tmp/duckdb -c "SELECT list_transform(events, e -> epoch_ms(e.at)),
//     list_transform(events, e -> e.ok) FROM read_json_auto(
//     'fixtures/jsonl/nested.jsonl', format='newline_delimited') WHERE id IN (1,4)
//     ORDER BY id;"
//   → id 1: [1740823200000, 1740823500000], [true, false]
//   → id 4: [1741071600000, NULL], [false, NULL]  (NULL list element)
//
// Freshness policy under test (pinned in apps/web/src/record/record-state.ts):
// an epoch shift (accepted sort/filter — the grid's row identity is positional
// in v1) CLOSES the inspector; it never re-resolves the position and never
// renders a stale snapshot as if current.

const FIXTURE_PATH = path.resolve(import.meta.dirname, '../../fixtures/jsonl/nested.jsonl')

test.beforeEach(async ({ page }) => {
  // Inject "no FSA picker" capabilities so the app takes its hidden-input
  // fallback; the filechooser event then carries the file (m1-5 precedent).
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    } catch {
      // Non-configurable global would be a Chromium change; the fallback
      // would then be skipped and the test would fail loudly at the chooser.
    }
  })
})

async function openNestedFixture(
  page: Page,
  beforeOpen?: (page: Page) => Promise<void>,
): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'idle', {
    timeout: 20_000,
  })
  if (beforeOpen !== undefined) await beforeOpen(page)
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  const chooser = await chooserPromise
  await chooser.setFiles(FIXTURE_PATH)
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'ready', {
    timeout: 20_000,
  })
  await expect(page.getByTestId('grid-total-rows')).toHaveText('12')
  // Privacy (ADR 0025): the picked file name is never rendered anywhere.
  await expect(page.getByTestId('table-info')).not.toContainText('nested.jsonl')
}

/** Opens the inspector for a grid row via the click affordance. */
async function openRow(page: Page, rowIndex: number): Promise<Locator> {
  const target = row(page, rowIndex)
  // Only a `ready` row opens the inspector (loading rows no-op by design) —
  // pin the row's readiness first so the gesture is never a silent race.
  await expect(target).toHaveAttribute('data-status', 'ready')
  await target.click()
  const panel = page.getByTestId('record-inspector')
  await expect(panel).toBeVisible()
  await expect(panel).toHaveAttribute('data-row-index', String(rowIndex))
  await expect(page.getByTestId('record-title-row')).toHaveText(String(rowIndex))
  return panel
}

/** The disclosure toggle of one branch node, addressed like the schema panel: role + name. */
function branchToggle(scope: Locator, name: string): Locator {
  return scope.getByRole('button', { name, exact: true })
}

/**
 * Locator for a leaf's value span at an exact tree path, e.g.
 * `['events', '0', 'ok']` — chains branch membership (`> ul >`) per step and
 * ends at the value text node inside the terminal leaf.
 */
function valueAt(scope: Locator, path: readonly string[]): Locator {
  let selector = ''
  for (const [index, key] of path.entries()) {
    selector += `li[data-node-key='${key}']`
    if (index < path.length - 1) selector += ' > span.record-branch > ul > '
  }
  return scope.locator(`${selector} > span.record-leaf > span[data-testid='record-node-value']`)
}

/** Locator for a branch node's bounded summary span (the collapsed view). */
function summaryAt(scope: Locator, path: readonly string[]): Locator {
  let selector = ''
  for (const [index, key] of path.entries()) {
    selector += `li[data-node-key='${key}']`
    if (index < path.length - 1) selector += ' > span.record-branch > ul > '
  }
  return scope.locator(`${selector} > span.record-branch > span[data-testid='record-node-summary']`)
}

test('row 0 renders the FULL record at every depth — not the capped preview', async ({ page }) => {
  await openNestedFixture(page)
  const panel = await openRow(page, 0)

  // The root lists all 10 schema columns in schema order (hostile key verbatim).
  await expect(panel.getByTestId('record-node')).toHaveCount(10)
  // The quoting-hostile key renders verbatim as data (matched via substring —
  // the exact value with embedded double quotes is asserted, not selector-encoded).
  await expect(panel.locator("li[data-node-key*='quoted']")).toHaveAttribute(
    'data-node-key',
    'weird "quoted" key',
  )
  // Its value renders as plain data, exactly like any other column.
  await expect(
    panel.locator(
      "li[data-node-key*='quoted'] > span.record-leaf > span[data-testid='record-node-value']",
    ),
  ).toHaveText('1')
  await expect(valueAt(panel, ['hole'])).toHaveText('null')

  // Depth-3 struct, expanded to the LEAF the capped grid preview elides:
  // CLI: deep {'a': {'b': {'c': 1}}}.
  await expect(summaryAt(panel, ['deep'])).toHaveText('{"a":{"b":{"c":…}}}') // collapsed = the m3-2 preview
  await expect(panel.locator("li[data-node-key='deep'] ul")).toHaveCount(0) // not yet expanded
  await branchToggle(panel, 'deep object').click()
  await expect(branchToggle(panel, 'deep object')).toHaveAttribute('aria-expanded', 'true')
  await branchToggle(panel, 'a object').click()
  await branchToggle(panel, 'b object').click()
  await expect(valueAt(panel, ['deep', 'a', 'b', 'c'])).toHaveText('1')

  // List-of-structs at full depth: epoch-ms numbers + booleans per element.
  // CLI: events epoch_ms → [1740823200000, 1740823500000], ok → [true, false].
  await branchToggle(panel, 'events array').click()
  await branchToggle(panel, '0 object').click()
  await branchToggle(panel, '1 object').click()
  await expect(valueAt(panel, ['events', '0', 'at'])).toHaveText('1740823200000')
  await expect(valueAt(panel, ['events', '0', 'ok'])).toHaveText('true')
  await expect(valueAt(panel, ['events', '1', 'at'])).toHaveText('1740823500000')
  await expect(valueAt(panel, ['events', '1', 'ok'])).toHaveText('false')

  // Struct fields: CLI meta {'src': sensor-a, 'ver': 1}; the all-NULL column
  // renders as the null kind; 64-bit ints as number-strings.
  await branchToggle(panel, 'meta object').click()
  await expect(valueAt(panel, ['meta', 'src'])).toHaveText('"sensor-a"')
  await expect(valueAt(panel, ['meta', 'ver'])).toHaveText('1')
  await expect(valueAt(panel, ['hole'])).toHaveText('null')
  await expect(panel.locator("li[data-node-key='hole']")).toHaveAttribute('data-node-kind', 'null')
  await expect(valueAt(panel, ['id'])).toHaveText('1')

  // The disclosure structure is present: aria-controls targets exist and the
  // expanded branch renders its children as a list.
  const controlsId = await branchToggle(panel, 'deep object').getAttribute('aria-controls')
  expect(controlsId).not.toBeNull()
  await expect(panel.locator(`ul[id="${controlsId as string}"]`)).toBeVisible()
  await expect(panel.locator("li[data-node-key='deep'] > span > ul > li")).toHaveCount(1) // a
})

test('NULL vs empty vs populated stay distinct at depth (rows 4, 3, 2)', async ({ page }) => {
  await openNestedFixture(page)

  // Row id 4 (index 3): whole-NULL struct and NULL list — null nodes, NOT {}
  // or [] renders, and not expandable; plus a NULL *element* inside events.
  const row4 = await openRow(page, 3)
  await expect(row4.locator("li[data-node-key='deep']")).toHaveAttribute('data-node-kind', 'null')
  await expect(row4.locator("li[data-node-key='deep'] button")).toHaveCount(0)
  await expect(valueAt(row4, ['deep'])).toHaveText('null')
  await expect(valueAt(row4, ['tags'])).toHaveText('null')
  await branchToggle(row4, 'events array').click()
  await branchToggle(row4, '0 object').click()
  await expect(valueAt(row4, ['events', '0', 'at'])).toHaveText('1741071600000') // CLI cross-check
  await expect(valueAt(row4, ['events', '0', 'ok'])).toHaveText('false')
  await expect(
    row4.locator("li[data-node-key='events'] > span > ul > li[data-node-key='1']"),
  ).toHaveAttribute('data-node-kind', 'null') // CLI: second element NULL

  // Row id 3 (index 2): NULLs INSIDE structures — NULL score, NULL struct
  // field next to a populated one, NULL list element, NULL timestamp.
  const row3 = await openRow(page, 2)
  await expect(valueAt(row3, ['score'])).toHaveText('null')
  await branchToggle(row3, 'meta object').click()
  await expect(valueAt(row3, ['meta', 'src'])).toHaveText('null')
  await expect(row3.locator("li[data-node-key='src']")).toHaveAttribute('data-node-kind', 'null')
  await expect(valueAt(row3, ['meta', 'ver'])).toHaveText('3')
  await branchToggle(row3, 'tags array').click()
  await expect(valueAt(row3, ['tags', '0'])).toHaveText('"x"')
  await expect(valueAt(row3, ['tags', '1'])).toHaveText('null')
  await expect(valueAt(row3, ['tags', '2'])).toHaveText('"z"')
  await branchToggle(row3, 'events array').click()
  await branchToggle(row3, '0 object').click()
  await expect(valueAt(row3, ['events', '0', 'at'])).toHaveText('null')

  // Row id 2 (index 1): the EMPTY list renders as [] (distinct from null) and
  // the unicode label survives as exact text.
  const row2 = await openRow(page, 1)
  await expect(valueAt(row2, ['label'])).toHaveText('"héllo → 世界 🚀"')
  await expect(row2.locator("li[data-node-key='tags']")).toHaveAttribute('data-node-kind', 'array')
  await expect(summaryAt(row2, ['tags'])).toHaveText('[]')
  await branchToggle(row2, 'tags array').click()
  await expect(row2.locator("li[data-node-key='tags'] ul li")).toHaveCount(0)
})

test('tree semantics: region role, disclosure toggles, keyboard open/close, reopen resets', async ({
  page,
}) => {
  await openNestedFixture(page)

  // Keyboard open: focus a row, press Enter (plain keyboard gesture). The
  // row must be ready first — a loading row deliberately does not open.
  const row3 = page.locator('[data-testid="grid-row"][data-row-index="3"]')
  await expect(row3).toHaveAttribute('data-status', 'ready')
  await row3.focus()
  await page.keyboard.press('Enter')
  const panel = page.getByTestId('record-inspector')
  await expect(panel).toBeVisible()
  await expect(panel).toHaveAttribute('data-row-index', '3')
  // Accessible as a named region.
  await expect(page.getByRole('region', { name: 'Record inspector — row 3' })).toBeVisible()

  // Disclosure toggles: native buttons with aria-expanded/aria-controls.
  // (Row id 4 has a NULL deep — no deep toggle exists; use the events array.)
  const eventsToggle = branchToggle(panel, 'events array')
  await expect(eventsToggle).toHaveAttribute('aria-expanded', 'false')
  const controlsId = await eventsToggle.getAttribute('aria-controls')
  expect(controlsId).not.toBeNull()
  await expect(panel.locator(`ul[id="${controlsId as string}"]`)).toHaveCount(0)
  await eventsToggle.click()
  await expect(eventsToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(panel.locator(`ul[id="${controlsId as string}"]`)).toBeVisible()

  // Keyboard close: Escape while focus is inside the panel.
  await eventsToggle.focus()
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)

  // Reopen resets expansion: expand → close → reopen → collapsed again.
  await openRow(page, 3)
  await branchToggle(panel, 'events array').click()
  await expect(panel.locator("li[data-node-key='events'] ul li")).toHaveCount(2)
  await page.getByTestId('record-close').click()
  await expect(panel).toHaveCount(0)
  await openRow(page, 3)
  await expect(panel.locator("li[data-node-key='events'] ul li")).toHaveCount(0)

  // Switch-row: opening another row re-points the panel without a close first.
  await openRow(page, 0)
  await expect(valueAt(panel, ['label'])).toHaveText('"plain alpha row"')
})

test('expand-all / collapse-all reach the full depth in one gesture', async ({ page }) => {
  await openNestedFixture(page)
  const panel = await openRow(page, 0)

  await page.getByTestId('record-expand-all').click()
  // The depth-3 leaf and both events elements' fields are visible without
  // any manual expanding — the full record at a glance.
  await expect(valueAt(panel, ['deep', 'a', 'b', 'c'])).toHaveText('1')
  await expect(valueAt(panel, ['events', '0', 'at'])).toHaveText('1740823200000')
  await expect(valueAt(panel, ['events', '1', 'ok'])).toHaveText('false')

  await page.getByTestId('record-collapse-all').click()
  await expect(panel.locator('ul.record-children')).toHaveCount(0) // every branch closed
  await expect(panel.getByTestId('record-node')).toHaveCount(10) // top-level columns remain
})

test(
  'freshness policy: an epoch shift closes the inspector — never a stale record as current' +
    ' (pinned)',
  async ({ page }) => {
    await openNestedFixture(page)
    const panel = await openRow(page, 0)
    await expect(valueAt(panel, ['label'])).toHaveText('"plain alpha row"')

    // An accepted sort starts a fresh data epoch (setSort → refresh(): cache
    // dropped, counters reset — pinned in m3-2's determinism spec). Row
    // identity is positional in v1, so the panel must close rather than
    // silently swap or stale-render the record under the same title.
    const idSort = page.locator('[data-testid="grid-sort-toggle"][data-col-name="id"]')
    await idSort.click()
    await expect(idSort).toHaveAttribute('data-sort', 'asc') // setSort accepted → refresh() ran
    await expect(page.getByTestId('record-inspector')).toHaveCount(0)

    // The app stays healthy and the user can deliberately re-open: sorting by
    // id asc restores the fixture's natural order, so row 0 is id 1 again.
    await expect(page.locator('[data-testid="grid-row"][data-row-index="0"]')).toHaveAttribute(
      'data-status',
      'ready',
    )
    const reopened = await openRow(page, 0)
    await expect(valueAt(reopened, ['label'])).toHaveText('"plain alpha row"')
  },
)

// uxc-2: a click on a still-loading row used to be silently dropped — the
// open effect guarded on the slot being `ready` and did not re-run when the
// fetch landed, so the gesture never resolved. Determinism: the grid's first
// render after `load()` always commits rows in the `loading` state (the cache
// is empty and the viewport fetch is issued from a passive effect *after* that
// commit), so an in-page MutationObserver can click the first row to mount and
// record the status at click time — no race against the engine worker.
test('a click on a still-loading row opens the inspector once it is ready (uxc-2)', async ({
  page,
}) => {
  await openNestedFixture(page, async (target) => {
    await target.evaluate(() => {
      interface ClickedRow {
        index: number
        status: string
      }
      type ClickedGlobal = typeof window & { __assayClickedLoadingRow?: ClickedRow }
      const observer = new MutationObserver(() => {
        const candidate = document.querySelector<HTMLElement>(
          '[data-testid="grid-row"][data-status="loading"]',
        )
        if (candidate === null) return
        observer.disconnect()
        ;(window as ClickedGlobal).__assayClickedLoadingRow = {
          index: Number(candidate.dataset['rowIndex']),
          status: candidate.dataset['status'] ?? '',
        }
        candidate.click()
      })
      observer.observe(document.body, { childList: true, subtree: true })
    })
  })

  // The observed click provably landed on a loading row (not a ready one) —
  // this is the state the dropped-gesture defect needed.
  const clicked = await page.evaluate(() => {
    type ClickedGlobal = typeof window & {
      __assayClickedLoadingRow?: { index: number; status: string }
    }
    return (window as ClickedGlobal).__assayClickedLoadingRow ?? null
  })
  expect(clicked).not.toBeNull()
  expect(clicked?.status).toBe('loading')
  const clickedIndex = clicked?.index ?? -1

  // The pending gesture resolves when the slot lands: the inspector opens on
  // the clicked row, which is ready by then.
  const panel = page.getByTestId('record-inspector')
  await expect(panel).toBeVisible({ timeout: 20_000 })
  await expect(panel).toHaveAttribute('data-row-index', String(clickedIndex))
  await expect(row(page, clickedIndex)).toHaveAttribute('data-status', 'ready')
})
