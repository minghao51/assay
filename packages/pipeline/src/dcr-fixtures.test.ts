// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseDcr } from './dcr-parse.js'
import { serializeDcr } from './dcr-serialize.js'

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/dcr')

interface Manifest {
  readonly files: readonly {
    readonly name: string
    readonly sha256: string
    /** True when the file itself is canonical text (`text === serializeDcr(parseDcr(text))`). */
    readonly canonical?: boolean
    /** The canonical fixture this non-canonical rendering must canonicalize to. */
    readonly canonicalizesTo?: string
    /** `refuses` when the fixture is a deliberate negative probe (parse must fail). */
    readonly expect?: 'parses' | 'refuses'
    /** The error code a `refuses` fixture must report. */
    readonly errorCode?: string
  }[]
}

const manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8')) as Manifest

/** Every fixture file on disk (yaml), as a name relative to the fixture dir. */
function listFixtureFiles(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.yaml'))
    .sort()
}

describe('golden DCR artifact fixtures', () => {
  it('lists every fixture with a matching sha256 (two-directional, manifest regeneration is deliberate)', () => {
    const onDisk = listFixtureFiles()
    const listed = manifest.files.map((file) => file.name).sort()
    expect(listed).toEqual(onDisk)
    for (const fixture of manifest.files) {
      const digest = createHash('sha256')
        .update(readFileSync(join(FIXTURE_DIR, fixture.name)))
        .digest('hex')
      expect(digest).toBe(fixture.sha256)
    }
  })

  for (const file of manifest.files) {
    const label =
      file.expect === 'refuses'
        ? 'is refused with the pinned error code'
        : 'parses, and round-trips byte-stably'
    it(`${file.name} ${label}`, () => {
      const text = readFileSync(join(FIXTURE_DIR, file.name), 'utf8')
      const parsed = parseDcr(text)
      if (file.expect === 'refuses') {
        expect(parsed.ok).toBe(false)
        if (!parsed.ok) {
          // Exact: the probe must yield exactly the pinned code — any
          // unexpected additional error class fails the pin.
          expect(parsed.errors.map((error) => error.code)).toEqual([file.errorCode])
        }
        return
      }
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) return

      const canonical = serializeDcr(parsed.artifact)
      // Canonical fixtures are literally canonical text.
      if (file.canonical) expect(text).toBe(canonical)
      const reparsed = parseDcr(canonical)
      expect(reparsed).toEqual({ ok: true, artifact: parsed.artifact })
      expect(serializeDcr(reparsed.ok ? reparsed.artifact : parsed.artifact)).toBe(canonical)

      // A non-canonical rendering is pinned to canonicalize to its target.
      if (file.canonicalizesTo !== undefined) {
        const target = readFileSync(join(FIXTURE_DIR, file.canonicalizesTo), 'utf8')
        expect(canonical).toBe(target)
      }
    })
  }

  it('canonical bytes of every parsing fixture carry no wall-clock token (D17-Q11)', () => {
    for (const file of manifest.files) {
      if (file.expect === 'refuses') continue
      const text = readFileSync(join(FIXTURE_DIR, file.name), 'utf8')
      const parsed = parseDcr(text)
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) continue
      const canonical = serializeDcr(parsed.artifact)
      expect(canonical).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    }
  })
})
