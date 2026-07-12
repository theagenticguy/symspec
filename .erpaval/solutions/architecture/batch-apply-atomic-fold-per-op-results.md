---
title: Batch CLI mutation — fold the SINGULAR applyChange yourself for per-op results; the plural applyChanges stops on first error
track: knowledge
category: architecture
module: src/cli/apply.ts, src/core/changes.ts
component: commander
severity: medium
tags: [agent-friendly-cli, batch, jsonl, atomic-write, applyChange, per-op-results, resume]
applies_when:
  - adding a batch/bulk command that applies many mutations in one process
  - a caller wants continue-on-error + a per-op results array, not all-or-nothing
  - reducing the "one subprocess per op + external state file" throughput tax
pattern: |
  `applyChanges(doc, changes[])` (plural, core/changes.ts) is a left-fold with
  NO try/catch — the first throw aborts the whole batch. It is fine for an
  atomic "all or nothing" apply, but it CANNOT produce per-op results or a
  continue-on-error tally. For those, fold the SINGULAR `applyChange` yourself:
    let current = doc
    for (const op of ops) {
      try { current = applyChange(current, toChange(current, op)); results.push(ok) }
      catch (e) { results.push(err); if (!continueOnError) return abort() }
    }
  Two load-bearing details:
    - Resolve refs against `current` (the FOLDED doc), not the original — so an
      `add` op's key/id minted earlier in the SAME batch resolves for a later
      op. This is what removes the label->UUID sidecar file entirely.
    - `writeDocFile` is atomic (temp + rename), so save EXACTLY ONCE at the end.
      Atomic-by-default means abort writes nothing and reports the failing op
      index — a crashed batch leaves the doc untouched, giving a resume story
      ("fix the line, re-run") the one-op-per-process path never had.
  Mirror parseBatch's result shape: {results:[{index,ok,id?,code?,error?}], summary}.
example_files:
  - src/cli/apply.ts
  - src/core/changes.ts
  - src/parse/batch.ts
---

# Why this matters

The field report's #1 lever: a 42-req spec took ~150 subprocess calls plus a
sidecar UUID map, with no resume after a crash. One `apply` command over a JSONL
op stream collapses all three problems — throughput, external state, and
partial-failure recovery — but only if you fold `applyChange` yourself. Reaching
for the plural `applyChanges` looks right and silently gives up per-op results
and continue-on-error.

# What NOT to do

Do not use `applyChanges` when you need per-op reporting or best-effort mode.
Do not resolve batch refs against the original doc — resolve against the folded
`current` so intra-batch keys work. Do not save per op — accumulate, save once.
