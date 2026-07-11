# symspec · Sequence diagrams

## 1. `symspec check` end to end (all tiers)

`runCheck` runs the tiers in a forced order: Tier-0 structural analyze, GtWR lint, the always-on deterministic ambiguity family, then the AC-3-7 gate partition, then the free + formal tiers inside `runSolvers` (`src/pipeline/check.ts:311-459`). Inside the formal callback it atomizes through the committed glossary, gets the shared Z3 context, and runs contradiction/subsumption/vacuity/completeness/similar/needs-review over the gate-included subset (`src/pipeline/check.ts:372-386`). The numeric tier runs over ALL requirements, not the gate subset, because numeric conflict is independent of the propositional-encoding soundness the gate protects (`src/pipeline/check.ts:396-406`). The temporal tier runs only when `--temporal` is set, mapping EARS→LTL and proving bounded contradictions on the same context (`src/pipeline/check.ts:412-419`); the semantic + graph passes run only when `--semantic` is set and are propose-only (`src/pipeline/check.ts:425-453`). Finally unsat-triggered findings gain atom-table + core evidence (`src/pipeline/check.ts:456`) and the report is wrapped in a `success('check', ...)` envelope with the AC-6-2b exit code (`src/cli/index.ts:412`, `src/cli/index.ts:97`).

```mermaid
sequenceDiagram
    participant CLI as check action (cli/index.ts)
    participant Pipe as runCheck (pipeline/check.ts)
    participant Gate as gateRequirements
    participant Solv as runSolvers
    participant Z3 as Z3 context (SMT)
    participant Num as numeric tier
    participant Tmp as temporal tier
    participant Sem as semantic + graph
    CLI->>Pipe: runCheck(doc, checkOpts)
    Pipe->>Pipe: analyze (structural) + GtWR lint
    Pipe->>Pipe: detectAmbiguity (always-on)
    Pipe->>Gate: gateRequirements → excludedIds
    Gate-->>Pipe: included / excluded partition
    Pipe->>Solv: runSolvers(doc, { formal })
    Solv->>Z3: getContext + encode(included)
    Z3-->>Solv: contradiction/subsumption/vacuity/completeness/similar/review
    Solv->>Num: findNumericContradictions(ALL reqs)
    Num-->>Solv: FND_NUMERIC_CONTRADICTION
    alt --temporal
        Solv->>Tmp: findTemporalContradictions(ALL, bound)
        Tmp-->>Solv: FND_TEMPORAL_CONTRADICTION (sound-for-UNSAT)
    end
    alt --semantic
        Solv->>Sem: findSimilarSemantic + buildSimilarityGraph(included)
        Sem-->>Solv: FND_SIMILAR_SEMANTIC / MISSING_TRACE_LINK / DUPLICATE_CLUSTER (propose)
    end
    Solv-->>Pipe: FormalTierResult
    Pipe->>Pipe: attachEvidenceToAll + sort + counts
    Pipe-->>CLI: CheckReport
    CLI->>CLI: emit(success('check', report))
```

## 2. Parse ladder (Tier 1 → Tier 2 → Tier 3)

A single line parses through an escalation ladder: `parseLine` runs the Tier-1 regex classifier, escalates to the lazy wink-nlp Tier-2 repair only when triggers fire, and falls to the Tier-3 failure classifier when neither yields a confident EARS structure (`src/parse/result.ts:258`, `src/parse/result.ts:259`, `src/parse/result.ts:237`). Tier 2 lazy-loads `wink-nlp` and reuses the Tier-1 keyword lexicon (`src/parse/tier2.ts:42`); Tier 3 emits a discriminated failure envelope with a stable `ERR_PARSE_*` code (`src/parse/tier3.ts:283`).

```mermaid
sequenceDiagram
    participant Batch as parseBatch / parseLine
    participant T1 as classifyTier1 (regex)
    participant T2 as runTier2 (wink-nlp, lazy)
    participant T3 as makeTier3Envelope
    Batch->>T1: classifyTier1(line)
    T1-->>Batch: EARS classification + confidence
    Batch->>T2: runTier2(input) (escalation triggers)
    T2->>T2: lazy-load wink-nlp, repair clauses
    alt repaired to confident EARS
        T2-->>Batch: ParseResult ok
    else still ambiguous / no modal
        T2->>T3: makeTier3Envelope(text, outcome)
        T3-->>Batch: ParseResult error (ERR_PARSE_*)
    end
```

## 3. `symspec certify` (Lean 4, opt-in)

`certify` is the only command touching `src/certify/*`; it loads the document, discovers the Lean toolchain (raising `ERR_LEAN_TOOLCHAIN_MISSING` on a miss), emits a `.lean` file, and runs Lean over it as an NDJSON stream (`src/cli/index.ts:434`, `src/certify/run.ts:305`, `src/certify/run.ts:310`, `src/certify/run.ts:322`). Each requirement is emitted as a placeholder `True` theorem — this attests the toolchain elaborates, NOT requirement semantics (`src/cli/index.ts:794-807`). It emits `FND_CERTIFIED` / `FND_CERTIFY_FAILED`.

```mermaid
sequenceDiagram
    participant CLI as certify action (cli/index.ts)
    participant Disc as discoverLeanToolchain
    participant Emit as emitLeanFile
    participant Run as runLean (NDJSON)
    participant Lean as lean toolchain
    CLI->>Disc: discoverLeanToolchain()
    alt toolchain missing
        Disc-->>CLI: LeanDiscoveryError → ERR_LEAN_TOOLCHAIN_MISSING
    else discovered
        Disc-->>CLI: toolchain pin
        CLI->>Emit: emitLeanFile(placeholder True theorems)
        Emit-->>CLI: .lean source
        CLI->>Run: runLean(source, opts)
        Run->>Lean: elaborate + parse NDJSON
        Lean-->>Run: per-theorem results + axiom provenance
        Run-->>CLI: FND_CERTIFIED / FND_CERTIFY_FAILED
    end
    CLI->>CLI: emit(success('certify', report))
```


## See also

- [symspec · Data flow](../../architecture/data-flow.md) — 6 shared source citations
- [symspec · Module map](../../architecture/module-map.md) — 6 shared source citations
- [symspec · Component diagram](../architecture/components.md) — 5 shared source citations
- [symspec · Contract map](../../insights/contract-map.md) — 5 shared source citations
- [symspec · Public API](../../reference/public-api.md) — 5 shared source citations
