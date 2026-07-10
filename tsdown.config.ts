import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    // `index` is the importable library entry (AC-6-5, AC-7-2): the CLI is a
    // thin formatter over the exact functions re-exported from `src/index.ts`.
    // `dts: true` below emits `dist/index.d.ts` alongside it so consumers get
    // full type information, not just the runtime JS.
    index: 'src/index.ts',
    cli: 'src/cli/index.ts',
  },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  sourcemap: true,
  dts: true,
  clean: true,
  treeshake: true,
  shims: false,
  // tsdown externalizes everything in `dependencies` by default. Override:
  // pull commander/zod into the bundle (they're pure JS and tree-shake
  // cleanly).
  deps: {
    alwaysBundle: ['commander', 'zod'],
  },
})
