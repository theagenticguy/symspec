---
title: Biome noNonNullAssertion — turn it off when noUncheckedIndexedAccess is on
track: knowledge
category: conventions
module: biome.json
component: biome
severity: info
tags: [biome, typescript, lint-config, idiom]
applies_when:
  - tsconfig has noUncheckedIndexedAccess=true
  - source uses guarded array index access in tight loops (e.g., for (let i; i < arr.length; i++) const x = arr[i]!)
pattern: |
  Biome's `style/noNonNullAssertion` warns on every `!`, but `noUncheckedIndexedAccess`
  forces you to either re-narrow with a runtime check or use `!` after a
  guarded index. The `!` is the canonical Pareto idiom in pure JS algorithm code
  (DFS, group-by, pair-emit loops). Re-narrowing inside an inner loop adds noise
  without changing correctness.

  Resolution: enable `noUncheckedIndexedAccess` in tsconfig (the strong
  type-system control) and turn `noNonNullAssertion` OFF in biome (the
  redundant style warning).

  ```json
  // biome.json
  {
    "linter": {
      "rules": {
        "style": { "noNonNullAssertion": "off" }
      }
    }
  }
  ```
example_files:
  - biome.json
  - src/solvers/free/duplicates.ts
  - src/solvers/free/pairwise-filter.ts
---

# Why this matters

Two strict checks (one structural, one stylistic) shouldn't double-warn on
the same idiom. Pick the one with type-system teeth.

# Example

```ts
// With noUncheckedIndexedAccess: true, arr[i] has type T | undefined.
// In a guarded for-loop, the ! is the cleanest way to re-narrow.
for (let i = 0; i < group.length; i++) {
  for (let j = i + 1; j < group.length; j++) {
    const a = group[i]!  // safe by construction; biome should not warn here
    const b = group[j]!
    ...
  }
}
```
