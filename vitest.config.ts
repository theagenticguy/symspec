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
    include: ['src/**/*.test.ts', 'adversarial/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**'],
    },
  },
})
