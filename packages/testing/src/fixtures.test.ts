import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fixturePath } from './node'

const categories = ['csv', 'jsonl', 'nested-json', 'parquet', 'llm'] // drift/diff pruned 2026-09-23 (DM-3a, dr-1)
const textCategories = ['csv', 'jsonl', 'nested-json', 'llm']

/**
 * Two-way set difference for the fixture manifest (AR-F3): `missing` are
 * manifest entries with no file on disk, `unlisted` are files on disk absent
 * from the manifest. Kept pure so a unit can prove the converse direction is
 * actually enforced (an unlisted parquet is caught).
 */
export function manifestDifferences(
  manifestNames: readonly string[],
  presentNames: readonly string[],
): { readonly missing: string[]; readonly unlisted: string[] } {
  const manifest = new Set(manifestNames)
  const present = new Set(presentNames)
  return {
    missing: manifestNames.filter((name) => !present.has(name)),
    unlisted: presentNames.filter((name) => !manifest.has(name)),
  }
}

describe('golden fixtures manifest (docs/engineering/04-testing-security-quality.md §3)', () => {
  it('defines every fixture category from the repository structure', () => {
    for (const category of categories) {
      expect(existsSync(fixturePath(category)), `fixtures/${category}`).toBe(true)
    }
  })

  it('text categories contain at least one data file', () => {
    for (const category of textCategories) {
      const files = readdirSync(fixturePath(category)).filter((f) => !f.endsWith('.md'))
      expect(files.length, `fixtures/${category}`).toBeGreaterThan(0)
    }
  })

  it('parquet fixtures match the committed manifest exactly (both directions, ADR 0038/AR-F3)', () => {
    const manifest = JSON.parse(readFileSync(fixturePath('parquet/manifest.json'), 'utf8')) as {
      duckdb_version: string
      files: Array<{ name: string; sha256: string; description: string }>
    }
    expect(manifest.files.length, 'manifest lists fixtures').toBeGreaterThan(0)
    for (const file of manifest.files) {
      const path = fixturePath(`parquet/${file.name}`)
      expect(existsSync(path), `fixtures/parquet/${file.name}`).toBe(true)
      const digest = createHash('sha256').update(readFileSync(path)).digest('hex')
      expect(
        digest,
        `checksum of fixtures/parquet/${file.name} (regenerate + commit manifest deliberately via generate.sh)`,
      ).toBe(file.sha256)
    }
    // Converse direction: every committed `.parquet` under fixtures/ must be
    // listed, so an unlisted file can never pass unnoticed (AR-F3).
    const present = readdirSync(fixturePath('parquet'))
      .filter((name) => name.endsWith('.parquet'))
      .sort()
    const differences = manifestDifferences(
      manifest.files.map((file) => file.name),
      present,
    )
    expect(differences.missing, 'manifest entries with no file on disk').toEqual([])
    expect(differences.unlisted, 'parquet files absent from the manifest').toEqual([])
  })

  it('manifestDifferences catches an unlisted (and a missing) parquet file (AR-F3)', () => {
    expect(manifestDifferences(['a.parquet'], ['a.parquet', 'b.parquet'])).toEqual({
      missing: [],
      unlisted: ['b.parquet'],
    })
    expect(manifestDifferences(['a.parquet', 'gone.parquet'], ['a.parquet'])).toEqual({
      missing: ['gone.parquet'],
      unlisted: [],
    })
  })

  it('jsonl fixtures parse line by line', () => {
    const jsonlFixtures = [
      'jsonl/events.jsonl',
      'jsonl/nested.jsonl',
      'nested-json/messages.jsonl',
      'llm/chat-eval.jsonl',
    ]
    for (const fixture of jsonlFixtures) {
      const lines = readFileSync(fixturePath(fixture), 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
      expect(lines.length, fixture).toBeGreaterThan(0)
      for (const line of lines) {
        expect(() => JSON.parse(line), `${fixture}: ${line}`).not.toThrow()
      }
    }
  })
})
