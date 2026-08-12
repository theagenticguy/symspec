import { defineConfig } from 'tsdown'

/**
 * The dependencies that are INLINED into `dist/cli.mjs`, as an exact allowlist.
 *
 * `deps.onlyBundle` is a guard, not a hint-silencer: tsdown ERRORS when a dependency lands
 * in the bundle that is not on this list. That matters for a single-file CLI, because the
 * default is to inline whatever the import graph reaches — so a new transitive dependency
 * would otherwise be absorbed into a published artifact silently, with no diff to review.
 * With the list explicit, it is a build failure that names the package and its importer.
 *
 * `ini`, `toml`, and `yaml` are NOT direct dependencies. They arrive through
 * `@effect/platform-node`'s config parsers, and they are listed because they are in the
 * bundle — recording what is actually shipped, rather than what was intended.
 */
const BUNDLED_DEPS = [/^effect(\/|$)/, /^@effect\//, 'ini', 'toml', 'yaml']

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
  deps: {
    // tsdown externalizes `dependencies` by default, which would leave bare
    // `import ... from "effect"` at the top of the bundle — not a single file at all (S2
    // finding 3). Inline the whole Effect surface so `dist/cli.mjs` runs under plain
    // `node` with nothing resolved at runtime.
    alwaysBundle: [/^effect(\/|$)/, /^@effect\//],
    onlyBundle: BUNDLED_DEPS,
  },
  outputOptions: { entryFileNames: 'cli.mjs' },
  inputOptions(options) {
    // `onLog`, not the deprecated `onwarn`.
    options.onLog = (level, log, defaultHandler) => {
      // ONE warning is suppressed, by exact module, and it is structurally unfixable:
      // `donor/formal/semantic.ts` lazy-imports `embed.ts` per call, and `src/donor/**` is
      // frozen. `formal/embedder.ts` imports `embed.ts` statically and deliberately — the
      // file is interface-only (a type, `cosine`, and the model id), while the expensive
      // things stay dynamic inside the loader. So the lazy import buys nothing and cannot
      // be removed without editing vendored code.
      //
      // Matched on the MODULE, not just the code, so a new ineffective dynamic import —
      // which would be a real finding about our own laziness — still reports. A blanket
      // suppression by code is how this warning stops meaning anything.
      if (
        log.code === 'INEFFECTIVE_DYNAMIC_IMPORT' &&
        String(log.message).includes('src/donor/formal/embed.ts')
      ) {
        return
      }
      defaultHandler(level, log)
    }
    return options
  },
})
