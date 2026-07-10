# symspec · Dead code

## Result: clean

`pnpm knip` reports nothing. The command exits 0 with no output:

```
$ pnpm knip
$ knip
```

(exit code 0, empty stdout — confirmed twice, including with `--no-progress`).

knip is part of the repo's own gate: `pnpm check` runs
`biome ci . && tsc --noEmit && vitest run && knip` (`package.json` scripts), so a
clean knip run is a merge precondition, not an accident. The three findings
tables knip would populate are all empty:

| Category | Findings |
|---|---|
| Unused files | none |
| Unused/unreferenced exports | none (rule disabled — see below) |
| Unlisted / unresolved imports & dependencies | none |

There is genuinely nothing to report. The rest of this document explains the
configuration that produces that result, so the "clean" verdict is legible
rather than blind.

## Configuration and carve-outs

Full `knip.json`:

```json
{
  "$schema": "https://unpkg.com/knip@5/schema.json",
  "project": ["src/**/*.ts"],
  "ignoreExportsUsedInFile": true,
  "ignoreDependencies": ["wink-nlp", "wink-eng-lite-web-model"],
  "ignoreBinaries": ["diff"],
  "rules": {
    "dependencies": "error",
    "devDependencies": "warn",
    "unlisted": "error",
    "exports": "off",
    "types": "off",
    "files": "warn"
  }
}
```

The real config carves out **two dependencies** (`wink-nlp`,
`wink-eng-lite-web-model`) and **one binary** (`diff`) — `knip.json:5-6`. It does
*not* ignore `onnxruntime-web` or `@huggingface/tokenizers`; those resolve
without help (see the last section).

### Rule posture (`knip.json:7-14`)

- `dependencies: error` and `unlisted: error` — the two rules that catch an
  actual packaging bug (a shipped dependency that is never imported, or an
  import that is never declared) are hard failures. These are the rules a clean
  run most meaningfully asserts.
- `exports: off` and `types: off` — unused-export and unused-type detection is
  disabled. This is deliberate for a library that exposes a public API surface
  (`exports` in `package.json` points at `dist/index.d.mts`): re-exported public
  symbols look "unused" internally but are the product. Leaving these on would
  produce false positives across the entire public API. `ignoreExportsUsedInFile:
  true` (`knip.json:4`) is the same principle at file scope.
- `files: warn` and `devDependencies: warn` — soft signals, not gate failures.

### `ignoreDependencies` — `wink-nlp`, `wink-eng-lite-web-model` (`knip.json:5`)

These two are carved out because they are loaded through **variable** dynamic
import specifiers that knip's static analysis cannot follow. In
`src/parse/tier2.ts` the specifiers are hoisted into constants first:

```
src/parse/tier2.ts:243  const WINK_NLP_SPECIFIER = 'wink-nlp'
src/parse/tier2.ts:244  const WINK_MODEL_SPECIFIER = 'wink-eng-lite-web-model'
src/parse/tier2.ts:273  const winkMod = (await import(WINK_NLP_SPECIFIER)) as { default: WinkFactory }
src/parse/tier2.ts:274  const modelMod = (await import(WINK_MODEL_SPECIFIER)) as { default: unknown }
```

Because the argument to `import()` is a binding (`WINK_NLP_SPECIFIER`) rather
than a string literal, knip sees no literal module reference and would flag both
packages as unused `dependencies` (an `error`) even though they are real runtime
deps. The ignore entries suppress that false positive. This indirection is
intentional in the source: Tier-2 parsing lazily loads wink-nlp and its English
model only when needed (`src/parse/tier2.ts:266`).

### `ignoreBinaries` — `diff` (`knip.json:6`)

`diff` is a system binary invoked from the `check:agents` script
(`tsx scripts/gen-agents.ts --stdout | diff -u AGENTS.md -`, `package.json`
scripts), not an npm-installed binary. knip's binary check would flag it as
unlisted; the ignore says "this is a POSIX tool, not a dependency."

## Note on other dynamic imports (why they are NOT carved out)

The other lazy loads in the codebase use **string-literal** specifiers, so knip
traces them fine and no ignore entry is needed:

```
src/formal/embed.ts:110   import('onnxruntime-web')
src/formal/embed.ts:111   import('@huggingface/tokenizers')
src/formal/backend.ts:45  const { init } = await import('z3-solver')
```

`onnxruntime-web`, `@huggingface/tokenizers`, and `z3-solver` are all declared
`dependencies` in `package.json` and are all referenced by literal `import()`
calls, so knip resolves them and the `dependencies: error` rule stays green
without any carve-out. (These three are lazily loaded for portability —
`src/formal/embed.ts:6-17` — but that affects only the runtime load path, not
static traceability; only the literal-vs-variable specifier distinction matters
to knip.) Relative dynamic imports such as `import('./embed.js')`
(`src/formal/semantic.ts:84`) and `import('../formal/embed.js')`
(`src/cli/index.ts:355`) are in-project and likewise fully resolved.

## Bottom line

knip is clean under a configuration that fails hard on real packaging bugs
(`dependencies`, `unlisted`) while intentionally silencing (a) public-API export
analysis that does not apply to a library entry point, and (b) exactly three
carve-outs — two variable-specifier dynamic deps and one system binary — that
are static-analysis blind spots, not dead code.


## See also

- [symspec · Component diagram](../diagrams/architecture/components.md) — 4 shared source citations
- [symspec · Dependency graph](../diagrams/structural/dependency-graph.md) — 4 shared source citations
- [symspec · Module map](../architecture/module-map.md) — 4 shared source citations
- [symspec · Tech debt](../insights/tech-debt.md) — 4 shared source citations
- [symspec · Contract map](../insights/contract-map.md) — 3 shared source citations
