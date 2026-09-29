// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { serializePipeline } from './serialize.js'
import { parsePipeline } from './parse.js'
import type { PipelineV1 } from './ast.js'

describe('serializePipeline: canonical bytes', () => {
  it('emits a stable minimal document (root/node key order, flow inputs, literal sql)', () => {
    const pipeline: PipelineV1 = {
      version: 1,
      pipeline: 'demo',
      nodes: [
        { id: 'z', type: 'sql', inputs: ['a'], sql: 'SELECT 1\n' },
        { id: 'a', type: 'source', source: { kind: 'file', path: './a.parquet' } },
      ],
    }
    expect(serializePipeline(pipeline)).toBe(`version: 1
pipeline: demo
nodes:
  a:
    type: source
    source:
      kind: file
      path: ./a.parquet
  z:
    type: sql
    inputs: [ a ]
    sql: |
      SELECT 1
`)
  })

  it('sorts generic mapping keys and keeps kind first in source config', () => {
    const pipeline: PipelineV1 = {
      version: 1,
      pipeline: 'demo',
      nodes: [
        {
          id: 's',
          type: 'source',
          source: { kind: 'file', zeta: 1, alpha: { b: 2, a: 1 } },
        },
      ],
    }
    expect(serializePipeline(pipeline)).toBe(`version: 1
pipeline: demo
nodes:
  s:
    type: source
    source:
      kind: file
      alpha:
        a: 1
        b: 2
      zeta: 1
`)
  })

  it('sorts operation args and diff config, and renders requires only when present', () => {
    const pipeline: PipelineV1 = {
      version: 1,
      pipeline: 'demo',
      nodes: [
        {
          id: 't',
          type: 'transform',
          inputs: ['s'],
          operation: { operation: 'join', args: { right: 's', left: 's', on: ['id'] } },
        },
        { id: 's', type: 'source', source: { kind: 'file' } },
        { id: 'd', type: 'diff', config: { z: 1, a: 2 } },
        { id: 'p', type: 'publish', input: 't' },
        { id: 'p2', type: 'publish', input: 't', requires: ['d'] },
      ],
    }
    const text = serializePipeline(pipeline)
    expect(text).toContain(`      join:
        left: s
        on:
          - id
        right: s`)
    expect(text).toContain(`  d:
    type: diff
    a: 2
    z: 1`)
    expect(text).toContain(`  p:
    type: publish
    input: t
`)
    expect(text).toContain(`  p2:
    type: publish
    input: t
    requires: [ d ]`)
  })

  it('is byte-identical regardless of node array order and generic key insertion order', () => {
    const nodes: PipelineV1['nodes'] = [
      { id: 'b', type: 'source', source: { kind: 'file', z: 1, a: 2 } },
      { id: 'a', type: 'sql', inputs: ['b'], sql: 'SELECT 1' },
    ]
    const reversed: PipelineV1 = { version: 1, pipeline: 'p', nodes: [...nodes].reverse() }
    const forward: PipelineV1 = { version: 1, pipeline: 'p', nodes }
    expect(serializePipeline(forward)).toBe(serializePipeline(reversed))
  })
})

describe('serializePipeline: totality', () => {
  it('never throws on caller bugs behind a cast', () => {
    expect(() => serializePipeline(null as unknown as PipelineV1)).not.toThrow()
    expect(() => serializePipeline({} as PipelineV1)).not.toThrow()
    expect(() =>
      serializePipeline({
        version: 1,
        pipeline: 7 as unknown as string,
        nodes: [
          { id: { toString: null }, type: 'source', source: null },
          { type: 'mystery' },
        ] as unknown as PipelineV1['nodes'],
      }),
    ).not.toThrow()
  })
})

describe('serializePipeline: fixpoint', () => {
  it('serialization is a fixpoint of parse∘serialize', () => {
    const text = `version: 1
pipeline: demo
nodes:
  a:
    type: source
    source:
      kind: file
      path: ./a.parquet
  b:
    type: sql
    inputs: [a]
    sql: SELECT 1
`
    const parsed = parsePipeline(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const once = serializePipeline(parsed.pipeline)
    const reparsed = parsePipeline(once)
    expect(reparsed).toEqual({ ok: true, pipeline: parsed.pipeline })
    expect(serializePipeline(reparsed.ok ? reparsed.pipeline : parsed.pipeline)).toBe(once)
  })
})
