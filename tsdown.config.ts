import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  outDir: 'dist',
  platform: 'node',
  target: 'node24',
  dts: false,
  sourcemap: false,
  minify: false,
  treeshake: true,
  clean: true,
  shims: false,
  // tsdown externalizes `dependencies` by default, which would leave bare
  // `import ... from "effect"` at the top of the bundle — not a single file at
  // all (S2 finding 3). Inline the whole Effect surface so `dist/cli.mjs` runs
  // under plain `node` with nothing resolved at runtime.
  noExternal: [/^effect(\/|$)/, /^@effect\//],
  outputOptions: { entryFileNames: 'cli.mjs' },
})
