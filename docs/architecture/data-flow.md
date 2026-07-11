# symspec · Data flow

How a requirements document moves through `symspec check` — from bytes on disk to a typed envelope — and the two internal flows that make paraphrased contradictions provable.

## Flow 1 — The `check` pipeline

`symspec check` runs a strictly-ordered tier stack: load and validate the document, run structural analysis, GtWR lint, and the always-on ambiguity family, gate statements before symbolization, then the formal tiers, all folded into one `CheckReport`. The order is forced — `parse → lint → symbolize → solve` — so the propositional SMT layer never receives unsound input (`src/pipeline/check.ts:23-30`).

The CLI reads the file through the single validation funnel `loadRequirementsDoc` (`src/core/load.ts:106`), which throws typed `ERR_DOC_PARSE` / `ERR_SCHEMA_VERSION` on malformed input, then calls `runCheck` (`src/pipeline/check.ts:311`). `runCheck` layers findings in fixed order: Tier-0 structural via `analyze` (`src/pipeline/check.ts:315`), GtWR lint per-statement and set-level (`src/pipeline/check.ts:318`), the deterministic always-on ambiguity family (`src/pipeline/check.ts:324`), then the AC-3-7 exclusion gate `gateRequirements` partitions out unsound statements (`src/pipeline/check.ts:336-337`). Inside the injected formal closure it runs the propositional checks over the gate-INCLUDED subset — contradiction, subsumption, vacuity, completeness, similar-ununified, needs-review (`src/pipeline/check.ts:372-386`) — the numeric/arithmetic tier over ALL requirements (`src/pipeline/check.ts:396-406`), the opt-in bounded temporal tier over ALL requirements when `--temporal` is set (`src/pipeline/check.ts:412-419`), and the opt-in `--semantic` paraphrase pass plus embedding graph over the included subset (`src/pipeline/check.ts:425-453`). Unsat-triggered findings gain their atom-table evidence via `attachEvidenceToAll` (`src/pipeline/check.ts:456-459`); findings are sorted stably and tallied into severity counts (`src/pipeline/check.ts:527-532`). The module never imports the Lean tier (`src/pipeline/check.ts:18-21`).

```mermaid
sequenceDiagram
    participant CLI as cli/index.ts
    participant Load as core/load.ts
    participant Run as runCheck
    participant An as core/analyze.ts
    participant Amb as formal/ambiguity.ts
    participant Gate as pipeline/gate.ts
    participant SMT as SMT propositional
    participant Num as numeric + temporal
    participant Sem as semantic + graph
    participant Env as cli/envelope.ts
    CLI->>Load: loadRequirementsDoc(path)
    Load-->>CLI: validated Doc (or ERR_DOC_PARSE)
    CLI->>Run: runCheck(doc, opts)
    Run->>An: analyze(doc) — Tier 0 structural
    An-->>Run: FND_DANGLING / CYCLE / ORPHAN / LEAF
    Run->>Run: GtWR lint (per-stmt + set)
    Run->>Amb: detectAmbiguity — always-on
    Amb-->>Run: FND_AMBIGUOUS_* / NEEDS_JUDGMENT
    Run->>Gate: gateRequirements(requirements)
    Gate-->>Run: {included, excluded} partition
    Run->>SMT: encode+solve INCLUDED subset only
    SMT-->>Run: contradiction/subsumption/vacuity + evidence
    Run->>Num: numeric over ALL, temporal over ALL when opt-in
    Num-->>Run: FND_NUMERIC / FND_TEMPORAL_CONTRADICTION
    Run->>Sem: semantic + graph over INCLUDED when opt-in
    Sem-->>Run: FND_SIMILAR_SEMANTIC / MISSING_TRACE_LINK (propose)
    Run-->>CLI: CheckReport {findings, excluded, counts}
    CLI->>Env: success('check', report)
    Env-->>CLI: {apiVersion, type:'check', data}
```

## Flow 2 — atomize → encode → SMT

A requirement's text only becomes a solver conflict through `atomize`, the single pure function that turns an EARS slot into a Boolean atom (`src/formal/atomize.ts:135`, ~165 LOC). Two requirements conflict exactly when their responses resolve to the SAME atom with opposite polarity, which makes this the load-bearing soundness component.

`atomize` normalizes conservatively — lowercase, strip one leading article, strip punctuation, underscore-join (`src/formal/atomize.ts:120`) — then applies glossary canonicalization FIRST, so an agent-confirmed alias is rewritten to its canonical phrase before antonym unification runs on response slots (`src/formal/atomize.ts:96`). `encode` threads each requirement through the injected atomizer and builds the guarded-implication formula `guard ⇒ (context ⇒ response)` (`src/formal/encode.ts:205`) as a pure, Z3-free AST. `findContradictions` (`src/formal/contradiction.ts:229`, ~330 LOC) then plans context groups (`src/formal/contradiction.ts:140`), materializes formulas into Z3 `Bool` expressions (`src/formal/encode.ts:260`), and per group asserts that group's context atoms while checking all guards, extracting and minimizing the unsat core (`minimizeCore` at `src/formal/contradiction.ts:189`). Z3 runs in-process on WASM via `getContext` (`src/formal/backend.ts:58`), memoized to init once per process (`src/formal/backend.ts:45-46`).

```mermaid
sequenceDiagram
    participant Req as EncodableRequirement
    participant Norm as normalize
    participant Gloss as glossary lookup
    participant Ant as ANTONYM_INDEX
    participant Enc as encode
    participant Mat as materialize
    participant Z3 as backend Z3 WASM
    participant Find as findContradictions
    Req->>Norm: atomize(kind, text, systemName, negated)
    Norm->>Gloss: normalized body → canonical?
    Gloss-->>Ant: canonical body (resp slots)
    Ant-->>Req: Atom {name: sys__..., negated (XOR)}
    Req->>Enc: encode(req, atomize)
    Enc-->>Find: EncodedRequirement {guard⇒(ctx⇒resp)}
    Find->>Find: planContextGroups (distinct ctx atom sets)
    Find->>Mat: materialize(formula)
    Mat->>Z3: getContext + Solver.add(formulas)
    Find->>Z3: check(...guards) per context group
    Z3-->>Find: unsat + unsatCore
    Find->>Find: minimizeCore → exactly conflicting ids
    Find-->>Req: FND_CONTRADICTION {requirementIds}
```

## Flow 3 — semantic PROPOSE → glossary DECIDE

The semantic tier separates a fuzzy proposal from a deterministic verdict. Embeddings PROPOSE that two differently-worded responses mean the same thing; the committed glossary DECIDEs by canonicalizing them to one atom; the SMT tier then PROVES any contradiction the shared atom exposes. The embedding backend never decides a conflict — its only durable effect is a suggested glossary entry (`src/formal/embed.ts:1-17`, ~240 LOC).

`findSimilarSemantic` (`src/formal/semantic.ts:76`, ~132 LOC) is opt-in (`check --semantic`); the CLI lazily loads the embedder only then (`src/cli/index.ts:356-373`), so the default `check` never touches the model. `loadEmbedder` (`src/formal/embed.ts:205`) resolves the pinned `Xenova/bge-base-en-v1.5` assets through `ensureModelAssets` (`src/formal/model-cache.ts:177`, ~237 LOC), which sha256-verifies every cached file and throws `ERR_EMBED_MODEL_MISSING` on a miss (`src/formal/embed.ts:46`). For each same-system pair that did NOT already unify via `atomize`, it embeds both responses (CLS-pooled, L2-normalized so dot product is cosine — `cosine` at `src/formal/embed.ts:231`) and, above threshold 0.82 (`src/formal/semantic.ts:45`), emits an info `FND_SIMILAR_SEMANTIC` suggesting `symspec glossary add`. Only after the agent commits that entry does the glossary index (`src/formal/atomize.ts:96`) feed it back into `atomize`, collapsing the paraphrases onto one atom so Flow 2 can prove the conflict.

```mermaid
sequenceDiagram
    participant CLI as cli/index.ts --semantic
    participant Load as embed.loadEmbedder
    participant Cache as model-cache.ts
    participant Sem as findSimilarSemantic
    participant Emb as Embedder (BGE WASM)
    participant Agent as calling agent
    participant Atom as atomize + glossary
    participant SMT as findContradictions
    CLI->>Load: loadEmbedder() (lazy, opt-in)
    Load->>Cache: ensureModelAssets(allowRemote)
    Cache-->>Load: sha256-verified assets (or ERR_EMBED_MODEL_MISSING)
    CLI->>Sem: findSimilarSemantic(included, embedder)
    Sem->>Sem: skip pairs already unified by atomize
    Sem->>Emb: embed(response texts)
    Emb-->>Sem: L2-normalized vectors
    Sem->>Sem: cosine ≥ 0.82 ?
    Sem-->>Agent: FND_SIMILAR_SEMANTIC (PROPOSE glossary add)
    Agent->>Atom: symspec glossary add (DECIDE, commit)
    Atom->>SMT: re-run check — paraphrases share one atom
    SMT-->>Agent: FND_CONTRADICTION (PROVE)
```


## See also

- [symspec · Module map](module-map.md) — 12 shared source citations
- [symspec · Component diagram](../diagrams/architecture/components.md) — 9 shared source citations
- [symspec · Contract map](../insights/contract-map.md) — 9 shared source citations
- [symspec · Public API](../reference/public-api.md) — 8 shared source citations
- [symspec · Processes](../behavior/processes.md) — 7 shared source citations
