---
name: a-generated-doc-needs-two-gates-not-one
description: A regenerate-and-diff gate cannot catch a generator that drops content — it regenerates to match; pair the byte-diff with in-process completeness assertions, and keep the renderer inside src/
metadata:
  type: architecture
---

# A generated doc needs two gates, not one

The single-source pattern for agent docs is: put every fact in one corpus, generate the
human-readable surface from it, and make drift a test failure via
`gen --stdout | diff -u COMMITTED -`.

That gate answers exactly one question: **is the committed file what the generator
produces?** It cannot answer the question that matters more: **does the generator produce
what it should?**

The hole is concrete. A generator that dropped every code table would pass its own diff gate
forever — the first `pnpm gen` after the regression rewrites the committed file, and the diff
is green from then on. The tables are simply gone from both sides.

## The structural cause: the renderer was outside the tested surface

The donor kept its generator in `scripts/gen-agents.ts`, which was outside the typechecker's
`include` and outside the test suite. So nothing *could* assert what it produced except the
byte-diff, and the byte-diff was blind by construction.

Moving the RENDERER into `src/` (a pure `renderAgentsDoc(manifest): string`) and leaving
`scripts/gen-agents.ts` as a five-line shell around it makes both gates possible:

- **completeness, in-process** — every operation projected with its own summary string, all
  75 codes present, every exit code, every scope claim, every craft section;
- **identity, cross-boundary** — `check:agents` regenerates and diffs the committed file,
  wired into `pnpm check`.

Verified independently:

| break | diff gate | completeness tests |
|---|---|---|
| hand-append a line to the committed file | **fails** | pass |
| elide the FND code table from the renderer | fails | **fails (2 assertions)** |

Neither gate alone is sufficient. The pair is.

## Determinism is a prerequisite, so assert it directly

A gate over a generator that embedded a clock, a cwd, or a probe result fails on every run
and gets disabled within a week. Assert the absence explicitly rather than hoping:

```ts
expect(render()).toBe(render())                          // byte-stable across calls
expect(rendered).not.toMatch(/\b20\d{2}-\d{2}-\d{2}T/)   // no timestamp
expect(rendered).not.toContain(process.cwd())            // no absolute path
expect(rendered).not.toContain(process.version)          // no environment value
```

## Table shape: do not imply information that does not exist

Three decisions on the same generated doc, all the same principle:

- `ERR_*` gets **two** columns (code, meaning). An operational error has no finding severity
  — it replaces the result rather than appearing inside one — so a severity column of `—`
  would imply the value is missing rather than inapplicable.
- `FND_*` gets **four** (code, severity, tier, meaning), because those are exactly the facts
  that decide what an agent does about a finding.
- `GTWR_*` gets **three plus a footnote**, because GtWR severity is decided *per finding*
  (contextual downgrades on R16/R26/R32/R35). A column of dashes reads as "unknown" where the
  truth is "depends on the finding".

And escape pipes in every cell, asserted by walking every rendered row and checking no cell
is empty — an unescaped `|` silently splits a row rather than failing to render.

## How to apply

1. Renderer in `src/`, pure, taking its inputs as arguments so a test can render against a
   constructed input rather than only the production one.
2. Script in `scripts/` decides only where the bytes go (`--stdout` vs write-in-place).
3. Completeness tests iterate the CORPUS and assert each element appears — so appending a
   code or an operation is covered automatically, not by a hand-updated list.
4. Byte-diff wired into the repo's `check`, and an in-process copy of the same assertion so a
   developer running only `vitest` still learns the file is stale.
5. Assert summaries appear VERBATIM (`| \`cmd x\` | ${op.summary} |`), which is what makes
   "projection" a property rather than an intention. A paraphrase here is how the donor ended
   up documenting `apply --file` for a command registered as `--doc`.

Related: [[manifest-single-source-derivation]] — the corpus side of the same pattern. That
lesson establishes single-sourcing; this one is about the gate over the artifact being only
half a gate.
