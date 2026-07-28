---
name: degradation-must-be-monotone-in-its-budget
description: A resource knob must degrade monotonically — a middle band that hard-errors while both tighter and looser settings return a usable verdict is incoherent
metadata:
  type: project
---

# Degradation must be monotone in its budget

After threading `--solver-budget-ms` through every solver tier, a budget sweep on
a 100-requirement document produced this:

```
budget=1ms     exit 0   verified=false, 5 truncation demotions
budget=500ms   exit 0   verified=false, 4 truncation demotions
budget=1500ms  exit 0   verified=false, 3 truncation demotions
budget=2000ms  exit 2   ERR_SOLVER_TIMEOUT — NO REPORT AT ALL
budget=3000ms  exit 0   verified=false, 0 truncation demotions
```

A **tighter** budget failed more softly than a looser one. The 2000ms band is
where the budget survives the earlier tiers and then dies inside
`findNeedsReview`'s group loop — the one tier allowed to throw
`ERR_SOLVER_TIMEOUT`. Every other tier had been converted to *record* truncation
and demote; that one still threw, and the throw escaped `runCheck`.

**Why it matters:** the error band lands precisely where a partial verdict is
most valuable — the run got far enough to prove real conflicts, then ran out of
time. Returning exit 2 with no report throws that work away, and an agent driving
the refine loop gets an operational failure where it should have received
findings plus an honest "I did not finish."

**How to apply:** When adding a resource bound, sweep it and assert the failure
mode is monotone. The invariant to encode is a disjunction, not a conjunction:
*the run either produced the verdict, or it admitted it was cut short* — never
silence, and never a hard error where a softer setting succeeds.

Two supporting details:

- **Absorb at the boundary that has somewhere to put the information.** The
  throw's contract was directly tested and is right for a *library* caller of
  `findNeedsReview`. Only the pipeline — which has a report and a demotion
  channel — should convert it. Fixing it inside the tier would have broken a
  legitimate contract.
- **Truncation must be unwaivable.** Read it from the run's own ledger, not from
  the finding set, and emit it outside any `requirements.length >= 2` guard:
  truncation is a fact about the *run*, not about the document.

Writing the regression test taught the same lesson twice — two of my own
assertions were wrong before the third held. At a 0ms budget even the
contradiction tier is truncated before it runs, so the planted conflict is *not*
reported. That is correct behavior (the run says "I did not finish" instead of "I
found nothing"), but it falsifies the tempting assertion "the contradiction always
survives."

Related: [[coverage-disclaimer-must-account-for-all-tiers]],
[[verified-is-decide-tier-not-any-comparison]].
