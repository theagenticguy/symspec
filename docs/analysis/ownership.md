# symspec · Ownership

## Single-author reality

symspec is a solo-authored repository. Every commit and every line traces to
one person, so "ownership" here is not a team map — it is module churn plus a
uniform bus factor of 1.

`git log --format='%an' | sort | uniq -c`:

```
    20 Laith Al-Saadoon
```

`git shortlog -sne HEAD` shows the same author under two email identities (a
GitHub noreply address and a personal address), not two contributors:

```
    11  Laith Al-Saadoon <9553966+theagenticguy@users.noreply.github.com>
     9  Laith Al-Saadoon <alsaadoonlaith@gmail.com>
```

20 commits total (`git rev-list --count HEAD` = 20), spanning 2026-05-13 to
2026-07-11. There is no second contributor to spread knowledge across, no
reviewer of record, and no natural code-owner boundary. The bus factor is 1 for
the entire tree; the tables below only tell you *where* that single point of
failure is most expensive to hit.

## Directory activity

Two views of activity, because raw file-churn and commit-touch count disagree in
a 20-commit repo where large features land in single commits.

### Raw file-touch churn

`git log --pretty=format: --name-only | grep -E '^(src|adversarial|scripts)/' | sed 's#/[^/]*$##' | sort | uniq -c | sort -rn | head`:

| File-touches | Directory |
|---|---|
| 33 | `src/formal` |
| 26 | `src/formal/__tests__` |
| 26 | `src/cli` |
| 21 | `src/cli/__tests__` |
| 15 | `src/core` |
| 10 | `src/solvers/llm` |
| 9 | `src/parse` |
| 9 | `src/core/__tests__` |
| 8 | `src/parse/__tests__` |
| 8 | `scripts` |

The v3.0–v3.4 work is what pushed `src/formal` to the top: `numeric.ts`,
`emit-smt2.ts`, and `adversarial/generate.ts` each show 2 file-touches, while
`ambiguity.ts`, `numeric-contradiction.ts`, `temporal.ts`,
`temporal-patterns.ts`, `graph.ts`, `scripts/temporal-feasibility.ts`, and
`adversarial/harness.ts` each show 1 (they landed in one feature commit apiece)
— `git log --format= --name-only | grep -E 'formal/(ambiguity|numeric|temporal|graph|emit-smt2)|adversarial/'`.

### Distinct commits touching each directory

Counting distinct commits (`git log --format='%H' -- <dir> | wc -l`) rather than
file rows, which is a better churn proxy when a single "feat: all the things"
commit rewrites many files at once:

| Commits | Directory |
|---|---|
| 7 | `src/formal` |
| 7 | `src/cli` |
| 5 | `src/pipeline` |
| 3 | `src/core` |
| 3 | `scripts` |
| 2 | `src/solvers` |
| 2 | `adversarial` |
| 1 | `src/parse` |
| 1 | `src/lint` |
| 1 | `src/certify` |

Both views agree on the ranking that matters: `src/formal` and `src/cli` are the
most-touched, most-actively-evolved directories, followed by `src/pipeline` and
`src/core`. `src/formal` overtook `src/cli` outright once the v3 tiers landed
there.

Note `src/solvers/llm` shows 10 file-touches in the churn view but the directory
no longer exists on disk (`find src -type d` does not list it) — those touches
are historical, from a since-removed LLM solver path. `src/mcp` is likewise gone
(5 historical file-touches, referenced nowhere in the current tree; deletion is
asserted by `src/cli/__tests__/no-mcp-surface.test.ts`).

## Single points of failure

The whole repo is bus-factor 1. The concentration of risk maps to the largest
and most-complex modules, which are also the most-churned:

- **`src/formal/`** — 23 non-test source files, 4,919 LOC, the deepest module in
  the codebase and the one the v3.0–v3.4 tiers expanded most. It houses the Z3
  SMT encoding and the entire neurosymbolic conflict-detection surface:
  `ambiguity.ts` (460 LOC, v3.1 Berry & Kamsties detector), `contradiction.ts`
  (327 LOC), `encode.ts` (293 LOC), `binary-backend.ts` (275 LOC, the
  out-of-process Z3/cvc5 path), `needs-review.ts` (261 LOC), `numeric.ts`
  (257 LOC, v3.0 LIA/LRA predicate lifting), `codes.ts` (244 LOC, the closed
  FND_* enum every tier shares), `embed.ts` (240 LOC, the ONNX/WASM embedder),
  `graph.ts` (238 LOC, v3.2 kNN similarity graph), `temporal.ts` (224 LOC, v3.3
  bounded LTL→SMT), `model-cache.ts` (237 LOC), with
  `numeric-contradiction.ts` (160 LOC), `temporal-patterns.ts` (195 LOC), and
  `emit-smt2.ts` (176 LOC) rounding out the v3 additions. This is the
  algorithmic heart of the tool and the hardest area to onboard a second person
  into. It also carries the dynamic `z3-solver`, `onnxruntime-web`, and
  `@huggingface/tokenizers` loads (`src/formal/backend.ts:45`,
  `src/formal/embed.ts:110-111`) whose failure modes are runtime-only.

- **`src/lint/gtwr.ts`** — a single 885-LOC file implementing 24 INCOSE GtWR
  lint rules (`src/lint/gtwr.ts:1-3`), each with its own stable code, severity,
  span, and suggestion logic. `src/lint/` is only 2 files / 1,032 LOC, so nearly
  all of the lint domain knowledge lives in this one file. Concentrated
  domain-specific logic in a single file is the classic bus-factor-1 hotspot.

- **`src/cli/index.ts`** — 885 LOC, tied for the most-churned single area (7
  distinct commits, 26 file-touches for `src/cli`). It is the thin formatter
  over the library API and defines the agent-facing contract spine for every
  command, including the v3 `check` flags (`--semantic`, `--temporal`,
  `--temporal-bound`, `--emit-smt2`, `--solver`). Because it is the entry point
  every consumer hits, a regression here is maximally visible, and there is no
  second maintainer to catch it in review.

- **`adversarial/` (v3.4)** — 2 files, 498 LOC (`generate.ts` 337,
  `harness.ts` 161). Small but load-bearing as the only end-to-end detection
  gate: it generates labelled defect fixtures and scores DETECTION+LOCALIZATION
  tier-by-tier. If it rots, the quality signal for the entire formal surface
  goes dark, and only one person knows how it is wired.

Mitigation for a solo repo is not adding owners — it is the test and gate
discipline that stands in for a second reviewer: `pnpm check` runs
`biome ci . && tsc --noEmit && vitest run && knip` (`package.json:46`), and
every source directory has a paired `__tests__` sibling (`find src -type d`).
Those gates are, effectively, the only reviewer this code has.


## See also

- [symspec · Component diagram](../diagrams/architecture/components.md) — 4 shared source citations
- [symspec · Module map](../architecture/module-map.md) — 4 shared source citations
- [symspec · System overview](../architecture/system-overview.md) — 4 shared source citations
- [symspec · Contract map](../insights/contract-map.md) — 3 shared source citations
- [symspec · Data flow](../architecture/data-flow.md) — 3 shared source citations
