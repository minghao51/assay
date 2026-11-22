#!/usr/bin/env node
/**
 * check-current-state.mjs — a deliberately SMALL, offline drift checker for the
 * facts that a cold agent reads first and that a mangled merge silently breaks.
 *
 * This is NOT semantic freshness coverage of the documentation. It parses a
 * finite, registered set of statements and compares each one with the single
 * authoritative source listed below. Every other Markdown file (history,
 * archives, closed queue rows, dated closure narratives) is deliberately out of
 * scope and may say anything.
 *
 * Registered facts and their sources
 * ----------------------------------
 * 1. dev-node-policy — root development Node line.
 *    - source of truth: root `package.json` `engines.node` (`^24.0.0`).
 *    - `.node-version` (major) must agree with that major.
 *    - AGENTS.md and README.md development paragraphs must claim
 *      "Node <major>" and the exact engines string.
 *    - docs/process/handoff/20261120-node-support-contract.md §1 must quote the
 *      exact engines string and the exact `.node-version` value.
 * 2. workspace-packages — pnpm-workspace globs vs the checkout.
 *    - source of truth: `pnpm-workspace.yaml` `packages:` globs.
 *    - every `apps/<dir>` and `packages/<dir>` that contains a `package.json`
 *      must be matched by a glob, every glob must expand to at least one such
 *      directory, and declared package names must be unique.
 * 3. supported-formats — the declared input formats.
 *    - source of truth: `apps/cli/src/connection.ts` `SUPPORTED_FORMATS`.
 *    - docs/process/handoff.md §1 ("for N input formats — …") and README.md's
 *      intro parenthesis must name the same set and the same count.
 * 4. active-queue — the living handoff's current-state block.
 *    - the block (the paragraph that begins `**Current state / next action (`)
 *      must contain the sentinel "No row is selected for dispatch.".
 *    - the bold row IDs in its "Recorded but unselected:" clause must equal the
 *      rows the dated pickup table marks "recorded, not selected" (so a CLOSED
 *      row can never be presented as remaining, and no remaining row is lost).
 *    - the block must not name a CLOSED row as the next action.
 *    - source of truth: docs/process/handoff/20261118-post-ew03ia-pickup.md
 *      tables (status cells).
 * 6. product-node-floor — the product manifests declare the development line.
 *    - source of truth: root `package.json` `engines.node` (`^24.0.0`).
 *    - every `apps/<dir>`/`packages/<dir>` manifest that declares `engines.node`
 *      must equal that string exactly; the three shipped apps (cli, web,
 *      vscode) must declare it (silent removal is drift too).
 * 5. package-allowlist — the recursive pipeline-runner entry.
 *    - packages/engine-duckdb/README.md claims the `files` allowlist carries
 *      the recursive `dist/pipeline-runner/**` JavaScript/declarations/maps.
 *    - the same package.json `files` array must actually carry all four globs.
 * 6. product-node-floor — every product manifest declares the development line
 *    (see above; kept adjacent to fact 5 for reading order).
 *
 * Deliberately NOT covered (do not widen this claim without implementing it):
 *   - any statement outside the blocks above, including §2 verified-state
 *     narratives, closed queue rows, the handoff snapshot and archive files;
 *   - dates, commit SHAs, gate counts, coverage numbers, "tested <version>"
 *     claims (there is no machine-readable source for them);
 *   - the counted package total mentioned in prose (docs/process/contributing.md
 *     "17 packages"), the ADR statuses (see `pnpm adr:index:check`), link
 *     existence (see `pnpm docs:links:check`) or any runtime behavior;
 *   - semantic meaning: a statement can be wrong in ways these patterns cannot
 *     see, and a rewritten sentence can pass.
 *
 * Inputs are Markdown/JSON/YAML text read as DATA ONLY — nothing is imported,
 * evaluated or executed. Zero dependencies, deterministic, offline. Normal mode
 * writes nothing; it prints findings and sets the exit code (0 clean, 1 drift).
 * Run `pnpm current-state:check`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const scriptDir = dirname(fileURLToPath(import.meta.url))
export const defaultRepoRoot = resolve(scriptDir, '..')

/** The finite set of files this checker reads. Paths are repo-relative. */
export const SOURCES = {
  rootPackage: 'package.json',
  nodeVersionFile: '.node-version',
  workspace: 'pnpm-workspace.yaml',
  agents: 'AGENTS.md',
  readme: 'README.md',
  handoff: 'docs/process/handoff.md',
  pickup: 'docs/process/handoff/20261118-post-ew03ia-pickup.md',
  nodeContract: 'docs/process/handoff/20261120-node-support-contract.md',
  cliConnection: 'apps/cli/src/connection.ts',
  enginePackage: 'packages/engine-duckdb/package.json',
  engineReadme: 'packages/engine-duckdb/README.md',
}

export const FACT_IDS = [
  'dev-node-policy',
  'workspace-packages',
  'supported-formats',
  'active-queue',
  'package-allowlist',
  'product-node-floor',
]

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 }

/** 1-based line number of a character offset. */
function lineAt(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/** 1-based line of the first line matching `regex`, or 1 when absent. */
function lineOfMatch(text, regex) {
  const match = regex.exec(text)
  return match === null ? 1 : lineAt(text, match.index)
}

/**
 * Paragraphs as data: a maximal run of non-blank lines, whitespace collapsed to
 * a single space so a sentence wrapped across lines still matches. `startLine`
 * is 1-based. A heading line with no blank line after it joins the next run —
 * every anchored block in this repo is separated by a blank line.
 */
export function paragraphs(text) {
  const lines = text.split('\n')
  const out = []
  let current = null
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') {
      current = null
      continue
    }
    if (current === null) {
      current = { startLine: i + 1, lines: [] }
      out.push(current)
    }
    current.lines.push(lines[i])
  }
  return out.map((p) => ({
    startLine: p.startLine,
    text: p.lines.join(' ').replace(/\s+/g, ' ').trim(),
  }))
}

/** The first paragraph whose text satisfies `predicate`. */
function findParagraph(text, predicate) {
  return paragraphs(text).find((p) => predicate(p.text)) ?? null
}

/** Normalize a human list ("Parquet, CSV, JSONL and JSON") to lowercase tokens. */
export function parseFormatList(listText) {
  return listText
    .replace(/\*\*/g, '')
    .split(/,|\band\b/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token !== '')
}

function sortedUnique(values) {
  return [...new Set(values)].sort()
}

function sameSet(a, b) {
  const left = sortedUnique(a)
  const right = sortedUnique(b)
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function formatSet(values) {
  return sortedUnique(values).join(', ')
}

/**
 * Repository-backed inputs. `readText` returns null for a missing file, so
 * every fact reports a located finding instead of throwing. Tests inject a
 * plain object with the same three functions.
 */
export function createRepoDeps(repoRoot = defaultRepoRoot) {
  return {
    readText(relPath) {
      try {
        return readFileSync(join(repoRoot, relPath), 'utf8')
      } catch {
        return null
      }
    },
    /** Every `apps/<dir>` and `packages/<dir>` that holds a package.json. */
    listPackageDirs() {
      const found = []
      for (const parent of ['apps', 'packages']) {
        let entries
        try {
          entries = readdirSync(join(repoRoot, parent), { withFileTypes: true })
        } catch {
          continue
        }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          if (!existsSync(join(repoRoot, parent, entry.name, 'package.json'))) continue
          found.push(`${parent}/${entry.name}`)
        }
      }
      return found.sort()
    },
  }
}

function makeReporter() {
  const findings = []
  let assertions = 0
  return {
    findings,
    get assertions() {
      return assertions
    },
    /** One assertion; records a located finding when `ok` is false. */
    expect(ok, location, expected, actual) {
      assertions++
      if (ok) return
      findings.push({
        fact: location.fact,
        file: location.file,
        line: location.line,
        expected,
        actual,
      })
    },
  }
}

// --- fact 1: root development Node policy ----------------------------------

function checkDevNodePolicy(deps, report) {
  const fact = 'dev-node-policy'
  const pkgText = deps.readText(SOURCES.rootPackage)
  let enginesNode = null
  if (pkgText === null) {
    report.expect(
      false,
      { fact, file: SOURCES.rootPackage, line: 1 },
      'engines.node present',
      'file missing',
    )
  } else {
    let pkg = null
    try {
      pkg = JSON.parse(pkgText)
    } catch {
      report.expect(
        false,
        { fact, file: SOURCES.rootPackage, line: 1 },
        'valid JSON',
        'unparseable',
      )
    }
    enginesNode = typeof pkg?.engines?.node === 'string' ? pkg.engines.node : null
    report.expect(
      enginesNode !== null,
      { fact, file: SOURCES.rootPackage, line: lineOfMatch(pkgText, /"engines"/) },
      'engines.node declares the development Node line',
      'no engines.node',
    )
  }

  const versionText = deps.readText(SOURCES.nodeVersionFile)
  const versionValue = versionText === null ? null : versionText.trim()
  report.expect(
    versionValue !== null && /^\d+$/.test(versionValue),
    { fact, file: SOURCES.nodeVersionFile, line: 1 },
    'a major line such as "24"',
    versionValue === null ? 'file missing' : JSON.stringify(versionValue),
  )

  const enginesMajor =
    enginesNode === null ? null : (/^\^?(\d+)(?:\.|$)/.exec(enginesNode)?.[1] ?? null)
  report.expect(
    enginesMajor !== null && enginesMajor === versionValue,
    { fact, file: SOURCES.rootPackage, line: lineOfMatch(pkgText ?? '', /"node"/) },
    `engines.node major equals .node-version (${versionValue ?? '?'})`,
    `engines.node ${enginesNode ?? '(none)'}`,
  )

  if (enginesNode === null || enginesMajor === null) return

  for (const file of [SOURCES.agents, SOURCES.readme]) {
    const text = deps.readText(file)
    const paragraph =
      text === null ? null : findParagraph(text, (body) => body.includes('Development requires'))
    if (paragraph === null) {
      report.expect(
        false,
        { fact, file, line: 1 },
        'a "Development requires …" paragraph',
        'not found',
      )
      continue
    }
    const line = paragraph.startLine
    report.expect(
      new RegExp(`Node ${enginesMajor}\\b`).test(paragraph.text),
      { fact, file, line },
      `the paragraph claims "Node ${enginesMajor}"`,
      'claim absent',
    )
    report.expect(
      paragraph.text.includes(`\`${enginesNode}\``),
      { fact, file, line },
      `the paragraph quotes the engines string \`${enginesNode}\``,
      'engines string absent or different',
    )
  }

  const contractText = deps.readText(SOURCES.nodeContract)
  const contract =
    contractText === null
      ? null
      : findParagraph(contractText, (body) => body.includes('support contract is the'))
  if (contract === null) {
    report.expect(
      false,
      { fact, file: SOURCES.nodeContract, line: 1 },
      'the §1 development-contract paragraph',
      'not found',
    )
  } else {
    const line = contract.startLine
    report.expect(
      contract.text.includes(`\`${enginesNode}\``),
      { fact, file: SOURCES.nodeContract, line },
      `the contract quotes \`${enginesNode}\``,
      'engines string absent or different',
    )
    report.expect(
      contract.text.includes(`(\`${versionValue}\`)`),
      { fact, file: SOURCES.nodeContract, line },
      `the contract quotes .node-version as (\`${versionValue}\`)`,
      'version string absent or different',
    )
  }
}

// --- fact 2: workspace globs vs the checkout -------------------------------

/** The `packages:` entries of pnpm-workspace.yaml, with their line numbers. */
export function parseWorkspaceGlobs(yamlText) {
  const globs = []
  let inPackages = false
  const lines = yamlText.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^packages:\s*$/.test(line)) {
      inPackages = true
      continue
    }
    if (inPackages) {
      const entry = /^\s+-\s+(.+?)\s*$/.exec(line)
      if (entry !== null) globs.push({ glob: entry[1].replace(/^['"]|['"]$/g, ''), line: i + 1 })
      else if (/^\S/.test(line)) inPackages = false
    }
  }
  return globs
}

/** Minimal glob support: the single-level `<parent>/*` form these workspaces use. */
function globMatchesDir(glob, dir) {
  if (!glob.endsWith('/*')) return glob === dir
  const parent = glob.slice(0, -2)
  return dir.startsWith(`${parent}/`) && !dir.slice(parent.length + 1).includes('/')
}

function checkWorkspacePackages(deps, report) {
  const fact = 'workspace-packages'
  const yamlText = deps.readText(SOURCES.workspace)
  if (yamlText === null) {
    report.expect(
      false,
      { fact, file: SOURCES.workspace, line: 1 },
      'pnpm-workspace.yaml present',
      'file missing',
    )
    return
  }
  const globs = parseWorkspaceGlobs(yamlText)
  report.expect(
    globs.length > 0,
    { fact, file: SOURCES.workspace, line: 1 },
    'a non-empty packages: glob list',
    'no globs',
  )

  const dirs = deps.listPackageDirs()
  for (const dir of dirs) {
    const glob = globs.find((candidate) => globMatchesDir(candidate.glob, dir))
    report.expect(
      glob !== undefined,
      { fact, file: SOURCES.workspace, line: globs[0]?.line ?? 1 },
      `a workspace glob covering ${dir} (has package.json)`,
      `no glob matches ${dir}`,
    )
  }

  for (const { glob, line } of globs) {
    const covered = dirs.filter((dir) => globMatchesDir(glob, dir))
    report.expect(
      covered.length > 0,
      { fact, file: SOURCES.workspace, line },
      `glob ${glob} expands to at least one package directory`,
      'expands to none',
    )
  }

  const names = []
  for (const dir of dirs) {
    const manifest = deps.readText(`${dir}/package.json`)
    let name = null
    try {
      name = JSON.parse(manifest ?? '')?.name ?? null
    } catch {
      name = null
    }
    report.expect(
      typeof name === 'string' && name !== '',
      { fact, file: `${dir}/package.json`, line: 1 },
      'a workspace package name',
      name === null ? 'no name field' : '',
    )
    if (typeof name === 'string') names.push(name)
  }
  for (const name of sortedUnique(names)) {
    const count = names.filter((candidate) => candidate === name).length
    report.expect(
      count === 1,
      { fact, file: SOURCES.workspace, line: 1 },
      `a unique name for every workspace package (${name})`,
      `${count} packages declare ${name}`,
    )
  }
}

// --- fact 3: declared supported formats ------------------------------------

function checkSupportedFormats(deps, report) {
  const fact = 'supported-formats'
  const connectionText = deps.readText(SOURCES.cliConnection)
  const match =
    connectionText === null
      ? null
      : /SUPPORTED_FORMATS\s*=\s*['"`]([^'"`]*)['"`]/.exec(connectionText)
  const declared = match === null ? null : parseFormatList(match[1])
  report.expect(
    declared !== null && declared.length > 0,
    {
      fact,
      file: SOURCES.cliConnection,
      line: lineOfMatch(connectionText ?? '', /SUPPORTED_FORMATS/),
    },
    'SUPPORTED_FORMATS declares the input formats',
    declared === null ? 'constant not found' : 'empty list',
  )
  if (declared === null) return

  const handoffText = deps.readText(SOURCES.handoff)
  if (handoffText === null) {
    report.expect(
      false,
      { fact, file: SOURCES.handoff, line: 1 },
      'handoff.md present',
      'file missing',
    )
  } else {
    const sectionIndex = handoffText.search(/^## 1\. Product and scope\s*$/m)
    const sectionStart = sectionIndex === -1 ? 0 : sectionIndex
    const sectionEnd = handoffText.indexOf('\n## ', sectionIndex + 1)
    const section = handoffText.slice(sectionStart, sectionEnd === -1 ? undefined : sectionEnd)
    const paragraph = findParagraph(section, (body) => body.includes('input formats'))
    const formats =
      paragraph === null ? null : /for (\w+) input formats\s*—\s*\*\*(.+?)\*\*/.exec(paragraph.text)
    const line =
      paragraph === null ? 1 : lineAt(handoffText, sectionStart) + paragraph.startLine - 1
    report.expect(
      formats !== null,
      { fact, file: SOURCES.handoff, line },
      '§1 states "for <n> input formats — **<list>**"',
      paragraph === null ? 'paragraph not found' : 'sentence not in the expected shape',
    )
    if (formats !== null) {
      const listed = parseFormatList(formats[2])
      const declaredCount = NUMBER_WORDS[formats[1].toLowerCase()] ?? Number(formats[1])
      report.expect(
        sameSet(listed, declared),
        { fact, file: SOURCES.handoff, line },
        `§1 formats equal SUPPORTED_FORMATS (${formatSet(declared)})`,
        formatSet(listed),
      )
      report.expect(
        declaredCount === listed.length,
        { fact, file: SOURCES.handoff, line },
        `§1 count matches its list (${listed.length})`,
        String(declaredCount),
      )
      report.expect(
        declaredCount === declared.length,
        { fact, file: SOURCES.handoff, line },
        `§1 count matches SUPPORTED_FORMATS (${declared.length})`,
        String(declaredCount),
      )
    }
  }

  const readmeText = deps.readText(SOURCES.readme)
  if (readmeText === null) {
    report.expect(
      false,
      { fact, file: SOURCES.readme, line: 1 },
      'README.md present',
      'file missing',
    )
  } else {
    const paragraph = findParagraph(readmeText, (body) =>
      body.includes('local-first data workbench'),
    )
    const parenthesis = paragraph === null ? null : /\(([^()]*Parquet[^()]*)\)/.exec(paragraph.text)
    const line = paragraph === null ? 1 : paragraph.startLine
    report.expect(
      parenthesis !== null,
      { fact, file: SOURCES.readme, line },
      'the intro names the supported formats in parentheses',
      paragraph === null ? 'paragraph not found' : 'format parenthesis not found',
    )
    if (parenthesis !== null) {
      const listed = parseFormatList(parenthesis[1])
      report.expect(
        sameSet(listed, declared),
        { fact, file: SOURCES.readme, line },
        `README formats equal SUPPORTED_FORMATS (${formatSet(declared)})`,
        formatSet(listed),
      )
    }
  }
}

// --- fact 4: active queue marker -------------------------------------------

/** Rows of every Markdown table in `text`, classified from their status cell. */
export function parseQueueRows(text) {
  const rows = []
  const lines = text.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (!line.startsWith('|')) continue
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
    if (cells.length < 2) continue
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell) || cell === '')) continue
    const idCell = cells[0].replace(/\*\*/g, '').trim()
    const id = /^([A-Za-z][A-Za-z0-9.]*(?:-[A-Za-z0-9]+)*)/.exec(idCell)?.[1] ?? null
    if (id === null) continue
    // The pickup's tables put the status in different columns (§1: middle,
    // §2: last), so any cell may carry the classification.
    rows.push({
      id,
      line: i + 1,
      closed: cells.some((cell) => /CLOSED/.test(cell)),
      recordedNotSelected: cells.some((cell) => /recorded, not selected/i.test(cell)),
    })
  }
  return rows
}

function boldIds(text) {
  return [...text.matchAll(/\*\*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)\*\*/g)].map((m) => m[1])
}

function checkActiveQueue(deps, report) {
  const fact = 'active-queue'
  const handoffText = deps.readText(SOURCES.handoff)
  const pickupText = deps.readText(SOURCES.pickup)
  if (handoffText === null || pickupText === null) {
    report.expect(
      false,
      { fact, file: handoffText === null ? SOURCES.handoff : SOURCES.pickup, line: 1 },
      'handoff.md and the dated pickup both present',
      'file missing',
    )
    return
  }

  const block = findParagraph(handoffText, (body) =>
    /^\*\*Current state \/ next action \(/.test(body),
  )
  report.expect(
    block !== null,
    { fact, file: SOURCES.handoff, line: 3 },
    'a top "$(Current state / next action)" block',
    'block not found',
  )
  if (block === null) return
  const blockLine = block.startLine

  const rows = parseQueueRows(pickupText)
  const closed = rows.filter((row) => row.closed).map((row) => row.id)
  const expectedRemaining = sortedUnique(
    rows.filter((row) => row.recordedNotSelected).map((row) => row.id),
  )
  // Parser-rot guards: an unparseable pickup must not silently "pass".
  report.expect(
    closed.length > 0,
    { fact, file: SOURCES.pickup, line: 1 },
    'the pickup tables mark at least one row CLOSED',
    'no CLOSED status cell parsed',
  )
  report.expect(
    // Parser-rot guard, queue-drained safe: what must be provable is that the
    // tables PARSED, not that some row is still unselected. A fully drained
    // pickup is a legitimate state (every row CLOSED) and must read as "none"
    // in the handoff clause — the equality assertion below is what catches a
    // lost or invented remaining row.
    rows.length > 0,
    { fact, file: SOURCES.pickup, line: 1 },
    'the pickup tables parse at least one row',
    'none parsed',
  )

  report.expect(
    block.text.includes('No row is selected for dispatch.'),
    { fact, file: SOURCES.handoff, line: blockLine },
    'the block states "No row is selected for dispatch."',
    'sentinel absent',
  )

  const marker = 'Recorded but unselected:'
  const markerIndex = block.text.indexOf(marker)
  report.expect(
    markerIndex !== -1,
    { fact, file: SOURCES.handoff, line: blockLine },
    'the block has a "Recorded but unselected:" clause',
    'clause absent',
  )
  if (markerIndex !== -1) {
    const rest = block.text.slice(markerIndex + marker.length)
    const stop = rest.search(/ — | Human asks/)
    const clause = stop === -1 ? rest : rest.slice(0, stop)
    const named = boldIds(clause)
    report.expect(
      sameSet(named, expectedRemaining),
      { fact, file: SOURCES.handoff, line: blockLine },
      `the unselected clause names exactly ${expectedRemaining.length === 0 ? 'none' : formatSet(expectedRemaining)} (pickup "recorded, not selected")`,
      named.length === 0 ? 'none named' : formatSet(named),
    )
  }

  const nextMatch = /\bnext(?:\s+row)?\b[^.!?]{0,60}?\*\*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)\*\*/i.exec(
    block.text,
  )
  report.expect(
    nextMatch === null || !closed.includes(nextMatch[1]),
    { fact, file: SOURCES.handoff, line: blockLine },
    'the block names no CLOSED row as the next action',
    nextMatch === null ? '' : `${nextMatch[1]} is CLOSED in the pickup`,
  )
}

// --- fact 5: engine-duckdb package allowlist -------------------------------

function checkPackageAllowlist(deps, report) {
  const fact = 'package-allowlist'
  const pkgText = deps.readText(SOURCES.enginePackage)
  let files = []
  if (pkgText === null) {
    report.expect(
      false,
      { fact, file: SOURCES.enginePackage, line: 1 },
      'package.json present',
      'file missing',
    )
    return
  }
  try {
    const parsed = JSON.parse(pkgText)
    files = Array.isArray(parsed?.files) ? parsed.files : []
  } catch {
    report.expect(
      false,
      { fact, file: SOURCES.enginePackage, line: 1 },
      'valid JSON',
      'unparseable',
    )
    return
  }
  report.expect(
    files.length > 0,
    { fact, file: SOURCES.enginePackage, line: lineOfMatch(pkgText, /"files"/) },
    'a non-empty files allowlist',
    'no files entries',
  )

  const readmeText = deps.readText(SOURCES.engineReadme)
  if (readmeText === null) {
    report.expect(
      false,
      { fact, file: SOURCES.engineReadme, line: 1 },
      'README present',
      'file missing',
    )
    return
  }
  const paragraph = findParagraph(
    readmeText,
    (body) => body.includes('files') && body.includes('dist/pipeline-runner'),
  )
  report.expect(
    paragraph !== null,
    { fact, file: SOURCES.engineReadme, line: 1 },
    'the README describes the recursive pipeline-runner allowlist',
    'paragraph not found',
  )
  if (paragraph === null) return
  const line = paragraph.startLine

  report.expect(
    paragraph.text.includes('recursive `dist/pipeline-runner/**`'),
    { fact, file: SOURCES.engineReadme, line },
    'the README claims recursive `dist/pipeline-runner/**` globs',
    'claim absent',
  )
  report.expect(
    !/flat only|top-level only|only flat/i.test(paragraph.text),
    { fact, file: SOURCES.engineReadme, line },
    'the README does not claim a flat-only allowlist',
    'README says the allowlist is flat/top-level only',
  )

  const required = [
    'dist/pipeline-runner/**/*.js',
    'dist/pipeline-runner/**/*.js.map',
    'dist/pipeline-runner/**/*.d.ts',
    'dist/pipeline-runner/**/*.d.ts.map',
  ]
  const missing = required.filter((glob) => !files.includes(glob))
  report.expect(
    missing.length === 0,
    { fact, file: SOURCES.enginePackage, line: lineOfMatch(pkgText, /"files"/) },
    `files carries the four recursive pipeline-runner globs (${required.join(', ')})`,
    missing.length === 0 ? '' : `missing ${missing.join(', ')}`,
  )
}

// --- fact 6: product Node floor -------------------------------------------

/** The shipped surfaces that must always declare their Node floor. */
const REQUIRED_NODE_FLOOR_MANIFESTS = ['apps/cli', 'apps/web', 'apps/vscode']

/**
 * The product Node floor is the development line, not a second unexercised
 * claim (C4, 2026-11-21). Root `engines.node` is the source of truth; a manifest
 * that drifts (for example back to `>=22`) or a shipped surface that silently
 * drops the field is drift the handoff's current state would otherwise hide.
 */
function checkProductNodeFloor(deps, report) {
  const fact = 'product-node-floor'
  const rootText = deps.readText(SOURCES.rootPackage)
  let rootEngine = null
  if (rootText !== null) {
    try {
      const parsed = JSON.parse(rootText)
      rootEngine = typeof parsed?.engines?.node === 'string' ? parsed.engines.node : null
    } catch {
      rootEngine = null
    }
  }
  report.expect(
    rootEngine !== null,
    { fact, file: SOURCES.rootPackage, line: 1 },
    'root engines.node is the floor source of truth',
    'missing or unparseable',
  )
  if (rootEngine === null) return

  const dirs = deps.listPackageDirs()
  const declared = []
  for (const dir of dirs) {
    const rel = `${dir}/package.json`
    const text = deps.readText(rel)
    if (text === null) continue
    let engine = null
    try {
      const parsed = JSON.parse(text)
      engine = typeof parsed?.engines?.node === 'string' ? parsed.engines.node : null
    } catch {
      report.expect(false, { fact, file: rel, line: 1 }, 'valid JSON', 'unparseable')
      continue
    }
    if (engine === null) continue
    declared.push(dir)
    report.expect(
      engine === rootEngine,
      { fact, file: rel, line: lineOfMatch(text, /"node"/) },
      `engines.node equals the root floor ${JSON.stringify(rootEngine)}`,
      `declares ${JSON.stringify(engine)}`,
    )
  }

  for (const dir of REQUIRED_NODE_FLOOR_MANIFESTS) {
    report.expect(
      declared.includes(dir),
      { fact, file: `${dir}/package.json`, line: 1 },
      'a shipped surface declares engines.node',
      dirs.includes(dir) && !declared.includes(dir) ? 'declares none' : 'manifest missing',
    )
  }
}

// --- driver ----------------------------------------------------------------

/**
 * Run every registered fact over `deps` (see `createRepoDeps`).
 * Returns `{ findings, assertions, facts }`; no filesystem writes, no network.
 */
export function checkCurrentState(deps = createRepoDeps()) {
  const report = makeReporter()
  for (const check of [
    checkDevNodePolicy,
    checkWorkspacePackages,
    checkSupportedFormats,
    checkActiveQueue,
    checkPackageAllowlist,
    checkProductNodeFloor,
  ]) {
    check(deps, report)
  }
  return { findings: report.findings, assertions: report.assertions, facts: FACT_IDS }
}

/** One finding per line: `file:line: [fact] expected … — actual …`. */
export function formatFindings(findings) {
  return findings
    .map(
      (finding) =>
        `${finding.file}:${finding.line}: [${finding.fact}] expected ${finding.expected} — actual ${finding.actual}`,
    )
    .join('\n')
}

export function main(deps = createRepoDeps(), stdout = process.stdout) {
  const { findings, assertions, facts } = checkCurrentState(deps)
  if (findings.length === 0) {
    stdout.write(
      `current-state:check — OK (${assertions} assertions across ${facts.length} facts)\n`,
    )
    return 0
  }
  stdout.write(`${formatFindings(findings)}\n`)
  const factNames = sortedUnique(findings.map((finding) => finding.fact))
  stdout.write(
    `current-state:check — FAIL: ${findings.length} drift finding(s) in ${factNames.join(', ')}\n`,
  )
  return 1
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  process.exitCode = main()
}
