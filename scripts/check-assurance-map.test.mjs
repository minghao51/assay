// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Tests for `scripts/check-assurance-map.mjs` (E03).
 *
 * Regression-first in the `check-current-state.test.mjs` style: every mutation
 * is applied to the REAL repository text held in memory (no temp directories,
 * no writes), and the checker must fail with a finding for that mutation. The
 * baseline case is the drift alarm itself: the committed map, the committed
 * runner configs and the committed root scripts must agree, and the parsed
 * Vitest project names are pinned by name so a config restructure fails loudly
 * instead of silently classifying nothing.
 *
 * What is NOT asserted here: that any named assertion still asserts its
 * contract. The checker cannot see that, and this file must not imply it can.
 */
import { describe, expect, it } from 'vitest'
import {
  EXTENSION_HOST_RUNNERS,
  FACT_IDS,
  MAP_PATH,
  REQUIRED_ROOT_SCRIPTS,
  VISUAL_CONFIGS,
  VITEST_CONFIG,
  checkAssuranceMap,
  createRepoDeps,
  expandBraces,
  extractPaths,
  globToRegExp,
  isTestFile,
  matchesAny,
  parsePlaywrightConfig,
  parseVitestProjects,
} from './check-assurance-map.mjs'

const repo = createRepoDeps()

/** Deps over the real repo with per-file text overrides and simulated absences. */
function depsWith({ files = {}, missing = [] } = {}) {
  return {
    exists: (path) => !missing.includes(path) && (repo.exists(path) || Object.hasOwn(files, path)),
    readText: (path) => {
      if (missing.includes(path)) return null
      return Object.hasOwn(files, path) ? files[path] : repo.readText(path)
    },
  }
}

/** Read a real file and apply one literal replacement, asserting it applied. */
function mutated(path, from, to) {
  const base = repo.readText(path)
  expect(base, `${path} must be readable`).not.toBeNull()
  expect(base.includes(from), `${path} must contain ${JSON.stringify(from)}`).toBe(true)
  return base.split(from).join(to)
}

function findingsFor(result, fact) {
  return result.findings.filter((finding) => finding.fact === fact)
}

/** The map text with one extra paragraph appended (an injected claim). */
function mapWith(extra) {
  return `${repo.readText(MAP_PATH)}\n${extra}\n`
}

describe('assurance-map checker — baseline', () => {
  const result = checkAssuranceMap(repo)

  it('passes on the unmutated repository and reports its bounded coverage', () => {
    expect(result.findings).toEqual([])
    expect(result.facts).toEqual(FACT_IDS)
    expect(result.assertions).toBe(FACT_IDS.length)
    // The map names a bounded set of paths, and every test file it names is
    // classified by a runner — the number that would otherwise hide a drift.
    expect(result.counts.paths).toBeGreaterThan(20)
    expect(result.counts.testFiles).toBeGreaterThan(10)
    expect(result.counts.classified).toBe(result.counts.testFiles)
  })

  it('reads the committed Vitest projects and Playwright configs by name', () => {
    const projects = parseVitestProjects(repo.readText(VITEST_CONFIG) ?? '')
    expect(projects.map((project) => project.name)).toEqual([
      'web',
      'node',
      'vscode-webview',
      'cli-integration',
    ])
    // The cli-integration project is the only one that sweeps the integration
    // files: the node project excludes them, so the exclusion must be parsed.
    const integration = 'apps/cli/src/dcr.integration.test.ts'
    const node = projects.find((project) => project.name === 'node')
    expect(node === undefined ? null : matchesAny(node.include, integration)).toBe(true)
    expect(node === undefined ? null : matchesAny(node.exclude, integration)).toBe(true)

    const root = parsePlaywrightConfig(
      'playwright.config.ts',
      repo.readText('playwright.config.ts') ?? '',
    )
    expect(root.testDir).toBe('tests/e2e')
    expect(root.testMatch).toEqual(['**/*.spec.ts'])
    for (const configPath of VISUAL_CONFIGS) {
      expect(repo.exists(configPath), `${configPath} must exist`).toBe(true)
    }
  })
})

describe('assurance-map checker — glob matching', () => {
  it('matches `**` including zero directory depth, and expands brace alternatives', () => {
    expect(matchesAny(['scripts/**/*.test.mjs'], 'scripts/check-assurance-map.test.mjs')).toBe(true)
    expect(
      matchesAny(['packages/*/src/**/*.test.ts'], 'packages/grid/src/viewport-model.test.ts'),
    ).toBe(true)
    expect(matchesAny(['packages/*/src/**/*.test.ts'], 'packages/grid/src/deep/x.test.ts')).toBe(
      true,
    )
    expect(matchesAny(['apps/*/src/**/*.test.{ts,tsx}'], 'apps/web/src/App.replace.test.tsx')).toBe(
      true,
    )
    expect(matchesAny(['apps/*/src/**/*.test.{ts,tsx}'], 'apps/web/src/App.replace.tsx')).toBe(
      false,
    )
    expect(expandBraces('a/{b,c}/d.{ts,tsx}')).toEqual([
      'a/b/d.ts',
      'a/b/d.tsx',
      'a/c/d.ts',
      'a/c/d.tsx',
    ])
    expect(globToRegExp('a/?.ts').test('a/b.ts')).toBe(true)
    expect(globToRegExp('a/?.ts').test('a/bc.ts')).toBe(false)
    expect(matchesAny(['apps/web/src/**/*.test.tsx'], 'apps/cli/src/x.test.tsx')).toBe(false)
  })

  it('extracts only backticked repo-relative file paths, never commands', () => {
    const text =
      '`packages/grid/src/viewport-model.test.ts` `pnpm test:coverage` `DUCKDB=/tmp/duckdb` ' +
      '`vitest.config.ts` `docs/engineering/11-assurance-coverage-map.md` `not/a/path` `apps/web`'
    expect(extractPaths(text)).toEqual([
      'packages/grid/src/viewport-model.test.ts',
      'vitest.config.ts',
      'docs/engineering/11-assurance-coverage-map.md',
    ])
    expect(isTestFile('apps/web/src/App.test.tsx')).toBe(true)
    expect(isTestFile('apps/web/src/App.spec.ts')).toBe(true)
    expect(isTestFile('apps/web/src/App.tsx')).toBe(false)
  })
})

describe('assurance-map checker — the map itself must be present and table-shaped', () => {
  it('reports a missing map', () => {
    const result = checkAssuranceMap(depsWith({ missing: [MAP_PATH] }))
    expect(findingsFor(result, 'map-exists')).toHaveLength(1)
  })

  it('reports a map whose contract table header is gone', () => {
    const result = checkAssuranceMap(
      depsWith({ files: { [MAP_PATH]: '# Assurance map\n\nNo table any more.\n' } }),
    )
    expect(findingsFor(result, 'map-exists')).toHaveLength(1)
  })
})

describe('assurance-map checker — every named path must exist', () => {
  it('fails a named assertion file that is not on disk', () => {
    const path = 'packages/grid/src/viewport-model.test.ts'
    expect(repo.readText(MAP_PATH)?.includes(`\`${path}\``)).toBe(true)
    const result = checkAssuranceMap(depsWith({ missing: [path] }))
    const findings = findingsFor(result, 'assertion-paths-exist')
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain(path)
  })

  it('fails a newly added map path that does not resolve', () => {
    const result = checkAssuranceMap(
      depsWith({
        files: { [MAP_PATH]: mapWith('A new claim: `packages/grid/src/invented.test.ts`.') },
      }),
    )
    expect(findingsFor(result, 'assertion-paths-exist').map((f) => f.path)).toEqual([
      'packages/grid/src/invented.test.ts',
    ])
  })
})

describe('assurance-map checker — every named test file must be swept by a runner', () => {
  it('fails when the node project stops including the tooling scripts', () => {
    const vitest = mutated(VITEST_CONFIG, "'scripts/**/*.test.mjs',", '')
    const result = checkAssuranceMap(depsWith({ files: { [VITEST_CONFIG]: vitest } }))
    expect(findingsFor(result, 'runner-classified').map((f) => f.path)).toEqual([
      'scripts/check-assurance-map.test.mjs',
    ])
  })

  it('fails when a Vitest project include is renamed away from the web tests', () => {
    const vitest = mutated(
      VITEST_CONFIG,
      "'apps/web/src/**/*.test.{ts,tsx}'",
      "'apps/web/src/**/*.unit.tsx'",
    )
    const result = checkAssuranceMap(depsWith({ files: { [VITEST_CONFIG]: vitest } }))
    const paths = findingsFor(result, 'runner-classified').map((f) => f.path)
    expect(paths).toContain('apps/web/src/App.replace.test.tsx')
    expect(paths.length).toBeGreaterThan(10)
  })

  it('fails when a config declares no named project at all', () => {
    const result = checkAssuranceMap(depsWith({ files: { [VITEST_CONFIG]: 'export default {}' } }))
    expect(findingsFor(result, 'runner-classified')[0]?.message).toContain(
      'declares no named Vitest projects',
    )
  })

  it('fails when the Playwright config stops sweeping tests/e2e', () => {
    const config = mutated(
      'playwright.config.ts',
      "testDir: './tests/e2e'",
      "testDir: './tests/elsewhere'",
    )
    const result = checkAssuranceMap(depsWith({ files: { 'playwright.config.ts': config } }))
    const paths = findingsFor(result, 'runner-classified').map((f) => f.path)
    expect(paths).toContain('tests/e2e/engine-conformance.spec.ts')
  })

  it('fails when a visual Playwright config is missing', () => {
    const result = checkAssuranceMap(depsWith({ missing: [VISUAL_CONFIGS[0]] }))
    const messages = findingsFor(result, 'runner-classified').map((f) => f.message)
    expect(messages).toContain(
      `${VISUAL_CONFIGS[0]} is missing, so its test discovery cannot be read`,
    )
    // The spec that config was the only home for is left unclassified too.
    expect(messages).toContain(
      'tests/visual/panel-recovery.spec.ts is named in the map but no Vitest project, Playwright config or declared extension-host runner includes it',
    )
  })

  it('classifies the declared extension-host test files', () => {
    const declared = EXTENSION_HOST_RUNNERS.map((runner) => runner.pattern)
    expect(matchesAny(declared, 'apps/vscode/test/e2e/dataset-runner.ts')).toBe(true)
    expect(matchesAny(declared, 'apps/vscode/test/vscode-runtime.test.mjs')).toBe(true)
  })
})

describe('assurance-map checker — runner files and root scripts', () => {
  it('fails when an extension-host runner script is gone', () => {
    const script = EXTENSION_HOST_RUNNERS[0].requires[0]
    const result = checkAssuranceMap(depsWith({ missing: [script] }))
    const findings = findingsFor(result, 'runner-scripts-exist')
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain(script)
  })

  it('fails when a root runner script the map quotes is not declared', () => {
    const pkg = repo.readText('package.json') ?? ''
    const without = JSON.parse(pkg)
    delete without.scripts['test:e2e']
    const result = checkAssuranceMap(
      depsWith({ files: { 'package.json': JSON.stringify(without, null, 2) } }),
    )
    expect(findingsFor(result, 'runner-scripts-exist').map((f) => f.message)).toEqual([
      `root package.json does not declare the "test:e2e" script`,
    ])
    expect(REQUIRED_ROOT_SCRIPTS).toContain('assurance-map:check')
  })

  it('fails loudly on an unparseable root manifest', () => {
    const result = checkAssuranceMap(depsWith({ files: { 'package.json': '{ not json' } }))
    expect(findingsFor(result, 'runner-scripts-exist').length).toBe(
      1 + REQUIRED_ROOT_SCRIPTS.length,
    )
  })
})
