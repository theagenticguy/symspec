---
title: Walking a Z3 answer AST — to_app on a non-APP returns GARBAGE (30M arity), APP_AST is 1 not 0, and the DAG needs a memo
track: knowledge
category: conventions
module: packages/symspec/src/formal/reachability.ts
component: z3-solver
severity: high
tags: [z3, wasm, ast, fixedpoint, spacer, invariant, ffi, hang]
applies_when:
  - walking any Z3 AST from JS/TS (an invariant, a proof term, a model)
  - extracting Spacer's inferred invariant for a certificate check
  - debugging a "solver hang" that is actually a JS-side traversal
pattern: |
  Three independent traps, all measured on z3-solver 5.0.0. Together they cost
  ~90 minutes and produced a symptom indistinguishable from the V14/V21 solver
  hang they were NOT.

  1. `Z3_to_app` on a node that is not `Z3_APP_AST` DOES NOT THROW. Given a
     de Bruijn VAR (kind 2 — exactly what is inside a quantifier body) it returns
     a bogus pointer whose `get_app_num_args` reads as **30,208,840**. A walker
     that loops over that arity makes 30M FFI calls per bound variable. MEASURED:
     `findInvariantBody` took **29.7s** on an answer whose printed form is 185
     characters, while the Spacer query it came from returned in 709ms.
     => ALWAYS gate on `get_ast_kind(ctx, ast) === APP_AST` before `to_app`.
     A try/catch cannot substitute: nothing throws.

  2. `Z3_APP_AST` is **1, not 0**. The enum is
     `NUMERAL_AST=0, APP_AST=1, VAR_AST=2, QUANTIFIER_AST=3, ...`, so the obvious
     wrong guess (0, because "app" feels like the base case) makes the kind gate
     false for EVERY application. Symptom: a fast, confident "no readable
     definition found" on an answer that plainly contains one.

  3. A Z3 AST is a **DAG**, not a tree — terms are hash-consed, so identical
     subterms are one shared node with many parents. An un-memoized recursive
     walk re-traverses them combinatorially (measured: >2M visits at depth 7 on
     the same 185-char answer). Memoize on `Z3_get_ast_id`.

     SUBTLETY: memoize "searched and found nothing", NOT "visited". Recording on
     ENTRY and returning early makes the first unproductive branch abort the whole
     search — the answer is `(and (= Bad ...) (forall ... (= (Inv A) BODY)))`, so
     marking the top-level `and` visited and returning undefined from branch 0
     skips branch 1, the only one holding the invariant. Record on the way OUT of
     a fruitless subtree instead.

  `Z3.is_quantifier_ast` also DOES NOT EXIST on 5.0.0 (only
  `is_quantifier_forall` / `is_quantifier_exists` / `get_ast_kind`).

  DIAGNOSIS DISCIPLINE: these all look like a hung solver. The tell is that the
  query's own verdict already returned. Instrument per STAGE (build / query /
  invariant-extract / obligations) before assuming the hang is in Z3 — reading the
  code did not find it, timing the stages found it in one run.
example_files:
  - packages/symspec/src/formal/reachability.ts
---

# Why this matters

The reachability tier's whole soundness story rests on independently re-checking
Spacer's invariant (three plain-SMT obligations). That check requires walking the
answer AST to extract `Inv`'s body — so all three traps sit directly on the
critical path of the mitigation for a different hazard.

Worse, each one FAILS QUIETLY in a way that mimics something else: trap 1 looks
like V14/V21's unkillable Spacer hang, trap 2 looks like "Spacer returned no
invariant" (leading to a spurious demotion), and trap 3 looks like a slow solver.
None of them produces an error message.
