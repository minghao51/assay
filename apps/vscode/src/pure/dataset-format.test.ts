// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  formatFromName,
  neutralDatasetName,
  SUPPORTED_FILENAME_PATTERNS,
  type DatasetFormat,
} from './dataset-format'

const aliases: readonly (readonly [string, DatasetFormat])[] = [
  ['events.parquet', 'parquet'],
  ['events.CSV', 'csv'],
  ['events.jsonl', 'jsonl'],
  ['events.NDJSON', 'jsonl'],
  ['events.json', 'json'],
]

/**
 * D-10 (SV-D07): the real engine's `detectFileFormat` returns `null` for
 * Arrow-family input (`packages/engine-duckdb/src/format-view.ts`), so the
 * VS Code surface must not claim it can open `.arrow`/`.feather`/`.ipc`.
 */
const ARROW_FAMILY_INPUT_CLAIM = /^(\*\.)?(arrow|feather|ipc)$/i

interface VscodeManifest {
  readonly description: string
  readonly contributes: {
    readonly customEditors: readonly {
      readonly selector: readonly { readonly filenamePattern: string }[]
    }[]
  }
}

const manifest = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as VscodeManifest

describe('desktop dataset format bridge', () => {
  it.each(aliases)(
    'maps %s to %s case-insensitively',
    (filename: string, format: DatasetFormat) => {
      expect(formatFromName(filename)).toBe(format)
    },
  )

  it('returns undefined for unsupported filenames and extensions', () => {
    expect(formatFromName('notes.txt')).toBeUndefined()
    expect(formatFromName('events.parquet.bak')).toBeUndefined()
    expect(formatFromName('parquet')).toBeUndefined()
  })

  it('rejects Arrow-family input the real engine cannot read (D-10)', () => {
    for (const name of ['events.arrow', 'events.FEATHER', 'events.ipc']) {
      expect(formatFromName(name)).toBeUndefined()
    }
  })

  it('uses a neutral engine-detectable name and never retains the source name', () => {
    for (const format of ['parquet', 'csv', 'jsonl', 'json'] as const) {
      expect(neutralDatasetName(format)).toBe(`dataset.${format}`)
    }
    expect(neutralDatasetName('json')).not.toContain('events')
  })

  it('keeps contributed editor patterns in sync with supported aliases', () => {
    expect(SUPPORTED_FILENAME_PATTERNS).toEqual(
      aliases.map(([name]) => `*.${name.split('.').pop()!.toLowerCase()}`),
    )
  })

  it('declares only engine-proven input formats in the manifest (D-10)', () => {
    const contributed = manifest.contributes.customEditors.flatMap((editor) =>
      editor.selector.map((selector) => selector.filenamePattern),
    )
    // The extension must not offer its read-only editor for a file the engine
    // will reject: the manifest and this module stay in lockstep.
    expect(contributed).toEqual([...SUPPORTED_FILENAME_PATTERNS])
    for (const pattern of contributed) {
      expect(pattern).not.toMatch(ARROW_FAMILY_INPUT_CLAIM)
    }
    expect(manifest.description).not.toMatch(/\b(?:arrow|feather|ipc)\b/i)
  })
})
