---
title: Effect 4.0.0-beta.102 — 5 MORE deltas from the G1b doc format + store, incl. a SILENT DATA-LOSS record bug
track: knowledge
category: conventions
module: packages/symspec (greenfield)
component: effect
severity: high
tags: [effect, v4, schema, record, jsonschema, layer, config, stdio, silent-data-loss]
applies_when:
  - defining a Schema.Record whose KEY schema carries a check (uuid, pattern, literals)
  - pairing withDecodingDefaultKey with an explicit default annotation
  - lowering a checked schema to JSON Schema and reading its annotations
  - reading env vars, stdin, or random bytes through Effect services
pattern: |
  Supplements `effect-v4-beta102-cli-api-reality.md` (the original 8) and
  `effect-v4-beta102-g1-kernel-deltas.md` (9-14). Found building the v3
  document format and the doc store. #15 is the most dangerous v4 behavior
  found so far — it loses DATA, not just manifest fidelity.

  15. **`Schema.Record(checkedKey, V)` SILENTLY DROPS entries whose key fails
      the key schema.** Probed directly:

        Schema.decodeUnknownEffect(Schema.Record(Uuid, Schema.Number))(
          {'not-a-uuid': 1, '<valid-uuid>': 2}
        )
        // => Success, value {'<valid-uuid>': 2}   <-- the entry is GONE

      Unaffected by `{onExcessProperty:'error'}` AND by `{errors:'all'}`. A
      record's key schema behaves as a FILTER, not a validator. For a
      UUID-keyed requirements map that means a file with one mistyped key loads
      CLEAN and is simply missing a requirement — every downstream count, every
      edge that pointed at it, and every verdict is computed over silently
      truncated data. Same species as donor finding V27, different route.

      Fix: key on `Schema.String` and enforce with a CHECK, which fails loudly
      and still publishes the constraint in the JSON Schema:

        Schema.Record(Schema.String, V).pipe(
          Schema.check(Schema.isPropertyNames(Uuid))
        )
        // => Failure: Expected a UUID, got "nope" at ["nope"]
        // => JSON Schema gains {allOf:[{propertyNames:{...}}]}

      Pin BOTH halves in a test (that the raw record drops, and that the
      wrapper fails), so a future beta fixing `Record` tells you the wrapper is
      no longer load-bearing instead of it decaying into cargo cult.

  16. **A `Schema.check(...)` refinement nests `default` under `allOf`, not just
      `description`.** The known trap said `Schema.Finite` buries `description`;
      it is wider than that. Any checked schema puts BOTH annotations one level
      down, so a top-level-only read of `default` reports `undefined` and
      "proves" a default is missing that is actually present. Every JSON-Schema
      annotation read must walk `allOf`/`anyOf`/`oneOf` — there is no annotation
      kind exempt from this.

  17. **`withDecodingDefaultKey` — the annotation goes on the INNER schema, and
      do NOT wrap in `optionalKey` yourself.** Two sub-facts:
      - `x.annotate({default}).pipe(withDecodingDefaultKey(...))` emits the
        default into JSON Schema; `.pipe(withDecodingDefaultKey(...)).annotate(
        {default})` does NOT (the annotation lands on a wrapper the lowering
        discards). Order matters and only one order works.
      - The combinator ALREADY makes the key optional on the ENCODED side (its
        declared result is `decodeTo<S, optionalKey<toEncoded<S>>>`). Adding an
        explicit `Schema.optionalKey` makes it optional on the TYPE side too,
        so a decoded value types `requirements?: …` even though decoding always
        materializes it — every read site then needs a needless `??` and the
        compiler stops catching a genuinely missing field.
      - Inside a GENERIC helper, `schema.pipe(withDecodingDefaultKey(...))` is
        TS2684 (`pipe` types `this` as the concrete `S`). Apply the combinator
        directly with the type argument spelled out:
        `Schema.withDecodingDefaultKey<S['Rebuild']>(Effect.succeed(v))(annotated)`.
        No cast, no `any`.

  18. **`Config.String` does not exist — it is `Config.string` (lowercase).**
      Also `Config.nonEmptyString`, `Config.int`, `Config.boolean`. Recall
      capitalizes them (v3 style); the runtime error is a bare
      `TypeError: Config.String is not a function` at layer construction, so it
      surfaces only when the layer is first built.

  19. **`Crypto.randomBytes` returns a non-Buffer-compatible object.**
      `Buffer.from(crypto.randomBytes(6))` throws
      `ERR_INVALID_ARG_TYPE: ... Received an instance of Object`. `randomUUIDv4`
      / `randomUUIDv7` are Effects and work fine. For a temp-file name, clock +
      a module counter is simpler and needs no crypto at all.

      Bonus (works as recalled, worth recording since it was probed):
      stdin is `Stdio.Stdio`'s `stdin` Stream —
      `stdio.stdin.pipe(Stream.decodeText(), Stream.mkString)` reads it whole.
      `Stream.runFold` with an array accumulator does NOT work
      (`TypeError: initial is not a function`).
example_files:
  - packages/symspec/src/core/document.ts
  - packages/symspec/src/core/store.ts
  - packages/symspec/src/core/document.test.ts
---

# Why this matters

The pattern across all three lesson files is now clear enough to state as a rule:
**this beta's failure mode is silence.** Nine of the nineteen deltas found so far
produce no error at all — they produce a wrong manifest, a wrong default, or (new
in #15) a wrong DOCUMENT. Vigilance has not caught any of them; what caught every
single one is a test that asserts the shape of the SHIPPED artifact, plus a
negative control proving that test can fail.

#15 raises the stakes because the earlier silent failures were about what an agent
is TOLD, and this one is about what is actually STORED. The mitigation that
generalizes: for any Effect Schema construct that takes a schema in a
non-value position (a record key, a property name, a discriminant), verify by
probe that a bad input FAILS rather than assuming it validates — and keep the
probe as a test.
