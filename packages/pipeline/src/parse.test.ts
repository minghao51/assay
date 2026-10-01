// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { isAlias, parseDocument } from 'yaml'
import { parsePipeline } from './parse.js'
import { serializePipeline } from './serialize.js'
import { validatePipelineDocument } from './validate.js'
import { MATERIALIZATION_MODES, materializationOf } from './ast.js'
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

/** Find the first real YAML alias node in a parsed document (for the p2-1 (f) probe). */
function findAlias(node: unknown): { resolve: (...args: unknown[]) => unknown } | null {
  if (node === null || typeof node !== 'object') return null
  if (isAlias(node)) return node as { resolve: (...args: unknown[]) => unknown }
  const candidate = node as {
    items?: readonly unknown[]
    key?: unknown
    value?: unknown
  }
  for (const item of candidate.items ?? []) {
    const hit = findAlias(item)
    if (hit !== null) return hit
  }
  if ('key' in candidate || 'value' in candidate) {
    const hit = findAlias(candidate.key) ?? findAlias(candidate.value)
    if (hit !== null) return hit
  }
  return null
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

  it('parses the settled diff shape (input + against, both table refs)', () => {
    const pipeline = parseOk(`${BASE}
  d:
    type: diff
    against: a
    input: a
`)
    expect(pipeline.nodes.find((candidate) => candidate.id === 'd')).toEqual({
      id: 'd',
      type: 'diff',
      input: 'a',
      against: 'a',
    })
  })

  it('requires both diff references and rejects unknown diff keys', () => {
    expect(codesOf(`${BASE}\n  d:\n    type: diff\n    input: a\n`)).toEqual(['missing-key'])
    expect(codesOf(`${BASE}\n  d:\n    type: diff\n    against: a\n`)).toEqual(['missing-key'])
    const errors = errorsOf(
      `${BASE}\n  d:\n    type: diff\n    input: a\n    against: a\n    nested: 1\n`,
    )
    expect(errors.map((error) => error.code)).toEqual(['unknown-key'])
  })

  it('rejects a sequence for a diff reference', () => {
    expect(codesOf(`${BASE}\n  d:\n    type: diff\n    input: [a]\n    against: a\n`)).toEqual([
      'wrong-type',
    ])
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

  it('rejects in-value alias cycles inside generic config (map/deep/seq)', () => {
    const cases: Readonly<Record<string, string>> = {
      'map self-cycle': `version: 1
pipeline: demo
nodes:
  a:
    type: source
    source: &s
      kind: file
      self: *s
`,
      'deep map cycle': `version: 1
pipeline: demo
nodes:
  a:
    type: source
    source: &s
      kind: file
      nested:
        deep: *s
`,
      'seq-in-map cycle': `version: 1
pipeline: demo
nodes:
  a:
    type: source
    source: &s
      kind: file
      list:
        - *s
`,
    }
    for (const [name, text] of Object.entries(cases)) {
      let result: ReturnType<typeof parsePipeline> | undefined
      // Total: an in-value alias cycle must become a typed error, never a
      // stack-overflow throw from the generic-value walk.
      expect(() => {
        result = parsePipeline(text)
      }, name).not.toThrow()
      expect(result?.ok, name).toBe(false)
      if (result !== undefined && !result.ok) {
        expect(result.errors, name).toHaveLength(1)
        expect(result.errors[0]?.code, name).toBe('yaml-syntax')
      }
    }
  })

  it('treats a YAML merge key as ordinary data (no merge is applied)', () => {
    // YAML 1.2 core has no merge-key feature; `<<` is an ordinary mapping key
    // and the format carries it verbatim. This pins the documented behavior
    // so the parser comment cannot drift back to claiming merge keys are
    // refused.
    const pipeline = parseOk(`${BASE}
  x:
    type: source
    source:
      kind: file
      <<: {path: ./merged.parquet}
`)
    const node = pipeline.nodes.find((candidate) => candidate.id === 'x')
    expect(node?.type).toBe('source')
    if (node?.type === 'source') {
      expect(Object.hasOwn(node.source, '<<')).toBe(true)
      expect(node.source['<<']).toEqual({ path: './merged.parquet' })
      // No merge was applied: the would-be merged key is absent.
      expect(Object.hasOwn(node.source, 'path')).toBe(false)
    }
  })
})

describe('parsePipeline: deep alias resolution stays a hard failure (p2-1 (f))', () => {
  it('re-throws a RangeError from alias resolution instead of swallowing it', () => {
    // `resolveNode` used to `catch { return null }`, swallowing a RangeError
    // from the YAML resolver (deep overspend / "Maximum call stack size
    // exceeded"). Real deep-nesting input is intercepted by the library's own
    // parse-time depth guard, so this pin injects the resolver failure at the
    // seam to prove the catch narrows: a RangeError propagates instead of
    // degrading to an innocuous null node.
    const text = `${BASE}\n  x:\n    type: source\n    source: *missing\n`
    const doc = parseDocument(text, { uniqueKeys: false })
    const alias = findAlias(doc.contents)
    expect(alias).not.toBeNull()
    if (alias === null) return
    alias.resolve = () => {
      throw new RangeError('Maximum call stack size exceeded')
    }
    expect(() => validatePipelineDocument(doc, text)).toThrow(RangeError)
  })

  it('degrades a non-RangeError resolver failure to typed, located errors', () => {
    // Rider (p2-2): this injected-Error probe guards the catch-degrade branch
    // of `resolveNode`; it is NOT a duplicate of the natural `*missing` probe
    // below — that one resolves without throwing and would still pass under a
    // `throw error` widening mutant.
    // The other half of the catch narrowing (item (f)): a non-RangeError
    // resolver throw must NOT propagate — it degrades to null and is reported
    // as a typed, located document error, mirroring the RangeError probe.
    const text = `${BASE}\n  x:\n    type: source\n    source: *missing\n`
    const doc = parseDocument(text, { uniqueKeys: false })
    const alias = findAlias(doc.contents)
    expect(alias).not.toBeNull()
    if (alias === null) return
    alias.resolve = () => {
      throw new Error('resolver failure that is not a RangeError')
    }
    let result: ReturnType<typeof validatePipelineDocument> | undefined
    expect(() => {
      result = validatePipelineDocument(doc, text)
    }).not.toThrow()
    expect(result?.errors.length).toBeGreaterThan(0)
    for (const error of result?.errors ?? []) {
      expect(error.code).toBeTruthy()
      expect(error.path).toBeTruthy()
      expect(typeof error.line).toBe('number')
      expect(typeof error.column).toBe('number')
    }
  })

  it('still degrades an ordinary unresolvable alias to a typed, located error', () => {
    // Rider (p2-2): the natural `*missing` probe does NOT inject a throw, so
    // it passes even under a `throw error` widening mutant; the injected-Error
    // probe above is what guards the catch-degrade branch. Keep both.
    const text = `${BASE}\n  x:\n    type: source\n    source: *missing\n`
    const doc = parseDocument(text, { uniqueKeys: false })
    const { errors } = validatePipelineDocument(doc, text)
    expect(errors.length).toBeGreaterThan(0)
    for (const error of errors) {
      expect(error.code).toBeTruthy()
      expect(error.path).toBeTruthy()
      expect(typeof error.line).toBe('number')
      expect(typeof error.column).toBe('number')
    }
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

describe('parsePipeline: materialization (p2-2; ADR 0033)', () => {
  it('pins the ADR 0033 mode vocabulary literally', () => {
    expect(MATERIALIZATION_MODES).toEqual([
      'ephemeral',
      'view',
      'table',
      'cache',
      'incremental',
      'export',
      'publish',
    ])
  })

  it('accepts all seven logical modes on a data node and defaults to view', () => {
    for (const mode of MATERIALIZATION_MODES) {
      const pipeline = parseOk(
        `${BASE}\n  x:\n    type: source\n    materialization: ${mode}\n    source: {kind: file}\n`,
      )
      const node = pipeline.nodes.find((candidate) => candidate.id === 'x')
      expect(node?.type, mode).toBe('source')
      if (node?.type !== 'source') continue
      if (mode === 'view') {
        // The default normalizes to absent (one shape per meaning).
        expect(Object.hasOwn(node, 'materialization'), mode).toBe(false)
      } else {
        expect(node.materialization, mode).toBe(mode)
      }
      expect(materializationOf(node), mode).toBe(mode)
    }
  })

  it('applies to source, transform, and sql (data-port classes)', () => {
    const pipeline = parseOk(`${BASE}
  s:
    type: source
    materialization: table
    source: {kind: file}
  t:
    type: transform
    materialization: cache
    inputs: [s]
    operation: {filter: {}}
  q:
    type: sql
    materialization: export
    inputs: [t]
    sql: SELECT 1
`)
    expect(pipeline.nodes).toContainEqual({
      id: 's',
      type: 'source',
      materialization: 'table',
      source: { kind: 'file' },
    })
    expect(pipeline.nodes).toContainEqual({
      id: 't',
      type: 'transform',
      materialization: 'cache',
      inputs: ['s'],
      operation: { operation: 'filter', args: {} },
    })
    expect(pipeline.nodes).toContainEqual({
      id: 'q',
      type: 'sql',
      materialization: 'export',
      inputs: ['t'],
      sql: 'SELECT 1',
    })
  })

  it('defaults to view when absent and never spells the default out', () => {
    const pipeline = parseOk(`${BASE}\n  x:\n    type: source\n    source: {kind: file}\n`)
    const node = pipeline.nodes.find((candidate) => candidate.id === 'x')
    if (node === undefined) throw new Error('expected the x node')
    expect(node.type).toBe('source')
    if (node.type !== 'source') throw new Error('expected the x node to be a source')
    expect(materializationOf(node)).toBe('view')
    expect(Object.hasOwn(node, 'materialization')).toBe(false)
  })

  it('rejects non-string materialization values as wrong-type', () => {
    const errors = errorsOf(
      `${BASE}\n  x:\n    type: source\n    materialization: 3\n    source: {kind: file}\n`,
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'wrong-type', path: 'nodes.x.materialization' })
  })

  it('rejects unknown, wrong-case, and whitespace-padded modes as located out-of-range', () => {
    for (const mode of ['mystery', 'View', "' view'", "'view '"]) {
      const errors = errorsOf(
        `${BASE}\n  x:\n    type: source\n    materialization: ${mode}\n    source: {kind: file}\n`,
      )
      expect(
        errors.map((error) => error.code),
        mode,
      ).toEqual(['out-of-range'])
      expect(errors[0], mode).toMatchObject({ path: 'nodes.x.materialization' })
      expect(typeof errors[0]?.line, mode).toBe('number')
      expect(typeof errors[0]?.column, mode).toBe('number')
    }
  })

  it('rejects the British spelling and the typo key as unknown-key', () => {
    for (const key of ['materialisation', 'materalization']) {
      const errors = errorsOf(
        `${BASE}\n  x:\n    type: source\n    ${key}: table\n    source: {kind: file}\n`,
      )
      expect(
        errors.map((error) => error.code),
        key,
      ).toEqual(['unknown-key'])
      expect(errors[0]?.path, key).toBe('nodes.x')
    }
  })

  it('rejects materialization on gated nodes (validate/diff/publish)', () => {
    const validate = errorsOf(
      `${BASE}\n  x:\n    type: validate\n    input: a\n    contract: c.yaml\n    materialization: table\n`,
    )
    expect(validate.map((error) => error.code)).toEqual(['unknown-key'])
    const publish = errorsOf(
      `${BASE}\n  x:\n    type: publish\n    input: a\n    materialization: table\n`,
    )
    expect(publish.map((error) => error.code)).toEqual(['unknown-key'])
    const diff = errorsOf(
      `${BASE}\n  x:\n    type: diff\n    input: a\n    against: a\n    materialization: table\n`,
    )
    expect(diff.map((error) => error.code)).toEqual(['unknown-key'])
  })

  it('serializes a non-default mode and drops explicit view', () => {
    const table = parseOk(
      `${BASE}\n  x:\n    type: source\n    materialization: table\n    source: {kind: file}\n`,
    )
    expect(serializePipeline(table)).toContain('materialization: table')
    const view = parseOk(
      `${BASE}\n  x:\n    type: source\n    materialization: view\n    source: {kind: file}\n`,
    )
    expect(serializePipeline(view)).not.toContain('materialization')
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

describe('parsePipeline: reserved assay_* node ids (p-2)', () => {
  it('rejects an assay_-prefixed node id with reserved-identifier', () => {
    const errors = errorsOf(
      `${BASE}\n  assay_overlay_ord:\n    type: source\n    source: {kind: file}\n`,
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'reserved-identifier', path: 'nodes' })
    expect(errors[0]?.message).toContain('assay_')
  })

  it('rejects the prefix case-insensitively (DuckDB folds identifier case)', () => {
    expect(codesOf(`${BASE}\n  ASSAY_X:\n    type: source\n    source: {kind: file}\n`)).toEqual([
      'reserved-identifier',
    ])
  })

  it('rejects the prefix after trimming surrounding whitespace (uniform policy)', () => {
    // The check is applied to the trimmed id, so leading/trailing whitespace
    // cannot smuggle a reserved name past the gate in either direction.
    for (const id of [' assay_x', 'assay_x ', '  ASSAY_X  ']) {
      const errors = errorsOf(
        `${BASE}\n  ${JSON.stringify(id)}:\n    type: source\n    source: {kind: file}\n`,
      )
      expect(
        errors.map((error) => error.code),
        id,
      ).toEqual(['reserved-identifier'])
      expect(errors[0]?.message, id).toContain('assay_')
    }
  })

  it('keeps everything else permissive (similar prefixes, hostile text, __proto__)', () => {
    for (const id of ['assay', 'assayx', 'my_assay_x', '__proto__', 'weird "quoted" key']) {
      const pipeline = parseOk(
        `${BASE}\n  ${JSON.stringify(id)}:\n    type: source\n    source: {kind: file}\n`,
      )
      expect(pipeline.nodes.map((node) => node.id)).toContain(id)
    }
  })
})

describe('parsePipeline: numbers are exact or rejected (p-2)', () => {
  it('rejects a 17th-significant-digit generic number, naming the written literal', () => {
    const errors = errorsOf(
      `${BASE}\n  x:\n    type: source\n    source:\n      kind: file\n      limit: 9007199254740993\n`,
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'imprecise-number', path: 'nodes.x.source.limit' })
    expect(errors[0]?.message).toContain('9007199254740993')
    expect(errors[0]?.message).not.toContain('9007199254740992')
  })

  it('rejects an imprecise version with imprecise-number (reported alone)', () => {
    expect(codesOf('version: 9007199254740993\npipeline: demo\nnodes: {}\n')).toEqual([
      'imprecise-number',
    ])
  })

  it('accepts exactly representable large numbers and keeps them exact', () => {
    const pipeline = parseOk(
      `${BASE}\n  x:\n    type: source\n    source: {kind: file, limit: 9007199254740992}\n`,
    )
    const node = pipeline.nodes.find((candidate) => candidate.id === 'x')
    expect(node?.type).toBe('source')
    if (node?.type === 'source') expect(node.source.limit).toBe(9007199254740992)
  })

  it('accepts exact exponential spellings and rejects inexact ones', () => {
    const exact = parseOk(
      `${BASE}\n  x:\n    type: source\n    source: {kind: file, limit: 9.007199254740992e15}\n`,
    )
    const node = exact.nodes.find((candidate) => candidate.id === 'x')
    if (node?.type === 'source') expect(node.source.limit).toBe(9007199254740992)
    expect(
      codesOf(
        `${BASE}\n  x:\n    type: source\n    source: {kind: file, limit: 9.007199254740993e15}\n`,
      ),
    ).toEqual(['imprecise-number'])
  })

  it('fails closed on spellings whose exact value cannot be verified (hex)', () => {
    const errors = errorsOf(
      `${BASE}\n  x:\n    type: source\n    source: {kind: file, mask: 0x1F}\n`,
    )
    expect(errors[0]?.code).toBe('imprecise-number')
    expect(errors[0]?.message).toContain('0x1F')
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
