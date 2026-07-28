---
name: re-verify-agent-findings-before-planning-on-them
description: Re-run every load-bearing subagent claim yourself before it enters a plan — in one session 2 of 6 reported lint defects were false, and the highest-value finding was only confirmed by probing the installed artifact
metadata:
  type: orchestration
---

# Re-verify agent findings before planning on them

A 13-agent Explore+Research fan-out produced ~20k lines of findings. Re-running
the load-bearing claims against the built CLI and the installed packages changed
the plan in both directions.

**Two of six reported lint defects were false.** Reported as confirmed bugs:

- "R1 hardcodes `shall`, so a `must` requirement gets an error-severity finding
  and is wrongly excluded from the formal tier." Actual: `must` produced **no R1
  finding at all**. A coverage gap, not a wrongful exclusion — a completely
  different fix.
- "R15 punishes the defined `[A AND B]` convention." Actual: **no R15 finding**.
  The negative lookahead works.

Both were plausible, specific, and cited real line numbers. Implementing either
would have written a false behavior into the tool.

**The highest-value finding only appeared under direct probing.** The research
claim was "Spacer/Fixedpoint may be available in the z3-solver WASM build."
Probing the *installed* package found `ctx.Fixedpoint` plus 31
`Z3_fixedpoint_*` entrypoints, and a functional test proved unbounded
reachability (`unsat` in 284ms with an inferred invariant; `sat` control in
36ms). That removed Veil/Quint/Lean/JVM from the plan's dependency list
entirely — the single largest scope reduction available.

**Verify against the installed artifact, not the upstream source tree.** A
sibling agent reported Z3 still ships `get-interpolant`. True of the native
build, false of the shipped WASM: `eval_smtlib2_string` returns `unsupported`
and the byte string is absent from `z3-built.wasm`. Feature sets differ
materially between a project's source tree and the package a user installs.

**How to apply:**

- Reproduce any claim that will drive an AC. Cheap: a shell script per claim.
- Record refuted claims *in the spec*, not just in your head, so a later session
  does not "fix" them. Mark them explicitly (refuted, with the evidence).
- Distrust reports whose reproducer you cannot run — including your own earlier
  ones. Write the reproducer before the fix.
- Notice when a fixture fails to exercise the code under test. Three successive
  100-requirement budget fixtures never reached the solver because bare integers
  tripped an error-severity lint that excluded every requirement
  (`encoded: 0, pairsChecked: 0`). Only a digit-free fixture produced
  `encoded: 100, pairsChecked: 4950` and a meaningful measurement. Always assert
  the tier you are measuring actually ran.

Agents that verify their own work are worth the tokens: in this session one
corrected three of its own premises by installing and running the tools, one
found a bypass in its own recommended hardening, and two independently
diagnosed a breakage the orchestrator had introduced — and correctly refused to
patch it out of scope.

Related: [[subagent-instant-stop-sendmessage-recovery]].
