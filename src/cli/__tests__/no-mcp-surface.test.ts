import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(__dirname, '../../..')

describe('T-AC-8-1: MCP surface deletion', () => {
  it('should not have src/mcp/server.ts', () => {
    expect(existsSync(resolve(repoRoot, 'src/mcp/server.ts'))).toBe(false)
  })

  it('should not have bin/symspec-mcp.mjs', () => {
    expect(existsSync(resolve(repoRoot, 'bin/symspec-mcp.mjs'))).toBe(false)
  })

  it('should not have MCP artifacts left in integration/', () => {
    expect(existsSync(resolve(repoRoot, 'integration/mcp-config.json'))).toBe(false)
    expect(existsSync(resolve(repoRoot, 'integration/SKILL.md'))).toBe(false)
  })

  it('package.json should have no symspec-mcp bin, mcp script, or @modelcontextprotocol/sdk dependency', () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf-8')) as {
      bin?: Record<string, string>
      scripts?: Record<string, string>
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }

    expect(pkg.bin?.['symspec-mcp']).toBeUndefined()
    expect(pkg.scripts?.mcp).toBeUndefined()
    expect(pkg.dependencies?.['@modelcontextprotocol/sdk']).toBeUndefined()
    expect(pkg.devDependencies?.['@modelcontextprotocol/sdk']).toBeUndefined()
  })

  it('tsdown.config.ts should have no mcp entry or MCP SDK bundle rule', () => {
    const config = readFileSync(resolve(repoRoot, 'tsdown.config.ts'), 'utf-8')
    expect(config).not.toMatch(/mcp:\s*['"]src\/mcp\/server\.ts['"]/)
    expect(config).not.toContain('@modelcontextprotocol/sdk')
  })
})
