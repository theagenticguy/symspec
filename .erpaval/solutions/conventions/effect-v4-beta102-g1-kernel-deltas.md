---
title: Effect 4.0.0-beta.102 — 4 MORE API deltas found building the G1 kernel, incl. a third silent manifest lie
track: knowledge
category: conventions
module: packages/symspec (greenfield)
component: effect
severity: high
tags: [effect, v4, schema, jsonschema, typescript, taggederror, manifest]
applies_when:
  - writing any Effect v4 code in the symspec greenfield (every G1+ Act brief)
  - defining Schema.TaggedErrorClass subclasses
  - lowering a Schema to JSON Schema for a manifest or agent-facing contract
  - typing a heterogeneous table of generic entries
pattern: |
  Supplements `effect-v4-beta102-cli-api-reality.md` (the original 8). Found
  while building the G1 kernel; each cost real debugging time and none is in
  the earlier file.

  9. `Schema.Struct({})` DOES NOT lower to `{type:'object',properties:{}}`.
     It lowers to `{anyOf:[{type:'object'},{type:'array'}]}` — an empty struct
     constrains nothing, so JSON Schema says "any object-ish value". A manifest
     built from it tells agents a no-input command accepts an ARRAY. SILENT —
     this is the THIRD silent manifest lie in this beta, after Finite/allOf and
     withDecodingDefaultKey. Fix: normalize on `Object.keys(schema.fields).length
     === 0`, NOT on the lowered output (which would misfire on a legitimate anyOf).

  10. TaggedErrorClass + `noImplicitOverride` requires `override` on the Runtime
      markers. `Cause.YieldableError` already declares
      `[Runtime.errorExitCode]?` / `[Runtime.errorReported]?`, so redeclaring
      them is TS4114. The S2 spike missed this only because its tsconfig lacked
      the flag. Write `override readonly [Runtime.errorExitCode] = 2`.

  11. `Schema.decodeUnknownEffect` carries a REQUIREMENT channel:
      `Schema.Struct.DecodingServices<Fields>`, not `never`. Declaring the
      return type with `never` in R is a type error, not a widening. Propagate
      it; concrete service-free schemas resolve it to `never` at the call site.

  12. `.ast.annotations` IS public API and carries `description` + `identifier`
      (TaggedErrorClass populates `identifier` from the tag, so you can read a
      class's code WITHOUT constructing an instance). But the bag is an index
      signature typed `unknown`, so every read must narrow. Type the parameter
      `{readonly ast: {readonly annotations?: {readonly [x:string]: unknown} |
      undefined}}` — `Annotations | undefined` is not assignable to a plain
      `Record<string, unknown>` under exactOptionalPropertyTypes.

  Plus two non-Effect traps worth the same money:

  13. A module-level `const` that CALLS a later `const` arrow function is a TDZ
      ReferenceError at import, and `tsc --noEmit` does NOT catch it (it tracks
      TDZ within a scope, not across module-initializer order). It surfaces as a
      vitest import crash. Declare derived constants AFTER the functions they call.

  14. An error message built by calling a sibling validator can mask the real
      fault: `descriptionOf` called `tagOf` to name the class, and `tagOf` threw
      first, reporting "missing identifier" when the actual fault was a missing
      description. Read defensively when building a diagnostic.
example_files:
  - packages/symspec/src/kernel/operation.ts
  - packages/symspec/src/kernel/errors.ts
---

# Why this matters

The recurring shape across all three silent manifest failures (Finite/allOf,
withDecodingDefaultKey, and now the empty struct) is that **JSON-Schema lowering
is where this beta lies quietly**. Nothing throws; the manifest is just wrong, and
an agent reading it makes a wrong call. The mitigation that actually works is not
vigilance but a construction-time assertion plus a drift test against the SHIPPED
artifact — `defineOperation` throws on an unreachable description or an invisible
default, and `cli.test.ts` spawns the real bundle.

One correction to earlier guidance worth carrying forward: S2 concluded the ops
table needs `Operation<any,any,any>` for its heterogeneous array. It does not.
Narrowing the ITERATION type to metadata only — dropping `handler`, the single
contravariant member — makes concrete generic ops assignable with no cast and no
`any`, which matters because `noExplicitAny` is an error in this repo.
