---
title: A propose-only similarity threshold should favor recall and be MEASURED against the real model, not guessed — 0.82 sat above the entire paraphrase band
track: knowledge
category: architecture
module: src/formal/semantic.ts, src/formal/graph.ts, src/formal/embed.ts
component: onnxruntime-web
severity: medium
tags: [embeddings, bge-onnx, cosine-threshold, recall, propose-only, calibration, magic-number, no-instruction-prefix]
applies_when:
  - choosing a cosine/similarity cutoff for an embedding-based detector
  - a paraphrase/similarity tier under-recalls (misses plausible matches) at its default
  - a threshold is a bare magic number with no measured/documented rationale
pattern: |
  symspec's `check --semantic` tier is PROPOSE-only: high-cosine unmerged
  response atoms become info-tier FND_SIMILAR_SEMANTIC suggestions to add a
  glossary entry; the SMT verdict never reads the score (see the sibling
  embeddings-propose-smt-decide lesson). The default cut was a bare
  `DEFAULT_THRESHOLD = 0.82`, duplicated independently in semantic.ts AND
  graph.ts, with NO rationale anywhere and NO test exercising the real model
  (tests inject hand-authored 2-D unit vectors that trivially clear any cut).

  Measuring the ACTUAL model settled it. Running the repo's own embedder
  (Xenova/bge-base-en-v1.5 int8, CLS-pooled, L2-normalized, and crucially NO
  instruction prefix — BGE was trained with a retrieval query prefix this code
  omits, which compresses scores below the numbers people cite from BGE
  benchmarks) over generic pairs produced three clean bands:
    - unrelated same-domain (noise floor):     ~0.44–0.58
    - divergent-wording paraphrases:           ~0.75–0.79   ("issue a session
      token" vs "issue a login credential" = 0.7498)
    - near-identical paraphrases:              ~0.87–0.89
  So 0.82 sat ABOVE the entire divergent-paraphrase band — every same-intent /
  different-head-noun pair was silently missed. Retuned to 0.72: captures the
  ~0.75 paraphrases with headroom, keeps a ~0.14 margin above the ~0.58 floor.

  Two decisions that generalize:
  - FAVOR RECALL when the tier is propose-only. A false suggestion costs the
    agent one ignored `glossary add`; a miss hides a real paraphrased conflict
    behind distinct atoms (the expensive failure for a consistency checker).
    Asymmetric cost → bias the cut toward recall.
  - Kill the magic number: export a NAMED constant
    (`DEFAULT_SEMANTIC_THRESHOLD`) with a doc-comment carrying the measured
    bands + the no-prefix caveat + the recall rationale, and have the manifest
    entry INTERPOLATE the constant so the documented default can never drift
    from the code. A second, genuinely-different use (graph tier's
    FND_MISSING_TRACE_LINK measures full-sentence relatedness / near-duplication,
    not response synonymy, and errs toward PRECISION) keeps its own named
    constant `DEFAULT_GRAPH_THRESHOLD = 0.82` with its own rationale — same value
    by coincidence, different judgment, so DON'T couple them.
example_files:
  - src/formal/semantic.ts
  - src/formal/graph.ts
  - src/formal/__tests__/semantic.test.ts
---

# Why this matters

A similarity threshold copied from a model's benchmark reputation (or picked by
vibe) is almost always wrong for YOUR pooling + prefix + normalization setup.
BGE without the retrieval instruction prefix scores materially lower than its
published numbers, so an "obviously safe" 0.82 silently excluded every real
paraphrase the tier existed to catch. Ten minutes running the actual embedder
over a dozen labelled pairs turns a guessed magic number into a defensible,
documented cut — and reveals the true separation band so the value is chosen,
not inherited.

# What NOT to do

Do not pick a cosine cut from a model's benchmark numbers without measuring your
own pipeline (pooling, L2, and especially whether you apply the model's
instruction prefix). Do not leave a threshold as a bare literal — name it,
document the measured band, and single-source it into the manifest. Do not
couple two thresholds just because they share a value today; if they encode
different judgments (recall-favoring paraphrase vs precision-favoring
relatedness), give each its own named constant and rationale.
