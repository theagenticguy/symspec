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
    // Carried over from the donor's config for the same reason, and worth restating:
    // the stub is NOT a fallback. Without this variable a missing model still fails
    // closed with ERR_EMBED_MODEL_MISSING, which `formal/embedder.test.ts` asserts by
    // deleting the variable for the duration of one case. Tests that need real
    // similarity SEMANTICS inject a hand-authored vector table instead, since the
    // stub's cosines are meaningless by design.
    env: { SYMSPEC_EMBED_STUB: '1' },
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
