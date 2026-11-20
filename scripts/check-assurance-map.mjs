#!/usr/bin/env node
/**
 * check-assurance-map.mjs — a bounded, offline consistency check for
 * `docs/engineering/11-assurance-coverage-map.md` (improvement-plan row E03).
 *
 * What this proves (and nothing more):
 * 1. `map-exists` — the map document exists and carries its contract table
 *    header (`| Contract |`), so a renamed/emptied map fails loudly.
 * 2. `assertion-paths-exist` — every repo-relative path written in backticks in
 *    the map (`apps/…|packages/…|tests/…|scripts/…|docs/…|fixtures/…` + a file
 *    extension, plus the three root files below) resolves on disk.
 * 3. `runner-classified` — every *test* file the map names is included by a
 *    runner this checker can see: a Vitest project's `include` (minus that same
 *    project's `exclude`), a Playwright config's `testDir`/`testMatch`, or a
 *    declared extension-host runner. A test file that no runner sweeps fails.
 * 4. `runner-scripts-exist` — each declared runner's required file exists and
 *    the root `package.json` declares the runner commands the map quotes.
 *
 * Deliberately NOT covered (do not widen this claim without implementing it):
 *   - semantic freshness: that a named assertion still asserts the contract, or
 *     that a describe/it title is still accurate. Not checked at all;
 *   - the map's subject type, environment or command cells;
 *   - coverage numbers, dates, SHAs, counts ("277 files", "89.71%") — there is
 *     no machine-readable source for them;
 *   - which assertions run in which *process* (a Vitest project that skips a
 *     file at runtime still classifies it here), test duration or flakiness.
 *
 * Inputs (the map and the configs) are read as TEXT/JSON DATA ONLY — nothing is
 * imported, evaluated or executed. Zero dependencies, deterministic, offline.
 * Normal mode writes nothing; it prints findings and sets the exit code
 * (0 clean, 1 drift). Run `pnpm assurance-map:check`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const scriptDir = dirname(fileURLToPath(import.meta.url))
export const defaultRepoRoot = resolve(scriptDir, '..')

/** The map this checker is about. Repo-relative. */
export const MAP_PATH = 'docs/engineering/11-assurance-coverage-map.md'

/** Root-level files the map may quote as paths (no directory prefix). */
const ROOT_PATHS = ['vitest.config.ts', 'playwright.config.ts', 'package.json']

/** Files whose presence makes a declared runner real. */
export const VITEST_CONFIG = 'vitest.config.ts'
export const PLAYWRIGHT_CONFIGS = ['playwright.config.ts']
export const VISUAL_CONFIGS = [
  'tests/visual/playwright.panel-recovery.config.ts',
  'tests/visual/playwright.telemetry.config.ts',
]

/**
 * Runners that are not described by a Vitest/Playwright config. Each entry is a
 * promise this checker can verify: the pattern classifies test files, and
 * `requires` names a file that must exist (the runner script or manifest the
 * map's command uses).
 */
export const EXTENSION_HOST_RUNNERS = [
  {
    id: 'vscode-extension-host',
    pattern: 'apps/vscode/test/e2e/**/*.ts',
    requires: ['apps/vscode/scripts/run-e2e.mjs'],
  },
  {
    id: 'vscode-node-test',
    pattern: 'apps/vscode/test/*.test.mjs',
    requires: ['apps/vscode/package.json'],
  },
]

/** Root scripts the map's runner matrix quotes; each must be declared. */
export const REQUIRED_ROOT_SCRIPTS = ['test', 'test:coverage', 'test:e2e', 'assurance-map:check']

export const FACT_IDS = [
  'map-exists',
  'assertion-paths-exist',
  'runner-classified',
  'runner-scripts-exist',
]

/** Real-repository deps: read a repo-relative file, and test a path's existence. */
export function createRepoDeps(root = defaultRepoRoot) {
  const full = (p) => join(root, p)
  return {
    root,
    exists: (p) => existsSync(full(p)),
    readText: (p) => {
      try {
        return readFileSync(full(p), 'utf8')
      } catch {
        return null
      }
    },
  }
}

/** 1-based line number of the first occurrence of `needle`, or 1. */
function lineOf(text, needle) {
  const index = text.indexOf(needle)
  if (index < 0) return 1
  let line = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/** Expand `{a,b}` alternatives into plain patterns (one level, as used here). */
export function expandBraces(pattern) {
  const match = /\{([^{}]*)\}/.exec(pattern)
  if (match === null) return [pattern]
  const head = pattern.slice(0, match.index)
  const tail = pattern.slice(match.index + match[0].length)
  const parts = match[1].split(',')
  const out = []
  for (const part of parts) out.push(...expandBraces(head + part + tail))
  return out
}

/**
 * Compile one glob to a RegExp. Supports `**` (any depth, including zero),
 * `*` (within a segment), `?` (one character) and `{a,b}` alternatives. Every
 * other character is literal.
 */
export function globToRegExp(pattern) {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        i++
        if (pattern[i + 1] === '/') {
          i++
          out += '(?:[^/]+/)*'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`)
}

/** True when `path` matches any of the (brace-expanded) glob patterns. */
export function matchesAny(patterns, path) {
  for (const pattern of patterns) {
    for (const expanded of expandBraces(pattern)) {
      if (globToRegExp(expanded).test(path)) return true
    }
  }
  return false
}

/** Quoted string literals inside a bracket body (glob arrays contain no `]`). */
function quotedLiterals(body) {
  const out = []
  const re = /'([^']*)'|"([^"]*)"/g
  let match
  while ((match = re.exec(body)) !== null) out.push(match[1] ?? match[2])
  return out
}

/**
 * Drop comments before quoting is parsed: a prose apostrophe in a comment
 * ("the repo's tooling scripts") would otherwise pair with a real literal quote
 * and silently swallow the rest of an `include` array. Two guards keep this
 * from eating glob syntax instead: a block comment must START in a code
 * position (`/*` after whitespace, `(`, `,`, `;` or `=` — never after a path
 * character, so `src/**\/*.test.ts` is left alone), and `//` directly after a
 * colon is kept so an `http://` URL in a string survives.
 */
export function stripComments(text) {
  return text.replace(/(^|[\s(,;=])\/\*[\s\S]*?\*\//g, '$1 ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** The literal array of `key: [...]` inside `chunk` (non-literal entries ignored). */
function literalArray(chunk, key) {
  const re = new RegExp(`(?:^|[\\s,{])${key}:\\s*\\[`, 'g')
  const match = re.exec(chunk)
  if (match === null) return []
  const start = chunk.indexOf('[', match.index)
  const end = chunk.indexOf(']', start)
  if (start < 0 || end < 0) return []
  return quotedLiterals(chunk.slice(start + 1, end))
}

/**
 * Vitest projects as declared in `vitest.config.ts`: each `name: '<id>'` mark
 * opens a chunk whose `include` / `exclude` literal arrays belong to it. The
 * coverage-level `include` (before the first project) is deliberately ignored.
 */
export function parseVitestProjects(text) {
  const source = stripComments(text)
  const marks = []
  const re = /name:\s*'([^']+)'/g
  let match
  while ((match = re.exec(source)) !== null) marks.push({ name: match[1], index: match.index })
  const projects = []
  for (let i = 0; i < marks.length; i++) {
    const chunk = source.slice(
      marks[i].index,
      i + 1 < marks.length ? marks[i + 1].index : source.length,
    )
    projects.push({
      name: marks[i].name,
      include: literalArray(chunk, 'include'),
      exclude: literalArray(chunk, 'exclude'),
    })
  }
  return projects
}

/** One Playwright config: its resolved testDir and its testMatch list. */
export function parsePlaywrightConfig(configPath, text) {
  const source = stripComments(text)
  const testDir = /testDir:\s*'([^']+)'/.exec(source)?.[1] ?? '.'
  const match = /testMatch:\s*('([^']*)'|\[([^\]]*)\])/.exec(source)
  const testMatch =
    match === null
      ? ['**/*.spec.ts']
      : match[2] !== undefined
        ? [match[2]]
        : quotedLiterals(match[3] ?? '')
  return { configPath, testDir: join(dirname(configPath), testDir), testMatch }
}

/** Every backticked repo-relative file path in the map, first-seen order. */
export function extractPaths(mapText) {
  const out = []
  const re = /`([^`\n]+)`/g
  let match
  while ((match = re.exec(mapText)) !== null) {
    const candidate = match[1].trim()
    if (ROOT_PATHS.includes(candidate)) {
      if (!out.includes(candidate)) out.push(candidate)
      continue
    }
    if (!/^(?:apps|packages|tests|scripts|docs|fixtures)\/[A-Za-z0-9._/-]+$/.test(candidate))
      continue
    if (!/\.(?:ts|tsx|mjs|md|json)$/.test(candidate)) continue
    if (!out.includes(candidate)) out.push(candidate)
  }
  return out
}

/** Test/spec files a runner is expected to sweep. */
export function isTestFile(path) {
  return /\.(?:test|spec)\.(?:ts|tsx|mjs)$/.test(path)
}

/**
 * Check the map against the repository. Returns findings (each with a `fact`,
 * a message and a map line where one is derivable) plus the counts that make
 * the check's coverage explicit.
 */
export function checkAssuranceMap(deps = createRepoDeps()) {
  const findings = []
  const add = (fact, message, path) => findings.push({ fact, message, path })
  const counts = { paths: 0, testFiles: 0, classified: 0, runners: 0 }

  const mapText = deps.readText(MAP_PATH)
  if (mapText === null) {
    add('map-exists', `${MAP_PATH} is missing`, MAP_PATH)
    return { findings, counts, assertions: 0, facts: FACT_IDS }
  }
  if (!/^\| Contract \|/m.test(mapText)) {
    add('map-exists', `${MAP_PATH} does not carry the "| Contract |" table header`, MAP_PATH)
  }

  // --- 2. every named path exists -------------------------------------------
  const paths = extractPaths(mapText)
  counts.paths = paths.length
  for (const path of paths) {
    if (!deps.exists(path)) {
      add(
        'assertion-paths-exist',
        `${path} is named in the map but does not exist (${MAP_PATH}:${String(lineOf(mapText, `\`${path}\``))})`,
        path,
      )
    }
  }

  // --- 3. runner classification (tests only) --------------------------------
  const vitestText = deps.readText(VITEST_CONFIG)
  if (vitestText === null) {
    add('runner-classified', `${VITEST_CONFIG} is missing, so no Vitest project can be read`)
  }
  const projects = vitestText === null ? [] : parseVitestProjects(vitestText)
  if (vitestText !== null && projects.length === 0) {
    add('runner-classified', `${VITEST_CONFIG} declares no named Vitest projects`)
  }
  counts.runners = projects.length

  const playwright = []
  for (const configPath of [...PLAYWRIGHT_CONFIGS, ...VISUAL_CONFIGS]) {
    const text = deps.readText(configPath)
    if (text === null) {
      add('runner-classified', `${configPath} is missing, so its test discovery cannot be read`)
      continue
    }
    playwright.push(parsePlaywrightConfig(configPath, text))
    counts.runners++
  }

  const testFiles = paths.filter(isTestFile)
  counts.testFiles = testFiles.length
  for (const path of testFiles) {
    const project = projects.find(
      (candidate) => matchesAny(candidate.include, path) && !matchesAny(candidate.exclude, path),
    )
    if (project !== undefined) {
      counts.classified++
      continue
    }
    const config = playwright.find(
      (candidate) =>
        matchesAny([`${candidate.testDir}/**`], path) && matchesAny(candidate.testMatch, path),
    )
    if (config !== undefined) {
      counts.classified++
      continue
    }
    const host = EXTENSION_HOST_RUNNERS.find((candidate) => matchesAny([candidate.pattern], path))
    if (host !== undefined) {
      counts.classified++
      continue
    }
    add(
      'runner-classified',
      `${path} is named in the map but no Vitest project, Playwright config or declared extension-host runner includes it`,
      path,
    )
  }

  // --- 4. runner files and root scripts -------------------------------------
  for (const configPath of [...PLAYWRIGHT_CONFIGS, ...VISUAL_CONFIGS]) {
    if (!deps.exists(configPath)) add('runner-scripts-exist', `${configPath} is missing`)
  }
  for (const runner of EXTENSION_HOST_RUNNERS) {
    for (const required of runner.requires) {
      if (!deps.exists(required)) {
        add(
          'runner-scripts-exist',
          `extension-host runner "${runner.id}" requires ${required}, which is missing`,
          required,
        )
      }
    }
  }
  const packageText = deps.readText('package.json')
  let rootScripts = {}
  try {
    rootScripts = packageText === null ? {} : (JSON.parse(packageText)?.scripts ?? {})
  } catch {
    add('runner-scripts-exist', 'package.json is not valid JSON, so its scripts cannot be read')
  }
  for (const script of REQUIRED_ROOT_SCRIPTS) {
    if (!Object.hasOwn(rootScripts, script)) {
      add('runner-scripts-exist', `root package.json does not declare the "${script}" script`)
    }
  }

  return { findings, counts, assertions: FACT_IDS.length, facts: FACT_IDS }
}

/** Render findings as `map:line: [fact] message` (stable, value-free). */
export function formatFindings(findings, mapText) {
  return findings.map((finding) => {
    const line = mapText === null ? 1 : lineOf(mapText, finding.path ?? finding.message)
    return `${MAP_PATH}:${String(line)}: [${finding.fact}] ${finding.message}`
  })
}

function main() {
  const out = (line) => process.stdout.write(`${line}\n`)
  const deps = createRepoDeps()
  const { findings, counts, facts, assertions } = checkAssuranceMap(deps)
  if (findings.length === 0) {
    out(
      `assurance-map: ok — ${String(counts.paths)} named paths (${String(counts.testFiles)} test files, ` +
        `${String(counts.classified)} classified by ${String(counts.runners)} config-declared runners + ` +
        `${String(EXTENSION_HOST_RUNNERS.length)} declared host runners), ${String(facts.length)} facts.`,
    )
    out(
      `assurance-map: semantics NOT checked — this proves the map's paths resolve and its test files are swept, not that they assert the contract.`,
    )
    return 0
  }
  const mapText = deps.readText(MAP_PATH)
  for (const line of formatFindings(findings, mapText)) out(line)
  out(`assurance-map: ${String(findings.length)} finding(s) across ${String(assertions)} facts.`)
  return 1
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) process.exitCode = main()
