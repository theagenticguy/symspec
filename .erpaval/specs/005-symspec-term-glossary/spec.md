---
slug: symspec-term-glossary
sequence: 005
session: session-61a342
---

**Status:** IN PROGRESS

## Why this is specified rather than just built

Term substitution changes the atom key the SMT solver compares. The governing lesson
(`.erpaval/solutions/architecture/normalization-for-a-propose-signal-must-not-touch-the-decide-key.md`)
forbids loosening that key to make two things match — and in the same breath names the
sanctioned alternative: *"let a committed, reviewed artifact do the actual unification."* A
committed `terms` table is that artifact. Inferred substring matching would not be.

What separates a term entry from a phrase entry is **blast radius**: one phrase entry rewrites
one body, one term entry rewrites every body containing the noun. The mitigation is disclosure
before commit plus write-time refusals — not a narrower substitution rule, because a narrower
rule would just be lenient matching wearing a different hat.

So the boundary behavior is the contract, and it is stated here before code: overlap,
ordering against the three rewrites already in `atomize`, one-hop, and inertness when the
table is empty.

---

## User Story 1 — the committed table

*As a spec author, I commit `session token = login credential` once and every requirement
mentioning either noun lands on one atom, including requirements I write next month.*

### Acceptance Criteria

AC-1-1 [P]
Ubiquitous: The document schema shall carry a `terms` array of `{canonical, aliases[]}`
defaulting to `[]`, alongside the three existing side tables, without moving `DOC_VERSION`.

AC-1-2 [P]
Dependencies: AC-1-1
Ubiquitous: The op vocabulary shall carry `term` and `unterm`, appended to `OP_VERBS` and to
the `DocumentOp` union, never interleaved.

AC-1-3
Dependencies: AC-1-2
Ubiquitous: The CLI shall expose `symspec term <canonical> <alias> [--remove] [--file]
[--dry-run]` as a PEER top-level command, not a `glossary` subcommand, because one envelope
type carries one data shape.

AC-1-4
Dependencies: AC-1-1
Ubiquitous: `toEngineDoc` shall copy `terms` onto the engine `Doc`, and the engine
`RequirementsDoc` type shall carry it.

---

## User Story 2 — the substitution contract

*The rewrite has to be one rule I can state in a sentence, or it is not reviewable.*

### Acceptance Criteria

AC-2-1
Dependencies: AC-1-4
Ubiquitous: `atomize` shall substitute committed terms in TOKEN-SEQUENCE space, matching only
whole underscore-delimited tokens, so a term `token` never rewrites the inside of `tokenizer`.

AC-2-2
Dependencies: AC-2-1
Ubiquitous: The substitution shall scan left to right, take the LONGEST matching alias at each
position, and advance past the tokens it wrote — one pass, no re-entry — so `a→b` plus `b→c`
never chains and the result is one hop, matching the phrase glossary's own rule.

AC-2-3
Dependencies: AC-2-1
Ubiquitous: The substitution shall run AFTER the phrase-glossary lookup and BEFORE the copula
strip, so a committed phrase entry stays keyed on the author's own spelling and guard entries
stay keyed in the same pre-strip space Stage 5 established.

AC-2-4
Dependencies: AC-2-1
Unwanted behavior: If the `terms` table is empty, then `atomize` shall produce byte-identical
output to the build without this feature — the proof that the tier stays reproducible from the
document and that nothing is inferred.

AC-2-5
Dependencies: AC-2-2
Ubiquitous: The resolved substitution index shall be snapshot-tested, as `antonyms.ts` pins
its class→canonical map, so an edit that silently re-keys the table fails loudly.

AC-2-6
Dependencies: AC-2-1
Ubiquitous: `atomize` shall be covered by a DIRECT test of term substitution, including the
empty-table inertness case.

The engine's `formal/` directory has exactly one test file (`lemma.test.ts`); there is no
`atomize.test.ts`, despite the module header claiming to be pinned by one. Coverage of the
function that computes the decide key is entirely indirect today. Adding a rule to it without
adding direct coverage would inherit that gap rather than pay it down.

---

## User Story 3 — refusals at write time

*A wrong term entry is worse than a wrong phrase entry, so the fold has to catch what it can.*

### Acceptance Criteria

AC-3-1 [P]
Dependencies: AC-1-2
Unwanted behavior: If a term's alias equals its canonical after normalization, then the fold
shall refuse with `ERR_USAGE`.

AC-3-2 [P]
Dependencies: AC-1-2
Unwanted behavior: If a term's alias already belongs to a different canonical, then the fold
shall refuse with `ERR_USAGE` rather than leaving the alias resolving by table order.

AC-3-3 [P]
Dependencies: AC-1-2
Unwanted behavior: If a term's canonical is itself a committed alias, then the fold shall
refuse — one-hop resolution would leave the chain silently unresolved.

AC-3-4
Dependencies: AC-3-3
Unwanted behavior: If a term's canonical CONTAINS a committed alias as a contiguous token
subsequence, then the fold shall refuse. This is the one-hop rule in token space: without it
the table's meaning depends on whether the reader expects a second pass, and an ambiguous
decide key is exactly what must not exist.

AC-3-5
Dependencies: AC-3-1
Ubiquitous: Committing a term shall be idempotent, and removing one shall drop an emptied
group entirely, matching `applyGlossary` / `applyUnglossary`.

AC-3-6
Dependencies: AC-3-1
Unwanted behavior: If a term's alias or canonical contains a token that is an antonym-index key
or an `ESTABLISH_VERBS` member, then the fold shall refuse with `ERR_USAGE`.

**This is the AC that keeps Stage 6 sound, and it exists because of a hazard the plan missed.**

`guard-implication.ts:177` decides whether a response is a state-establishing BRIDGE by parsing
the RAW response text — terms-blind by design, because it hands the caller a raw substring to
atomize. But `guard-implication.ts:255` computes that bridge's polarity by running the FULL
`atomize` pipeline, which after this change is terms-AWARE. A term that rewrites a response head
into an antonym-class member desyncs them: the bridge is still recognised from the raw text
while `respNegated` flips from the antonym XOR, so the bridge asserts
`bridgeId ⟹ (context ⟹ ¬state)` where the document asserts `state`. The inert-drop at `:261`
compares the atom NAME and not the polarity, so it does not catch it — the inverted implication
enters the whole-spec conjunction and can make a group UNSAT that the document does not entail.
That is a fabricated `FND_CONTRADICTION` at error severity.

"Do not rewrite token 0" is NOT sufficient: the two-token antonym probe means rewriting token 1
can also move a head out of its class (`roll_back` → `roll_rearward`), which flips polarity the
same way.

So the refusal is at WRITE time — the same discipline `validateAntonyms` uses, and for the same
stated reason: it keeps the check path throw-free. It is injected through `MutateOptions`,
because `domain/requirements` must not import the engine tier.

AC-3-7
Dependencies: AC-3-6
Ubiquitous: The refusal shall be reachable only through the injected validator, so a caller with
no engine available (the domain's own tests) still folds ops without it — matching how
`validateAntonyms` is optional in `MutateOptions` and mandatory at the operation layer.

---

## User Story 4 — the threading, and the gate that catches a missed thread

*The recorded prior bug is threading a table into one `makeAtomize` call site and not the
other.*

### Acceptance Criteria

AC-4-1
Dependencies: AC-2-3
Ubiquitous: The two duplicated `makeAtomize` expressions in
`src/domain/engine/pipeline/check.ts` shall be COLLAPSED into one `pipelineAtomize(doc)` helper
called from both `encodeIncluded` and the main closure.

Threading a table into one site and not the other is a recorded prior bug, and the plan's answer
was to gate it. Collapsing is strictly stronger: it makes the divergence unrepresentable rather
than merely detected. `check.ts:598-602` already refers to "pipelineAtomize" in prose, so the
name is pre-blessed. The two sites are currently two textually-identical expressions on two
lines with no shared constant — the AC-2-7 "one atomizer for both tiers" guarantee rests on
nothing but that coincidence.

AC-4-2
Dependencies: AC-4-1
Ubiquitous: A gate shall assert that, with a NON-EMPTY `terms` table, the atom set
`encodeIncluded` yields agrees with the atom set the main `check` path compares.

Kept even though AC-4-1 makes the failure unrepresentable, because it also catches future
divergence, and because the property it names is currently unasserted in either direction. The
observable is two-directional: a terms entry that unifies two response atoms must drop
`check`'s `progress.atomsUncompared` AND the plan's `corpus.responseNodes`. Dropping the thread
at either site moves exactly one of those.

AC-4-3
Dependencies: AC-3-6
Ubiquitous: A gate shall assert `ESTABLISH_VERBS ∩ keys(ANTONYM_INDEX) = ∅`, the invariant
that is prose-only today and that AC-3-6 protects.

AC-4-4
Dependencies: AC-2-3
Unwanted behavior: If a `terms` table is committed, then `quantityKey` shall NOT see it —
`check.ts:912` keeps building `quantityAliases` from `glossaryIndex(doc.glossary)` alone.

An explicit non-goal, recorded at the call site. `quantityAliases` is sound only because
`glossaryIndex` is whole-phrase exact-match against a single `get(normalize(label))`. Per-token
substitution inside a quantity label would collapse phrasal-verb tails (`carry over` against
`carry`) onto one key and re-commit the fabricated-`FND_NUMERIC_CONTRADICTION` defect the
governing lesson was written about.

---

## User Story 5 — the propose side

*The table is only useful if the tool tells me which entries to write.*

### Acceptance Criteria

AC-5-1
Dependencies: AC-2-2
Ubiquitous: `propose-glossary` shall propose term candidates from shared noun-phrase suffixes,
reusing `sharedObjectSuffix` rather than re-deriving the shape.

AC-5-2
Dependencies: AC-5-1
Ubiquitous: Each term candidate shall report its BLAST RADIUS — every atom the entry would
rewrite — because one entry to many atoms is the whole difference from a phrase entry, and an
author cannot review what they cannot see.

AC-5-3
Dependencies: AC-5-2
Ubiquitous: A term candidate whose alias or canonical is a single token sitting in the antonym
index shall be WITHHELD, because rewriting a verb head feeds the antonym probe and can flip
polarity. The restriction lives in the propose tier; the write path stays sovereign.

AC-5-4
Dependencies: AC-5-1
Ubiquitous: Term candidates shall never enter `plan.ops`, for the same reason guard classes do
not: the decide tier re-validates none of the propose-side conditions.

---

## User Story 6 — the projections

### Acceptance Criteria

AC-6-1
Dependencies: AC-1-3
Ubiquitous: Every derived count and name shall be regenerated, and each prose change shall
carry a NEGATIVE guard asserting the stale literal is absent. The operation count moves 23 → 24
and `src/publish.test.ts` derives it, so README goes red until updated — that is the gate
working.

AC-6-2
Dependencies: AC-6-1
Ubiquitous: `pnpm gen:agents` shall be run and `check:agents` shall pass, and the three doc
comments naming the non-existent `--emit-smt2` / `--solver` flags shall be corrected, since
Stage 6 opens all three files.
