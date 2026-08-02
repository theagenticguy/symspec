---
title: Effect 4.0.0-beta.102 CLI/Layer API reality — 8 verified deltas vs recall, incl. two SILENT manifest/help failures
track: knowledge
category: conventions
module: packages/symspec (greenfield)
component: effect
severity: high
tags: [effect, v4, unstable-cli, schema, layer, jsonschema, logger, cold-start]
applies_when:
  - writing any Effect v4 code in the symspec greenfield (every G1+ Act brief)
  - deriving manifest/help from Schema annotations
pattern: |
  Verified against installed .d.ts / live probes in spikes S2+S3
  (session-d4dc8e, effect 4.0.0-beta.102). Recall was wrong on each:

  1. `Layer.scoped` DOES NOT EXIST — `Layer.effect` is it (its signature's
     `Exclude<R, Scope>` is the tell); use Effect.acquireRelease inside.
  2. `Effect.fork` DOES NOT EXIST — forkChild/forkIn/forkScoped/forkDetach.
  3. `Effect.async` DOES NOT EXIST — `Effect.callback`; its RETURN VALUE is
     the canceler and may itself be an Effect (this is what makes an async
     Z3 finalizer expressible).
  4. `withDecodingDefaultKey` takes `Effect.succeed(v)`, not a thunk — and
     does NOT emit `default` into JSON Schema; annotate explicitly or the
     manifest hides defaults (SILENT).
  5. `Schema.Finite` nests `description` under `allOf` — help renders the
     flag doc BLANK and nothing fails (SILENT). Diff help against manifest
     as a test; promote the S2 drift checks into the real suite.
  6. `Runtime.errorReported` is INVERTED — set false to suppress the extra
     stack trace after your JSON error envelope (default duplicates it).
  7. Default logger writes to STDOUT and corrupts the envelope an agent
     parses — `Logger.LogToStderr` is a Context.Reference (service VALUE,
     not a Layer); mandatory on every surface.
  8. Cold-start attribution: ~72ms is unstable/cli + platform-node init,
     per-PROCESS fixed; Effect core ~6ms; ops table ~6ms for 4 commands.
     22 ops ≈ single-digit ms more. Spike manifest: 108.8ms p50 vs donor
     239.1ms (2.2x faster). Loadavg swings (7→25) tripled p50 on the same
     command — always record loadavg beside benchmarks.
example_files:
  - .erpaval/sessions/session-d4dc8e/spikes/S2-KERNEL-FINDINGS.md
  - .erpaval/sessions/session-d4dc8e/spikes/S3-LAYER-FINDINGS.md
---

# Why this matters

Three sibling codebases documented "v4 differs from recall and training data;
each delta cost real debugging time." These 8 are symspec-greenfield-specific
additions, verified once so no G1+ agent pays for them again. Items 4 and 5
are silent failures caught only by drift-diffing in a 3-op toy — the strongest
argument for the drift checks being first-class tests in G1.
