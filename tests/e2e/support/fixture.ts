import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { test as base } from '@playwright/test'
import type { BrowserContext, Route } from '@playwright/test'

/**
 * hf-1: the deterministic DuckDB-WASM extension fixture.
 *
 * The web build runs DuckDB-WASM, whose `read_parquet` / JSON readers
 * **autoload** their extensions over the network from
 * `https://extensions.duckdb.org` at runtime (the VS Code webview documents the
 * same behaviour and answers it locally — see
 * `apps/vscode/assets/duckdb/VENDORED_ASSETS.md`). The engine build statically
 * links CSV only, so before this fixture every Parquet/JSONL open in the
 * browser suite depended on a third-party CDN and the full suite failed at
 * random in the open phase (`docs/process/handoff/20261104-svg-implementation-map.md`
 * §6.6).
 *
 * This module registers ONE route on every browser **context** — before any
 * page exists, so a spec that navigates straight to `/` or to an engine harness
 * URL is covered exactly like one that opens through `openFixture` — and
 * fulfils it from the **already committed, checksum-pinned** binaries in
 * `apps/vscode/assets/duckdb/<basename>.pinned` with
 * `contentType: 'application/wasm'`. The binaries are never copied,
 * regenerated or re-downloaded: `apps/vscode/scripts/build.mjs` verifies their
 * SHA-256 against the lockfile-pinned package, which is what makes them a
 * trustworthy stand-in for the CDN bytes.
 *
 * No pinned binary for a requested autoload path ⇒ the request is **aborted**
 * (loudly, on stderr) instead of being allowed through. A future extension
 * dependency therefore fails the test that needs it instead of silently
 * reaching for the network — the failure is the point.
 *
 * Specs import `test`/`expect` from here rather than `@playwright/test`. Routes
 * are per-context, so a route registered only inside `openFixture` would miss
 * the specs that `goto` directly; the fixture is the only placement that gives
 * every context the same network surface.
 */

export { expect } from '@playwright/test'
// Type-only re-export so a spec with a mixed import
// (`import { expect, test, type Page } from './support/fixture'`) keeps a
// single import line. Values are deliberately NOT re-exported: `test` and
// `expect` above are the fixture's own.
export type * from '@playwright/test'

/** Host DuckDB-WASM autoloads extensions from, in the build the suite runs. */
export const EXTENSION_ORIGIN = 'https://extensions.duckdb.org'

/** Playwright route pattern covering every autoload path on that host. */
const EXTENSION_ROUTE = `${EXTENSION_ORIGIN}/**`

/** Committed, checksum-pinned binaries (the `.pinned` suffix keeps formatters off them). */
const PINNED_DIR = path.join(process.cwd(), 'apps', 'vscode', 'assets', 'duckdb')
const PINNED_SUFFIX = '.pinned'

/** One extension request the route fulfilled from a pinned binary. */
export interface ExtensionServe {
  /** The full autoload URL the engine requested. */
  readonly url: string
  /** Its file name, e.g. `parquet.duckdb_extension.wasm`. */
  readonly basename: string
  /** The committed binary that answered it. */
  readonly pinnedPath: string
  /** Bytes served (equal to the pinned file's size; the proof spec pins this). */
  readonly bytes: number
}

/** What the route did on this context, in request order. */
export interface ExtensionServeLog {
  /** Fulfilled extension requests — each one proved the request never left the browser. */
  readonly served: ExtensionServe[]
  /** Aborted extension requests (no pinned binary); non-empty is a harness gap. */
  readonly aborted: string[]
}

/**
 * Read-once cache: the Parquet extension is ~2.9 MB and a full-suite run opens
 * it in every context, so each worker reads the committed bytes at most once.
 */
const pinnedReads = new Map<string, Promise<Buffer>>()

function readPinned(pinnedPath: string): Promise<Buffer> {
  const cached = pinnedReads.get(pinnedPath)
  if (cached !== undefined) return cached
  const read = readFile(pinnedPath).catch((error: unknown) => {
    // Never cache a rejection: a transient read failure must not poison the
    // rest of the worker.
    pinnedReads.delete(pinnedPath)
    throw error
  })
  pinnedReads.set(pinnedPath, read)
  return read
}

async function serveFromPinned(route: Route, log: ExtensionServeLog): Promise<void> {
  const url = route.request().url()
  const basename = path.basename(new URL(url).pathname)
  const pinnedPath = path.join(PINNED_DIR, `${basename}${PINNED_SUFFIX}`)
  let body: Buffer
  try {
    body = await readPinned(pinnedPath)
  } catch (error) {
    log.aborted.push(url)
    // Loud on purpose: an unknown autoload path is a harness gap, and the
    // abort makes the dependent open fail visibly instead of going to the CDN.
    console.error(
      `[e2e] DuckDB-WASM requested ${url} but no pinned binary is committed at ` +
        `${pinnedPath} (${error instanceof Error ? error.message : String(error)}); ` +
        'aborting — the harness never falls back to the third-party host.',
    )
    await route.abort('failed')
    return
  }
  log.served.push({ url, basename, pinnedPath, bytes: body.byteLength })
  await route.fulfill({ status: 200, contentType: 'application/wasm', body })
}

/**
 * Install the pinned-extension route on a context. Exported for the one spec
 * shape the fixture cannot reach: `bench-ttfr.spec.ts` opens its own page via
 * `browser.newPage()`, which creates a *fresh* context.
 */
export async function servePinnedExtensions(context: BrowserContext): Promise<ExtensionServeLog> {
  const log: ExtensionServeLog = { served: [], aborted: [] }
  await context.route(EXTENSION_ROUTE, async (route) => {
    await serveFromPinned(route, log)
  })
  return log
}

/** Per-context serve log, so the `context` fixture and the opt-in reader share one record. */
const serveLogs = new WeakMap<BrowserContext, ExtensionServeLog>()

/**
 * The suite's `test`. Everything from `@playwright/test` is available
 * unchanged; the only addition is that each context gets the pinned
 * extension route and that `duckdbExtensions` exposes what the route did.
 */
// `react-hooks/rules-of-hooks` reads Playwright's fixture callback (`use`) as a
// React hook; these two fixtures are the suite's only `test.extend` call sites,
// and the repo config is not this task's to change (hf-1 is harness-only).
/* eslint-disable react-hooks/rules-of-hooks */
export const test = base.extend<{ duckdbExtensions: ExtensionServeLog }>({
  // Registered before the context's first page navigates, so the interception
  // covers the whole suite, not just the helper-driven opens.
  context: async ({ context }, use) => {
    serveLogs.set(context, await servePinnedExtensions(context))
    await use(context)
    serveLogs.delete(context)
  },
  /**
   * Opt-in observation (`wasm-cache.spec.ts` pins the determinism claim with
   * it). A spec that doesn't ask for it pays nothing beyond the route itself.
   */
  duckdbExtensions: async ({ context }, use) => {
    const log = serveLogs.get(context)
    if (log === undefined) {
      throw new Error('the pinned DuckDB-WASM extension route is not installed on this context')
    }
    await use(log)
  },
})
/* eslint-enable react-hooks/rules-of-hooks */
