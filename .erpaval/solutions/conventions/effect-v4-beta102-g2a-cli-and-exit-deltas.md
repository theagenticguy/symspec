---
title: Effect 4.0.0-beta.102 — 3 more deltas from the G2a check op: a negative flag value is unreachable, Literals infers readonly, and a non-zero SUCCESS exit needs a non-catalog error carrier
track: knowledge
category: conventions
module: packages/symspec/src/operations/check.ts, packages/symspec/src/cli.ts
component: effect
severity: medium
tags: [effect, v4, unstable-cli, flags, schema, literals, exit-codes, runtime-markers]
applies_when:
  - adding a numeric CLI flag whose "disabled" state needs an out-of-band value
  - spelling a type argument for Schema.Literals in a combinator call
  - a SUCCESSFUL operation must produce a non-zero process exit code
pattern: |
  Supplements the earlier beta.102 files (deltas 1-8, 9-14, 15-19, 20). Found
  building the G2a `check` operation and its CLI projection.

  21. **A NEGATIVE numeric flag value is UNREACHABLE from the command line.**
      `--fail-on-unmatched -1` does not pass `-1`; `effect/unstable/cli` reads the
      leading `-` as the start of the NEXT flag and the invocation degrades to a
      help dump (exit 0, no envelope). So a negative "disabled" sentinel cannot be
      typed, no matter what the schema declares. And 0 is often unavailable as the
      sentinel too — for a count-valued gate, 0 is the STRICTEST meaningful
      threshold ("fail on any"), not an off switch.

      Model absence as ABSENCE: `Schema.NullOr(Schema.Int)` + a `null` decoding
      default on the schema side, `Flag.optional(...)` + `Option.getOrNull` on the
      CLI side. Omitting the flag IS the disabled state, which is both expressible
      and self-documenting.

      Corollary that bit immediately: this is where lesson #17 recurs. Do NOT wrap
      the inner schema in `Schema.optionalKey` — `withDecodingDefaultKey` already
      makes the key optional on the ENCODED side, and adding `optionalKey` makes it
      optional on the TYPE side too, so the decoded value types
      `field?: number | null | undefined` even though decoding always materializes
      it. The tell is a `!= null` (nullish) check being required where `!== null`
      should suffice; if you find yourself widening a comparison to satisfy the
      compiler, the schema is wrong, not the comparison.

  22. **`Schema.Literals([...])` infers its tuple as READONLY, and the type
      argument must say so.** Spelling
      `Schema.withDecodingDefaultKey<Schema.Literals<['error','warn','info']>>(...)`
      is TS2345 — `Literals<readonly [...]>` is not assignable to `Literals<[...]>`
      because the tuple is invariant. The error surfaces at the
      `withDecodingDefaultKey` call, NOT at the `Schema.Literals` call, which is
      what makes it read as a mystery. Write
      `Schema.Literals<readonly ['error','warn','info']>`.

  23. **A non-zero exit on a SUCCESSFUL run needs its own error carrier, and it
      must NOT be one of your catalog error classes.** The shape: an operation
      completes, emits a valid SUCCESS envelope, and still has to exit non-zero
      (findings present, or an opt-in gate tripped). Reusing a catalog `ERR_*`
      class would relabel it as an operational failure and collapse the
      distinction the exit contract exists to make.

        class GateExit extends Data.TaggedError('GateExit')<{ code: ExitCode }> {
          override readonly [Runtime.errorReported] = false
          override get [Runtime.errorExitCode](): number { return this.code }
        }

      - `Runtime.errorExitCode` as a GETTER, so one class carries any code.
      - `Runtime.errorReported = false` — INVERTED relative to its name; `false`
        means "app code already reported this". Without it the runtime prints a
        human-shaped stack trace AFTER the JSON an agent just parsed.
      - FAIL with it rather than calling `process.exit`, so finalizers still run.
        That is not hygiene: a Layer holding a WASM module or a connection needs
        its release to fire, and `process.exit` skips it.

      The trap this closes is not an API delta but an INTEGRATION gap worth the
      same money: a fully-implemented, fully-unit-tested exit-code mapping that
      the CLI never CALLED on the success path. It was invisible for a whole wave
      because no operation produced findings, so every reachable success genuinely
      was exit 0. The unit tests passed — the function was right. Only an
      end-to-end assertion on the PROCESS STATUS finds it.
example_files:
  - packages/symspec/src/operations/check.ts
  - packages/symspec/src/cli.ts
  - packages/symspec/src/cli.test.ts
---

# Why this matters

#21 and #23 share a shape: the code was correct in isolation and wrong at the
seam, and in both cases the in-process test could not see it. A negative flag
default typechecks, decodes, and unit-tests perfectly — and is untypeable at a
shell. An exit mapping unit-tests perfectly — and was never wired.

So the generalizable rule is about WHERE the assertion lives, not about the API: for
anything whose contract is observed by a process outside your program (an exit
status, an argv spelling, a stream's bytes), the test has to spawn the real binary.
`cli.test.ts` spawning `dist/cli.mjs` is what caught both.

# What NOT to do

Do not work around #21 by accepting the flag as a string and parsing it in the
handler. That moves a malformed number from a CLI usage error (exit 1, before any
work) into an operational failure envelope (exit 2), which mislabels a typo as a
tool failure.

Do not give the gate carrier a code from the ERR_* catalog "so it has one". It never
becomes an error envelope — the envelope on stdout is a SUCCESS envelope — so a
code would be a field nothing reads, and a future reader would reasonably assume
the run failed.
