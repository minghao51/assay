/**
 * Deterministic generators for the m5-0 property tests (test support only —
 * NOT part of the public surface; `index.ts` never re-exports this module).
 *
 * Repo convention is determinism: no `Math.random`. Everything derives from
 * a seedable PRNG (mulberry32, same construction as `@assay/domain`'s
 * private copy — packages are lint-forbidden from importing each other) so
 * a failing seed reproduces exactly; seeds are fixed in the test files on
 * purpose.
 *
 * Generated contracts are always *normalized* ASTs (the shape `parseContract`
 * returns: `required`/`unique` only `true`, no empty descriptions, dataset
 * present only with a rule) — the normalization itself is pinned by golden
 * tests, and the round-trip properties operate on canonical shapes.
 *
 * The value pools are deliberately "messy-renderable": strings that
 * `renderMessyYaml` can emit by hand (no quotes/newlines outside the
 * description pool, RE2-safe patterns without single quotes). Trickier
 * scalar shapes are covered by golden pins instead.
 */
import type { ColumnRuleSet, ContractScalar, ContractV1, DatasetRuleSet } from './ast'
import { CONTRACT_TYPE_VOCABULARY } from './vocabulary'

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

const NAME_STEMS = ['customers', 'orders', 'events_daily', 'ledger-v3', 'inventory']
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

/**
 * Description pool — every entry is renderable by the messy YAML writer:
 * plain-ish single lines, quoted strings with leading/trailing spaces, one
 * multi-line and one trailing-newline entry (rendered as literal blocks).
 */
const DESCRIPTIONS = [
  'Quality gates for the customers feed',
  'unicode: ünïcødé — ✓',
  'trailing space ',
  ' leading space',
  "it's quoted",
  'multi\nline',
  'trailing newline\n',
  'symbols #not-a-comment: maybe',
]

/** RE2-safe patterns without single quotes (so the messy writer can single-quote them). */
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

function genName(rng: TestRng): string {
  return `${rng.pick(NAME_STEMS)}-${rng.int(0, 99)}`
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
      const roll = rng.int(0, 3)
      if (roll === 0) values.push(rng.pick(ALLOWED_STRINGS))
      else if (roll === 1) values.push(rng.pick(ALLOWED_NUMBERS))
      else if (roll === 2) values.push(rng.bool())
      else
        values.push(values.length > 0 ? (values[0] as ContractScalar) : rng.pick(ALLOWED_STRINGS)) // occasional duplicate entry (semantically a set)
    }
    column.allowedValues = values
  }
  if (rng.bool(0.4)) column.regex = rng.pick(REGEX_POOL)
  if (rng.bool(0.4)) column.maxNullShare = rng.pick(SHARE_VALUES)
  if (rng.bool(0.4)) column.minDistinctShare = rng.pick(SHARE_VALUES)
  return column as ColumnRuleSet
}

/** Generate a normalized v1 contract (the exact shape `parseContract` returns). */
export function genContract(rng: TestRng): ContractV1 {
  const metadata: { name: string; version: number; description?: string } = {
    name: genName(rng),
    version: rng.int(1, 9),
  }
  if (rng.bool(0.5)) metadata.description = rng.pick(DESCRIPTIONS)

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

// ---------------------------------------------------------------------------
// Messy YAML rendering — a *test-side*, deliberately non-canonical writer
// used to pin canonical stability: parse(renderMessyYaml(rng, ast)) must
// equal `ast`, and serializeContract of it must be byte-identical to the
// canonical serialization, for every generated contract.
// ---------------------------------------------------------------------------

const SECTION_COMMENTS = [' contract metadata', ' column rules follow', ' dataset-level rules']

function isPlainSafe(text: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9 _./@-]*$/.test(text)) return false
  if (/^\s|\s$/.test(text)) return false // plain scalars would strip it (pinning the quoted path instead)
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(text)) return false
  if (/^-?[0-9][0-9.]*$/.test(text)) return false
  return true
}

function singleQuoted(text: string): string {
  return `'${text.replaceAll("'", "''")}'`
}

function styleInlineScalar(rng: TestRng, text: string): string {
  if (isPlainSafe(text)) return rng.bool(0.5) ? text : singleQuoted(text)
  if (rng.bool(0.5)) return singleQuoted(text)
  return JSON.stringify(text) // double-quoted; pool strings contain no exotic control chars
}

function styleKey(rng: TestRng, key: string): string {
  if (rng.bool(0.75)) return key
  return rng.bool() ? `"${key}"` : `'${key}'`
}

/** Render a description that may contain newlines via literal blocks (chomping exact). */
function renderDescription(rng: TestRng, indent: number, text: string): string[] {
  if (!text.includes('\n')) {
    return [`${styleKey(rng, 'description')}: ${styleInlineScalar(rng, text)}`]
  }
  // Literal blocks only: folded ('>') styles would rewrite '\n' as a space.
  const chomp = text.endsWith('\n') ? '|' : '|-'
  const pad = ' '.repeat(indent)
  const bodyLines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
  return [`${styleKey(rng, 'description')}: ${chomp}`, ...bodyLines.map((line) => `${pad}${line}`)]
}

function renderAllowedValues(
  rng: TestRng,
  indent: number,
  values: readonly ContractScalar[],
): string[] {
  const pad = ' '.repeat(indent)
  const key = styleKey(rng, 'allowed-values')
  if (values.length === 0 || rng.bool(0.5)) {
    const flow = values
      .map((value) => (typeof value === 'string' ? styleInlineScalar(rng, value) : String(value)))
      .join(', ')
    return [`${pad}${key}: [${flow}]`]
  }
  return [
    `${pad}${key}:`,
    ...values.map((value) => {
      const rendered = typeof value === 'string' ? styleInlineScalar(rng, value) : String(value)
      return `${pad}  - ${rendered}`
    }),
  ]
}

/**
 * Render a valid but deliberately non-canonical YAML document for `contract`:
 * shuffled section order, random indentation width (2/4), random blank
 * lines and comments, mixed key/scalar quoting styles, block *or* flow
 * allowed-values. Only produces YAML for the generator's value pools.
 */
export function renderMessyYaml(rng: TestRng, contract: ContractV1): string {
  const indentSize = rng.pick([2, 4])
  const pad = ' '.repeat(indentSize)
  const lines: string[] = []

  const sections = rng
    .shuffle(['format', 'name', 'version', 'description', 'columns', 'dataset'])
    .filter((section) => {
      if (section === 'description') return contract.metadata.description !== undefined
      if (section === 'columns') return contract.columns.length > 0
      if (section === 'dataset') return contract.dataset !== undefined
      return true
    })

  for (const section of sections) {
    if (lines.length > 0 && rng.bool(0.3)) lines.push('')
    if (rng.bool(0.25)) lines.push(`#${rng.pick(SECTION_COMMENTS)}`)
    switch (section) {
      case 'format':
        lines.push(`${styleKey(rng, 'format')}: ${styleInlineScalar(rng, contract.format)}`)
        break
      case 'name':
        lines.push(`${styleKey(rng, 'name')}: ${styleInlineScalar(rng, contract.metadata.name)}`)
        break
      case 'version':
        lines.push(`${styleKey(rng, 'version')}: ${String(contract.metadata.version)}`)
        break
      case 'description':
        lines.push(...renderDescription(rng, indentSize, contract.metadata.description as string))
        break
      case 'columns': {
        lines.push(`${styleKey(rng, 'columns')}:`)
        const dashPad = rng.bool() ? pad : '' // dashes may sit at the key's indent or deeper
        for (const column of contract.columns) {
          const fieldPad = `${dashPad}  `
          lines.push(`${dashPad}- ${styleKey(rng, 'name')}: ${styleInlineScalar(rng, column.name)}`)
          const ruleKeys = rng
            .shuffle([
              'type',
              'required',
              'unique',
              'min',
              'max',
              'allowed-values',
              'regex',
              'max-null-share',
              'min-distinct-share',
            ])
            .filter((ruleKey) => {
              if (ruleKey === 'type') return column.type !== undefined
              if (ruleKey === 'required') return column.required === true
              if (ruleKey === 'unique') return column.unique === true
              if (ruleKey === 'min') return column.min !== undefined
              if (ruleKey === 'max') return column.max !== undefined
              if (ruleKey === 'allowed-values') return column.allowedValues !== undefined
              if (ruleKey === 'regex') return column.regex !== undefined
              if (ruleKey === 'max-null-share') return column.maxNullShare !== undefined
              return column.minDistinctShare !== undefined
            })
          for (const ruleKey of ruleKeys) {
            if (ruleKey === 'allowed-values') {
              lines.push(
                ...renderAllowedValues(
                  rng,
                  fieldPad.length,
                  column.allowedValues as readonly ContractScalar[],
                ),
              )
              continue
            }
            const value =
              ruleKey === 'type'
                ? styleInlineScalar(rng, column.type as string)
                : ruleKey === 'required'
                  ? 'true'
                  : ruleKey === 'unique'
                    ? 'true'
                    : ruleKey === 'regex'
                      ? singleQuoted(column.regex as string)
                      : String(
                          (column as unknown as Record<string, unknown>)[
                            ruleKey === 'max-null-share'
                              ? 'maxNullShare'
                              : ruleKey === 'min-distinct-share'
                                ? 'minDistinctShare'
                                : ruleKey
                          ],
                        )
            lines.push(`${fieldPad}${styleKey(rng, ruleKey)}: ${value}`)
          }
        }
        break
      }
      case 'dataset': {
        lines.push(`${styleKey(rng, 'dataset')}:`)
        const dataset = contract.dataset as DatasetRuleSet
        // Nested mapping keys must sit deeper than the `dataset` key itself.
        const fieldPad = rng.bool() ? pad : `${pad}  `
        if (dataset.minRows !== undefined) {
          lines.push(`${fieldPad}${styleKey(rng, 'min-rows')}: ${String(dataset.minRows)}`)
        }
        if (dataset.maxRows !== undefined) {
          lines.push(`${fieldPad}${styleKey(rng, 'max-rows')}: ${String(dataset.maxRows)}`)
        }
        break
      }
    }
  }
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Fuzz mutations — bounded text mutations of a valid contract, for the
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

/** Apply 1–3 random text mutations (delete/insert/duplicate-line/splice). */
export function mutateYaml(rng: TestRng, base: string): string {
  let text = base
  const operations = rng.int(1, 3)
  for (let i = 0; i < operations; i++) {
    const at = rng.int(0, text.length)
    switch (rng.int(0, 4)) {
      case 0: // delete a slice
        text = text.slice(0, at) + text.slice(at + rng.int(1, 20))
        break
      case 1: // insert garbage
        text = text.slice(0, at) + rng.pick(GARBAGE) + text.slice(at)
        break
      case 2: {
        // delete a line
        const lines = text.split('\n')
        lines.splice(rng.int(0, lines.length - 1), 1)
        text = lines.join('\n')
        break
      }
      case 3: {
        // duplicate a line
        const lines = text.split('\n')
        const lineIndex = rng.int(0, lines.length - 1)
        lines.splice(lineIndex, 0, lines[lineIndex] ?? '')
        text = lines.join('\n')
        break
      }
      case 4: {
        // splice out a region
        const to = rng.int(0, text.length)
        const [from, end] = at <= to ? [at, to] : [to, at]
        text = text.slice(0, from) + text.slice(end)
        break
      }
    }
    if (text.length > 20000) text = text.slice(0, 20000) // keep the fuzz bounded
  }
  return text
}
