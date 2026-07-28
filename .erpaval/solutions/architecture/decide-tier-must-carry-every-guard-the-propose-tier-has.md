---
name: decide-tier-must-carry-every-guard-the-propose-tier-has
description: A guard present in the propose tier but missing from the decide tier is a fabricated-verdict bug; audit the pair whenever both tiers reason over the same data
metadata:
  type: project
---

# The decide tier must carry every guard the propose tier has

`quantity-alias.ts` (PROPOSE-only, info severity) had this guard:

```ts
// Comparable unit: both unitless or the same normalized base. A time
// bound and a byte bound are genuinely different quantities.
if (pa.baseUnit !== pb.baseUnit) continue
```

`numeric-contradiction.ts` (DECIDE, **error** severity, exit 1) did not. It
grouped predicates by `pred.quantity` alone. Result, verified live:

```
respond within 5        (unitless, value 5)
respond over 2000 ms    (value 2000)
→ FND_NUMERIC_CONTRADICTION, severity error, exit 1
```

5 seconds is 5000 ms, strictly greater than 2000 ms. **No conflict exists.** The
tool fabricated a contradiction — the one error the codebase is built never to
make (`numeric.ts` labels it "the cardinal sin" in its own soundness note).

**Why:** The guard was written for the tier where getting it wrong is *cheap* (a
propose-only suggestion) and omitted from the tier where getting it wrong is
*unrecoverable*. That is exactly backwards, and it is an easy inversion to make,
because the propose tier is usually written second — while the author has the
edge cases fresh in mind.

**How to apply:** Whenever two tiers reason over the same extracted data with
different authority, diff their guards explicitly. Any predicate present only in
the propose tier is a suspected fabricated-verdict bug in the decide tier until
proven otherwise. The asymmetry is only ever sound in one direction: the DECIDE
tier may be *stricter* than propose (it may decline where propose suggests), and
never *looser*.

The fix shape matters too. Partitioning by `(quantity, baseUnit)` was chosen over
folding the unit into the quantity key, because folding renames the Real const
and `evidence.numeric.quantity` of every already-correct finding. Partition is
also not a skip: a quantity carrying both a unitless and an `ms` bound still gets
its `ms` bounds proved.

Related: [[normalization-for-a-propose-signal-must-not-touch-the-decide-key]],
[[verified-is-decide-tier-not-any-comparison]],
[[detect-and-demote-vs-solve-for-intractable-blind-spots]].
