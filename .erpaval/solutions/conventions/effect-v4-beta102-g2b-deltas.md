---
title: Effect 4.0.0-beta.102 — 3 more deltas from the G2b wave, plus a latency-comparison trap that cost a 1.9x wrong conclusion
track: knowledge
category: conventions
module: packages/symspec/src/operations/parse.ts, packages/symspec/src/cli.ts, packages/symspec/src/operations/mutation.test.ts
component: effect
severity: medium
tags: [effect, v4, unstable-cli, flags, generics, benchmarking, tsx, schema]
applies_when:
  - adding a FRACTIONAL numeric CLI flag
  - writing a test helper that drives a heterogeneous list of generic Operations
  - declaring an optional flag whose absence is meaningful
  - comparing two implementations' latency
pattern: |
  Supplements the earlier beta.102 files (deltas 1-8, 9-14, 15-19, 20, 21-23). Found
  building the G2b parse ladder, semantic tier, and mutation ops.

  24. **`Flag.float` exists and is REQUIRED for a fractional flag.** `Flag.integer`
      rejects `0.72`, which matters for exactly the flag most likely to be fractional
      (a cosine threshold). The failure is a CLI usage error at exit 1, so it is loud
      rather than silent — but the fix is a different constructor, not a parse in the
      handler. Keeping it at the flag layer is what keeps a numeric typo a usage error
      (exit 1, before any work) instead of an operational failure envelope (exit 2),
      which would mislabel a typo as a tool failure.

  25. **Delta #17/#21 recurs, and the TELL is a nullish comparison.** Wrapping an
      inner schema in `Schema.optionalKey` alongside `withDecodingDefaultKey` leaks
      `undefined` into the decoded TYPE, even though decoding always materializes the
      value. This produced two real compile errors (TS18048, TS2345) on the first build
      of `parse`, because the handler branches on `!== null` and the leaked `undefined`
      made the narrowing incomplete.

      The reliable tell, worth stating as a rule: **if you find yourself widening
      `!== null` to `!= null` to satisfy the compiler, the SCHEMA is wrong, not the
      comparison.** Factor the correct pairing into one helper so no field site can get
      it wrong:

        const nullableStringFlag = (description: string) =>
          Schema.withDecodingDefaultKey<Schema.NullOr<Schema.String>>(Effect.succeed(null))(
            Schema.NullOr(Schema.String).annotate({ default: null, description }),
          )

  26. **A test helper cannot be generic over a HETEROGENEOUS list of `Operation`s, and
      the fix is to split the helper rather than reach for `any`.** Eight operations
      with different input `Fields` cannot go through one `<Fields extends
      Schema.Struct.Fields>(op: Operation<Fields, …>)` helper at a call site that
      iterates them — each call needs its own instantiation.

      Three approaches tried; only the third is cast-free at the call sites:
        - `op as any` per call — works, and `noExplicitAny` is an error in this repo.
        - a narrowed structural interface (`{name, input, handler}`) — does NOT satisfy
          `runOperation`'s generic parameter, because `handler` is contravariant in its
          input. Same reason the kernel's `OperationMetadata` had to DROP `handler`.
        - a GENERIC wrapper returning an erased THUNK:

            const runnable = <Fields extends Schema.Struct.Fields>(
              op: Operation<Fields, string, Payload, R> & AnyOperation,
            ): RunnableOp => ({ name: op.name, run: (i) => runOperation(op, i), meta: op })

          `runnable` is instantiated at each op's precise type (so `runOperation` is
          called exactly as production calls it), and the RESULT is a non-generic shape
          the list can hold. This is the same conclusion the kernel reached for the ops
          table — narrow the ITERATION type to what the iteration touches — applied to a
          test harness.

  Plus one non-Effect trap that cost a wrong conclusion:

  27. **Never compare a BUILT bundle's latency against an on-the-fly transpile.**
      Measuring the donor CLI through `npx tsx src/cli/index.ts` gave 1267ms against the
      greenfield's built bundle at 677ms, which reads as "the rewrite is 1.9x faster".
      Both through their own `dist/cli.mjs`: 635ms vs 677ms, i.e. the rewrite is 6.6%
      SLOWER. The 630ms difference was `tsx` compiling TypeScript on every invocation.

      The rule: before believing a latency RATIO between two implementations, confirm
      both run through the same KIND of entry point. A ratio near 2x from a shell
      measurement is more likely to be a build step than an optimization.
example_files:
  - packages/symspec/src/operations/parse.ts
  - packages/symspec/src/cli.ts
  - packages/symspec/src/operations/mutation.test.ts
  - .erpaval/sessions/session-d4dc8e/G2b-LATENCY-REPORT.md
---

# Why this matters

#25 is the third appearance of the same `optionalKey` mistake across three waves, which
is what makes the TELL worth more than the rule: nobody remembers "do not wrap in
optionalKey", but "a nullish comparison means the schema is wrong" is a signal that
shows up at the moment of the mistake.

#27 is not an Effect delta at all, and it is the most expensive item here. It would have
been written into a wave-exit report as a headline result, and it was wrong by a factor
of two in the flattering direction — which is the direction least likely to get
challenged.

# What NOT to do

Do not work around #24 by accepting a float as a string and parsing it in the handler:
that moves a malformed number from a usage error into an operational failure envelope.

Do not work around #26 with `Operation<any, any, any>`. The S2 spike concluded the ops
table needed that and it did not; the same is true of a test harness. If a generic
fights a heterogeneous list, the list wants a narrower type, not a wider one.
