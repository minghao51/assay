// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Deterministic generators for the p-1 property tests (test support only —
 * NOT part of the public surface; `index.ts` never re-exports this module).
 *
 * Repo convention is determinism: no `Math.random`. Everything derives from a
 * seedable PRNG (mulberry32, same construction as `@assay/contracts`) so a
 * failing seed reproduces exactly; seeds are fixed in the test files on
 * purpose.
 *
 * Generated pipelines are always *canonical* ASTs — the shape `parsePipeline`
 * returns (nodes ascending by id, `publish.requires` absent when empty,
 * unique ids) — and acyclic by construction (an edge only ever points at a
 * node created earlier), so `validatePipeline` always accepts them.
 */
import { canonicalNodeOrder } from './ast.js'
import type {
  OperationConfig,
  PipelineMap,
  PipelineNode,
  PipelineV1,
  PipelineValue,
} from './ast.js'

/** mulberry32 — 32-bit seeded PRNG, deterministic across platforms. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Small deterministic RNG facade over mulberry32. */
export interface TestRng {
  float(): number
  int(min: number, max: number): number
  pick<T>(items: readonly T[]): T
  bool(p?: number): boolean
  shuffle<T>(items: readonly T[]): T[]
}

export function makeTestRng(seed: number): TestRng {
  const next = mulberry32(seed)
  return {
    float: next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)] as (typeof items)[number],
    bool: (p = 0.5) => next() < p,
    shuffle: (items) => {
      const out = [...items]
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1))
        const tmp = out[i] as (typeof out)[number]
        out[i] = out[j] as (typeof out)[number]
        out[j] = tmp
      }
      return out
    },
  }
}

/**
 * Node-id / key pool deliberately mixes plain and hostile text: quotes, SQL
 * comment/quote syntax, whitespace, unicode, numeric-looking keys (`1`, `01`
 * exercise the Map-based canonical ordering), the reserved `assay_*`
 * namespace, and the prototype-pollution probe `__proto__`.
 */
const ID_POOL = [
  'a',
  'B',
  'customers',
  'sg_customers',
  '1',
  '01',
  'a b',
  'a"b',
  "a'b",
  'ünï',
  'assay_overlay_ord',
  '  spaced  ',
  'weird "quoted" key',
  'a.b',
  '#hash',
  '__proto__',
  'constructor',
]

const PIPELINE_NAMES = [
  'customer_portfolio',
  'daily',
  'pipeline with spaces',
  'ünï-pipeline',
  '__proto__',
]

const SOURCE_KINDS = ['file', 'table', 'dataset', 'object-store']
const OPERATIONS = ['filter', 'select-columns', 'rename', 'cast', 'join', 'aggregate']
const SCALARS: PipelineValue[] = [null, true, false, 0, 1, -2, 1.5, '', 'x', 'a"b', 'ünï']

/** A hostile-ish id from the pool, made unique against `used`. */
function genId(rng: TestRng, used: Set<string>): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = rng.pick(ID_POOL)
    if (!used.has(id)) {
      used.add(id)
      return id
    }
  }
  let n = 0
  let id = `node-${n}`
  while (used.has(id)) id = `node-${++n}`
  used.add(id)
  return id
}

function genValue(rng: TestRng, depth: number): PipelineValue {
  if (depth <= 0) return rng.pick(SCALARS)
  switch (rng.int(0, 3)) {
    case 0:
      return rng.pick(SCALARS)
    case 1: {
      const length = rng.int(0, 3)
      return Array.from({ length }, () => genValue(rng, depth - 1))
    }
    default: {
      const map: Record<string, PipelineValue> = {}
      const keys = rng.shuffle(['k', 'kind', 'path', 'expression', 'on', '__proto__', 'a b'])
      const count = rng.int(0, keys.length)
      for (const key of keys.slice(0, count)) {
        Object.defineProperty(map, key, {
          value: genValue(rng, depth - 1),
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }
      return map
    }
  }
}

function genArgs(rng: TestRng): PipelineMap {
  const args: Record<string, PipelineValue> = {}
  const keys = rng.shuffle(['expression', 'columns', 'on', 'left', 'right', 'value'])
  for (const key of keys.slice(0, rng.int(0, keys.length))) {
    Object.defineProperty(args, key, {
      value: genValue(rng, 2),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return args as PipelineMap
}

function genOperation(rng: TestRng): OperationConfig {
  return { operation: rng.pick(OPERATIONS), args: genArgs(rng) }
}

/** Generate a canonical, acyclic, unique-id pipeline. */
export function genPipeline(rng: TestRng): PipelineV1 {
  const count = rng.int(1, 8)
  const used = new Set<string>()
  const nodes: PipelineNode[] = []
  const dataIds: string[] = []
  const allIds: string[] = []
  for (let index = 0; index < count; index++) {
    const id = genId(rng, used)
    const classRoll = rng.int(0, 5)
    if (classRoll === 0 || dataIds.length === 0) {
      nodes.push({
        id,
        type: 'source',
        source: { kind: rng.pick(SOURCE_KINDS), path: `./${id}.parquet` },
      })
      dataIds.push(id)
      allIds.push(id)
      continue
    }
    const pickData = (): string[] => {
      const shuffled = rng.shuffle(dataIds)
      return shuffled.slice(0, Math.max(1, rng.int(1, Math.min(3, dataIds.length))))
    }
    switch (classRoll) {
      case 1:
        nodes.push({ id, type: 'transform', inputs: pickData(), operation: genOperation(rng) })
        dataIds.push(id)
        break
      case 2:
        nodes.push({
          id,
          type: 'sql',
          inputs: rng.bool(0.8) ? pickData() : [],
          sql: `SELECT *\nFROM "${rng.pick(dataIds)}"\n`,
        })
        dataIds.push(id)
        break
      case 3:
        nodes.push({
          id,
          type: 'validate',
          input: rng.pick(dataIds),
          contract: `contracts/${id}.yaml`,
        })
        break
      case 4: {
        const requires = rng.bool(0.5)
          ? rng.shuffle(allIds).slice(0, rng.int(1, Math.min(2, allIds.length)))
          : undefined
        nodes.push({
          id,
          type: 'publish',
          input: rng.pick(dataIds),
          ...(requires !== undefined ? { requires } : {}),
        })
        break
      }
      default: {
        nodes.push({ id, type: 'diff', config: genArgs(rng) })
        break
      }
    }
    allIds.push(id)
  }
  return { version: 1, pipeline: rng.pick(PIPELINE_NAMES), nodes: canonicalNodeOrder(nodes) }
}

/**
 * Render a *valid but deliberately non-canonical* document for `pipeline`:
 * JSON (a YAML 1.2 subset), so node/key order, whitespace, and scalar style
 * differ from the canonical block form. `parsePipeline` of it must equal the
 * AST and `serializePipeline` must be byte-identical to the canonical bytes.
 */
export function renderAlternateYaml(rng: TestRng, pipeline: PipelineV1): string {
  const nodes: Record<string, unknown> = {}
  for (const node of rng.shuffle([...pipeline.nodes])) {
    Object.defineProperty(nodes, node.id, { value: toPlain(rng, nodeBody(node)), enumerable: true })
  }
  const root: Record<string, unknown> = {
    version: 1,
    pipeline: pipeline.pipeline,
    nodes,
  }
  const indent = rng.pick([0, 1, 2])
  return indent === 0 ? JSON.stringify(root) : JSON.stringify(root, null, indent)
}

/**
 * The serialized node body (mirrors `serialize.ts`): the AST's `config` field
 * is spread for `diff`, whose opaque body lives directly at the node level.
 */
function nodeBody(node: PipelineNode): Record<string, unknown> {
  switch (node.type) {
    case 'source':
      return { type: 'source', source: node.source }
    case 'transform':
      return {
        type: 'transform',
        inputs: node.inputs,
        operation: { [node.operation.operation]: node.operation.args },
      }
    case 'sql':
      return { type: 'sql', inputs: node.inputs, sql: node.sql }
    case 'validate':
      return { type: 'validate', input: node.input, contract: node.contract }
    case 'publish':
      return {
        type: 'publish',
        input: node.input,
        ...(node.requires !== undefined ? { requires: node.requires } : {}),
      }
    case 'diff':
      return { type: 'diff', ...node.config }
  }
}

function toPlain(rng: TestRng, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => toPlain(rng, item))
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const key of rng.shuffle(Object.keys(value as Record<string, unknown>))) {
      Object.defineProperty(out, key, {
        value: toPlain(rng, (value as Record<string, unknown>)[key]),
        enumerable: true,
      })
    }
    return out
  }
  return value
}

// ---------------------------------------------------------------------------
// Fuzz mutations — bounded text mutations of a valid pipeline, for the
// totality property (parse never throws; whatever parses satisfies the
// canonical fixpoint).
// ---------------------------------------------------------------------------

const GARBAGE = [
  '{',
  '}',
  '[',
  ']',
  ':',
  '"',
  "'",
  '#',
  '@',
  '&',
  '*',
  '!',
  '|',
  '>',
  '%',
  '`',
  '\\',
  '\t',
  ' ',
  '\n',
  '- ',
  '? ',
  '---',
  '…',
  'ü',
  '0',
  'a',
  'null',
  '.inf',
  '.nan',
  '<<',
  '*a',
  '&x',
  'true',
]

/** Apply 1–3 random text mutations (delete/insert/duplicate-line/splice/alias-cycle). */
export function mutateYaml(rng: TestRng, base: string): string {
  let text = base
  const operations = rng.int(1, 3)
  for (let i = 0; i < operations; i++) {
    const at = rng.int(0, text.length)
    switch (rng.int(0, 5)) {
      case 0:
        text = text.slice(0, at) + text.slice(at + rng.int(1, 20))
        break
      case 1:
        text = text.slice(0, at) + rng.pick(GARBAGE) + text.slice(at)
        break
      case 2: {
        const lines = text.split('\n')
        lines.splice(rng.int(0, lines.length - 1), 1)
        text = lines.join('\n')
        break
      }
      case 3: {
        const lines = text.split('\n')
        const lineIndex = rng.int(0, lines.length - 1)
        lines.splice(lineIndex, 0, lines[lineIndex] ?? '')
        text = lines.join('\n')
        break
      }
      case 4: {
        const to = rng.int(0, text.length)
        const [from, end] = at <= to ? [at, to] : [to, at]
        text = text.slice(0, from) + text.slice(end)
        break
      }
      default:
        text = injectAnchorAlias(rng, text)
        break
    }
    if (text.length > 20000) text = text.slice(0, 20000)
  }
  return text
}

/**
 * Inject a YAML anchor declaration plus an alias that points back at it — an
 * alias **cycle** — into an existing mapping. The totality suite therefore
 * also exercises the parser's generic-value cycle guard (`walkValue`'s
 * `seen` set): a future removal of that guard would recurse until the stack
 * overflows and fail the never-throws assertion. Returns `text` unchanged
 * when the document has no mapping-key line to anchor.
 */
function injectAnchorAlias(rng: TestRng, text: string): string {
  const lines = text.split('\n')
  const candidates: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (/^\s+\S.*:\s*$/.test(lines[i] as string)) candidates.push(i)
  }
  if (candidates.length === 0) return text
  const at = rng.pick(candidates)
  const line = lines[at] as string
  const anchor = `fz${rng.int(0, 99)}`
  const indent = `${line.match(/^\s*/)?.[0] ?? ''}  `
  lines[at] = `${line} &${anchor}`
  lines.splice(at + 1, 0, `${indent}self: *${anchor}`)
  return lines.join('\n')
}
