// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { parsePipeline } from './parse.js'
import type { PipelineError } from './errors.js'
import type { PipelineV1 } from './ast.js'

const BASE = `version: 1
pipeline: demo
nodes:
  a:
    type: source
    source:
      kind: file
      path: ./a.parquet
`

function errorsOf(text: string): readonly PipelineError[] {
  const result = parsePipeline(text)
  if (result.ok)
    throw new Error(`expected a parse failure, got: ${JSON.stringify(result.pipeline)}`)
  return result.errors
}

function codesOf(text: string): string[] {
  return errorsOf(text).map((error) => error.code)
}

function parseOk(text: string): PipelineV1 {
  const result = parsePipeline(text)
  if (!result.ok) {
    throw new Error(`expected success, got: ${result.errors.map((e) => e.message).join('; ')}`)
  }
  return result.pipeline
}

describe('parsePipeline: valid documents', () => {
  it('parses a minimal source pipeline and sorts nodes by id', () => {
    const pipeline = parseOk(`version: 1
pipeline: demo
nodes:
  z:
    type: sql
    inputs: []
    sql: SELECT 1
  a:
    type: source
    source:
      kind: file
      path: ./a.parquet
`)
    expect(pipeline).toEqual({
      version: 1,
      pipeline: 'demo',
      nodes: [
        { id: 'a', type: 'source', source: { kind: 'file', path: './a.parquet' } },
        { id: 'z', type: 'sql', inputs: [], sql: 'SELECT 1' },
      ],
    })
  })

  it('normalizes an empty publish requires list to absent', () => {
    const pipeline = parseOk(`${BASE}
  out:
    type: publish
    input: a
    requires: []
`)
    expect(pipeline.nodes).toContainEqual({ id: 'out', type: 'publish', input: 'a' })
  })

  it('carries a diff body opaquely', () => {
    const pipeline = parseOk(`${BASE}
  d:
    type: diff
    against: a
    nested:
      deep: [1, 2, 3]
`)
    expect(pipeline.nodes).toContainEqual({
      id: 'd',
      type: 'diff',
      config: { against: 'a', nested: { deep: [1, 2, 3] } },
    })
  })

  it('parses validate and publish (typed-but-reserved)', () => {
    const pipeline = parseOk(`${BASE}
  v:
    type: validate
    input: a
    contract: contracts/a.yaml
  p:
    type: publish
    input: a
    requires: [v]
`)
    expect(pipeline.nodes).toContainEqual({
      id: 'v',
      type: 'validate',
      input: 'a',
      contract: 'contracts/a.yaml',
    })
    expect(pipeline.nodes).toContainEqual({
      id: 'p',
      type: 'publish',
      input: 'a',
      requires: ['v'],
    })
  })

  it('accepts an empty nodes mapping', () => {
    expect(parseOk('version: 1\npipeline: demo\nnodes: {}\n').nodes).toEqual([])
  })

  it('accepts a leading BOM', () => {
    expect(parseOk(`\uFEFF${BASE}`).pipeline).toBe('demo')
  })

  it('accepts JSON (a YAML 1.2 subset)', () => {
    const pipeline = parseOk(
      JSON.stringify({
        version: 1,
        pipeline: 'demo',
        nodes: { a: { type: 'source', source: { kind: 'file' } } },
      }),
    )
    expect(pipeline.nodes[0]).toEqual({ id: 'a', type: 'source', source: { kind: 'file' } })
  })
})

describe('parsePipeline: totality', () => {
  it('returns a typed error for non-string input', () => {
    const result = parsePipeline(123 as unknown as string)
    expect(result).toEqual({
      ok: false,
      errors: [
        {
          code: 'wrong-type',
          message: 'the pipeline source must be a string of YAML text',
          path: 'document',
          line: 1,
          column: 1,
        },
      ],
    })
  })

  it('returns a typed error for an empty document', () => {
    expect(codesOf('')).toEqual(['wrong-type'])
    expect(codesOf('   \n# only a comment\n')).toEqual(['wrong-type'])
  })

  it('reports YAML syntax problems and stops walking', () => {
    const errors = errorsOf('version: 1\npipeline: [unterminated\n')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.every((error) => error.code === 'yaml-syntax')).toBe(true)
    expect(errors[0]?.line).toBeGreaterThanOrEqual(1)
  })

  it('turns parse warnings (unresolved tags) into yaml-syntax errors', () => {
    expect(codesOf('version: 1\npipeline: !unknown demo\nnodes: {}\n')).toContain('yaml-syntax')
  })

  it('never throws on arbitrary text', () => {
    for (const text of [
      '{',
      ':',
      '- ',
      '[',
      ']',
      '&a *a',
      '!!binary aGk=',
      '\u0000',
      'a'.repeat(10000),
    ]) {
      expect(() => parsePipeline(text)).not.toThrow()
    }
  })
})

describe('parsePipeline: root structure', () => {
  it('rejects a non-mapping root', () => {
    expect(codesOf('[]')).toEqual(['wrong-type'])
    expect(codesOf('just a scalar')).toEqual(['wrong-type'])
  })

  it('requires version, pipeline, and nodes', () => {
    expect(codesOf('pipeline: demo\nnodes: {}\n')).toEqual(['missing-key'])
    expect(codesOf('version: 1\nnodes: {}\n')).toEqual(['missing-key'])
    expect(codesOf('version: 1\npipeline: demo\n')).toEqual(['missing-key'])
  })

  it('rejects an unsupported version alone', () => {
    expect(codesOf('version: 2\npipeline: demo\nnodes: {}\n')).toEqual(['unsupported-version'])
  })

  it('rejects a non-numeric version', () => {
    expect(codesOf("version: '1'\npipeline: demo\nnodes: {}\n")).toEqual(['wrong-type'])
  })

  it('rejects unknown root keys with a hint', () => {
    const errors = errorsOf('version: 1\npipeline: demo\nnodes: {}\nname: x\n')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.code).toBe('unknown-key')
    expect(errors[0]?.message).toContain('unknown key "name"')
  })

  it('rejects a duplicate root key', () => {
    expect(codesOf('version: 1\nversion: 1\npipeline: demo\nnodes: {}\n')).toContain(
      'duplicate-key',
    )
  })

  it('rejects a non-mapping nodes value', () => {
    expect(codesOf('version: 1\npipeline: demo\nnodes: [a]\n')).toEqual(['wrong-type'])
  })

  it('rejects an empty pipeline name', () => {
    expect(codesOf("version: 1\npipeline: ''\nnodes: {}\n")).toEqual(['out-of-range'])
  })

  it('rejects a NUL-bearing pipeline name', () => {
    expect(codesOf('version: 1\npipeline: "a\\0b"\nnodes: {}\n')).toEqual(['out-of-range'])
  })

  it('locates errors with visible line/column', () => {
    const errors = errorsOf('version: 2\npipeline: demo\nnodes: {}\n')
    expect(errors[0]).toMatchObject({
      code: 'unsupported-version',
      path: 'version',
      line: 1,
      column: 10,
    })

    const bom = errorsOf('\uFEFFversion: 2\npipeline: demo\nnodes: {}\n')
    expect(bom[0]).toMatchObject({ line: 1, column: 10 })
  })
})

describe('parsePipeline: nodes', () => {
  it('requires a node type', () => {
    expect(codesOf(`${BASE}\n  x:\n    source: {kind: file}\n`)).toContain('missing-key')
  })

  it('rejects an unknown node class', () => {
    const errors = errorsOf(`${BASE}\n  x:\n    type: mystery\n`)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.code).toBe('unknown-node-class')
    expect(errors[0]?.nodeId).toBe('x')
  })

  it('rejects non-mapping and empty node ids', () => {
    expect(codesOf(`${BASE}\n  x: 3\n`)).toContain('wrong-type')
    expect(codesOf(`${BASE}\n  '':\n    type: source\n    source: {kind: file}\n`)).toContain(
      'out-of-range',
    )
  })

  it('rejects duplicate node keys', () => {
    const text = `${BASE}\n  a:\n    type: source\n    source: {kind: file}\n`
    expect(codesOf(text)).toContain('duplicate-key')
  })

  it('rejects alias cycles', () => {
    const errors = errorsOf(`version: 1
pipeline: demo
nodes:
  a: &a
    type: source
    source: *a
`)
    expect(errors.some((error) => error.code === 'yaml-syntax')).toBe(true)
  })
})

describe('parsePipeline: source nodes', () => {
  it('requires the source block and kind', () => {
    expect(codesOf(`${BASE}\n  x:\n    type: source\n`)).toContain('missing-key')
    expect(codesOf(`${BASE}\n  x:\n    type: source\n    source: {path: p}\n`)).toContain(
      'missing-key',
    )
  })

  it('rejects a non-mapping source config and a non-string kind', () => {
    expect(codesOf(`${BASE}\n  x:\n    type: source\n    source: 3\n`)).toContain('wrong-type')
    expect(codesOf(`${BASE}\n  x:\n    type: source\n    source: {kind: 3}\n`)).toContain(
      'wrong-type',
    )
  })

  it('rejects keys not allowed on a source node', () => {
    const errors = errorsOf(
      `${BASE}\n  x:\n    type: source\n    source: {kind: file}\n    inputs: [a]\n`,
    )
    expect(errors.map((error) => error.code)).toContain('unknown-key')
  })

  it('rejects non-finite and tagged generic values', () => {
    expect(
      codesOf(`${BASE}\n  x:\n    type: source\n    source: {kind: file, extra: .inf}\n`),
    ).toContain('out-of-range')
    expect(
      codesOf(`${BASE}\n  x:\n    type: source\n    source: {kind: file, extra: !!binary aGk=}\n`),
    ).toContain('wrong-type')
  })

  it('rejects NUL in generic string values and duplicate generic keys', () => {
    expect(
      codesOf(`${BASE}\n  x:\n    type: source\n    source: {kind: file, path: "a\\0b"}\n`),
    ).toContain('out-of-range')
    expect(
      codesOf(`${BASE}\n  x:\n    type: source\n    source: {kind: file, path: p, path: q}\n`),
    ).toContain('duplicate-key')
  })
})

describe('parsePipeline: transform nodes', () => {
  it('requires inputs and operation', () => {
    expect(codesOf(`${BASE}\n  x:\n    type: transform\n`)).toEqual(['missing-key', 'missing-key'])
  })

  it('rejects an empty inputs list with port-arity', () => {
    expect(
      codesOf(`${BASE}\n  x:\n    type: transform\n    inputs: []\n    operation: {filter: {}}\n`),
    ).toEqual(['port-arity'])
  })

  it('rejects a non-list inputs value and non-string entries', () => {
    expect(
      codesOf(`${BASE}\n  x:\n    type: transform\n    inputs: a\n    operation: {filter: {}}\n`),
    ).toContain('wrong-type')
    expect(
      codesOf(`${BASE}\n  x:\n    type: transform\n    inputs: [1]\n    operation: {filter: {}}\n`),
    ).toContain('invalid-reference')
    expect(
      codesOf(
        `${BASE}\n  x:\n    type: transform\n    inputs: ['']\n    operation: {filter: {}}\n`,
      ),
    ).toContain('invalid-reference')
  })

  it('rejects duplicate references', () => {
    expect(
      codesOf(
        `${BASE}\n  x:\n    type: transform\n    inputs: [a, a]\n    operation: {filter: {}}\n`,
      ),
    ).toContain('duplicate-reference')
  })

  it('requires exactly one operation with mapping arguments', () => {
    expect(
      codesOf(`${BASE}\n  x:\n    type: transform\n    inputs: [a]\n    operation: {}\n`),
    ).toEqual(['out-of-range'])
    expect(
      codesOf(
        `${BASE}\n  x:\n    type: transform\n    inputs: [a]\n    operation: {filter: {}, join: {}}\n`,
      ),
    ).toEqual(['out-of-range'])
    expect(
      codesOf(`${BASE}\n  x:\n    type: transform\n    inputs: [a]\n    operation: {filter: 3}\n`),
    ).toEqual(['wrong-type'])
  })

  it('rejects keys misplaced from other node classes with a hint', () => {
    const errors = errorsOf(
      `${BASE}\n  x:\n    type: transform\n    inputs: [a]\n    operation: {filter: {}}\n    contract: c\n`,
    )
    expect(errors.map((error) => error.code)).toContain('unknown-key')
    expect(errors.some((error) => error.message.includes('valid only in'))).toBe(true)
  })
})

describe('parsePipeline: sql nodes', () => {
  it('requires inputs and sql text', () => {
    expect(codesOf(`${BASE}\n  x:\n    type: sql\n`)).toEqual(['missing-key', 'missing-key'])
  })

  it('rejects empty sql text', () => {
    expect(codesOf(`${BASE}\n  x:\n    type: sql\n    inputs: []\n    sql: ''\n`)).toEqual([
      'out-of-range',
    ])
  })

  it('allows an empty inputs list', () => {
    expect(
      parseOk(`${BASE}\n  x:\n    type: sql\n    inputs: []\n    sql: SELECT 1\n`).nodes,
    ).toContainEqual({ id: 'x', type: 'sql', inputs: [], sql: 'SELECT 1' })
  })
})

describe('parsePipeline: validate/publish nodes', () => {
  it('requires validate input and contract', () => {
    expect(codesOf(`${BASE}\n  x:\n    type: validate\n`)).toEqual(['missing-key', 'missing-key'])
  })

  it('rejects a sequence for the single input reference', () => {
    expect(codesOf(`${BASE}\n  x:\n    type: validate\n    input: [a]\n    contract: c\n`)).toEqual(
      ['wrong-type'],
    )
  })

  it('requires publish input and rejects bad requires lists', () => {
    expect(codesOf(`${BASE}\n  x:\n    type: publish\n`)).toEqual(['missing-key'])
    expect(codesOf(`${BASE}\n  x:\n    type: publish\n    input: a\n    requires: a\n`)).toContain(
      'wrong-type',
    )
    expect(
      codesOf(`${BASE}\n  x:\n    type: publish\n    input: a\n    requires: [1]\n`),
    ).toContain('invalid-reference')
  })
})

describe('parsePipeline: golden fixtures', () => {
  it('parses the architecture §5 example structure', () => {
    const text = `version: 1
pipeline: customer_portfolio
nodes:
  customers:
    type: source
    source:
      kind: file
      path: ./customers.parquet
  quality:
    type: validate
    input: customers
    contract: contracts/portfolio.yaml
`
    const pipeline = parseOk(text)
    expect(pipeline.nodes.map((node) => node.id)).toEqual(['customers', 'quality'])
  })
})
