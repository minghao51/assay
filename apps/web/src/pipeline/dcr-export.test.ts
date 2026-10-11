// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit pins for the p3-4 web DCR export (`./dcr-export`).
 *
 * The LOAD-BEARING PIN: the web derivation — the real `parsePipeline` over
 * the committed golden gated pipeline, the real p3-2
 * `candidateVersionRefFromRun`, the real `@assay/diff` classifier, the real
 * p3-1 `buildDcrArtifact` + `serializeDcr`, with ONLY the engine
 * introspection faked (the session seam; the real-engine path is the
 * playwright journey) — produces bytes IDENTICAL to the committed golden
 * `fixtures/dcr/cli-gated-run.yaml` the p3-3 CLI path minted. That is the
 * web≡CLI byte-agreement, asserted byte-for-byte, plus round-trip and
 * run-to-run stability.
 *
 * Also pinned here: the D19-OQ-5 export-time liveness refusal (typed data,
 * nothing built), the full typed refusal taxonomy, the value-free scan
 * (ADR 0025), and the m5-3/m6-4 delivery discipline (messages + both save
 * strategies + the same-source refusal).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDcr, parsePipeline, serializeDcr } from '@assay/pipeline'
import type { PipelineRunColumn, PipelineRunResult } from '@assay/engine-duckdb'
import { describe, expect, it } from 'vitest'
import {
  DCR_EXPORT_CANCELLED_MESSAGE,
  DCR_EXPORT_SAME_SOURCE_MESSAGE,
  dcrArtifactFileName,
  dcrExportableNodeIds,
  dcrExportFailureMessage,
  dcrExportSuccessMessage,
  dcrRefusalMessage,
  deriveDcrArtifact,
  requestDcrDestination,
  writeDcrCopy,
} from './dcr-export'
import type { DcrExportRefusal, DcrExportSpec } from './dcr-export'

const REPO_ROOT = process.cwd()
const GOLDEN_PIPELINE_PATH = join(REPO_ROOT, 'fixtures', 'pipeline', 'cli_dcr_gated.yaml')
const COMMITTED_GOLDEN_PATH = join(REPO_ROOT, 'fixtures', 'dcr', 'cli-gated-run.yaml')

/** The committed golden gated pipeline (the CLI byte-pin's own input). */
function goldenPipelineText(): string {
  expect(existsSync(GOLDEN_PIPELINE_PATH), 'the golden gated pipeline fixture must exist').toBe(
    true,
  )
  return readFileSync(GOLDEN_PIPELINE_PATH, 'utf8')
}

/** The committed golden artifact the p3-3 CLI path minted (byte-pin target). */
function committedGoldenBytes(): Buffer {
  expect(existsSync(COMMITTED_GOLDEN_PATH), 'the committed golden artifact must exist').toBe(true)
  return readFileSync(COMMITTED_GOLDEN_PATH)
}

/**
 * The executed golden gated run, exactly as the engine produces it: the run
 * stops at the failing `quality` validate gate after `by_country`
 * materialized (1 SG group), so the executed prefix is the lineage.
 */
function goldenGatedRun(): Extract<PipelineRunResult, { status: 'gated' }> {
  return {
    status: 'gated',
    gatedAt: 'quality',
    gate: 'validation-failed',
    nextNodeId: null,
    nodes: [
      { nodeId: 'customers', relation: 'customers', rowCount: 5, materialization: 'source' },
      { nodeId: 'renamed', relation: 'renamed', rowCount: 5, materialization: 'view' },
      { nodeId: 'sg_only', relation: 'sg_only', rowCount: 2, materialization: 'view' },
      { nodeId: 'by_country', relation: 'by_country', rowCount: 1, materialization: 'view' },
      {
        nodeId: 'quality',
        relation: 'by_country',
        rowCount: 1,
        materialization: 'gate',
        gate: { class: 'validate', input: 'by_country', valid: false, violatedRules: 1 },
      },
    ],
  }
}

/**
 * The two materialized relations' schemas — the engine introspection the
 * golden run produced (types as DuckDB spells them for the CSV fixture).
 * This is the ONE fake: the session seam (`schemaOf`), same boundary the
 * CLI unit tests fake.
 */
function goldenSchemaOf(relation: string): readonly PipelineRunColumn[] {
  if (relation === 'renamed') {
    return [
      { name: 'customer_ref', type: 'BIGINT' },
      { name: 'country', type: 'VARCHAR' },
      { name: 'income', type: 'BIGINT' },
      { name: 'signup_date', type: 'DATE' },
    ]
  }
  if (relation === 'by_country') {
    return [
      { name: 'country', type: 'VARCHAR' },
      { name: 'customers', type: 'BIGINT' },
    ]
  }
  return [{ name: 'customer_id', type: 'BIGINT' }]
}

/** The golden journey's side spec (the CLI's --base/--candidate flags). */
function goldenSpec(): DcrExportSpec {
  return {
    baseNodeId: 'renamed',
    baseDatasetId: 'customers_base',
    candidateNodeId: 'by_country',
    candidateDatasetId: 'customers_by_country',
  }
}

function deriveGolden(): ReturnType<typeof deriveDcrArtifact> {
  const parsed = parsePipeline(goldenPipelineText())
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) throw new Error('the golden pipeline must parse')
  return deriveDcrArtifact({
    run: goldenGatedRun(),
    plan: parsed.pipeline,
    schemaOf: async (relation) => goldenSchemaOf(relation),
    spec: goldenSpec(),
  })
}

/** Distinctive synthetic cell values of the golden CSV fixture (never real). */
const GOLDEN_CELL_VALUES = [
  'SG',
  'US',
  'DE',
  '52000',
  '61000',
  '48000',
  '75000',
  '2025-01-04',
  '2025-02-02',
  '2025-02-19',
  '2025-03-01',
]

describe('deriveDcrArtifact — the web≡CLI byte-agreement pin (load-bearing)', () => {
  it('web bytes ≡ the committed CLI-minted golden bytes, byte-for-byte', async () => {
    const derived = await deriveGolden()
    expect(derived.ok).toBe(true)
    if (!derived.ok) return
    const webBytes = Buffer.from(derived.yaml, 'utf8')
    expect(webBytes.equals(committedGoldenBytes())).toBe(true)
  })

  it('the derived bytes round-trip through the total parser byte-identically', async () => {
    const derived = await deriveGolden()
    expect(derived.ok).toBe(true)
    if (!derived.ok) return
    const parsed = parseDcr(derived.yaml)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(
      Buffer.from(serializeDcr(parsed.artifact), 'utf8').equals(Buffer.from(derived.yaml, 'utf8')),
    ).toBe(true)
  })

  it('is byte-stable across derivations (no wall-clock)', async () => {
    const first = await deriveGolden()
    const second = await deriveGolden()
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.yaml).toBe(second.yaml)
  })

  it('the summary carries the value-free counts (findings, verdicts, honest roll-up)', async () => {
    const derived = await deriveGolden()
    expect(derived.ok).toBe(true)
    if (!derived.ok) return
    expect(derived.summary).toEqual({
      baseDatasetId: 'customers_base',
      candidateDatasetId: 'customers_by_country',
      baseNodeId: 'renamed',
      candidateNodeId: 'by_country',
      schemaDriftFindings: 4,
      validationVerdicts: 1,
      validationValid: false,
    })
  })

  it('is value-free: no dataset cell value reaches the artifact bytes (ADR 0025)', async () => {
    const derived = await deriveGolden()
    expect(derived.ok).toBe(true)
    if (!derived.ok) return
    for (const value of GOLDEN_CELL_VALUES) {
      expect(derived.yaml).not.toContain(value)
    }
  })
})

describe('deriveDcrArtifact — the D19-OQ-5 export-time liveness refusal', () => {
  it('a relation that no longer resolves refuses loudly — dangling, typed, nothing built', async () => {
    const parsed = parsePipeline(goldenPipelineText())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const derived = await deriveDcrArtifact({
      run: goldenGatedRun(),
      plan: parsed.pipeline,
      schemaOf: async () => {
        throw new Error('the view was dropped')
      },
      spec: goldenSpec(),
    })
    expect(derived).toEqual({
      ok: false,
      refusal: { reason: 'dangling-materialization', nodeId: 'renamed' },
    })
  })

  it('a relation introspecting to an empty schema is dangling too', async () => {
    const parsed = parsePipeline(goldenPipelineText())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const derived = await deriveDcrArtifact({
      run: goldenGatedRun(),
      plan: parsed.pipeline,
      schemaOf: async () => [],
      spec: goldenSpec(),
    })
    expect(derived).toEqual({
      ok: false,
      refusal: { reason: 'dangling-materialization', nodeId: 'renamed' },
    })
  })

  it('the candidate side is liveness-verified too (base first, then candidate)', async () => {
    const parsed = parsePipeline(goldenPipelineText())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const derived = await deriveDcrArtifact({
      run: goldenGatedRun(),
      plan: parsed.pipeline,
      schemaOf: async (relation) => (relation === 'by_country' ? [] : goldenSchemaOf(relation)),
      spec: goldenSpec(),
    })
    expect(derived).toEqual({
      ok: false,
      refusal: { reason: 'dangling-materialization', nodeId: 'by_country' },
    })
  })

  it('the refusal message says NOTHING was written (the OQ-5 in-panel line)', () => {
    const message = dcrRefusalMessage({
      reason: 'dangling-materialization',
      nodeId: 'by_country',
    })
    expect(message).toContain('no longer')
    expect(message).toContain('Nothing was written')
  })
})

describe('deriveDcrArtifact — the typed refusal taxonomy', () => {
  const parsed = parsePipeline(goldenPipelineText())
  const plan = parsed.ok ? parsed.pipeline : null

  function expectRefusal(
    derived: Awaited<ReturnType<typeof deriveDcrArtifact>>,
    refusal: DcrExportRefusal,
  ): void {
    expect(derived).toEqual({ ok: false, refusal })
  }

  it('an unknown node id is node-unknown', async () => {
    if (plan === null) throw new Error('the golden pipeline must parse')
    expectRefusal(
      await deriveDcrArtifact({
        run: goldenGatedRun(),
        plan,
        schemaOf: async (relation) => goldenSchemaOf(relation),
        spec: { ...goldenSpec(), baseNodeId: 'ghost' },
      }),
      { reason: 'node-unknown', nodeId: 'ghost' },
    )
  })

  it('a node the run never executed is node-absent', async () => {
    if (plan === null) throw new Error('the golden pipeline must parse')
    const run = goldenGatedRun()
    expectRefusal(
      await deriveDcrArtifact({
        run: { ...run, nodes: run.nodes.slice(0, 2) },
        plan,
        schemaOf: async (relation) => goldenSchemaOf(relation),
        spec: goldenSpec(),
      }),
      { reason: 'node-absent', nodeId: 'by_country' },
    )
  })

  it('a gate node is node-unknown (gates are not data nodes of the plan)', async () => {
    if (plan === null) throw new Error('the golden pipeline must parse')
    expectRefusal(
      await deriveDcrArtifact({
        run: goldenGatedRun(),
        plan,
        schemaOf: async (relation) => goldenSchemaOf(relation),
        spec: { ...goldenSpec(), candidateNodeId: 'quality' },
      }),
      { reason: 'node-unknown', nodeId: 'quality' },
    )
  })

  it('a source node is node-not-materialized too', async () => {
    if (plan === null) throw new Error('the golden pipeline must parse')
    expectRefusal(
      await deriveDcrArtifact({
        run: goldenGatedRun(),
        plan,
        schemaOf: async (relation) => goldenSchemaOf(relation),
        spec: { ...goldenSpec(), baseNodeId: 'customers' },
      }),
      { reason: 'node-not-materialized', nodeId: 'customers' },
    )
  })

  it('an empty dataset id is identity-invalid', async () => {
    if (plan === null) throw new Error('the golden pipeline must parse')
    expectRefusal(
      await deriveDcrArtifact({
        run: goldenGatedRun(),
        plan,
        schemaOf: async (relation) => goldenSchemaOf(relation),
        spec: { ...goldenSpec(), baseDatasetId: '' },
      }),
      { reason: 'identity-invalid', nodeId: 'renamed' },
    )
  })

  it('every refusal message states that nothing was written', () => {
    for (const reason of [
      'dangling-materialization',
      'run-canceled',
      'node-unknown',
      'node-absent',
      'node-not-materialized',
      'publish-materialization',
      'unsupported-materialization',
      'identity-invalid',
      'builder-refused',
      'same-node',
    ] as const) {
      expect(dcrRefusalMessage({ reason, nodeId: null })).toContain('Nothing was written')
    }
  })
})

describe('dcrExportableNodeIds — the offered side options', () => {
  it('offers materialized data nodes in execution order, never source/gate nodes', () => {
    expect(dcrExportableNodeIds(goldenGatedRun())).toEqual(['renamed', 'sg_only', 'by_country'])
  })

  it('an export node is offered (the derivation refuses it loudly if it dangles)', () => {
    const run = goldenGatedRun()
    const withExport: Extract<PipelineRunResult, { status: 'gated' }> = {
      ...run,
      nodes: [
        ...run.nodes,
        {
          nodeId: 'dump',
          relation: 'dump',
          rowCount: 1,
          materialization: 'export',
          exportPath: '/pipeline-exports/dump.parquet',
        },
      ],
    }
    expect(dcrExportableNodeIds(withExport)).toContain('dump')
  })
})

describe('the m5-3/m6-4 delivery discipline', () => {
  const YAML = 'format: assay-dcr\nversion: 1\n'

  it('suggests a new-file artifact name, never a source name', () => {
    expect(dcrArtifactFileName()).toBe('assay-dcr.yaml')
  })

  it('an input-fallback session (no provable identity) is download-only by construction', async () => {
    const strategy = await writeDcrCopy({ via: 'download' }, { yaml: YAML })
    expect(strategy).toBe('download')
  })

  it('an FSA destination gets a direct write of the exact bytes', async () => {
    const written: Uint8Array<ArrayBuffer>[] = []
    const strategy = await writeDcrCopy(
      {
        via: 'file-system-access',
        handle: {
          createWritable: async () => ({
            write: async (chunk) => {
              written.push(chunk)
            },
            close: async () => {},
          }),
        },
      },
      { yaml: YAML },
    )
    expect(strategy).toBe('file-system-access')
    expect(Buffer.from(written[0] ?? []).toString('utf8')).toBe(YAML)
  })

  it('without a retained source identity the save picker is never offered', async () => {
    const destination = await requestDcrDestination({
      showSaveFilePicker: async () => {
        throw new Error('the picker must never be offered')
      },
    })
    expect(destination).toEqual({ via: 'download' })
  })

  it('a picked handle that IS the opened source is refused before any write', async () => {
    const destination = await requestDcrDestination({
      capabilities: { fileSavePicker: true },
      showSaveFilePicker: async () => ({
        createWritable: async () => {
          throw new Error('must never reach a write')
        },
      }),
      sourceIdentity: { isSameEntry: async () => true },
    })
    expect(destination).toEqual({ via: 'refused-source' })
  })

  it('a picker that fails for a real reason propagates (surfaced by the caller)', async () => {
    await expect(
      requestDcrDestination({
        capabilities: { fileSavePicker: true },
        showSaveFilePicker: async () => {
          throw new Error('picker crashed')
        },
        sourceIdentity: { isSameEntry: async () => false },
      }),
    ).rejects.toThrow('picker crashed')
  })

  it('a dismissed picker resolves null (a real cancel, not a failure)', async () => {
    const destination = await requestDcrDestination({
      capabilities: { fileSavePicker: true },
      showSaveFilePicker: async () => {
        throw Object.assign(new Error('user dismissed'), { name: 'AbortError' })
      },
      sourceIdentity: { isSameEntry: async () => false },
    })
    expect(destination).toBeNull()
  })

  it('the result lines are honest about strategy and the unchanged source', () => {
    const summary = {
      baseDatasetId: 'b',
      candidateDatasetId: 'c',
      baseNodeId: 'x',
      candidateNodeId: 'y',
      schemaDriftFindings: 4,
      validationVerdicts: 1,
      validationValid: false,
    }
    expect(dcrExportSuccessMessage(summary, 'download')).toContain('new file')
    expect(dcrExportSuccessMessage(summary, 'download')).toContain('The opened file is unchanged')
    expect(dcrExportSuccessMessage(summary, 'file-system-access')).toContain('to a new file')
    expect(DCR_EXPORT_CANCELLED_MESSAGE).toContain('no new file was written')
    expect(DCR_EXPORT_SAME_SOURCE_MESSAGE).toContain('Nothing was written')
    expect(dcrExportFailureMessage(new Error('boom\nSQL: select *'))).toContain('boom')
    expect(dcrExportFailureMessage(new Error('boom\nSQL: select *'))).not.toContain('SQL')
    expect(dcrExportFailureMessage(new Error('boom'))).toContain('No file was written')
  })
})
