---
slug: symspec-terminology-tier
sequence: 006
session: session-69aed8
---

**Status:** IN PROGRESS

## Why this is specified rather than just built

`FND_TERM_INCONSISTENT` was specified three increments ago (`002-symspec-v3/spec.md`
AC-31-4) as *"a term used in embedding-distant contexts (homonym drift) proposes a
disambiguation"*, and never built. Building it now needed a measurement first, because
the spec assumes a separation that had never been checked against the real model.

**The measurement, on the pinned `Xenova/bge-base-en-v1.5` int8 build, 28 hand-labelled
requirement pairs** (`.erpaval/sessions/session-69aed8/research-term-drift-calibration.yaml`):

| framing | drift band | honest-reuse band | overlap |
| --- | --- | --- | --- |
| the EARS sentence as written | 0.5077 .. 0.6992 | 0.6015 .. 0.8753 | +0.0977 |
| the parsed slots | 0.4785 .. 0.6801 | 0.6458 .. 0.8665 | +0.0342 |
| slots minus a stopword list | 0.4820 .. 0.6537 | 0.6354 .. 0.8645 | +0.0182 |

Two facts came out of it and both shape this spec.

**The EARS boilerplate is a confound.** `the system shall` is a constant in every
requirement, and it pulls every pair up: two requirements sharing NO term at all score
0.6800 as whole sentences. Comparing the PARSED SLOTS instead removes the constant with
no new lexicon, because the document already carries `trigger` / `preCondition` /
`systemResponse` separately. That is the framing this tier uses.

**The signal is real but weak, so the cut is precision-favoring.** At 0.62 on slot
framing, 9 of 12 deliberate homonyms are caught and 0 of 16 honest reuses are split. The
three misses are measured and named in the code. This INVERTS the posture of
`.erpaval/solutions/architecture/propose-only-threshold-favor-recall-measure-it.md`,
and the inversion needs its reason stated: there, a missed paraphrase hides a real
CONFLICT behind distinct atoms, so recall wins. Here a miss hides a wording suggestion
while a false positive is pure noise on a finding that gates nothing — and noise is what
teaches an author to ignore a tier. The asymmetry flipped, so the cut flips.

The second half of this increment is a **false claim in shipped prose**.
`GTWR_R37_ACRONYM` emits *"ensure it is defined in the glossary"* from
`src/domain/engine/lint/gtwr.ts:1063`, in a function whose entire scope is
`(sentence: string, findings: GtWRFinding[])`. It has never seen a glossary. That is the
`download-model` defect class: a capability named by prose and implemented nowhere.

---

## User Story 1 — a committed table that fused two concepts

*As a spec author who committed `token` as a term, I want to be told when that one entry
is rewriting bodies in two requirements that have nothing to do with each other, because
that entry is fusing two concepts into one atom and a conflict between them can no longer
be proven.*

### Why the candidate set is the COMMITTED vocabulary, and not every repeated word

The narrowing is deliberate and is the design decision most worth arguing with.

A committed `terms` entry rewrites **every** body containing the noun — that is Stage 6's
whole point and its named hazard, blast radius. If the two concepts it fuses are
different, the merge does what
`.erpaval/solutions/architecture/antonym-glossary-mirrors-synonym-glossary-for-opposition.md`
calls the masking direction: two requirements land on one atom, and the tool reports
agreement it never proved. So drift in a committed entry is the case where the stakes are
highest and the author has already told us the phrase is vocabulary.

Mining every repeated word instead would need a function-word lexicon — without one, `the`
occurs in every requirement and would be the first term proposed for a split. A new
lexicon in a tier whose only justification is determinism is a cost, and
`.erpaval/solutions/conventions/lexicon-entries-need-per-entry-reachability-tests.md`
prices it. The broader mining pass is the next increment, not this one, and AC-1-6 keeps
it honest by making the tier say what it examined.

### Acceptance Criteria

AC-1-1 [P]
Ubiquitous: A new greenfield `src/domain/terminology/terminology-codes.ts` shall declare
an append-only `TERMINOLOGY_FND_CODES` list and a `TerminologyFndCodeMeta` record, whose
descriptions carry the `FND_*` corpus format — a `<severity> — ` prefix using an em dash
U+2014, and a trailing `Suggestion:` clause — because `catalog.ts`'s `FND_SEVERITY_PREFIX`
and `SUGGESTION_MARKER` parse that shape and a hyphen matches nothing.

AC-1-2
Dependencies: AC-1-1
Ubiquitous: `catalog.ts` shall union the new corpus through its own tier table and row
builder, appended after `reachabilityRows()`, so an agent sees ONE finding-code
vocabulary. The tier shall be `'formal'`, matching `FND_SIMILAR_SEMANTIC` — the
embedding-derived synonym bridge this finding is the dual of — and not a widening of
`CheckTier`.

AC-1-3
Dependencies: AC-1-1
Event-driven: When the semantic tier runs and a committed `terms` or `glossary` entry's
key occurs in the slot bodies of two or more requirements of one system, symspec shall
compare those requirements' slot texts pairwise and emit `FND_TERM_INCONSISTENT` (info)
naming the two MOST DISTANT sites when their cosine falls below
`DEFAULT_TERM_COHERENCE_FLOOR`.

AC-1-4
Dependencies: AC-1-3
Ubiquitous: `DEFAULT_TERM_COHERENCE_FLOOR` shall be a named exported constant of `0.62`
whose doc comment carries the measured bands, the three named misses, and the
precision-favoring rationale. It shall NOT be derived from, aliased to, or share a
constant with `DEFAULT_SEMANTIC_THRESHOLD` (0.72) or
`DEFAULT_OPPOSITION_COSINE_FLOOR` (0.5) — three different judgments, and a shared value
by coincidence must not become a shared constant.

AC-1-5
Dependencies: AC-1-3
Ubiquitous: The finding's message shall name the AUTHOR's phrase and the two requirement
ids, disclose the cosine rounded to two decimals, and state the consequence in the
masking direction — that a fused atom makes a conflict between the two unprovable. It
shall carry a `symspec unterm` / `symspec unglossary` remedy and shall state that leaving
the entry is correct when the reuse is intended.

AC-1-6
Dependencies: AC-1-3
Ubiquitous: The payload shall report what the tier EXAMINED — the number of committed
keys considered and the number of requirement pairs compared — so "no drift found" is
distinguishable from "the tier had nothing to look at". A document with empty tables
reports zero keys examined, not silence.

---

## User Story 2 — the finding must not become a gate

*As an agent driving `check --strict` in a loop, I need a clarity suggestion to leave my
exit code alone, or it becomes a task I must discharge to make the build green.*

### Acceptance Criteria

AC-2-1
Dependencies: AC-1-3
Unwanted behavior: If `FND_TERM_INCONSISTENT` fires, then symspec shall NOT push a
coverage demotion, NOT flip `data.verified`, and NOT set `strictGate: 'fail'`. It is
`info`, so `exitCodeForEnvelope` already ignores it; the demotion set is the only other
lever on the verdict and this tier must not touch it.

AC-2-2
Dependencies: AC-1-3
Unwanted behavior: If `FND_TERM_INCONSISTENT` fires on a document where no
cross-requirement comparison happened, then `FND_NO_PAIRS_CHECKED` shall still be
emitted. The disclaimer is computed inside the engine, before this tier's splice, so the
seam choice enforces this — and the test shall assert the property rather than the
seam, so moving the splice cannot silently take the disclaimer with it.

AC-2-3
Dependencies: AC-1-3
Ubiquitous: The spliced findings shall be filtered by the same `--min-severity` rule as
every other tier, and `counts` shall be recomputed over the merged set, so
`counts.info` agrees with `findings.length` and `counts.error` is provably unmoved.

AC-2-4
Dependencies: AC-1-3
State-driven: While `--semantic=false`, the tier shall not run, and the existing
`semantic-tier-skipped` demotion shall remain the single disclosure of that absence — no
second demotion reason for the same fact.

---

## User Story 3 — an acronym rule that stops claiming a check it never ran

*As a reader of a finding, I need the message to describe what was actually examined.*

### Acceptance Criteria

AC-3-1
Ubiquitous: `GTWR_R37_ACRONYM`'s per-statement message shall state only what a
single-sentence check can know — that the statement carries an unexpanded acronym — and
shall not assert anything about the glossary. This is an edit under
`src/domain/engine/**`, so it lands with a sabotage that turns a gate red.

AC-3-2
Dependencies: AC-3-1
Ubiquitous: A test shall assert the OLD prose is ABSENT. Asserting the new sentence
passes just as happily on a file containing both, which is how a corrected count came
back twice.

AC-3-3
Dependencies: AC-1-1
Event-driven: When the document declares an acronym that appears in neither the glossary
nor the terms table, symspec shall emit `FND_ACRONYM_UNDEFINED` (info) from the
terminology tier — the document-level claim R37's prose promised, made where the tables
are in scope — naming each acronym and the `symspec glossary` command that defines it.

AC-3-4
Dependencies: AC-3-3
Ubiquitous: The two codes shall be documented as different claims, not duplicates: R37 is
per-statement style ("expand on first use"), which a glossary entry does not satisfy,
while `FND_ACRONYM_UNDEFINED` is document-level definition coverage, which a glossary
entry does satisfy and therefore silences. R37's firing condition shall be UNCHANGED —
threading the tables into it would conflate the two claims the reword just separated.

AC-3-5
Ubiquitous: `src/domain/engine/lint/` shall gain a test file. It has none today, so R37's
severity, allowlist, and message have never been asserted, and the reword in AC-3-1 would
otherwise be unobserved.

---

## User Story 4 — the count moves, and three surfaces are already wrong about it

*As the person who owns the derivable-number rule, I want this increment to prove the
gate, not route around it.*

### Acceptance Criteria

AC-4-1
Dependencies: AC-1-1, AC-3-3
Ubiquitous: Two new codes take the catalog from 81 to 83 and `FND_*` from 36 to 38. Every
prose surface shall be updated from the catalog: `README.md`, the regenerated `AGENTS.md`,
`skill-body.ts`, `explain`, `waive --help`, and the pinned literals in
`catalog.test.ts`, `agents-doc.test.ts`, and `index.test.ts`.

AC-4-2
Dependencies: AC-4-1
Ubiquitous: `publish.test.ts`'s total-code-count assertion shall gain the NEGATIVE guard
it lacks. `publish.test.ts:599-601` asserts only `toContain('**81 stable codes**')`, while
its own sibling three lines above argues in a comment that the positive form "passes just
as happily for a hardcoded copy". The count assertion shall assert the predecessor is
absent, as the operation-count assertion already does.

AC-4-3
Ubiquitous: `package.json`'s registry description states `81 stable codes` and NO test
gates it, so this increment ships a wrong number to npm unless it is fixed. It shall be
asserted against the catalog with the same negative guard.

AC-4-4
Ubiquitous: `README.md`'s `applies 24 INCOSE rules` is hand-typed and ungated, and the
existing `HAND_TYPED_COUNT` sweep in `repair.test.ts` reads only `src/**/*.ts`, so
Markdown and `package.json` escape it. The sweep shall be extended to cover them, or each
count gated individually — and the extension shall be observed to fail against the
current tree before the counts are corrected.

AC-4-5
Ubiquitous: `catalog.ts` and `index.ts` carry doc comments saying `5` reachability codes
and `80` total against a real 6 and 81. These are comment lines, which `HAND_TYPED_COUNT`
skips by design, and they are wrong now. They shall be corrected in this pass.
