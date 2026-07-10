---
title: Derive manifest, AGENTS.md, and code tables from Zod .describe() + enums — drift becomes a test failure, not a review comment
track: knowledge
category: architecture
module: src/cli/manifest.ts, scripts/gen-agents.ts
component: zod
severity: medium
tags: [agent-friendly-cli, manifest, zod, describe, single-source, drift-gate, append-only]
applies_when:
  - building an agent-facing CLI that needs docs, help text, and a machine-readable surface
  - adding a command, error code, or finding code to symspec
pattern: |
  One corpus, many projections. Every field/command/code carries its prose on
  the schema itself (Zod .describe(), per-code described literals in
  *Meta objects). Everything else derives:
    - `symspec manifest` builds tables via z.toJSONSchema(..., {io:'input'})
      and the code catalogs (buildCodeCatalog reads live .describe()).
    - AGENTS.md is generated from buildManifest() (scripts/gen-agents.ts);
      a lefthook pre-push diff gate (check:agents) fails on drift, and a test
      asserts the committed file contains the live manifest strings verbatim.
    - Append-only discipline: ERR_*/GTWR_*/FND_* enums + the envelope type
      enum each have snapshot guards (prefix-must-match, length-only-grows);
      the manifest schema pins apiVersion/scope with z.literal so a drifted
      value fails the manifest's own validation.
  Cross-boundary drift (committed file vs live code) can't be caught by an
  in-memory mutation test — the regenerate-and-diff gate is the mechanism.
example_files:
  - src/cli/manifest.ts
  - scripts/gen-agents.ts
  - src/__tests__/agents-md.test.ts
---

# Why this matters

Hand-maintained agent docs contradict the code within weeks. Making every
human- and agent-readable surface a projection of the schema corpus means a
.describe() edit updates CLI help, manifest, and AGENTS.md together — or CI
fails. New codes appear in all tables automatically.

# What NOT to do

Do not add a command or code with a hand-written row in any doc/table. Add it
to the enum/COMMAND_SPECS with .describe(), regenerate, commit both.
