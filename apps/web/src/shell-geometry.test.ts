// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * uxv-3 / R-11: source pins for the fluid desktop canvas (spec §4 "Geometry").
 *
 * The load-bearing evidence is the real-browser matrix in
 * `tests/e2e/shell.spec.ts` (gutters/main/pane/gap/grid column at all four
 * samples, the ≤140px ready-workspace top, the clamped grid viewport height
 * and the 1024×700 first-paint acceptance). These are the cheap structural
 * pins on the stylesheet those measurements depend on — the shapes a later
 * "just put the width cap back" or "hard-code 480px again" edit would break
 * long before a browser is launched:
 *
 * 1. no `main` width cap: the page inset is the only horizontal inset, so the
 *    shell is exactly `viewport − 2 × gutter` wide;
 * 2. the gutter step (16px → 24px at 1440px) and the pane step (320px →
 *    360px at 1200px) with a 16px gap between the tracks;
 * 3. the preserved collapsed-rail track at ≥1024px (ADR 0044);
 * 4. the grid viewport follows the window between a 280px floor and a 640px
 *    ceiling, with the `vh` fallback declared BEFORE the `dvh` line.
 *
 * No value here is invented: every expectation is read back from the same
 * stylesheet the browser loads (`index.css`), and the comment text is stripped
 * first so prose cannot satisfy a pin.
 */

const STYLESHEET = readFileSync(resolve(process.cwd(), 'apps', 'web', 'src', 'index.css'), 'utf8')

/** Stylesheet with comments removed (prose must never satisfy a pin). */
const CSS = STYLESHEET.replace(/\/\*[\s\S]*?\*\//g, '')

interface CssRule {
  readonly selectors: readonly string[]
  readonly body: string
}

/** Flat rule extractor; at-rule preludes are skipped (design-tokens pattern). */
function parseRules(css: string): CssRule[] {
  const rules: CssRule[] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let match: RegExpExecArray | null
  while ((match = re.exec(css)) !== null) {
    const selectorText = match[1]?.trim() ?? ''
    if (selectorText.startsWith('@')) continue
    rules.push({
      selectors: selectorText
        .split(',')
        .map((selector) => selector.trim())
        .filter((selector) => selector.length > 0),
      body: match[2] ?? '',
    })
  }
  return rules
}

const RULES = parseRules(CSS)

/** Every declaration body whose selector list names `selector`, in file order. */
function bodiesFor(selector: string): string[] {
  return RULES.filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.body)
}

/** The declaration body of the at-rule block opened by `prelude`. */
function mediaBlock(prelude: string): string {
  const start = CSS.indexOf(prelude)
  if (start < 0) throw new Error(`missing at-rule: ${prelude}`)
  // The block ends at the first `}` that closes it; nested rules make a full
  // parse unnecessary because every assertion below is a substring/structure
  // check on the prelude's own slice up to the next at-rule.
  const next = CSS.indexOf('@media', start + prelude.length)
  return CSS.slice(start, next < 0 ? CSS.length : next)
}

describe('uxv-3 / R-11 fluid desktop canvas', () => {
  it('leaves main uncapped so the page inset is the only horizontal inset', () => {
    const capped = RULES.filter(
      (rule) => rule.selectors.includes('main') && /max-width/.test(rule.body),
    )
    expect(
      capped.map((rule) => rule.body),
      'no main { max-width } cap: the shell must fill viewport − 2 × gutter',
    ).toEqual([])
    expect(CSS, 'the 1152px (72rem) width cap is gone from the stylesheet').not.toMatch(
      /max-width:\s*72rem/,
    )
  })

  it('steps the page gutter 16px → 24px at 1440px', () => {
    const body = bodiesFor('body').join('\n')
    expect(body, 'body padding is the 16px gutter step').toMatch(/padding:\s*var\(--space-4\)/)
    expect(
      mediaBlock('@media (min-width: 1440px)'),
      'the 24px gutter step lives at 1440px',
    ).toMatch(/body\s*\{[^}]*padding:\s*var\(--space-6\)/)
  })

  it('uses the 16px gap, the 320px pane step and the 360px step at 1200px', () => {
    const desktop = mediaBlock('@media (min-width: 1024px)')
    expect(desktop, 'pane track: fixed 320px beside a fluid center column').toMatch(
      /grid-template-columns:\s*320px minmax\(0, 1fr\)/,
    )
    expect(desktop, 'pane/grid gap is the 16px space token').toMatch(/gap:\s*var\(--space-4\)/)
    expect(desktop, 'the collapsed rail keeps its own attribute-scoped track (ADR 0044)').toMatch(
      /grid-template-columns:\s*2\.5rem minmax\(0, 1fr\)/,
    )

    const wide = mediaBlock('@media (min-width: 1200px)')
    expect(wide, 'the pane grows to 360px at 1200px').toMatch(
      /grid-template-columns:\s*360px minmax\(0, 1fr\)/,
    )
  })

  it('bounds the grid viewport with a vh fallback before the dvh clamp', () => {
    const bodies = bodiesFor('.grid-viewport').join('\n')
    expect(bodies, 'no hard-coded 480px viewport height').not.toMatch(/height:\s*480px/)
    const fallback = bodies.indexOf('clamp(280px, calc(100vh - 360px), 640px)')
    const dynamic = bodies.indexOf('clamp(280px, calc(100dvh - 360px), 640px)')
    expect(
      fallback,
      'the clamp keeps the 280px floor, the 360px chrome reserve and the 640px ceiling',
    ).toBeGreaterThanOrEqual(0)
    expect(dynamic, 'the dvh clamp is declared too').toBeGreaterThanOrEqual(0)
    expect(
      dynamic,
      'the vh fallback is declared FIRST so dvh wins where supported',
    ).toBeGreaterThan(fallback)
  })
})
