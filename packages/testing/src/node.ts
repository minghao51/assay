/**
 * Node-only helpers for tests and tooling (kept out of index.ts so the
 * package stays importable from browser test contexts later).
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Resolve the repository's `fixtures/` root from a module URL. The anchor is
 * this module's own location — `packages/testing/src/node.ts` unbuilt or
 * `packages/testing/dist/node.js` built, both three levels below the repo
 * root — **never** `process.cwd()`, so resolution is correct whatever
 * directory the runner was launched from (AR-F2). Throws a readable error
 * when the root is absent, so a relocated package fails loudly instead of
 * silently resolving somewhere else.
 */
export function resolveFixturesRoot(moduleUrl: string = import.meta.url): string {
  const repoRoot = fileURLToPath(new URL('../../..', moduleUrl))
  const root = join(repoRoot, 'fixtures')
  if (!existsSync(root)) {
    throw new Error(
      `fixture root not found at ${root} — @assay/testing must live inside the repository; ` +
        `fixtures/ is resolved relative to this module (${moduleUrl}), never the process cwd`,
    )
  }
  return root
}

/** Absolute path to a golden fixture under `<repo>/fixtures/`. */
export function fixturePath(relative: string): string {
  return resolve(resolveFixturesRoot(), relative)
}
