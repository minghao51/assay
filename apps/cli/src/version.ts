// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The CLI version, read from the package's own `package.json` (q-4 / AR-C6).
 *
 * Single source of truth: the published `@assay/cli` version is the
 * `package.json` `version`, and `--version`/the help banner must print THAT —
 * never a hand-maintained constant that can drift from the manifest. The
 * file is one directory above both layouts the entry runs from (`src/` under
 * `tsx`, `dist/` under plain `node`), so the same relative URL resolves in
 * the repo and in an installed package. Reading it is synchronous, tiny, and
 * imports nothing from the engine — `--version` still exits without the
 * command graph (ADR 0042).
 *
 * The reader is total: a missing/garbled manifest degrades to the historical
 * `0.0.0` fallback rather than throwing before `--version` can answer.
 */
import { readFileSync } from 'node:fs'

/** The version when the manifest cannot be read (should not happen). */
export const VERSION_FALLBACK = '0.0.0'

/** Read `<package root>/package.json`'s `version`, or the fallback. */
export function readCliVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && 'version' in parsed) {
      const version = (parsed as { version?: unknown }).version
      if (typeof version === 'string' && version.length > 0) return version
    }
  } catch {
    // fall through to the fallback — `--version` must never crash
  }
  return VERSION_FALLBACK
}
