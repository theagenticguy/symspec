import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * AC-8-6: symspec rewrites the package `description` to state the v2
 * CLI-native formal-methods purpose, removing the dead-machinery language from
 * the v1 string ("CLI + MCP", "three-tier solver … Bedrock ensemble + Opus 4.7
 * arbiter", the Automerge CRDT storage claim).
 *
 * Verification (spec): a unit test asserts the `description` matches a v2
 * pattern — mentions "formal"/"EARS"/"CLI" — and contains NONE of the dead
 * tokens: MCP, Bedrock, Opus, Automerge, CRDT, three-tier, arbiter, ensemble,
 * migrate. Reading the raw JSON (not the type-asserted import) keeps the assert
 * honest against exactly the shipped file. Matching is case-insensitive so a
 * regression cannot slip past on casing alone.
 */

const repoRoot = resolve(__dirname, '../../..')

function readDescription(): string {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf-8')) as {
    description?: string
  }
  expect(typeof pkg.description).toBe('string')
  return pkg.description ?? ''
}

// Dead-machinery tokens from the v1 description and removed v1 subsystems.
// Word-boundary match so a legitimate longer word cannot false-positive, but
// the tokens are also distinctive enough that substring vs. boundary is moot.
const FORBIDDEN_TOKENS = [
  'MCP',
  'Bedrock',
  'Opus',
  'Automerge',
  'CRDT',
  'three-tier',
  'arbiter',
  'ensemble',
  'migrate',
] as const

// v2 terms the description MUST surface so scope-claim regressions are caught.
const REQUIRED_TERMS = ['formal', 'EARS', 'CLI'] as const

describe('package description v2 (AC-8-6)', () => {
  it('states the v2 formal-methods / EARS / CLI purpose', () => {
    const description = readDescription().toLowerCase()
    for (const term of REQUIRED_TERMS) {
      expect(description).toContain(term.toLowerCase())
    }
  })

  it('contains none of the dead-machinery tokens', () => {
    const description = readDescription()
    for (const token of FORBIDDEN_TOKENS) {
      const pattern = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
      expect(description, `description must not mention "${token}"`).not.toMatch(pattern)
    }
  })

  it('is a substantive, non-empty single-line string', () => {
    const description = readDescription()
    expect(description.length).toBeGreaterThan(40)
    expect(description).not.toContain('\n')
  })
})
