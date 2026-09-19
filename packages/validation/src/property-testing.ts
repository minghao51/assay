/**
 * Deterministic generators for the m5-1 property tests (test support only —
 * NOT part of the public surface; `index.ts` never re-exports this module).
 *
 * Repo convention is determinism: no `Math.random`. Everything derives from
 * a seedable PRNG (mulberry32, the same construction as `@assay/contracts`
 * and `@assay/domain`'s private copies — packages are lint-forbidden from
 * importing each other) so a failing seed reproduces exactly; seeds are
 * fixed in the test files on purpose.
 *
 * Generated schemas deliberately mix every family the classifier knows —
 * canonical scalars, parameterized forms, arrays, nested types, unknown
 * spellings — plus occasional malformed entries (duplicates), because the
 * property under test is *totality*: any (contract, schema, options) input
 * yields a plan or typed binding errors, never a throw.
 */
import type { ColumnRuleSet, ContractScalar, ContractV1, DatasetRuleSet } from '@assay/contracts'
import { CONTRACT_TYPE_VOCABULARY } from '@assay/contracts'

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
  /** Next float in [0, 1). */
  float(): number
  /** Next integer in [min, max] inclusive. */
  int(min: number, max: number): number
  /** Uniform pick; list must be non-empty. */
  pick<T>(items: readonly T[]): T
  /** True with probability p (default 0.5). */
  bool(p?: number): boolean
  /** Fisher–Yates shuffle (returns a fresh array). */
  shuffle<T>(items: readonly T[]): T[]
}

export function makeTestRng(seed: number): TestRng {
  const next = mulberry32(seed)
  const rng: TestRng = {
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
  return rng
}

const COLUMN_POOL = [
  'id',
  'email',
  'country',
  'age',
  'joined_at',
  'amount',
  'score',
  'flag',
  'note',
]

/** RE2-safe patterns without single quotes (pool mirrors m5-0's generator). */
const REGEX_POOL = [
  '^[A-Z]{2}$',
  '^\\d{4}-\\d{2}-\\d{2}$',
  'user_[0-9]+',
  '@example\\.com$',
  '^(a|b)+c?',
  '[a-z-]+_[0-9]{1,3}',
]

const SHARE_VALUES = [0, 0.25, 0.5, 0.75, 1]
const ALLOWED_STRINGS = ['US', 'GB', 'DE', 'FR', 'has space', 'ünï']
const ALLOWED_NUMBERS = [0, 1, 2, 100, -5, 0.25, 1.5]

/**
 * Engine type spellings the generated schemas draw from — canonical flat
 * scalars across every family, parameterized forms, arrays/nested/unknown
 * spellings that must classify as `'other'`, and one alias spelling that
 * must stay unclassified (the engine never reports aliases).
 */
const SCHEMA_TYPE_POOL = [
  'BIGINT',
  'INTEGER',
  'SMALLINT',
  'TINYINT',
  'HUGEINT',
  'UBIGINT',
  'DOUBLE',
  'FLOAT',
  'DECIMAL(10,2)',
  'DECIMAL(38,10)',
  'VARCHAR',
  'VARCHAR(3)',
  'BOOLEAN',
  'DATE',
  'TIME',
  'TIMESTAMP',
  'TIMESTAMP WITH TIME ZONE',
  'UUID',
  'JSON',
  'BLOB',
  // unclassifiable — every family rule must reject these honestly
  'INTEGER[]',
  'VARCHAR[]',
  'STRUCT(a INTEGER)',
  'MAP(VARCHAR, INTEGER)',
  'UNION(a INTEGER, b VARCHAR)',
  'WEIRD_TYPE',
  'varchar',
]

/** Generate a target schema; occasionally includes a duplicate name. */
export function genSchema(rng: TestRng): { name: string; type: string }[] {
  const names = rng.shuffle(COLUMN_POOL).slice(0, rng.int(0, COLUMN_POOL.length))
  const schema = names.map((name) => ({ name, type: rng.pick(SCHEMA_TYPE_POOL) }))
  if (schema.length > 0 && rng.bool(0.05)) {
    const original = rng.pick(schema)
    schema.push({ name: original.name, type: rng.pick(SCHEMA_TYPE_POOL) })
  }
  return schema
}

function genColumn(rng: TestRng, name: string): ColumnRuleSet {
  const column: { name: string } & Record<string, unknown> = { name }
  if (rng.bool(0.6)) column.type = rng.pick(CONTRACT_TYPE_VOCABULARY)
  if (rng.bool(0.4)) column.required = true
  if (rng.bool(0.4)) column.unique = true
  const boundsRoll = rng.int(0, 3)
  const finite = () => (rng.bool(0.5) ? rng.int(-1000, 1000) : rng.int(-10000, 10000) / 100)
  if (boundsRoll === 0) {
    const min = finite()
    column.min = min
    column.max = min + rng.int(1, 5000) // min ≤ max guaranteed
  } else if (boundsRoll === 1) {
    column.min = finite()
  } else if (boundsRoll === 2) {
    column.max = finite()
  }
  if (rng.bool(0.4)) {
    const count = rng.int(0, 4)
    const values: ContractScalar[] = []
    for (let i = 0; i < count; i++) {
      const roll = rng.int(0, 2)
      if (roll === 0) values.push(rng.pick(ALLOWED_STRINGS))
      else if (roll === 1) values.push(rng.pick(ALLOWED_NUMBERS))
      else values.push(rng.bool())
    }
    column.allowedValues = values
  }
  if (rng.bool(0.4)) column.regex = rng.pick(REGEX_POOL)
  if (rng.bool(0.4)) column.maxNullShare = rng.pick(SHARE_VALUES)
  if (rng.bool(0.4)) column.minDistinctShare = rng.pick(SHARE_VALUES)
  // Generated ASTs are normalized (m5-0 convention): a rule-less entry is
  // not a shape parseContract can return, so guarantee a rule. No rng draw:
  // the streams of the pinned seeds are unaffected apart from this fix-up.
  if (Object.keys(column).length === 1) column.required = true
  return column as ColumnRuleSet
}

/** Generate a normalized v1 contract (the exact shape `parseContract` returns). */
export function genContract(rng: TestRng): ContractV1 {
  const metadata: { name: string; version: number; description?: string } = {
    name: `contract-${rng.int(0, 99)}`,
    version: rng.int(1, 9),
  }
  if (rng.bool(0.5)) metadata.description = 'generated for property tests'

  const names = rng.shuffle(COLUMN_POOL).slice(0, rng.int(0, COLUMN_POOL.length))
  const columns = names.map((name) => genColumn(rng, name))

  let dataset: DatasetRuleSet | undefined
  if (rng.bool(0.5)) {
    const minRows = rng.int(0, 50000)
    dataset = rng.bool(0.6) ? { minRows, maxRows: minRows + rng.int(0, 100000) } : { minRows }
  }

  return {
    format: 'v1',
    metadata,
    columns,
    ...(dataset !== undefined ? { dataset } : {}),
  }
}

/** Deterministic compile options over a small relation-name pool. */
export function genOptions(rng: TestRng): { relation: string; sampleLimit?: number } {
  const options: { relation: string; sampleLimit?: number } = {
    relation: rng.pick(['t1', 'assay_v2', 'view with spaces']),
  }
  if (rng.bool(0.5)) options.sampleLimit = rng.pick([1, 2, 5, 20, 100])
  return options
}
