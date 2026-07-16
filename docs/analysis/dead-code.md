# symspec · Dead code

## Result: clean

`pnpm knip` reports nothing. The command exits 0 with an empty findings body:

```
$ pnpm knip
$ knip
EXIT=0
```

knip is part of the repo's own gate: `pnpm check` runs
`biome ci . && tsc --noEmit && vitest run && knip` (`package.json:46`), so a
clean knip run is a merge precondition, not an accident. The three findings
tables knip would populate are all empty:

| Category | Findings |
|---|---|
| Unused files | none |
| Unused/unreferenced exports | none (rule disabled — see below) |
| Unlisted / unresolved imports & dependencies | none |

There is genuinely nothing to report, including across the issue-#2
adversarial-hardening additions merged since the last pass. The four new source
files all have live inbound references, so none is a dead file and none exports a
dead symbol:

- `src/formal/quantity-alias.ts` — `findQuantityAliasCandidates` is imported and
  called from the pipeline (`src/pipeline/check.ts:85`, `src/pipeline/check.ts:835`).
- `src/formal/relational.ts` — `findRelationalUnchecked` is imported and called
  from the pipeline (`src/pipeline/check.ts:86`, `src/pipeline/check.ts:856`).
- `src/formal/lemma.ts` — `deInflectHead` and `IRREGULAR_VERB_LEMMAS` are
  consumed by `src/formal/atomize.ts` and `src/formal/guard-implication.ts`.
- `src/cli/field.ts` — the `--field` projection is wired into the CLI
  (`src/cli/index.ts`).

knip's `project` and `entry` globs cover the adversarial harness and every
script (`knip.json:3-4`), so the grown `adversarial/eval-rounds.ts` (650 LOC) and
its test sit inside the analysis boundary, and the run stays green. The rest of
this document explains the configuration that produces that result, so the
"clean" verdict is legible rather than blind.

## Configuration and carve-outs

Full `knip.json` (unchanged across the issue-#2 merge):

```json
{
  "$schema": "https://unpkg.com/knip@5/schema.json",
  "project": ["src/**/*.ts", "adversarial/**/*.ts", "scripts/**/*.ts"],
  "entry": ["adversarial/harness.ts", "scripts/*.ts"],
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

The `project` glob spans three roots — `src/`, `adversarial/`, `scripts/`
(`knip.json:3`) — so the adversarial harness and every script are inside the
analysis boundary. The `entry` glob (`knip.json:4`) declares
`adversarial/harness.ts` and every `scripts/*.ts` as reachable roots; without
this, files invoked only from the command line (the harness `main`,
`scripts/gen-agents.ts`) would be flagged as unused `files`. The config carves
out **two dependencies** (`wink-nlp`, `wink-eng-lite-web-model`) and **one
binary** (`diff`) — `knip.json:6-7`. It does *not* ignore `onnxruntime-web`,
`@huggingface/tokenizers`, or `z3-solver`; those resolve without help (see the
last section).

### Rule posture (`knip.json:8-15`)

- `dependencies: error` and `unlisted: error` — the two rules that catch an
  actual packaging bug (a shipped dependency that is never imported, or an
  import that is never declared) are hard failures. These are the rules a clean
  run most meaningfully asserts.
- `exports: off` and `types: off` — unused-export and unused-type detection is
  disabled. This is deliberate for a library that exposes a public API surface
  (`exports` in `package.json` points at the built `dist` barrel): re-exported
  public symbols look "unused" internally but are the product. The barrel
  `src/index.ts` re-exports certify/core/formal/lint/parse/pipeline/solvers;
  leaving these rules on would produce false positives across the entire public
  API. `ignoreExportsUsedInFile: true` (`knip.json:5`) is the same principle at
  file scope. Note the consequence for this refresh: because `exports: off`,
  knip does not itself vouch for unused exports — the four new files above were
  verified by inbound-reference grep, not by knip.
- `files: warn` and `devDependencies: warn` — soft signals, not gate failures.

### `ignoreDependencies` — `wink-nlp`, `wink-eng-lite-web-model` (`knip.json:6`)

These two are carved out because they are loaded through **variable** dynamic
import specifiers that knip's static analysis cannot follow. In
`src/parse/tier2.ts` the specifiers are hoisted into constants first:

```
src/parse/tier2.ts:267  const WINK_NLP_SPECIFIER = 'wink-nlp'
src/parse/tier2.ts:268  const WINK_MODEL_SPECIFIER = 'wink-eng-lite-web-model'
src/parse/tier2.ts:297  const winkMod = (await import(WINK_NLP_SPECIFIER)) as { default: WinkFactory }
src/parse/tier2.ts:298  const modelMod = (await import(WINK_MODEL_SPECIFIER)) as { default: unknown }
```

Because the argument to `import()` is a binding (`WINK_NLP_SPECIFIER`) rather
than a string literal, knip sees no literal module reference and would flag both
packages as unused `dependencies` (an `error`) even though they are real runtime
deps. The ignore entries suppress that false positive. This indirection is
intentional in the source: Tier-2 parsing lazily loads wink-nlp and its English
model only when needed.

### `ignoreBinaries` — `diff` (`knip.json:7`)

`diff` is a system binary invoked from the `check:agents` script
(`tsx scripts/gen-agents.ts --stdout | diff -u AGENTS.md -`, `package.json:49`),
not an npm-installed binary. knip's binary check would flag it as unlisted; the
ignore says "this is a POSIX tool, not a dependency."

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
without any carve-out. These three are lazily loaded for portability, but that
affects only the runtime load path, not static traceability; only the
literal-vs-variable specifier distinction matters to knip. Relative dynamic
imports such as `import('./embed.js')` (`src/formal/semantic.ts:143`) and
`import('../formal/embed.js')` (`src/cli/index.ts:543`) are in-project and
likewise fully resolved.

## Bottom line

knip is clean under a configuration that fails hard on real packaging bugs
(`dependencies`, `unlisted`) while intentionally silencing (a) public-API export
analysis that does not apply to a library entry point, and (b) exactly three
carve-outs — two variable-specifier dynamic deps and one system binary — that
are static-analysis blind spots, not dead code. The issue-#2 additions
(`quantity-alias.ts`, `relational.ts`, `lemma.ts`, `field.ts`, and the expanded
`adversarial/eval-rounds.ts`) sit inside the widened `project`/`entry` boundary,
each carry live inbound references, and add nothing to the findings.

## See also

- [Module map](../architecture/module-map.md) — 3 shared source citations
- [Processes](../behavior/processes.md) — 3 shared source citations
- [Business logic](../insights/business-logic.md) — 3 shared source citations
- [Contract map](../insights/contract-map.md) — 3 shared source citations
- [Data flow](../architecture/data-flow.md) — 2 shared source citations
