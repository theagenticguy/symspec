# symspec · Sequence diagrams

## 1. `symspec check` end to end (all tiers)

`runCheck` runs the tiers in a forced order: Tier-0 structural analyze, GtWR lint, the always-on deterministic ambiguity family, then the waiver-aware AC-3-7 gate partition, then the free + formal tiers inside `runSolvers` (`src/pipeline/check.ts:682-1006`). Inside the formal callback it atomizes through the committed glossary + antonyms, gets the shared Z3 context, and runs contradiction/subsumption/vacuity/completeness/similar/needs-review over the gate-included subset (`src/pipeline/check.ts:781-795`). The numeric tier and the two propose-only signals (quantity-alias, relational-unchecked) run over ALL requirements, because those are independent of the propositional-encoding soundness the gate protects (`src/pipeline/check.ts:822`, `src/pipeline/check.ts:835`, `src/pipeline/check.ts:856`). The temporal tier runs only when `--temporal` is set, and the semantic + opposition + graph passes only when `--semantic` is set — all propose-only (`src/pipeline/check.ts:871`, `src/pipeline/check.ts:884-927`). Back in `runCheck`, one `FND_EXCLUDED_FROM_FORMAL` per gate-excluded requirement is emitted (`src/pipeline/check.ts:1030`), waivers are dropped, and `verified` is computed as `demotions.length === 0` — a demotion-only verdict where propose signals and coverage gaps can only push it FALSE (`src/pipeline/check.ts:1289`). The report is wrapped in a `success('check', ...)` envelope with the exit code from `exitCodeForEnvelope` (`src/cli/index.ts:632`, `src/cli/index.ts:161`).

```mermaid
sequenceDiagram
    participant CLI as check action (cli/index.ts)
    participant Pipe as runCheck (pipeline/check.ts)
    participant Gate as gateRequirements (waiver-aware)
    participant Solv as runSolvers
    participant Z3 as Z3 context (SMT)
    participant Num as numeric + propose signals
    participant OptTier as temporal / semantic (opt-in)
    CLI->>Pipe: runCheck(doc, checkOpts)
    Pipe->>Pipe: analyze + GtWR lint + detectAmbiguity
    Pipe->>Gate: gateRequirements(reqs, waivers) → excludedIds
    Gate-->>Pipe: included / excluded (waived lint re-admits)
    Pipe->>Solv: runSolvers(doc, { formal })
    Solv->>Z3: getContext + encode(included)
    Z3-->>Solv: contradiction/subsumption/vacuity/completeness/similar/review
    Solv->>Num: findNumericContradictions(ALL) + quantity-alias + relational
    Num-->>Solv: FND_NUMERIC_CONTRADICTION (decide) / *_CANDIDATE, *_UNCHECKED (propose)
    opt --temporal / --semantic
        Solv->>OptTier: temporal / semantic+opposition+graph
        OptTier-->>Solv: FND_TEMPORAL_CONTRADICTION / propose-only findings
    end
    Solv-->>Pipe: FormalTierResult
    Pipe->>Pipe: emit FND_EXCLUDED_FROM_FORMAL, drop waivers, sort + counts
    Pipe->>Pipe: demotions[] → verified = demotions.length === 0
    Pipe-->>CLI: CheckReport (verified, coverage.demotions)
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

## 3. The PROPOSE → DECIDE author loop (issue #2)

The two-pass loop that closes reproducer-a. Pass 1: one physical quantity phrased two ways ("complete the infusion within ≤30 min" vs "run the infusion for ≥60 min") splits onto two quantity keys, so the numeric tier never compares them; `findQuantityAliasCandidates` fires a propose-only `FND_QUANTITY_ALIAS_CANDIDATE` that DEMOTES `verified` and carries the exact `glossary add` command (`src/formal/quantity-alias.ts:160`, `src/pipeline/check.ts:835`). The author commits the alias via `glossaryAdd` (`src/cli/glossary.ts:58`) — the only step that touches the decide-tier surface. Pass 2: the committed glossary is passed as the numeric quantity-alias map, `quantityKey` canonicalizes both labels to one key (`src/pipeline/check.ts:809`, `src/formal/numeric.ts:170`), and the LIA/LRA solver proves `FND_NUMERIC_CONTRADICTION` (≤30 ∧ ≥60 UNSAT). A fuzzy signal only proposed; only the sound solver decided. Pinned as a regression fixture (`adversarial/eval-rounds.ts:589`).

```mermaid
sequenceDiagram
    participant Author as author / agent
    participant Check as symspec check
    participant Alias as findQuantityAliasCandidates
    participant Gloss as glossaryAdd (cli)
    participant Num as numeric tier (LIA/LRA)
    Note over Author,Num: Pass 1 — abstain (PROPOSE)
    Author->>Check: symspec check
    Check->>Num: findNumericContradictions (two verb-phrasings, split keys)
    Num-->>Check: no same-quantity conflict found
    Check->>Alias: same-system+trigger, opposed bounds, shared object
    Alias-->>Check: FND_QUANTITY_ALIAS_CANDIDATE (+ glossary add cmd)
    Check-->>Author: verified=false, demotion: quantity-alias-candidate
    Note over Author,Num: commit the DECIDE-tier artifact
    Author->>Gloss: symspec glossary add "infusion within" "run the infusion"
    Gloss-->>Author: alias committed to doc.glossary
    Note over Author,Num: Pass 2 — prove (DECIDE)
    Author->>Check: symspec check (re-run)
    Check->>Num: findNumericContradictions (alias map → one key)
    Num-->>Check: FND_NUMERIC_CONTRADICTION (≤30 ∧ ≥60 UNSAT) naming both
    Check-->>Author: error finding, candidate stops firing
```

## See also

- [Module map](../../architecture/module-map.md) — 8 shared source citations
- [Processes](../../behavior/processes.md) — 8 shared source citations
- [System overview](../../architecture/system-overview.md) — 4 shared source citations
- [Component diagram](../architecture/components.md) — 4 shared source citations
- [Business logic](../../insights/business-logic.md) — 4 shared source citations
