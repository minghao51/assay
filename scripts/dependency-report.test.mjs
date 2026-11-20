// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Tests for `scripts/dependency-report.mjs` (E02).
 *
 * The baseline case asserts the COMMITTED manifest matches the repository, so
 * the suite doubles as the drift alarm for a dependency change that skips the
 * manifest. Every other case mutates one input in memory (a manifest, the
 * lockfile, a source file, an annotation) and asserts the specific located
 * finding, so a silent pass is impossible. Nothing is installed, built, packed
 * or fetched, and no file is written.
 */
import { describe, expect, it } from 'vitest'
import {
  MANIFEST_PATH,
  collectUseSites,
  compareManifests,
  createRepoDeps,
  deriveManifest,
  formatFindings,
  importBindings,
  importerOfPath,
  lineAt,
  main,
  packageNameOf,
  parseCatalogSpecifiers,
  parseLockfile,
  scanModuleSpecifiers,
  scanTsconfigTypes,
  stripJsonComments,
} from './dependency-report.mjs'

const repo = createRepoDeps()
const committed = JSON.parse(repo.readText(MANIFEST_PATH))

/** The derivation of the unmutated repository, computed once for the suite. */
let baselineCache = null
function baselineDerived() {
  baselineCache ??= deriveManifest(repo, committed)
  return baselineCache
}

/** Real repository deps with per-file text overrides, as A02's tests do. */
function depsWith(overrides = {}, extra = {}) {
  return {
    ...repo,
    readText: (relPath) =>
      Object.hasOwn(overrides, relPath) ? overrides[relPath] : repo.readText(relPath),
    listSourceFiles: () => extra.sourceFiles ?? repo.listSourceFiles(),
    listWorkspaceDirs: () => extra.workspaceDirs ?? repo.listWorkspaceDirs(),
  }
}

function mutated(relPath, from, to) {
  const base = repo.readText(relPath)
  expect(base, `${relPath} must be readable`).not.toBeNull()
  expect(base.includes(from), `${relPath} must contain ${JSON.stringify(from)}`).toBe(true)
  return base.split(from).join(to)
}

function findingsFor(findings, code) {
  return findings.filter((finding) => finding.code === code)
}

describe('dependency-report — baseline', () => {
  it('the committed manifest matches the repository', () => {
    expect(compareManifests(committed, baselineDerived())).toEqual([])
  })

  it('lists every direct declaration exactly once', () => {
    expect(committed.entries).toHaveLength(114)
    expect(committed.entries.filter((entry) => entry.source === 'external')).toHaveLength(74)
    expect(committed.annotations).toHaveLength(31)
    expect(committed.importers).toHaveLength(21)
  })
})

describe('dependency-report — declaration drift', () => {
  // One derivation for four independent mutations keeps the suite cheap; each
  // mutation must still produce its own located finding.
  it('fails for a new declaration, a removed one, a lockfile change and a new use site', () => {
    const domainManifest = JSON.parse(repo.readText('packages/domain/package.json'))
    domainManifest.dependencies = { 'left-pad': '^1.0.0' }
    const diffManifest = JSON.parse(repo.readText('packages/diff/package.json'))
    delete diffManifest.dependencies['@assay/validation']
    const sourceFiles = [...repo.listSourceFiles(), 'apps/web/src/e02-extra.test.ts']
    const findings = compareManifests(
      committed,
      deriveManifest(
        depsWith(
          {
            'packages/domain/package.json': JSON.stringify(domainManifest),
            'packages/diff/package.json': JSON.stringify(diffManifest),
            'pnpm-lock.yaml': mutated(
              'pnpm-lock.yaml',
              '      prettier:\n        specifier: ^3.9.8\n        version: 3.9.8',
              '      prettier:\n        specifier: ^3.9.8\n        version: 3.9.9',
            ),
            'apps/web/src/e02-extra.test.ts':
              "import { useVirtualizer } from '@tanstack/react-virtual'\n",
          },
          { sourceFiles },
        ),
        committed,
      ),
    )
    expect(findingsFor(findings, 'declaration-missing')).toContainEqual(
      expect.objectContaining({ importer: 'packages/domain', name: 'left-pad' }),
    )
    expect(findingsFor(findings, 'unannotated')).toContainEqual(
      expect.objectContaining({ name: 'left-pad' }),
    )
    expect(findingsFor(findings, 'stale-entry')).toContainEqual(
      expect.objectContaining({ importer: 'packages/diff', name: '@assay/validation' }),
    )
    expect(findingsFor(findings, 'field-drift')).toContainEqual(
      expect.objectContaining({
        importer: '.',
        name: 'prettier',
        message: expect.stringContaining('3.9.9'),
      }),
    )
    expect(findingsFor(findings, 'use-sites-drift')).toContainEqual(
      expect.objectContaining({ importer: 'apps/web', name: '@tanstack/react-virtual' }),
    )
  })
})

describe('dependency-report — annotation drift', () => {
  it('fails when an external dependency has no annotation', () => {
    const findings = compareManifests(
      { ...committed, annotations: [] },
      deriveManifest(repo, committed),
    )
    expect(findingsFor(findings, 'unannotated')).toHaveLength(31)
  })

  it('fails on an unknown kind, an empty rationale and a stale annotation', () => {
    const annotations = committed.annotations.map((annotation) =>
      annotation.name === 'react'
        ? { ...annotation, kind: 'runtime-ish' }
        : annotation.name === 'yaml'
          ? { ...annotation, rationale: '   ' }
          : annotation,
    )
    annotations.push({ name: 'left-pad', kind: 'runtime', rationale: 'removed long ago' })
    const findings = compareManifests({ ...committed, annotations }, baselineDerived())
    expect(findingsFor(findings, 'invalid-kind')).toContainEqual(
      expect.objectContaining({ name: 'react' }),
    )
    expect(findingsFor(findings, 'missing-rationale')).toContainEqual(
      expect.objectContaining({ name: 'yaml' }),
    )
    expect(findingsFor(findings, 'stale-annotation')).toContainEqual(
      expect.objectContaining({ name: 'left-pad' }),
    )
  })

  it('renders findings with importer, name and code', () => {
    const text = formatFindings([
      { code: 'unannotated', name: 'left-pad', message: 'no annotation' },
      { code: 'field-drift', importer: '.', name: 'prettier', message: 'locked differs' },
    ])
    expect(text).toBe(
      'left-pad: [unannotated] no annotation\n. prettier: [field-drift] locked differs',
    )
  })
})

describe('dependency-report — parsers', () => {
  const LOCKFILE = [
    "lockfileVersion: '9.0'",
    '',
    'catalogs:',
    '  default:',
    "    '@types/node':",
    '      specifier: ^26.6.2',
    '      version: 26.6.2',
    '',
    'importers:',
    '',
    '  .:',
    '    devDependencies:',
    "      '@types/node':",
    "        specifier: 'catalog:'",
    '        version: 26.6.2',
    '',
    '  apps/cli:',
    '    dependencies:',
    '      yaml:',
    '        specifier: 2.9.1',
    '        version: 2.9.1',
    '',
    'snapshots:',
    '  yaml@2.9.1: {}',
  ].join('\n')

  it('parses importers and catalogs from the lockfile without a YAML dependency', () => {
    const parsed = parseLockfile(LOCKFILE)
    expect(parsed.catalogs.default['@types/node']).toEqual({
      specifier: '^26.6.2',
      version: '26.6.2',
    })
    expect(parsed.importers['.'].devDependencies['@types/node']).toEqual({
      specifier: 'catalog:',
      version: '26.6.2',
    })
    expect(parsed.importers['apps/cli'].dependencies.yaml).toEqual({
      specifier: '2.9.1',
      version: '2.9.1',
    })
    expect(parsed.importers.snapshots).toBeUndefined()
  })

  it('parses the flat catalog block this workspace uses and named catalogs', () => {
    const flat = parseCatalogSpecifiers('catalog:\n  typescript: ^6.0.3\n  react: ^19.1.0\n')
    expect(flat['default\u0000typescript']).toBe('^6.0.3')
    expect(flat['default\u0000react']).toBe('^19.1.0')
    const named = parseCatalogSpecifiers('catalogs:\n  stable:\n    vite: ^8.0.0\n')
    expect(named['stable\u0000vite']).toBe('^8.0.0')
    expect(parseCatalogSpecifiers('packages:\n  - apps/*\n')).toEqual({})
  })

  it('reads module specifiers, incl. a multi-line import, with bindings', () => {
    const source = [
      "import { useState } from 'react'",
      'import {',
      '  readFileSync,',
      '  writeFileSync as write,',
      "} from 'node:fs'",
      "import type { EventBuffer } from '@assay/telemetry'",
      "import './side-effect.css'",
      "const yaml = await import('yaml')",
      "const required = require('apache-arrow')",
      "const path = require.resolve('prettier/package.json')",
    ].join('\n')
    const specifiers = scanModuleSpecifiers(source).map(
      (site) => `${site.line}:${site.via}:${site.specifier}`,
    )
    expect(specifiers).toEqual([
      '1:import:react',
      '2:import:node:fs',
      '6:import-type:@assay/telemetry',
      '8:dynamic-import:yaml',
      '9:require:apache-arrow',
      '10:require-resolve:prettier/package.json',
    ])
    const fsImport = scanModuleSpecifiers(source).find((site) => site.specifier === 'node:fs')
    expect(fsImport.symbols).toEqual(['readFileSync', 'writeFileSync'])
  })

  it('extracts default, named and namespace bindings', () => {
    expect(importBindings("import { a, b as c, type T } from 'x'")).toEqual(['a', 'b', 'T'])
    expect(importBindings("import React from 'react'")).toEqual(['React'])
    expect(importBindings("import * as path from 'node:path'")).toEqual(['* as path'])
    expect(importBindings("import Def, { named } from 'x'")).toEqual(['named', 'Def'])
  })

  it('maps tsconfig types entries, including JSONC comments and trailing commas', () => {
    const tsconfig = [
      '{',
      '  // comment with a "quote" and a */ sequence',
      '  "extends": "../../tsconfig.base.json",',
      '  "compilerOptions": {',
      '    "types": ["node", "vite/client", "unknown"],',
      '  },',
      '}',
    ].join('\n')
    const sites = scanTsconfigTypes(tsconfig)
    expect(sites.map((site) => site.packageName)).toEqual(['@types/node', 'vite'])
    expect(sites[0].line).toBe(5)
    expect(stripJsonComments('{"a": "https://example.test", "b": [1,2,],}')).toBe(
      '{"a": "https://example.test", "b": [1,2]}',
    )
  })

  it('attributes files to the owning importer', () => {
    expect(importerOfPath('apps/web/src/App.tsx')).toBe('apps/web')
    expect(importerOfPath('packages/domain/src/index.ts')).toBe('packages/domain')
    expect(importerOfPath('scripts/doctor.mjs')).toBe('.')
    expect(importerOfPath('tests/e2e/a11y.spec.ts')).toBe('.')
    expect(packageNameOf('@assay/domain/sub')).toBe('@assay/domain')
    expect(packageNameOf('yaml')).toBe('yaml')
    expect(lineAt('a\nb\nc', 4)).toBe(3)
  })

  it('records bin-name evidence for a script that runs tsc', () => {
    const declaredBy = new Map()
    declaredBy.set('.\u0000typescript', { importer: '.', name: 'typescript' })
    declaredBy.namesFor = (importer) => (importer === '.' ? ['typescript'] : [])
    const deps = depsWith({}, { sourceFiles: [] })
    const sites = collectUseSites({ ...deps, listSourceFiles: () => [] }, declaredBy, {
      typescript: ['tsc'],
    })
    expect(sites['.\u0000typescript']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: 'package.json', via: 'script', symbols: ['test'] }),
      ]),
    )
  })
})

describe('dependency-report — CLI surface', () => {
  it('rejects unknown arguments with exit 2 and prints usage for --help', () => {
    expect(main(['--nope'], repo)).toBe(2)
    expect(main(['--help'], repo)).toBe(0)
  })

  it('checks the committed manifest successfully', () => {
    expect(main([], repo)).toBe(0)
  })

  it('refuses to write while an external dependency is unannotated', () => {
    const text = repo.readText('packages/domain/package.json')
    const parsed = JSON.parse(text)
    parsed.dependencies = { 'left-pad': '^1.0.0' }
    const written = []
    const exit = main(
      ['--write'],
      depsWith({ 'packages/domain/package.json': JSON.stringify(parsed) }),
      (path, contents) => written.push({ path, contents }),
    )
    expect(exit).toBe(1)
    expect(written).toEqual([])
  })

  it('writes exactly one manifest file whose entries match the derivation', () => {
    const written = []
    const exit = main(['--write'], repo, (path, contents) => written.push({ path, contents }))
    expect(exit).toBe(0)
    expect(written).toHaveLength(1)
    expect(written[0].path).toBe(MANIFEST_PATH)
    const serialized = JSON.parse(written[0].contents)
    expect(serialized.entries).toEqual(committed.entries)
    expect(serialized.annotations).toEqual(committed.annotations)
  })
})
