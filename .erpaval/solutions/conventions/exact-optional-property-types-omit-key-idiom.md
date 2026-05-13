---
title: exactOptionalPropertyTypes — omit the key, don't assign undefined
track: knowledge
category: conventions
module: tsconfig.json
component: typescript
severity: info
tags: [typescript, strict-mode, exactOptionalPropertyTypes, idiom]
applies_when:
  - tsconfig has exactOptionalPropertyTypes=true
  - assigning to an optional field (foo?: T) where the value may be undefined
pattern: |
  With `exactOptionalPropertyTypes: true`, the type `{ foo?: T }` does NOT
  match `{ foo?: T | undefined }`. Assigning `foo: maybeUndefined` errors;
  assigning `foo: undefined` errors; only OMITTING the key (or assigning a
  defined T) is legal.

  Two clean idioms — pick whichever reads better at the call site:

  1) Build the object without the key, then conditionally assign:
       const r: SolverFinding = { kind: 'Ambiguity', id, ... }
       if (rewrites.length) r.suggestedRewrites = rewrites
       findings.push(r)

  2) Conditional spread in the literal:
       return {
         output,
         ...(rawText ? { rawText } : {}),
       }

  Avoid widening the type to `foo?: T | undefined` just to silence the error —
  that defeats the point of exactOptionalPropertyTypes (callers can no longer
  rely on the absence of a key meaning "no value").
example_files:
  - src/solvers/free/ambiguity.ts
  - src/solvers/llm/bedrock-client.ts
  - src/solvers/llm/arbiter.ts
---

# Why this matters

`exactOptionalPropertyTypes` distinguishes `{ foo: undefined }` from `{}` —
this is what lets discriminated unions and `in` checks behave precisely. If
you widen optional fields to `T | undefined` to placate the compiler, every
downstream consumer has to start handling explicit `undefined` even when
the producer never emits it. Push the discipline to the assignment site.

# Example

```ts
// BAD — widens type to satisfy compiler:
type X = { foo?: T | undefined }
const x: X = { foo: maybe }

// GOOD — omit key:
const x: X = {}
if (defined(maybe)) x.foo = maybe

// GOOD — conditional spread:
const x: X = { ...(defined(maybe) ? { foo: maybe } : {}) }
```
