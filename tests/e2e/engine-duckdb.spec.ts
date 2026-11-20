import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './support/fixture'
import { sha256Bytes } from './support/hash'

// Task M1-2 proof (handoff §6 #2): `query()` returns the first Apache Arrow
// record batch to the main thread (ADR 0020) over the typed postMessage
// protocol (ADR 0021). DuckDB-WASM cannot run under Node vitest — this e2e
// is the authoritative proof. The harness renders results strictly through
// the Arrow API (schema fields, batch row counts, vector reads) so these
// assertions exercise real Arrow reconstitution, not JSON string comparison.
// Harness served from packages/engine-duckdb by the second webServer in
// playwright.config.ts.
// Engine-harness port is env-overridable for parallel worktree batches
// (must match ASSAY_E2E_PORT_ENGINE in playwright.config.ts; default 4179).
const HARNESS_URL = `http://localhost:${process.env['ASSAY_E2E_PORT_ENGINE'] ?? 4179}/`

// Task M1-4 adds the file-lifecycle proof: open (OPFS-staged genuine
// FileSystemFileHandle — same trick as the data-sources harness, ADR 0017
// disposable-cache framing) → schema() → Arrow-backed fetchRange windows,
// failed-query-then-reuse, and nested type-string passthrough.
const REPO_ROOT = process.cwd()
const FIXTURE_BYTES: Record<string, Buffer> = {}

function fixtureBytes(relativePath: string): Buffer {
  FIXTURE_BYTES[relativePath] ??= readFileSync(path.join(REPO_ROOT, relativePath))
  return FIXTURE_BYTES[relativePath]
}

test('harness fixture copies are byte-identical to the golden fixtures (manifest checksums)', async () => {
  // Copies live in the harness public dir so the page can stage real handles.
  // They must never drift from fixtures/parquet + manifest.json.
  const manifest = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'fixtures/parquet/manifest.json'), 'utf8'),
  ) as { files: Array<{ name: string; sha256: string }> }
  for (const name of ['customers.parquet', 'nested.parquet']) {
    const golden = fixtureBytes(`fixtures/parquet/${name}`)
    const copy = fixtureBytes(`packages/engine-duckdb/harness/public/fixtures/${name}`)
    const manifestEntry = manifest.files.find((file) => file.name === name)
    expect(manifestEntry, `${name} is listed in the manifest`).toBeTruthy()
    expect(sha256Bytes(golden), `fixtures/parquet/${name} matches manifest.json`).toBe(
      manifestEntry!.sha256,
    )
    expect(copy.equals(golden), `harness copy of ${name} is byte-identical`).toBe(true)
  }
})

test('engine-duckdb boots lazily in a worker and query() returns the first Arrow batch', async ({
  page,
}) => {
  await page.goto(HARNESS_URL)

  // Laziness: loading the page must not boot the engine.
  await expect(page.getByTestId('engine-status')).toHaveText('idle')

  await page.getByRole('button', { name: 'Boot engine and run SELECT 42 AS answer' }).click()

  // The real DuckDB engine answered; the result was reconstituted on the main
  // thread as an Arrow table and read back through the Arrow API.
  await expect(page.getByTestId('engine-status')).toHaveText('ready')
  await expect(page.getByTestId('duckdb-version')).toContainText(/v\d+\.\d+/)
  await expect(page.getByTestId('arrow-schema')).toHaveText('answer:Int32')
  await expect(page.getByTestId('arrow-num-rows')).toHaveText('1')
  await expect(page.getByTestId('arrow-value')).toHaveText('42')
  await expect(page.getByTestId('query-has-more')).toHaveText('false')
})

test('multi-batch result reports hasMore and the engine stays usable after the tail is cancelled', async ({
  page,
}) => {
  await page.goto(HARNESS_URL)
  await page.getByRole('button', { name: /range\(5000\)/ }).click()

  // DuckDB streams range(5000) in 2048-row Arrow batches: the first batch is
  // transported, hasMore reports the discarded tail honestly, and the worker
  // cancelled the pending query — the follow-up SELECT must still answer 7.
  await expect(page.getByTestId('engine-status')).toHaveText('ready')
  await expect(page.getByTestId('arrow-schema-range')).toHaveText('i:Int64')
  await expect(page.getByTestId('arrow-num-rows-range')).toHaveText('2048')
  await expect(page.getByTestId('query-has-more-range')).toHaveText('true')
  await expect(page.getByTestId('post-cancel-value')).toHaveText('7')
})

test('opens a staged fixture, serves its DESCRIBE schema and Arrow-backed row windows', async ({
  page,
}) => {
  await page.goto(HARNESS_URL)
  // Laziness: loading the page must not boot the engine.
  await expect(page.getByTestId('engine-status')).toHaveText('idle')

  // Open: the staged FileSystemFileHandle crosses the EngineFileSource seam;
  // the worker registers it with DuckDB and creates the view. The UI shows
  // the table id and status — never a file name (ADR 0025).
  await page.getByRole('button', { name: 'Open flat fixture via engine' }).click()
  await expect(page.getByTestId('engine-status')).toHaveText('ready')
  await expect(page.getByTestId('open-status-flat')).toHaveText('opened', { timeout: 20_000 })
  await expect(page.getByTestId('open-table-id-flat')).toHaveText('t1')

  // Schema: DuckDB's DESCRIBE type strings pass through as-is.
  await page.getByRole('button', { name: 'Read schema of opened flat fixture' }).click()
  await expect(page.getByTestId('schema-flat')).toHaveText(
    'customer_id:BIGINT, country:VARCHAR, income:BIGINT, signup_date:DATE',
  )
  await expect(page.getByTestId('schema-count-flat')).toHaveText('4')

  // First window [0,5): known fixture rows via the Arrow vector API —
  // including the NULL income of customer 3 (rendered as `null`).
  await page.getByRole('button', { name: 'fetchRange rows 0–5 (first window)' }).click()
  await expect(page.getByTestId('range-first-values')).toHaveText('1|2|3|4|5')
  await expect(page.getByTestId('range-first-countries')).toHaveText('SG|US|SG|DE|US')
  await expect(page.getByTestId('range-first-income')).toHaveText('52000|61000|null|48000|75000')
  await expect(page.getByTestId('range-first-num-rows')).toHaveText('5')
  await expect(page.getByTestId('range-first-has-more')).toHaveText('false')

  // Middle window [2,4): proves OFFSET correctness — exactly rows 2 and 3,
  // and the income slice starts at the NULL then continues with 48000.
  await page.getByRole('button', { name: 'fetchRange rows 2–4 (middle window)' }).click()
  await expect(page.getByTestId('range-middle-values')).toHaveText('3|4')
  await expect(page.getByTestId('range-middle-countries')).toHaveText('SG|DE')
  await expect(page.getByTestId('range-middle-income')).toHaveText('null|48000')
  await expect(page.getByTestId('range-middle-num-rows')).toHaveText('2')
  await expect(page.getByTestId('range-middle-has-more')).toHaveText('false')
})

test('schema() passes nested DuckDB type strings through unchanged', async ({ page }) => {
  await page.goto(HARNESS_URL)

  await page.getByRole('button', { name: 'Open nested fixture via engine' }).click()
  await expect(page.getByTestId('engine-status')).toHaveText('ready')
  await expect(page.getByTestId('open-status-nested')).toHaveText('opened', { timeout: 20_000 })
  await expect(page.getByTestId('open-table-id-nested')).toHaveText('t1')

  // The nested column arrives as its full SQL type string — exactly what
  // DuckDB's DESCRIBE reports (m1-6 renders these in the schema tree).
  await page.getByRole('button', { name: 'Read schema of opened nested fixture' }).click()
  await expect(page.getByTestId('schema-nested')).toHaveText(
    'id:BIGINT, payload:STRUCT("name" VARCHAR, geo STRUCT(lat DECIMAL(21,1), lon DECIMAL(21,1)), ' +
      'tags VARCHAR[], scores STRUCT(q1 DOUBLE, q2 INTEGER))',
  )
  await expect(page.getByTestId('schema-count-nested')).toHaveText('2')
})

test('a failed query rejects with the engine error and the engine stays reusable', async ({
  page,
}) => {
  await page.goto(HARNESS_URL)

  await page.getByRole('button', { name: 'Run invalid SQL, then SELECT 7 AS seven' }).click()

  // The invalid SQL rejected through the typed protocol with the engine's REAL
  // message (ADR 0048): the catalog/binder error for the missing table, on the
  // `eh` bundle this browser selects. Before R1-A the shipped `mvp` glue masked
  // every failure as `ReferenceError: _setThrew is not defined`, so this
  // assertion — not just "something rejected" — is the honest-text proof.
  const queryError = page.getByTestId('query-error')
  await expect(queryError).toContainText('Catalog Error')
  await expect(queryError).toContainText('Table with name __assay_no_such_table__ does not exist')
  await expect(queryError).not.toContainText('_setThrew')
  await expect(queryError).not.toHaveText('not run')
  await expect(queryError).not.toHaveText('no error reported (unexpected)')
  await expect(queryError).not.toHaveText('')
  // The engine's diagnostic is multi-line (summary + hint + the offending SQL),
  // and the raw text is what crossed the protocol — the engine's own summary is
  // its first line.
  const reported = (await queryError.textContent()) ?? ''
  expect(reported.split('\n')[0]).toBe(
    'Catalog Error: Table with name __assay_no_such_table__ does not exist!',
  )

  // …and the follow-up query still answers: worker + connection survived.
  await expect(page.getByTestId('post-error-value')).toHaveText('7')
  await expect(page.getByTestId('engine-status')).toHaveText('ready')
})

// C04: every dispose() caller awaits the same real-engine teardown. The
// pre-C04 client short-circuited a second dispose() on the terminal status, so
// it resolved while the graceful handshake and the worker termination were
// still in flight — visible here as a settlement order that starts with the
// second caller.
test('every dispose() caller awaits the same real-engine teardown (C04)', async ({ page }) => {
  await page.goto(HARNESS_URL)
  await page.getByRole('button', { name: 'Dispose twice concurrently' }).click()
  const element = page.getByTestId('dispose-twice-result')
  await expect(element).not.toHaveText('not run', { timeout: 60_000 })
  const facts = JSON.parse((await element.textContent())!) as {
    booted?: boolean
    firstQueryValue?: string
    settlementOrder?: string[]
    bothSettled?: boolean
    statusAfter?: string
    postDisposeRejected?: boolean
    repeatedDisposeResolved?: boolean
    fatal?: string
  }

  expect(facts.fatal).toBeUndefined()
  expect(facts.booted).toBe(true)
  expect(facts.firstQueryValue).toBe('7')
  expect(facts.bothSettled).toBe(true)
  // The first dispose() settles first: the second awaited the same teardown.
  expect(facts.settlementOrder).toEqual(['first', 'second'])
  expect(facts.statusAfter).toBe('disposed')
  expect(facts.postDisposeRejected).toBe(true)
  expect(facts.repeatedDisposeResolved).toBe(true)
})
