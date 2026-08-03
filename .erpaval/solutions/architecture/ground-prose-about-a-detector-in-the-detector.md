---
name: ground-prose-about-a-detector-in-the-detector
description: Documentation that claims a rule fires must be tested against the rule; three of fifteen guessed pairings were wrong, and a count assertion caught a regex that silently missed one entry
metadata:
  type: architecture
---

# Ground prose about a detector in the detector

symspec's G3 wave added an authoring-craft surface (AC-A-6): an anti-pattern catalog teaching
"avoid this, prefer that, and here is the code that fires". Every row names a stable code.

The temptation is to write those pairings from the code catalog's own descriptions —
`GTWR_R7_VAGUE` says "a vague term from the weasel lexicon", so a vague term must fire it.
**Three of fifteen pairings written that way were wrong**, and each wrong one is more
instructive than the right answer:

| claim a reasonable author would make | what the detector actually does |
|---|---|
| "respond **quickly**" fires the vague-term rule | fires **nothing**. `quickly`, `rapidly`, `promptly`, `efficiently`, `easily` are absent from both weasel lexicons; `fast`, `robust`, `timely`, `minimal`, `adequate`, `flexible` fire. It is a LEXICON, not a semantic judgment. |
| a compound requirement fires `GTWR_R18_MULTIPLE_SHALL` | fires `GTWR_R19_COMBINATOR` at **warn**. R18 needs TWO `shall`s and the common compound has one, so lint does not block it — the error-severity signal is on the PARSE path (`ERR_PARSE_COMPOUND`), which is also the only path that returns a mechanical split. |
| `GTWR_R33_MISSING_TOLERANCE` fires when a tolerance is absent | fires on `within 500 ms`, on `within 400 ms to 600 ms`, AND on `500 ms plus or minus 50 ms`. It is a PROMPT to state a tolerance, not an absence check — it cannot be silenced by adding one. |

A catalog description says what a rule is **for**. Only running the rule says what it
**catches**. The gap between those is where documentation rots.

## The precedent this is guarding against

The donor shipped `GTWR_R20_PURPOSE` advising authors to "move rationale to a separate
attribute" — a field that did not exist in the document schema. Nothing failed, because no
test connected the advice to the tool. So the corpus type carries a `codes: string[]` and a
test asserts every code named anywhere in the craft corpus resolves in the unified catalog.
Verified to fail: a fabricated `GTWR_R99_INVENTED` breaks it.

## The count assertion that caught a silent miss

The catalog also extracts a worked micro-example from each code's description text (two
shapes: `(e.g. …)` and `such as …`). The `such as` regex terminated on `[^.(]`, which made
**one** entry unreachable — `GTWR_R9_OPEN_ENDED`, whose example is
`"including but not limited to" / "etc."`, i.e. an example that *ends in a period*. Ten of
eleven worked and nothing threw.

It was caught only because the test pins the **exact list** of codes carrying an example
rather than asserting "some code has one":

```ts
expect(withExample.map(r => r.code)).toEqual([...11 codes...])   // fails at 10
```

This is the same species as an earlier lesson in this repo where a trailing `\b` after a
lexicon entry ending in `.` could never match, killing six entries including R9's canonical
INCOSE exemplar. **Same shape, same rule, found again by a different route** — which is the
argument for the count assertion rather than for remembering the trap.

## How to apply

- **Re-derive, never restate.** Every `fires: [...]` array in the catalog is compared against
  the live detector's output on that exact sentence, with `toEqual` and not `toContain`. Exact
  equality is what caught a second problem: the first draft's examples used "a request" /
  "an order" and fired an incidental `GTWR_R5_INDEFINITE_ARTICLE` on five of fifteen rows, so
  each row was teaching two smells at once. Spelling them "the request" / "the order"
  isolates each example to the code it demonstrates.
- **Assert the "good" rewrite clears the ERROR, not that it is silent.** Several legitimate
  rewrites still carry warn-level prompts (R33's tolerance question, R5's article note), and
  demanding a clean result would push the catalog toward advice that games the linter instead
  of improving the requirement. The property that matters is that no rewrite fires an
  error-severity finding, since error severity is what gates the exit code *and* excludes the
  requirement from formal analysis.
- **Pin counts, not existence, for anything extracted by pattern.** A regex that stops
  matching and a regex that starts over-matching both fail a count; neither fails an
  existence check.
- **Re-run a worked example end to end.** The corpus's worked example claims a document with
  a flat contradiction checks *clean* and that one `antonym add` op makes it provable. Both
  halves are re-executed against a real solver boot in the test, so the section's numbers
  cannot decay into a plausible fiction.
