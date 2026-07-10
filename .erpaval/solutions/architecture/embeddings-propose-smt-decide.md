---
title: Bridge paraphrased conflicts with embeddings-propose / glossary-decide — never let fuzzy scores touch the verdict
track: knowledge
category: architecture
module: src/formal/embed.ts, src/formal/semantic.ts, src/formal/atomize.ts, src/core/schema.ts
component: transformers.js
severity: high
tags: [embeddings, bge-onnx, transformers.js, glossary, determinism, atomize, smt, offline]
applies_when:
  - a formal/deterministic checker misses conflicts because two inputs are worded differently
  - considering embeddings/LLMs to close a "words don't match exactly" gap in a sound tool
pattern: |
  symspec's SMT tier is sound-modulo-atomization: it only catches a conflict
  when the two responses atomize to the SAME atom. "issue a session token" vs
  "issue a login credential" are distinct atoms, so a real contradiction hides.
  Naively adding embeddings to the verdict path would destroy determinism (a
  0.83 cosine merges today, not tomorrow after a model bump).

  The sound design splits PROPOSE from DECIDE:
  - PROPOSE (fuzzy, embeddings): `check --semantic` embeds per-system response
    atoms (transformers.js + onnx-community/bge-base-en-v1.5-ONNX, ONNX WASM —
    no native onnxruntime-node build so the package stays npm-installable),
    mean-pooled + normalized so cosine is a dot product. High-cosine UNMERGED
    pairs become info-tier FND_SIMILAR_SEMANTIC findings suggesting a glossary
    merge. Never a verdict.
  - DECIDE (deterministic, SMT): a committed `glossary` in the doc maps aliases
    → canonical phrasing. `atomize` canonicalizes through it BEFORE the antonym
    step, so glossary-merged responses collide on one atom and the existing SMT
    contradiction check proves the conflict. Given (doc + glossary + pinned
    model) `check` is byte-reproducible — the fuzzy step ran once, was reviewed
    by the agent, and is versioned in git.

  This is INCOSE C11 (consistent glossary terms) made mechanical, and it is the
  general recipe for adding ML to a sound tool: embeddings generate candidates,
  a committed human/agent-reviewed artifact is the only thing the sound layer
  consults.

  Discipline that made it work: model lazy-imported (default `check` pays zero
  cost), offline by default (allowRemoteModels off; ERR_EMBED_MODEL_MISSING when
  absent, never blocking SMT/lint), embedder INJECTED into the pipeline so tests
  use a deterministic fake vector table (no model download in CI). loadEmbedder
  wraps ANY factory failure in the typed error so the contract holds regardless
  of injected factory.
example_files:
  - src/formal/embed.ts
  - src/formal/semantic.ts
  - src/formal/atomize.ts
  - src/pipeline/__tests__/check-semantic.test.ts
  - .erpaval/specs/001-symspec-v2/spec-semantic.md
---

# Why this matters

The tool's entire promise is "conflict-free specs". A conflict hidden by
wording is a promise broken. But closing that gap with ML the wrong way
(fuzzy in the verdict) trades one broken promise (missed conflicts) for a worse
one (non-reproducible verdicts). Propose/decide keeps both.

# What NOT to do

Never let a cosine threshold or an LLM judgment decide a conflict. The only
durable output of the embedding pass is a SUGGESTED glossary entry; the SMT
layer reads the committed glossary, never the model.
