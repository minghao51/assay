// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * uxv-1 / R-09: source pins for the two floating telemetry surfaces.
 *
 * The defect this guards was invisible to any JSDOM component test: the
 * stylesheet painted `.telemetry-settings-dialog, .telemetry-disclosure` with
 * `var(--color-surface-panel, #fff)`, and `--color-surface-panel` was declared
 * NOWHERE in the token layer — so the hard-coded `#fff` fallback won in both
 * schemes and the panels stayed white in dark mode.
 *
 * These pins are cheap and fail fast on the exact regression class:
 *
 * 1. every telemetry surface background is a SINGLE `var(--token)` — no colour
 *    fallback, so a token typo resolves to nothing and fails visibly instead of
 *    silently painting the panel white;
 * 2. that token is declared in BOTH scheme blocks (typical `:root` and the
 *    `prefers-color-scheme: dark` override) with different values, so the
 *    surface is genuinely scheme-aware;
 * 3. the inherited body text token clears the WCAG AA 4.5:1 floor on that
 *    surface in both schemes, computed from the declarations the browser
 *    actually resolves (no duplicated colour literals).
 *
 * This is NOT the contrast evidence — the driven browser proof lives in
 * `tests/e2e/theme.spec.ts` and the configured-disclosure leg in
 * `tests/visual/telemetry-disclosure-theme.spec.ts`.
 */

const STYLESHEET = readFileSync(resolve(process.cwd(), 'apps', 'web', 'src', 'index.css'), 'utf8')
const DARK_AT_RULE = '@media (prefers-color-scheme: dark)'
const DARK_START = STYLESHEET.indexOf(DARK_AT_RULE)

/** The light scheme's declarations (everything before the dark override). */
const LIGHT_SOURCE = STYLESHEET.slice(0, DARK_START)
/** The dark scheme's declarations (the dark media block onwards). */
const DARK_SOURCE = STYLESHEET.slice(DARK_START)

/** The AA floor for normal text (WCAG 1.4.3). */
const AA_NORMAL_TEXT = 4.5

/** The two surfaces R-09 owns; both are `role="dialog"` panels. */
const TELEMETRY_SURFACES = ['.telemetry-settings-dialog', '.telemetry-disclosure'] as const

/** The declaration body of the first rule whose selector list names `selector`. */
function ruleBody(selector: string): string {
  // Strip comments first: a comment above a rule would otherwise be parsed as
  // part of that rule's selector text.
  const source = STYLESHEET.replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = /([^{}]+)\{([^{}]*)\}/g
  let match: RegExpExecArray | null
  while ((match = rule.exec(source)) !== null) {
    const selectors = (match[1] ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
    if (!selectors.includes(selector)) continue
    return match[2] ?? ''
  }
  throw new Error(`no CSS rule for ${selector}`)
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

function rgb(hex: string): [number, number, number] {
  const body = hex.trim().replace(/^#/, '')
  const expanded =
    body.length === 3
      ? body
          .split('')
          .map((char) => char + char)
          .join('')
      : body
  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) throw new Error(`unsupported hex colour ${hex}`)
  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
  ]
}

function relativeLuminance([r, g, b]: readonly [number, number, number]): number {
  const channel = (raw: number): number => {
    const s = raw / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(foreground: string, background: string): number {
  const a = relativeLuminance(rgb(foreground))
  const b = relativeLuminance(rgb(background))
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

describe('telemetry surfaces use a defined, scheme-aware surface token (R-09)', () => {
  for (const selector of TELEMETRY_SURFACES) {
    it(`${selector} paints a single defined token with no colour fallback`, () => {
      const body = ruleBody(selector)
      const background = declaration(body, 'background') ?? declaration(body, 'background-color')
      expect(background, `${selector} must declare a background`).not.toBeNull()

      // Exactly `var(--some-token)` — no `, #fff` fallback survives this.
      const reference = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(background ?? '')
      expect(
        reference,
        `${selector} background must be a bare var(--token) with no colour fallback; got "${String(background)}"`,
      ).not.toBeNull()

      const token = (reference?.[1] ?? '').replace(/^--/, '')
      expect(token, `${selector} must reference a token`).not.toBe('')

      // Declared in BOTH scheme blocks, and genuinely different per scheme.
      const lightValues = tokenValues(LIGHT_SOURCE, token)
      const darkValues = tokenValues(DARK_SOURCE, token)
      expect(
        lightValues.length,
        `--${token} must be declared for the light scheme`,
      ).toBeGreaterThan(0)
      expect(darkValues.length, `--${token} must be declared for the dark scheme`).toBeGreaterThan(
        0,
      )
      expect(darkValues.at(-1), `--${token} must change with the scheme`).not.toBe(
        lightValues.at(-1),
      )
    })

    it(`${selector} normal text clears the ${String(AA_NORMAL_TEXT)}:1 AA floor in both schemes`, () => {
      const body = ruleBody(selector)
      const background = declaration(body, 'background') ?? declaration(body, 'background-color')
      const token = /^var\(\s*--([a-z0-9-]+)\s*\)$/i.exec(background ?? '')?.[1] ?? ''

      const surfaceLight = tokenValues(LIGHT_SOURCE, token).at(-1) ?? ''
      const surfaceDark = tokenValues(DARK_SOURCE, token).at(-1) ?? ''
      // The surfaces inherit their text colour from the body rule.
      const bodyRule = ruleBody('body')
      const textToken = /^var\(\s*--([a-z0-9-]+)\s*\)$/i.exec(
        declaration(bodyRule, 'color') ?? '',
      )?.[1]
      expect(textToken, 'the body text colour must come from a token').toBeTruthy()

      const textLight = tokenValues(LIGHT_SOURCE, textToken ?? '').at(-1) ?? ''
      const textDark = tokenValues(DARK_SOURCE, textToken ?? '').at(-1) ?? ''

      expect(
        contrast(textLight, surfaceLight),
        `light: --${String(textToken)} on --${token} must clear AA`,
      ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
      expect(
        contrast(textDark, surfaceDark),
        `dark: --${String(textToken)} on --${token} must clear AA`,
      ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
    })
  }
})
