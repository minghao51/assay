// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * ug-19 contrast source pins (UG-37 and its `.record-value-null` successor).
 *
 * The e2e axe scans prove the rendered surfaces in both schemes, but they only
 * cover the states their journeys drive. These cheap source assertions pin the
 * token/rule layer directly: the profile/SQL empty-state selectors cannot
 * drift back to the sub-AA faint/placeholder tokens (the surviving `a2`
 * mutant), and both NULL markers must use the semantic null token whose light
 * AND dark values are verified against the WCAG 4.5:1 floor here.
 *
 * The numbers are computed from the same declarations the browser resolves —
 * no duplicated colour literals in this test.
 */

const STYLESHEET = readFileSync(resolve(process.cwd(), 'apps', 'web', 'src', 'index.css'), 'utf8')

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

function ruleBody(selector: string): string {
  const rule = RULES.find((candidate) => candidate.selectors.includes(selector))
  if (rule === undefined) throw new Error(`no CSS rule for ${selector}`)
  return rule.body
}

/** All declared values for a token, in file order (light then dark). */
function tokenValues(token: string): string[] {
  const re = new RegExp(`--${token}\\s*:\\s*(#[0-9a-fA-F]{3,6})\\s*;`, 'g')
  return [...STYLESHEET.matchAll(re)].map((match) => match[1] as string)
}

function rgb(hex: string): [number, number, number] {
  const body = hex.slice(1)
  const expanded =
    body.length === 3
      ? body
          .split('')
          .map((char) => char + char)
          .join('')
      : body
  if (expanded.length !== 6) throw new Error(`unsupported hex colour ${hex}`)
  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
  ]
}

function luminance(hex: string): number {
  const [red, green, blue] = rgb(hex).map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground)
  const b = luminance(background)
  const lighter = Math.max(a, b)
  const darker = Math.min(a, b)
  return (lighter + 0.05) / (darker + 0.05)
}

describe('ug-19 contrast source pins', () => {
  it('defines light and dark NULL tokens that clear AA on every surface', () => {
    const nullTokens = tokenValues('color-null-text')
    expect(nullTokens).toHaveLength(2)
    // The grid NULL marker sits on a row that can be hovered, so the worst
    // relevant background (not just the subtle panel) is part of the pin.
    const surfaceTokens = [
      'color-surface',
      'color-surface-subtle',
      'color-surface-alt',
      'color-row-hover',
    ]
    const surfaces = surfaceTokens.map((token) => {
      const values = tokenValues(token)
      expect(values, token).toHaveLength(2)
      return values
    })
    nullTokens.forEach((value, scheme) => {
      for (const [index, token] of surfaceTokens.entries()) {
        const surface = surfaces[index]?.[scheme] as string
        expect(contrast(value, surface), `${value} on ${token} ${surface}`).toBeGreaterThanOrEqual(
          4.5,
        )
      }
    })
  })

  it('uses the semantic NULL token for the record dock and grid NULL markers', () => {
    for (const selector of ['.record-value-null', '.grid-null-marker']) {
      const body = ruleBody(selector)
      expect(body, selector).toMatch(/color:\s*var\(--color-null-text\)\s*;/)
      expect(body, selector).not.toMatch(/color:\s*var\(--color-text-(?:faint|placeholder)\)/)
      // The visual distinction stays: NULL is italic, never an empty-looking blank.
      expect(body, selector).toContain('font-style: italic')
    }
  })

  it('keeps the empty-state selectors on --color-text-secondary', () => {
    for (const selector of [
      '.filter-empty',
      '.sql-result-empty',
      '.profile-strip-tick-name',
      '.profile-strip-empty',
      '.profile-topk-empty',
    ]) {
      const body = ruleBody(selector)
      expect(body, selector).toMatch(/color:\s*var\(--color-text-secondary\)\s*;/)
      expect(body, selector).not.toMatch(/color:\s*var\(--color-text-(?:faint|placeholder)\)/)
    }
  })
})
