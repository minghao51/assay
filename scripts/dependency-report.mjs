#!/usr/bin/env node
/**
 * dependency-report.mjs — E02: derive and check the committed dependency-use
 * manifest (`docs/engineering/dependency-use-manifest.json`).
 *
 * Usage
 *   node scripts/dependency-report.mjs            # check (same as --check)
 *   node scripts/dependency-report.mjs --check     # exit 1 on any drift
 *   node scripts/dependency-report.mjs --write     # regenerate derived fields
 *   node scripts/dependency-report.mjs --json      # print the derived entries
 *   node scripts/dependency-report.mjs --help
 *
 * Method (no dependency is invented and no usage is guessed)
 * ---------------------------------------------------------
 * Every value in the manifest is derived from repository data:
 *   - declarations: every root/workspace `package.json` dependency section;
 *   - declared + locked ranges: the `pnpm-lock.yaml` `importers` and `catalogs`
 *     blocks (the lockfile records the resolved version beside the specifier);
 *   - engines/peer ranges: the installed package's own `package.json`, read
 *     through node's resolver from the declaring workspace (an installed-
 *     metadata snapshot, never a registry lookup);
 *   - use sites: a line-anchored scan of repository source/config files for
 *     module specifiers, `tsconfig` `types` entries, `package.json` script
 *     tokens and config strings. Each site records file, line, how it is
 *     referenced and (for imports) the imported bindings.
 * Two things are NOT derived and must be hand-verified, because no file records
 * them: the per-name `kind` and `rationale` in `annotations`. `--check` fails
 * when a declared external dependency has no annotation, so a new dependency
 * cannot be added without writing down why it is kept.
 *
 * What this script NEVER does: install, download, build, pack, publish or probe
 * the registry. It reads files, compares data and (with --write) writes exactly
 * one committed JSON file.
 *
 * Deliberate limits
 * -----------------
 * - Use sites are literal, line-anchored evidence, not an AST. A dependency
 *   consumed implicitly (for example `@types/react` through tsc's module
 *   resolution) has no site and says so in its annotation instead of inventing
 *   one.
 * - At most `MAX_USE_SITES` sites are stored per entry with the full count; a
 *   change beyond the stored head is therefore caught by the count, not by the
 *   site list.
 * - Transitive (non-direct) packages are out of scope; only what the manifests
 *   declare is listed.
 * - Peer/engine ranges are reported as data. This script does not decide
 *   compatibility between ranges.
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const scriptDir = dirname(fileURLToPath(import.meta.url))
export const defaultRepoRoot = resolve(scriptDir, '..')

/** The committed manifest this script owns. */
export const MANIFEST_PATH = 'docs/engineering/dependency-use-manifest.json'
/** Declarations in these sections are direct dependencies of the importer. */
export const SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]
/** Allowed `kind` values, documented in the manifest's own `kinds` field. */
export const KINDS = ['runtime', 'test', 'type-only', 'config', 'bin', 'workspace']
/** At most this many use sites are stored per entry (the count stays exact). */
export const MAX_USE_SITES = 10
/** Files scanned for use sites: extensions only, generated/vendor output skipped. */
const SCAN_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.yml',
  '.yaml',
])
const SCAN_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.turbo',
  'coverage',
  'playwright-report',
  'test-results',
  '.changeset',
  'fixtures',
])
/** `tsconfig` `types` entries and the package each one pulls in. */
const TSCONFIG_TYPE_PACKAGES = {
  node: '@types/node',
  vscode: '@types/vscode',
  'vite/client': 'vite',
}
/**
 * Modules whose TypeScript declarations come from a `@types/*` package: tsc
 * resolves the module to the typings, so an import of `react` IS evidence for
 * `@types/react` even though the specifier never names it.
 */
const MODULE_TYPE_PACKAGES = {
  vscode: '@types/vscode',
  react: '@types/react',
  'react-dom': '@types/react-dom',
}
/** `node:*` builtin imports typecheck against `@types/node`. */
const BUILTIN_TYPE_PACKAGE = { prefix: 'node:', packageName: '@types/node' }

const MODULE_PATTERNS = [
  {
    via: 'import',
    regex: /^[ \t]*(?:import|export)\b(?:(?!\bfrom\b)[\s\S]){0,400}?\bfrom\s*['"]([^'"\n]+)['"]/gm,
  },
  { via: 'import', regex: /^[ \t]*import\s*['"]([^'"\n]+)['"]/gm },
  { via: 'dynamic-import', regex: /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g },
  { via: 'require', regex: /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g },
  { via: 'require-resolve', regex: /\brequire\.resolve\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g },
]

/** 1-based line number of a character offset. */
export function lineAt(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/** Package name of a module specifier (`@scope/name/sub` → `@scope/name`). */
export function packageNameOf(specifier) {
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) return parts.slice(0, 2).join('/')
  return parts[0]
}

function stripQuotes(value) {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * Parse the `catalogs` and `importers` blocks of a pnpm lockfile. Only these two
 * blocks are read: they are the machine-readable record of what each workspace
 * declares and which version the lock resolved.
 */
export function parseLockfile(text) {
  const lines = text.split('\n')
  const catalogs = {}
  const importers = {}
  let section = null
  let importer = null
  let dependencySection = null
  let catalogName = null
  let dependency = null
  let catalogEntry = null

  for (const line of lines) {
    if (/^[A-Za-z]/.test(line)) {
      section = line.startsWith('catalogs:')
        ? 'catalogs'
        : line.startsWith('importers:')
          ? 'importers'
          : null
      importer = null
      dependencySection = null
      continue
    }
    if (section === 'catalogs') {
      const catalog = /^ {2}(\S[^:]*):\s*$/.exec(line)
      if (catalog !== null) {
        catalogName = stripQuotes(catalog[1])
        catalogs[catalogName] = catalogs[catalogName] ?? {}
        continue
      }
      const entry = /^ {4}(\S[^:]*):\s*$/.exec(line)
      if (entry !== null && catalogName !== null) {
        catalogEntry = stripQuotes(entry[1])
        catalogs[catalogName][catalogEntry] = {}
        continue
      }
      const field = /^ {6}(specifier|version):\s*(.+)$/.exec(line)
      if (field !== null && catalogName !== null && catalogEntry !== null) {
        catalogs[catalogName][catalogEntry][field[1]] = stripQuotes(field[2])
      }
      continue
    }
    if (section === 'importers') {
      const importerMatch = /^ {2}(\S[^:]*):\s*$/.exec(line)
      if (importerMatch !== null) {
        importer = stripQuotes(importerMatch[1])
        importers[importer] = importers[importer] ?? {}
        dependencySection = null
        continue
      }
      const sectionMatch = /^ {4}(\w+):\s*$/.exec(line)
      if (sectionMatch !== null) {
        dependencySection = sectionMatch[1]
        if (importer === null) continue
        importers[importer][dependencySection] = importers[importer][dependencySection] ?? {}
        continue
      }
      const dependencyMatch = /^ {6}(\S[^:]*):\s*$/.exec(line)
      if (dependencyMatch !== null && importer !== null && dependencySection !== null) {
        dependency = stripQuotes(dependencyMatch[1])
        importers[importer][dependencySection][dependency] = {}
        continue
      }
      const fieldMatch = /^ {8}(specifier|version):\s*(.+)$/.exec(line)
      if (
        fieldMatch !== null &&
        importer !== null &&
        dependencySection !== null &&
        dependency !== null
      ) {
        importers[importer][dependencySection][dependency][fieldMatch[1]] = stripQuotes(
          fieldMatch[2],
        )
      }
    }
  }
  return { catalogs, importers }
}

/** Imported bindings of one module statement, as symbol evidence. */
export function importBindings(statement) {
  const head = statement
    .replace(/^[ \t]*(?:import|export)\s+(?:type\s+)?/, '')
    .replace(/\bfrom\s*['"][^'"]+['"]\s*$/, '')
  const symbols = []
  const braces = /\{([^}]*)\}/.exec(head)
  if (braces !== null) {
    for (const part of braces[1].split(',')) {
      const name = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]
        .trim()
      if (name !== '') symbols.push(name)
    }
  }
  const namespace = /\*\s*as\s+([A-Za-z0-9_$]+)/.exec(head)
  if (namespace !== null) symbols.push(`* as ${namespace[1]}`)
  const withoutBraces = head.replace(/\{[^}]*\}/, '').replace(/\*\s*as\s+[A-Za-z0-9_$]+/, '')
  const defaultName = withoutBraces.split(',')[0].trim()
  if (/^[A-Za-z0-9_$]+$/.test(defaultName)) symbols.push(defaultName)
  return symbols
}

/**
 * Every module specifier mentioned by one file, with its line and bindings.
 * Line-anchored patterns keep this from matching a `from 'x'` deep inside a
 * template literal or comment block; a multi-line import is matched by the
 * bounded `[\s\S]{0,400}` window that stops at the first `from`.
 */
export function scanModuleSpecifiers(text) {
  const found = []
  for (const { via, regex } of MODULE_PATTERNS) {
    regex.lastIndex = 0
    for (const match of text.matchAll(regex)) {
      const specifier = match[1]
      if (specifier === undefined || specifier.startsWith('.') || specifier.startsWith('/'))
        continue
      const kind = /^[ \t]*(?:import|export)\s+type\b/.test(match[0]) ? 'import-type' : via
      found.push({
        specifier,
        line: lineAt(text, match.index ?? 0),
        via: kind,
        symbols: via === 'import' ? importBindings(match[0]) : [],
      })
    }
  }
  return found.sort((a, b) => a.line - b.line || a.via.localeCompare(b.via))
}

/** `tsconfig` `types` entries mapped to the package they pull in. */
export function scanTsconfigTypes(text) {
  const found = []
  // tsconfig files are JSONC: comments and trailing commas are legal.
  const parsed = parseJson(stripJsonComments(text))
  const types = parsed?.compilerOptions?.types
  if (!Array.isArray(types)) return found
  for (const entry of types) {
    const packageName = TSCONFIG_TYPE_PACKAGES[entry]
    if (packageName === undefined) continue
    const index = text.indexOf(`"${entry}"`)
    found.push({
      packageName,
      line: index === -1 ? 1 : lineAt(text, index),
      via: 'tsconfig-types',
      symbols: [entry],
    })
  }
  return found
}

/** Quoted config strings that name a package (provider, environment, path). */
export function scanConfigStrings(text) {
  const found = []
  const regex = /['"](@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+|[A-Za-z0-9._-]+)['"]/g
  for (const match of text.matchAll(regex)) {
    found.push({
      value: match[1],
      line: lineAt(text, match.index ?? 0),
    })
  }
  return found
}

/**
 * Strip JSONC comments and trailing commas so a `tsconfig` can be parsed. The
 * scanner respects string literals, so `"$schema": "https://..."` survives (a
 * naive regex would truncate it at the `//`).
 */
export function stripJsonComments(text) {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false
  let pendingComma = -1
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    const next = text[i + 1]
    if (inLine) {
      if (char === '\n') {
        inLine = false
        out += char
      }
      continue
    }
    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      out += char
      if (char === '\\') {
        out += next ?? ''
        i++
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      // A comma before a string value is a real comma: clear the trailing-comma
      // candidate so `["a", "b"]` cannot lose its separator.
      inString = true
      pendingComma = -1
      out += char
      continue
    }
    if (char === '/' && next === '/') {
      inLine = true
      pendingComma = -1
      i++
      continue
    }
    if (char === '/' && next === '*') {
      inBlock = true
      pendingComma = -1
      i++
      continue
    }
    if (char === ',') {
      pendingComma = out.length
      out += char
      continue
    }
    if (char === '}' || char === ']') {
      if (pendingComma !== -1) {
        out = out.slice(0, pendingComma) + out.slice(pendingComma + 1)
        pendingComma = -1
      }
      out += char
      continue
    }
    if (!/\s/.test(char)) pendingComma = -1
    out += char
  }
  return out
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function createInstalledResolver(repoRoot) {
  // Memoized: one importer declares many dependencies and the check derives the
  // whole manifest more than once in the test suite.
  const cache = new Map()
  return (packageName, importerRelPath) => {
    const key = `${importerRelPath}\u0000${packageName}`
    if (cache.has(key)) return cache.get(key)
    const resolved = resolveInstalledManifest(packageName, importerRelPath)
    cache.set(key, resolved)
    return resolved
  }

  function resolveInstalledManifest(packageName, importerRelPath) {
    try {
      const require = createRequire(join(repoRoot, importerRelPath, 'package.json'))
      const manifestPath = require.resolve(`${packageName}/package.json`)
      if (existsSync(manifestPath)) return parseJson(readFileSync(manifestPath, 'utf8'))
    } catch {
      // packages that do not export ./package.json fall through to the entry walk
    }
    try {
      const require = createRequire(join(repoRoot, importerRelPath, 'package.json'))
      let current = dirname(require.resolve(packageName))
      for (let depth = 0; depth < 12; depth++) {
        const candidate = join(current, 'package.json')
        const manifest = existsSync(candidate) ? parseJson(readFileSync(candidate, 'utf8')) : null
        if (manifest !== null && manifest.name === packageName) return manifest
        const parent = dirname(current)
        if (parent === current) return null
        current = parent
      }
    } catch {
      return null
    }
    return null
  }
}

/**
 * Repository-backed inputs. `readText` returns null for a missing file so a
 * check reports a located finding instead of throwing; tests inject a plain
 * object with the same functions.
 */
export function createRepoDeps(repoRoot = defaultRepoRoot) {
  const absolute = (relPath) => join(repoRoot, relPath)
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
  const listSourceFiles = () => {
    const found = []
    const walk = (currentRel) => {
      let entries
      try {
        entries = readdirSync(absolute(currentRel), { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const childRel = currentRel === '' ? entry.name : `${currentRel}/${entry.name}`
        if (entry.isDirectory()) {
          if (SCAN_SKIP_DIRS.has(entry.name)) continue
          walk(childRel)
          continue
        }
        const dot = entry.name.lastIndexOf('.')
        const ext = dot <= 0 ? '' : entry.name.slice(dot)
        if (SCAN_EXTENSIONS.has(ext)) found.push(childRel)
      }
    }
    walk('')
    return found.sort()
  }
  return {
    readText(relPath) {
      try {
        return readFileSync(absolute(relPath), 'utf8')
      } catch {
        return null
      }
    },
    listWorkspaceDirs,
    listSourceFiles,
    readInstalledManifest: createInstalledResolver(repoRoot),
    /** Only `--write` uses this; the check path never writes. */
    writeText(relPath, text) {
      mkdirSync(dirname(absolute(relPath)), { recursive: true })
      writeFileSync(absolute(relPath), text, 'utf8')
    },
  }
}

/** Importer that owns a repository path: `apps/x`/`packages/x`, else the root. */
export function importerOfPath(relPath) {
  const parts = relPath.split('/')
  if ((parts[0] === 'apps' || parts[0] === 'packages') && parts.length > 2) {
    return `${parts[0]}/${parts[1]}`
  }
  return '.'
}

/**
 * Collect use sites per importer and package name.
 *
 * A site belongs to the importer that owns the file, so a site is evidence for
 * the declaration the *same* workspace makes (a package that imports something
 * it does not declare is a separate concern — `import/no-extraneous-
 * dependencies` owns it).
 */
export function collectUseSites(deps, declaredBy, binNames = {}) {
  const sites = new Map()
  const add = (importer, packageName, site) => {
    if (!declaredBy.has(`${importer}\u0000${packageName}`)) return
    const key = `${importer}\u0000${packageName}`
    const list = sites.get(key) ?? []
    if (
      !list.some(
        (entry) => entry.file === site.file && entry.line === site.line && entry.via === site.via,
      )
    ) {
      list.push(site)
      sites.set(key, list)
    }
  }

  for (const file of deps.listSourceFiles()) {
    const text = deps.readText(file)
    if (text === null) continue
    const importer = importerOfPath(file)
    const importedHere = new Set()
    for (const site of scanModuleSpecifiers(text)) {
      const packageName = packageNameOf(site.specifier)
      importedHere.add(packageName)
      add(importer, packageName, {
        file,
        line: site.line,
        via: site.via,
        symbols: [...new Set(site.symbols)].slice(0, 12),
      })
      // Evidence for the typings a module resolves to (react → @types/react,
      // vscode → @types/vscode, node:* → @types/node). This is the TypeScript
      // module-resolution rule, not an invented reference.
      const typedBy =
        MODULE_TYPE_PACKAGES[packageName] ??
        (site.specifier.startsWith(BUILTIN_TYPE_PACKAGE.prefix)
          ? BUILTIN_TYPE_PACKAGE.packageName
          : undefined)
      if (typedBy !== undefined) {
        add(importer, typedBy, {
          file,
          line: site.line,
          via: 'module-types',
          symbols: [site.specifier],
        })
      }
    }
    for (const site of scanTsconfigTypes(text)) {
      add(importer, site.packageName, {
        file,
        line: site.line,
        via: site.via,
        symbols: site.symbols,
      })
    }
    if (
      /\.ya?ml$/.test(file) ||
      /\.config\.[cm]?[jt]s$/.test(file) ||
      /(^|\/)tsconfig[^/]*\.json$/.test(file)
    ) {
      for (const site of scanConfigStrings(text)) {
        const packageName = packageNameOf(site.value)
        if (importedHere.has(packageName)) continue
        add(importer, packageName, {
          file,
          line: site.line,
          via: 'config-string',
          symbols: [site.value],
        })
      }
    }
  }

  // Bin invocations: a package script that runs the dependency's executable.
  for (const importer of ['.', ...deps.listWorkspaceDirs()]) {
    const manifestPath = importer === '.' ? 'package.json' : `${importer}/package.json`
    const text = deps.readText(manifestPath)
    const manifest = text === null ? null : parseJson(text)
    if (manifest === null) continue
    for (const [scriptName, command] of Object.entries(manifest.scripts ?? {})) {
      if (typeof command !== 'string') continue
      for (const name of declaredBy.namesFor(importer)) {
        const tokens = [name, ...(binNames[name] ?? [])]
        const matched = tokens.find((token) =>
          new RegExp(`(^|[\\s;&|()"'])${escapeRegExp(token)}($|[\\s;&|()"'])`).test(command),
        )
        if (matched === undefined) continue
        const scriptKey = text.indexOf(`"${scriptName}"`)
        const commandIndex = text.indexOf(scriptName, scriptKey)
        add(importer, name, {
          file: manifestPath,
          line:
            text === null
              ? 1
              : lineAt(
                  text,
                  commandIndex === -1 ? (scriptKey === -1 ? 0 : scriptKey) : commandIndex,
                ),
          via: 'script',
          symbols: [scriptName],
        })
      }
    }
  }

  return Object.fromEntries(
    [...sites.entries()].map(([key, list]) => {
      const sorted = list.sort(
        (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.via.localeCompare(b.via),
      )
      return [key, sorted]
    }),
  )
}

/**
 * Derive the manifest from repository data, preserving the hand-verified
 * `annotations`, `kinds`, `reviewConclusion` and `limits` already committed.
 */
export function deriveManifest(deps, existing) {
  const lockfile = parseLockfile(deps.readText('pnpm-lock.yaml') ?? '')
  const workspace = deps.readText('pnpm-workspace.yaml') ?? ''
  const catalogSpecifiers = parseCatalogSpecifiers(workspace)
  const importers = ['.', ...deps.listWorkspaceDirs()]
  const declaredBy = new Map()
  const declarations = []
  for (const importer of importers) {
    const manifestPath = importer === '.' ? 'package.json' : `${importer}/package.json`
    const text = deps.readText(manifestPath)
    const manifest = text === null ? null : parseJson(text)
    if (manifest === null) continue
    for (const section of SECTIONS) {
      for (const name of Object.keys(manifest[section] ?? {}).sort()) {
        const declared = manifest[section][name]
        const key = `${importer}\u0000${name}`
        if (declaredBy.has(key)) continue
        declaredBy.set(key, { importer, name, section, declared })
        declarations.push({ importer, name, section, declared })
      }
    }
  }
  declaredBy.namesFor = (importer) =>
    declarations.filter((entry) => entry.importer === importer).map((entry) => entry.name)

  // Executable names each external dependency provides (`typescript` → `tsc`),
  // read from the installed metadata, so a script that runs `tsc` counts as
  // evidence for the package that ships it.
  const binNames = {}
  for (const { importer, name, declared } of declarations) {
    if (typeof declared === 'string' && declared.startsWith('workspace:')) continue
    const installed = deps.readInstalledManifest(name, importer)
    const bin = installed?.bin
    const names = typeof bin === 'string' ? [name] : Object.keys(bin ?? {})
    if (names.length > 0) binNames[name] = names.filter((entry) => entry !== name)
  }

  const annotationByName = new Map(
    (existing?.annotations ?? []).map((annotation) => [annotation.name, annotation]),
  )
  const useSites = collectUseSites(deps, declaredBy, binNames)
  const entries = declarations.map(({ importer, name, section, declared }) => {
    const lockEntry = lockfile.importers[importer]?.[section]?.[name] ?? {}
    const isCatalog = declared === 'catalog:'
    const isWorkspace = typeof declared === 'string' && declared.startsWith('workspace:')
    const installed = isWorkspace ? null : deps.readInstalledManifest(name, importer)
    const locked = lockEntry.version ?? null
    const sites = useSites[`${importer}\u0000${name}`] ?? []
    const annotation = isWorkspace ? undefined : annotationByName.get(name)
    return {
      importer,
      name,
      source: isWorkspace ? 'workspace' : 'external',
      section,
      declared,
      declaredRange: isCatalog ? (catalogSpecifiers[`default\u0000${name}`] ?? null) : declared,
      catalog: isCatalog ? 'default' : null,
      locked,
      workspaceTarget:
        isWorkspace && typeof locked === 'string' && locked.startsWith('link:')
          ? posix.normalize(
              posix.join(importer === '.' ? '' : importer, locked.slice('link:'.length)),
            )
          : null,
      engines: installed?.engines ?? null,
      peerDependencies: installed?.peerDependencies ?? null,
      useSiteCount: sites.length,
      useSites: sites.slice(0, MAX_USE_SITES),
      useSitesTruncated: sites.length > MAX_USE_SITES,
      // Copied from `annotations[name]` so every entry is self-contained; the
      // annotation table stays the hand-verified source of truth and --check
      // fails when a copy and its annotation disagree.
      kind: isWorkspace ? 'workspace' : (annotation?.kind ?? null),
      rationale: isWorkspace
        ? `internal workspace link (${section}); the importer consumes TypeScript source through the package \`exports\` field and the apps → ui/core → domain direction is lint-enforced`
        : (annotation?.rationale ?? null),
      pinRationale: annotation?.pinRationale ?? null,
    }
  })

  return {
    schemaVersion: 1,
    document: 'docs/engineering/10-dependency-and-bundle-measurements.md',
    generatedBy: 'scripts/dependency-report.mjs',
    method: {
      derivation:
        'Every field except per-name `kind`/`rationale` is derived from the manifests, pnpm-lock.yaml importers/catalogs blocks, installed package metadata and a line-anchored source scan.',
      regenerate: 'node scripts/dependency-report.mjs --write',
      check: 'node scripts/dependency-report.mjs --check',
      annotations:
        '`kind` and `rationale` are hand-verified per EXTERNAL name (no file records intent). A declared external dependency without an annotation fails --check.',
      useSites:
        'file/line/via/symbols evidence from import, dynamic import, require, require.resolve, tsconfig types, config strings and package scripts. Not an AST.',
    },
    inputs: [
      'package.json',
      'apps/*/package.json',
      'packages/*/package.json',
      'pnpm-workspace.yaml (catalog)',
      'pnpm-lock.yaml (importers, catalogs)',
      'node_modules/<name>/package.json (installed metadata: engines, peers)',
      'repository source/config files (use sites)',
    ],
    kinds: existing?.kinds ?? DEFAULT_KINDS,
    limits: existing?.limits ?? DEFAULT_LIMITS,
    reviewConclusion: existing?.reviewConclusion ?? DEFAULT_REVIEW_CONCLUSION,
    importers: importers
      .map((importer) => {
        const text = deps.readText(importer === '.' ? 'package.json' : `${importer}/package.json`)
        const manifest = text === null ? null : parseJson(text)
        if (manifest === null) return null
        return {
          path: importer,
          name: manifest.name ?? null,
          engines: manifest.engines ?? null,
        }
      })
      .filter((entry) => entry !== null),
    annotations: (existing?.annotations ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)),
    entries: entries.sort(
      (a, b) => a.importer.localeCompare(b.importer) || a.name.localeCompare(b.name),
    ),
  }
}

export const DEFAULT_KINDS = {
  runtime: 'shipped code the product executes (browser, worker or CLI runtime)',
  test: 'only test suites, test runners, coverage or fixtures use it',
  'type-only': 'TypeScript declarations only; contributes no runtime code',
  config:
    'consumed by a build/lint/format configuration file or a tool configuration string; not shipped',
  bin: 'invoked as an executable by package scripts or CI',
  workspace: 'internal @assay package link, not a third-party dependency',
}

export const DEFAULT_LIMITS = [
  'Literal, line-anchored use-site evidence only: a dependency consumed implicitly has no site and says so in its annotation instead of inventing one.',
  'At most 10 use sites are stored per entry; useSiteCount stays exact, so a change beyond the stored head is caught by the count rather than the list.',
  'Only direct declarations are listed; transitive packages are out of scope.',
  'engines/peerDependencies are read from the installed package metadata, not from the registry.',
  'Engine and peer ranges are recorded as data; range compatibility is not decided here.',
  'engines/peerDependencies come from the installed packages, so a lock that resolves platform-specific optional dependencies can legitimately change them; --check reports that as metadata drift instead of passing silently.',
  'Installed byte sizes live in the measurements report, never here: install size is not bundle weight.',
]

export const DEFAULT_REVIEW_CONCLUSION = {
  claim:
    'The accepted 31-name dependency review found no verified behaviour-equivalent built-in module or <20-line replacement for any external direct dependency.',
  status: 'retained',
  evidence:
    '31 external direct names, no name reached the "equivalence proven" verdict; every name is annotated `none proven` with its observed API surface and use sites. This manifest does not remove or upgrade any dependency; see the removal policy in docs/engineering/10-dependency-and-bundle-measurements.md §10.',
}

/**
 * `pnpm-workspace.yaml` catalog specifiers, keyed `catalog\u0000name`.
 * Handles the flat `catalog:` block this repository uses and the named
 * `catalogs:` form, without a YAML dependency.
 */
export function parseCatalogSpecifiers(text) {
  const out = {}
  let mode = null
  let catalogName = null
  for (const line of text.split('\n')) {
    if (/^\s*(?:#|$)/.test(line)) continue
    const trimmed = line.trim()
    const indent = line.length - line.trimStart().length
    if (indent === 0) {
      mode = trimmed === 'catalog:' ? 'flat' : trimmed === 'catalogs:' ? 'named' : null
      catalogName = null
      continue
    }
    if (mode === null) continue
    if (mode === 'named' && catalogName === null) {
      catalogName = trimmed.replace(/:$/, '').replace(/'/g, '')
      continue
    }
    const entry = /^'?([^':]+)'?:\s*(\S+)\s*$/.exec(trimmed)
    if (entry === null) continue
    const catalog = mode === 'flat' ? 'default' : catalogName
    if (catalog !== null) out[`${catalog}\u0000${entry[1]}`] = entry[2]
  }
  return out
}

function siteSignature(site) {
  return `${site.file}:${site.line}:${site.via}:${(site.symbols ?? []).join(',')}`
}

/** Structured comparison of the committed manifest with a freshly derived one. */
export function compareManifests(committed, derived) {
  const findings = []
  if (committed === null) {
    findings.push({ code: 'manifest-missing', message: `${MANIFEST_PATH} cannot be parsed` })
    return findings
  }
  const entryKey = (entry) => `${entry.importer}\u0000${entry.name}`
  const committedEntries = new Map(
    (committed.entries ?? []).map((entry) => [entryKey(entry), entry]),
  )
  const derivedEntries = new Map((derived.entries ?? []).map((entry) => [entryKey(entry), entry]))

  for (const [key, entry] of derivedEntries) {
    const committedEntry = committedEntries.get(key)
    if (committedEntry === undefined) {
      findings.push({
        code: 'declaration-missing',
        importer: entry.importer,
        name: entry.name,
        message: `declared in ${entry.section} but absent from the manifest — run --write and annotate it`,
      })
      continue
    }
    for (const field of ['section', 'declared', 'declaredRange', 'catalog', 'locked', 'source']) {
      if (JSON.stringify(committedEntry[field]) !== JSON.stringify(entry[field])) {
        findings.push({
          code: 'field-drift',
          importer: entry.importer,
          name: entry.name,
          message: `${field}: manifest ${JSON.stringify(committedEntry[field])} — derived ${JSON.stringify(entry[field])}`,
        })
      }
    }
    for (const field of ['engines', 'peerDependencies']) {
      if (JSON.stringify(committedEntry[field]) !== JSON.stringify(entry[field])) {
        findings.push({
          code: 'metadata-drift',
          importer: entry.importer,
          name: entry.name,
          message: `${field}: manifest ${JSON.stringify(committedEntry[field])} — installed ${JSON.stringify(entry[field])}`,
        })
      }
    }
    if (committedEntry.useSiteCount !== entry.useSiteCount) {
      findings.push({
        code: 'use-sites-drift',
        importer: entry.importer,
        name: entry.name,
        message: `useSiteCount: manifest ${committedEntry.useSiteCount} — derived ${entry.useSiteCount}`,
      })
    }
    const committedSites = (committedEntry.useSites ?? []).map(siteSignature)
    const derivedSites = (entry.useSites ?? []).map(siteSignature)
    if (JSON.stringify(committedSites) !== JSON.stringify(derivedSites)) {
      findings.push({
        code: 'use-sites-drift',
        importer: entry.importer,
        name: entry.name,
        message: `stored use sites differ from the scan — run --write`,
      })
    }
    for (const field of ['kind', 'rationale', 'pinRationale']) {
      if (JSON.stringify(committedEntry[field]) !== JSON.stringify(entry[field])) {
        findings.push({
          code: 'annotation-drift',
          importer: entry.importer,
          name: entry.name,
          message: `${field} differs from the annotation or generated text — run --write`,
        })
      }
    }
  }

  for (const [key, entry] of committedEntries) {
    if (!derivedEntries.has(key)) {
      findings.push({
        code: 'stale-entry',
        importer: entry.importer,
        name: entry.name,
        message: 'in the manifest but no longer declared anywhere',
      })
    }
  }

  const annotations = new Map((committed.annotations ?? []).map((entry) => [entry.name, entry]))
  const externalNames = new Set(
    (derived.entries ?? [])
      .filter((entry) => entry.source === 'external')
      .map((entry) => entry.name),
  )
  for (const name of [...externalNames].sort()) {
    const annotation = annotations.get(name)
    if (annotation === undefined) {
      findings.push({
        code: 'unannotated',
        name,
        message: 'external direct dependency without a hand-verified kind/rationale annotation',
      })
      continue
    }
    if (!KINDS.includes(annotation.kind)) {
      findings.push({
        code: 'invalid-kind',
        name,
        message: `kind ${JSON.stringify(annotation.kind)} is not one of ${KINDS.join(', ')}`,
      })
    }
    if (typeof annotation.rationale !== 'string' || annotation.rationale.trim() === '') {
      findings.push({ code: 'missing-rationale', name, message: 'annotation has no rationale' })
    }
  }
  for (const annotation of committed.annotations ?? []) {
    if (!externalNames.has(annotation.name)) {
      findings.push({
        code: 'stale-annotation',
        name: annotation.name,
        message: 'annotation for a name that is no longer a declared external dependency',
      })
    }
  }

  for (const importer of derived.importers ?? []) {
    const committedImporter = (committed.importers ?? []).find(
      (entry) => entry.path === importer.path,
    )
    if (committedImporter === undefined) {
      findings.push({
        code: 'importer-missing',
        importer: importer.path,
        message: 'workspace importer absent from the manifest',
      })
    }
  }

  return findings
}

const USAGE = `Usage: node scripts/dependency-report.mjs [--check|--write|--json|--help]

Derives the dependency-use manifest from the manifests, pnpm-lock.yaml and a
source scan, then compares it with the committed
${MANIFEST_PATH}. It never installs, downloads, builds, packs or
probes the registry.

  --check  (default) compare; exit 1 on any drift
  --write  regenerate the derived fields, preserving hand-verified annotations
  --json   print the derived entries
  --help   this message`

export function parseArgs(argv) {
  const options = { mode: 'check' }
  for (const arg of argv) {
    if (arg === '--check') options.mode = 'check'
    else if (arg === '--write') options.mode = 'write'
    else if (arg === '--json') options.mode = 'json'
    else if (arg === '--help' || arg === '-h') options.mode = 'help'
    else return { error: `unknown argument: ${arg}` }
  }
  return { options }
}

/** Serialize with stable key order and two-space indent (prettier-compatible). */
export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

export function formatFindings(findings) {
  return findings
    .map((finding) => {
      const where = [finding.importer, finding.name].filter(Boolean).join(' ')
      return `${where === '' ? '' : `${where}: `}[${finding.code}] ${finding.message}`
    })
    .join('\n')
}

export function main(argv, deps = createRepoDeps(), writeFile = null) {
  const parsed = parseArgs(argv)
  if (parsed.error !== undefined) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}\n`)
    return 2
  }
  const { mode } = parsed.options
  if (mode === 'help') {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const committedText = deps.readText(MANIFEST_PATH)
  const committed = committedText === null ? null : parseJson(committedText)
  const derived = deriveManifest(deps, committed)

  if (mode === 'json') {
    process.stdout.write(`${JSON.stringify(derived.entries, null, 2)}\n`)
    return 0
  }

  if (mode === 'write') {
    const missingAnnotations = derived.entries
      .filter((entry) => entry.source === 'external')
      .map((entry) => entry.name)
      .filter(
        (name, index, names) =>
          names.indexOf(name) === index &&
          !(committed?.annotations ?? []).some((annotation) => annotation.name === name),
      )
    if (missingAnnotations.length > 0) {
      process.stderr.write(
        `dependency-report: ${missingAnnotations.length} external name(s) have no annotation yet:\n` +
          `${missingAnnotations.map((name) => `  - ${name}`).join('\n')}\n` +
          'Add them to `annotations` (kind + rationale) before writing; this script does not invent intent.\n',
      )
      return 1
    }
    const writer = writeFile ?? ((relPath, text) => deps.writeText(relPath, text))
    writer(MANIFEST_PATH, serializeManifest(derived))
    process.stdout.write(
      `dependency-report: wrote ${MANIFEST_PATH} (${derived.entries.length} entries, ${derived.annotations.length} annotations)\n`,
    )
    return 0
  }

  const findings = compareManifests(committed, derived)
  if (findings.length > 0) {
    process.stderr.write(
      `${formatFindings(findings)}\n\ndependency-report: ${findings.length} finding(s); run --write for derived drift, annotate for a new dependency.\n`,
    )
    return 1
  }
  process.stdout.write(
    `dependency-report: ${derived.entries.length} entries (${derived.annotations.length} external annotations) match ${MANIFEST_PATH}\n`,
  )
  return 0
}

/* c8 ignore start — CLI entry point, exercised through `main` in tests. */
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
/* c8 ignore stop */
