// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parsePipeline } from './parse.js'
import { serializePipeline } from './serialize.js'
import { validatePipeline } from './dag.js'

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/pipeline')

interface Manifest {
  readonly files: readonly {
    readonly name: string
    readonly sha256: string
    /** True when the file itself is canonical text (`text === serialize(parse(text))`). */
    readonly canonical: boolean
  }[]
}

const manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8')) as Manifest

describe('golden pipeline fixtures', () => {
  it('lists every fixture with a matching sha256 (bidirectional)', () => {
    const onDisk = readdirSync(FIXTURE_DIR)
      .filter((name) => name.endsWith('.yaml'))
      .sort()
    expect(manifest.files.map((file) => file.name).sort()).toEqual(onDisk)
    for (const file of manifest.files) {
      const digest = createHash('sha256')
        .update(readFileSync(join(FIXTURE_DIR, file.name)))
        .digest('hex')
      expect(digest).toBe(file.sha256)
    }
  })

  for (const file of manifest.files) {
    it(`${file.name} parses, validates, and round-trips byte-stably`, () => {
      const text = readFileSync(join(FIXTURE_DIR, file.name), 'utf8')
      const parsed = parsePipeline(text)
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) return

      const validated = validatePipeline(parsed.pipeline)
      expect(validated.ok).toBe(true)

      const canonical = serializePipeline(parsed.pipeline)
      // Canonical fixtures are literally canonical text; the architecture §5
      // example is deliberately non-canonical and is covered separately below.
      if (file.canonical) expect(text).toBe(canonical)
      const reparsed = parsePipeline(canonical)
      expect(reparsed).toEqual({ ok: true, pipeline: parsed.pipeline })
      expect(serializePipeline(reparsed.ok ? reparsed.pipeline : parsed.pipeline)).toBe(canonical)
    })
  }

  it('architecture-example.yaml is the §5 literal and canonicalizes to customer_portfolio.yaml', () => {
    const literal = readFileSync(join(FIXTURE_DIR, 'architecture-example.yaml'), 'utf8')
    const canonicalGolden = readFileSync(join(FIXTURE_DIR, 'customer_portfolio.yaml'), 'utf8')
    const parsed = parsePipeline(literal)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(validatePipeline(parsed.pipeline).ok).toBe(true)
    // The literal is deliberately not canonical (blank lines/flow spacing), so
    // §5 is parse-verified rather than overclaimed as canonical text.
    expect(literal).not.toBe(canonicalGolden)
    expect(serializePipeline(parsed.pipeline)).toBe(canonicalGolden)
  })

  it('reserved-nodes.yaml carries the diff body spread at the node level (no config: wrapper)', () => {
    const text = readFileSync(join(FIXTURE_DIR, 'reserved-nodes.yaml'), 'utf8')
    const parsed = parsePipeline(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const compare = parsed.pipeline.nodes.find((node) => node.id === 'compare')
    expect(compare).toEqual({
      id: 'compare',
      type: 'diff',
      config: { input: 'clean', against: 'raw' },
    })
    if (compare?.type !== 'diff') throw new Error('expected the compare node to be a diff')
    expect(Object.hasOwn(compare.config, 'config')).toBe(false)
  })

  it('customer_portfolio.yaml is the architecture §5 example surface', () => {
    const text = readFileSync(join(FIXTURE_DIR, 'customer_portfolio.yaml'), 'utf8')
    const parsed = parsePipeline(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.pipeline.pipeline).toBe('customer_portfolio')
    expect(parsed.pipeline.nodes.map((node) => `${node.id}:${node.type}`)).toEqual([
      'customer_policies:transform',
      'customers:source',
      'output:publish',
      'policies:source',
      'portfolio:sql',
      'quality:validate',
      'sg_customers:transform',
    ])
  })

  it('hostile-names.yaml preserves hostile ids and the __proto__ probe', () => {
    const text = readFileSync(join(FIXTURE_DIR, 'hostile-names.yaml'), 'utf8')
    const parsed = parsePipeline(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const ids = parsed.pipeline.nodes.map((node) => node.id)
    expect(ids).toContain('__proto__')
    expect(ids).toContain('weird "quoted" key')
    expect(ids).toContain('ünï')
    expect(Object.hasOwn(parsed.pipeline.nodes[0] ?? {}, 'id')).toBe(true)
    // Prototype pollution probe: the generic `__proto__` key is an own property
    // on the transform's operation args, not a prototype mutation.
    const transform = parsed.pipeline.nodes.find((node) => node.id === '1')
    expect(transform?.type).toBe('transform')
    if (transform?.type === 'transform') {
      expect(Object.hasOwn(transform.operation.args, '__proto__')).toBe(true)
      expect(Object.getPrototypeOf(transform.operation.args)).toBe(Object.prototype)
      expect(transform.operation.args['__proto__']).toEqual({ polluted: true })
    }
  })
})
