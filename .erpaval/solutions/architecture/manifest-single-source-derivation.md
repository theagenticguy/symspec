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

# The blind spot: text is single-sourced, but the FLAG NAME is not

The single-source derivation guarantees the manifest's description PROSE matches
the Zod `.describe()` — but it does NOT guarantee the flag the prose names is the
flag the parser actually registers. These are two independent sources: the
`.describe()` string lives in `manifest.ts`; the `.option()`/`.argument()`
registration lives in `index.ts`. Nothing cross-checked them, so a command that
reused a SHARED describe-field whose text hardcodes a flag (`docFileOpt` says
"supplied as the `--file <path>` option") while registering a DIFFERENT flag
(`apply` registers `--doc`, because its positional is already the JSONL op
stream) drifted silently. The manifest told an agent to run `apply --file`,
which returns ERR_USAGE — and the flagship "agent drives from the manifest"
promise broke on the flagship command. Every text-vs-Zod test still passed.

Two fixes, both needed:
- Give the outlier command its OWN describe-field (`docApplyOpt` describing
  `--doc`) instead of reusing a field whose text hardcodes another flag. Never
  reuse a shared `.describe()` whose prose names a specific flag on a command
  that registers a different one.
- Add a MANIFEST ROUND-TRIP TEST that closes the gap: introspect the exported
  commander `program` (`cmd.options[].long`, `cmd.registeredArguments`) and
  assert every manifest-documented field maps to a real registration — a field
  whose description embeds a literal `` `--flag` `` must have that exact option
  registered. Prove it's not a tautology by reverting the fix and watching it
  fail (the buggy `apply→docFileOpt` state failed 3/4 round-trip assertions).
  Exporting `program` for introspection needs a guard so importing `index.ts`
  in a unit test doesn't run `main()` — gate on
  `process.argv[1] === fileURLToPath(import.meta.url)` (integration spawns) OR
  absence of `process.env.VITEST` (prod; VITEST leaks to spawned children, so
  the isEntry check is load-bearing for integration spawns).

Cross-boundary drift needs a cross-boundary test. A regenerate-and-diff gate
catches committed-file-vs-code drift (AGENTS.md); a round-trip parse-introspect
test catches manifest-text-vs-parser-registration drift. Same failure class
(two independent sources of one fact), two different gates.

example_files_addendum:
  - src/cli/__tests__/manifest-roundtrip.test.ts
