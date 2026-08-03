---
title: winkNLP(model) LEAKS and throws RangeError on its ~21st construction — memoize the analyzer, never construct per call
track: knowledge
category: conventions
module: src/parse/tier2.ts, src/parse/batch.ts, src/parse/result.ts
component: wink-nlp
severity: high
tags: [wink-nlp, nlp, memoization, resource-leak, batch, parse, per-call-construction, donor-bug]
applies_when:
  - calling `winkNLP(model)` more than a handful of times in one process
  - a per-line/per-item loop resolves its analyzer, tokenizer, or model inside the loop
  - a batch command works on small input and dies on real input
pattern: |
  `wink-nlp`'s factory accumulates state that is never released. Probed directly,
  on wink-nlp 2.4.0 + wink-eng-lite-web-model 1.8.1:

    const w = (await import('wink-nlp')).default
    const m = (await import('wink-eng-lite-web-model')).default
    for (let i = 1; i <= 200; i++) w(m)
    // => RangeError: Invalid string length, at construction 21

  The throw comes from inside the MODEL package
  (`wink-eng-lite-web-model/dist/load-cer-meta-model.js`), which appends to a string
  that eventually exceeds V8's maximum length. The loads also slow superlinearly as
  that string grows, so the symptom before the throw is a hang, not an error.

  ## Why this is easy to ship

  symspec's donor `runTier2` resolves `opts.load ?? defaultTier2Loader` PER LINE, and
  `defaultTier2Loader` constructs a fresh analyzer every call. Its own header claimed
  the model "loads at most once per run" — but nothing memoized it, and the claim was
  never false in testing because no test escalated more than a handful of lines in one
  process. Tier 2 only runs on ESCALATION (a passive clause, a weak subject), so a
  test corpus of clean sentences never reaches the cliff.

  Measured against the LIVE donor: 30 escalating lines through its own `parseBatch`
  never completes. So `symspec parse --file` died on the 21st escalating line of a
  real requirements file — with a dependency-internal `RangeError` rather than a parse
  error, so the whole batch aborted instead of reporting per-line results. A 42-
  requirement spec with 21 passive sentences is an entirely ordinary input.

  ## The fix, and why sharing is sound

  Memoize the PROMISE, not the resolved analyzer, so two concurrent callers cannot
  both start a load:

    const memoized = (load: Loader): Loader => {
      let inflight: ReturnType<Loader> | undefined
      return () => { inflight ??= load(); return inflight }
    }

  Sharing one analyzer across calls is safe — probed: 500 sequential `readDoc` calls
  on one instance produce correct tags with no degradation, in 22ms total versus ~62ms
  for a single fresh construction. So the memo is both the correctness fix and a large
  speedup on the escalating path.

  TWO memo scopes are needed, because there are two routes to the leak:
  - per BATCH, in the batch driver, which is the precise scope and keeps an injected
    test loader's invocation count assertable (exactly one per batch);
  - process-wide for the DEFAULT loader, covering a caller that loops over the
    single-item entry point directly.

  Memoize only the DEFAULT loader process-wide. Memoizing an INJECTED one would let
  one test's fake leak into another's.

  ## How to test it

  Escalating input past the cliff, through the REAL model: 40 lines whose main clause
  is passive ("The audit record N shall be written to the ledger"). Completes in
  ~277ms with the memo; without it the test times out at 90s before throwing. Assert
  every line reached an outcome (`ok + skipped + error === 40`), so a batch that lost
  lines to a swallowed throw fails too.
example_files:
  - packages/symspec/src/donor/parse/batch.ts
  - packages/symspec/src/donor/parse/result.ts
  - packages/symspec/src/operations/parse.test.ts
---

# Why this matters

The failure mode is the worst shape a batch command has: it works on every small
input, then on real input it neither completes nor reports — it throws from inside a
dependency, so the per-item results the caller needed are lost along with the run.
And the cliff is at ~21, which is above every plausible unit-test fixture and below
every plausible real document.

The generalizable rule is narrower than "memoize expensive things": **for any
third-party factory called inside a per-item loop, construct it ONCE and prove the
shared instance is safe by probe.** "Expensive" would have argued for the memo on
latency grounds and got the same fix by accident; the reason to insist on it is that
repeated construction is a CORRECTNESS hazard whenever the library holds
module-global state, and nothing in a factory's signature tells you whether it does.

# What NOT to do

Do not trust a comment that says a resource "loads at most once" — check whether
anything memoizes it. This one was wrong in the donor for a whole release, and the
comment is what made it look deliberate.

Do not fix it only in the batch driver. The single-item entry point is a public API,
and a caller looping over it hits the identical cliff.

Do not memoize an injected/test-supplied loader. The invocation count is the only
observable for the gating contract ("a clean sentence must not load the model"), and
memoizing the fake destroys it.
