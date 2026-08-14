/**
 * The version constant is a literal so the single-file bundle needs no runtime
 * `package.json` read. This test is the other half of that trade: it pins the
 * constant to `package.json`, so bumping one without the other fails the suite
 * instead of shipping a CLI that misreports its own version.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { VERSION } from './version.ts'

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8'),
) as { version: string }

describe('VERSION', () => {
  it('equals the version in package.json', () => {
    expect(VERSION).toBe(packageJson.version)
  })

  it('is a non-empty semver-shaped string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
  })
})
