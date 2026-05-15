import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    cli: 'src/cli/index.ts',
    mcp: 'src/mcp/server.ts',
  },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  sourcemap: true,
  dts: false,
  clean: true,
  treeshake: true,
  shims: false,
  // tsdown externalizes everything in `dependencies` by default. Override:
  // pull commander/zod/MCP SDK into the bundle (they're pure JS and tree-shake
  // cleanly), but keep Automerge (ships a WASM blob the loader resolves
  // relative to its own package) and AWS SDK (huge, uses import.meta.url for
  // credential providers) external so the user installs them via the
  // package's own `dependencies`.
  deps: {
    alwaysBundle: ['commander', 'zod', /^@modelcontextprotocol\/sdk(\/|$)/],
    neverBundle: ['@automerge/automerge', /^@aws-sdk\//, /^@smithy\//],
  },
})
