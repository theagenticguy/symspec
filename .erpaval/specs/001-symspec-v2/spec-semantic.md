# Core v2 — Semantic paraphrase-bridging tier (EARS spec addendum)

Promoted from follow-up to CORE v2 on 2026-07-10. symspec's goal is
*conflict-free specifications*; a contradiction hidden only because two
responses are worded differently ("issue a session token" vs "issue a login
credential") is a conflict symspec MUST surface. Lexical Jaccard
(`FND_SIMILAR_UNUNIFIED`) misses paraphrases; local embeddings bridge them.

## Architecture — propose vs. decide (the load-bearing invariant)

The formal verdict path stays PURELY deterministic. Embeddings never produce a
conflict verdict. Two mechanisms, cleanly split:

- **Propose (fuzzy, embeddings):** an embedding pass over per-system response
  atom texts flags high-cosine unmerged pairs as **info-tier**
  `FND_SIMILAR_SEMANTIC` findings, each suggesting a concrete glossary merge.
- **Decide (deterministic, SMT):** a committed **glossary** in the doc maps
  synonymous phrasings to one canonical atom. `atomize` consults the glossary,
  so glossary-merged responses become the SAME atom and a real contradiction
  becomes provable by the existing SMT tier. Given (doc + glossary + pinned
  model), `check` is byte-reproducible — the fuzzy step ran once, was reviewed,
  and is versioned in git.

This is INCOSE C11 (consistent glossary terms) made mechanical.

## Acceptance criteria

**AC-9-1 [P]** — Ubiquitous: the document schema shall carry an optional
`glossary`: an array of `{ canonical: string, aliases: string[] }` entries,
validated by Zod, defaulting to `[]`, persisted in the JSON doc. SCHEMA_VERSION
stays 2 (v2 has not shipped). Verification: unit (schema round-trips; default []).

**AC-9-2 [P]** — Ubiquitous: `atomize` shall accept an optional glossary map and,
when a normalized response phrase matches an alias (or canonical), emit the
atom for the canonical phrase instead — so glossary-merged phrasings collide.
Purity preserved; no glossary ⇒ identical output to today.
Dependencies: AC-9-1. Verification: unit (aliased pair → same atom; antonym +
negation polarity still respected; no-glossary parity).

**AC-9-3** — Event-driven: When `check` runs with a glossary present, symspec
shall thread it through the encode/atomize path so contradiction/subsumption/
redundancy see canonicalized atoms — turning a paraphrased contradiction into a
real `FND_CONTRADICTION`. Dependencies: AC-9-2, AC-6-8. Verification: pipeline
test (two reqs, same trigger, responses "issue a session token" / "not issue a
login credential", glossary unifies token≡credential → FND_CONTRADICTION with
both ids; WITHOUT glossary → no contradiction, an FND_SIMILAR_* instead).

**AC-9-4 [P]** — Ubiquitous: symspec shall provide a local embedding backend
using `@huggingface/transformers` feature-extraction with
`onnx-community/bge-base-en-v1.5-ONNX`, `{ pooling: 'mean', normalize: true }`,
lazy-imported (never on the default `check` path), model files resolved from a
local cache. Offline: `env.allowRemoteModels` gated; when the model is absent
and remote loading is disallowed, an `ERR_EMBED_MODEL_MISSING` envelope carries
a download suggestion — never blocking the SMT/lint tiers (mirrors the Lean
toolchain discovery pattern). Verification: unit (backend loads a cached model;
absent+offline → ERR_EMBED_MODEL_MISSING).

**AC-9-5** — Event-driven: When `check --semantic` is passed (opt-in; default
off so the base path stays zero-dependency-cost), symspec shall embed the
per-system response atoms, and for each unmerged pair with cosine ≥ a threshold
(default 0.82, `--semantic-threshold`) NOT already unified by atomize/glossary,
emit an info-tier `FND_SIMILAR_SEMANTIC` finding naming both ids, the cosine,
and a `symspec glossary add <canonical> <alias>` suggestion.
Dependencies: AC-9-4, AC-6-8. Verification: pipeline test (paraphrase pair fires
FND_SIMILAR_SEMANTIC; already-glossary-merged pair does not; identical text does
not).

**AC-9-6 [P]** — Ubiquitous: symspec shall provide a `glossary` command group —
`glossary add <canonical> <alias>`, `glossary list`, `glossary remove
<canonical> <alias>` — mutating the doc's glossary and re-saving, each returning
a typed envelope. Adding is idempotent. Dependencies: AC-9-1. Verification:
spawn (add then list shows the pair; check then re-detects fewer semantic
findings).

**AC-9-7** — Ubiquitous: the `FND_SIMILAR_SEMANTIC` code shall be appended to
`FndCodeSchema` (append-only) with a `.describe()`, and the manifest scope text
shall state that semantic similarity is a PROPOSE-only assist that never
produces a verdict. Dependencies: AC-9-5. Verification: unit (snapshot guard;
manifest scope substring).

## Non-goals (unchanged)

No network calls in the product (model is local/cached). No embedding in the
verdict path. The glossary is the only durable bridge; the model only proposes.

## Determinism statement (manifest scope addendum)

"Semantic similarity (`--semantic`) is a propose-only assist: it suggests
glossary merges but never emits a conflict verdict. `check` remains
reproducible given the document, its glossary, and the pinned embedding model."
