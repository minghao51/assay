import path from 'node:path'
import { stat } from 'node:fs/promises'
import { expect, test } from './support/fixture'
import type { ExtensionServeLog } from './support/fixture'
import type { Page } from '@playwright/test'
import { openFixture } from './support/fixtures'

/**
 * hf-1: the deterministic-extension proof.
 *
 * `docs/process/handoff/20261104-svg-implementation-map.md` §6.6 recorded an open
 * class of full-suite failures: DuckDB-WASM autoloads its Parquet/JSON
 * extensions from `https://extensions.duckdb.org` at runtime, so the
 * fixture-open phase of the browser gate depended on a third-party CDN and
 * failed at random under contention (isolated reruns always passed). The
 * harness now serves the already-committed, checksum-pinned binaries through a
 * context route (`./support/fixture`). This spec pins that:
 *
 *   1. Parquet **and** JSONL open to `ready` (the two autoloading readers),
 *   2. the route really fulfilled those requests — from the pinned files on
 *      disk, with no abort and no request left to reach the host,
 *   3. an autoload path with no pinned binary is aborted rather than allowed
 *      out to the network, so a future extension dependency fails visibly.
 *
 * The assertions are provenance-based (bytes == the committed file's size)
 * rather than URL-version-based, so a deliberate re-vendor is a one-fixture
 * change rather than a spec rewrite.
 */

const EXTENSION_ORIGIN = 'https://extensions.duckdb.org'
const PINNED_DIR = path.join(process.cwd(), 'apps', 'vscode', 'assets', 'duckdb')

const PARQUET_FIXTURE = path.join(process.cwd(), 'fixtures', 'parquet', 'customers.parquet')
const JSONL_FIXTURE = path.join(process.cwd(), 'fixtures', 'jsonl', 'nested.jsonl')

// Picker path shared with every web spec: remove the FSA global so the hidden
// `<input type="file">` fallback drives Playwright's filechooser event.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    } catch {
      // Non-configurable global: the chooser assertion fails loudly instead.
    }
  })
})

/** Collect the extension URLs the page itself reports (the bypass detector). */
function observeExtensionRequests(page: Page): string[] {
  const urls: string[] = []
  page.on('request', (request) => {
    if (request.url().startsWith(`${EXTENSION_ORIGIN}/`)) urls.push(request.url())
  })
  return urls
}

/**
 * Pin one extension's interception. `requested` is what the page reported; the
 * log is what the route actually served. A run that reached the host instead
 * of the route cannot satisfy these assertions: `served` would be empty and the
 * route log's provenance checks have nothing to pass on.
 */
async function expectServedFromPinned(
  log: ExtensionServeLog,
  basename: string,
  requested: readonly string[],
): Promise<void> {
  const served = log.served.filter((entry) => entry.basename === basename)

  // 1. The route fulfilled at least one request for this extension.
  expect(served.length, `route fulfilled ${basename}`).toBeGreaterThan(0)

  // 2. It answered the host's real autoload path — not some other URL shape.
  for (const entry of served) {
    expect(entry.url.startsWith(`${EXTENSION_ORIGIN}/`), entry.url).toBe(true)
  }

  // 3. The bytes came from the committed, checksum-pinned binary: the served
  //    length equals the pinned file's size on disk (no download, no copy).
  const pinnedPath = path.join(PINNED_DIR, `${basename}.pinned`)
  const pinned = await stat(pinnedPath)
  for (const entry of served) {
    expect(entry.pinnedPath).toBe(pinnedPath)
    expect(entry.bytes).toBe(pinned.size)
  }

  // 4. No autoload path went unserved on this context.
  expect(log.aborted).toEqual([])

  // 5. Nothing bypassed the route: every extension request the page reported is
  //    one the route fulfilled. (If Playwright does not surface a worker-level
  //    request, this list is shorter — never contradictory — and step 1 still
  //    proves interception.)
  const servedUrls = log.served.map((entry) => entry.url)
  for (const url of requested) {
    expect(servedUrls, `unintercepted extension request ${url}`).toContain(url)
  }
}

test('a Parquet open is served the committed pinned extension, never the host', async ({
  page,
  duckdbExtensions,
}) => {
  const requested = observeExtensionRequests(page)

  // Opening the committed golden fixture goes through the app's real picker
  // path and waits for `data-phase="ready"` (the extension has loaded by then).
  await openFixture(page, PARQUET_FIXTURE, { expandSections: false })
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')

  await expectServedFromPinned(duckdbExtensions, 'parquet.duckdb_extension.wasm', requested)
})

test('a JSONL open is served the committed pinned extension, never the host', async ({
  page,
  duckdbExtensions,
}) => {
  const requested = observeExtensionRequests(page)

  await openFixture(page, JSONL_FIXTURE, { expandSections: false })
  await expect(page.getByTestId('grid-total-rows')).toHaveText('12')

  await expectServedFromPinned(duckdbExtensions, 'json.duckdb_extension.wasm', requested)
})

test('an autoload path with no pinned binary is aborted, not sent to the host', async ({
  page,
  duckdbExtensions,
}) => {
  const unknownUrl = `${EXTENSION_ORIGIN}/v1.4.3/wasm_mvp/no-such-extension.duckdb_extension.wasm`
  // Navigating first keeps the fetch same-page (a browser request the context
  // route owns) rather than an opaque-origin one from `about:blank`.
  await page.goto('/')

  const outcome = await page.evaluate(async (url) => {
    try {
      const response = await fetch(url)
      return `status:${response.status}`
    } catch {
      return 'network-error'
    }
  }, unknownUrl)

  // Fail-closed: the route aborted the request (a served response here would
  // mean the harness let a future extension reach the third-party host).
  expect(outcome).toBe('network-error')
  expect(duckdbExtensions.aborted).toEqual([unknownUrl])
  expect(duckdbExtensions.served).toEqual([])
})
