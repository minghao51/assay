#!/usr/bin/env node
/**
 * generate-adr-index.mjs — regenerate the ADR index tables in docs/adr/README.md
 * from the ADR files themselves (their H1 title and Status section).
 *
 * The tables live between the explicit markers `<!-- adr-index:begin -->` and
 * `<!-- adr-index:end -->`; everything outside the markers is left untouched.
 * The output is deterministic (sorted by ADR number, fixed formatting), so
 * `--check` is a reliable drift gate: it exits 1 and prints a diff when the
 * checked-in index is stale.
 *
 * Plain Node ≥22, zero dependencies. Run `pnpm adr:index` (write) or
 * `pnpm adr:index:check` (verify). See docs/adr/README.md § Conventions.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

export const BEGIN_MARKER = '<!-- adr-index:begin -->'
export const END_MARKER = '<!-- adr-index:end -->'

const scriptDir = dirname(fileURLToPath(import.meta.url))
export const repoRoot = resolve(scriptDir, '..')
const adrDir = join(repoRoot, 'docs', 'adr')
const readmePath = join(adrDir, 'README.md')

/**
 * Parse one ADR file into `{ number, title, status }`.
 *
 * - The title is the H1 text after `# ADR NNNN: ` — the file is the source of
 *   truth (it intentionally overrides any earlier hand-written index wording).
 * - The status is the first line of the `## Status` section; a trailing
 *   parenthetical/date is ignored, only the leading `Accepted`/`Proposed`
 *   keyword classifies the record.
 */
export function parseAdrFile(filePath) {
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
  const h1 = lines.find((line) => line.startsWith('# ADR '))
  if (h1 === undefined) throw new Error(`${filePath}: no '# ADR NNNN: Title' H1`)
  const match = /^# ADR (\d{4}): (.+)$/.exec(h1)
  if (match === null) throw new Error(`${filePath}: malformed H1: ${h1}`)
  const number = match[1]
  const title = match[2].trim()

  const statusAt = lines.findIndex((line) => line.trim() === '## Status')
  if (statusAt === -1) throw new Error(`${filePath}: no '## Status' section`)
  let status = ''
  let started = false
  for (let i = statusAt + 1; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!started) {
      if (line === '') continue
      if (line.startsWith('#')) break
      started = true
    } else if (line === '' || line.startsWith('#')) {
      break
    }
    status += line
  }

  let classification = 'Other'
  if (status.startsWith('Accepted')) classification = 'Accepted'
  else if (status.startsWith('Proposed')) classification = 'Proposed'
  return { number, title, status, classification }
}

/** Read every `docs/adr/0*.md` record (template/README excluded by the glob). */
export function readAdrRecords() {
  return readdirSync(adrDir)
    .filter((name) => /^0\d{3}-.*\.md$/.test(name))
    .map((name) => parseAdrFile(join(adrDir, name)))
    .sort((a, b) => a.number.localeCompare(b.number))
}

const byNumber = (a, b) => a.number.localeCompare(b.number)

/** Render one Markdown table; mirrors Prettier's markdown table padding. */
function formatTable(rows) {
  const col0 = Math.max('ADR'.length, ...rows.map((r) => r.number.length))
  const col1 = Math.max('Decision'.length, ...rows.map((r) => r.title.length))
  const pad = (value, width) => value + ' '.repeat(width - value.length)
  const out = [
    `| ${pad('ADR', col0)} | ${pad('Decision', col1)} |`,
    `| ${'-'.repeat(col0)} | ${'-'.repeat(col1)} |`,
  ]
  for (const row of rows) out.push(`| ${pad(row.number, col0)} | ${pad(row.title, col1)} |`)
  return out.join('\n')
}

/** Build the full marker region body (section headings + both tables). */
export function buildIndexBody(records) {
  const accepted = records.filter((r) => r.classification === 'Accepted').sort(byNumber)
  const proposed = records.filter((r) => r.classification === 'Proposed').sort(byNumber)
  const other = records.filter(
    (r) => r.classification !== 'Accepted' && r.classification !== 'Proposed',
  )
  if (other.length > 0) {
    throw new Error(
      `ADR(s) with an unrecognized Status were not indexed: ${other
        .map((r) => `${r.number} (${JSON.stringify(r.status)})`)
        .join(', ')} — extend generate-adr-index.mjs`,
    )
  }
  return [
    '## Accepted',
    '',
    formatTable(accepted),
    '',
    '## Proposed',
    '',
    formatTable(proposed),
  ].join('\n')
}

/** Replace the marker region in `readme` with the freshly generated body. */
export function generateReadme(readme, records) {
  const begin = readme.indexOf(BEGIN_MARKER)
  const end = readme.indexOf(END_MARKER)
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(`docs/adr/README.md is missing the ${BEGIN_MARKER} … ${END_MARKER} markers`)
  }
  const before = readme.slice(0, begin + BEGIN_MARKER.length)
  const after = readme.slice(end)
  return `${before}\n\n${buildIndexBody(records)}\n\n${after}`
}

/** Minimal unified diff (LCS) for the `--check` failure output. */
function unifiedDiff(current, generated, label) {
  const a = current.split('\n')
  const b = generated.split('\n')
  const n = a.length
  const m = b.length
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: ' ', line: a[i] })
      i += 1
      j += 1
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: '-', line: a[i] })
      i += 1
    } else {
      ops.push({ type: '+', line: b[j] })
      j += 1
    }
  }
  while (i < n) ops.push({ type: '-', line: a[i++] })
  while (j < m) ops.push({ type: '+', line: b[j++] })

  // Emit hunks with 3 lines of context.
  const context = 3
  const changed = ops.map((op) => op.type !== ' ')
  const hunks = []
  let k = 0
  while (k < ops.length) {
    if (!changed[k]) {
      k += 1
      continue
    }
    let start = Math.max(0, k - context)
    let end = k
    while (end < ops.length) {
      if (changed[end]) {
        end += 1
      } else if (ops.slice(end, end + context).some((op, idx) => changed[end + idx])) {
        end += 1
      } else {
        break
      }
    }
    end = Math.min(ops.length, end + context)
    hunks.push(ops.slice(start, end))
    k = end
  }
  if (hunks.length === 0) return ''
  const out = [`--- ${label} (checked in)`, `+++ ${label} (generated)`]
  for (const hunk of hunks) {
    out.push(`@@`)
    for (const op of hunk) out.push(`${op.type}${op.line}`)
  }
  return out.join('\n') + '\n'
}

function main() {
  const check = process.argv.slice(2).includes('--check')
  const records = readAdrRecords()
  const current = readFileSync(readmePath, 'utf8')
  const generated = generateReadme(current, records)
  if (!check) {
    writeFileSync(readmePath, generated)
    process.stdout.write(
      `adr:index — wrote ${records.length} records (${records.filter((r) => r.classification === 'Accepted').length} accepted, ${records.filter((r) => r.classification === 'Proposed').length} proposed)\n`,
    )
    return 0
  }
  if (current === generated) {
    process.stdout.write(`adr:index:check — OK (${records.length} records)\n`)
    return 0
  }
  process.stderr.write(unifiedDiff(current, generated, 'docs/adr/README.md'))
  process.stderr.write('adr:index:check — FAIL: docs/adr/README.md is stale; run pnpm adr:index\n')
  return 1
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  process.exitCode = main()
}
