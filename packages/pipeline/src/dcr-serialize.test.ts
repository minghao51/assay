// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { parseDcr } from './dcr-parse.js'
import { serializeDcr } from './dcr-serialize.js'
import { DCR_PRIVACY_NOT_COMPUTED_DISCLOSURE } from './dcr-ast.js'
import type { DcrArtifactV1 } from './dcr-ast.js'

/**
 * The DCR serializer's canonical-byte pins (p3-1). Byte stability is the
 * ADR 0046 core promise (D17-Q11: no wall-clock anywhere in canonical
 * bytes), so the exact text of the minimal form and the full-delta form is
 * pinned here and in the golden fixtures.
 */

const MINIMAL: DcrArtifactV1 = {
  format: 'assay-dcr',
  version: 1,
  base: {
    datasetId: 'dataset-a',
    versionId: 'version-a-1',
    schemaFingerprint: { algorithm: 'assay-schema-fingerprint-v1', value: 'fp-a-0001' },
    materialization: { node: 'src_orders' },
  },
  candidate: {
    datasetId: 'dataset-a',
    versionId: 'version-a-2',
    schemaFingerprint: { algorithm: 'assay-schema-fingerprint-v1', value: 'fp-a-0002' },
    materialization: { export: 'exports/run-2/out.parquet' },
  },
  deltas: {},
  privacyFindings: { status: 'not-computed', disclosure: DCR_PRIVACY_NOT_COMPUTED_DISCLOSURE },
}

describe('serializeDcr: canonical bytes', () => {
  it('emits the stable minimal document (root key order, absent empties, stamped disclosure)', () => {
    expect(serializeDcr(MINIMAL)).toBe(`format: assay-dcr
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
`)
  })

  it('renders deltas, row diff, validation, and lineage in their fixed orders', () => {
    const artifact: DcrArtifactV1 = {
      ...MINIMAL,
      deltas: {
        schemaDrift: [
          { kind: 'nullability-changed', column: 'region_code', nullShareA: 0, nullShareB: null },
        ],
        columnDeltas: [
          {
            column: 'amount',
            typeA: 'DECIMAL(18,2)',
            typeB: 'DECIMAL(18,2)',
            kindA: 'numeric',
            kindB: 'numeric',
            numeric: {
              meanShiftStandardized: 0.5,
              varianceShiftStandardized: null,
              p50Shift: 12.5,
              p90Shift: -0.25,
            },
          },
        ],
        rowDiff: {
          keys: ['order_id'],
          sampleLimit: 20,
          rowCountA: 1000,
          rowCountB: 1002,
          aspects: [
            { aspect: 'removed', count: 0, samples: [] },
            {
              aspect: 'changed',
              count: 2,
              samples: [
                { side: 'A', rowKey: 'base:41', changedColumns: ['status', 'amount'] },
                { side: 'B', rowKey: 'b:1001', changedColumns: ['amount'] },
              ],
            },
            { aspect: 'added', count: 1, samples: [{ side: 'B', rowKey: 'b:1000' }] },
          ],
        },
      },
      validation: [
        {
          nodeId: 'check_rows',
          input: 'candidate',
          valid: false,
          violatedRules: 1,
          rowCount: 1002,
          rules: [
            {
              ruleId: 'required:region_code',
              kind: 'required',
              column: 'region_code',
              failCount: 250,
              failPercent: 25,
            },
          ],
        },
      ],
      lineage: { inputVersionIds: ['version-a-1'], nodes: ['src_orders', 'filter_recent'] },
    }
    expect(serializeDcr(artifact)).toBe(`format: assay-dcr
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
deltas:
  schemaDrift:
    - kind: nullability-changed
      column: region_code
      nullShareA: 0
      nullShareB: null
  columnDeltas:
    - column: amount
      typeA: DECIMAL(18,2)
      typeB: DECIMAL(18,2)
      kindA: numeric
      kindB: numeric
      numeric:
        meanShiftStandardized: 0.5
        varianceShiftStandardized: null
        p50Shift: 12.5
        p90Shift: -0.25
  rowDiff:
    keys: [ order_id ]
    sampleLimit: 20
    rowCountA: 1000
    rowCountB: 1002
    aspects:
      - aspect: added
        count: 1
        samples:
          - side: B
            rowKey: b:1000
      - aspect: removed
        count: 0
        samples: []
      - aspect: changed
        count: 2
        samples:
          - side: A
            rowKey: base:41
            changedColumns: [ amount, status ]
          - side: B
            rowKey: b:1001
            changedColumns: [ amount ]
validation:
  - nodeId: check_rows
    input: candidate
    valid: false
    violatedRules: 1
    rowCount: 1002
    rules:
      - ruleId: required:region_code
        kind: required
        column: region_code
        failCount: 250
        failPercent: 25
lineage:
  inputVersionIds: [ version-a-1 ]
  nodes: [ src_orders, filter_recent ]
privacyFindings:
  status: not-computed
  disclosure: "Privacy findings were not computed: this build has no local privacy-analysis producer (ADR 0046, ruling D17-Q6)."
`)
  })

  it('emits the D19-OQ-4 bounding disclosure in fixed key order after the base keys (p3-1b)', () => {
    const artifact: DcrArtifactV1 = {
      ...MINIMAL,
      deltas: {
        columnDeltas: [
          {
            column: 'status',
            typeA: 'VARCHAR',
            typeB: 'VARCHAR',
            kindA: 'categorical',
            kindB: 'categorical',
            categorical: {
              totalVariation: 0.25,
              newCategories: [{ value: 'alpha', count: 7 }],
              vanishedCategories: [],
              newCategoriesBounded: true,
              vanishedCategoriesBounded: true,
            },
          },
        ],
      },
    }
    // Canonical block form: both flags, appended in fixed order after the
    // three base keys — never interleaved, never reordered.
    expect(serializeDcr(artifact)).toBe(`format: assay-dcr
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
deltas:
  columnDeltas:
    - column: status
      typeA: VARCHAR
      typeB: VARCHAR
      kindA: categorical
      kindB: categorical
      categorical:
        totalVariation: 0.25
        newCategories:
          - value: alpha
            count: 7
        vanishedCategories: []
        newCategoriesBounded: true
        vanishedCategoriesBounded: true
privacyFindings:
  status: not-computed
  disclosure: "Privacy findings were not computed: this build has no local privacy-analysis producer (ADR 0046, ruling D17-Q6)."
`)
  })

  it('old bytes unchanged: an unbounded categorical block emits exactly the pre-p3-1b form (absence is meaning)', () => {
    const artifact: DcrArtifactV1 = {
      ...MINIMAL,
      deltas: {
        columnDeltas: [
          {
            column: 'status',
            typeA: 'VARCHAR',
            typeB: 'VARCHAR',
            kindA: 'categorical',
            kindB: 'categorical',
            categorical: {
              totalVariation: 0.25,
              newCategories: [{ value: 'alpha', count: 7 }],
              vanishedCategories: [],
            },
          },
        ],
      },
    }
    // The pre-disclosure byte form, pinned: no trace of either new key.
    const text = serializeDcr(artifact)
    expect(text).toBe(`format: assay-dcr
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
deltas:
  columnDeltas:
    - column: status
      typeA: VARCHAR
      typeB: VARCHAR
      kindA: categorical
      kindB: categorical
      categorical:
        totalVariation: 0.25
        newCategories:
          - value: alpha
            count: 7
        vanishedCategories: []
privacyFindings:
  status: not-computed
  disclosure: "Privacy findings were not computed: this build has no local privacy-analysis producer (ADR 0046, ruling D17-Q6)."
`)
    expect(text).not.toContain('newCategoriesBounded')
    expect(text).not.toContain('vanishedCategoriesBounded')
    // …and it parses back to the flag-less AST unchanged.
    expect(parseDcr(text)).toEqual({ ok: true, artifact })
  })

  it('one-sided bounding discloses exactly the bounded side (independent flags)', () => {
    const artifact: DcrArtifactV1 = {
      ...MINIMAL,
      deltas: {
        columnDeltas: [
          {
            column: 'status',
            typeA: 'VARCHAR',
            typeB: 'VARCHAR',
            kindA: 'categorical',
            kindB: 'categorical',
            categorical: {
              totalVariation: null,
              newCategories: [],
              vanishedCategories: [{ value: 'beta', count: 3 }],
              vanishedCategoriesBounded: true,
            },
          },
        ],
      },
    }
    const text = serializeDcr(artifact)
    expect(text).toContain('        vanishedCategoriesBounded: true\n')
    expect(text).not.toContain('newCategoriesBounded')
    expect(parseDcr(text)).toEqual({ ok: true, artifact })
  })

  it('is a fixpoint: serialize(parse(serialize(x))) is byte-identical', () => {
    const text = serializeDcr(MINIMAL)
    const parsed = parseDcr(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(serializeDcr(parsed.artifact)).toBe(text)
  })

  it('normalizes -0 to 0 (one shape per meaning)', () => {
    const withNegativeZero = {
      ...MINIMAL,
      deltas: {
        schemaDrift: [
          {
            kind: 'nullability-changed' as const,
            column: 'region_code',
            nullShareA: -0,
            nullShareB: 0,
          },
        ],
      },
    }
    const text = serializeDcr(withNegativeZero)
    expect(text).not.toMatch(/nullShare[AB]: -0\b/)
    expect(text).toContain('nullShareA: 0')
    expect(text).toContain('nullShareB: 0')
  })

  it('enforces canonical collection order even for a hand-assembled (unsorted) AST', () => {
    const unsorted: DcrArtifactV1 = {
      ...MINIMAL,
      deltas: {
        schemaDrift: [
          { kind: 'column-added', column: 'zzz_last' },
          { kind: 'column-added', column: 'aaa_first' },
        ],
        columnDeltas: [
          { column: 'zebra', typeA: 'A', typeB: 'B', kindA: 'other', kindB: 'other' },
          { column: 'alpha', typeA: 'A', typeB: 'B', kindA: 'other', kindB: 'other' },
        ],
      },
      lineage: { nodes: ['zzz_node', 'aaa_node'], inputVersionIds: ['v2', 'v1'] },
    }
    const text = serializeDcr(unsorted)
    expect(text.indexOf('aaa_first')).toBeLessThan(text.indexOf('zzz_last'))
    expect(text.indexOf('column: alpha')).toBeLessThan(text.indexOf('column: zebra'))
    expect(text).toContain('inputVersionIds: [ v1, v2 ]')
    expect(text).toContain('nodes: [ zzz_node, aaa_node ]') // order is meaning — preserved
  })

  it('is total over hostile caller input (never throws; degrades to deterministic plain output)', () => {
    const hostile = {
      format: 42,
      version: 'one',
      base: null,
      candidate: 'not-a-mapping',
      deltas: 7,
      validation: 'nope',
      lineage: true,
      privacyFindings: undefined,
    } as unknown as DcrArtifactV1
    let text: string | undefined
    expect(() => {
      text = serializeDcr(hostile)
    }).not.toThrow()
    expect(typeof text).toBe('string')
    expect(text?.endsWith('\n')).toBe(true)
  })

  it('normalizes a rowDiff whose aspects were hand-assembled out of order', () => {
    const unsortedRowDiff = {
      ...MINIMAL,
      deltas: {
        rowDiff: {
          keys: ['order_id'],
          sampleLimit: 1,
          rowCountA: 1,
          rowCountB: 1,
          aspects: [
            { aspect: 'removed', count: 0, samples: [] },
            { aspect: 'added', count: 0, samples: [] },
            { aspect: 'changed', count: 0, samples: [] },
          ],
        },
      },
    } as unknown as DcrArtifactV1
    const text = serializeDcr(unsortedRowDiff)
    const addedAt = text.indexOf('aspect: added')
    const removedAt = text.indexOf('aspect: removed')
    const changedAt = text.indexOf('aspect: changed')
    expect(addedAt).toBeLessThan(removedAt)
    expect(removedAt).toBeLessThan(changedAt)
  })
})
