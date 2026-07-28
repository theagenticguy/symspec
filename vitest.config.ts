import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // The semantic tier is core: every CLI `check` loads the embedding model.
    // Tests run against the deterministic hash stub (see formal/embed.ts) so
    // spawned-CLI tests don't need the ~110 MB model; child processes inherit
    // this env. Unit tests that need real similarity semantics keep injecting
    // fake embedders directly.
    env: { SYMSPEC_EMBED_STUB: '1' },
    // Vitest's bare 5000ms default has no headroom for this suite. Several tests
    // spawn the CLI as `npx tsx` CHILD PROCESSES (each ~0.6-1.1s of Node+tsx boot)
    // and several drive real Z3-WASM solves; the slowest legitimately sit at
    // 2.4-3.7s in isolation. Because vitest runs test FILES in parallel, a busy
    // machine (a loaded CI runner, or a dev box running other work) pushes those
    // past 5000ms and the suite fails on scheduling latency rather than on any
    // behavioral regression — a flaky gate, which is worse than a slow one since
    // it trains people to re-run instead of read. 20s restores a ~5x margin over
    // the slowest real test while still catching a genuine hang.
    testTimeout: 20_000,
    // Same reasoning for `beforeAll`/`afterAll`: the CLI-spawning suites do their
    // fixture setup (init + several `add`s, each its own subprocess) in hooks.
    hookTimeout: 20_000,
    include: ['src/**/*.test.ts', 'adversarial/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**'],
    },
  },
})
