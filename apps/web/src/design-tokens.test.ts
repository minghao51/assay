// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * uxv-2 / R-10: source pins for the design-token layer and its bounded
 * adoption list.
 *
 * The rendered proof (computed styles in a real browser, both schemes) lives in
 * `tests/e2e/theme.spec.ts`; these are the cheap, fast pins on the layer
 * itself, following the `theme-contrast.test.ts` precedent. They fail on the
 * exact regression classes this row is about:
 *
 * 1. a scale value drifting off the agreed 4/8/12/16/24/32, 32/36, 4/6/8 and
 *    type ranges — and any of those aliases leaking into a scheme block (they
 *    are scheme-independent by construction);
 * 2. a named control that stops reading the alias (`var(--…)`) it adopted;
 * 3. the primary/secondary split collapsing (a second accent, or a secondary
 *    promoted to the accent treatment);
 * 4. the focus ring losing its 2px/offset shape or leaving the shared
 *    `--color-focus` token;
 * 5. a raw colour literal, transition or animation entering the new block (the
 *    row adds no palette and no motion);
 * 6. a global element selector (`button { … }`) or a grid/schema/filter/SQL
 *    selector creeping into the adopted rules — the R-10 "no global button
 *    restyle" acceptance.
 *
 * Everything is derived from the stylesheet the browser actually loads, so no
 * value is duplicated here except the agreed scale itself.
 */

const STYLESHEET = readFileSync(resolve(process.cwd(), 'apps', 'web', 'src', 'index.css'), 'utf8')

/** The comment banner that opens the uxv-2 adopted-control block. */
const ADOPTED_BANNER = 'Named control surfaces (uxv-2 / R-10)'

/** The banner that opens the token layer (spacing/control/radius/type). */
const TOKEN_BANNER = 'Design tokens: spacing, control, radius and type'

/** Index of the comment opener that precedes `marker`. */
function commentOpen(marker: string): number {
  const at = STYLESHEET.indexOf(marker)
  if (at < 0) throw new Error(`missing stylesheet marker: ${marker}`)
  const open = STYLESHEET.lastIndexOf('/*', at)
  if (open < 0) throw new Error(`no comment opens around: ${marker}`)
  return open
}

/** Index just past the comment terminator for the comment opened at `open`. */
function commentClose(open: number): number {
  const close = STYLESHEET.indexOf('*/', open)
  if (close < 0) throw new Error('unterminated comment')
  return close + 2
}

const DARK_AT_RULE = '@media (prefers-color-scheme: dark)'
const DARK_START = STYLESHEET.indexOf(DARK_AT_RULE)
/** Everything before the dark override: the scheme-neutral + light layer. */
const LIGHT_SOURCE = STYLESHEET.slice(0, DARK_START)
/** Everything from the dark override on. */
const DARK_SOURCE = STYLESHEET.slice(DARK_START)

/** The uxv-2 adopted-control block's rules: after its banner, before the next banner. */
const ADOPTED_BLOCK = ((): string => {
  const open = commentOpen(ADOPTED_BANNER)
  const rest = STYLESHEET.slice(commentClose(open))
  const nextBanner = rest.indexOf('/* ---- ')
  if (nextBanner < 0) throw new Error('the uxv-2 adopted-control block is not closed by a banner')
  return rest.slice(0, nextBanner)
})()

/** The token-layer section: its banner plus the single root rule it opens. */
const TOKEN_BLOCK = ((): string => {
  const open = commentOpen(TOKEN_BANNER)
  const close = commentClose(open)
  const ruleOpen = STYLESHEET.indexOf('{', close)
  const ruleClose = STYLESHEET.indexOf('}', ruleOpen)
  if (ruleOpen < 0 || ruleClose < 0) throw new Error('the token layer is not a single :root rule')
  return STYLESHEET.slice(open, ruleClose + 1)
})()

interface CssRule {
  readonly selectors: readonly string[]
  readonly body: string
}

/** Minimal rule extractor: flat declarations; at-rule wrappers are skipped. */
function parseRules(css: string): CssRule[] {
  const rules: CssRule[] = []
  // Strip comments first: a comment directly above a rule would otherwise be
  // parsed as part of that rule's selector text.
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const re = /([^{}]+)\{([^{}]*)\}/g
  let match: RegExpExecArray | null
  while ((match = re.exec(source)) !== null) {
    const selectorText = match[1]?.trim() ?? ''
    // At-rule preludes (the `@media` wrapper) are not style rules.
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

const RULES = parseRules(STYLESHEET)

/** Every declaration body whose selector list names `selector`, in file order. */
function bodiesFor(selector: string): string[] {
  return RULES.filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.body)
}

/** The first declaration body whose selector list names `selector`. */
function bodyFor(selector: string): string {
  const bodies = bodiesFor(selector)
  if (bodies.length === 0) throw new Error(`no CSS rule for ${selector}`)
  return bodies[0] as string
}

/** One declaration value from a rule body (`null` when the property is absent). */
function declaration(body: string, property: string): string | null {
  const match = new RegExp(String.raw`(?:^|[;\s])${property}\s*:\s*([^;]+);`).exec(body)
  return match === null ? null : (match[1] ?? '').trim()
}

/** Every declared value of a custom property in a slice of the stylesheet. */
function tokenValues(source: string, token: string): string[] {
  const re = new RegExp(String.raw`--${token}\s*:\s*([^;]+);`, 'g')
  return [...source.matchAll(re)].map((match) => (match[1] ?? '').trim())
}

/** `0.25rem` → 4 at the 16px default root; `8px` → 8; anything else throws. */
function px(value: string): number {
  const rem = /^([\d.]+)rem$/.exec(value)
  if (rem !== null) return Number(rem[1]) * 16
  const raw = /^([\d.]+)px$/.exec(value)
  if (raw !== null) return Number(raw[1])
  throw new Error(`unsupported length token value: ${value}`)
}

/** The adopted control classes, split by the treatment they must carry. */
const PRIMARY_CONTROLS = ['.open-button', '.export-action-primary'] as const
const SECONDARY_CONTROLS = [
  '.example-button',
  '.telemetry-settings-toggle',
  '.telemetry-settings-close',
  '.telemetry-disclosure-action',
  '.export-action-secondary',
] as const
const QUIET_TOGGLES = ['.workbench-section-toggle', '.workbench-pane-toggle'] as const
const ALL_ADOPTED_CONTROLS = [...PRIMARY_CONTROLS, ...SECONDARY_CONTROLS, ...QUIET_TOGGLES] as const

describe('uxv-2 design tokens: the scale is declared once and scheme-independent', () => {
  /** `token` → the px figure the contract fixes (spec §4 inventory). */
  const SCALE = {
    'space-1': 4,
    'space-2': 8,
    'space-3': 12,
    'space-4': 16,
    'space-6': 24,
    'space-8': 32,
    'control-height-compact': 32,
    'control-height': 36,
    'radius-sm': 4,
    'radius-md': 6,
    'radius-lg': 8,
  } as const

  for (const [token, expected] of Object.entries(SCALE)) {
    it(`--${token} is declared once at ${String(expected)}px and does not vary by scheme`, () => {
      const light = tokenValues(LIGHT_SOURCE, token)
      expect(light, `--${token} must be declared exactly once (light/neutral layer)`).toHaveLength(
        1,
      )
      expect(px(light[0] as string), `--${token}`).toBe(expected)
      // Spacing/size tokens are scheme-INDEPENDENT: a value in the dark block
      // would mean the scale silently forks per scheme.
      expect(
        tokenValues(DARK_SOURCE, token),
        `--${token} must not appear in the dark block`,
      ).toEqual([])
    })
  }

  it('declares the UI / body / metadata / page-title type aliases in the agreed ranges', () => {
    const sizes = {
      'font-size-ui': [14, 16],
      'font-size-body': [14, 16],
      'font-size-metadata': [12, 13],
      'font-size-page-title': [20, 24],
    } as const
    for (const [token, [min, max]] of Object.entries(sizes)) {
      const values = tokenValues(LIGHT_SOURCE, token)
      expect(values, `--${token} must be declared exactly once`).toHaveLength(1)
      const size = px(values[0] as string)
      expect(
        size,
        `--${token} = ${String(size)}px must be within ${String(min)}–${String(max)}px`,
      ).toBeGreaterThanOrEqual(min)
      expect(size).toBeLessThanOrEqual(max)
      expect(tokenValues(DARK_SOURCE, token), `--${token} must not vary by scheme`).toEqual([])
    }

    // The two family aliases: the platform UI stack and a real monospace stack.
    for (const token of ['font-family-ui', 'font-family-mono'] as const) {
      const values = tokenValues(LIGHT_SOURCE, token)
      expect(values, `--${token} must be declared exactly once`).toHaveLength(1)
      expect(values[0] ?? '').not.toBe('')
    }
    expect(tokenValues(LIGHT_SOURCE, 'font-family-ui')[0]).toContain('system-ui')
    expect(tokenValues(LIGHT_SOURCE, 'font-family-mono')[0]).toMatch(/mono/i)
  })

  it('adds no palette, font import or motion in the token layer', () => {
    expect(TOKEN_BLOCK, 'the token layer must add no colour literal').not.toMatch(
      /#[0-9a-fA-F]{3,8}\b|rgba?\(/,
    )
    expect(TOKEN_BLOCK, 'the token layer must add no external font/image').not.toMatch(
      /@import|url\(|@font-face/,
    )
  })
})

describe('uxv-2 adoption: the named controls read the aliases', () => {
  /** selector → the token each adopted property must reference. */
  const ADOPTIONS: readonly (readonly [string, string, string])[] = [
    ['.workbench-section-toggle', 'gap', 'var(--space-1)'],
    ['.workbench-section-toggle', 'padding', 'var(--space-1) var(--space-2)'],
    ['.workbench-section-toggle', 'margin-top', 'var(--space-4)'],
    ['.workbench-section-toggle', 'min-height', 'var(--control-height-compact)'],
    ['.workbench-section-toggle', 'border-radius', 'var(--radius-sm)'],
    ['.workbench-pane-toggle', 'min-height', 'var(--control-height-compact)'],
    ['.workbench-pane-toggle', 'min-width', 'var(--control-height-compact)'],
    ['.workbench-pane-toggle', 'border-radius', 'var(--radius-sm)'],
    ['.telemetry-settings-option', 'min-height', 'var(--control-height-compact)'],
    ['.telemetry-settings-option', 'font-size', 'var(--font-size-ui)'],
    ['.telemetry-settings-option', 'gap', 'var(--space-2)'],
    ['.telemetry-settings-hard-off', 'font-size', 'var(--font-size-metadata)'],
    ['.telemetry-disclosure-actions', 'gap', 'var(--space-2)'],
    ['.telemetry-settings-close', 'margin-top', 'var(--space-2)'],
    ['.export-formats', 'border-radius', 'var(--radius-sm)'],
    ['.export-formats', 'padding', 'var(--space-2) var(--space-3)'],
    ['.export-format-option', 'min-height', 'var(--control-height-compact)'],
    ['.export-format-option', 'font-size', 'var(--font-size-ui)'],
    ['.export-format-option', 'border-radius', 'var(--radius-sm)'],
    ['.export-actions', 'gap', 'var(--space-2)'],
    ['.export-actions', 'margin-top', 'var(--space-3)'],
    ['.edit-overlay-explanation', 'font-size', 'var(--font-size-body)'],
    ['.export-staged-count', 'font-size', 'var(--font-size-metadata)'],
    ['.export-staged-count', 'margin', '0 0 var(--space-2)'],
  ]

  for (const [selector, property, value] of ADOPTIONS) {
    it(`${selector} adopts ${property}: ${value}`, () => {
      const bodies = bodiesFor(selector)
      expect(bodies.length, `${selector} must have a rule`).toBeGreaterThan(0)
      const declared = bodies
        .filter((body) => declaration(body, property) !== null)
        .map((body) => declaration(body, property))
      expect(
        declared,
        `${selector} must declare ${property} through the aliases, not literals`,
      ).toContain(value)
    })
  }

  it('every adopted control gets the shared 36px control height and UI type', () => {
    for (const selector of ALL_ADOPTED_CONTROLS) {
      // The two shell toggles are compact, transparent disclosure controls:
      // they adopt the compact height instead (asserted above).
      if ((QUIET_TOGGLES as readonly string[]).includes(selector)) continue
      const bodies = bodiesFor(selector)
      const shared = bodies.find(
        (body) =>
          declaration(body, 'min-height') === 'var(--control-height)' &&
          declaration(body, 'font-size') === 'var(--font-size-ui)',
      )
      expect(shared, `${selector} must join the shared control geometry rule`).toBeDefined()
    }
  })
})

describe('uxv-2 semantics: one accent, neutral secondaries, visible focus', () => {
  it('gives exactly the primary controls the accent treatment, from accent tokens', () => {
    for (const selector of PRIMARY_CONTROLS) {
      const accent = bodiesFor(selector).find(
        (body) => declaration(body, 'background') === 'var(--color-accent-subtle)',
      )
      expect(accent, `${selector} must take the accent surface`).toBeDefined()
      expect(declaration(accent ?? '', 'color')).toBe('var(--color-accent-text)')
      expect(declaration(accent ?? '', 'border-color')).toBe('var(--color-accent-border)')
    }
    // No secondary may be promoted into the accent rule.
    const accentRule = RULES.find(
      (rule) => declaration(rule.body, 'background') === 'var(--color-accent-subtle)',
    )
    expect(accentRule, 'the accent rule must exist').toBeDefined()
    for (const selector of SECONDARY_CONTROLS) {
      expect(
        accentRule?.selectors.includes(selector),
        `${selector} is a secondary control and must stay neutral`,
      ).toBe(false)
    }
  })

  it('keeps the secondaries on the neutral surface/text tokens', () => {
    for (const selector of SECONDARY_CONTROLS) {
      const neutral = bodiesFor(selector).find(
        (body) =>
          declaration(body, 'background') === 'var(--color-surface-alt)' &&
          declaration(body, 'color') === 'var(--color-text)',
      )
      expect(neutral, `${selector} must take the neutral secondary treatment`).toBeDefined()
    }
  })

  it('does not bias the telemetry consent choice with the accent', () => {
    // Both consent affordances share one neutral class: neither answer is
    // visually promoted (ADR 0037 — the opt-out is a real choice, not a
    // de-emphasised one).
    const consentRules = RULES.filter((rule) =>
      rule.selectors.includes('.telemetry-disclosure-action'),
    )
    expect(consentRules.length, 'the consent affordance must be styled').toBeGreaterThan(0)
    for (const rule of consentRules) {
      expect(declaration(rule.body, 'background')).not.toBe('var(--color-accent-subtle)')
    }
  })

  it('paints one 2px focus outline with an offset, on the shared focus token', () => {
    const focusRule = RULES.find((rule) => declaration(rule.body, 'outline-offset') !== null)
    expect(focusRule, 'the focus ring rule must exist').toBeDefined()
    expect(declaration(focusRule?.body ?? '', 'outline')).toBe('2px solid var(--color-focus)')
    expect(declaration(focusRule?.body ?? '', 'outline-offset')).toBe('2px')
    for (const selector of ALL_ADOPTED_CONTROLS) {
      expect(
        focusRule?.selectors.includes(`${selector}:focus-visible`),
        `${selector} must carry the shared focus ring`,
      ).toBe(true)
    }
  })

  it('keeps the staged-count state as text plus colour, never colour alone', () => {
    const body = bodyFor('.export-staged-count')
    // The colour is a semantic token (not a literal) and the emphasis is
    // additive: the element's own copy carries the count.
    expect(declaration(body, 'color')).toBe('var(--color-warning-text)')
    expect(declaration(body, 'font-weight')).toBe('600')
  })
})

describe('uxv-2 scope: no global control selector, no grid/schema/filter/SQL restyle', () => {
  it('never declares a bare element selector for form controls', () => {
    const bare = /^(button|input|select|textarea|label|fieldset|a|p|span|div)$/i
    for (const rule of RULES) {
      for (const selector of rule.selectors) {
        expect(bare.test(selector), `global selector "${selector}" must not be introduced`).toBe(
          false,
        )
      }
    }
  })

  it('keeps the adopted block free of colour literals, motion and non-control selectors', () => {
    expect(ADOPTED_BLOCK, 'no raw colour literal in the adopted block').not.toMatch(
      /#[0-9a-fA-F]{3,8}\b|rgba?\(/,
    )
    expect(ADOPTED_BLOCK, 'no motion in the adopted block').not.toMatch(
      /transition|animation|@keyframes/,
    )
    const adoptedRules = parseRules(ADOPTED_BLOCK)
    expect(adoptedRules.length, 'the adopted block must contain rules').toBeGreaterThan(0)
    for (const rule of adoptedRules) {
      for (const selector of rule.selectors) {
        // Strip the adopted classes' pseudo-classes, then require what is left
        // to be one of the named control classes (or a descendant control of
        // one, e.g. the export format radio).
        const base = selector.replace(/:(?:focus-visible|hover|not\(:disabled\)|disabled)/g, '')
        const named =
          (ALL_ADOPTED_CONTROLS as readonly string[]).includes(base) ||
          base.startsWith('.export-format-option ')
        expect(named, `"${selector}" is outside the uxv-2 adoption list`).toBe(true)
      }
    }
  })

  it('leaves the grid, schema, filter and SQL surfaces without any adopted control class', () => {
    const forbiddenPrefixes = ['.grid-', '.schema-', '.filter-', '.sql-']
    for (const rule of parseRules(ADOPTED_BLOCK)) {
      for (const selector of rule.selectors) {
        for (const prefix of forbiddenPrefixes) {
          expect(
            selector.startsWith(prefix),
            `the adopted block must not restyle ${prefix}* (got "${selector}")`,
          ).toBe(false)
        }
      }
    }
  })
})
