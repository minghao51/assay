// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * DuckDB engine adapter for the p-3/p2-4 pipeline-runner conformance suite
 * (`@assay/testing`). Mirrors `conformance-subject.ts`'s dependency direction
 * (implementations import the testing package) but binds the dedicated
 * runner suite to the REAL `DuckDbEngineClient.runPipeline` on the real
 * DuckDB-WASM engine. Browser-only (OPFS staging + a real Worker).
 *
 * The suite's runner seam is deliberately structural
 * (`PipelineRunnerConformanceRunOptions`), so this adapter bridges shapes to
 * the real client:
 * - `sources[].source.getFile(): Promise<unknown>` → the client's
 *   `PipelineRunSource` (`Promise<File>`). The staged value is a genuine
 *   `FileSystemFileHandle`, validated here rather than assumed.
 * - the structural guard (`{ invalidate }`) → the real `PipelineRunGuard`.
 * - the suite's opaque parsed contracts / diff key sets → the pure
 *   `@assay/validation` / `@assay/diff` compilers the runner consumes (the
 *   engine package stays dependency-free of those packages; the host supplies
 *   the compiled plans).
 *
 * Privacy: the suite reports only ids/counts; no dataset values are rendered
 * here beyond the column a scenario explicitly reads back.
 */
import { compileContract, sqlStringLiteral } from '@assay/validation'
import { compileRowDiffPlan } from '@assay/diff'
import {
  DuckDbEngineClient,
  EngineOperationError,
  PipelineRunError,
  PipelineRunGuard,
  PipelineRunRefusalError,
  quotedIdentifier,
} from '../src/index'
import type { PipelineRunCompilers, PipelineRunSourceFile } from '../src/index'
import type {
  PipelineRunnerConformanceGuard,
  PipelineRunnerConformanceRunner,
  PipelineRunnerConformanceRunOptions,
  PipelineRunnerConformanceSource,
  PipelineRunnerConformanceSubject,
  PipelineRunnerConformanceTableHandle,
} from '@assay/testing'
import type { ContractV1 } from '@assay/contracts'
import type { PipelineV1 } from '@assay/pipeline'

/** Stage bytes into the OPFS sandbox and return a genuine file handle. */
async function stageBytesInOpfs(bytes: Uint8Array, name: string): Promise<FileSystemFileHandle> {
  const root = await navigator.storage.getDirectory()
  const fileHandle = await root.getFileHandle(name, { create: true })
  const writable = await fileHandle.createWritable()
  const chunk = new Uint8Array(bytes.byteLength)
  chunk.set(bytes)
  await writable.write(chunk)
  await writable.close()
  return fileHandle
}

/**
 * The real guards behind the suite's structural guards (the cancel bridge):
 * `createGuard` mints the pair; `runPipeline` looks the real half up when the
 * suite passes its half back in the run options.
 */
const realGuards = new WeakMap<PipelineRunnerConformanceGuard, PipelineRunGuard>()

/** The pure M5/M6 plan compilers the runner consumes (host-supplied). */
function buildCompilers(): PipelineRunCompilers {
  return {
    validate: (input) => {
      const compiled = compileContract(input.contract as ContractV1, [...input.columns], {
        relation: input.relation,
      })
      return compiled.ok ? { ok: true, plan: compiled.plan } : { ok: false }
    },
    diff: (input) => {
      const compiled = compileRowDiffPlan([...input.schemaA], [...input.schemaB], [...input.keys], {
        relationA: input.relationA,
        relationB: input.relationB,
      })
      return compiled.ok ? { ok: true, plan: compiled.plan } : { ok: false }
    },
  }
}

class HarnessPipelineRunner implements PipelineRunnerConformanceRunner {
  constructor(private readonly client: DuckDbEngineClient) {}

  runPipeline(
    pipeline: PipelineV1,
    options: PipelineRunnerConformanceRunOptions,
  ): ReturnType<DuckDbEngineClient['runPipeline']> {
    return this.client.runPipeline(pipeline, {
      sources: options.sources?.map((binding) => ({
        nodeId: binding.nodeId,
        source: bridgeSource(binding.source),
      })),
      guard: options.guard === undefined ? undefined : bridgeGuard(options.guard),
      onNode: options.onNode,
      ...(options.contracts === undefined ? {} : { contracts: [...options.contracts] }),
      ...(options.diffKeys === undefined ? {} : { diffKeys: [...options.diffKeys] }),
      compilers: buildCompilers(),
    })
  }

  async readColumn(relation: string, column: string): Promise<readonly (string | null)[]> {
    const result = await this.client.query(
      `SELECT CAST(${quotedIdentifier(column)} AS VARCHAR) AS "value" FROM ${quotedIdentifier(relation)}`,
    )
    const vector = result.batch.getChildAt(0)
    if (vector === null) return []
    const values: (string | null)[] = []
    for (let row = 0; row < vector.length; row++) {
      const value: unknown = vector.get(row)
      values.push(value === null || value === undefined ? null : String(value))
    }
    return values
  }

  registerRelation(relation: string): Promise<PipelineRunnerConformanceTableHandle> {
    return this.client.registerPipelineRelation(relation)
  }

  async schema(
    handle: PipelineRunnerConformanceTableHandle,
  ): Promise<readonly { readonly name: string; readonly type: string }[]> {
    const columns = await this.client.schema(handle)
    return columns.map((column) => ({ name: column.name, type: column.type }))
  }

  rowCount(handle: PipelineRunnerConformanceTableHandle): Promise<number> {
    return this.client.rowCount(handle)
  }

  /**
   * The physical kind of a session relation (p2-4). `information_schema.tables`
   * reports `VIEW` for `CREATE VIEW` relations and `BASE TABLE` for
   * `CREATE TABLE` ones; a relation absent from both is `missing`. The
   * relation is rendered as a string literal (never an identifier), so a
   * hostile name cannot alter the query.
   */
  async relationKind(relation: string): Promise<'table' | 'view' | 'missing'> {
    const result = await this.client.query(
      `SELECT table_type FROM information_schema.tables WHERE table_name = ${sqlStringLiteral(relation)}`,
    )
    const vector = result.batch.getChildAt(0)
    if (vector === null || vector.length === 0) return 'missing'
    const value: unknown = vector.get(0)
    const text = value === null || value === undefined ? '' : String(value)
    if (text === 'BASE TABLE') return 'table'
    if (text === 'VIEW') return 'view'
    return 'missing'
  }

  dispose(): Promise<void> {
    return this.client.dispose()
  }
}

/** Validate a suite source's staged value into the client's File contract. */
function bridgeSource(source: PipelineRunnerConformanceSource): PipelineRunSourceFile {
  return {
    name: source.name,
    getFile: async () => {
      const file: unknown = await source.getFile()
      if (typeof File !== 'undefined' && file instanceof File) return file
      throw new Error('the staged pipeline source is not a File')
    },
  }
}

/** The real guard behind a suite guard (only `createGuard` mints pairs). */
function bridgeGuard(guard: PipelineRunnerConformanceGuard): PipelineRunGuard {
  const real = realGuards.get(guard)
  if (real === undefined) {
    throw new Error('the guard was not created by this harness (createGuard required)')
  }
  return real
}

export interface PipelineRunnerSubjectOptions {
  /** URL (served by this harness) of the 5-row customer Parquet fixture. */
  readonly fixtureUrl: string
}

export function createPipelineRunnerSubject(
  options: PipelineRunnerSubjectOptions,
): PipelineRunnerConformanceSubject {
  return {
    name: 'engine-duckdb',
    createRunner: () => new HarnessPipelineRunner(new DuckDbEngineClient()),
    dispose: async (runner) => {
      if (runner instanceof HarnessPipelineRunner) await runner.dispose()
    },
    stageSource: async (): Promise<PipelineRunnerConformanceSource> => {
      const response = await fetch(options.fixtureUrl)
      if (!response.ok) throw new Error(`pipeline fixture fetch failed: HTTP ${response.status}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      return stageBytesInOpfs(bytes, 'assay-pipeline-runner-source.parquet')
    },
    createGuard: (): PipelineRunnerConformanceGuard => {
      const real = new PipelineRunGuard()
      const bridge: PipelineRunnerConformanceGuard = {
        invalidate: () => real.invalidate(),
      }
      realGuards.set(bridge, real)
      return bridge
    },
    errors: {
      refusal: (error) => error instanceof PipelineRunRefusalError,
      failure: (error) => error instanceof PipelineRunError,
      failureNodeId: (error) => (error instanceof PipelineRunError ? error.nodeId : null),
      failurePartial: (error) =>
        error instanceof PipelineRunError ? error.partial.map((entry) => entry.nodeId) : [],
      operation: (error) => error instanceof EngineOperationError,
      refusalReason: (error) => (error instanceof PipelineRunRefusalError ? error.reason : null),
    },
  }
}
