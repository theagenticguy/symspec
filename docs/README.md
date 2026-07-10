# symspec · Documentation

Generated codebase documentation for `symspec` — a neurosymbolic EARS
requirements spec validator for coding agents. Prose is generated; structure is
mechanical. Cross-references are deterministic (docs sharing ≥ 2 source
citations link to each other under `## See also`).

Start with [Architecture · System overview](architecture/system-overview.md) for
the two-paragraph orientation, then follow the map below.

## Architecture

- [System overview](architecture/system-overview.md) — what symspec is, the stack, and the check pipeline diagram.
- [Module map](architecture/module-map.md) — every `src/` module and its load-bearing files.
- [Data flow](architecture/data-flow.md) — how a document moves through parse → lint → SMT → semantic → envelope.

## Reference

- [CLI reference](reference/cli.md) — all commands, flags, envelope types, and environment variables.
- [Public API](reference/public-api.md) — the library-first exported surface (`import { runCheck } from 'symspec'`).

## Behavior

- [Processes](behavior/processes.md) — what actually runs during `check`, the parse ladder, SMT contradiction, semantic load, and `certify`.

## Diagrams

- [Component diagram](diagrams/architecture/components.md) — components and their relationships (classDiagram).
- [Dependency graph](diagrams/structural/dependency-graph.md) — internal modules + external deps (flowchart).
- [Sequence diagrams](diagrams/behavioral/sequences.md) — call order for `check --semantic`, `download-model`, and the paraphrase proof.

## Insights

- [Impact analysis](insights/impact-analysis.md) — if I change X, what breaks?
- [Contract map](insights/contract-map.md) — what each module boundary assumes.
- [Business logic](insights/business-logic.md) — EARS patterns, GtWR rules, conflict semantics, the propose/decide invariant.
- [Debugging guide](insights/debugging-guide.md) — error codes, failure modes, and where to look first.
- [Tech debt](insights/tech-debt.md) — the ranked register (the honest `certify` placeholder, threshold calibration).

## Analysis

- [Ownership](analysis/ownership.md) — module churn and bus-factor reality.
- [Dead code](analysis/dead-code.md) — knip findings and the deliberate carve-outs.

---

Regenerate the breadth-scan input with `npx repomix@latest --style json --output docs/.repomix/codebase.json`. Citations are of the form `` `path:LINE` `` and point at the source tree at generation time.
