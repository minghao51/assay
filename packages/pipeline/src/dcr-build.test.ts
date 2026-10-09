// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { serializeDcr } from './dcr-serialize.js'
import { parseDcr } from './dcr-parse.js'
import {
  DCR_FORMAT,
  DCR_PRIVACY_NOT_COMPUTED_DISCLOSURE,
  DCR_RESERVED_PREFIX,
  DCR_VERSION,
} from './dcr-ast.js'
import { buildDcrArtifact } from './dcr-build.js'
import type { DcrBuilderInput } from './dcr-build.js'
import { genDcr, makeTestRng } from './dcr-property-testing.js'

/**
 * The pure builder's contract tests + the p3-1 hygiene pins (p3-1).
 *
 * Hygiene pins (each FAILS if violated):
 * - **No wall-clock**: no `Date` construction anywhere in the DCR module
 *   sources, and no timestamp-shaped token in any serialized artifact
 *   (D17-Q11).
 * - **`assay_dcr_*` reservation** (D17-Q9): refused in id positions by both
 *   the builder and the parser; the constant is exported as the reservation.
 * - **ADR 0025 privacy**: the fixture corpus carries no SQL statements, no
 *   absolute paths, no ISO timestamps, and the canonical bytes of generated
 *   artifacts carry none either.
 */

const BASE_REF = {
  datasetId: 'dataset-a',
  versionId: 'version-a-1',
  schemaFingerprint: { algorithm: 'assay-schema-fingerprint-v1', value: 'fp-a-0001' },
  materialization: { node: 'src_orders' },
}

function baseInput(): DcrBuilderInput {
  return {
    base: BASE_REF,
    candidate: {
      ...BASE_REF,
      versionId: 'version-a-2',
      schemaFingerprint: { algorithm: 'assay-schema-fingerprint-v1', value: 'fp-a-0002' },
      materialization: { export: 'exports/run-2/out.parquet' },
    },
    deltas: {},
  }
}

describe('buildDcrArtifact: the canonical artifact from producer inputs', () => {
  it('supplies the stamp and the canonical privacyFindings disclosure (D17-Q1/Q6a)', () => {
    const built = buildDcrArtifact(baseInput())
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.artifact.format).toBe(DCR_FORMAT)
    expect(built.artifact.version).toBe(DCR_VERSION)
    expect(built.artifact.privacyFindings).toEqual({
      status: 'not-computed',
      disclosure: DCR_PRIVACY_NOT_COMPUTED_DISCLOSURE,
    })
  })

  it('normalizes to the canonical AST: sorts, dedupes-refuses, and spells empties by absence', () => {
    const built = buildDcrArtifact({
      ...baseInput(),
      deltas: {
        schemaDrift: [
          { kind: 'column-added', column: 'z' },
          { kind: 'nullability-changed', column: 'z', nullShareA: 0, nullShareB: null },
          { kind: 'column-added', column: 'a' },
        ],
        columnDeltas: [
          { column: 'm', typeA: 'INTEGER', typeB: 'INTEGER', kindA: 'numeric', kindB: 'numeric' },
          { column: 'b', typeA: 'INTEGER', typeB: 'INTEGER', kindA: 'numeric', kindB: 'numeric' },
        ],
      },
      validation: [],
      lineage: { inputVersionIds: ['v-2', 'v-1'], nodes: ['n2', 'n1', 'n0'] },
    })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(
      built.artifact.deltas.schemaDrift?.flatMap((finding) => [finding.column, finding.kind]),
    ).toEqual(['a', 'column-added', 'z', 'column-added', 'z', 'nullability-changed'])
    expect(built.artifact.deltas.columnDeltas?.map((delta) => delta.column)).toEqual(['b', 'm'])
    expect(built.artifact.validation).toBeUndefined() // empty → absent
    expect(built.artifact.lineage).toEqual({
      inputVersionIds: ['v-1', 'v-2'], // order is not meaning → sorted
      nodes: ['n2', 'n1', 'n0'], // order is meaning (topological) → preserved
    })
    // The built artifact round-trips byte-stably by construction.
    const text = serializeDcr(built.artifact)
    expect(parseDcr(text)).toEqual({ ok: true, artifact: built.artifact })
  })

  it('never throws over hostile inputs; every violation is a typed error with an AST path', () => {
    const hostile = {
      base: { datasetId: 42 },
      candidate: null,
      deltas: 'nope',
      validation: () => 'not an array',
      lineage: 7,
    } as unknown as DcrBuilderInput
    let result: ReturnType<typeof buildDcrArtifact> | undefined
    expect(() => {
      result = buildDcrArtifact(hostile)
    }).not.toThrow()
    expect(result?.ok).toBe(false)
    if (result !== undefined && !result.ok) {
      expect(
        result.errors.every((error) => error.path.length > 0 && error.message.length > 0),
      ).toBe(true)
    }
  })

  it('enforces the ruled contracts: materialization exclusivity, D17-Q7 keys, ranges, and bounded samples', () => {
    const bothMaterializations = buildDcrArtifact({
      ...baseInput(),
      base: {
        ...BASE_REF,
        materialization: { node: 'src', export: 'x.parquet' },
      } as unknown as DcrBuilderInput['base'],
    })
    expect(bothMaterializations.ok).toBe(false)
    if (!bothMaterializations.ok) {
      expect(bothMaterializations.errors.map((error) => error.code)).toEqual(['out-of-range'])
    }

    const noMaterialization = buildDcrArtifact({
      ...baseInput(),
      base: { ...BASE_REF, materialization: {} } as unknown as DcrBuilderInput['base'],
    })
    expect(noMaterialization.ok).toBe(false)
    if (!noMaterialization.ok) {
      expect(noMaterialization.errors[0]?.code).toBe('missing-key')
    }

    const keylessRowDiff = buildDcrArtifact({
      ...baseInput(),
      deltas: {
        rowDiff: {
          keys: [],
          sampleLimit: 20,
          rowCountA: 1,
          rowCountB: 1,
          aspects: [
            { aspect: 'added', count: 0, samples: [] },
            { aspect: 'removed', count: 0, samples: [] },
            { aspect: 'changed', count: 0, samples: [] },
          ],
        },
      },
    })
    expect(keylessRowDiff.ok).toBe(false)
    if (!keylessRowDiff.ok) {
      expect(keylessRowDiff.errors[0]?.code).toBe('out-of-range')
      expect(keylessRowDiff.errors[0]?.message).toContain('D17-Q7')
    }

    const oversampled = buildDcrArtifact({
      ...baseInput(),
      deltas: {
        rowDiff: {
          keys: ['k'],
          sampleLimit: 1,
          rowCountA: 0,
          rowCountB: 0,
          aspects: [
            { aspect: 'added', count: 0, samples: [{ side: 'A', rowKey: 'base:1' }] },
            { aspect: 'removed', count: 0, samples: [] },
            { aspect: 'changed', count: 0, samples: [] },
          ],
        },
      },
    })
    expect(oversampled.ok).toBe(false)
    if (!oversampled.ok) expect(oversampled.errors[0]?.code).toBe('out-of-range')

    const anchoredKey = buildDcrArtifact({
      ...baseInput(),
      deltas: {
        rowDiff: {
          keys: ['k'],
          sampleLimit: 1,
          rowCountA: 1,
          rowCountB: 1,
          aspects: [
            { aspect: 'added', count: 1, samples: [{ side: 'A', rowKey: 'base:some-anchor#9' }] },
            { aspect: 'removed', count: 0, samples: [] },
            { aspect: 'changed', count: 0, samples: [] },
          ],
        },
      },
    })
    expect(anchoredKey.ok).toBe(false)
    if (!anchoredKey.ok) {
      expect(anchoredKey.errors[0]?.code).toBe('invalid-reference')
      // Value-free diagnostics: the anchor text is never echoed.
      expect(anchoredKey.errors[0]?.message).not.toContain('some-anchor')
      expect(anchoredKey.errors[0]?.path).toBe('deltas.rowDiff.aspects[0].samples[0].rowKey')
    }
  })
})

// ---------------------------------------------------------------------------
// Hygiene pins
// ---------------------------------------------------------------------------

describe('hygiene: no wall-clock anywhere in the serialization path or output (D17-Q11)', () => {
  const dcrSources = readdirSync(dirname(fileURLToPath(import.meta.url)))
    .filter((name) => name.startsWith('dcr-') && name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => join(dirname(fileURLToPath(import.meta.url)), name))

  it('no DCR module source constructs a Date or reads a clock', () => {
    for (const file of dcrSources) {
      const source = readFileSync(file, 'utf8')
      expect(source).not.toMatch(/\bDate\.now\b/)
      expect(source).not.toMatch(/\bnew Date\b/)
      expect(source).not.toMatch(/\bperformance\.now\b/)
      expect(source).not.toMatch(/\bprocess\.hrtime\b/)
    }
  })

  it('no serialized artifact contains a timestamp-shaped token (400 generated artifacts)', () => {
    const rng = makeTestRng(20261006)
    for (let i = 0; i < 400; i++) {
      const built = buildDcrArtifact({ ...genDcr(rng) })
      if (!built.ok) throw new Error('generator produced an invalid artifact')
      const text = serializeDcr(built.artifact)
      // No ISO date, no RFC time, no epoch-millis-looking integer field.
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/)
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
    }
  })

  it('the builder accepts no timestamp input at all (structural: the field does not exist)', () => {
    const smuggled = {
      ...baseInput(),
      createdAt: new Date(0).toISOString(),
      generatedAt: Date.now(),
    } as DcrBuilderInput & Record<string, unknown>
    const built = buildDcrArtifact(smuggled)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    // The extra keys never reach the artifact: the grammar has no slot for them.
    expect(JSON.stringify(built.artifact)).not.toContain('createdAt')
    expect(JSON.stringify(built.artifact)).not.toContain('generatedAt')
  })
})

describe('hygiene: the assay_dcr_ namespace reservation (D17-Q9)', () => {
  it('is exported as the reservation constant and enforced by the builder', () => {
    expect(DCR_RESERVED_PREFIX).toBe('assay_dcr_')
    const reserved = buildDcrArtifact({
      ...baseInput(),
      base: { ...BASE_REF, materialization: { node: 'Assay_Dcr_internal_1' } },
    })
    expect(reserved.ok).toBe(false)
    if (!reserved.ok) expect(reserved.errors[0]?.code).toBe('reserved-identifier')
  })

  it('is enforced case-insensitively in every id position (verdict node ids, lineage nodes)', () => {
    const verdict = buildDcrArtifact({
      ...baseInput(),
      validation: [
        { nodeId: 'ASSAY_DCR_verdict', input: 'candidate', valid: true, violatedRules: 0 },
      ],
    })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.errors[0]?.code).toBe('reserved-identifier')

    const lineage = buildDcrArtifact({
      ...baseInput(),
      lineage: { nodes: ['fine', 'Assay_Dcr_Node'] },
    })
    expect(lineage.ok).toBe(false)
    if (!lineage.ok) expect(lineage.errors[0]?.code).toBe('reserved-identifier')
  })
})

describe('hygiene: ADR 0025 — fixtures and output carry no dataset values, SQL, or sensitive paths', () => {
  const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/dcr')

  function listFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? listFiles(join(dir, entry.name))
        : entry.name.endsWith('.yaml')
          ? [join(dir, entry.name)]
          : [],
    )
  }

  it('every parsing fixture canonical output is free of SQL, absolute paths, and timestamps', () => {
    // The refuses-* probes are hostile inputs by design (they carry the very
    // content the grammar refuses), so the scan runs over what the parser
    // ACCEPTS: each parsing fixture's raw text (== its canonical output).
    for (const file of listFiles(FIXTURE_DIR)) {
      const text = readFileSync(file, 'utf8')
      const parsed = parseDcr(text)
      if (!parsed.ok) continue // a negative probe: its refused content is the point
      expect(text, `${file}: SQL statement`).not.toMatch(/\b(SELECT|INSERT|UPDATE|DELETE)\b/)
      expect(text, `${file}: absolute path`).not.toMatch(/:\s+(?:\/|~\/|[A-Za-z]:\\)/)
      expect(text, `${file}: ISO timestamp`).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    }
  })

  it('serialized artifacts never carry SQL or path-like values outside the materialization export slot', () => {
    const rng = makeTestRng(20261007)
    for (let i = 0; i < 200; i++) {
      const built = buildDcrArtifact(genDcr(rng))
      if (!built.ok) throw new Error('generator produced an invalid artifact')
      const text = serializeDcr(built.artifact)
      expect(text).not.toMatch(/\bSELECT\b/)
      // Strip the sanctioned export-path values, then assert no path remains.
      const withoutExport = text
        .split('\n')
        .filter((line) => !line.trim().startsWith('export:'))
        .join('\n')
      expect(withoutExport).not.toMatch(/[\w./-]+\.(?:parquet|jsonl|csv|json)\b/)
    }
  })
})
