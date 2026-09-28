#!/usr/bin/env node
/**
 * check-doc-links.mjs — verify that every *relative* Markdown link target in
 * `docs/**\/*.md` and the root-level `*.md` files resolves to a real path on
 * disk.
 *
 * Only the inline forms `[text](target)` and `![alt](target)` are checked.
 * Skipped targets: absolute URLs (`http(s)://`), `mailto:`/`tel:`, any other
 * `scheme:` prefix, protocol-relative `//`, and pure `#anchor` links. Fenced
 * code blocks (``` / ~~~) and inline code spans are ignored so examples and
 * glob patterns are not mistaken for links.
 *
 * `#fragment` and `?query` suffixes are stripped before resolving; `%20`-style
 * escapes are URL-decoded. A target that resolves to a directory is fine.
 *
 * Plain Node ≥22, zero dependencies, deterministic. Run `pnpm docs:links:check`
 * (write/no-op `pnpm docs:links` is kept for parity with `adr:index`).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const scriptDir = dirname(fileURLToPath(import.meta.url))
export const repoRoot = resolve(scriptDir, '..')
const docsDir = join(repoRoot, 'docs')

/** Recursively collect every `*.md` path under `dir`. */
function collectMarkdown(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...collectMarkdown(full))
    else if (entry.isFile() && entry.name.endsWith('.md')) found.push(full)
  }
  return found
}

/** The checked file set: all `docs/**\/*.md` plus root-level `*.md`. */
export function markdownFiles() {
  const rootDocs = readdirSync(repoRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => join(repoRoot, entry.name))
  return [...collectMarkdown(docsDir), ...rootDocs].sort()
}

const FENCE = /^\s*(```|~~~)/
const CODE_SPAN = /(`+)([^`]*?)\1/g
const LINK = /!?\[[^\]]*\]\(([^)]+)\)/g

/** Remove inline code spans so backticked examples are not scanned as links. */
function stripCodeSpans(line) {
  return line.replace(CODE_SPAN, '')
}

/** True for links that are not relative filesystem paths. */
function isExternal(target) {
  return (
    target.startsWith('http://') ||
    target.startsWith('https://') ||
    target.startsWith('mailto:') ||
    target.startsWith('tel:') ||
    target.startsWith('//') ||
    target.startsWith('#') ||
    // Any other explicit `scheme:` (e.g. `vscode:`, `data:`).
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)
  )
}

/** Extract every broken relative link from one file's contents. */
export function checkFile(filePath) {
  const broken = []
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
  let inFence = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (FENCE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    const scanned = stripCodeSpans(line)
    for (const match of scanned.matchAll(LINK)) {
      const raw = match[1].trim().replace(/^<|>$/g, '')
      if (isExternal(raw)) continue
      const withoutQuery = raw.split(/[#?]/, 1)[0]
      if (withoutQuery === '') continue
      let target = withoutQuery
      try {
        target = decodeURIComponent(withoutQuery)
      } catch {
        // A malformed escape is not a valid relative path either; fall back.
      }
      const resolved = resolve(dirname(filePath), target)
      if (!existsSync(resolved)) {
        broken.push({ line: i + 1, target: raw })
      }
    }
  }
  return broken
}

function main() {
  const files = markdownFiles()
  const broken = []
  for (const file of files) {
    for (const miss of checkFile(file)) broken.push({ file, ...miss })
  }

  if (broken.length === 0) {
    process.stdout.write(`docs:links:check — OK (${files.length} files, 0 broken links)\n`)
    return 0
  }
  for (const { file, line, target } of broken) {
    process.stdout.write(`${relative(repoRoot, file)}:${line}: broken relative link -> ${target}\n`)
  }
  process.stdout.write(`docs:links:check — FAIL: ${broken.length} broken relative link(s)\n`)
  return 1
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  process.exitCode = main()
}
