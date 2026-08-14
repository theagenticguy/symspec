import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The semantic tier runs on every `check`, and its model is a ~110 MB
    // sha256-pinned download. `SYMSPEC_EMBED_STUB=1` selects the DETERMINISTIC hash
    // embedder so the suite — and every SPAWNED CLI test, which inherits this env —
    // exercises the always-on tier without the model.
    //
    // The stub is NOT a fallback. Without this variable a missing model still fails
    // closed with ERR_EMBED_MODEL_MISSING, which `adapters/embedding/embedder.test.ts` asserts by
    // deleting the variable for the duration of one case. Tests that need real
    // similarity SEMANTICS inject a hand-authored vector table instead, since the
    // stub's cosines are meaningless by design.
    env: { SYMSPEC_EMBED_STUB: '1' },
    // Several drift tests spawn the built bundle as a CHILD PROCESS (that is the
    // point — the drift they guard is between the SHIPPED manifest and the
    // SHIPPED help, not between two in-process function calls). Each spawn is a
    // full node boot of a 2.2 MB bundle (~110ms quiet, ~330ms on a loaded box), so
    // the bare 5000ms default has no headroom on a shared machine.
    //
    // The budget is sized against a MEASUREMENT, and it is restated when the
    // measurement moves: slowest test 8.1s on an 8-core devbox, quiet. 45s keeps the
    // ~5x margin that makes this a hang detector rather than a load detector — a
    // 2-core CI runner is comfortably slower than quiet-devbox numbers, and a test
    // that fails only under contention gets muted rather than fixed.
    //
    // Any loop over an independent SET of spawns runs concurrently (see
    // `runJsonAsync` and the cached `commandHelp` map in `cli.test.ts`). That is the
    // real fix; the timeout is only the backstop.
    testTimeout: 45_000,
    hookTimeout: 45_000,
  },
})
