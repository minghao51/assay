#!/usr/bin/env node
/**
 * check-doc-links.mjs — verify that every *relative* Markdown link target in
 * `docs/**\/*.md` and the root-level `*.md` files resolves to a real path on
 * disk.
 *
 * Covered forms:
 *   - inline links `[text](target)` and images `![alt](target)` written on a
 *     single line, including CommonMark titles (`"…"`, `'…'`, `(…)`) and
 *     `<…>` destinations, with escaped `\)`/`\(` handled;
 *   - reference-definition targets `[ref]: target` (the definition line is
 *     resolved; reference *uses* are therefore checked through their
 *     definition).
 *
 * Deliberately NOT covered (do not widen this claim without implementing it):
 *   - multi-line link text, i.e. a `]` on one line and its `(` opening on a
 *     later line (this checker scans line by line);
 *   - indented code blocks (fenced code blocks are skipped).
 *
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
// `[ref]: target`, where target is `<…>` (may contain spaces) or a bare token.
const REFERENCE_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/

/** Remove inline code spans so backticked examples are not scanned as links. */
function stripCodeSpans(line) {
  return line.replace(CODE_SPAN, '')
}

/** Strip a single layer of `<…>` and any `#fragment`/`?query` suffix. */
function normalizeDestination(raw) {
  let dest = raw.trim()
  if (dest.startsWith('<') && dest.endsWith('>')) dest = dest.slice(1, -1)
  return dest.split(/[#?]/, 1)[0]
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

/**
 * Extract the destinations of every inline `[text](dest "title")` / image link
 * on one line. Understands `<…>` destinations, CommonMark titles in `"…"`,
 * `'…'`, or `(…)` form, and backslash-escaped punctuation in the destination.
 */
export function inlineDestinations(line) {
  const destinations = []
  let i = 0
  while (i < line.length) {
    const open = line.indexOf('](', i)
    if (open === -1) break
    let j = open + 2
    while (j < line.length && /\s/.test(line[j])) j += 1
    if (j >= line.length) break

    let dest
    if (line[j] === '<') {
      // Angle-bracket destination: runs to the next unescaped `>`.
      j += 1
      let buffer = ''
      let closed = false
      while (j < line.length) {
        if (line[j] === '\\' && j + 1 < line.length) {
          buffer += line[j + 1]
          j += 2
          continue
        }
        if (line[j] === '>') {
          closed = true
          j += 1
          break
        }
        buffer += line[j]
        j += 1
      }
      if (!closed) {
        i = open + 2
        continue
      }
      dest = buffer
    } else {
      // Bare destination: runs to unescaped whitespace or `)`.
      let buffer = ''
      while (j < line.length) {
        const ch = line[j]
        if (ch === '\\' && j + 1 < line.length) {
          buffer += line[j + 1]
          j += 2
          continue
        }
        if (ch === ')' || /\s/.test(ch)) break
        buffer += ch
        j += 1
      }
      dest = buffer
    }

    // Optional whitespace + a CommonMark title ("…", '…', or (…)).
    let k = j
    while (k < line.length && /\s/.test(line[k])) k += 1
    if (k < line.length && (line[k] === '"' || line[k] === "'" || line[k] === '(')) {
      const closer = line[k] === '(' ? ')' : line[k]
      k += 1
      while (k < line.length) {
        if (line[k] === '\\' && k + 1 < line.length) {
          k += 2
          continue
        }
        if (line[k] === closer) {
          k += 1
          break
        }
        k += 1
      }
    }

    if (k < line.length && line[k] === ')') {
      destinations.push(dest)
      i = k + 1
      continue
    }
    // Not actually a well-formed inline link; keep scanning after `](`.
    i = open + 2
  }
  return destinations
}

/** Extract the target of a reference-style definition `[ref]: target`. */
export function referenceDestination(line) {
  const match = REFERENCE_DEFINITION.exec(line)
  return match ? match[1] : null
}

/** Resolve one raw destination against `filePath`; return it if broken. */
function brokenTarget(filePath, raw) {
  const dest = normalizeDestination(raw)
  if (dest === '' || isExternal(dest)) return null
  let target = dest
  try {
    target = decodeURIComponent(dest)
  } catch {
    // A malformed escape is not a valid relative path either; fall back.
  }
  return existsSync(resolve(dirname(filePath), target)) ? null : raw
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
    const candidates = inlineDestinations(scanned)
    const reference = referenceDestination(scanned)
    if (reference !== null) candidates.push(reference)

    for (const raw of candidates) {
      if (brokenTarget(filePath, raw) !== null) broken.push({ line: i + 1, target: raw })
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
