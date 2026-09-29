// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { validatePipeline } from './dag.js'
import type { PipelineNode, PipelineV1 } from './ast.js'
import { genPipeline, makeTestRng, type TestRng } from './property-testing.js'

function pipelineOf(nodes: PipelineNode[]): PipelineV1 {
  return { version: 1, pipeline: 'test', nodes }
}

function source(id: string): PipelineNode {
  return { id, type: 'source', source: { kind: 'file', path: `./${id}.parquet` } }
}

function transform(id: string, inputs: string[]): PipelineNode {
  return { id, type: 'transform', inputs, operation: { operation: 'filter', args: {} } }
}

describe('validatePipeline: accepted DAGs', () => {
  it('accepts the §5-style DAG and returns a topological order', () => {
    const result = validatePipeline(
      pipelineOf([
        source('customers'),
        source('policies'),
        transform('sg_customers', ['customers']),
        transform('customer_policies', ['sg_customers', 'policies']),
        { id: 'portfolio', type: 'sql', inputs: ['customer_policies'], sql: 'SELECT 1' },
        {
          id: 'quality',
          type: 'validate',
          input: 'portfolio',
          contract: 'contracts/portfolio.yaml',
        },
        { id: 'output', type: 'publish', input: 'portfolio', requires: ['quality'] },
      ]),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.order).toEqual([
      'customers',
      'policies',
      'sg_customers',
      'customer_policies',
      'portfolio',
      'quality',
      'output',
    ])
    expect(isTopological(result.pipeline, result.order)).toBe(true)
  })

  it('accepts a pipeline with no nodes', () => {
    const result = validatePipeline(pipelineOf([]))
    expect(result).toEqual({ ok: true, pipeline: pipelineOf([]), order: [] })
  })

  it('accepts reserved nodes and an opaque diff body', () => {
    const result = validatePipeline(
      pipelineOf([
        source('raw'),
        { id: 'd', type: 'diff', config: { against: 'raw' } },
        { id: 'v', type: 'validate', input: 'raw', contract: 'c.yaml' },
        { id: 'p', type: 'publish', input: 'raw', requires: ['d', 'v'] },
      ]),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.order.indexOf('d')).toBeLessThan(result.order.indexOf('p'))
    expect(result.order.indexOf('v')).toBeLessThan(result.order.indexOf('p'))
  })
})

describe('validatePipeline: rejected DAGs', () => {
  it('flags duplicate node ids as single-writer', () => {
    const result = validatePipeline(pipelineOf([source('a'), source('a')]))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.map((error) => error.code)).toEqual(['single-writer'])
    expect(result.errors[0]?.nodeId).toBe('a')
  })

  it('flags invalid node ids', () => {
    const result = validatePipeline(
      pipelineOf([{ id: '', type: 'source', source: { kind: 'file' } }]),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]?.code).toBe('invalid-reference')
  })

  it('flags unresolved data and gate references', () => {
    const data = validatePipeline(pipelineOf([transform('a', ['missing'])]))
    expect(data.ok).toBe(false)
    if (!data.ok)
      expect(data.errors[0]).toMatchObject({ code: 'unresolved-reference', nodeId: 'a' })

    const gate = validatePipeline(
      pipelineOf([source('s'), { id: 'p', type: 'publish', input: 's', requires: ['missing'] }]),
    )
    expect(gate.ok).toBe(false)
    if (!gate.ok) expect(gate.errors[0]?.code).toBe('unresolved-reference')
  })

  it('flags non-string/empty data references', () => {
    const bad = {
      id: 'a',
      type: 'transform',
      inputs: [3],
      operation: { operation: 'filter', args: {} },
    } as unknown as PipelineNode
    const result = validatePipeline(pipelineOf([bad]))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]?.code).toBe('invalid-reference')
  })

  it('flags data inputs that reference a non-data node (port type-shape)', () => {
    const result = validatePipeline(
      pipelineOf([
        source('s'),
        { id: 'v', type: 'validate', input: 's', contract: 'c.yaml' },
        { id: 'q', type: 'sql', inputs: ['v'], sql: 'SELECT 1' },
      ]),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.map((error) => error.code)).toContain('port-type-shape')
  })

  it('flags source arity and transform arity', () => {
    const stray = {
      id: 's',
      type: 'source',
      source: { kind: 'file' },
      inputs: ['x'],
    } as unknown as PipelineNode
    const sourceResult = validatePipeline(pipelineOf([stray]))
    expect(sourceResult.ok).toBe(false)
    if (!sourceResult.ok) expect(sourceResult.errors.map((e) => e.code)).toContain('port-arity')

    const transformResult = validatePipeline(pipelineOf([transform('t', [])]))
    expect(transformResult.ok).toBe(false)
    if (!transformResult.ok)
      expect(transformResult.errors.map((e) => e.code)).toContain('port-arity')
  })

  it('detects cycles (including self-loops) with a concrete path', () => {
    const cycle = validatePipeline(pipelineOf([transform('a', ['b']), transform('b', ['a'])]))
    expect(cycle.ok).toBe(false)
    if (!cycle.ok) {
      const error = cycle.errors.find((e) => e.code === 'cycle')
      expect(error).toBeDefined()
      expect(error?.message).toContain('"a"')
      expect(error?.nodeId).toBeDefined()
    }

    const self = validatePipeline(pipelineOf([transform('a', ['a'])]))
    expect(self.ok).toBe(false)
    if (!self.ok) expect(self.errors[0]?.code).toBe('cycle')
  })

  it('reports unresolved references before attempting a cycle', () => {
    const result = validatePipeline(
      pipelineOf([transform('a', ['b']), transform('b', ['missing'])]),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.map((error) => error.code)).toContain('unresolved-reference')
    expect(result.errors.map((error) => error.code)).not.toContain('cycle')
  })
})

describe('validatePipeline: properties', () => {
  it('accepts generated pipelines and returns a topological order', () => {
    const rng = makeTestRng(20260929)
    for (let i = 0; i < 400; i++) {
      const pipeline = genPipeline(rng)
      const result = validatePipeline(pipeline)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(isTopological(result.pipeline, result.order)).toBe(true)
      expect(new Set(result.order).size).toBe(result.order.length)
    }
  })

  it('agrees with a reference acyclicity check on random graphs (seed 20260930)', () => {
    const rng = makeTestRng(20260930)
    for (let i = 0; i < 500; i++) {
      const pipeline = randomGraph(rng)
      const result = validatePipeline(pipeline)
      const acyclic = referenceIsAcyclic(pipeline)
      expect(result.ok).toBe(acyclic)
      if (result.ok) expect(isTopological(result.pipeline, result.order)).toBe(true)
    }
  })
})

/** Shuffle helper for graphs: pick `count` distinct items. */
function pickDistinct<T>(rng: TestRng, items: readonly T[], count: number): T[] {
  const shuffled = rng.shuffle(items)
  return shuffled.slice(0, Math.min(count, shuffled.length))
}

function randomGraph(rng: TestRng): PipelineV1 {
  const n = rng.int(1, 7)
  const ids = Array.from({ length: n }, (_, index) => `n${index}`)
  const nodes: PipelineNode[] = ids.map((id) => {
    const inputs = pickDistinct(rng, ids, rng.int(1, Math.min(3, ids.length)))
    return transform(id, inputs)
  })
  return pipelineOf(nodes)
}

/** Independent DFS-based acyclicity reference for the property test. */
function referenceIsAcyclic(pipeline: PipelineV1): boolean {
  const deps = new Map<string, string[]>()
  for (const node of pipeline.nodes) {
    deps.set(node.id, node.type === 'transform' || node.type === 'sql' ? [...node.inputs] : [])
  }
  const state = new Map<string, 0 | 1 | 2>()
  const visit = (id: string): boolean => {
    const status = state.get(id)
    if (status === 1) return false
    if (status === 2) return true
    state.set(id, 1)
    for (const dep of deps.get(id) ?? []) {
      if (!visit(dep)) return false
    }
    state.set(id, 2)
    return true
  }
  return [...deps.keys()].every(visit)
}

function isTopological(pipeline: PipelineV1, order: readonly string[]): boolean {
  const position = new Map(order.map((id, index) => [id, index]))
  for (const node of pipeline.nodes) {
    for (const input of dependenciesOf(node)) {
      if ((position.get(input) ?? Infinity) >= (position.get(node.id) ?? -Infinity)) return false
    }
  }
  return true
}

function dependenciesOf(node: PipelineNode): readonly string[] {
  switch (node.type) {
    case 'transform':
    case 'sql':
      return node.inputs
    case 'validate':
      return [node.input]
    case 'publish':
      return [node.input, ...(node.requires ?? [])]
    case 'source':
    case 'diff':
      return []
  }
}
