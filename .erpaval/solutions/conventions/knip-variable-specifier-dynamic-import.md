---
title: knip cannot trace `await import(VARIABLE)` — lazy deps loaded via variable specifiers need ignoreDependencies
track: knowledge
category: conventions
module: src/parse/tier2.ts (wink-nlp lazy load)
component: knip
severity: low
tags: [knip, dynamic-import, lazy-loading, ignoreDependencies, ignoreBinaries]
applies_when:
  - a runtime dependency is imported only via `await import(SOME_CONST)` (variable specifier)
  - knip flags a genuinely-used dependency as unused, or a script's shell binary as unlisted
pattern: |
  knip's static analysis resolves `await import('literal')` fine, but not
  `await import(WINK_NLP_SPECIFIER)` where the specifier is a const — a
  pattern we use deliberately so bundlers/knip don't eagerly pull the 4MB
  wink model into the default path. Result: `wink-nlp` and
  `wink-eng-lite-web-model` were flagged as unused dependencies while being
  load-bearing at runtime.

  Fix: `"ignoreDependencies": ["wink-nlp", "wink-eng-lite-web-model"]` in
  knip.json, with a comment-adjacent note (this lesson) explaining WHY, so a
  future cleanup doesn't delete the carve-out and then the deps.

  Related: package.json scripts that shell out to system binaries (our
  check:agents uses `diff`) trip knip's unlisted-binaries rule —
  `"ignoreBinaries": ["diff"]` is the sanctioned fix.
example_files:
  - knip.json
  - src/parse/tier2.ts
---

# Why this matters

The whole point of the variable-specifier import is to keep an optional heavy
dep off the hot path; knip punishing that pattern with an "unused dependency"
error makes the gate fail exactly when the design is correct.

# What NOT to do

Do not switch to a literal `await import('wink-nlp')` just to appease knip —
that re-couples the model download to module-load analysis in bundlers. The
carve-out is the right tool.
