import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Several drift tests spawn the built bundle as a CHILD PROCESS (that is the
    // point — the drift they guard is between the SHIPPED manifest and the
    // SHIPPED help, not between two in-process function calls). Each spawn is a
    // full node boot (~110ms quiet, ~330ms on a loaded box), so the bare 5000ms
    // default has no headroom on a shared machine. 20s matches the donor's
    // reasoning: a ~5x margin over the slowest real test, still short enough to
    // catch a genuine hang.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
