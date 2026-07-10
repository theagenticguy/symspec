---
title: transformers.js cannot run ONNX WASM in Node — it hard-binds onnxruntime-node at import; drive onnxruntime-web directly
track: knowledge
category: conventions
module: src/formal/embed.ts, src/formal/model-cache.ts
component: onnxruntime-web
severity: high
tags: [onnx, wasm, transformers.js, onnxruntime-web, onnxruntime-node, node, embeddings, portability]
applies_when:
  - you want a Node package to run an ONNX model on pure WASM with no native binary (portability / npm-installability)
  - a design says "ONNX WASM, no native onnxruntime-node build" but the dependency is @huggingface/transformers
  - pnpm/npm pulled in onnxruntime-node and you expected only WASM
pattern: |
  @huggingface/transformers (Transformers.js) v4.x declares BOTH onnxruntime-node
  and onnxruntime-web as hard (non-optional) dependencies, so installing it always
  pulls the native onnxruntime-node prebuilt binary — "no native build" is false at
  install time.

  Worse, it is unfixable at RUNTIME through the library's API. In its backends/onnx.js,
  the ONNX runtime is chosen ONCE at module import by environment detection:
    if (apis.IS_NODE_ENV) { ONNX = onnxruntime_node; defaultDevices = ['cpu']; }
    else                  { ONNX = onnxruntime_web;  defaultDevices = ['wasm']; }
  In Node the `supportedDevices` list is built WITHOUT 'wasm', so:
    - pipeline(..., { device: 'wasm' }) THROWS `Unsupported device: "wasm"`.
    - device: 'cpu' runs on the NATIVE onnxruntime-node CPU EP, not WASM.
    - env.backends.onnx.* is a mirror of the already-selected native runtime — no
      knob swaps in onnxruntime-web.
  The ONLY override is undocumented: set globalThis[Symbol.for('onnxruntime')] to
  onnxruntime-web BEFORE importing the library — but that branch skips
  supportedDevices population, so you then must pass executionProviders manually.
  Not a supported "use web in node" switch.

  Conclusion: if the requirement is genuinely "pure WASM, no native binary in Node",
  Transformers.js CANNOT satisfy it. Remove it and drive onnxruntime-web directly:
    - Import onnxruntime-web (its `./wasm` subpath export resolves to a pure-WASM
      bundle; the default node entry works too). Set ort.env.wasm.numThreads = 1
      (safe in Node — no SharedArrayBuffer/worker; also avoids a multi-thread hang
      on external-data models). Create the session with executionProviders: ['wasm'].
    - Tokenize with @huggingface/tokenizers (HF-official, pure-JS, zero-dep) — it
      reads the model's tokenizer.json/tokenizer_config.json and produces
      byte-identical input_ids to what Transformers.js did.
    - Feed input_ids / attention_mask / token_type_ids as int64 [batch, seq];
      token_type_ids (zeros) is a REQUIRED input for the BERT/BGE export.
    - Pool per the model's spec. BGE = CLS pooling (last_hidden_state[:, 0]) then
      L2-normalize. Transformers.js `pooling: 'mean'` was OFF-SPEC for BGE.

  Prefer single-file quantized exports (e.g. Xenova/bge-base-en-v1.5
  model_quantized.onnx) over onnx-community external-data (.onnx_data) exports:
  a single .onnx needs no `externalData` wiring and sidesteps the multi-thread hang.
example_files:
  - src/formal/embed.ts
  - src/formal/model-cache.ts
---

# Why this matters

A "portable, npm-installable, no compiler" promise is silently broken if the
embedding dependency drags in a native binary AND ignores your attempt to force
WASM. The failure is invisible in tests (mocks bypass the runtime) and only shows
as an installed onnxruntime-node .node file plus native-CPU inference — the exact
opposite of the stated design. Verify the runtime that actually executes, not the
docstring.

# What NOT to do

Do not add `{ device: 'wasm' }` to a Transformers.js pipeline() call in Node and
assume it forces WASM — it throws. Do not trust that listing only
@huggingface/transformers keeps you WASM-only — onnxruntime-node rides in
transitively. If you need WASM in Node, own the onnxruntime-web + tokenizer stack
directly.
