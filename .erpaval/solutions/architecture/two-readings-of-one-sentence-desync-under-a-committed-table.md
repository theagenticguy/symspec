---
title: When two code paths read the SAME sentence differently, a committed table desyncs them — recognize and decide from ONE reading, or drop the inference
track: knowledge
category: architecture
module: src/domain/engine/formal/guard-implication.ts, src/domain/engine/formal/atomize.ts, src/domain/requirements/mutate.ts
component: symspec
severity: high
tags: [propose-decide, sound-modulo-atomization, false-positive, atomization, guard-implication, adversarial-critic, determinism, committed-table]
applies_when:
  - one code path RECOGNIZES a construct from raw text while another DECIDES its polarity, sign, or key from a normalized/rewritten form
  - adding a committed side table (glossary, terms, antonyms) that rewrites text the solver compares
  - tempted to close a soundness hole with a write-time validator on the table
pattern: |
  symspec's guard-implication tier decides a response ESTABLISHES a state by parsing the RAW
  sentence against a verb lexicon, then computes that state's POLARITY by running the full
  terms/glossary-aware `atomize`. Two readings of one sentence. They agree only while no
  committed table moves the head between them.

  `ESTABLISH_VERBS` and the antonym heads are disjoint, so a genuine bridge's head can never
  reach the antonym probe on its own — the disjointness was treated as the safety argument. But
  a committed table can PUT an antonym head there. Then bridge-ness is still recognized from the
  raw text while the polarity flips, so the emitted implication asserts the NEGATION of what the
  author wrote. The inert-implication filter compares atom NAMES, not polarity, so an inverted
  implication whose consequent another rule genuinely guards on enters the whole-spec
  conjunction and can make a group UNSAT the document never entailed: a fabricated
  FND_CONTRADICTION at error severity, the cardinal sin.

  Verified on the built CLI, two doors:
    - `symspec term "revokes entry" "keeps the latch"` — a write-time fence checking RAW tokens
      accepts it, because `atomize` de-inflects before probing (`revokes` is not an index key,
      `revoke` is).
    - `symspec glossary "revoke entry" "keep the latch engaged"` — the shipped command, no verb
      check at all. This door predates the terms table.

  A WRITE-TIME VALIDATOR CANNOT CLOSE THIS, and that is the transferable part:
    1. a per-token check cannot see a multi-token key (`roll back`) formed by joining the
       canonical to tokens already beside it in the body;
    2. every table that rewrites the same text needs its own copy of the fence, kept in step;
    3. ORDERING defeats it outright — a term that is clean against the seed antonym index
       becomes hazardous when a doc antonym is committed afterwards, and the antonym write never
       re-validates existing terms. Two individually-valid writes compose the desync.

  The fix is at the point of inference, not the point of authorship: drop the inference when the
  two readings disagree. Concretely, compare the atomized head against `deInflectHead` of the raw
  head and skip the bridge when they differ. One line, closes both doors and the ordering bypass,
  and a dropped bridge is a MISS — which is what "sound modulo atomization" already promises.
  Keep the write-time fence as defense in depth and for the early error message, and say in the
  code that it is not load-bearing.
example_files:
  - src/domain/engine/formal/guard-implication.ts
  - src/testing/fabrication.ts
  - src/app/operations/mutation.ts
---

# Why this matters

The two-readings shape is easy to build by accident and invisible to a green suite: 1487 tests
passed over the broken version, including a purpose-built fabrication scorer, because every
fixture had an EMPTY table and the desync needs a populated one. It took an adversarial refute
pass with a construction budget to find, and the construction is three requirements long.

The generalizable test: for any inference of the form "recognize X from form A, then decide a
property of X from form B", ask what makes A and B agree. If the answer is a disjointness or
lexicon-membership argument, a committed table is a mechanism for violating it — because a table
exists precisely to rewrite one form into another.

Note the direction of the fix. It would have been natural to make the raw parse terms-aware so
both sides agree. That is worse: it widens what counts as a bridge under an author's table,
which moves in the false-positive direction. Dropping when the readings disagree moves in the
miss direction, which is the only direction a sound checker may move.

See [[normalization-for-a-propose-signal-must-not-touch-the-decide-key]] for the rule this is a
corollary of — a committed table is the SANCTIONED unifier there, and this is the one way a
sanctioned unifier still breaks something.
[[guard-implication-closure-widens-reachability-soundly]] is the feature whose soundness comment
this corrected. [[detect-and-demote-vs-solve-for-intractable-blind-spots]] is why the answer is
a drop rather than a cleverer parse.

# What NOT to do

Do not answer "a committed table can reach this unsound path" with a validator on the table.
There is one path and N tables, the check has to be duplicated per table, and a two-write
ordering composes past all of them. Guard the path.
