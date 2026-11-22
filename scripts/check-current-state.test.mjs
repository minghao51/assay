// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Tests for `scripts/check-current-state.mjs` (A02).
 *
 * Regression-first: every mutation below is applied to a COPY of the real
 * repository files held in memory (no temp directories, no writes), and the
 * checker must FAIL with a located finding for the mutated fact. The baseline
 * case proves the unmutated repository passes. The last group proves the
 * checker is scoped: adding a closed historical narrative to the handoff does
 * not trip it.
 */
import { describe, expect, it } from 'vitest'
import { createRepoDeps, checkCurrentState, SOURCES } from './check-current-state.mjs'

const repo = createRepoDeps()
const packageDirs = repo.listPackageDirs()

/** deps over the real repo with per-file text overrides. */
function depsWith(overrides = {}, dirs = packageDirs) {
  return {
    readText: (relPath) =>
      Object.hasOwn(overrides, relPath) ? overrides[relPath] : repo.readText(relPath),
    listPackageDirs: () => dirs,
  }
}

/** Read a real file and apply one literal replacement, asserting it applied. */
function mutated(relPath, from, to) {
  const base = repo.readText(relPath)
  expect(base, `${relPath} must be readable`).not.toBeNull()
  expect(base.includes(from), `${relPath} must contain ${JSON.stringify(from)}`).toBe(true)
  return base.split(from).join(to)
}

function findingsFor(deps, fact) {
  return checkCurrentState(deps).findings.filter((finding) => finding.fact === fact)
}

describe('current-state checker — baseline', () => {
  it('passes on the unmutated repository and reports bounded coverage', () => {
    const { findings, assertions, facts } = checkCurrentState(repo)
    expect(findings).toEqual([])
    expect(facts).toEqual([
      'dev-node-policy',
      'workspace-packages',
      'supported-formats',
      'active-queue',
      'package-allowlist',
    ])
    expect(assertions).toBeGreaterThan(50)
  })
})

describe('current-state checker — dev-node-policy mutations', () => {
  it('fails when root engines.node leaves the .node-version major', () => {
    const findings = findingsFor(
      depsWith({ [SOURCES.rootPackage]: mutated(SOURCES.rootPackage, '^24.0.0', '^22.0.0') }),
      'dev-node-policy',
    )
    const engineFinding = findings.find(
      (finding) => finding.expected === 'engines.node major equals .node-version (24)',
    )
    expect(engineFinding).toMatchObject({
      file: SOURCES.rootPackage,
      actual: 'engines.node ^22.0.0',
    })
    expect(engineFinding.line).toBeGreaterThan(1)
    // The docs still quote ^24.0.0, so the same mutation is visible there too.
    expect(findings.map((finding) => finding.file)).toContain(SOURCES.agents)
  })

  it('fails when .node-version no longer matches the engines major', () => {
    const findings = findingsFor(depsWith({ [SOURCES.nodeVersionFile]: '22\n' }), 'dev-node-policy')
    expect(findings.map((finding) => finding.expected)).toContain(
      'engines.node major equals .node-version (22)',
    )
  })

  it('fails when AGENTS.md stops claiming the selected Node line', () => {
    const findings = findingsFor(
      depsWith({ [SOURCES.agents]: mutated(SOURCES.agents, 'Node 24', 'Node 22') }),
      'dev-node-policy',
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      file: SOURCES.agents,
      expected: 'the paragraph claims "Node 24"',
    })
    expect(findings[0].line).toBeGreaterThan(1)
  })

  it('fails when the node support contract quotes a different engines string', () => {
    const findings = findingsFor(
      depsWith({ [SOURCES.nodeContract]: mutated(SOURCES.nodeContract, '`^24.0.0`', '`^22.0.0`') }),
      'dev-node-policy',
    )
    expect(findings).toHaveLength(1)
    expect(findings[0].file).toBe(SOURCES.nodeContract)
  })
})

describe('current-state checker — workspace-packages mutations', () => {
  it('fails when a package directory has no matching workspace glob', () => {
    const findings = findingsFor(
      depsWith({}, [...packageDirs, 'tools/not-listed']),
      'workspace-packages',
    )
    expect(findings.map((finding) => finding.expected)).toContain(
      'a workspace glob covering tools/not-listed (has package.json)',
    )
    expect(findings[0]).toMatchObject({ file: SOURCES.workspace })
    expect(findings[0].line).toBeGreaterThan(1)
  })

  it('fails when a glob expands to no package directory', () => {
    const findings = findingsFor(
      depsWith({ [SOURCES.workspace]: mutated(SOURCES.workspace, '  - packages/*', '  - libs/*') }),
      'workspace-packages',
    )
    expect(findings.map((finding) => finding.expected)).toContain(
      'glob libs/* expands to at least one package directory',
    )
    // …and every real packages/ directory is now uncovered (apps/* still covers apps/).
    const uncovered = findings.filter((finding) =>
      finding.expected.startsWith('a workspace glob covering'),
    )
    expect(uncovered).toHaveLength(packageDirs.filter((dir) => dir.startsWith('packages/')).length)
  })

  it('fails when two workspace packages declare the same name', () => {
    const first = packageDirs[0]
    const second = packageDirs[packageDirs.length - 1]
    const name = JSON.parse(repo.readText(`${first}/package.json`)).name
    const secondText = repo.readText(`${second}/package.json`)
    const secondName = JSON.parse(secondText).name
    const findings = findingsFor(
      depsWith({ [`${second}/package.json`]: secondText.replace(secondName, name) }),
      'workspace-packages',
    )
    expect(findings.map((finding) => finding.expected)).toContain(
      `a unique name for every workspace package (${name})`,
    )
    expect(findings[0].actual).toBe(`2 packages declare ${name}`)
  })
})

describe('current-state checker — supported-formats mutations', () => {
  it('fails when the CLI constant and the handoff §1 list disagree', () => {
    const findings = findingsFor(
      depsWith({
        [SOURCES.cliConnection]: mutated(
          SOURCES.cliConnection,
          'parquet, csv, jsonl, json',
          'parquet, csv, jsonl',
        ),
      }),
      'supported-formats',
    )
    expect(findings.map((finding) => finding.file)).toContain(SOURCES.handoff)
    expect(findings.map((finding) => finding.file)).toContain(SOURCES.readme)
    expect(findings.map((finding) => finding.expected)).toContain(
      '§1 formats equal SUPPORTED_FORMATS (csv, jsonl, parquet)',
    )
  })

  it('fails when the handoff claims a different format list than the source', () => {
    const findings = findingsFor(
      depsWith({
        [SOURCES.handoff]: mutated(
          SOURCES.handoff,
          '**Parquet, CSV, JSONL and\nJSON**',
          '**Parquet, CSV and JSONL**',
        ),
      }),
      'supported-formats',
    )
    // The list and the declared count both disagree with the four-format source.
    expect(findings).toHaveLength(2)
    expect(findings[0]).toMatchObject({
      file: SOURCES.handoff,
      actual: 'csv, jsonl, parquet',
    })
    expect(findings[0].line).toBeGreaterThan(1)
    expect(findings.map((finding) => finding.expected)).toContain('§1 count matches its list (3)')
  })
})

describe('current-state checker — active-queue mutations', () => {
  it('fails when the current-state block loses the no-row-selected sentinel', () => {
    const findings = findingsFor(
      depsWith({
        [SOURCES.handoff]: mutated(
          SOURCES.handoff,
          '**No row is selected for dispatch.**',
          '**A row is selected for dispatch.**',
        ),
      }),
      'active-queue',
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      file: SOURCES.handoff,
      expected: 'the block states "No row is selected for dispatch."',
    })
  })

  it('fails when a CLOSED row is presented as remaining', () => {
    // The pickup queue is fully drained, so ANY bold id in the clause is a row
    // the handoff presents as remaining while the tables say CLOSED.
    const findings = findingsFor(
      depsWith({
        [SOURCES.handoff]: mutated(
          SOURCES.handoff,
          'Recorded but unselected: none',
          'Recorded but unselected: **EW-04I**',
        ),
      }),
      'active-queue',
    )
    expect(findings.map((finding) => finding.expected)).toContain(
      'the unselected clause names exactly none (pickup "recorded, not selected")',
    )
    expect(findings[0].actual).toContain('EW-04I')
  })

  it('passes when the queue is fully drained (no row recorded-but-unselected)', () => {
    // The legitimate post-drain state: every parsed row is CLOSED, the clause
    // says "none", and the equality assertion is what still guards a lost or
    // invented remaining row.
    const findings = findingsFor(
      depsWith({
        [SOURCES.pickup]: [
          '| # | Row | Status |',
          '| --- | --- | --- |',
          '| **AAA-1** | first row | **CLOSED** |',
          '| **BBB-2** | second row | **CLOSED** |',
        ].join('\n'),
      }),
      'active-queue',
    )
    expect(findings).toEqual([])
  })

  it('fails when a CLOSED row is named as the next action', () => {
    const findings = findingsFor(
      depsWith({
        [SOURCES.handoff]: mutated(
          SOURCES.handoff,
          '**No row is selected for dispatch.**',
          'Next row **D3-1** is ready. **No row is selected for dispatch.**',
        ),
      }),
      'active-queue',
    )
    expect(findings.map((finding) => finding.expected)).toContain(
      'the block names no CLOSED row as the next action',
    )
    expect(findings.find((finding) => finding.actual.includes('D3-1'))).toBeDefined()
  })

  it('fails loudly when the pickup tables parse no row at all (parser rot)', () => {
    const findings = findingsFor(depsWith({ [SOURCES.pickup]: 'no tables here\n' }), 'active-queue')
    expect(findings.map((finding) => finding.expected)).toContain(
      'the pickup tables parse at least one row',
    )
    // The CLOSED-row guard fires too, so a rotted pickup never reads as clean.
    expect(findings.map((finding) => finding.expected)).toContain(
      'the pickup tables mark at least one row CLOSED',
    )
  })

  it('fails loudly (never throws) when the handoff is unreadable', () => {
    const { findings } = checkCurrentState(depsWith({ [SOURCES.handoff]: null }))
    expect(findings.map((finding) => finding.file)).toContain(SOURCES.handoff)
  })
})

describe('current-state checker — package-allowlist mutations', () => {
  it('fails when the manifest drops a recursive pipeline-runner glob', () => {
    const findings = findingsFor(
      depsWith({
        [SOURCES.enginePackage]: mutated(
          SOURCES.enginePackage,
          '    "dist/pipeline-runner/**/*.js.map",\n',
          '',
        ),
      }),
      'package-allowlist',
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ file: SOURCES.enginePackage })
    expect(findings[0].actual).toContain('dist/pipeline-runner/**/*.js.map')
  })

  it('fails when the README claims a flat-only allowlist again', () => {
    const findings = findingsFor(
      depsWith({
        [SOURCES.engineReadme]: mutated(
          SOURCES.engineReadme,
          'plus the recursive `dist/pipeline-runner/**` JavaScript, declarations',
          'flat only: top-level library emit, and the recursive `dist/pipeline-runner/**` JavaScript, declarations',
        ),
      }),
      'package-allowlist',
    )
    expect(findings.map((finding) => finding.expected)).toContain(
      'the README does not claim a flat-only allowlist',
    )
  })
})

describe('current-state checker — scoping (history must not trigger)', () => {
  it('ignores a closed historical narrative appended to the handoff', () => {
    const narrative =
      '\n**Verified state (2026-01-01, OLD-9 CLOSED — historical):** Next row **OLD-9** landed; ' +
      'three input formats were supported at the time (Parquet, CSV and JSON); the package name ' +
      'was @assay/legacy and the allowlist was flat only. This paragraph is history, not current state.\n'
    const { findings } = checkCurrentState(
      depsWith({ [SOURCES.handoff]: `${repo.readText(SOURCES.handoff)}\n${narrative}` }),
    )
    expect(findings).toEqual([])
  })

  it('ignores unrelated Markdown files entirely', () => {
    const { findings } = checkCurrentState(
      depsWith({ 'docs/process/handoff-snapshot-20261014.md': 'anything at all\n' }),
    )
    expect(findings).toEqual([])
  })
})
