# symspec · Ownership

## Single-author reality

symspec is a solo-authored repository. Every commit and every line traces to
one person, so "ownership" here is not a team map — it is module churn plus a
uniform bus factor of 1.

`git log --format='%an' | sort | uniq -c`:

```
    30 Laith Al-Saadoon
```

`git shortlog -sne HEAD` shows the same author under two email identities (a
personal address and a GitHub noreply address), not two contributors:

```
    18  Laith Al-Saadoon <alsaadoonlaith@gmail.com>
    12  Laith Al-Saadoon <9553966+theagenticguy@users.noreply.github.com>
```

30 commits total (`git rev-list --count HEAD` = 30), spanning 2026-05-13 to
2026-07-16. There is no second contributor to spread knowledge across, no
reviewer of record, and no natural code-owner boundary. The bus factor is 1 for
the entire tree; the tables below only tell you *where* that single point of
failure is most expensive to hit.

## Directory activity

Two views of activity, because raw file-churn and commit-touch count disagree in
a 30-commit repo where large features land in single commits.

### Raw file-touch churn

`git log --pretty=format: --name-only | grep -E '^(src|adversarial|scripts)/' | sed 's#/[^/]*$##' | sort | uniq -c | sort -rn | head`:

| File-touches | Directory |
|---|---|
| 56 | `src/formal` |
| 52 | `src/cli` |
| 39 | `src/formal/__tests__` |
| 37 | `src/cli/__tests__` |
| 23 | `src/core` |
| 13 | `src/parse` |
| 11 | `src/pipeline/__tests__` |
| 11 | `src/pipeline` |
| 11 | `src/parse/__tests__` |
| 10 | `src/solvers/llm` |

The issue-#2 adversarial-hardening work is the most recent driver of
`src/formal`'s lead: `quantity-alias.ts`, `relational.ts`, and `lemma.ts` are new
files, and `semantic.ts` was extended (4 file-touches) alongside a heavily
reworked `src/pipeline/check.ts` (9 file-touches — the most-churned single
source file in the repo).

### Distinct commits touching each directory

Counting distinct commits (`git log --format='%H' -- <dir> | wc -l`) rather than
file rows, which is a better churn proxy when a single "feat: all the things"
commit rewrites many files at once:

| Commits | Directory |
|---|---|
| 12 | `src/cli` |
| 11 | `src/formal` |
| 9 | `src/pipeline` |
| 7 | `src/core` |
| 4 | `scripts` |
| 4 | `adversarial` |
| 3 | `src/lint` |
| 2 | `src/solvers` |
| 2 | `src/parse` |
| 1 | `src/certify` |

The two views now disagree at the top: raw file-touch puts `src/formal` first,
while distinct-commit count puts `src/cli` first (12 vs 11). Both agree that
`src/formal`, `src/cli`, and `src/pipeline` are the most-actively-evolved
directories. `src/pipeline` rose to third by commit count — up from where it sat
in the prior pass — because the DEMOTION-ONLY hardening concentrated in
`check.ts`.

Note `src/solvers/llm` still shows 10 file-touches in the churn view but the
directory no longer exists on disk (`find src -type d` does not list it) — those
touches are historical, from a since-removed LLM solver path. `src/mcp` is
likewise gone (5 historical file-touches, referenced nowhere in the current
tree; deletion is asserted by `src/cli/__tests__/no-mcp-surface.test.ts`).

## Single points of failure

The whole repo is bus-factor 1. The concentration of risk maps to the largest
and most-complex modules, which are also the most-churned:

- **`src/formal/`** — 28 non-test source files, 6,519 LOC, the deepest module in
  the codebase and the one the adversarial-hardening tiers expanded most. It
  houses the Z3 SMT encoding and the entire neurosymbolic conflict-detection
  surface: `ambiguity.ts` (460 LOC, Berry & Kamsties detector), `semantic.ts`
  (391 LOC, embedding-backed similarity with inline antonym suggestion),
  `contradiction.ts` (345 LOC), `numeric.ts` (316 LOC, LIA/LRA predicate
  lifting), `codes.ts` (300 LOC, the closed 30-code `FND_*` enum every tier
  shares), `encode.ts` (293 LOC), `graph.ts` (286 LOC, trace-gated
  orphan/missing-link detection), `atomize.ts` (286 LOC), `guard-implication.ts`
  (281 LOC), `embed.ts` (276 LOC, the ONNX/WASM embedder), `binary-backend.ts`
  (275 LOC, the out-of-process Z3/cvc5 path), `needs-review.ts` (261 LOC),
  `temporal.ts` (224 LOC, bounded LTL→SMT), with the issue-#2 additions
  `quantity-alias.ts` (220 LOC), `lemma.ts` (195 LOC), and `relational.ts`
  (134 LOC) rounding out the tier. This is the algorithmic heart of the tool and
  the hardest area to onboard a second person into. It also carries the dynamic
  `z3-solver`, `onnxruntime-web`, and `@huggingface/tokenizers` loads
  (`src/formal/backend.ts:45`, `src/formal/embed.ts:110-111`) whose failure modes
  are runtime-only.

- **`src/pipeline/check.ts`** — 1,350 LOC, the single most-churned source file
  (9 file-touches). It is where the sound-modulo-atomization doctrine is
  enforced: `verified = demotions.length === 0` (`src/pipeline/check.ts:1289`),
  the propose-only and coverage-gap `FND` code sets, and the calls into the new
  `findQuantityAliasCandidates` (`src/pipeline/check.ts:835`) and
  `findRelationalUnchecked` (`src/pipeline/check.ts:856`) propose signals. A
  soundness regression here is the cardinal-sin failure mode (fabricating a
  conflict, or certifying `verified:true` past a blind spot), and there is no
  second maintainer to catch it in review.

- **`src/lint/gtwr.ts`** — a single 1,108-LOC file implementing ~24 INCOSE GtWR
  lint rules (`src/lint/gtwr.ts:1-3`), each with its own stable code, severity,
  span, and suggestion logic. It grew from the R6 unit-recognition rewrite
  (broadened mass/volume/rate/distance/currency/calendar units, exported
  `R6_RECOGNIZED_UNITS`/`R6_MULTIWORD_UNITS`/`R6_SYMBOL_UNITS` at
  `src/lint/gtwr.ts:116`, `:212`, `:224`). `src/lint/` is only 2 non-test files
  / 1,255 LOC, so nearly all of the lint domain knowledge lives in this one file.
  Concentrated domain-specific logic in a single file is the classic
  bus-factor-1 hotspot.

- **`src/cli/index.ts`** — 1,347 LOC, in the most-churned single area (12
  distinct commits, 52 file-touches for `src/cli`). It is the thin formatter over
  the library API and defines the agent-facing contract spine for every command,
  including the `check` flags and the new `--field` jq-style projection
  (`src/cli/field.ts`, wired at `src/cli/index.ts`). Because it is the entry
  point every consumer hits, a regression here is maximally visible, and there is
  no second maintainer to catch it in review.

- **`adversarial/`** — 3 non-test files, 1,148 LOC (`eval-rounds.ts` 650,
  `generate.ts` 337, `harness.ts` 161). Small but load-bearing as the
  end-to-end detection gate. `eval-rounds.ts` pins 12 winning rounds of a real
  external red-team eval (Opus 4.8 proposer, blind judge panel, z3 oracle) as
  regression fixtures. If it rots, the quality signal for the entire formal
  surface goes dark, and only one person knows how it is wired.

Mitigation for a solo repo is not adding owners — it is the test and gate
discipline that stands in for a second reviewer: `pnpm check` runs
`biome ci . && tsc --noEmit && vitest run && knip` (`package.json:46`), and
every source directory has a paired `__tests__` sibling (11 test directories
under `src/`, `find src -type d -name __tests__`). Those gates are, effectively,
the only reviewer this code has.

## See also

- [Module map](../architecture/module-map.md) — 4 shared source citations
- [Data flow](../architecture/data-flow.md) — 3 shared source citations
- [System overview](../architecture/system-overview.md) — 3 shared source citations
- [Contract map](../insights/contract-map.md) — 3 shared source citations
- [Public API](../reference/public-api.md) — 3 shared source citations
