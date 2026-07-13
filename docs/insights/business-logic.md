# symspec · Business logic

The domain rules symspec enforces over EARS (Easy Approach to Requirements Syntax) requirements: what a valid requirement looks like, how it renders, how prose is classified into it, the surface-quality lint catalog, the formal conflict semantics proved by SMT, the v3 numeric / ambiguity / temporal / requirement-graph tiers, and the propose-vs-decide boundary that keeps the verdict path deterministic. Every rule below cites the source that defines it.

**The governing invariant across all tiers**: a **verdict-eligible** finding (`error`/`warn` that can drive the pass/fail gate) must recompute **bit-identically** from `(document + committed glossary + pinned model)`; everything fuzzier is `info` / propose-only. Deterministic tiers (structural DAG, GtWR lint, propositional SMT, numeric SMT, bounded temporal SMT, the mechanical `and…or` ambiguity case) can hold that contract; embedding-driven tiers only PROPOSE. This is the "propose-vs-decide split" that recurs in every section below.

---

## EARS patterns

Five pattern types (`EARS_PATTERNS`) are the closed vocabulary; each fixes which structural slots are mandatory and how the canonical sentence renders. The five slots are `patternType, preCondition, trigger, systemName, systemResponse`.

| Pattern | Required slot | Renders as | Rule source |
|---|---|---|---|
| `ubiquitous` | none (always-true invariant) | `The <system> shall <response>.` | `src/core/render.ts:42`; `src/core/schema.ts:77` |
| `event-driven` | `trigger` | `When <trigger>, the <system> shall <response>.` | `src/core/render.ts:44`; `src/core/schema.ts:79` |
| `state-driven` | `preCondition` | `While <preCondition>, the <system> shall <response>.` | `src/core/render.ts:48`; `src/core/schema.ts:81` |
| `optional-feature` | `preCondition` | `Where <preCondition>, the <system> shall <response>.` | `src/core/render.ts:50`; `src/core/schema.ts:83` |
| `unwanted-behavior` | `trigger` | `If <trigger>, then the <system> shall <response>.` | `src/core/render.ts:52`; `src/core/schema.ts:85` |

- The pattern enum is the single source of truth — `EARS_PATTERNS` at `src/core/schema.ts:27`.
- Combined precondition+trigger case: an event-driven requirement that also carries a `preCondition` renders `While <pre>, when <trigger>, the <system> shall <response>.` — `src/core/render.ts:46`.
- `sentence` is a derived, denormalized field — never authored directly; the renderer re-runs whenever an EARS slot changes — `src/core/schema.ts:170`, `src/core/render.ts:33`.
- `systemName` always renders with a leading `the`, so the stored value must omit any leading article — `src/core/schema.ts:109`, `src/core/render.ts:40`.
- `systemResponse` must stay POSITIVE and drop the word `shall`; a prohibition is expressed by the `negated` flag, not by baking `not` into the text — `src/core/schema.ts:116`.
- Response polarity (AC-2-4): `negated=true` renders `shall not <response>` and encodes as `¬R`, letting `shall X` and `shall not X` share one atom at opposite polarity — `src/core/schema.ts:128`, `src/core/render.ts:39`.
- Slot-presence is enforced at check time, not write time: an event-driven / unwanted-behavior requirement with no `trigger` yields a `MissingTrigger` finding; a state-driven / optional-feature requirement with no `preCondition` yields `MissingPreCondition` — `src/core/analyze.ts:49`, `src/core/analyze.ts:57`.

### Tier-1 parse (prose → slots)

`classifyTier1` maps requirement-shaped prose into EARS slots via an ordered regex cascade — `src/parse/tier1.ts:239`.

- Cascade order is load-bearing: `complex (While…, when…) → unwanted (if…then) → unwanted-no-then → event (when) → event-no-comma → state (while) → optional (where) → ubiquitous` — `src/parse/tier1.ts:156`. `complex` must precede `state` (else `While` greedily swallows the sentence); `if…then` must precede `when` — `src/parse/tier1.ts:6`.
- The mandatory gate: a keyword rung counts as matched only if its main clause `<system> shall <response>` parses via `MAIN`; a keyword hit whose main clause fails to parse falls through to the next rung — `src/parse/tier1.ts:111`, `src/parse/tier1.ts:245`.
- Keyword synonyms broaden each pattern (`when|whenever|upon|once|after|as soon as|on receipt of|in the event that`, etc.) — `src/parse/tier1.ts:70`.
- Accepted modals: `shall|must|will|should`; any non-`shall` modal downgrades confidence and adds a `nonstandard-modal` note — `src/parse/tier1.ts:80`, `src/parse/tier1.ts:301`.
- `MAIN` strips a leading article (`the|a|an`) to honor the article-free `systemName` convention, and captures an explicit negator (`not|never|not be able to`) as a polarity flag so the formal tier receives `¬R` rather than a string containing "not" — `src/parse/tier1.ts:102`.
- Escalation predicates reject an untrustworthy parse (`system-clause-pollution` when the system group contains a comma, an embedded EARS keyword, or >6 tokens) or annotate a weak one (`weak-subject` for a bare person-word subject like "users") — `src/parse/tier1.ts:192`.
- A line with a modal but no response ("The system shall") escalates as `modal-without-response` (a truncated requirement — an error, never silently dropped); a line with no modal at all is treated as prose — `src/parse/tier1.ts:274`.

---

## GtWR lint rules

Surface-quality checks derived from the INCOSE *Guide to Writing Requirements* (GtWR v4). symspec implements the **24 Tier-1 (regex / lexicon) checkable rules** of that catalog, each with a stable `GTWR_R<n>_<slug>` code, a severity, a character span, and (often) a mechanical suggestion — `src/lint/gtwr.ts:1`, `src/lint/gtwr.ts:74`. Severity legend: `error` feeds the pass/fail gate; `warn` has legitimate exceptions and is excluded from the gate; `info` is advisory — `src/lint/gtwr.ts:6`.

Categories (with representative rules; not exhaustive):

- **Pattern compliance** — R1: the statement must match the EARS master template `[Where…,][While…,][When|If…,[then]] the <system> shall <response>`; anything else is an `error`. The template is built from the parser's own `KW` vocabulary so lint and parse agree on what EARS is — `src/lint/gtwr.ts:53`, `src/lint/gtwr.ts:156`.
- **Vagueness / immeasurability** — R7 weasel-word lexicon (`adequate, appropriate, fast, robust, seamless, user-friendly, …`, `error`) — `src/lint/gtwr.ts:247`; R34 immeasurable performance terms (`warn`) — `src/lint/gtwr.ts:665`; R33 quantity without a tolerance/range (`warn`) — `src/lint/gtwr.ts:645`.
- **Units / numbers** — R6 bare number with no unit (`error`) — `src/lint/gtwr.ts:224`; R40 decimal-format consistency, the one **set-level** rule — literals of mixed fractional precision across the spec are flagged `info` against the dominant precision — `src/lint/gtwr.ts:833`.
- **Definiteness / reference** — R5 indefinite article `a`/`an` where `the` is expected (`warn`) — `src/lint/gtwr.ts:200`; R24 personal/indefinite pronouns (`it, they, this, one, …`, `warn`) — `src/lint/gtwr.ts:542`; R37 undefined acronyms (skips a common allowlist, `warn`) — `src/lint/gtwr.ts:743`; R38 non-unit abbreviations (`warn`) — `src/lint/gtwr.ts:780`.
- **Negation** — R16 flags `not/never/shall not/unable to/no longer` unless wrapped in a defined logical expression `[NOT X]`; `warn` because negation has legitimate uses — `src/lint/gtwr.ts:395`.
- **Absolutes / quantifiers** — R26 absolutes (`all, every, always, never, 100%, …`) escalate to `error` unless a conditional clause is present, else `warn` (AC-3-3 exception handling) — `src/lint/gtwr.ts:580`; R32 universal quantifiers recommend `each` (`warn`) — `src/lint/gtwr.ts:625`.
- **Structure / atomicity** — R18 multiple `shall` in one sentence — split into separate requirements (`error`) — `src/lint/gtwr.ts:440`; R19 combinators (`and, or, unless, otherwise, …`) inside the response clause (`warn`) — `src/lint/gtwr.ts:460`; R15 undefined lowercase `and`/`or` in condition clauses (`warn`) — `src/lint/gtwr.ts:371`; R21 parenthetical subordinate text (`warn`) — `src/lint/gtwr.ts:519`.
- **Ambiguity / escape hatches** — R8 escape clauses (`where possible, if necessary, …`, `error`) — `src/lint/gtwr.ts:301`; R9 open-ended phrases (`including but not limited to, etc., …`, `error`) — `src/lint/gtwr.ts:325`; R10 superfluous infinitives (`shall be able to, …`, `warn`) — `src/lint/gtwr.ts:352`; R20 purpose phrases (`in order to, so that`, move rationale out, `warn`) — `src/lint/gtwr.ts:494`; R17 oblique `/` for "and/or" (`warn`) — `src/lint/gtwr.ts:421`; R35 indefinite temporal keywords, `info` when bound to a measured event/time, else `warn` — `src/lint/gtwr.ts:695`.
- **Voice** — R2 passive voice `shall be <participle>` with an active-form suggestion (`warn`) — `src/lint/gtwr.ts:178`.

---

## Formal conflict semantics

The formal tier discharges four whole-spec / pairwise properties on an SMT (z3) solver. All four are only as sound as `atomize` — the invariant "sound modulo atomization" (AC-4-11): a conflict is provable only when two responses resolve to the **same atom** at opposite polarity — `src/formal/atomize.ts:1`.

### Atomization contract (the load-bearing function)

`atomize` is the single pure function turning slot text into a Boolean atom — `src/formal/atomize.ts:135`. Its four guaranteed invariants:

- **Purity / determinism** — depends only on its args and a frozen antonym table; same input → byte-identical output — `src/formal/atomize.ts:14`.
- **Conservative normalization** — lowercase → strip one leading article → strip punctuation → collapse whitespace → underscore-join. No stemming/lemmatization/stopword removal (`issues` ≠ `issue`), because aggressive normalization is the one false-positive class — `src/formal/atomize.ts:120`.
- **Per-`systemName` scoping** — every atom is prefixed `sys__<system>__<kind>__`, so identical response text under two different systems yields two distinct atoms and can never fake a cross-system conflict (AC-4-2a) — `src/formal/atomize.ts:164`, `src/formal/atomize.ts:29`.
- **Negation on the same atom** — the AC-2-4 `negated` flag becomes the atom's polarity, not part of the text; the curated antonym table extends this to lexical opposites (`grant access` / `revoke access` unify to one atom, opposite polarity, via XOR composition) — `src/formal/atomize.ts:153`.

### Contradiction (`FND_CONTRADICTION`, error)

- Detected only when two responses resolve to the same atom at opposite polarity under a **reachable** context — `src/formal/contradiction.ts:224`, `src/formal/contradiction.ts:95`.
- Reachability discipline: group requirements by their context (trigger/precondition) atoms; for each group assert **only that group's** context atoms true while including **every** requirement's guarded implication (whole-spec), because `(X⇒Y)∧(X⇒¬Y)` is vacuously satisfiable if `X` is never asserted, and asserting all triggers at once manufactures spurious conflicts between mutually exclusive triggers — `src/formal/contradiction.ts:1`, `planContextGroups` at `src/formal/contradiction.ts:140`.
- A baseline empty-context group catches unconditional (ubiquitous `R` vs ubiquitous `¬R`) conflicts and is always present — `src/formal/contradiction.ts:141`.
- Unsat cores are minimized (z3 `smt.core.minimize` plus a deletion-based re-check, `minimizeCore`) so an innocent whole-spec requirement sharing no atom cannot ride along in the core — `src/formal/contradiction.ts:189`, `src/formal/contradiction.ts:265`. A finding requires ≥2 distinct requirement ids — `src/formal/contradiction.ts:310`.
- Per-group enumeration finds every pairwise-disjoint conflict in a group, not just the first — `src/formal/contradiction.ts:282`.

### Subsumption & redundancy (`FND_SUBSUMPTION` / `FND_REDUNDANCY`, warn)

- Pairwise, over candidate pairs only (contrast with whole-spec contradiction/vacuity) — `src/formal/subsumption.ts:150`.
- One-directional valid implication → `FND_SUBSUMPTION`; both directions → `FND_REDUNDANCY` (logical duplicate); neither/inconclusive → no finding — `src/formal/subsumption.ts:95`.
- Direction is decided by which SMT implication is valid and mapped back by id — `moreGeneral` is the implied-side requirement (fires in the superset of cases), never assigned positionally from the pair's `a`/`b` slot — `src/formal/subsumption.ts:12`, `src/formal/subsumption.ts:127`.
- Compares `.body` (`context ⇒ response`), not the guarded `.formula`, because two distinct free guard literals make `formulaA ⇒ formulaB` never valid — `src/formal/subsumption.ts:31`, `src/formal/subsumption.ts:79`.
- Inconclusive (`sat`/`unknown`) is conservatively never reported as a proven implication — `src/formal/subsumption.ts:84`.

### Vacuity (`FND_VACUITY`, warn, low confidence)

- Relational, not "unsatisfiable guard": a distinct-atom guard is always satisfiable in isolation, so vacuity asserts every **other** requirement's body plus this requirement's guard literals and checks for `unsat` — `unsat` means the guard is unreachable given the rest of the spec — `src/formal/vacuity.ts:1`, `src/formal/vacuity.ts:72`.
- Ubiquitous requirements have no guard and are never vacuity candidates — `src/formal/vacuity.ts:54`.
- Shipped at `confidence: 'low'` — under regex parsing it only bites when one requirement's response atom is another's negated precondition atom under the same system — `src/formal/vacuity.ts:18`, `src/formal/vacuity.ts:37`.
- `unknown` is never reported as vacuous — `src/formal/vacuity.ts:91`.

---

## Numeric / arithmetic conflict (v3.0)

The propositional SMT tier is opaque to arithmetic: "temperature above 40" and "temperature below 30" become two unrelated Boolean atoms that never conflict. The numeric tier lifts numeric predicates into a real-arithmetic (LIA/LRA) SMT check so jointly-unsatisfiable bounds on one quantity prove UNSAT. It is deterministic and **verdict-eligible** (`error`), and it **runs over ALL requirements**, not the gate-included subset — numeric conflict is independent of the propositional-encoding soundness the AC-3-7 gate protects, so a lint-blocking finding (e.g. a missing-units warning on a bare number) must not hide a real numeric contradiction — `src/pipeline/check.ts:388`, `src/pipeline/check.ts:396`.

### Extraction contract (`extractNumericPredicates`)

`extractNumericPredicates(text, systemName)` is a pure regex/lexicon lift of `(quantity, comparator, value, unit)` tuples; no model, no guessing — a slot with no recognizable predicate yields `[]`, so a missed extraction is a false negative (the honest failure direction), never a fabricated constraint — `src/formal/numeric.ts:196`, `src/formal/numeric.ts:33`.

- **Unit normalization.** Every value normalizes to a canonical base unit before comparison, or a real conflict (2000 ms vs 200 ms) is missed. Two dimensions ship: time → `ms` (`s`×1000, `min`×60000, `h`×3600000, …) and size → `B` (`kb`×1000, `kib`×1024, `mb`×1e6, …); unknown units stay unitless — `src/formal/numeric.ts:58`, `src/formal/numeric.ts:99`.
- **Per-system quantity identity.** "temperature", "the temperature", "temp" must collapse to ONE canonical key scoped per system — `sys__<system>__qty__<label>` — mirroring the AC-4-2a atom scoping, so two systems' "latency" are distinct quantities and never cross-conflict — `src/formal/numeric.ts:142`, `src/formal/numeric.ts:16`.
- Comparator lexicon maps phrasing to `<=`/`>=`/`<`/`>`/`=` (`no more than`→`<=`, `at least`→`>=`, `within`→`<=`, `exactly`→`=`, …); longer phrases match first so `less than` cannot re-match inside `no less than` — `src/formal/numeric.ts:114`, `src/formal/numeric.ts:206`.
- The quantity label is the noun phrase immediately BEFORE the comparator, trimmed of trailing prepositions/fillers so "respond in", "respond in no", "respond" all normalize to one quantity — over-broad capture would split identical quantities and let a conflict escape — `src/formal/numeric.ts:159`.

### Detection (`FND_NUMERIC_CONTRADICTION`, error)

`findNumericContradictions` groups predicates by canonical per-system quantity; a quantity constrained by < 2 distinct requirements is skipped without a solver call. For each remaining group it asserts every requirement's predicate under its own guard literal (= requirement id) and checks joint SAT over a shared per-quantity Real variable; on `unsat` the minimal unsat core names exactly the culprit ids — the same assumption-literal-guard technique the propositional `contradiction.ts` uses — `src/formal/numeric-contradiction.ts:55`, `src/formal/numeric-contradiction.ts:82`. The core is deletion-minimized so an innocent requirement sharing the quantity cannot ride along, and a finding requires ≥2 distinct ids — `src/formal/numeric-contradiction.ts:139`. LIA/LRA is convex and decidable, so the verdict and core are reproducible; this tier introduces no approximation — `src/formal/numeric-contradiction.ts:19`.

---

## Ambiguity family (v3.1)

A deterministic, always-on finding family grounded in the Berry & Kamsties taxonomy: lexical (vague), scope/quantifier, referential/anaphoric, and pragmatic/contextual ambiguity. The module is PURE and SYNCHRONOUS — no solver, no model, no async, no I/O — so it recomputes bit-identical findings and runs on the default `check` path like structural + lint — `src/formal/ambiguity.ts:442`, `src/pipeline/check.ts:320`. Only the mechanical case is verdict-eligible; the rest are `info` / propose-only, tagged `tier: 'lint'` in the report — `src/pipeline/check.ts:324`.

- **`FND_AMBIGUOUS_VAGUE` (info).** One finding per DISTINCT vague/weasel phrase from a SHORT, high-precision lexicon (`fast, user-friendly, adequate, efficient, as appropriate, etc, reasonable, timely, robust, seamless, …`) — kept deliberately small per the SREE/Gleich false-positive-fatigue lesson so authors do not learn to ignore it — `src/formal/ambiguity.ts:103`, `src/formal/ambiguity.ts:156`.
- **`FND_AMBIGUOUS_QUANTIFIER`.** Three patterns; only (a) is verdict-eligible: (a) an un-parenthesized `and…or` coordination — the classic `X and Y or Z` scope ambiguity — is severity `warn` and the only case that enters the reproducibility contract; a sentence that groups its coordination with parentheses is treated as disambiguated and NOT flagged — `src/formal/ambiguity.ts:262`. (b) a leading universal (`all/each/every`) + determiner and (c) a bare plural subject of `shall` are `info` — `src/formal/ambiguity.ts:280`, `src/formal/ambiguity.ts:293`.
- **`FND_AMBIGUOUS_REFERENCE` (info).** Recall-first per Ezzini: FLAG a pronoun (`it/this/they/them/that`) or a bare definite NP (`the system`/`the service`) when ≥2 distinct `systemName`s exist across the document, and list them as candidate antecedents — resolution is deliberately punted. Reports the earliest such reference per requirement (one finding, low-noise) — `src/formal/ambiguity.ts:337`, `src/formal/ambiguity.ts:321`.
- **`FND_AMBIGUITY_NEEDS_JUDGMENT` (info).** The structured replacement for the silent pragmatic/contextual punt (Berry & Kamsties' non-decidable class): emitted only for a long requirement (> 25 words) that triggered NONE of the deterministic categories, naming it for an LLM/agent review pass — never enters the reproducibility contract — `src/formal/ambiguity.ts:401`, `src/formal/ambiguity.ts:384`.

---

## Temporal / ordering conflict (v3.3, opt-in `--temporal`)

The propositional tier evaluates one snapshot; the temporal tier reasons about ORDER over a finite trace. It is opt-in (`--temporal`, default bound `k=10`) and, when enabled, runs over ALL requirements on the shared in-process Z3-WASM context — `src/pipeline/check.ts:412`, `src/cli/index.ts:311`.

### EARS → LTL mapping (`earsToTemporal`, pure)

`earsToTemporal(req)` is a pure, solver-free map from an EARS requirement to a Dwyer/SPS LTL formula per NASA FRET semantics — `src/formal/temporal-patterns.ts:168`:

| EARS pattern | SPS pattern | LTL shape |
|---|---|---|
| event-driven | Response | `G(trig → F resp)` |
| unwanted-behavior | Absence | `G(trig → ¬resp)` |
| state-driven | Universality | `G(state → resp)` |
| optional-feature | Universality⟨feat⟩ | `G(feature → resp)` |
| ubiquitous | Universality | `G(resp)` |

- Response polarity is threaded onto the response literal (`¬resp` when `negated`), never baked into the atom name, and atoms are scoped per system `sys__<system>__<kind>__<slot>` with the same conservative normalization the propositional atomizer uses — so a temporal atom and its propositional counterpart line up by name — `src/formal/temporal-patterns.ts:142`, `src/formal/temporal-patterns.ts:121`.

### Bounded lowering + detection (`FND_TEMPORAL_CONTRADICTION`, error)

`findTemporalContradictions(ctx, reqs, k)` lowers each formula loop-free to per-timestep atom variables (`<atom>@<t>` for t in 0..k) — `G φ` unrolls to `⋀ φ@t`, `F φ` to `⋁ φ@t`, `X φ` shifts to t+1 (false past the horizon), `φ U ψ` to its bounded expansion — then checks joint SAT under per-id guard literals; on `unsat` the minimal core names the culprits — `src/formal/temporal.ts:118`, `src/formal/temporal.ts:62`.

- **SOUND-FOR-UNSAT, not complete-for-SAT (the honest limit).** Without a loopback lasso, an `unsat` verdict is a genuine contradiction (no trace of length ≤ k satisfies the set, and `G`/response obligations only get harder with more steps), but a `sat`-at-k result is NOT a consistency certificate — a conflict may first appear past the horizon. A finding is emitted ONLY on `unsat`, so the tier never over-reports; the evidence carries `{ bound: k, complete: false }` — `src/formal/temporal.ts:13`, `src/formal/temporal.ts:143`.
- **Reachability discipline.** A `G(ante → cons)` obligation is vacuously satisfiable by keeping `ante` false forever, which would hide a real conflict; the solver adds an `F(antecedent)` reachability assertion per distinct guarded trigger. Shared antecedents dedupe by atom name so two requirements on the same trigger become reachable together without asserting mutually-exclusive triggers — the temporal analogue of `contradiction.ts`'s context-group reachability — `src/formal/temporal.ts:186`.

---

## Requirement similarity graph + DAG invariant (v3.1–v3.2)

### Similarity graph (propose-only, `--semantic`)

`buildSimilarityGraph(reqs, embedder, opts)` is an always-on-when-`--semantic` deterministic kNN graph over rendered sentences that PROPOSES two info-tier findings — never a verdict, because the trace-link-recovery literature is clear that embedding link suggestions have too-low precision to auto-commit — `src/formal/graph.ts:102`, `src/formal/graph.ts:8`. Determinism is engineered: the embedder is injected (CPU/ONNX-WASM, byte-reproducible where GPU is not); cosine is QUANTIZED to a fixed precision (4 dp) before any threshold comparison so sub-ULP jitter can never flip an edge; neighbor ties break on requirement id; clustering is union-find over the deterministic edge set — `src/formal/graph.ts:16`, `src/formal/graph.ts:82`.

- **`FND_MISSING_TRACE_LINK` (info).** A kept edge (cosine ≥ 0.82 default, in either endpoint's top-k=5) whose endpoints carry no committed `refines`/`derives`/`satisfies` link — suggests adding the edge — `src/formal/graph.ts:45`, `src/formal/graph.ts:144`.
- **`FND_DUPLICATE_CLUSTER` (info).** A connected component of ≥3 mutually-similar requirements — surfaced as a near-duplication review prompt — `src/formal/graph.ts:56`, `src/formal/graph.ts:199`.

### `FND_LEAF_UNVERIFIABLE` (structural DAG invariant, verdict)

Added to the structural analyzer (`analyze`), not the graph tier. KAOS/SysML canon: a **refinement leaf** — a requirement that others refine or derive toward (has inbound `refines`/`derives`) but which itself refines/derives nothing further (a DAG sink) — must be independently verifiable. A leaf with no `verifies` edge is flagged an unverifiable dead end — `src/core/analyze.ts:102`, `src/core/analyze.ts:125`.

---

## Propose/decide invariant

The determinism boundary between embeddings and the SMT verdict.

- **Embeddings only PROPOSE.** `findSimilarSemantic` embeds the response phrasings of same-system pairs that did NOT already unify, and when cosine ≥ threshold (default 0.72) emits an **info-tier** `FND_SIMILAR_SEMANTIC` finding suggesting a concrete `symspec glossary add` merge. It never emits a conflict verdict; its only durable effect is a suggestion the agent may confirm — `src/formal/semantic.ts:1`, `src/formal/semantic.ts:76`, `src/formal/semantic.ts:116`. The `0.72` default (`DEFAULT_SEMANTIC_THRESHOLD`) is tuned to this model's real CLS-pooled, L2-normalized, no-prefix cosine band — divergent-wording paraphrases sit at ~0.75–0.79, unrelated same-domain pairs at ~0.44–0.58 — and favors recall because a miss hides a provable conflict while a false suggestion costs one ignored glossary line. This is deliberately **lower** than the graph tier's `0.82` (`DEFAULT_GRAPH_THRESHOLD`, above): the paraphrase tier judges response-phrase synonymy and favors recall, while the graph tier judges whole-sentence relatedness and errs toward precision.
- Same-system scoping applies to the proposal too — two systems with identical wording are genuinely distinct atoms, so bridging across systems would be unsound; pairs already unified by `atomize` are skipped — `src/formal/semantic.ts:15`, `src/formal/semantic.ts:97`.
- **The committed glossary is the only thing the SMT path consults.** `atomize` canonicalizes a response through the glossary index **first** (before antonym unification), rewriting an agent-confirmed alias to its canonical phrasing so a paraphrased conflict becomes provable — `src/formal/atomize.ts:144`, `glossaryIndex` at `src/formal/atomize.ts:96`.
- This split is what preserves determinism: the fuzzy embedding step only proposes entries; the deterministic glossary lookup is what actually merges them, and it is a no-op byte-for-byte when no glossary is supplied — `src/formal/atomize.ts:80`, `src/core/schema.ts:317`.
- Glossary shape: a `canonical` phrase plus its synonymous `aliases`; lives in the committed document, defaults to `[]` — `src/core/schema.ts:325`, `src/core/schema.ts:341`.

---

## Validation & defaults

Schema is the single source of truth (Zod), composed from atomic field definitions — `src/core/schema.ts:212`, `RequirementSchema` at `src/core/schema.ts:277`.

- **Defaults at create time**: `priority='medium'`, `status='draft'`, `negated=false`, all four edge arrays `[]` — `src/core/schema.ts:285`, `src/core/changes.ts:110`. Enum domains: priorities `low|medium|high|critical` (`src/core/schema.ts:36`), statuses `draft|approved|implemented|verified` (`src/core/schema.ts:39`).
- **UUID minting**: every requirement gets a stable `randomUUID()` assigned once at creation and never reused — edges reference nodes by UUID so renames/reorders never break references — `src/core/doc.ts:54`, `src/core/schema.ts:163`.
- **Timestamps**: `createdAt`/`updatedAt` are ISO-8601 UTC set by the runtime (never the caller); `updatedAt` is refreshed on every accepted change — `src/core/schema.ts:260`, `src/core/changes.ts:76`.
- **The mutation path**: `applyChange` is the only sanctioned mutation; it validates against `ChangeSchema`, deep-clones the input (never mutates), and returns a new document — `src/core/changes.ts:74`.
- **Re-render gate (AC-1-6)**: an update to any of the five EARS structural slots re-renders `sentence`; a pure metadata update (priority/status/verificationMethod) does not — `src/core/changes.ts:153`.
- **Typed error conditions**: `CreateRequirement` on an existing id throws `ERR_DUPLICATE_ID`; nulling a non-nullable attr throws `ERR_NULL_REQUIRED` (only `preCondition`, `trigger`, `verificationMethod` are clearable) — `src/core/changes.ts:82`, `src/core/changes.ts:135`, `NULLABLE_ATTRS` at `src/core/schema.ts:61`.
- **Idempotent / defensive edge ops (AC-1-7)**: `AddRelationship` is a no-op when the edge exists (but a missing source still throws); `RemoveRelationship` and `DeleteRequirement` no-op on a missing edge/requirement — `src/core/changes.ts:174`, `src/core/changes.ts:187`, `src/core/changes.ts:202`.
- **Permissive writes, integrity as lint**: dangling edge targets are allowed at write time and surfaced later as `DanglingReference` findings by `symspec check`; the `derives` DAG must be acyclic (`CycleDetected`); nodes with no edges surface as `OrphanRequirement` — `src/core/schema.ts:182`, `src/core/analyze.ts:36`, `src/core/analyze.ts:71`, `src/core/analyze.ts:90`.
- **Document validation (AC-1-4)**: the whole on-disk document is validated by `RequirementsDocSchema` at load — a UUID-keyed record with an integer `schemaVersion` and optional glossary; malformed JSON is rejected before any command runs (`SCHEMA_VERSION = 2`) — `src/core/schema.ts:337`, `src/core/schema.ts:572`.


## See also

- [symspec · Module map](../architecture/module-map.md) — 12 shared source citations
- [symspec · Public API](../reference/public-api.md) — 10 shared source citations
- [symspec · Data flow](../architecture/data-flow.md) — 4 shared source citations
- [symspec · Component diagram](../diagrams/architecture/components.md) — 3 shared source citations
- [symspec · Impact analysis](impact-analysis.md) — 3 shared source citations
