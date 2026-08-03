---
title: A hand-written count in generated prose is the same defect as a hand-written table — and needs a NEGATIVE guard
track: knowledge
category: conventions
module: packages/symspec/src/kernel/catalog.ts, craft corpus
component: single-source-derivation
severity: medium
tags: [drift-gate, single-source, generated-docs, agent-surface, counts]
applies_when:
  - generated prose mentions the size of any corpus (codes, commands, rules)
  - reviewing a wave that grows a catalog
pattern: |
  G5 found six sentences across two agent-facing surfaces saying "all 75
  stable codes" after G4 made it 80 — including the INSTALLED SKILL.md
  sitting in agents' context windows. Every drift gate was green: the
  byte-diff regenerates to match (so it agrees with the wrong prose), and
  the completeness loop asserted titles, not numbers.

  Rule: any number in generated prose that describes the size of a corpus
  must be INTERPOLATED from that corpus (catalogCounts()), never typed.
  The guard needs the NEGATIVE assertion (not.toContain('all 75')) —
  a positive-only check passes on prose containing both numbers.

  Sibling lesson from the same wave: content assertions over Markdown must
  be reflow-insensitive (flatten newlines/emphasis, assert the sentence) —
  raw-byte assertions turn paragraph reformatting into test failures and
  train people to never reflow docs.
example_files:
  - packages/symspec/src/kernel/catalog.ts
---

# Why this matters

The single-source discipline covered tables, ops, codes, and scope claims,
and STILL shipped a stale count through a green suite — prose numbers are
the blind spot of regenerate-and-diff gates. The fix (9d2b83f) makes the
count a projection like everything else.
