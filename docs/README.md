# symspec · documentation

Generated documentation tree for `symspec`. *Prose is generated; structure is mechanical. Cross-references are deterministic.*

Start with [System overview](architecture/system-overview.md) for the mental model, then drill into the area you need.

## Architecture

- [System overview](architecture/system-overview.md) — narrative + stack + module Mermaid map.
- [Module map](architecture/module-map.md) — per-module file inventory with LOC counts and roles.
- [Data flow](architecture/data-flow.md) — three sequence diagrams covering the three flows.

## Reference

- [Public API](reference/public-api.md) — every exported symbol grouped by file.
- [CLI reference](reference/cli.md) — the 11 `req` subcommands with flags.
- [MCP tool reference](reference/rpc-tools.md) — the 8 MCP tools and their input shapes.

## Behavior

- [Processes](behavior/processes.md) — five end-to-end processes from input to side effect.

## Analysis

- [Dead code](analysis/dead-code.md) — knip output plus manual scan of unreferenced exports/files/imports.

## Diagrams

- [Component diagram](diagrams/architecture/components.md) — class-diagram view of the named components.
- [Dependency graph](diagrams/structural/dependency-graph.md) — internal modules + external deps.
- [Behavioral sequences](diagrams/behavioral/sequences.md) — three sequence diagrams for the top processes.

## Insights

The "ultra-explore" extension — what the codebase quietly assumes and what changes if you touch it.

- [Impact analysis](insights/impact-analysis.md) — if I change X, what breaks?
- [Debugging guide](insights/debugging-guide.md) — when something breaks, where to look.
- [Contract map](insights/contract-map.md) — what each module assumes about its callers and callees.
- [Business logic](insights/business-logic.md) — domain rules, validations, invariants, calculations.
- [Tech debt register](insights/tech-debt.md) — ranked register with cost-of-removal estimates.

## Out of scope (not generated)

The skill emits conditional files only when their subject exists. These were intentionally omitted:

- `behavior/state-machines.md` — only one state machine (the requirement `status` lifecycle: `draft → approved → implemented → verified` per `src/core/schema.ts:38`); the threshold is ≥ 2.
- `analysis/risk-hotspots.md` and `analysis/ownership.md` — repo has 4 commits and a single author; no meaningful activity or ownership signal.

## Structure

```
docs/
├── README.md                              # this file
├── architecture/
│   ├── system-overview.md
│   ├── module-map.md
│   └── data-flow.md
├── reference/
│   ├── public-api.md
│   ├── cli.md
│   └── rpc-tools.md
├── behavior/
│   └── processes.md
├── analysis/
│   └── dead-code.md
├── diagrams/
│   ├── architecture/components.md
│   ├── structural/dependency-graph.md
│   └── behavioral/sequences.md
└── insights/
    ├── impact-analysis.md
    ├── debugging-guide.md
    ├── contract-map.md
    ├── business-logic.md
    └── tech-debt.md
```

Source breadth-scan input is at `docs/.repomix/codebase.json` (regenerate with `npx repomix@latest --style json --output docs/.repomix/codebase.json`).
