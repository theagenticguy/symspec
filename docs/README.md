# symspec · Documentation

Generated codebase documentation for `symspec` — a neurosymbolic EARS
requirements spec checker for coding agents. Prose is generated; structure is
mechanical. Cross-references are deterministic (docs sharing ≥ 2 source
citations link to each other under `## See also`).

Refreshed at the issue-#2 adversarial-hardening merge (`fabc156`): the
propose/decide + demotion-only doctrine is documented as the spine, and the new
`quantity-alias`, `relational`, and loud-coverage surfaces (`FND_QUANTITY_ALIAS_CANDIDATE`,
`FND_RELATIONAL_UNCHECKED`, `FND_EXCLUDED_FROM_FORMAL`) are covered throughout.

Start with [Architecture · System overview](architecture/system-overview.md) for
the two-paragraph orientation, then follow the map below.

## Architecture

- [System overview](architecture/system-overview.md) — what symspec is, the stack, and the multi-tier check pipeline diagram.
- [Module map](architecture/module-map.md) — every module (`src/`, `adversarial/`, `scripts/`) and its load-bearing files.
- [Data flow](architecture/data-flow.md) — how a document moves through structural → lint → ambiguity → gate → SMT / numeric / temporal / semantic-graph → envelope.

## Reference

- [CLI reference](reference/cli.md) — all commands, flags, envelope types, and environment variables.
- [Public API](reference/public-api.md) — the library-first exported surface (`import { runCheck } from 'symspec'`).

## Behavior

- [Processes](behavior/processes.md) — what actually runs during `check`: the parse ladder, the gate, SMT contradiction, the numeric/ambiguity/temporal tiers, semantic load, `certify`, and the adversarial harness.

## Diagrams

- [Component diagram](diagrams/architecture/components.md) — components and their relationships (classDiagram).
- [Dependency graph](diagrams/structural/dependency-graph.md) — internal modules + external deps (flowchart).
- [Sequence diagrams](diagrams/behavioral/sequences.md) — call order for the full `check` tier fan-out, the parse ladder, and `certify`.

## Insights

- [Impact analysis](insights/impact-analysis.md) — if I change X, what breaks?
- [Contract map](insights/contract-map.md) — what each module boundary assumes.
- [Business logic](insights/business-logic.md) — EARS patterns, GtWR rules, propositional/numeric/temporal/ambiguity conflict semantics, and the verdict-eligibility (propose/decide) invariant.
- [Debugging guide](insights/debugging-guide.md) — error codes, failure modes, and where to look first.
- [Tech debt](insights/tech-debt.md) — the ranked register (the honest `certify` placeholder, threshold calibration).

## Analysis

- [Ownership](analysis/ownership.md) — module churn and bus-factor reality.
- [Dead code](analysis/dead-code.md) — knip findings and the deliberate carve-outs.

---

Regenerate the breadth-scan input with `npx repomix@latest --style json --output docs/.repomix/codebase.json`. Citations are of the form `` `path:LINE` `` and point at the source tree at generation time.
