import path from 'node:path'
import { stat } from 'node:fs/promises'
import { expect, pinnedPathFor, test } from './support/fixture'
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
 *      out to the network, so a future extension dependency fails visibly,
 *   4. the served platform is the one the engine's selected bundle asked for
 *      (ADR 0048): this Chromium supports wasm exception handling, so the
 *      engine selects the `eh` pair and DuckDB autoloads `/wasm_eh/…`, which
 *      the route answers with the committed `.eh.pinned` binary.
 *
 * The assertions are provenance-based (bytes == the committed file's size,
 * platform == the URL's platform segment) rather than URL-version-based, so a
 * deliberate re-vendor is a one-fixture change rather than a spec rewrite.
 *
 * File identity is pinned **absolutely** ({@link WASM_EH_PINNED}): the served
 * `.eh.pinned` name and its committed byte count are literals here, not derived
 * from the fixture's own platform→suffix map. Deriving both sides with
 * `pinnedPathFor()` would be circular — a `PLATFORM_PINNED_SUFFIX` regression
 * (`wasm_eh → '.pinned'`) would still pass every derived check, because DuckDB
 * happily loads the wrong-platform extension bytes.
 */

const EXTENSION_ORIGIN = 'https://extensions.duckdb.org'

const PARQUET_FIXTURE = path.join(process.cwd(), 'fixtures', 'parquet', 'customers.parquet')
const JSONL_FIXTURE = path.join(process.cwd(), 'fixtures', 'jsonl', 'nested.jsonl')

/**
 * The **absolute** `wasm_eh` file pins (ADR 0048 / R1-A).
 *
 * These file names and byte counts are literals on purpose. The platform and
 * URL assertions prove which autoload path the engine requested; only an
 * absolute pin proves which committed FILE answered it. Computing the expected
 * path with the fixture's `pinnedPathFor()` on both sides makes the check
 * circular: with `PLATFORM_PINNED_SUFFIX.wasm_eh` regressed to `'.pinned'` the
 * route would serve the `wasm_mvp` bytes and every derived assertion would
 * still pass (measured by the reviewer: 3 passed), because DuckDB accepts the
 * wrong-platform extension bytes.
 *
 * A deliberate re-vendor must update these two numbers in the same commit —
 * that is the point of the pin. The sizes are the committed files':
 * `parquet.duckdb_extension.wasm.eh.pinned` 3,045,039 B sha256 `22765c8f…4f55`,
 * `json.duckdb_extension.wasm.eh.pinned` 820,646 B sha256 `b997276c…302e9`.
 */
const WASM_EH_PINNED: Readonly<Record<string, { readonly file: string; readonly bytes: number }>> =
  {
    'parquet.duckdb_extension.wasm': {
      file: 'parquet.duckdb_extension.wasm.eh.pinned',
      bytes: 3_045_039,
    },
    'json.duckdb_extension.wasm': {
      file: 'json.duckdb_extension.wasm.eh.pinned',
      bytes: 820_646,
    },
  }

/** The committed pinned-binary directory, independently of the fixture's own constant. */
const PINNED_DIR = path.join(process.cwd(), 'apps', 'vscode', 'assets', 'duckdb')

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

  // 3. Route↔fixture consistency: the served length equals the size of the
  //    file the fixture chose for this platform (no download, no copy). This is
  //    deliberately the *derived* path — and therefore not the file-identity
  //    proof: `expectServedAbsoluteEhFile` below pins WHICH committed file must
  //    answer a `wasm_eh` request, with a literal name and literal byte count.
  for (const entry of served) {
    const pinnedPath = pinnedPathFor(entry.platform, basename)
    expect(entry.pinnedPath).toBe(pinnedPath)
    const pinned = await stat(pinnedPath)
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

/**
 * Prove WHICH committed file answered a `wasm_eh` autoload request, without
 * asking the fixture's mapping what the answer should be: the served path must
 * be the literal `.eh.pinned` file in the committed assets directory, and the
 * served byte count must be that file's known committed size.
 *
 * This is the non-circular half of the proof: `expectServedFromPinned` pins the
 * request path (platform + URL), this pins the file. A wrong-platform mapping
 * regression passes the former and fails here.
 */
function expectServedAbsoluteEhFile(log: ExtensionServeLog, basename: string): void {
  const pin = WASM_EH_PINNED[basename]
  expect(pin, `an absolute wasm_eh file pin exists for ${basename}`).toBeDefined()
  if (pin === undefined) return

  const served = log.served.filter((entry) => entry.basename === basename)
  expect(served.length, `route fulfilled ${basename}`).toBeGreaterThan(0)

  for (const entry of served) {
    // The platform tag still has to be the EH one — cheap, and it keeps this
    // helper honest if it is ever reused for an mvp leg.
    expect(entry.platform, entry.pinnedPath).toBe('wasm_eh')
    // Absolute file identity: literal name (basename AND its committed
    // directory) and literal committed size — never `pinnedPathFor()`.
    expect(path.basename(entry.pinnedPath), `served file for ${basename}`).toBe(pin.file)
    expect(entry.pinnedPath).toBe(path.join(PINNED_DIR, pin.file))
    expect(entry.bytes, `served bytes of ${pin.file}`).toBe(pin.bytes)
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

  // 6. The end-to-end bundle-selection proof (ADR 0048 / R1-A): this Chromium
  //    validates the wasm exception-handling probe, so the engine selected the
  //    `eh` DuckDB-WASM pair and the Parquet extension it autoloaded is the
  //    `wasm_eh` platform build — served from the committed `.eh.pinned`
  //    binary. A run that fell back to `mvp` would serve `/wasm_mvp/…` from
  //    `*.pinned` and fail here.
  const parquetServes = duckdbExtensions.served.filter(
    (entry) => entry.basename === 'parquet.duckdb_extension.wasm',
  )
  expect(parquetServes.map((entry) => entry.platform)).toEqual(['wasm_eh'])
  expect(parquetServes[0]?.url).toContain('/wasm_eh/')

  // 7. …and the FILE that answered it is the committed `.eh.pinned` binary, by
  //    literal name and literal committed size (absolute, not derived from the
  //    fixture's platform→suffix map — see {@link WASM_EH_PINNED}).
  expectServedAbsoluteEhFile(duckdbExtensions, 'parquet.duckdb_extension.wasm')
})

test('a JSONL open is served the committed pinned extension, never the host', async ({
  page,
  duckdbExtensions,
}) => {
  const requested = observeExtensionRequests(page)

  await openFixture(page, JSONL_FIXTURE, { expandSections: false })
  await expect(page.getByTestId('grid-total-rows')).toHaveText('12')

  await expectServedFromPinned(duckdbExtensions, 'json.duckdb_extension.wasm', requested)

  // The same absolute file pin as the Parquet leg: this Chromium selected the
  // `eh` bundle, so the JSON reader's `wasm_eh` extension must be the committed
  // `json.duckdb_extension.wasm.eh.pinned` (820,646 B).
  const jsonServes = duckdbExtensions.served.filter(
    (entry) => entry.basename === 'json.duckdb_extension.wasm',
  )
  expect(jsonServes.map((entry) => entry.platform)).toEqual(['wasm_eh'])
  expect(jsonServes[0]?.url).toContain('/wasm_eh/')
  expectServedAbsoluteEhFile(duckdbExtensions, 'json.duckdb_extension.wasm')
})

test('a platform-less autoload path is aborted, not sent to the host', async ({
  page,
  duckdbExtensions,
}) => {
  // The route serves extensions only for a known platform tag (`wasm_eh` /
  // `wasm_mvp`); anything else is a harness gap and is aborted rather than
  // guessed at. Proven here so the fail-closed arm is not code-only.
  const platformlessUrl = `${EXTENSION_ORIGIN}/v1.4.3/parquet.duckdb_extension.wasm`
  await page.goto('/')

  const outcome = await page.evaluate(async (url) => {
    try {
      const response = await fetch(url)
      return `status:${response.status}`
    } catch {
      return 'network-error'
    }
  }, platformlessUrl)

  expect(outcome).toBe('network-error')
  expect(duckdbExtensions.aborted).toEqual([platformlessUrl])
  expect(duckdbExtensions.served).toEqual([])
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
