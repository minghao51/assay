// SPDX-License-Identifier: AGPL-3.0-or-later
/* global Buffer, process */

/**
 * Tests for `scripts/measure-bundle.mjs` (E02).
 *
 * Every case injects a synthetic tree through the same repo-relative deps
 * interface the real script uses, so nothing here reads or writes the repository
 * or a real build. The assertions pin the contract a baseline report relies on:
 * one bucket per emitted file (no double counting), static vs lazy edges,
 * `files` allowlist matching, install size labelled separately, deterministic
 * numbers, and a helpful failure when dist/ is missing.
 */
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  allowlistMatcher,
  bucketDesktopAssets,
  bucketWebAssets,
  buildMeasurements,
  classifyAsset,
  createFsDeps,
  formatReport,
  main,
  matchesAllowlist,
  measureBytes,
  parseHtmlEntry,
  referenceKind,
  summariseContents,
} from './measure-bundle.mjs'

const WEB_HTML = [
  '<!doctype html><html><head>',
  '<script type="module" crossorigin src="/assets/index-AAA.js"></script>',
  '<link rel="modulepreload" crossorigin href="/assets/vendor-BBB.js">',
  '<link rel="stylesheet" crossorigin href="/assets/index-CCC.css">',
  '</head></html>',
].join('')

/** A minified-shaped chunk: static import, dynamic import, worker, wasm URL. */
const WEB_ENTRY_JS = [
  'import{v}from"./vendor-BBB.js";',
  'const p=()=>import("./panel-DDD.js");',
  'new Worker(new URL("/assets/worker-EEE.js",import.meta.url),{type:"module"});',
  'const w=new URL("/assets/duck-FFF.wasm",import.meta.url);',
].join('')

/** Vite's preload map names the dynamic chunk before the `import()` does. */
const WEB_ENTRY_WITH_PRELOAD_MAP = [
  'const m={"panel-DDD.js":["assets/panel-DDD.js"]};',
  'const p=()=>import("./panel-DDD.js");',
].join('')

function syntheticWebTree() {
  return {
    'apps/web/dist/index.html': WEB_HTML,
    'apps/web/dist/assets/index-AAA.js': WEB_ENTRY_JS,
    'apps/web/dist/assets/vendor-BBB.js': 'export const v=1',
    'apps/web/dist/assets/index-CCC.css': 'body{margin:0}',
    'apps/web/dist/assets/panel-DDD.js': 'export const p=1',
    'apps/web/dist/assets/worker-EEE.js': 'self.onmessage=()=>{}',
    'apps/web/dist/assets/duck-FFF.wasm': 'not a real wasm module, only bytes',
  }
}

const ROOT_MANIFEST = JSON.stringify({
  name: 'assay',
  version: '0.0.0',
  devDependencies: { react: 'catalog:' },
})

/** Deps over an in-memory tree plus optional package manifests per importer. */
function treeDeps(tree, options = {}) {
  const files = new Map(Object.entries(tree))
  const workspaceDirs = options.workspaceDirs ?? []
  const manifests = options.manifests ?? {}
  const existingDirs = new Set(options.dirs ?? [])
  return {
    workspaceDirs,
    exists(relPath) {
      if (files.has(relPath)) return true
      if (existingDirs.has(relPath)) return true
      return [...files.keys()].some((path) => path.startsWith(`${relPath}/`))
    },
    readText(relPath) {
      if (files.has(relPath)) return files.get(relPath)
      const manifest = manifests[relPath]
      return manifest === undefined ? null : manifest
    },
    readBytes(relPath) {
      if (files.has(relPath)) return Buffer.from(files.get(relPath), 'utf8')
      return null
    },
    listFiles(relDir) {
      return [...files.keys()].filter((path) => path.startsWith(`${relDir}/`)).sort()
    },
    sumInstalledBytes: () => 0,
    resolveInstalledDir: () => null,
  }
}

function bucketsById(buckets) {
  return new Map(buckets.map((bucket) => [bucket.id, bucket]))
}

describe('measure-bundle — asset classification', () => {
  it('classifies emitted kinds by extension', () => {
    expect(classifyAsset('index.html')).toBe('document')
    expect(classifyAsset('assets/duck-FFF.wasm')).toBe('wasm')
    expect(classifyAsset('assets/index-CCC.css')).toBe('css')
    expect(classifyAsset('spike-artifacts.json')).toBe('json')
    expect(classifyAsset('assets/index-AAA.js')).toBe('js')
    expect(classifyAsset('assets/font.woff2')).toBe('other')
  })

  it('reads entry declarations in either attribute order', () => {
    const html =
      '<script src="/assets/a.js"></script><link href="/b.css" rel="stylesheet"><link rel="modulepreload" href="/c.js">'
    expect(parseHtmlEntry(html)).toEqual(['a.js', 'b.css', 'c.js'])
  })

  it('classifies a reference window as static, dynamic, worker or url', () => {
    expect(referenceKind('from"./x.js"', 'from"./'.length)).toBe('static')
    expect(referenceKind('import("./x.js"', 'import("./'.length)).toBe('dynamic')
    expect(
      referenceKind('new Worker(new URL("/assets/x.js"', 'new Worker(new URL("/assets/'.length),
    ).toBe('worker')
    expect(referenceKind('new URL("/assets/x.wasm"', 'new URL("/assets/'.length)).toBe('url')
  })
})

describe('measure-bundle — web buckets', () => {
  it('assigns every emitted file to exactly one bucket', () => {
    const tree = syntheticWebTree()
    const files = Object.entries(tree).map(([path, text]) => ({
      path: path.slice('apps/web/dist/'.length),
      ...measureBytes(Buffer.from(text, 'utf8')),
    }))
    const buckets = bucketsById(
      bucketWebAssets(files, (relPath) => tree[`apps/web/dist/${relPath}`] ?? null),
    )
    expect([...buckets.keys()]).toEqual([
      'document',
      'static-entry',
      'lazy-chunk',
      'lazy-worker',
      'lazy-wasm',
    ])
    expect(buckets.get('document').files.map((file) => file.path)).toEqual(['index.html'])
    expect(buckets.get('static-entry').files.map((file) => file.path)).toEqual([
      'assets/index-AAA.js',
      'assets/index-CCC.css',
      'assets/vendor-BBB.js',
    ])
    expect(buckets.get('lazy-chunk').files.map((file) => file.path)).toEqual([
      'assets/panel-DDD.js',
    ])
    expect(buckets.get('lazy-worker').files.map((file) => file.path)).toEqual([
      'assets/worker-EEE.js',
    ])
    expect(buckets.get('lazy-wasm').files.map((file) => file.path)).toEqual([
      'assets/duck-FFF.wasm',
    ])
    const counted = [...buckets.values()].reduce((total, bucket) => total + bucket.files.length, 0)
    expect(counted).toBe(files.length)
  })

  it('keeps a chunk lazy when a preload map names it before the import()', () => {
    const tree = {
      'apps/web/dist/index.html': '<script type="module" src="/assets/index-AAA.js"></script>',
      'apps/web/dist/assets/index-AAA.js': WEB_ENTRY_WITH_PRELOAD_MAP,
      'apps/web/dist/assets/panel-DDD.js': 'export const p=1',
    }
    const files = Object.entries(tree).map(([path, text]) => ({
      path: path.slice('apps/web/dist/'.length),
      ...measureBytes(Buffer.from(text, 'utf8')),
    }))
    const buckets = bucketsById(
      bucketWebAssets(files, (relPath) => tree[`apps/web/dist/${relPath}`] ?? null),
    )
    expect(buckets.get('lazy-chunk').files.map((file) => file.path)).toEqual([
      'assets/panel-DDD.js',
    ])
    expect(buckets.has('static-entry')).toBe(true)
  })

  it('marks a lazy asset with no emitted reference instead of guessing one', () => {
    const tree = {
      ...syntheticWebTree(),
      'apps/web/dist/assets/orphan-ZZZ.js': 'export const unused=1',
    }
    const files = Object.entries(tree).map(([path, text]) => ({
      path: path.slice('apps/web/dist/'.length),
      ...measureBytes(Buffer.from(text, 'utf8')),
    }))
    const buckets = bucketsById(
      bucketWebAssets(files, (relPath) => tree[`apps/web/dist/${relPath}`] ?? null),
    )
    const orphan = buckets
      .get('lazy-chunk')
      .files.find((file) => file.path.endsWith('orphan-ZZZ.js'))
    expect(orphan.unreferenced).toBe(true)
  })
})

describe('measure-bundle — allowlist and contents', () => {
  it('matches npm files patterns the way the manifests use them', () => {
    expect(matchesAllowlist('dist/a.js', ['dist/**/*.js'])).toBe(true)
    expect(matchesAllowlist('dist/nested/a.js', ['dist/**/*.js'])).toBe(true)
    expect(matchesAllowlist('dist/a.d.ts', ['dist/**/*.js'])).toBe(false)
    expect(matchesAllowlist('dist/nested/a.js', ['dist/*.js'])).toBe(false)
    expect(matchesAllowlist('dist/anything.bin', ['dist/'])).toBe(true)
    expect(allowlistMatcher('dist/**/*.d.ts.map').test('dist/x/a.d.ts.map')).toBe(true)
  })

  it('summarises payload contents by extension with the largest files', () => {
    const summary = summariseContents([
      { path: 'a.js', raw: 10 },
      { path: 'b.js', raw: 30 },
      { path: 'c.d.ts', raw: 5 },
    ])
    expect(summary.byExtension).toEqual([
      { extension: '.js', files: 2, raw: 40 },
      { extension: '.d.ts', files: 1, raw: 5 },
    ])
    expect(summary.largest[0]).toEqual({ path: 'b.js', raw: 30 })
  })
})

describe('measure-bundle — desktop buckets', () => {
  it('separates host, test, webview, DuckDB runtime, extension and metadata', () => {
    const files = [
      'extension.cjs',
      'e2e-test.cjs',
      'webview/dataset.js',
      'webview/duckdb-eh.wasm',
      'webview/parquet.duckdb_extension.wasm',
      'vendored-assets.json',
    ].map((path) => ({ path, raw: 1, gzip: 1, brotli: 1 }))
    const buckets = bucketsById(bucketDesktopAssets(files))
    expect(buckets.get('host-bundle').files.map((file) => file.path)).toEqual(['extension.cjs'])
    expect(buckets.get('test-bundle').files.map((file) => file.path)).toEqual(['e2e-test.cjs'])
    expect(buckets.get('webview-script').files.map((file) => file.path)).toEqual([
      'webview/dataset.js',
    ])
    expect(buckets.get('duckdb-runtime').files.map((file) => file.path)).toEqual([
      'webview/duckdb-eh.wasm',
    ])
    expect(buckets.get('duckdb-extension').files.map((file) => file.path)).toEqual([
      'webview/parquet.duckdb_extension.wasm',
    ])
    expect(buckets.get('metadata').files.map((file) => file.path)).toEqual(['vendored-assets.json'])
  })
})

describe('measure-bundle — whole report', () => {
  const cliFiles = {
    'apps/cli/dist/index.js': 'export const cli=1',
    'apps/cli/dist/index.d.ts': 'export declare const cli: number',
    'apps/cli/dist/.tsbuildinfo': '{}',
  }

  function fullTree() {
    return {
      ...syntheticWebTree(),
      ...cliFiles,
      'apps/vscode/dist/extension.cjs': 'exports.activate=()=>{}',
      'apps/vscode/dist/webview/dataset.js': 'export const d=1',
      'packages/domain/dist/index.js': 'export const D=1',
      'packages/domain/dist/index.js.map': '{}',
    }
  }

  const manifests = {
    'apps/cli/package.json': JSON.stringify({
      name: '@assay/cli',
      files: ['dist/**/*.js', 'dist/**/*.d.ts'],
    }),
    'apps/vscode/package.json': JSON.stringify({ name: '@assay/vscode', private: true }),
    'packages/domain/package.json': JSON.stringify({
      name: '@assay/domain',
      files: ['dist/**/*.js'],
    }),
    'packages/private/package.json': JSON.stringify({ name: '@assay/private', private: true }),
    'package.json': ROOT_MANIFEST,
  }

  function deps() {
    return treeDeps(fullTree(), {
      workspaceDirs: ['apps/cli', 'apps/vscode', 'packages/domain', 'packages/private'],
      manifests,
      dirs: Object.keys(manifests).map((path) => path.replace('/package.json', '')),
    })
  }

  it('reports web, cli, desktop and publishable packages', () => {
    const { report, missing } = buildMeasurements(deps())
    expect(missing).toEqual([])
    expect(Object.keys(report.targets)).toEqual(['web', 'cli', 'desktop', 'packages'])
    expect(report.targets.web.total.files).toBe(Object.keys(syntheticWebTree()).length)
    // `.tsbuildinfo` is not in the `files` allowlist and must be reported apart.
    expect(report.targets.cli.payload.total.files).toBe(2)
    expect(report.targets.cli.excluded).toEqual([{ path: '.tsbuildinfo', raw: 2 }])
    expect(report.targets.desktop.total.files).toBe(2)
    expect(report.targets.packages.map((entry) => entry.importer)).toEqual(['packages/domain'])
    expect(report.targets.packages[0].total.files).toBe(1)
  })

  it('fails with the documented remedy when build output is missing', () => {
    const missingDeps = { ...deps(), exists: () => false }
    const { missing } = buildMeasurements(missingDeps)
    expect(missing).toEqual(['web', 'cli', 'desktop'])
    expect(main([], missingDeps)).toBe(1)
  })

  it('is deterministic and keeps gzip of the file own bytes', () => {
    const first = JSON.stringify(buildMeasurements(deps()).report)
    const second = JSON.stringify(buildMeasurements(deps()).report)
    expect(second).toBe(first)
    const bytes = Buffer.from('a'.repeat(1000), 'utf8')
    expect(measureBytes(bytes)).toEqual({
      raw: 1000,
      gzip: gzipSync(bytes, { level: 6 }).length,
      brotli: expect.any(Number),
    })
  })

  it('labels install size as install size, not bundle weight', () => {
    const withInstall = {
      ...deps(),
      exists(relPath) {
        return relPath === 'node_modules' || Object.keys(fullTree()).includes(relPath)
      },
      resolveInstalledDir: (name) =>
        name === 'react' ? 'node_modules/.pnpm/react@19.3.0/node_modules/react' : null,
      sumInstalledBytes: () => 178663,
    }
    const { report } = buildMeasurements(withInstall)
    expect(report.installSize.label).toBe(
      'installed own-package bytes (install size, NOT bundle weight)',
    )
    expect(report.installSize.packages).toEqual([{ name: 'react', installed: true, bytes: 178663 }])
  })

  it('renders buckets, payload and install size in the text report', () => {
    const text = formatReport(buildMeasurements(deps()).report)
    expect(text).toContain('static-entry')
    expect(text).toContain('lazy-wasm')
    expect(text).toContain('npm files allowlist: dist/**/*.js, dist/**/*.d.ts')
    expect(text).toContain('publishable packages')
    expect(text).toContain('Not claimed: tree-shaking')
  })
})

describe('measure-bundle — CLI surface', () => {
  it('rejects unknown arguments with exit 2', () => {
    expect(main(['--nope'], treeDeps({}))).toBe(2)
  })

  it('prints usage with exit 0 for --help', () => {
    expect(main(['--help'], treeDeps({}))).toBe(0)
  })

  it('exposes repository-backed deps without reading anything', () => {
    const deps = createFsDeps(process.cwd())
    expect(typeof deps.readText).toBe('function')
    expect(Array.isArray(deps.workspaceDirs)).toBe(true)
  })
})
