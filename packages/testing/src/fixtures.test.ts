import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fixturePath } from './node'

const categories = ['csv', 'jsonl', 'nested-json', 'parquet', 'drift', 'diff', 'llm']
const textCategories = ['csv', 'jsonl', 'nested-json', 'llm']

describe('golden fixtures manifest (docs/engineering/06-testing-security-quality.md §3)', () => {
  it('defines every fixture category from the repository structure', () => {
    for (const category of categories) {
      expect(existsSync(fixturePath(category)), `fixtures/${category}`).toBe(true)
    }
  })

  it('text categories contain at least one data file', () => {
    for (const category of textCategories) {
      const files = readdirSync(fixturePath(category)).filter((f) => !f.endsWith('.md'))
      expect(files.length, `fixtures/${category}`).toBeGreaterThan(0)
    }
  })

  it('jsonl fixtures parse line by line', () => {
    const jsonlFixtures = [
      'jsonl/events.jsonl',
      'nested-json/messages.jsonl',
      'llm/chat-eval.jsonl',
    ]
    for (const fixture of jsonlFixtures) {
      const lines = readFileSync(fixturePath(fixture), 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
      expect(lines.length, fixture).toBeGreaterThan(0)
      for (const line of lines) {
        expect(() => JSON.parse(line), `${fixture}: ${line}`).not.toThrow()
      }
    }
  })
})
