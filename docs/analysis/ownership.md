# symspec · Ownership

## Single-author reality

symspec is a solo-authored repository. Every commit and every line traces to
one person, so "ownership" here is not a team map — it is module churn plus a
uniform bus factor of 1.

`git shortlog -sne`:

```
    14  Laith Al-Saadoon <...>
```

`git log --format='%an' | sort | uniq -c`:

```
    14 Laith Al-Saadoon
```

14 commits total (`git rev-list --count HEAD` = 14), spanning 2026-05-13 to
2026-07-10. There is no second contributor to spread knowledge across, no
reviewer of record, and no natural code-owner boundary. The bus factor is 1 for
the entire tree; the tables below only tell you *where* that single point of
failure is most expensive to hit.

## Directory activity

Two views of activity, because raw file-churn and commit-touch count disagree in
a 14-commit repo where large features land in single commits.

### Raw file-touch churn

`git log --pretty=format: --name-only | grep -E '^src/' | sed 's#/[^/]*$##' | sort | uniq -c | sort -rn | head`:

| File-touches | Directory |
|---|---|
| 22 | `src/cli` |
| 20 | `src/cli/__tests__` |
| 19 | `src/formal` |
| 17 | `src/formal/__tests__` |
| 13 | `src/core` |
| 10 | `src/solvers/llm` |
| 9 | `src/parse` |
| 9 | `src/core/__tests__` |
| 8 | `src/parse/__tests__` |
| 5 | `src/solvers/free` |

### Distinct commits touching each directory

Counting distinct commits (`git log --format='%H' -- <dir> | wc -l`) rather than
file rows, which is a better churn proxy when a single "feat: all the things"
commit rewrites many files at once:

| Commits | Directory |
|---|---|
| 4 | `src/cli` |
| 3 | `src/formal` |
| 2 | `src/solvers` |
| 2 | `src/core` |
| 1 | `src/pipeline` |
| 1 | `src/parse` |
| 1 | `src/lint` |
| 1 | `src/certify` |
| 1 | `src/__tests__` |

Both views agree on the ranking that matters: `src/cli` and `src/formal` are the
most-touched, most-actively-evolved directories, followed by `src/core`.

Note `src/solvers/llm` shows 10 file-touches in the churn view but the directory
no longer exists on disk (`find src -type d` lists only `src/solvers` and
`src/solvers/free`) — those touches are historical, from a since-removed LLM
solver path. `src/mcp` is likewise referenced nowhere in the current tree.

## Single points of failure

The whole repo is bus-factor 1. The concentration of risk maps to the largest
and most-complex modules, which are also the most-churned:

- **`src/formal/`** — 17 non-test source files, 3,241 LOC, the deepest module in
  the codebase. It houses the Z3 SMT encoding and the entire neurosymbolic
  conflict-detection surface: `contradiction.ts` (327 LOC), `binary-backend.ts`
  (275 LOC, the out-of-process Z3 path), `needs-review.ts` (261 LOC),
  `encode.ts` (251 LOC), `embed.ts` (240 LOC, the ONNX/WASM embedder),
  `model-cache.ts` (237 LOC). This is the algorithmic heart of the tool and the
  hardest area to onboard a second person into. It also carries the dynamic
  `z3-solver`, `onnxruntime-web`, and `@huggingface/tokenizers` loads
  (`src/formal/backend.ts:45`, `src/formal/embed.ts:110-111`) whose failure
  modes are runtime-only.

- **`src/lint/gtwr.ts`** — a single 885-LOC file implementing ~24 INCOSE GtWR
  lint rules (`src/lint/gtwr.ts:1-3`), each with its own stable code, severity,
  span, and suggestion logic. `src/lint/` is only 2 files / 1,032 LOC, so nearly
  all of the lint domain knowledge lives in this one file. Concentrated
  domain-specific logic in a single file is the classic bus-factor-1 hotspot.

- **`src/cli/index.ts`** — 871 LOC, the most-churned single area (4 distinct
  commits, 22 file-touches for `src/cli`). It is "the thin formatter over the
  library API" (`src/cli/index.ts:1-2`) and defines the agent-facing contract
  spine for every command. Because it is the entry point every consumer hits,
  a regression here is maximally visible, and there is no second maintainer to
  catch it in review.

Mitigation for a solo repo is not adding owners — it is the test and gate
discipline that stands in for a second reviewer: `pnpm check` runs
`biome ci . && tsc --noEmit && vitest run && knip`
(`package.json` scripts), and every source directory has a paired `__tests__`
sibling (`find src -type d`). Those gates are, effectively, the only reviewer
this code has.


## See also

- [symspec · Component diagram](../diagrams/architecture/components.md) — 4 shared source citations
- [symspec · Module map](../architecture/module-map.md) — 4 shared source citations
- [symspec · System overview](../architecture/system-overview.md) — 4 shared source citations
- [symspec · Contract map](../insights/contract-map.md) — 3 shared source citations
- [symspec · Data flow](../architecture/data-flow.md) — 3 shared source citations
