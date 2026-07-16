---
title: Lenient normalization that helps a PROPOSE signal must never be applied to the DECIDE key — it converts a helpful suggestion into a fabricated verdict
track: knowledge
category: architecture
module: src/formal/numeric.ts, src/formal/quantity-alias.ts
component: symspec
severity: high
tags: [propose-decide, sound-modulo-atomization, false-positive, numeric-tier, atomization, adversarial-critic, determinism]
applies_when:
  - fixing a "these two should have matched" miss by loosening how a term is normalized/keyed
  - the same normalization feeds BOTH a verdict-eligible path and a propose-only suggestion path
pattern: |
  To surface reproducer (a) (same quantity, two verbs), the first cut stripped
  trailing comparator words (within/under/over/above/below) from the numeric
  quantity LABEL so "complete the infusion within" and "run the infusion" would
  share a key. It worked for the target case — and fabricated a false
  `FND_NUMERIC_CONTRADICTION` (an ERROR-severity verdict, the cardinal sin under
  sound-modulo-atomization). The adversarial-critic found it: "the carry OVER at
  least 100 mb" and "the carry at most 50 mb" collapsed onto ONE key, inventing a
  conflict between a billing carry-over and an in-flight transfer. The stripped
  words are also phrasal-verb noun tails: carry-OVER, roll-OVER, turn-OVER,
  hold-OVER, lay-OVER, spill-OVER. There is no syntactic way to tell a LEAKED
  compound-bound word from a phrasal-verb suffix — both are
  [word][comparator][number].

  The fix is the propose/decide boundary applied to NORMALIZATION itself:
  - The DECIDE key (numeric.ts quantityKey) stays CONSERVATIVE — no comparator
    stripping. A conservative key can only cause a MISS (false negative, the
    honest direction), never a fabricated conflict.
  - The lenient matching (drop comparator words when comparing object suffixes)
    lives ONLY in the PROPOSE-only detector (quantity-alias.ts), where over-firing
    is sound because that tier can just DEMOTE `verified` and SUGGEST a `glossary
    add` — it never asserts a contradiction. Over-firing there costs at most a
    waivable nag; over-firing in the key costs a false verdict.

  General rule: when one normalization feeds both a sound/verdict path and a
  fuzzy/propose path, the sound path gets the STRICTER normalization and the
  propose path gets the looser one — never the reverse, and never a shared loose
  one. The DECIDE artifact (here, a committed glossary alias the propose finding
  suggests) is what legitimately unifies the two keys for the solver.
example_files:
  - src/formal/numeric.ts
  - src/formal/quantity-alias.ts
  - src/pipeline/__tests__/check-wishlist.test.ts
---

# Why this matters

Loosening a match to fix a miss feels safe, but if that match is verdict-eligible
it can invent a conflict between genuinely distinct things — and a false positive
in the one tier the doctrine says must never fabricate is strictly worse than the
miss you were fixing. An adversarial refute-pass caught this where a green test
suite (which only checked the target case) did not — run one before trusting a
"soundness-adjacent" change. See
[[detect-and-demote-vs-solve-for-intractable-blind-spots]] for the propose/decide
split this is a corollary of, and [[embeddings-propose-smt-decide]] for the
original rule.

# What NOT to do

Do not strip/stem/canonicalize a term in the KEY that a sound tier compares just
to make two things match. Put the lenient normalization in the propose-only
detector and let a committed, reviewed artifact do the actual unification.
