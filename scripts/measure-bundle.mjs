#!/usr/bin/env node
/**
 * measure-bundle.mjs — E02: read the EXISTING build output and print the same
 * numbers a documented baseline report records. Zero dependencies, read-only,
 * offline, deterministic.
 *
 * Usage
 *   node scripts/measure-bundle.mjs            # human tables; exit 0
 *   node scripts/measure-bundle.mjs --json     # machine-readable JSON; exit 0
 *   node scripts/measure-bundle.mjs --help     # usage; exit 0
 *   exit 1                                     # build output missing (see below)
 *   exit 2                                     # usage error
 *
 * What it NEVER does: install, download, build, pack, publish, probe the
 * registry, start a server, or write a file. It does not run turbo/vite/tsc and
 * does not create a tarball. If the build output is absent it fails with the
 * documented remedy (`pnpm build`) instead of building anything itself.
 *
 * Measured targets (all from `pnpm build` output, never from node_modules)
 * ----------------------------------------------------------------------
 *   web      apps/web/dist — the shipped browser app. Every emitted file is
 *            assigned to exactly ONE bucket, so a chunk shared by two entries
 *            is counted once:
 *              document      index.html
 *              static-entry  files reachable from index.html along STATIC
 *                            module edges only (the boot cost)
 *              lazy-chunk    ES chunks reachable only through a dynamic
 *                            `import()` (panel code)
 *              lazy-worker   the app worker and DuckDB-WASM's own browser
 *                            worker (loaded in another thread)
 *              lazy-wasm     .wasm assets fetched by URL at runtime
 *              other         anything else emitted
 *   cli      apps/cli/dist — the publishable `files` allowlist payload, with a
 *            per-extension contents summary. The npm tarball is NOT produced
 *            here (see the report's "CLI tarball" note).
 *   desktop  apps/vscode/dist — the extension payload, split into host bundles,
 *            webview scripts, test-only bundles, the vendored `eh` DuckDB-WASM
 *            runtime, DuckDB extension wasm files and metadata.
 *   packages the publishable workspace libraries' `files` allowlist payloads.
 *   install  installed own-package bytes of every direct external dependency,
 *            read from the resolved node_modules path. This is INSTALL SIZE —
 *            files shipped inside a package — and is NOT bundle weight.
 *
 * Sizes: raw bytes from `stat`, gzip (level 6) and brotli (quality 6) of the
 * file's own bytes. Per-file compression is a transport indicator, NOT a claim
 * that the bundle is served compressed, and the sums are not a tarball size
 * (tar headers and npm's pack normalization are absent).
 *
 * Static vs lazy, and what is NOT claimed
 * --------------------------------------
 * "Static" means the emitted ES module graph from `index.html`: a chunk is
 * static when only static `import`/`from` edges reach it from the entry. A file
 * is "lazy" when it is only reached through `import(...)`, `new Worker(new
 * URL(...))`, `new URL(...)`, or a plain URL string that the runtime fetches.
 * Classification reads the emitted JS text for other emitted file names, so an
 * asset named nowhere in the output is reported as unreferenced instead of
 * guessed. This is a byte measurement of build output: it makes NO tree-shaking,
 * runtime-fetch-order, parse/execute-cost, memory or startup claim, and it does
 * not measure the e2e harness builds (packages/{engine-duckdb,data-sources}/dist)
 * because those duplicate assets for tests and are not shipped weight.
 *
 * Regenerate the inputs with `pnpm build` first (see docs/engineering/
 * 10-dependency-and-bundle-measurements.md §3 for the exact commands).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { constants as zlibConstants, brotliCompressSync, gzipSync } from 'node:zlib'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const scriptDir = dirname(fileURLToPath(import.meta.url))
export const defaultRepoRoot = resolve(scriptDir, '..')

/** gzip/brotli settings are FIXED so repeated runs agree on every byte count. */
const GZIP_OPTIONS = { level: 6 }
const BROTLI_OPTIONS = { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 } }

/** Build tools whose versions the report records beside the numbers. */
export const BUILD_TOOLS = ['vite', 'typescript', 'turbo', 'esbuild']
/** Packages whose build output is measured, in report order. */
export const TARGET_DIRS = {
  web: 'apps/web/dist',
  cli: 'apps/cli/dist',
  desktop: 'apps/vscode/dist',
}
/** Bucket order is fixed so text and JSON output are stable. */
export const BUCKET_IDS = [
  'document',
  'static-entry',
  'lazy-chunk',
  'lazy-worker',
  'lazy-wasm',
  'host-bundle',
  'webview-script',
  'test-bundle',
  'duckdb-runtime',
  'duckdb-extension',
  'metadata',
  'other',
]

const KIB = 1024

/** Human byte count: raw with a KiB/MiB suffix. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'n/a'
  if (bytes < KIB) return `${bytes} B`
  if (bytes < KIB * KIB) return `${(bytes / KIB).toFixed(1)} KiB`
  return `${(bytes / (KIB * KIB)).toFixed(2)} MiB`
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0)
}

/** One file's measured weight. `brotli`/`gzip` are of this file's own bytes. */
export function measureBytes(buffer) {
  return {
    raw: buffer.length,
    gzip: gzipSync(buffer, GZIP_OPTIONS).length,
    brotli: brotliCompressSync(buffer, BROTLI_OPTIONS).length,
  }
}

function emptyTotals() {
  return { files: 0, raw: 0, gzip: 0, brotli: 0 }
}

function addToTotals(totals, entry) {
  totals.files += 1
  totals.raw += entry.raw
  totals.gzip += entry.gzip
  totals.brotli += entry.brotli
}

/**
 * File-kind classification by emitted extension/name. Names are the only signal
 * available after bundling, so the rules are deliberately explicit.
 */
export function classifyAsset(relPath) {
  const name = posix.basename(relPath)
  const lower = name.toLowerCase()
  if (lower.endsWith('.html')) return 'document'
  if (lower.endsWith('.wasm')) return 'wasm'
  if (lower.endsWith('.css')) return 'css'
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'js'
  return 'other'
}

/** A worker bundle carries a worker name or is loaded with `new Worker(...)`. */
function looksLikeWorkerName(relPath) {
  return /worker/i.test(posix.basename(relPath))
}

/**
 * Module-reference classification: how does `from` reach `to`'s emitted name?
 *
 * The window before the file-name occurrence decides the edge kind. Minified
 * Vite output writes `import("./chunk.js")`, `new Worker(new URL("/assets/
 * worker.js", import.meta.url))` and `new URL("/assets/x.wasm", ...)`; anything
 * else that names the file is a static module edge.
 */
export function referenceKind(text, index) {
  const window = text.slice(Math.max(0, index - 60), index)
  if (/\bimport\s*\(\s*["'`][^"'`]*$/.test(window)) return 'dynamic'
  if (/\bnew\s+Worker\s*\(\s*new\s+URL\s*\(\s*["'`][^"'`]*$/.test(window)) return 'worker'
  if (/\bnew\s+URL\s*\(\s*["'`][^"'`]*$/.test(window)) return 'url'
  return 'static'
}

/**
 * Edges from `text` to every other emitted file it names. Matching is by
 * basename because Vite emits both `"./name.js"` and `"/assets/name.js"` forms;
 * emitted names carry a content hash, so a basename collision is not expected
 * and would only over-report one edge (never invent a file).
 *
 * EVERY occurrence is classified and the laziest kind wins: Vite also lists a
 * dynamic chunk's URL inside a `__vite__mapDeps` string array used for
 * preloading, so the first occurrence of a dynamically imported chunk is a plain
 * string. If any occurrence is `import(...)`, `new Worker(...)` or `new URL(...)`
 * the edge is lazy; only edges whose every occurrence is a module `from` /
 * side-effect import count as static boot cost.
 */
export function findReferences(text, fromName, candidateNames) {
  const edges = []
  for (const candidate of candidateNames) {
    if (candidate === fromName) continue
    const kinds = new Set()
    let index = text.indexOf(candidate)
    while (index !== -1) {
      kinds.add(referenceKind(text, index))
      index = text.indexOf(candidate, index + 1)
    }
    if (kinds.size === 0) continue
    let kind = 'static'
    if (kinds.has('worker')) kind = 'worker'
    else if (kinds.has('dynamic')) kind = 'dynamic'
    else if (kinds.has('url')) kind = 'url'
    edges.push({ to: candidate, kind })
  }
  return edges
}

/**
 * Entry names declared by `index.html` (script, modulepreload, stylesheet), in
 * document order. Both attribute orders are accepted because the HTML is
 * build output, not source the repository controls.
 */
export function parseHtmlEntry(html) {
  const found = []
  const patterns = [
    /<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/g,
    /<link[^>]*\brel\s*=\s*["'](?:modulepreload|stylesheet)["'][^>]*\bhref\s*=\s*["']([^"']+)["']/g,
    /<link[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\brel\s*=\s*["'](?:modulepreload|stylesheet)["']/g,
  ]
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const base = match[1].split('/').pop()
      if (base !== undefined && base !== '') found.push({ index: match.index, base })
    }
  }
  found.sort((a, b) => a.index - b.index)
  const names = []
  for (const entry of found) if (!names.includes(entry.base)) names.push(entry.base)
  return names
}

/**
 * Resolve one emitted file name (as written by Vite, e.g. `/assets/x.js`) to an
 * emitted relative path. Vite hashes the basename, so a basename match is the
 * only stable join after the build.
 */
function resolveEmitted(name, relPaths) {
  const base = name.split('/').pop()
  if (base === undefined) return null
  return relPaths.find((relPath) => posix.basename(relPath) === base) ?? null
}

/**
 * Assign every emitted web file to exactly one bucket. See the header for the
 * meaning of each bucket; the sum of the buckets equals the emitted total, so
 * nothing is counted twice.
 */
export function bucketWebAssets(files, readText) {
  const relPaths = files.map((file) => file.path)
  const entryNames = parseHtmlEntry(readText('index.html') ?? '')
  const entryPaths = new Set(
    entryNames.map((name) => resolveEmitted(name, relPaths)).filter((path) => path !== null),
  )

  const edges = new Map()
  const referenced = new Set()
  for (const file of files) {
    if (classifyAsset(file.path) !== 'js') continue
    const text = readText(file.path) ?? ''
    const found = findReferences(
      text,
      posix.basename(file.path),
      relPaths.map((p) => posix.basename(p)),
    )
    // Map basenames back to emitted paths for the graph.
    const resolved = found
      .map((edge) => {
        const target = resolveEmitted(edge.to, relPaths)
        if (target === null || target === file.path) return null
        return { ...edge, to: target }
      })
      .filter((edge) => edge !== null)
    edges.set(file.path, resolved)
    for (const edge of resolved) referenced.add(edge.to)
  }

  const staticReachable = new Set()
  const queue = [...entryPaths]
  while (queue.length > 0) {
    const current = queue.pop()
    if (current === undefined || staticReachable.has(current)) continue
    staticReachable.add(current)
    for (const edge of edges.get(current) ?? []) {
      // Only static module edges cost anything at boot; `import()`, workers and
      // URL fetches are lazy and are bucketed separately below.
      if (edge.kind === 'static') queue.push(edge.to)
    }
  }

  const buckets = new Map(BUCKET_IDS.map((id) => [id, []]))
  for (const file of files) {
    const kind = classifyAsset(file.path)
    let bucket
    if (kind === 'document') bucket = 'document'
    else if (staticReachable.has(file.path)) bucket = 'static-entry'
    else if (kind === 'wasm') bucket = 'lazy-wasm'
    else if (
      kind === 'js' &&
      (looksLikeWorkerName(file.path) || isWorkerTarget(file.path, edges))
    ) {
      bucket = 'lazy-worker'
    } else if (kind === 'js' || kind === 'css') bucket = 'lazy-chunk'
    else bucket = 'other'
    const lazy = bucket === 'lazy-chunk' || bucket === 'lazy-worker' || bucket === 'lazy-wasm'
    buckets.get(bucket).push({ ...file, bucket, unreferenced: lazy && !referenced.has(file.path) })
  }

  return serializeBuckets(buckets)
}

/** A chunk is worker-loaded when any emitted edge names it with `new Worker`. */
function isWorkerTarget(path, edges) {
  for (const list of edges.values()) {
    for (const edge of list) if (edge.to === path && edge.kind === 'worker') return true
  }
  return false
}

/**
 * Desktop buckets: the VS Code extension has no `.vsix` build step in this
 * repository, so `dist/` IS the payload. Test-only bundles are separated from
 * the shipped triple-slash entry set, and the vendored DuckDB runtime is split
 * into the wasm/worker pair plus the extension wasm files the extension loads
 * at runtime.
 */
export function bucketDesktopAssets(files) {
  const buckets = new Map(BUCKET_IDS.map((id) => [id, []]))
  for (const file of files) {
    const name = posix.basename(file.path)
    const kind = classifyAsset(file.path)
    let bucket = 'other'
    if (file.path.startsWith('webview/') && kind === 'wasm') {
      bucket = name.startsWith('duckdb-eh') ? 'duckdb-runtime' : 'duckdb-extension'
    } else if (file.path.startsWith('webview/') && kind === 'js') {
      bucket = 'webview-script'
    } else if (kind === 'js' && /-test\.cjs$/.test(name)) {
      bucket = 'test-bundle'
    } else if (kind === 'js') {
      bucket = 'host-bundle'
    } else if (kind === 'json') {
      bucket = 'metadata'
    }
    buckets.get(bucket).push({ ...file, bucket })
  }
  return serializeBuckets(buckets)
}

function serializeBuckets(buckets) {
  return [...buckets.entries()]
    .filter(([, files]) => files.length > 0)
    .map(([id, files]) => {
      const totals = emptyTotals()
      for (const file of files) addToTotals(totals, file)
      return { id, totals, files: files.sort((a, b) => a.path.localeCompare(b.path)) }
    })
}

function totalsOfFiles(files) {
  const totals = emptyTotals()
  for (const file of files) addToTotals(totals, file)
  return totals
}

/**
 * Minimal glob match for npm `files` allowlist entries. Supports `**` (any
 * number of directories, including none — npm's reading, not minimatch's),
 * `*` and `?` inside one path segment, and a trailing `/` meaning "everything
 * under this directory". `[]`/`{}` are not used by any manifest here and are
 * matched literally rather than silently reinterpreted.
 */
export function allowlistMatcher(pattern) {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '')
  let source = ''
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i]
    if (char === '*') {
      if (normalized[i + 1] === '*') {
        if (normalized[i + 2] === '/') {
          source += '(?:[^/]+/)*'
          i += 2
        } else {
          source += '.*'
          i += 1
        }
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else if ('.+^${}()|[]\\'.includes(char)) {
      source += `\\${char}`
    } else {
      source += char
    }
  }
  const anchored = normalized.endsWith('/') ? `${source}.*` : source
  return new RegExp(`^${anchored}$`)
}

/** True when `relPath` is included by npm `files` patterns. */
export function matchesAllowlist(relPath, patterns) {
  return patterns.some((pattern) => allowlistMatcher(pattern).test(relPath))
}

function extensionOf(relPath) {
  const base = posix.basename(relPath)
  if (base.endsWith('.d.ts.map')) return '.d.ts.map'
  if (base.endsWith('.d.ts')) return '.d.ts'
  if (base.endsWith('.js.map')) return '.js.map'
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '(none)' : base.slice(dot)
}

/** Contents summary: file count and bytes per extension, largest files first. */
export function summariseContents(files) {
  const byExtension = new Map()
  for (const file of files) {
    const ext = extensionOf(file.path)
    const current = byExtension.get(ext) ?? { extension: ext, files: 0, raw: 0 }
    current.files += 1
    current.raw += file.raw
    byExtension.set(ext, current)
  }
  return {
    byExtension: [...byExtension.values()].sort(
      (a, b) => b.raw - a.raw || a.extension.localeCompare(b.extension),
    ),
    largest: [...files]
      .sort((a, b) => b.raw - a.raw || a.path.localeCompare(b.path))
      .slice(0, 5)
      .map((file) => ({ path: file.path, raw: file.raw })),
  }
}

/**
 * Resolve a dependency's installed directory from an importer, in absolute
 * terms. `name/package.json` is tried first; several packages (for example
 * `@duckdb/duckdb-wasm`) do not export `./package.json`, so the second attempt
 * resolves the package's entry point and walks up to the directory whose
 * manifest declares that name.
 */
function resolveInstalledAbsolute(packageName, importerRelPath, repoRoot = defaultRepoRoot) {
  try {
    const require = createRequire(join(repoRoot, importerRelPath, 'package.json'))
    const installed = dirname(require.resolve(`${packageName}/package.json`))
    if (existsSync(join(installed, 'package.json'))) return installed
  } catch {
    // fall through to the entry-point walk
  }
  try {
    const require = createRequire(join(repoRoot, importerRelPath, 'package.json'))
    let current = dirname(require.resolve(packageName))
    for (let depth = 0; depth < 12; depth++) {
      const manifestPath = join(current, 'package.json')
      const manifest = existsSync(manifestPath)
        ? parseJson(readFileSync(manifestPath, 'utf8'))
        : null
      if (manifest !== null && manifest.name === packageName) return current
      const parent = dirname(current)
      if (parent === current) return null
      current = parent
    }
  } catch {
    return null
  }
  return null
}

/**
 * Repository-backed inputs. Every function is repo-root-relative POSIX, so the
 * tests can inject synthetic trees without touching the filesystem.
 */
export function createFsDeps(repoRoot = defaultRepoRoot) {
  const absolute = (relPath) => join(repoRoot, relPath)
  /** Every `apps/<dir>` and `packages/<dir>` that holds a package.json. */
  const listWorkspaceDirs = () => {
    const found = []
    for (const parent of ['apps', 'packages']) {
      let entries
      try {
        entries = readdirSync(absolute(parent), { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (!existsSync(absolute(`${parent}/${entry.name}/package.json`))) continue
        found.push(`${parent}/${entry.name}`)
      }
    }
    return found.sort()
  }
  return {
    workspaceDirs: listWorkspaceDirs(),
    exists(relPath) {
      return existsSync(absolute(relPath))
    },
    readText(relPath) {
      try {
        return readFileSync(absolute(relPath), 'utf8')
      } catch {
        return null
      }
    },
    readBytes(relPath) {
      try {
        return readFileSync(absolute(relPath))
      } catch {
        return null
      }
    },
    /** All files below `relDir`, repo-relative POSIX paths, sorted. */
    listFiles(relDir) {
      const out = []
      const walk = (currentRel, currentAbs) => {
        for (const entry of readdirSync(currentAbs, { withFileTypes: true })) {
          const childRel = `${currentRel}/${entry.name}`
          if (entry.isDirectory()) walk(childRel, join(currentAbs, entry.name))
          else if (entry.isFile()) out.push(childRel)
        }
      }
      walk(relDir, absolute(relDir))
      return out.sort()
    },
    /** Own regular-file bytes of an installed package directory (install size). */
    sumInstalledBytes(relDir) {
      let total = 0
      const walk = (currentAbs) => {
        for (const entry of readdirSync(currentAbs, { withFileTypes: true })) {
          const child = join(currentAbs, entry.name)
          if (entry.isDirectory()) walk(child)
          else if (entry.isFile()) total += statSync(child).size
        }
      }
      walk(absolute(relDir))
      return total
    },
    /**
     * Resolve a dependency from an importer, returning its installed directory
     * as a repo-relative POSIX path (null when it is unresolvable or lives
     * outside this checkout, where the repo-relative deps cannot read it).
     */
    resolveInstalledDir(packageName, importerRelPath) {
      const resolved = resolveInstalledAbsolute(packageName, importerRelPath)
      if (resolved === null) return null
      const relative = posix.relative(repoRoot, resolved.split('\\').join('/'))
      return relative.startsWith('..') || relative === '' ? null : relative
    },
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Direct external dependency names declared by the root or a workspace. */
export function directExternalDeps(deps) {
  const names = new Set()
  const importers = ['.', ...deps.workspaceDirs]
  for (const importer of importers) {
    const manifest = parseJson(
      deps.readText(`${importer === '.' ? '' : `${importer}/`}package.json`) ?? '',
    )
    if (manifest === null) continue
    for (const section of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      for (const name of Object.keys(manifest[section] ?? {})) {
        if (!name.startsWith('@assay/')) names.add(name)
      }
    }
  }
  return [...names].sort()
}

function measuredFiles(deps, relDir, readBytes) {
  return deps.listFiles(relDir).map((relPath) => ({
    path: relPath.slice(relDir.length + 1),
    ...measureBytes(readBytes(relPath)),
  }))
}

/** Build tool version, resolved from whichever importer declares the tool. */
function findToolVersion(deps, tool) {
  for (const importer of ['.', 'apps/web', 'apps/cli', 'apps/vscode']) {
    const dir = deps.resolveInstalledDir(tool, importer)
    if (dir === null) continue
    const manifest = parseJson(deps.readText(`${dir}/package.json`) ?? '')
    if (manifest !== null && typeof manifest.version === 'string') return manifest.version
  }
  return null
}

/**
 * The whole measurement. Returns `{ report, missing }`; `missing` lists target
 * ids whose build output is absent, so the caller can fail with the documented
 * remedy instead of printing partial numbers as if they were complete.
 */
export function buildMeasurements(deps) {
  const missing = Object.keys(TARGET_DIRS).filter((id) => !deps.exists(TARGET_DIRS[id]))
  const report = {
    schemaVersion: 1,
    tool: 'measure-bundle',
    method: {
      sizes: 'raw = stat bytes; gzip = zlib level 6; brotli = quality 6, of each file own bytes',
      buckets: 'every emitted file is assigned to exactly one bucket',
      static: 'reachable from index.html along static module edges only',
      lazy: 'reached only via import(), new Worker(new URL(...)), new URL(...) or a URL string',
      excluded:
        'e2e harness builds packages/{engine-duckdb,data-sources}/dist are not product weight',
      notClaimed: [
        'tree-shaking: bytes are measured, not attributed to included or excluded modules',
        'runtime fetch order, parse/execute cost, memory or startup',
        'served transfer size: per-file compression is not a server configuration claim',
      ],
    },
    environment: {
      node: process.versions.node,
      buildTools: Object.fromEntries(
        BUILD_TOOLS.map((tool) => [tool, findToolVersion(deps, tool)]),
      ),
    },
    targets: {},
    installSize: null,
  }

  if (!missing.includes('web')) {
    const files = measuredFiles(deps, 'apps/web/dist', deps.readBytes)
    const buckets = bucketWebAssets(files, (relPath) => deps.readText(`apps/web/dist/${relPath}`))
    report.targets.web = {
      root: 'apps/web/dist',
      total: totalsOfFiles(files),
      buckets,
    }
  }

  if (!missing.includes('cli')) {
    const manifest = parseJson(deps.readText('apps/cli/package.json') ?? '')
    const patterns = Array.isArray(manifest?.files) ? manifest.files : []
    const all = measuredFiles(deps, 'apps/cli/dist', deps.readBytes)
    const payload = all.filter((file) => matchesAllowlist(`dist/${file.path}`, patterns))
    report.targets.cli = {
      root: 'apps/cli/dist',
      total: totalsOfFiles(all),
      payload: {
        allowlist: patterns,
        total: totalsOfFiles(payload),
        contents: summariseContents(payload),
      },
      excluded: all
        .filter((file) => !matchesAllowlist(`dist/${file.path}`, patterns))
        .map((file) => ({ path: file.path, raw: file.raw })),
      tarball: null,
    }
  }

  if (!missing.includes('desktop')) {
    const files = measuredFiles(deps, 'apps/vscode/dist', deps.readBytes)
    report.targets.desktop = {
      root: 'apps/vscode/dist',
      total: totalsOfFiles(files),
      buckets: bucketDesktopAssets(files),
    }
  }

  report.targets.packages = publishablePackagePayloads(deps)

  if (deps.exists('node_modules')) {
    report.installSize = installSizes(deps)
  }

  return { report, missing }
}

/** `files` allowlist payload of every publishable workspace package. */
export function publishablePackagePayloads(deps) {
  const packages = []
  for (const importer of deps.workspaceDirs) {
    // The CLI has its own target (payload + contents summary) above.
    if (importer === 'apps/cli') continue
    const manifest = parseJson(deps.readText(`${importer}/package.json`) ?? '')
    if (manifest === null || manifest.private === true) continue
    const patterns = Array.isArray(manifest.files) ? manifest.files : []
    if (patterns.length === 0) continue
    const payload = deps
      .listFiles(`${importer}/dist`)
      .map((relPath) => ({
        path: relPath.slice(importer.length + 'dist'.length + 2),
        ...measureBytes(deps.readBytes(relPath)),
      }))
      .filter((file) => matchesAllowlist(`dist/${file.path}`, patterns))
    packages.push({
      importer,
      name: manifest.name,
      allowlist: patterns,
      total: totalsOfFiles(payload),
      contents: summariseContents(payload),
    })
  }
  return packages.sort((a, b) => (a.importer < b.importer ? -1 : 1))
}

/**
 * Installed own-package bytes per direct external dependency. This is INSTALL
 * SIZE — every regular file the package ships, including binaries, typings and
 * assets — never bundle weight. A package resolved to the same real directory
 * from several importers is counted once.
 */
export function installSizes(deps) {
  const names = directExternalDeps(deps)
  const seen = new Map()
  const packages = []
  for (const name of names) {
    const importers = ['.', ...deps.workspaceDirs]
    let resolved = null
    for (const importer of importers) {
      const dir = deps.resolveInstalledDir(name, importer)
      if (dir !== null) {
        resolved = dir
        break
      }
    }
    if (resolved === null) {
      packages.push({ name, installed: false, bytes: null })
      continue
    }
    if (seen.has(resolved)) {
      packages.push({ name, installed: true, bytes: seen.get(resolved) })
      continue
    }
    let bytes = null
    try {
      bytes = deps.sumInstalledBytes(resolved)
    } catch {
      bytes = null
    }
    seen.set(resolved, bytes)
    packages.push({ name, installed: true, bytes })
  }
  return {
    label: 'installed own-package bytes (install size, NOT bundle weight)',
    packages: packages.sort(
      (a, b) => (b.bytes ?? 0) - (a.bytes ?? 0) || a.name.localeCompare(b.name),
    ),
    total: sum(packages.map((entry) => entry.bytes ?? 0)),
  }
}

function formatRow(file) {
  return `    ${file.path.padEnd(46)} ${String(file.raw).padStart(10)} ${String(file.gzip).padStart(10)} ${String(file.brotli).padStart(10)}${file.unreferenced ? '  unreferenced' : ''}`
}

function formatTotals(label, totals) {
  return `${label.padEnd(16)} ${String(totals.files).padStart(4)} ${String(totals.raw).padStart(12)} ${String(totals.gzip).padStart(12)} ${String(totals.brotli).padStart(12)}  (${formatBytes(totals.raw)} raw, ${formatBytes(totals.gzip)} gzip)`
}

/** Human report: one table per target, bucket rows before file rows. */
export function formatReport(report) {
  const lines = [
    'Assay build-output measurements (E02) — read from existing dist/ only',
    `node ${report.environment.node}  build tools: ${BUILD_TOOLS.map(
      (tool) => `${tool} ${report.environment.buildTools[tool] ?? 'unknown'}`,
    ).join(', ')}`,
  ]
  for (const [id, target] of Object.entries(report.targets)) {
    if (Array.isArray(target)) continue
    if (target === null || target === undefined) continue
    lines.push('', `${id} — ${target.root}`)
    lines.push('  bucket             files          raw         gzip       brotli')
    for (const bucket of target.buckets ?? []) {
      lines.push(formatTotals(`  ${bucket.id}`, bucket.totals))
      for (const file of bucket.files) lines.push(formatRow(file))
    }
    lines.push(formatTotals('  total', target.total))
    if (target.payload) {
      lines.push('', `  npm files allowlist: ${target.payload.allowlist.join(', ')}`)
      lines.push(formatTotals('  payload', target.payload.total))
      lines.push(
        `  contents: ${target.payload.contents.byExtension
          .map((entry) => `${entry.extension} ${entry.files} files/${entry.raw} B`)
          .join(', ')}`,
      )
      lines.push(
        '  tarball: not produced here (no pack, no network) — see the report for the `pnpm pack` number',
      )
    }
  }
  const packages = report.targets.packages
  if (Array.isArray(packages) && packages.length > 0) {
    lines.push('', 'publishable packages — files allowlist payload')
    for (const entry of packages) {
      lines.push(
        `  ${entry.importer.padEnd(28)} ${String(entry.total.files).padStart(4)} files ${String(
          entry.total.raw,
        ).padStart(9)} B raw ${String(entry.total.gzip).padStart(9)} gzip`,
      )
    }
  }
  if (report.installSize !== null) {
    lines.push('', `install size — ${report.installSize.label}`)
    for (const entry of report.installSize.packages) {
      lines.push(
        `  ${entry.name.padEnd(34)} ${String(entry.bytes ?? 'n/a').padStart(12)} B  ${formatBytes(
          entry.bytes ?? NaN,
        )}`,
      )
    }
    lines.push(`  ${'total'.padEnd(34)} ${String(report.installSize.total).padStart(12)} B`)
  }
  lines.push(
    '',
    'Not claimed: tree-shaking, runtime fetch order, parse/execute cost, memory, startup, served transfer size.',
  )
  return lines.join('\n')
}

const USAGE = `Usage: node scripts/measure-bundle.mjs [--json|--help]

Reads the EXISTING build output (apps/web/dist, apps/cli/dist, apps/vscode/dist)
and prints per-file and per-bucket raw/gzip/brotli bytes. It never builds,
installs, downloads, packs or writes anything.

  --json   machine-readable report (same numbers as the text tables)
  --help   this message

Missing build output exits 1: run \`pnpm build\` first.`

export function parseArgs(argv) {
  const options = { json: false, help: false }
  for (const arg of argv) {
    if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else return { error: `unknown argument: ${arg}` }
  }
  return { options }
}

export function main(argv, deps = createFsDeps()) {
  const parsed = parseArgs(argv)
  if (parsed.error !== undefined) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}\n`)
    return 2
  }
  if (parsed.options.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const { report, missing } = buildMeasurements(deps)
  if (missing.length > 0) {
    process.stderr.write(
      `measure-bundle: missing build output for: ${missing
        .map((id) => `${id} (${TARGET_DIRS[id]}/)`)
        .join(', ')}\n` +
        'This command reads existing dist/ only; it does not build.\n' +
        'Run `pnpm build` first, then re-run `pnpm measure:bundle`.\n',
    )
    return 1
  }
  process.stdout.write(
    parsed.options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`,
  )
  return 0
}

/* c8 ignore start — CLI entry point, exercised through `main` in tests. */
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
/* c8 ignore stop */
