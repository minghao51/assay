#!/usr/bin/env node
/**
 * netlify-deploy-url.mjs — read the deploy result out of a `netlify deploy --json`
 * log so the collector workflow can hand its URL to the live probe.
 *
 * Why this exists (2026-11-27, run 45992312947): the workflow used to extract the
 * payload with `grep -a '^{' | tail -n 1`, which assumes COMPACT JSON on one line.
 * `netlify deploy --json` prints PRETTY-PRINTED JSON, so that grep matched only the
 * lone opening brace, `jq` got `{`, and the step died with "the CLI printed no site
 * URL" — after a deploy that had in fact succeeded (deploy id 6b096c5a…, URL
 * https://assay-dataworkbench.netlify.app). The probe step never ran, so a green
 * deploy was reported as a failure and nothing was verified. The failed regex was
 * correct about `url` being a flat top-level key; it was wrong about the SHAPE.
 *
 * What this proves: the last JSON object in the log parses as JSON, carries a
 * non-empty string `url`, and that `url` is an absolute `http(s)` URL. Human noise
 * before, after or between documents is ignored — the last parsable object wins,
 * which is the deploy the CLI finished with.
 *
 * Deliberately NOT covered (do not widen this claim without implementing it):
 *   - the deploy's own exit status (the workflow checks that separately),
 *   - that the URL actually serves the function — that is the `--probe` step,
 *   - any field beyond `url` (site name and deploy id are passed through verbatim
 *     for the step summary and may be empty),
 *   - a JSON payload written to another destination: this reads the log it is given.
 *
 * Usage: `node scripts/netlify-deploy-url.mjs <log-path> [more-log-paths…]` prints
 * one tab-separated line `url\tsite_name\tdeploy_id` on stdout and exits 0, or
 * writes the reason on stderr and exits 1. Multiple paths are concatenated in the
 * given order and the LAST parsable object wins, so the workflow can hand it both
 * the CLI's stdout payload and its stderr log without deciding which one holds it.
 * Zero dependencies, offline, deterministic.
 */
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { URL } from 'node:url'

/**
 * The end index (inclusive) of the balanced `{…}` block starting at `start`, or
 * `-1`. String-aware: braces inside a JSON string do not move the depth.
 *
 * @param {string} text
 * @param {number} start index of the `{`
 * @returns {number}
 */
function matchObjectEnd(text, start) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * The last parsable JSON object in `text`, or `null`. A block that looks like JSON
 * but does not parse is skipped in favour of trying an inner start, so an unbalanced
 * brace in human noise cannot swallow the real payload.
 *
 * @param {string} text
 * @returns {Record<string, unknown> | null}
 */
export function lastJsonObject(text) {
  let found = null
  let i = 0
  while (i < text.length) {
    const start = text.indexOf('{', i)
    if (start === -1) break
    const end = matchObjectEnd(text, start)
    if (end === -1) {
      i = start + 1
      continue
    }
    try {
      const parsed = JSON.parse(text.slice(start, end + 1))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        found = parsed
        i = end + 1
        continue
      }
    } catch {
      // Not JSON — fall through and retry from the next brace.
    }
    i = start + 1
  }
  return found
}

/** A non-empty trimmed string field, or `''`. */
function field(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Resolve the deploy result from a CLI log.
 *
 * @param {string} text
 * @returns {{ ok: true, url: string, siteName: string, deployId: string }
 *   | { ok: false, reason: 'no-object' | 'unparsable' | 'missing-url' | 'invalid-url', detail: string }}
 */
export function deployResultFromLog(text) {
  if (!text.includes('{')) {
    return { ok: false, reason: 'no-object', detail: 'the CLI printed no JSON object' }
  }
  const payload = lastJsonObject(text)
  if (payload === null) {
    return {
      ok: false,
      reason: 'unparsable',
      detail: 'the CLI printed a brace-delimited block, but it is not valid JSON',
    }
  }
  const url = field(payload.url)
  if (url === '') {
    const keys = Object.keys(payload).sort().join(', ')
    return {
      ok: false,
      reason: 'missing-url',
      detail: `the deploy JSON has no non-empty string "url" (keys: ${keys || 'none'})`,
    }
  }
  let protocol
  try {
    protocol = new URL(url).protocol
  } catch {
    protocol = ''
  }
  if (protocol !== 'https:' && protocol !== 'http:') {
    // The URL becomes a probe target and a step summary. Refuse anything that is
    // not an absolute http(s) URL instead of interpolating an unknown shape.
    return {
      ok: false,
      reason: 'invalid-url',
      detail: `"url" is not an absolute http(s) URL: ${url}`,
    }
  }
  return {
    ok: true,
    url,
    siteName: field(payload.site_name),
    deployId: field(payload.deploy_id),
  }
}

function main(argv) {
  const logPaths = argv.slice(2)
  if (logPaths.length === 0) {
    process.stderr.write(
      'usage: node scripts/netlify-deploy-url.mjs <log-path> [more-log-paths…]\n',
    )
    return 2
  }
  const parts = []
  for (const logPath of logPaths) {
    try {
      parts.push(readFileSync(logPath, 'utf8'))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      process.stderr.write(`cannot read ${logPath}: ${reason}\n`)
      return 2
    }
  }
  const result = deployResultFromLog(parts.join('\n'))
  if (!result.ok) {
    process.stderr.write(`deploy result unreadable (${result.reason}): ${result.detail}\n`)
    return 1
  }
  process.stdout.write(`${result.url}\t${result.siteName}\t${result.deployId}\n`)
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv)
}
