# symspec · Dependency graph

Internal `src/` modules and their key external npm dependencies, with edges pointing from importer to imported. The CLI depends on `commander` and `zod` and dispatches into the `check` pipeline (`src/cli/index.ts:53`). Every heavy external is lazily imported so the default `check` never pays their cost: `z3-solver` via `await import('z3-solver')` (`src/formal/backend.ts`), `onnxruntime-web` + `@huggingface/tokenizers` inside the embedder factory (`src/formal/embed.ts`), and `wink-nlp` only on parse escalation (`src/parse/tier2.ts`). Runtime dependencies are exactly `@huggingface/tokenizers`, `onnxruntime-web`, `wink-eng-lite-web-model`, `wink-nlp`, and `z3-solver` (`package.json:55-61`); `commander` and `zod` are devDependencies bundled at build (`package.json:66`, `package.json:73`). The v3 formal submodules add external edges: `z3-solver` is now reached by the numeric and temporal tiers as well as the SMT core, and `onnxruntime-web` by the semantic + graph tiers via the embedder.

```mermaid
flowchart LR
    subgraph ext[External deps]
        commander[commander]
        zod[zod]
        z3[z3-solver]
        onnx[onnxruntime-web]
        hf[huggingface/tokenizers]
        wink[wink-nlp]
    end

    cli[cli/index] --> commander
    cli --> zod
    cli --> check[pipeline/check]
    cli --> certify[certify/run]

    check --> gate[pipeline/gate]
    check --> core[core/*]
    check --> gtwr[lint/gtwr]
    check --> solvers[solvers/index]
    check --> smt[formal/smt+encode]
    check --> numeric[formal/numeric]
    check --> temporal[formal/temporal]
    check --> ambiguity[formal/ambiguity]
    check --> embed[formal/embed+semantic+graph]

    smt --> backend[formal/backend]
    numeric --> backend
    temporal --> backend
    backend -.lazy.-> z3
    gtwr --> parse[parse/ladder]
    parse -.lazy.-> wink
    embed -.lazy.-> onnx
    embed -.lazy.-> hf

    classDef internal fill:#1f2937,stroke:#60a5fa,color:#f1f5f9;
    classDef external fill:#4c1d95,stroke:#c084fc,color:#f1f5f9;
    class cli,check,certify,gate,core,gtwr,solvers,smt,numeric,temporal,ambiguity,embed,backend,parse internal;
    class commander,zod,z3,onnx,hf,wink external;
```

Dotted edges (`-.lazy.->`) are dynamic `import()` calls loaded on demand, not at module load.

## Legend

| Node | Type | Module / package | Cite |
|---|---|---|---|
| cli/index | internal | `src/cli/index.ts` | `src/cli/index.ts:53` |
| pipeline/check | internal | `src/pipeline/check.ts` | `src/pipeline/check.ts:311` |
| pipeline/gate | internal | `src/pipeline/gate.ts` | `src/pipeline/check.ts:88` |
| core/* | internal | `src/core/{doc,analyze,schema,render}.ts` | `src/pipeline/check.ts:56` |
| lint/gtwr | internal | `src/lint/gtwr.ts` | `src/pipeline/check.ts:85` |
| solvers/index | internal | `src/solvers/index.ts` | `src/pipeline/check.ts:86` |
| formal/smt+encode | internal | `src/formal/{encode,atomize,contradiction,subsumption,vacuity,incomplete,similar,needs-review}.ts` | `src/pipeline/check.ts:65` |
| formal/numeric | internal | `src/formal/{numeric,numeric-contradiction}.ts` (LIA/LRA, over ALL reqs) | `src/pipeline/check.ts:77` |
| formal/temporal | internal | `src/formal/{temporal,temporal-patterns}.ts` (opt-in `--temporal`) | `src/pipeline/check.ts:82` |
| formal/ambiguity | internal | `src/formal/ambiguity.ts` (always-on) | `src/pipeline/check.ts:61` |
| formal/embed+semantic+graph | internal | `src/formal/{embed,semantic,graph,model-cache}.ts` (opt-in `--semantic`) | `src/pipeline/check.ts:74` |
| formal/backend | internal | `src/formal/backend.ts` (shared Z3 WASM context) | `src/pipeline/check.ts:63` |
| parse/ladder | internal | `src/parse/{tier1,tier2,tier3}.ts` | `src/parse/tier2.ts:42` |
| certify/run | internal | `src/certify/run.ts` (only `certify` reaches it) | `src/cli/index.ts:434` |
| commander | external | `commander@^14` (dev, bundled) | `package.json:66` |
| zod | external | `zod@^4` (dev, bundled) | `package.json:73` |
| z3-solver | external | `z3-solver@^4.16` (runtime, lazy; SMT + numeric + temporal) | `package.json:60` |
| onnxruntime-web | external | `onnxruntime-web@^1.27` (runtime, lazy; embed → semantic + graph) | `package.json:57` |
| @huggingface/tokenizers | external | `@huggingface/tokenizers@^0.1.3` (runtime, lazy) | `package.json:56` |
| wink-nlp | external | `wink-nlp@^2.4` + `wink-eng-lite-web-model` (runtime, lazy) | `package.json:59` |


## See also

- [symspec · Component diagram](../architecture/components.md) — 8 shared source citations
- [symspec · Module map](../../architecture/module-map.md) — 8 shared source citations
- [symspec · System overview](../../architecture/system-overview.md) — 7 shared source citations
- [symspec · Contract map](../../insights/contract-map.md) — 6 shared source citations
- [symspec · Data flow](../../architecture/data-flow.md) — 6 shared source citations
