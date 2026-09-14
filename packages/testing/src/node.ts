/**
 * Node-only helpers for tests and tooling (kept out of index.ts so the
 * package stays importable from browser test contexts later).
 */
import { resolve } from 'node:path'

/** Absolute path to a golden fixture under `<repo>/fixtures/`. */
export function fixturePath(relative: string): string {
  return resolve(process.cwd(), 'fixtures', relative)
}
