// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { parseDcr } from './dcr-parse.js'
import { serializeDcr } from './dcr-serialize.js'
import { DCR_PRIVACY_NOT_COMPUTED_DISCLOSURE } from './dcr-ast.js'
import { describeDcrError } from './dcr-errors.js'
import { buildDcrArtifact } from './dcr-build.js'
import type { DcrError } from './dcr-errors.js'

/**
 * The total parser's rejection matrix (p3-1). Every malformed document
 * yields typed, located, value-free errors — never a throw (the repo
 * never-throws convention; ADR 0046's format-discipline clause). The
 * privacy shape-pins live here too: the grammar has no carrier for SQL text
 * or cell values (probed structurally below), and the row-key grammar
 * refuses grid anchors (ADR 0025).
 */

/** A minimal legal document, for surgical corruption. */
const MINIMAL = `format: assay-dcr
version: 1
base:
  datasetId: dataset-a
  versionId: version-a-1
  schemaFingerprint:
    algorithm: assay-schema-fingerprint-v1
    value: fp-a-0001
  materialization:
    node: src_orders
candidate:
  datasetId: dataset-a
  versionId: version-a-2
  schemaFingerprint:
    algorithm: assay-schema-fingerprint-v1
    value: fp-a-0002
  materialization:
    export: exports/run-2/out.parquet
deltas: {}
privacyFindings:
  status: not-computed
  disclosure: "Privacy findings were not computed: this build has no local privacy-analysis producer (ADR 0046, ruling D17-Q6)."
`

function codesOf(errors: readonly DcrError[]): string[] {
  return errors.map((error) => error.code)
}

function parseCorrupted(patch: string): ReturnType<typeof parseDcr> {
  return parseDcr(MINIMAL.replace('deltas: {}', patch))
}

describe('parseDcr: accepts the canonical form', () => {
  it('parses the minimal document and round-trips it byte-stably', () => {
    const parsed = parseDcr(MINIMAL)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.artifact.format).toBe('assay-dcr')
    expect(parsed.artifact.version).toBe(1)
    expect(parsed.artifact.deltas).toEqual({})
    expect(parsed.artifact.privacyFindings.disclosure).toBe(DCR_PRIVACY_NOT_COMPUTED_DISCLOSURE)
    expect(serializeDcr(parsed.artifact)).toBe(MINIMAL)
  })

  it('empty schemaDrift/columnDeltas normalize to absent (one shape per meaning)', () => {
    const parsed = parseCorrupted(`deltas:
  schemaDrift: []
  columnDeltas: []`)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.artifact.deltas).toEqual({})
  })

  it('rowDiff absent is legal — the one spelling of "no keys were supplied" (D17-Q7c)', () => {
    const parsed = parseCorrupted(`deltas:
  schemaDrift:
    - kind: column-added
      column: priority_flag`)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.artifact.deltas.rowDiff).toBeUndefined()
    expect(parsed.artifact.deltas.schemaDrift).toHaveLength(1)
  })

  it('name-keyed collections are normalized into canonical order on parse', () => {
    const parsed = parseCorrupted(`deltas:
  schemaDrift:
    - kind: column-added
      column: zebra
    - kind: nullability-changed
      column: zebra
    - kind: column-added
      column: alpha
  columnDeltas:
    - column: zebra
      typeA: INTEGER
      typeB: INTEGER
      kindA: numeric
      kindB: numeric
      numeric:
        meanShiftStandardized: 0
        varianceShiftStandardized: null
        p50Shift: null
        p90Shift: null
    - column: alpha
      typeA: INTEGER
      typeB: INTEGER
      kindA: numeric
      kindB: numeric
      numeric:
        meanShiftStandardized: null
        varianceShiftStandardized: null
        p50Shift: null
        p90Shift: null`)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.artifact.deltas.schemaDrift?.map((finding) => finding.column)).toEqual([
      'alpha',
      'zebra',
      'zebra',
    ])
    expect(parsed.artifact.deltas.schemaDrift?.[1]?.kind).toBe('column-added')
    expect(parsed.artifact.deltas.schemaDrift?.[2]?.kind).toBe('nullability-changed')
    expect(parsed.artifact.deltas.columnDeltas?.map((delta) => delta.column)).toEqual([
      'alpha',
      'zebra',
    ])
  })

  it('rowDiff aspects are normalized into the documented order', () => {
    const parsed = parseCorrupted(`deltas:
  rowDiff:
    keys: [ order_id ]
    sampleLimit: 20
    rowCountA: 1
    rowCountB: 1
    aspects:
      - aspect: changed
        count: 0
        samples: []
      - aspect: removed
        count: 0
        samples: []
      - aspect: added
        count: 0
        samples: []`)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.artifact.deltas.rowDiff?.aspects.map((aspect) => aspect.aspect)).toEqual([
      'added',
      'removed',
      'changed',
    ])
  })

  it('an anchored grid row key (`base:<anchor>#<ordinal>`) is refused — anchors never enter the artifact', () => {
    const parsed = parseCorrupted(`deltas:
  rowDiff:
    keys: [ order_id ]
    sampleLimit: 20
    rowCountA: 1
    rowCountB: 1
    aspects:
      - aspect: added
        count: 1
        samples:
          - side: B
            rowKey: base:abc123#41`)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(codesOf(parsed.errors)).toEqual(['invalid-reference'])
    expect(parsed.errors[0]?.path).toBe('deltas.rowDiff.aspects[0].samples[0].rowKey')
    // Value-free diagnostics: the hostile key text is not echoed.
    expect(parsed.errors[0]?.message).not.toContain('abc123')
  })

  it('the reserved assay_dcr_ namespace is refused in id positions (D17-Q9)', () => {
    const withReserved = MINIMAL.replace('    node: src_orders', '    node: Assay_DCR_generated')
    const parsed = parseDcr(withReserved)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(codesOf(parsed.errors)).toEqual(['reserved-identifier'])
    expect(parsed.errors[0]?.path).toBe('base.materialization.node')
  })
})

describe('parseDcr: refuses malformed documents with typed located errors', () => {
  it('a foreign format stamp is reported alone (never guessed at)', () => {
    const parsed = parseDcr(MINIMAL.replace('format: assay-dcr', 'format: assay-diff'))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(codesOf(parsed.errors)).toEqual(['unsupported-format'])
  })

  it('a foreign version is reported alone (a version bump is maintainer-visible, D17-Q12)', () => {
    const parsed = parseDcr(MINIMAL.replace('version: 1', 'version: 2'))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(codesOf(parsed.errors)).toEqual(['unsupported-version'])
  })

  it('non-string input degrades to a typed error, never a throw', () => {
    // A caller bug behind a cast: the parser is total over document inputs.
    const parsed = parseDcr(42 as unknown as string)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(codesOf(parsed.errors)).toEqual(['wrong-type'])
  })

  it('empty and non-mapping documents are typed errors with positions', () => {
    expect(parseDcr('').ok).toBe(false)
    const seq = parseDcr('- just\n- a list\n')
    expect(seq.ok).toBe(false)
    if (!seq.ok) expect(codesOf(seq.errors)).toEqual(['wrong-type'])
  })

  it('unknown keys are refused at every level, with a misplaced-key hint', () => {
    const rootLevel = parseDcr(MINIMAL.replace('deltas: {}', 'deltas: {}\nreviews: []'))
    expect(rootLevel.ok).toBe(false)
    if (!rootLevel.ok) {
      expect(codesOf(rootLevel.errors)).toEqual(['unknown-key'])
      expect(rootLevel.errors[0]?.message).toContain('document')
    }

    // The privacy-carrier probes: there is no field anywhere in the grammar
    // that could carry SQL text or cell values (ADR 0025, structural pin).
    for (const [probe, location] of [
      ['deltas:\n  sql: SELECT 1', 'deltas'],
      [
        'deltas:\n  schemaDrift:\n    - kind: column-added\n      column: c\n      value: 42',
        'deltas.schemaDrift[0]',
      ],
      [
        'deltas:\n  rowDiff:\n    keys: [ k ]\n    sampleLimit: 1\n    rowCountA: 1\n    rowCountB: 1\n    aspects:\n      - aspect: added\n        count: 1\n        samples:\n          - side: A\n            rowKey: b:1\n            cells: [ x ]\n      - aspect: removed\n        count: 0\n        samples: []\n      - aspect: changed\n        count: 0\n        samples: []',
        'deltas.rowDiff.aspects[0].samples[0]',
      ],
    ] as const) {
      const parsed = parseCorrupted(probe)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) {
        expect(codesOf(parsed.errors)).toEqual(['unknown-key'])
        expect(parsed.errors[0]?.path).toBe(location)
      }
    }
  })

  it('duplicate keys and duplicate entries are refused', () => {
    const duplicateKey = parseDcr(
      MINIMAL.replace('format: assay-dcr', 'format: assay-dcr\nformat: assay-dcr'),
    )
    expect(duplicateKey.ok).toBe(false)
    if (!duplicateKey.ok) expect(codesOf(duplicateKey.errors)).toEqual(['duplicate-key'])

    const duplicateDelta = parseCorrupted(`deltas:
  schemaDrift:
    - kind: column-added
      column: alpha
    - kind: column-added
      column: alpha`)
    expect(duplicateDelta.ok).toBe(false)
    if (!duplicateDelta.ok) expect(codesOf(duplicateDelta.errors)).toEqual(['duplicate-reference'])

    const duplicateVerdict = parseCorrupted(`deltas: {}
validation:
  - nodeId: gate_a
    input: candidate
    valid: true
    violatedRules: 0
  - nodeId: gate_a
    input: candidate
    valid: true
    violatedRules: 0`)
    expect(duplicateVerdict.ok).toBe(false)
    if (!duplicateVerdict.ok)
      expect(codesOf(duplicateVerdict.errors)).toEqual(['duplicate-reference'])
  })

  it('rowDiff keys obey the D17-Q7 discipline: present-but-empty is a typed error, absent is legal', () => {
    const emptyKeys = parseCorrupted(`deltas:
  rowDiff:
    keys: []
    sampleLimit: 20
    rowCountA: 1
    rowCountB: 1
    aspects:
      - aspect: added
        count: 0
        samples: []`)
    expect(emptyKeys.ok).toBe(false)
    if (!emptyKeys.ok) {
      expect(codesOf(emptyKeys.errors)).toEqual(['out-of-range'])
      expect(emptyKeys.errors[0]?.message).toContain('D17-Q7')
    }

    const missingKeys = parseCorrupted(`deltas:
  rowDiff:
    sampleLimit: 20
    rowCountA: 1
    rowCountB: 1
    aspects:
      - aspect: added
        count: 0
        samples: []`)
    expect(missingKeys.ok).toBe(false)
    if (!missingKeys.ok) expect(codesOf(missingKeys.errors)).toEqual(['missing-key'])

    // Case-insensitive duplicates are the m6-1 binding error, not a silent collapse.
    const caseDuplicate = parseCorrupted(`deltas:
  rowDiff:
    keys: [ order_id, Order_ID ]
    sampleLimit: 20
    rowCountA: 1
    rowCountB: 1
    aspects:
      - aspect: added
        count: 0
        samples: []`)
    expect(caseDuplicate.ok).toBe(false)
    if (!caseDuplicate.ok) expect(codesOf(caseDuplicate.errors)).toEqual(['duplicate-reference'])
  })

  it('range violations are typed: failPercent, sampleLimit, shares, and totalVariation', () => {
    const failPercent = parseCorrupted(`deltas: {}
validation:
  - nodeId: gate_a
    input: candidate
    valid: false
    violatedRules: 1
    rules:
      - ruleId: min-rows:2000
        failCount: 5
        failPercent: 101`)
    expect(failPercent.ok).toBe(false)
    if (!failPercent.ok) expect(codesOf(failPercent.errors)).toEqual(['out-of-range'])

    const sampleLimit = parseCorrupted(`deltas:
  rowDiff:
    keys: [ k ]
    sampleLimit: 0
    rowCountA: 1
    rowCountB: 1
    aspects:
      - aspect: added
        count: 0
        samples: []`)
    expect(sampleLimit.ok).toBe(false)
    if (!sampleLimit.ok) expect(codesOf(sampleLimit.errors)).toEqual(['out-of-range'])

    const share = parseCorrupted(`deltas:
  schemaDrift:
    - kind: nullability-changed
      column: c
      nullShareA: 1.5`)
    expect(share.ok).toBe(false)
    if (!share.ok) expect(codesOf(share.errors)).toEqual(['out-of-range'])

    const tv = parseCorrupted(`deltas:
  columnDeltas:
    - column: c
      typeA: VARCHAR
      typeB: VARCHAR
      kindA: categorical
      kindB: categorical
      categorical:
        totalVariation: 2
        newCategories: []
        vanishedCategories: []`)
    expect(tv.ok).toBe(false)
    if (!tv.ok) expect(codesOf(tv.errors)).toEqual(['out-of-range'])
  })

  it('non-finite and imprecise numbers are refused (exact-or-rejected)', () => {
    const inf = parseCorrupted(`deltas:
  schemaDrift:
    - kind: nullability-changed
      column: c
      nullShareA: .inf`)
    expect(inf.ok).toBe(false)
    if (!inf.ok) expect(codesOf(inf.errors)).toEqual(['out-of-range'])

    // A literal the YAML→number parse would silently alter.
    const imprecise = parseCorrupted(`deltas: {}
validation:
  - nodeId: gate_a
    input: candidate
    valid: false
    violatedRules: 1
    rowCount: 9007199254740993`)
    expect(imprecise.ok).toBe(false)
    if (!imprecise.ok) expect(codesOf(imprecise.errors)).toEqual(['imprecise-number'])
  })

  it('the privacyFindings block must be exactly the canonical spelling (D17-Q6a)', () => {
    const wrongStatus = parseDcr(
      MINIMAL.replace('  status: not-computed', '  status: computed-clean'),
    )
    expect(wrongStatus.ok).toBe(false)
    if (!wrongStatus.ok) expect(codesOf(wrongStatus.errors)).toEqual(['out-of-range'])

    const variedDisclosure = parseDcr(
      MINIMAL.replace(
        '  disclosure: "Privacy findings were not computed: this build has no local privacy-analysis producer (ADR 0046, ruling D17-Q6)."',
        '  disclosure: "no privacy issues found"',
      ),
    )
    expect(variedDisclosure.ok).toBe(false)
    if (!variedDisclosure.ok) expect(codesOf(variedDisclosure.errors)).toEqual(['out-of-range'])

    const missingBlock = parseDcr(MINIMAL.replace(/privacyFindings:[\s\S]*$/, ''))
    expect(missingBlock.ok).toBe(false)
    if (!missingBlock.ok) expect(codesOf(missingBlock.errors)).toEqual(['missing-key'])
  })

  it('a lineage block carrying nothing is refused (omit it instead)', () => {
    // An entirely empty block normalizes to absent (one shape per meaning);
    // a block that NAMES a collection but carries nothing is a refusal.
    const empty = parseCorrupted('deltas: {}\nlineage: {}')
    expect(empty.ok).toBe(true)
    const named = parseCorrupted('deltas: {}\nlineage:\n  inputVersionIds: []')
    expect(named.ok).toBe(false)
    if (!named.ok) expect(codesOf(named.errors)).toEqual(['out-of-range'])
  })

  it('errors carry 1-based line/column and render through describeDcrError', () => {
    const lines = MINIMAL.split('\n')
    const withBogus = [
      `format: assay-dcr`,
      'version: 1',
      'bogus_key: true',
      ...lines.slice(2),
    ].join('\n')
    const parsed = parseDcr(withBogus)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.errors[0]?.line).toBe(3)
    expect(parsed.errors[0]?.column).toBe(1)
    const rendered = describeDcrError(parsed.errors[0] as DcrError)
    expect(rendered).toBe(`${parsed.errors[0]?.path}:3:1: ${parsed.errors[0]?.message}`)
  })

  it('an alias cycle is a typed error; the document round-trips anchor-free', () => {
    const cycled = MINIMAL.replace('deltas: {}', 'deltas: &loop\n  self: *loop')
    let result: ReturnType<typeof parseDcr> | undefined
    expect(() => {
      result = parseDcr(cycled)
    }).not.toThrow()
    expect(result?.ok).toBe(false)
  })
})

describe('parseDcr: consumes the builder output', () => {
  it('parses a builder-produced artifact to the same AST (the two seams agree)', () => {
    const built = buildDcrArtifact({
      base: {
        datasetId: 'dataset-a',
        versionId: 'version-a-1',
        schemaFingerprint: { algorithm: 'alg', value: 'fp-1' },
        materialization: { node: 'src' },
      },
      candidate: {
        datasetId: 'dataset-a',
        versionId: 'version-a-2',
        schemaFingerprint: { algorithm: 'alg', value: 'fp-2' },
        materialization: { export: 'exports/run-1/out.parquet' },
      },
      deltas: {
        schemaDrift: [{ kind: 'column-added', column: 'priority_flag' }],
      },
      lineage: { nodes: ['src', 'filter_recent'] },
    })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const parsed = parseDcr(serializeDcr(built.artifact))
    expect(parsed).toEqual({ ok: true, artifact: built.artifact })
  })
})
