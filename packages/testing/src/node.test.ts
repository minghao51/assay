// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fixturePath, resolveFixturesRoot } from './node'

/**
 * Fixture-path resolution pins (AR-F2): the anchor is the module URL, never
 * `process.cwd()`. The chdir probe lives in this file alone (vitest isolates
 * files into workers by default) and always restores the cwd in `afterEach`.
 */
describe('fixturePath — repo-anchored, not cwd-anchored (AR-F2)', () => {
  const originalCwd = process.cwd()
  afterEach(() => {
    process.chdir(originalCwd)
  })

  it('resolves fixtures relative to the module even when cwd is a package dir', () => {
    const fromRepoRoot = fixturePath('parquet/manifest.json')
    expect(existsSync(fromRepoRoot)).toBe(true)

    process.chdir(resolve(originalCwd, 'packages/domain'))
    expect(fixturePath('parquet/manifest.json')).toBe(fromRepoRoot)
    expect(existsSync(fixturePath('parquet/manifest.json'))).toBe(true)
  })

  it('resolveFixturesRoot asserts the anchor exists, with a readable message', () => {
    let error: unknown
    try {
      resolveFixturesRoot('file:///nonexistent/a/b/c/node.ts')
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('fixture root not found')
    expect((error as Error).message).toContain('never the process cwd')
  })
})
