// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parsePipeline } from './parse.js'
import { serializePipeline } from './serialize.js'
import { validatePipeline } from './dag.js'
import { isDataNode, materializationOf } from './ast.js'
import { compilePipeline } from './compile/index.js'

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/pipeline')

interface Manifest {
  readonly files: readonly {
    readonly name: string
    readonly sha256: string
    /** True when the file itself is canonical text (`text === serialize(parse(text))`). */
    readonly canonical?: boolean
    /** `refuses` when the fixture is a deliberate negative probe (parse must fail). */
    readonly expect?: 'parses' | 'refuses'
    /** The error code a `refuses` fixture must report. */
    readonly errorCode?: string
  }[]
  /**
   * Data-contract fixtures (`contracts/`) checksummed by the same recursive
   * discipline but NOT parsed as Pipeline IR (they are not pipelines).
   */
  readonly contracts?: readonly {
    readonly name: string
    readonly sha256: string
    readonly description?: string
  }[]
}

const manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8')) as Manifest

/** Every `*.yaml` under `dir`, as a `/`-separated path relative to `dir`. */
function listYamlFiles(dir: string, prefix = ''): string[] {
  const names: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) names.push(...listYamlFiles(join(dir, entry.name), relative))
    else if (entry.name.endsWith('.yaml')) names.push(relative)
  }
  return names
}

describe('golden pipeline fixtures', () => {
  it('lists every fixture (recursively, incl. contracts/) with a matching sha256', () => {
    // Recursive bidirectional check: the manifest names every `*.yaml` under
    // fixtures/pipeline/ (contracts/ included) and nothing stale, so editing
    // or adding a contract fixture requires the deliberate, reviewed
    // manifest regeneration the policy mandates.
    const onDisk = listYamlFiles(FIXTURE_DIR).sort()
    const listed = [
      ...manifest.files.map((file) => file.name),
      ...(manifest.contracts ?? []).map((contract) => contract.name),
    ].sort()
    expect(listed).toEqual(onDisk)
    for (const fixture of [...manifest.files, ...(manifest.contracts ?? [])]) {
      const digest = createHash('sha256')
        .update(readFileSync(join(FIXTURE_DIR, fixture.name)))
        .digest('hex')
      expect(digest).toBe(fixture.sha256)
    }
  })

  for (const file of manifest.files) {
    const label =
      file.expect === 'refuses'
        ? 'is refused with the pinned error code'
        : 'parses, validates, and round-trips byte-stably'
    it(`${file.name} ${label}`, () => {
      const text = readFileSync(join(FIXTURE_DIR, file.name), 'utf8')
      const parsed = parsePipeline(text)
      if (file.expect === 'refuses') {
        expect(parsed.ok).toBe(false)
        if (!parsed.ok) {
          // Exact: the probe must yield exactly the pinned code — any
          // unexpected additional error class fails the pin.
          expect(parsed.errors.map((error) => error.code)).toEqual([file.errorCode])
        }
        return
      }
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

  it('architecture-example.yaml compiles its executable subgraph (p2-3 closes the §5 divergence)', () => {
    const text = readFileSync(join(FIXTURE_DIR, 'architecture-example.yaml'), 'utf8')
    const parsed = parsePipeline(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    // The full §5 document still refuses its P2-gated classes — and only
    // those: the structured filter and the compiled join no longer diverge.
    const full = compilePipeline(parsed.pipeline)
    expect(full.ok).toBe(false)
    if (!full.ok) {
      expect(full.errors.map((error) => error.code)).toEqual([
        'reserved-node-class',
        'reserved-node-class',
      ])
    }

    // Dropping the gated nodes leaves the §5 data subgraph, which now compiles.
    const dataOnly = {
      ...parsed.pipeline,
      nodes: parsed.pipeline.nodes.filter(
        (node) => node.type !== 'validate' && node.type !== 'publish',
      ),
    }
    const compiled = compilePipeline(dataOnly)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const byId = new Map(compiled.plan.nodes.map((node) => [node.nodeId, node]))
    expect(byId.get('sg_customers')?.sql).toBe(
      `SELECT\n  *\nFROM "customers"\nWHERE ("country" = 'SG')`,
    )
    expect(byId.get('customer_policies')?.sql).toBe(
      'SELECT\n  *\nFROM "sg_customers"\nINNER JOIN "policies" USING ("customer_id")',
    )
  })

  it('reserved-nodes.yaml pins the settled diff/validate/publish AST shapes (p2-2)', () => {
    const text = readFileSync(join(FIXTURE_DIR, 'reserved-nodes.yaml'), 'utf8')
    const parsed = parsePipeline(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const byId = new Map(parsed.pipeline.nodes.map((node) => [node.id, node]))
    expect(byId.get('compare')).toEqual({
      id: 'compare',
      type: 'diff',
      input: 'clean',
      against: 'raw',
    })
    expect(byId.get('gate')).toEqual({
      id: 'gate',
      type: 'validate',
      input: 'clean',
      contract: 'contracts/clean.yaml',
    })
    expect(byId.get('out')).toEqual({
      id: 'out',
      type: 'publish',
      input: 'clean',
      requires: ['gate'],
    })
    // No stale opaque `config` wrapper survives the settlement.
    expect(
      byId.get('compare') !== undefined && Object.hasOwn(byId.get('compare') ?? {}, 'config'),
    ).toBe(false)
  })

  it('materialization-modes.yaml pins the new field and the absent-default node (p2-2)', () => {
    const text = readFileSync(join(FIXTURE_DIR, 'materialization-modes.yaml'), 'utf8')
    const parsed = parsePipeline(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const modes = new Map(
      parsed.pipeline.nodes.filter(isDataNode).map((node) => [node.id, materializationOf(node)]),
    )
    expect(modes.get('raw')).toBe('view') // absent default
    expect(modes.get('cached')).toBe('cache')
    expect(modes.get('ephemeral_step')).toBe('ephemeral')
    expect(modes.get('staged')).toBe('table')
    expect(modes.get('incr')).toBe('incremental')
    expect(modes.get('exported')).toBe('export')
    // The absent-default node must not carry the key in the AST.
    const raw = parsed.pipeline.nodes.find((node) => node.id === 'raw')
    expect(raw !== undefined && Object.hasOwn(raw, 'materialization')).toBe(false)
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

  it('architecture-example.yaml is the only canonical:false manifest entry that parses (p2-1 (g))', () => {
    // The queue wording said "the only canonical:false entry"; reality is two
    // canonical:false entries. The invariant pinned here is the true one:
    // architecture-example.yaml is the only canonical:false entry that PARSES,
    // and the only other canonical:false entry is the deliberate negative
    // probe (which must keep failing to parse).
    const nonCanonical = manifest.files.filter((file) => file.canonical !== true)
    expect(nonCanonical.map((file) => file.name).sort()).toEqual([
      'architecture-example.yaml',
      'reserved-namespace-refusal.yaml',
    ])
    const parsing = nonCanonical.filter((file) => file.expect !== 'refuses')
    expect(parsing.map((file) => file.name)).toEqual(['architecture-example.yaml'])

    // Re-verify the split explicitly against the bytes, not the manifest flags.
    const example = parsePipeline(
      readFileSync(join(FIXTURE_DIR, 'architecture-example.yaml'), 'utf8'),
    )
    expect(example.ok).toBe(true)
    // The probe is now doubly invalid (reserved `assay_*` id AND a diff node
    // missing `input`); the pinned `reserved-identifier` depends on that check
    // short-circuiting before shape validation — regenerate with that order
    // preserved or re-pin the expected code here.
    const refusal = parsePipeline(
      readFileSync(join(FIXTURE_DIR, 'reserved-namespace-refusal.yaml'), 'utf8'),
    )
    expect(refusal.ok).toBe(false)
  })

  it('hostile-names.yaml pins the parsed AST of its most hostile construct (p2-1 (h))', () => {
    // The fixture has no diff node, so the most hostile construct is the
    // publish node whose id/input carry quotes, spaces and unicode, plus the
    // __proto__-keyed transform. Pin the PARSED AST (not merely "it parses")
    // so the hostile-name mapping cannot silently degrade.
    const text = readFileSync(join(FIXTURE_DIR, 'hostile-names.yaml'), 'utf8')
    const parsed = parsePipeline(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    const publish = parsed.pipeline.nodes.find((node) => node.id === '\u00fcn\u00ef')
    expect(publish).toEqual({
      id: '\u00fcn\u00ef',
      type: 'publish',
      input: 'weird "quoted" key',
      requires: ['1'],
    })

    const transform = parsed.pipeline.nodes.find((node) => node.id === '1')
    expect(transform?.type).toBe('transform')
    if (transform?.type !== 'transform') return
    expect(transform.id).toBe('1')
    expect(transform.inputs).toEqual(['__proto__'])
    expect(transform.operation.operation).toBe('filter')
    expect(Object.hasOwn(transform.operation.args, '__proto__')).toBe(true)
    expect(transform.operation.args.expression).toBe('x = 1')
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
