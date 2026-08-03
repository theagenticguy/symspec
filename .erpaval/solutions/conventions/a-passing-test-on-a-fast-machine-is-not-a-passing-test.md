---
name: a-passing-test-on-a-fast-machine-is-not-a-passing-test
description: A threshold test whose margin comes from a floor rather than from the logic passes in isolation and fails under load; pin the ARITHMETIC, not the outcome
metadata:
  type: conventions
---

# A passing test on a fast machine is not a passing test

symspec's `data.budgetHint` (AC-A-8) recommends a `--solver-budget-ms` for a run that
truncated. The recommendation was computed as

```
recommended = measuredMs * (totalUnits / completedUnits) * HEADROOM
completedUnits = report.pairsChecked
```

`pairsChecked` reads like "pairs the solver compared". It is not — it counts the candidate
pairs the free-tier filter **identified**. Measured on a 10-requirement document at a 1ms
budget: `pairsChecked: 45` while all five solver tiers truncated and **nothing was solved**.
So the arithmetic computed `45/(45+76) ≈ 0.37`, concluded a run that had solved nothing had
completed a third of its work, and recommended roughly a third of what was needed.

## Why every test passed anyway

Three layers of tests, all green:

- **unit tests** over a synthetic report — they asserted the ratio behaved as a ratio, i.e.
  they were checking the same misreading the code made;
- **an end-to-end test** running the real pipeline: truncate at 1ms, apply the hint, assert
  the truncation demotions are gone;
- **an isolated re-run** of that exact file.

The end-to-end test passed because the under-estimate hit the `MIN_RECOMMENDED_BUDGET_MS`
floor of 2000 ms, and on a quiet machine the document's real cost was ~650 ms. The floor
covered the bug. Under contention the same document costs ~880 ms and the floor stops
covering it — so the defect surfaced **only in the full parallel suite**, where 29 test files
compete for the same cores.

| | quiet | loaded |
|---|---|---|
| real cost of the fixture | ~650 ms | ~880 ms |
| what the buggy hint recommended | 2000 ms (floored) | 2000 ms (floored) |
| test outcome | PASS | **FAIL** |

## The repair that is circular

The obvious fix looks like accounting:

```ts
completedUnits = totalUnits - unrunUnits      // with totalUnits = pairs + unrunUnits
                = pairs                        // ...which is exactly the bug
```

It reduces to the original expression. Worth writing out before implementing, because it
reads as a fix and changes nothing.

There is no arithmetic that recovers the rate: a truncated run's `measuredMs` is
parse-and-lint time, not solve time, and the report has no field separating them. The honest
answer is to stop extrapolating and say so — a named `NO_EVIDENCE_BUDGET_MS` constant with
the measurements behind it, plus the raw counts published so a caller can compute its own.

## How to apply

**Pin the arithmetic, not the outcome.** The replacement regression test uses the exact
numbers from the run that exposed it (45 pairs identified, 76 units unrun, 120 ms measured)
and asserts the recommendation is *not* what the ratio would produce. That assertion is
machine-independent, so it cannot pass again for the same reason.

**When a threshold test's margin comes from a floor or a default, the test is measuring the
floor.** Ask what the assertion would do if the floor were removed. If the answer is "fail",
the floor is load-bearing and the logic is untested.

**Suspect any field whose name reads like a completion count.** `pairsChecked`,
`itemsProcessed`, `rowsScanned` — verify by probe what the field counts at a boundary where
the answer should be zero. One run at a 1ms budget was enough here.

**Run the full parallel suite before believing a fix.** Two of the three green signals in
this episode came from running one file in isolation, which is the configuration least like
CI and least like a contended machine. Related: the same contention term dominated two
earlier measurements in this repo (a 1.9x "speedup" that was `tsx` compiling on every
invocation, and a 10x cost "knee" that flattened under load).

Related: [[degradation-must-be-monotone-in-its-budget]] — the same knob, from the other
side. That lesson says the failure mode must be monotone in the budget; this one says the
ADVICE about the budget must not be derived from a number that does not mean what it says.
