import { describe, expect, it } from 'vitest'
import { APP_NAME, NEXT_MILESTONE, SCAFFOLD_STATUS, TAGLINE } from './app'

describe('app scaffold metadata', () => {
  it('identifies the product', () => {
    expect(APP_NAME).toBe('Assay')
    expect(TAGLINE).toBe('The local-first data workbench')
    expect(SCAFFOLD_STATUS).toContain('M0')
    expect(NEXT_MILESTONE).toContain('M1')
  })
})
