import AxeBuilder from '@axe-core/playwright'
import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * Shared axe-core a11y scanning for the e2e suite (pt0-4, O3).
 *
 * Scans run fully local: `@axe-core/playwright` injects the bundled
 * `axe-core` script into the page and evaluates it in-browser — no data
 * leaves the machine (same local-first posture as the rest of the suite;
 * axe-core does not phone home). axe-core CAN fetch cross-origin stylesheets
 * when pointed at pages that have them; this app has none (CSS is bundled
 * same-origin), so no network calls happen here (reviewer pt0-4).
 *
 * The suite asserts the bar from the pt0-4 task row: **zero critical/serious
 * violations** on each real surface, with a documented, honest allowlist for
 * genuinely deferred findings. Minor/moderate findings are reported (this
 * helper's `summarizeViolations` output) but do not gate.
 */

/** axe-core results, derived from the builder so we never import axe-core directly. */
export type A11yResults = Awaited<ReturnType<AxeBuilder['analyze']>>
/** One axe rule violation (id + impact + offending nodes). */
export type A11yViolation = A11yResults['violations'][number]
/** axe impact levels (`null` is axe's "no impact assigned"). */
export type A11yImpact = A11yViolation['impact']

/** Scan scope: axe `include`/`exclude` selectors. */
export interface A11yScanOptions {
  /** Restrict the scan to these selectors (default: the whole page). */
  readonly include?: readonly string[]
  /** Exclude these selectors from the scan (default: none). */
  readonly exclude?: readonly string[]
}

/**
 * A documented deferral of a known axe violation. Every entry MUST name a
 * concrete reason and a tracking pointer (the queue/carry-over that owns the
 * fix); `assertNoCriticalOrSerious` fails if an entry stops firing, so a
 * fixed violation cannot hide behind a stale allowlist line.
 */
export interface DeferredA11yEntry {
  /** axe rule id, e.g. `color-contrast`. */
  readonly id: string
  /** The impact this entry defers (only critical/serious are gateable). */
  readonly impact: 'critical' | 'serious'
  /** Why this is deferred rather than fixed now. */
  readonly reason: string
  /** Which queue/carry-over owns the fix, e.g. `PT-0 carry-over / D12`. */
  readonly tracking: string
  /**
   * Optional scoping: the entry only covers violations whose offending node
   * matches one of these selectors (substring match against axe's node
   * target). Omit to defer the rule everywhere on the page.
   */
  readonly selectors?: readonly string[]
}

/**
 * Deferred critical/serious violations. Currently EMPTY: the pt0-4 scans found
 * two real findings (a row-actions `aria-required-children` critical and a
 * `.filter-empty` `color-contrast` serious), both fixed at the root in app
 * source, so no deferral is warranted. The mechanism stays for future
 * deferrals: every entry MUST carry a concrete reason + tracking pointer, and
 * `assertNoCriticalOrSerious` fails if an entry stops firing so a fixed
 * violation cannot hide behind a stale line.
 */
export const DEFERRED_A11Y: readonly DeferredA11yEntry[] = []

/** Run axe on `page` (whole page by default; scope with include/exclude). */
export async function scanA11y(page: Page, options: A11yScanOptions = {}): Promise<A11yResults> {
  let builder = new AxeBuilder({ page })
  for (const selector of options.include ?? []) builder = builder.include(selector)
  for (const selector of options.exclude ?? []) builder = builder.exclude(selector)
  return builder.analyze()
}

/** True when `target` (axe's node target) contains `selector` as a substring. */
function targetMatches(
  target: A11yViolation['nodes'][number]['target'],
  selector: string,
): boolean {
  return target.some((part) => (typeof part === 'string' ? part.includes(selector) : false))
}

/** True when an allowlist entry covers this violation. */
function isAllowed(violation: A11yViolation, entry: DeferredA11yEntry): boolean {
  if (violation.id !== entry.id) return false
  if (violation.impact !== entry.impact) return false
  if (entry.selectors === undefined) return true
  return violation.nodes.some((node) =>
    (entry.selectors ?? []).some((selector) => targetMatches(node.target, selector)),
  )
}

/** A human-readable one-violation-per-line summary (all impacts, for reports). */
export function summarizeViolations(violations: readonly A11yViolation[]): string {
  if (violations.length === 0) return 'no violations'
  return violations
    .map(
      (violation) =>
        `- ${violation.id} [${violation.impact ?? 'none'}] ×${String(violation.nodes.length)}: ${violation.help}`,
    )
    .join('\n')
}

/**
 * Assert no UNALLOWLISTED critical/serious violations fired, and that the
 * allowlist is honest (every entry still fires). Fails with two distinct,
 * actionable messages so a real regression is never confused with a stale
 * allowlist line.
 */
export function assertNoCriticalOrSerious(
  violations: readonly A11yViolation[],
  allowlist: readonly DeferredA11yEntry[] = DEFERRED_A11Y,
): void {
  const actionable = violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious',
  )

  const usedEntries = new Set<DeferredA11yEntry>()
  const unexpected: A11yViolation[] = []
  for (const violation of actionable) {
    const entry = allowlist.find((candidate) => isAllowed(violation, candidate))
    if (entry === undefined) unexpected.push(violation)
    else usedEntries.add(entry)
  }
  const stale = allowlist.filter((entry) => !usedEntries.has(entry))

  expect(
    unexpected.map(
      (violation) =>
        `${violation.id} [${violation.impact ?? 'none'}] ×${String(violation.nodes.length)}: ${violation.help}`,
    ),
    'unexpected critical/serious a11y violations (not allowlisted) — fix in app code, or add a DEFERRED_A11Y entry with a concrete reason + tracking pointer',
  ).toEqual([])

  expect(
    stale.map((entry) => `${entry.id} [${entry.impact}] tracking=${entry.tracking}`),
    'stale DEFERRED_A11Y entries — the violation no longer fires; remove the allowlist entry (allowlist entries must stay honest)',
  ).toEqual([])
}
