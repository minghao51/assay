// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * D19-OQ-6(b) fingerprint-stability fixture (p3-5): schema sets → expected
 * `assay-schema-fingerprint-v1` values, pinned verbatim.
 *
 * The candidate reference records its fingerprint algorithm by name (no
 * frozen-name policy — candidate-ref.ts), which means the algorithm's
 * *output* is the compatibility surface: if the canonical rendering or the
 * digest ever changes, these pinned vectors fail and the change is forced to
 * be a deliberate, version-stamped decision rather than a silent drift.
 *
 * The vectors go through the public derivation (`candidateVersionRefFromRun`)
 * against a hand-built completed run — no engine execution — and are
 * cross-checked against an independent SHA-256 of the canonical rendering,
 * so the pin does not merely restate the implementation.
 *
 * Column names are synthetic format vocabulary (ADR 0025: value-free).
 */
import { describe, expect, it } from 'vitest'
import type { PipelineV1 } from '@assay/pipeline'
import {
  candidateVersionRefFromRun,
  CANDIDATE_SCHEMA_FINGERPRINT_ALGORITHM,
} from './candidate-ref.js'
import { PipelineRunRefusalError } from './errors.js'
import type { PipelineRunColumn } from './plan.js'
import type { PipelineRunCompleted } from './runner.js'

/** The canonical rendering the algorithm digests (sorted by name, `name:type`, comma-joined). */
function canonicalRendering(columns: readonly PipelineRunColumn[]): string {
  const sorted = [...columns].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return sorted.map((column) => `${column.name}:${column.type}`).join(',')
}

/** Independent SHA-256 (node/WebCrypto) — does not trust the implementation. */
async function independentDigest(rendering: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rendering))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const PLAN: PipelineV1 = {
  version: 1,
  pipeline: 'fingerprint-fixture',
  nodes: [{ id: 'out', type: 'sql', inputs: ['src'], sql: 'SELECT 1' }],
}

function completedRun(relation: string): PipelineRunCompleted {
  return {
    status: 'completed',
    nodes: [{ nodeId: 'out', relation, rowCount: 3, materialization: 'view' }],
  }
}

/**
 * The pinned vector table: schema set → the exact fingerprint hex the
 * algorithm must keep producing (D19-OQ-6(b)). Computed once from the
 * canonical rendering of each set; any change to the rendering, the digest,
 * or the sort breaks these lines loudly.
 */
const VECTORS: readonly {
  readonly label: string
  readonly columns: readonly PipelineRunColumn[]
  readonly rendering: string
  readonly fingerprint: string
}[] = [
  {
    label: 'single column',
    columns: [{ name: 'account_ref', type: 'INTEGER' }],
    rendering: 'account_ref:INTEGER',
    fingerprint: '889b9fd15e19a4a81f18a57d29b1678ed7c4a7bc7a7ce4a877abcf0acc237e50',
  },
  {
    label: 'two columns (input order differs from canonical order)',
    columns: [
      { name: 'region_code', type: 'VARCHAR' },
      { name: 'account_ref', type: 'INTEGER' },
    ],
    rendering: 'account_ref:INTEGER,region_code:VARCHAR',
    fingerprint: 'b6106cca75cb35b50232347c9857e1bb911e5d7a1343362fb2fdbf26fdd1f067',
  },
  {
    label: 'name case is significant',
    columns: [{ name: 'Region_Code', type: 'VARCHAR' }],
    rendering: 'Region_Code:VARCHAR',
    fingerprint: '90f04019f84caeed22d4dcd1f1da2923b2474332da1d57adb628ba20c7f6b822',
  },
  {
    label: 'three mixed types (parameterized type spelling is part of the rendering)',
    columns: [
      { name: 'amount', type: 'DECIMAL(18,2)' },
      { name: 'status', type: 'VARCHAR' },
      { name: 'order_id', type: 'BIGINT' },
    ],
    rendering: 'amount:DECIMAL(18,2),order_id:BIGINT,status:VARCHAR',
    fingerprint: 'cb30ea974988cf2a3001ca6a30feff5bc3dd3b273d8b3970b28ca777774287a2',
  },
]

describe('fingerprint-stability fixture (D19-OQ-6(b)): assay-schema-fingerprint-v1 outputs are pinned', () => {
  it('the recorded algorithm label is assay-schema-fingerprint-v1', () => {
    expect(CANDIDATE_SCHEMA_FINGERPRINT_ALGORITHM).toBe('assay-schema-fingerprint-v1')
  })

  for (const vector of VECTORS) {
    it(`vector: ${vector.label} → ${vector.fingerprint.slice(0, 16)}…`, async () => {
      // The pin's premise: the canonical rendering of this set is what the
      // table says it is (independent of the implementation).
      expect(canonicalRendering(vector.columns)).toBe(vector.rendering)
      expect(await independentDigest(vector.rendering)).toBe(vector.fingerprint)

      const ref = await candidateVersionRefFromRun({
        run: completedRun('out'),
        plan: PLAN,
        nodeId: 'out',
        datasetId: 'fixture-dataset',
        schemaOf: async () => vector.columns,
      })
      expect(ref.schemaFingerprint).toEqual({
        algorithm: 'assay-schema-fingerprint-v1',
        value: vector.fingerprint,
      })
    })
  }

  it('the derived default version id is the pinned fingerprint prefix (deterministic, no wall-clock)', async () => {
    const vector = VECTORS[1]
    if (vector === undefined) throw new Error('unreachable: the vector table is non-empty')
    const ref = await candidateVersionRefFromRun({
      run: completedRun('out'),
      plan: PLAN,
      nodeId: 'out',
      datasetId: 'fixture-dataset',
      schemaOf: async () => vector.columns,
    })
    expect(ref.versionId).toBe(`fixture-dataset@${vector.fingerprint.slice(0, 16)}`)
  })

  it('column order never changes the fingerprint: a shuffled introspection yields the pinned value', async () => {
    const vector = VECTORS[3]
    if (vector === undefined) throw new Error('unreachable: the vector table is non-empty')
    const shuffled = [...vector.columns].reverse()
    expect(canonicalRendering(shuffled)).toBe(vector.rendering)
    const ref = await candidateVersionRefFromRun({
      run: completedRun('out'),
      plan: PLAN,
      nodeId: 'out',
      datasetId: 'fixture-dataset',
      schemaOf: async () => shuffled,
    })
    expect(ref.schemaFingerprint.value).toBe(vector.fingerprint)
  })

  it('an empty introspected schema refuses (candidate-schema-unavailable) — no fingerprint is minted from nothing', async () => {
    await expect(
      candidateVersionRefFromRun({
        run: completedRun('out'),
        plan: PLAN,
        nodeId: 'out',
        datasetId: 'fixture-dataset',
        schemaOf: async () => [],
      }),
    ).rejects.toThrow(PipelineRunRefusalError)
  })
})
