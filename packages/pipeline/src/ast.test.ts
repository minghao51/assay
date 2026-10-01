// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import {
  PIPELINE_NODE_CLASSES,
  canonicalNodeOrder,
  compareNodeIds,
  isExecutableNodeClass,
  isPipelineNodeClass,
  portTypeOf,
} from './ast.js'
import type { PipelineNode } from './ast.js'
import { describePipelineError } from './errors.js'

describe('node-class vocabulary', () => {
  it('recognizes exactly the ADR 0030 class list', () => {
    for (const nodeClass of PIPELINE_NODE_CLASSES) {
      expect(isPipelineNodeClass(nodeClass)).toBe(true)
    }
    expect(isPipelineNodeClass('mystery')).toBe(false)
    expect(isPipelineNodeClass(3)).toBe(false)
    expect(isPipelineNodeClass(undefined)).toBe(false)
  })

  it('distinguishes executable from reserved classes', () => {
    expect(isExecutableNodeClass('source')).toBe(true)
    expect(isExecutableNodeClass('transform')).toBe(true)
    expect(isExecutableNodeClass('sql')).toBe(true)
    expect(isExecutableNodeClass('validate')).toBe(false)
    expect(isExecutableNodeClass('diff')).toBe(false)
    expect(isExecutableNodeClass('publish')).toBe(false)
  })

  it('maps classes to their coarse port type', () => {
    const node = (type: PipelineNode['type']): PipelineNode => {
      switch (type) {
        case 'source':
          return { id: 'x', type, source: { kind: 'file' } }
        case 'transform':
          return { id: 'x', type, inputs: ['a'], operation: { operation: 'filter', args: {} } }
        case 'sql':
          return { id: 'x', type, inputs: [], sql: 'SELECT 1' }
        case 'validate':
          return { id: 'x', type, input: 'a', contract: 'c.yaml' }
        case 'publish':
          return { id: 'x', type, input: 'a' }
        case 'diff':
          return { id: 'x', type, input: 'a', against: 'a' }
      }
    }
    expect(portTypeOf(node('source'))).toBe('data')
    expect(portTypeOf(node('transform'))).toBe('data')
    expect(portTypeOf(node('sql'))).toBe('data')
    expect(portTypeOf(node('validate'))).toBe('gated')
    expect(portTypeOf(node('diff'))).toBe('gated')
    expect(portTypeOf(node('publish'))).toBe('gated')
  })
})

describe('canonical ordering', () => {
  it('sorts by code-unit order and does not mutate the input', () => {
    const nodes: PipelineNode[] = [
      { id: 'b', type: 'source', source: { kind: 'file' } },
      { id: '1', type: 'source', source: { kind: 'file' } },
      { id: 'a', type: 'source', source: { kind: 'file' } },
    ]
    const sorted = canonicalNodeOrder(nodes)
    expect(sorted.map((node) => node.id)).toEqual(['1', 'a', 'b'])
    expect(nodes.map((node) => node.id)).toEqual(['b', '1', 'a'])
  })

  it('compareNodeIds is a total order', () => {
    expect(compareNodeIds('a', 'b')).toBeLessThan(0)
    expect(compareNodeIds('b', 'a')).toBeGreaterThan(0)
    expect(compareNodeIds('a', 'a')).toBe(0)
  })
})

describe('describePipelineError', () => {
  it('renders line/column when located (parse errors)', () => {
    expect(
      describePipelineError({
        code: 'unsupported-version',
        message: 'nope',
        path: 'version',
        line: 3,
        column: 9,
      }),
    ).toBe('version:3:9: nope')
  })

  it('renders path-only for DAG errors', () => {
    expect(
      describePipelineError({ code: 'cycle', message: 'loop', path: 'nodes.a', nodeId: 'a' }),
    ).toBe('nodes.a: loop')
  })
})
