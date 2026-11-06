import { expect, test } from './support/fixture'
import type { Locator, Page } from '@playwright/test'
import { openNestedFixture } from './support/fixtures'

// Task m3-5 (handoff §6, FINAL M3 task): the exit-criterion journey. M3's exit
// criterion (impl-plan §5) is: "JSONL with nested fields is materially easier
// to inspect than plain text." This spec walks ONE continuous user journey
// over the committed `fixtures/jsonl/nested.jsonl` golden fixture (m3-1) from
// a cold start, and the following journey facts are exactly what prove the
// criterion's substance — everything a user needs to inspect nested structure
// without ever reading or writing raw JSON text:
//
//   1. STRUCTURE WITHOUT RAW TEXT — the schema tree renders the full nested
//      type tree (struct-in-struct, lists, list-of-structs, the
//      quoting-hostile key) as an expandable disclosure tree, not a DESCRIBE
//      string blob (m1-6 tree, m3-5 actions).
//   2. VALUES AT A GLANCE — grid cells render bounded one-line nested
//      previews (m2-2 pins), so nested cell contents are scannable in the
//      grid instead of a wall of raw JSON.
//   3. THE FULL VALUE IS REACHABLE — the record inspector discloses the
//      entire row at every depth (m3-3 pins), including the depth-3 leaf the
//      capped preview deliberately elides.
//   4. ONE CLICK RE-SHAPES — a STRUCT column header flattens `meta` into
//      `meta.src`/`meta.ver` child columns (fixture-pinned values), a LIST
//      column explodes `tags` into rows × elements with 1-based positions
//      (fixture-pinned multiset), and a struct child field extracts its
//      dotted path (`deep.a.b.c`, pinned column) — all without typing SQL
//      (m3-5 actions through m3-4's composer into the m2-4 pane).
//   5. HONESTY — after every action the composed SQL is visible verbatim in
//      the editor, so the user sees exactly what ran.
//
// Pinned values were derived from the fixture and cross-checked against the
// DuckDB CLI (v1.5.5) by running the composed statements wrapped exactly as
// the pane wraps them; e.g.:
//
//   /tmp/duckdb -c "CREATE VIEW v AS SELECT * FROM read_json_auto(
//     'fixtures/jsonl/nested.jsonl', format='newline_delimited');
//     SELECT * FROM (SELECT \"meta\".\"src\" AS \"meta.src\", \"meta\".\"ver\"
//     AS \"meta.ver\" FROM v) AS _assay_page LIMIT 50 OFFSET 0;"
//   → 12 rows: sensor-a/sensor-b/NULL… · 1,2,3,4,NULL,1,2,8,1,2,3,NULL
//   (flatten NULL struct/field rows render as empty cells — the pane's NULL
//   contract). The tags explode returns 20 rows and deep.a.b.c returns
//   1,2,3,NULL,5,6,NULL,8,-9,10,NULL,12 (HUGEINT → exact integer text).
//
// Order honesty: the composed statements carry no ORDER BY. Cross-row order
// is therefore NOT assumed for the explode (asserted as a sorted multiset —
// a CLI run of the same statement shows DuckDB's emission order varies), and
// per-row projections (flatten/extract) are pinned as ordered columns only
// where the whole result is one row per source row, the same precedent as
// sql-editor.spec.ts's unwrapped-fixture pins. Element positions come from
// the projected `tags.pos` column itself, not from row order.
//
// Picker path (m1-5 precedent): the FSA global is removed via an init script
// so the app takes its hidden-input fallback, which Playwright's filechooser
// carries. Accessibility bar: actions are asserted by role + accessible
// name, and the journey performs the explode with keyboard only (focus +
// Enter). Privacy (ADR 0025): the file name is never rendered anywhere.
// The composer-rejection alert (role="alert") is asserted ABSENT throughout:
// every action the gated UI offers composes, and the rejection path's
// reasons are pinned at the unit level (nested-actions.test.ts).

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

/** One result column of the SQL pane, addressed positionally like sql-editor.spec. */
function resultColumn(page: Page, columnIndex: number): Locator {
  return page
    .locator('[data-testid="sql-result-row"]')
    .locator(`[data-testid="sql-result-cell"]:nth-child(${String(columnIndex)})`)
}

/**
 * The exact composed explode statement (m3-4 byte shape), restated with the
 * runtime view name so the pin cannot silently depend on table id `t1`.
 */
function explodeTagsSql(viewName: string): string {
  const others = ['id', 'kind', 'label', 'score', 'deep', 'meta', 'events', 'hole']
    .map((column) => `"${viewName}"."${column}"`)
    .join(', ')
  const hostile = `"${viewName}"."weird ""quoted"" key"`
  const v = `"${viewName}"`
  return (
    `SELECT ${others}, ${hostile}, ` +
    '"_assay_explode"."tags" AS "tags", "_assay_explode"."tags.pos" AS "tags.pos" ' +
    `FROM ${v}, UNNEST(CASE WHEN ${v}."tags" IS NULL THEN [NULL] ELSE ${v}."tags" END) ` +
    'WITH ORDINALITY AS "_assay_explode"("tags", "tags.pos")'
  )
}

test('cold start to insight: schema tree → previews → inspector → one-click flatten / explode / extract, SQL visible throughout', async ({
  page,
}) => {
  const { viewName } = await openNestedFixture(page)

  // ---- Fact 1: the schema tree exposes the nested structure as a tree ----
  // The quoting-hostile key is a first-class column (exact attribute value).
  const hostile = page.locator(
    "[data-testid='schema-column'][data-col-name='weird \"quoted\" key']",
  )
  await expect(hostile).toHaveCount(1)
  await expect(hostile.getByTestId('schema-type-badge')).toHaveText('BIGINT')

  // Struct children are real tree nodes: expand meta → src/ver.
  await page.getByTestId('schema-panel').getByRole('button', { name: 'meta STRUCT' }).click()
  const metaColumn = page.locator('[data-testid="schema-column"][data-col-name="meta"]')
  await expect(metaColumn.locator('[data-field-name="src"]')).toBeVisible()
  await expect(metaColumn.locator('[data-field-name="ver"]')).toBeVisible()
  // Leaf fields carry the extract action too (the most common extract target).
  await expect(metaColumn.getByRole('button', { name: 'Extract path meta.src' })).toBeVisible()

  // List-of-structs children render too — and honestly carry NO action of
  // their own: the tree has no indices, so reaching into `events` elements
  // is explode's job, not a composed blind path. (Regression pins: the
  // element continuation once re-offered the column-level Flatten.)
  const eventsColumn = page.locator('[data-testid="schema-column"][data-col-name="events"]')
  await eventsColumn.getByRole('button', { name: 'STRUCT', exact: true }).click()
  const atField = eventsColumn.locator('[data-field-name="at"]')
  await expect(atField).toBeVisible()
  await expect(atField.getByRole('button')).toHaveCount(0)
  await expect(
    eventsColumn.getByRole('button', { name: 'Flatten struct column events' }),
  ).toHaveCount(0)
  await expect(
    eventsColumn.getByRole('button', { name: 'Explode list column events' }),
  ).toHaveCount(1)

  // ---- Fact 2: nested cells render bounded previews, not raw JSON walls ----
  const row1 = page.locator('[data-testid="grid-row"][data-row-index="0"]')
  await expect(row1).toHaveAttribute('data-status', 'ready')
  const row1Cells = row1.getByTestId('grid-cell')
  await expect(row1Cells.nth(4)).toHaveText('{"a":{"b":{"c":…}}}') // depth-3 struct, capped
  await expect(row1Cells.nth(5)).toHaveText('{"src":"sensor-a","ver":1}')
  await expect(row1Cells.nth(6)).toHaveText('["x","y"]')
  await expect(row1Cells.nth(7)).toHaveText(
    '[{"at":1740823200000,"ok":true},{"at":1740823500000,"ok":false}]',
  )

  // ---- Fact 3: the inspector discloses the FULL row (the elided leaf) ----
  await row1.click()
  const panel = page.getByTestId('record-inspector')
  await expect(panel).toBeVisible()
  // ug-11: the dock's visible number is 1-based (row index 0 → row 1), the
  // same convention as the grid's row-number gutter.
  await expect(page.getByRole('region', { name: 'Record inspector — row 1' })).toBeVisible()

  /** Leaf value at an exact tree path (record-inspector.spec pattern). */
  const valueAt = (scope: Locator, keys: readonly string[]): Locator => {
    let selector = ''
    for (const [index, key] of keys.entries()) {
      selector += `li[data-node-key='${key}']`
      if (index < keys.length - 1) selector += ' > span.record-branch > ul > '
    }
    return scope.locator(`${selector} > span.record-leaf > span[data-testid='record-node-value']`)
  }
  await panel.getByRole('button', { name: 'deep object', exact: true }).click()
  await panel.getByRole('button', { name: 'a object', exact: true }).click()
  await panel.getByRole('button', { name: 'b object', exact: true }).click()
  // CLI: deep {'a': {'b': {'c': 1}}} — the value the preview capped away.
  await expect(valueAt(panel, ['deep', 'a', 'b', 'c'])).toHaveText('1')
  await page.getByTestId('record-close').click()
  await expect(panel).toHaveCount(0)

  // ---- Fact 4a: ONE CLICK on the `meta` HEADER flattens it ----
  const flattenMeta = page
    .locator('[data-testid="grid-header-cell"][data-col-name="meta"]')
    .getByRole('button', { name: 'Flatten struct column meta' })
  await expect(flattenMeta).toBeVisible()
  await flattenMeta.click()
  await expect(page.getByTestId('sql-panel')).toHaveAttribute('data-state', 'done')
  // Honesty: the editor shows the exact composed statement that ran.
  await expect(page.getByTestId('sql-input')).toHaveValue(
    'SELECT "id", "kind", "label", "score", "deep", "tags", "events", "hole", ' +
      '"weird ""quoted"" key", "meta"."src" AS "meta.src", "meta"."ver" AS "meta.ver" ' +
      `FROM "${viewName}"`,
  )
  // The struct is replaced by its child columns; other columns keep order.
  await expect(page.getByTestId('sql-result-header')).toHaveText([
    'id',
    'kind',
    'label',
    'score',
    'deep',
    'tags',
    'events',
    'hole',
    'weird "quoted" key',
    'meta.src',
    'meta.ver',
  ])
  await expect(page.locator('[data-testid="sql-result-row"]')).toHaveCount(12) // one row per source row
  // Fixture-pinned values (CLI cross-check in the header comment): NULL
  // structs/fields render as empty cells, exactly like the grid's contract.
  await expect(resultColumn(page, 10)).toHaveText([
    'sensor-a',
    'sensor-b',
    '',
    'sensor-a',
    '',
    'sensor-c',
    'sensor-a',
    '',
    'sensor-b',
    'sensor-c',
    'sensor-a',
    '',
  ])
  await expect(resultColumn(page, 11)).toHaveText([
    '1',
    '2',
    '3',
    '4',
    '',
    '1',
    '2',
    '8',
    '1',
    '2',
    '3',
    '',
  ])

  // ---- Fact 4b: ONE CLICK (keyboard) on the `tags` tree node explodes it ----
  const explodeTags = page
    .getByTestId('schema-panel')
    .getByRole('button', { name: 'Explode list column tags' })
  await expect(explodeTags).toBeVisible()
  await explodeTags.focus()
  await page.keyboard.press('Enter') // keyboard-operable: no pointer needed
  await expect(page.getByTestId('sql-panel')).toHaveAttribute('data-state', 'done')
  await expect(page.getByTestId('sql-input')).toHaveValue(explodeTagsSql(viewName))
  await expect(page.getByTestId('sql-result-header')).toHaveText([
    'id',
    'kind',
    'label',
    'score',
    'deep',
    'meta',
    'events',
    'hole',
    'weird "quoted" key',
    'tags',
    'tags.pos',
  ])
  // 20 rows = Σ list lengths, with the m3-4 NULL-list CASE guard: the two
  // empty lists (id 2, 9) contribute ZERO rows, the NULL lists (id 4, 10)
  // keep one NULL row, NULL elements stay. Order-free: sorted multiset.
  const exploded = await page.locator('[data-testid="sql-result-row"]').evaluateAll((rows) =>
    rows.map((row) => {
      const cells = row.querySelectorAll('[data-testid="sql-result-cell"]')
      const at = (index: number): string => cells[index]?.textContent ?? ''
      return `${at(0)}|${at(9)}|${at(10)}` // id | element | position
    }),
  )
  const expectedExploded = [
    ['1', 'x', '1'],
    ['1', 'y', '2'],
    ['3', 'x', '1'],
    ['3', '', '2'], // NULL element kept, position honest
    ['3', 'z', '3'],
    ['4', '', '1'], // NULL LIST → one NULL row (never silently dropped)
    ['5', 'repeat', '1'],
    ['5', 'repeat', '2'],
    ['6', 'a', '1'],
    ['6', 'b', '2'],
    ['6', 'c', '3'],
    ['6', 'd', '4'],
    ['7', 'solo', '1'],
    ['8', 'x', '1'],
    ['8', 'y', '2'],
    ['10', '', '1'],
    ['11', 'u', '1'],
    ['11', 'v', '2'],
    ['12', 'x', '1'],
    ['12', '', '2'],
  ]
    .map((triple) => triple.join('|'))
    .sort()
  expect(exploded.sort()).toEqual(expectedExploded)
  expect(exploded.filter((tuple) => tuple.startsWith('2|') || tuple.startsWith('9|'))).toEqual([])

  // ---- Fact 4c: ONE CLICK on the `deep.a.b.c` field extracts its path ----
  const deepColumn = page.locator('[data-testid="schema-column"][data-col-name="deep"]')
  await deepColumn.getByRole('button', { name: 'deep STRUCT' }).click()
  const fieldA = deepColumn.locator('[data-field-name="a"]')
  await fieldA.getByRole('button', { name: 'a STRUCT' }).click()
  const fieldB = fieldA.locator('[data-field-name="b"]')
  await fieldB.getByRole('button', { name: 'b STRUCT' }).click()
  const extractC = fieldB
    .locator('[data-field-name="c"]')
    .getByRole('button', { name: 'Extract path deep.a.b.c' })
  await expect(extractC).toBeVisible()
  await extractC.click()
  await expect(page.getByTestId('sql-panel')).toHaveAttribute('data-state', 'done')
  await expect(page.getByTestId('sql-input')).toHaveValue(
    `SELECT "deep"['a']['b']['c'] AS "deep.a.b.c" FROM "${viewName}"`,
  )
  await expect(page.getByTestId('sql-result-header')).toHaveText(['deep.a.b.c'])
  // Fixture-pinned column (CLI: 1,2,3,NULL,5,6,NULL,8,-9,10,NULL,12); one row
  // per source row, NULL deep/a.b.c reads as an empty cell.
  await expect(resultColumn(page, 1)).toHaveText([
    '1',
    '2',
    '3',
    '',
    '5',
    '6',
    '',
    '8',
    '-9',
    '10',
    '',
    '12',
  ])

  // Every action composed and ran: the rejection alert never appeared.
  await expect(page.getByTestId('nested-action-error')).toHaveCount(0)
})

test('tree flatten is keyboard operable too and composes the other struct column (deep)', async ({
  page,
}) => {
  const { viewName } = await openNestedFixture(page)

  const flattenDeep = page
    .getByTestId('schema-panel')
    .getByRole('button', { name: 'Flatten struct column deep' })
  await flattenDeep.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('sql-panel')).toHaveAttribute('data-state', 'done')
  await expect(page.getByTestId('sql-input')).toHaveValue(
    'SELECT "id", "kind", "label", "score", "meta", "tags", "events", "hole", ' +
      '"weird ""quoted"" key", "deep"."a" AS "deep.a" ' +
      `FROM "${viewName}"`,
  )
  await expect(page.getByTestId('sql-result-header')).toHaveText([
    'id',
    'kind',
    'label',
    'score',
    'meta',
    'tags',
    'events',
    'hole',
    'weird "quoted" key',
    'deep.a',
  ])
  await expect(page.locator('[data-testid="sql-result-row"]')).toHaveCount(12)
  await expect(page.getByTestId('nested-action-error')).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// ug-1 / R-01–R-02: nested one-click actions reveal their SQL outcome.
//
// These scenarios start at the shell's REAL collapsed defaults
// (`expandSections: false`), unlike the m3-5 journey above: a successful
// action must open SQL through the existing section seam, scroll it into view
// and focus the outcome that belongs to that request — with no nav click.
// ---------------------------------------------------------------------------

/** The composed flatten statement for the STRUCT column `meta`. */
function flattenMetaSql(viewName: string): string {
  return (
    'SELECT "id", "kind", "label", "score", "deep", "tags", "events", "hole", ' +
    '"weird ""quoted"" key", "meta"."src" AS "meta.src", "meta"."ver" AS "meta.ver" ' +
    `FROM "${viewName}"`
  )
}

/** Count direct activations of the shell nav links (any counts as a nav click). */
async function trackNavClicks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as unknown as { __assayNavClicks?: number }
    state.__assayNavClicks = 0
    for (const link of document.querySelectorAll('[data-testid^="section-nav-"]')) {
      link.addEventListener('click', () => {
        state.__assayNavClicks = (state.__assayNavClicks ?? 0) + 1
      })
    }
  })
}

async function navClickCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __assayNavClicks?: number }).__assayNavClicks ?? 0,
  )
}

test('collapsed defaults: tags header Explode opens SQL, scrolls and focuses the populated result (R-01/R-02)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { viewName } = await openNestedFixture(page, { expandSections: false })

  const sqlToggle = page.getByTestId('section-toggle-sql')
  await expect(sqlToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('#section-sql-content')).toBeHidden()
  await trackNavClicks(page)

  await page.locator('[data-testid="grid-header-nested-action"][data-col-name="tags"]').click()

  // Revealed without a nav click; the section toggle reports the expansion.
  await expect(sqlToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('#section-sql-content')).toBeVisible()
  await expect(page.getByTestId('sql-panel')).toHaveAttribute('data-state', 'done')
  expect(await navClickCount(page)).toBe(0)

  await expect(page.getByTestId('sql-input')).toHaveValue(explodeTagsSql(viewName))
  await expect(page.locator('[data-testid="sql-result-row"]')).toHaveCount(20)
  await expect(page.getByTestId('sql-page-info')).toHaveText('rows 1–20')

  // The outcome itself is the named, keyboard-scrollable focus target.
  const result = page.getByTestId('sql-result')
  await expect(page.locator('#section-sql')).toBeInViewport()
  await expect(result).toBeFocused()
  await expect(result).toHaveAttribute('role', 'region')
  await expect(result).toHaveAttribute('aria-label', 'SQL result — rows 1–20')
  const metrics = await result.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }))
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight)
  await page.keyboard.press('PageDown')
  await expect.poll(async () => result.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)

  // The main grid is unchanged: same row/column identity and data.
  await expect(page.getByTestId('grid-total-rows')).toHaveText('12')
  await expect(page.getByTestId('grid-column-count')).toHaveText('10')
  await expect(
    page.locator('[data-testid="grid-row"][data-row-index="0"]').getByTestId('grid-cell').nth(5),
  ).toHaveText('{"src":"sensor-a","ver":1}')
})

test('collapsed defaults: schema-tree STRUCT Flatten opens SQL and focuses its result (R-01/R-02)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { viewName } = await openNestedFixture(page, { expandSections: false })
  await expect(page.getByTestId('section-toggle-sql')).toHaveAttribute('aria-expanded', 'false')

  await page
    .getByTestId('schema-panel')
    .getByRole('button', { name: 'Flatten struct column meta' })
    .click()

  await expect(page.getByTestId('section-toggle-sql')).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('sql-panel')).toHaveAttribute('data-state', 'done')
  await expect(page.getByTestId('sql-input')).toHaveValue(flattenMetaSql(viewName))
  await expect(page.locator('[data-testid="sql-result-row"]')).toHaveCount(12)
  await expect(page.getByTestId('sql-result')).toBeFocused()
  await expect(page.getByTestId('sql-result')).toHaveAttribute(
    'aria-label',
    'SQL result — rows 1–12',
  )
})

test('rail-collapsed pane expands for a header Explode and focuses the result (R-01)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openNestedFixture(page, { expandSections: false })

  await page.getByTestId('pane-toggle').click()
  await expect(page.locator('.workbench-layout')).toHaveAttribute('data-pane', 'collapsed')
  await expect(page.locator('#workbench-tools-body')).toHaveAttribute('hidden', '')

  await page.locator('[data-testid="grid-header-nested-action"][data-col-name="tags"]').click()

  await expect(page.locator('.workbench-layout')).toHaveAttribute('data-pane', 'expanded')
  await expect(page.locator('#workbench-tools-body')).not.toHaveAttribute('hidden', '')
  await expect(page.locator('#section-sql-content')).toBeVisible()
  await expect(page.locator('#section-sql')).toBeInViewport()
  await expect(page.getByTestId('sql-panel')).toHaveAttribute('data-state', 'done')
  await expect(page.getByTestId('sql-result')).toBeFocused()
})

test('900px fallback: schema Explode reveals SQL, focuses the result and scrolls the page (R-01/R-02)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 900 })
  const { viewName } = await openNestedFixture(page, { expandSections: false })
  await expect(page.getByTestId('section-toggle-sql')).toHaveAttribute('aria-expanded', 'false')

  await page
    .getByTestId('schema-panel')
    .getByRole('button', { name: 'Explode list column tags' })
    .click()

  await expect(page.getByTestId('section-toggle-sql')).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('#section-sql-content')).toBeVisible()
  await expect(page.getByTestId('sql-input')).toHaveValue(explodeTagsSql(viewName))
  await expect(page.getByTestId('sql-result')).toBeFocused()
  await expect.poll(async () => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
})
