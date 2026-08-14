/**
 * THE AUTHORING-CRAFT CORPUS — how to author a sound spec, not merely which commands
 * exist (spec AC-A-6, v4 AC-3-6).
 *
 * ## The gap this closes, measured
 *
 * Donor spec 003 assessed both agent surfaces (the generated `AGENTS.md` and the
 * installed `SKILL.md`) as **~85% reference tables**: command rows, code rows, exit
 * codes, envelope shapes. Everything an agent needs to CALL symspec, and almost
 * nothing about how to write a requirement that survives contact with it. Named absent:
 * EARS pattern selection, vocabulary alignment BEFORE writing, `derive`/`satisfy`
 * decomposition, a worked multi-requirement example, and an anti-pattern catalog.
 *
 * That gap has a concrete cost visible in this repo's own history. The default failure
 * of a symspec document is not a false conflict — it is SILENCE: two requirements that
 * genuinely contradict each other never share an atom, so the solver never compares
 * them and `check` reports nothing. An agent that knows every flag and none of the
 * craft writes documents that pass. {@link WORKED_EXAMPLE} is that exact trap, measured
 * on this pipeline.
 *
 * ## Single-source, same discipline as everything else
 *
 * This module is the ONE place the craft prose lives. The installed skill body and the
 * generated `AGENTS.md` both render from {@link CRAFT_SECTIONS}; neither restates a
 * sentence. Drift is therefore unrepresentable rather than tested for, which is the
 * standing constraint the spec sets for every human- and agent-readable surface.
 *
 * ## Every claim is GROUNDED, and the grounding was measured, not recalled
 *
 * Each anti-pattern names the code that actually fires on its example, and each of
 * those pairings was verified by running the real detector rather than read off the
 * catalog description. Three of the pairings a reasonable author would have guessed are
 * WRONG, and they are recorded in {@link ANTI_PATTERNS} because the wrong guess is more
 * instructive than the right answer:
 *
 * - "respond quickly" fires NOTHING. `quickly`, `rapidly`, `promptly`, `efficiently`,
 *   and `easily` are all absent from both weasel lexicons; `fast`, `robust`, `timely`,
 *   `minimal`, `adequate`, and `flexible` fire. So the catalog is a LEXICON, not a
 *   semantic judgment, and an author who writes "quickly" gets silence.
 * - A compound requirement authored through `add` fires `GTWR_R19_COMBINATOR` (warn),
 *   not `GTWR_R18_MULTIPLE_SHALL` — R18 needs TWO `shall`s, and the common compound has
 *   one. The error-severity signal comes from the PARSE path instead
 *   (`ERR_PARSE_COMPOUND`), which is also the only path that hands back a mechanical
 *   split.
 * - `GTWR_R33_MISSING_TOLERANCE` fires on `within 500 ms` AND on `within 400 ms to
 *   600 ms` AND on `500 ms plus or minus 50 ms`. It is a prompt to state a tolerance,
 *   not a check that one is absent, so an author cannot silence it by adding a range.
 *
 * `craft.test.ts` re-runs every one of these against the live detectors, so a claim
 * that stops being true is a test failure rather than stale documentation — which is
 * the only way prose about a detector stays honest.
 *
 * ## The state-model section holds itself to the same standard (G5)
 *
 * {@link STATE_MODEL} teaches the reachability tier, and its four-step transcript
 * (prove → violate → fix → re-prove) was produced by running the built CLI on the real
 * hex-bonk `TX-C1` rather than composed. `craft.test.ts` re-runs the same document through
 * the real `check` operation and asserts the same four verdicts, including the two that are
 * inconvenient to teach:
 *
 * - TX-C1 proves `PROVED_UNDER_HYPOTHESES`, not `PROVED`. With more than one state variable
 *   the nothing-assumed run is essentially always reachable, so frame-closed proof is a
 *   property of single-variable models. Writing `PROVED` there would have read better and
 *   been false.
 * - An effect-free model reports `PROVED` **and** `FND_REACHABILITY_NOT_CHECKED` at once,
 *   because with no transitions the only reachable state is the initial one. Both are
 *   asserted, because the pair is the lesson — a proof over one state is not evidence about
 *   a running system.
 */

// ---------------------------------------------------------------------------
// The section shape
// ---------------------------------------------------------------------------

/**
 * One craft section — a heading, a body, and (optionally) the codes it teaches.
 *
 * `codes` is not decoration: `craft.test.ts` asserts every code named here exists in
 * the unified catalog, so a section cannot teach an agent to look for a code the tool
 * does not emit. That failure mode is exactly what `GTWR_R20_PURPOSE` did in v4
 * — it told authors to "move rationale to a separate attribute", a field that did not
 * exist.
 */
export interface CraftSection {
  /** Stable slug, used as the anchor in both rendered surfaces. */
  readonly id: string
  /** Heading text. */
  readonly title: string
  /** One-line summary, for a table-of-contents projection. */
  readonly summary: string
  /** The Markdown body. */
  readonly body: string
  /** Every stable code this section names. Verified to exist. */
  readonly codes: readonly string[]
}

// ---------------------------------------------------------------------------
// 1. EARS pattern selection — a decision procedure, not a table
// ---------------------------------------------------------------------------

/**
 * The five EARS patterns as a DECISION TREE over two questions.
 *
 * A table of five patterns is what both surfaces already had (the `patternType` field
 * description enumerates them). What was missing is the PROCEDURE: which one to pick,
 * decided by facts about the requirement rather than by taste. Two questions suffice
 * because the patterns partition exactly on them — is the behavior conditioned, and if
 * so is the condition an EVENT (instantaneous, fires once) or a STATE (holds over an
 * interval).
 *
 * The tree is worth more than the table because getting `patternType` wrong is not a
 * style error: the structural tier requires `trigger` for event-driven and
 * unwanted-behavior and `preCondition` for state-driven and optional-feature, so a
 * mis-chosen pattern produces `FND_MISSING_TRIGGER` or `FND_MISSING_PRECONDITION` at
 * ERROR severity — which then EXCLUDES the requirement from the formal tier, so it is
 * never cross-compared at all.
 */
const PATTERN_SELECTION: CraftSection = {
  id: 'ears-pattern-selection',
  title: 'Choosing an EARS pattern: a decision procedure',
  summary:
    'Two questions pick the pattern; a wrong pick is an error-severity finding, not a style nit.',
  codes: ['FND_MISSING_TRIGGER', 'FND_MISSING_PRECONDITION', 'GTWR_R1_PATTERN'],
  body: `Answer two questions in order. Do not choose by feel — the pattern determines
which slots are MANDATORY, and a wrong choice is an error-severity finding that
excludes the requirement from formal analysis entirely.

**Q1 — Is the behavior conditioned on anything?**

- **No** → \`ubiquitous\`. An invariant that always holds.
  *The scheduler shall retain the audit log for 90 days.*
- **Yes** → go to Q2.

**Q2 — Is the condition an EVENT (fires once, instantaneous) or a STATE (holds over an
interval)?**

- **Event, and the behavior is wanted** → \`event-driven\`. Requires \`trigger\`.
  *When the operator confirms the plan, the scheduler shall start the nightly run.*
- **Event, and the behavior handles a FAILURE or an unwanted condition** →
  \`unwanted-behavior\`. Requires \`trigger\`.
  *If the nightly run exceeds its window, then the scheduler shall page the on-call
  engineer.*
- **State, always active while it holds** → \`state-driven\`. Requires \`preCondition\`.
  *While maintenance mode is enabled, the scheduler shall reject new submissions.*
- **State, gating an OPTIONAL feature** → \`optional-feature\`. Requires
  \`preCondition\`.
  *Where the tenant has SSO configured, the auth service shall delegate
  authentication to the identity provider.*

**Why the event/state distinction is load-bearing.** \`trigger\` and \`preCondition\`
are not two names for the same slot — the formal tier groups requirements into context
groups by them, and only requirements in the SAME group are checked for contradiction.
Two requirements that conflict but land in different groups are never compared. Phrase a
trigger as a discrete event in the present tense ("the user submits valid credentials")
and a precondition as a state ("the tenant has SSO configured"), with no leading
"when"/"while"/"where"/"if" — the renderer adds those.

**The unwanted-behavior vs event-driven call.** Both require \`trigger\` and both are
structurally valid either way, so nothing will fail if you pick the wrong one. Choose
\`unwanted-behavior\` when the trigger is something you are trying to PREVENT or
RECOVER from; it renders "If …, then …", which is what a reviewer reads as error
handling.`,
}

// ---------------------------------------------------------------------------
// 2. Vocabulary alignment BEFORE writing — the glossary-first workflow
// ---------------------------------------------------------------------------

/**
 * The discipline that prevents demotions instead of discharging them.
 *
 * This is the single highest-value section, because it targets symspec's actual
 * failure mode. The tool's honest scope is that SILENCE IS NOT A CONSISTENCY
 * CERTIFICATE: paraphrases atomize to distinct atoms, so two genuinely contradictory
 * requirements phrased differently are never compared and `check` reports nothing.
 *
 * v4's surfaces taught the reactive loop — write, check, read the demotions,
 * commit the suggested `glossary add`. That works, and it is strictly more expensive
 * than deciding the vocabulary first: every misaligned pair costs a full `check` cycle
 * plus a review of a propose-only candidate that could have been avoided by using the
 * same words twice.
 */
const VOCABULARY_FIRST: CraftSection = {
  id: 'vocabulary-alignment-first',
  title: 'Align vocabulary BEFORE writing, not after checking',
  summary:
    'symspec fails by SILENCE, not false alarms. Decide the words first so conflicts become provable.',
  codes: [
    'FND_SIMILAR_SEMANTIC',
    'FND_SIMILAR_UNUNIFIED',
    'FND_OPPOSITION_CANDIDATE',
    'FND_QUANTITY_ALIAS_CANDIDATE',
    'FND_NO_PAIRS_CHECKED',
  ],
  body: `**The failure mode you are avoiding.** symspec is sound modulo atomization: every
conflict it reports is real, and a conflict it does NOT report may still exist. Two
requirements are only compared when they share an atom. So if one says "start the
nightly run" and another says "begin the batch job", they atomize to different things,
the solver never puts them in the same query, and \`check\` returns clean — even when
they contradict.

A clean \`check\` therefore means "no conflict was PROVEN", never "the spec is
consistent". \`data.residualRisk.unmatchedAtoms\` and \`data.progress.atomsUncompared\`
are the numbers that tell you how much went uncompared; \`FND_NO_PAIRS_CHECKED\` fires
when NOTHING was cross-compared at all.

**The workflow, in order:**

1. **Name the system once.** Every requirement about the same component uses the SAME
   \`systemName\` string. The candidate-pair filter skips pairs that span different
   systems outright, so "scheduler" vs "job scheduler" halves your coverage for free.
2. **Name each trigger once.** Copy the trigger string verbatim between requirements
   that react to the same event. Context groups are keyed on it, and the solver asserts
   one group at a time — so two requirements whose triggers are paraphrases are never
   live together and their responses are never compared at all. If you inherited a spec
   that already paraphrases its triggers, \`symspec propose-glossary\` reports the guard
   alignments under \`data.guardClasses\`, each naming in \`unlocks\` which requirements the
   alignment would make comparable. Those are SUGGESTIONS ONLY and never appear in
   \`data.ops\`: a wrong response merge merely hides a conflict, while a wrong guard merge
   asserts two different conditions are one and can prove a conflict the document does
   not contain. Read the pair; when the two guards are mutually exclusive, leaving them
   distinct is the correct answer, and no antonym op can help because antonyms apply to
   responses only.
3. **Fix one verb per action, and one noun per object.** Write a short list before you
   write requirements: start/stop, enqueue/dequeue, grant/revoke, open/close. Then use
   only those. Paraphrase is the enemy here, not repetition — a spec that reads
   repetitively is a spec whose conflicts are provable.
4. **Commit oppositions you rely on.** If the conflict you care about is
   "start" vs "halt", run \`symspec antonym add start halt\` so the atomizer collapses
   them to one atom at opposite polarity. Until you do, the solver sees two unrelated
   facts and proves nothing.
5. **Commit synonyms you could not avoid.** Where two teams genuinely use different
   words for one thing, \`symspec glossary add "<canonical>" "<alias>"\` unifies them.
6. **Only then \`check\`.** The propose-only tier will suggest what you missed
   (\`FND_SIMILAR_SEMANTIC\`, \`FND_OPPOSITION_CANDIDATE\`,
   \`FND_QUANTITY_ALIAS_CANDIDATE\`) — treat each as a gap in step 3, not as a chore.

**The one thing never to do mechanically.** An \`FND_OPPOSITION_CANDIDATE\` offers TWO
mutually exclusive remedies: \`antonym add\` if the verbs are opposites,
\`glossary add\` if they are synonyms. Committing the wrong one MANUFACTURES a false
contradiction, and embeddings cannot tell which is right because antonyms embed close
together. Read the pair and decide; the always-safe third option is a reviewed waiver
that records "I triaged this and it is not a conflict".`,
}

// ---------------------------------------------------------------------------
// 3. Decomposition — derives / satisfies / refines / verifies
// ---------------------------------------------------------------------------

/**
 * When to split a requirement and which edge to use.
 *
 * v4 surfaces list the four relations in the `--relation` flag description and
 * nowhere say which to reach for. That leaves the one structurally consequential
 * relation — `verifies` — undocumented in the place an author would look, even though
 * its absence on a leaf produces `FND_LEAF_UNVERIFIABLE`.
 */
const DECOMPOSITION: CraftSection = {
  id: 'decomposition',
  title: 'Decomposition: when to split, and which edge to use',
  summary: 'One obligation per requirement; the four relations answer four different questions.',
  codes: ['FND_LEAF_UNVERIFIABLE', 'FND_ORPHAN', 'FND_CYCLE', 'FND_DANGLING_REFERENCE'],
  body: `**Split when a requirement carries more than one obligation.** The test is
mechanical: if you cannot verify the requirement with a single pass/fail observation,
it is more than one requirement. "The checkout service shall reserve the inventory and
charge the payment method" needs two observations, so it is two requirements — and
\`symspec parse\` will hand you both as ready-to-apply ops rather than making you split
by hand.

**Do NOT split** to make a sentence shorter, or to separate a requirement from its
measurable bound. "respond within 500 ms" is one obligation.

**The four relations, each answering a different question:**

| Relation | Question it answers | Direction |
|---|---|---|
| \`refines\` | Is this the SAME obligation stated more precisely? | specific → general |
| \`derives\` | Does this obligation EXIST BECAUSE of that one? | child → parent |
| \`satisfies\` | Does this design decision DISCHARGE that need? | solution → need |
| \`verifies\` | Does this requirement establish that the other HOLDS? | test → claim |

**\`refines\` vs \`derives\` — the distinction that matters.** \`refines\` keeps ONE
obligation and adds precision, so the parent and child should share vocabulary and land
in the same context group (which means the solver can check them against each other —
a refinement that contradicts its parent is exactly the conflict you want proven).
\`derives\` introduces a NEW obligation that the parent motivated; parent and child are
different claims, and the solver treats them as such.

**\`verifies\` is the one with a structural consequence.** A leaf of the refinement DAG
— inbound \`refines\`/\`derives\`, no outbound — with no \`verifies\` edge produces
\`FND_LEAF_UNVERIFIABLE\` (warn): a leaf is where the work actually happens, so it must
be independently verifiable. Either link the requirement that verifies it, or set
\`verificationMethod\` (\`test\`/\`inspection\`/\`analysis\`/\`demonstration\`) and say
how in \`verificationNote\`.

**Two structural traps.** \`derives\`/\`refines\` must form a DAG —
\`FND_CYCLE\` (error) fires on a loop, and a cycle usually means two requirements each
claim to motivate the other, which is a modelling error rather than a typo. And a
requirement with no edges at all in a multi-requirement document is
\`FND_ORPHAN\` (warn): it may be legitimate, but it is worth asking why nothing relates
to it.`,
}

// ---------------------------------------------------------------------------
// 4. The anti-pattern catalog — every entry grounded in a code that FIRES
// ---------------------------------------------------------------------------

/**
 * One anti-pattern: the bad text, the fix, and the codes that ACTUALLY fire.
 *
 * `fires` is measured against the live detectors by `craft.test.ts`, not read off the
 * catalog. The distinction is the whole point of the type: a catalog description says
 * what a rule is FOR, and only running the detector says what it CATCHES.
 */
export interface AntiPattern {
  /** Short name, used as the row label. */
  readonly name: string
  /** The requirement text that exhibits it. */
  readonly bad: string
  /** A rewrite that does not. */
  readonly good: string
  /**
   * The codes this exact `bad` text provokes, in the order the detectors emit them.
   * VERIFIED against the live detectors, so an empty array would be a claim that
   * nothing fires — which for `vague-not-in-lexicon` is the honest and instructive
   * answer.
   */
  readonly fires: readonly string[]
  /** Why the rewrite is better, and what the codes do and do not tell you. */
  readonly note: string
}

/**
 * The anti-pattern catalog, grounded.
 *
 * Ordered so the two entries whose grounding CONTRADICTS the obvious guess come first
 * — a reader who stops after two rows still learns the thing most likely to mislead
 * them.
 */
export const ANTI_PATTERNS: readonly AntiPattern[] = [
  {
    name: 'Vague term the lexicon does NOT know',
    bad: 'When the request arrives, the api gateway shall respond quickly.',
    good: 'When the request arrives, the api gateway shall respond within 500 ms.',
    // MEASURED: nothing fires. `quickly` is absent from both weasel lexicons.
    fires: [],
    note: 'Fires NOTHING — and that is the most important row in this table. The vague-term check is a LEXICON, not a semantic judgment: `fast`, `robust`, `timely`, `minimal`, `adequate`, `flexible`, and `user-friendly` fire `GTWR_R7_VAGUE` at ERROR severity, while `quickly`, `rapidly`, `promptly`, `efficiently`, and `easily` fire nothing at all. Do not read a clean lint as "this requirement is measurable". Every performance claim needs a number and a unit, whether or not a rule catches its absence.',
  },
  {
    name: 'Compound requirement',
    bad: 'When the user submits the order, the checkout service shall reserve the inventory and charge the payment method.',
    good: 'When the user submits the order, the checkout service shall reserve the inventory.',
    // MEASURED via checkGtWRules on the authored sentence. NOT R18: that needs two
    // `shall`s, and the common compound has one.
    fires: ['GTWR_R15_LOGICAL_EXPR', 'GTWR_R19_COMBINATOR'],
    note: 'The lint signal is `GTWR_R19_COMBINATOR` at WARN — not `GTWR_R18_MULTIPLE_SHALL`, which needs two `shall`s and does not fire here. So a compound authored directly through `add` is only a warning, and warnings do not gate. Author through `symspec parse` instead: the parse path returns `ERR_PARSE_COMPOUND` AND hands back `proposedOps` with the split already computed, so `symspec apply` fixes it mechanically.',
  },
  {
    name: 'Passive voice hiding the actor',
    bad: 'When the batch completes, the report shall be generated.',
    good: 'When the batch completes, the reporting service shall generate the report.',
    fires: ['GTWR_R2_PASSIVE'],
    note: 'Passive voice does not say WHO is obligated, so nothing can be held responsible and no test can be written. It also costs coverage: the actor becomes the grammatical object, so `systemName` ends up as the artifact ("report") rather than the component, and requirements about the same component stop sharing a system — which makes them ineligible to be paired.',
  },
  {
    name: 'Bare number with no unit',
    bad: 'When the request arrives, the api gateway shall respond within 500.',
    good: 'When the request arrives, the api gateway shall respond within 500 ms.',
    fires: ['GTWR_R6_MISSING_UNITS'],
    note: '`GTWR_R6_MISSING_UNITS` is ERROR severity, which makes this the anti-pattern with the largest hidden cost: an error-severity lint finding EXCLUDES the requirement from the formal tier, so the requirement is never cross-compared and `data.verified` is demoted with an `excluded-from-formal` reason. A missing unit does not just fail a style check — it removes the requirement from the analysis.',
  },
  {
    name: 'Unit mixing across a set',
    bad: 'When the request arrives, the api gateway shall respond within 1.5 seconds.',
    good: 'When the request arrives, the api gateway shall respond within 1500 ms.',
    // Fires nothing on its OWN; the set-level rule needs a second requirement at a
    // different precision. Recorded honestly rather than claimed.
    fires: ['GTWR_R33_MISSING_TOLERANCE'],
    note: 'This sentence alone fires only the tolerance prompt. Unit and precision consistency is a SET-level property: `GTWR_R40_DECIMAL_FORMAT` (info) fires only once a second requirement uses a different number of fractional digits, so it cannot be seen by checking one requirement at a time. Pick one unit per quantity across the whole document, because the numeric tier compares bounds only after unit normalization — and two bounds on what you think is one quantity may land on different quantity keys, which surfaces as `FND_QUANTITY_ALIAS_CANDIDATE` rather than as the conflict you were looking for.',
  },
  {
    name: 'Tolerance-free quantity',
    bad: 'The pump shall deliver 30 ml per hour.',
    good: 'The pump shall deliver 30 ml per hour plus or minus 2 ml per hour.',
    fires: ['GTWR_R33_MISSING_TOLERANCE'],
    note: 'A WARN prompt, and one you cannot silence by adding a range: `GTWR_R33_MISSING_TOLERANCE` also fires on "within 400 ms to 600 ms" and on "500 ms plus or minus 50 ms" (measured). It is a prompt to state a tolerance, not a check that one is missing, so treat it as a question to answer in review rather than a finding to drive to zero.',
  },
  {
    name: 'Unachievable absolute',
    bad: 'The scheduler shall always enqueue the job.',
    good: 'When the operator confirms the plan, the scheduler shall enqueue the job.',
    fires: ['GTWR_R26_ABSOLUTE'],
    note: 'ERROR severity on a BARE absolute, and WARN when a conditional clause qualifies it — the severity is decided per finding, not per code. That is also the fix: an absolute is usually a missing trigger or precondition. Replacing "always" with the condition under which the behavior is actually required makes the requirement both achievable and eligible for a context group.',
  },
  {
    name: 'Universal quantifier where "each" is meant',
    bad: 'The scheduler shall validate all inputs.',
    good: 'The scheduler shall validate each input.',
    fires: ['GTWR_R26_ABSOLUTE', 'GTWR_R32_UNIVERSAL'],
    note: '"all inputs" reads as a single aggregate obligation ("validate the set"), where "each input" reads as one obligation per element — a different claim, and the one usually intended. Note it fires BOTH `GTWR_R32_UNIVERSAL` and `GTWR_R26_ABSOLUTE`, because "all" is in the absolutes lexicon too.',
  },
  {
    name: 'Escape clause',
    bad: 'The scheduler shall retry the job where possible.',
    good: 'When a transient error occurs, the scheduler shall retry the job up to 3 times.',
    fires: ['GTWR_R8_ESCAPE'],
    note: 'ERROR severity, and correctly so: "where possible" makes the requirement unfalsifiable — no observation can violate it, so no test can verify it. The fix is to state the condition that makes the behavior required, which is usually what "where possible" was standing in for.',
  },
  {
    name: 'Open-ended list',
    bad: 'The scheduler shall log the errors, etc.',
    good: 'The scheduler shall log the error code, the job id, and the retry count.',
    fires: ['GTWR_R9_OPEN_ENDED'],
    note: 'ERROR severity. "etc." and "including but not limited to" leave the obligation unbounded, so it can never be shown complete. Enumerate, or split into one requirement per item.',
  },
  {
    name: 'Pronoun with an unclear referent',
    bad: 'When the job fails, the scheduler shall retry it.',
    good: 'When the job fails, the scheduler shall retry the job.',
    fires: ['GTWR_R24_PRONOUN'],
    note: 'A WARN, and the coverage cost is the real reason to care: "it" is not an atom the way "the job" is, so a pronoun weakens the vocabulary the solver matches on. Repetition reads worse and proves more.',
  },
  {
    name: 'Purpose phrase inside the requirement',
    bad: 'The scheduler shall enqueue the job in order to balance the load.',
    good: 'The scheduler shall enqueue the job.',
    fires: ['GTWR_R20_PURPOSE'],
    note: 'The rationale is not part of the obligation, and mixing it in makes the requirement look like it has two clauses. Keep the statement to the obligation and record the reasoning in `verificationNote` or in the parent requirement the `derives` edge points at.',
  },
  {
    name: 'Superfluous infinitive',
    bad: 'The scheduler shall be able to enqueue the job.',
    good: 'The scheduler shall enqueue the job.',
    fires: ['GTWR_R10_SUPERFLUOUS_INFINITIVE'],
    note: '"shall be able to" states a CAPABILITY, not an obligation — a system can be able to do something and never do it, so the requirement is satisfied by inaction. Drop the infinitive and the obligation becomes testable.',
  },
  {
    name: 'Oblique "and/or"',
    bad: 'The scheduler shall enqueue and/or defer the job.',
    good: 'When the queue has capacity, the scheduler shall enqueue the job.',
    fires: ['GTWR_R17_OBLIQUE', 'GTWR_R19_COMBINATOR'],
    note: '"and/or" is three requirements in one ambiguous phrase, and it also fires `FND_AMBIGUOUS_QUANTIFIER` at the ambiguity tier when the coordination is un-parenthesized. Say which condition selects which behavior; that is the information "and/or" is hiding.',
  },
  {
    name: 'Negated obligation',
    bad: 'The scheduler shall not enqueue the job.',
    good: 'While the queue is full, the scheduler shall reject the job.',
    fires: ['GTWR_R16_NEGATION'],
    note: 'A WARN with a legitimate-exception downgrade, so this is a judgment call rather than a rule. But a negative obligation is hard to verify (you must observe the absence of a behavior forever) and it is usually a positive obligation about a different condition. When you do need the negation, `negated: true` on the requirement records it as a FLAG the atomizer understands, which is strictly better than burying "not" in the response text where it becomes part of the atom.',
  },
] as const

/** The anti-pattern catalog rendered as the section both surfaces show. */
const ANTI_PATTERN_SECTION: CraftSection = {
  id: 'anti-patterns',
  title: 'Anti-patterns, and the code each one actually fires',
  summary:
    'Fifteen requirement smells with the measured code for each — including one that fires nothing.',
  codes: [...new Set(ANTI_PATTERNS.flatMap((p) => p.fires))],
  body: `Every row below was measured against the live detectors, not read off a rule
description. Three of them contradict the obvious guess, and those are the useful ones.

${ANTI_PATTERNS.map(
  (p) => `### ${p.name}

- **Avoid:** ${p.bad}
- **Prefer:** ${p.good}
- **Fires:** ${p.fires.length === 0 ? '_nothing_' : p.fires.map((c) => `\`${c}\``).join(', ')}

${p.note}`,
).join('\n\n')}

**The severity rule that governs all of these.** Only ERROR-severity findings gate the
exit code — and an error-severity lint finding also EXCLUDES its requirement from the
formal tier, so it costs you analysis coverage on top of the failed check. GtWR severity
is decided PER FINDING, not per code: the same rule can be \`error\` on a bare phrase and
\`warn\` when a conditional clause qualifies it. Read each finding's own \`severity\`
field rather than assuming a code's severity from its name.`,
}

// ---------------------------------------------------------------------------
// 5. The worked example — one loop, real ops, measured outcomes
// ---------------------------------------------------------------------------

/**
 * The worked multi-requirement example, MEASURED on this pipeline.
 *
 * Every number and code in this section was produced by running the real operations
 * against a real Z3 boot; `craft.test.ts` re-runs the same sequence and asserts the
 * same outcomes, so the example cannot rot into a plausible-looking fiction.
 *
 * The example is deliberately the SILENCE trap rather than a lint fix, because that is
 * what an author actually gets wrong. Step 1 produces a document that looks perfect —
 * `verified: true`, zero findings, exit 0 — and contains a flat contradiction. The only
 * visible tell is `progress.atomsUncompared: 2`.
 */
const WORKED_EXAMPLE: CraftSection = {
  id: 'worked-example',
  title: 'A worked example: the silent contradiction, and the loop that finds it',
  summary:
    'Two requirements that contradict each other, a clean check, and the one op that makes the conflict provable.',
  codes: ['FND_CONTRADICTION'],
  body: `Measured on this build. The point of the example is that **step 1 looks
perfect and is wrong.**

**Step 1 — author two requirements that contradict each other.**

\`\`\`bash
symspec init ./requirements.json
cat > plan.jsonl <<'OPS'
{"op":"add","patternType":"event-driven","trigger":"the operator confirms the plan","systemName":"scheduler","systemResponse":"start the nightly run"}
{"op":"add","patternType":"event-driven","trigger":"the operator confirms the plan","systemName":"scheduler","systemResponse":"halt the nightly run"}
OPS
symspec apply --ops plan.jsonl
symspec check
\`\`\`

Result:

\`\`\`
verified: true    findings: 0    counts.error: 0    exit 0
pairsChecked: 1   progress.atomsUncompared: 2
\`\`\`

The document says the scheduler shall both start and halt the same run on the same
trigger, and \`check\` is **clean**. Nothing is broken — this is the soundness boundary
working as designed. "start" and "halt" are two unrelated atoms, so the solver had
nothing to contradict. The only signal is \`atomsUncompared: 2\`: two atoms had no
cross-requirement partner.

**Step 2 — commit the opposition, so the solver can SEE it.**

\`\`\`bash
echo '{"op":"antonym","a":"start","b":"halt"}' | symspec apply --ops /dev/stdin
symspec check
\`\`\`

Result:

\`\`\`
verified: true    findings: 1    counts.error: 1    exit 1
FND_CONTRADICTION (error) — names BOTH requirement ids, with the unsat core as evidence
progress.atomsUncompared: 0    progress.openFindings: 1
\`\`\`

**What changed, and what did not.** The document is byte-identical apart from one
antonym entry. No requirement was edited. The conflict was always there; committing the
vocabulary is what made it PROVABLE. \`atomsUncompared\` fell from 2 to 0 because the
two responses now collapse to one atom at opposite polarity.

**Read \`verified\` correctly.** It is \`true\` in BOTH runs, and that is not a bug —
\`verified\` answers "was consistency actually CHECKED", not "is the document clean". A
proven contradiction is the strongest evidence the decide tier ran. What says the
document is bad is \`counts.error\` and the exit code, which went 0 → 1.

**The loop, generalized.**

1. \`symspec check --strict\` — exit 3 means "I could not verify this".
2. Read \`data.coverage.demotions\`; each carries \`repair.ops\` (apply-ready) and
   \`repair.commands\` (runnable). No placeholders.
3. Apply: \`symspec check --field data.coverage.demotions\` → extract the ops →
   \`symspec apply\`.
4. Re-check. \`data.progress\` is the gradient — \`demotions\`, \`openFindings\`, and
   \`atomsUncompared\` all reaching zero is the fixed point. If none of the three moved,
   the last batch did nothing and you need a different repair.
5. Fix the error-severity findings the run reports. Each one you fix also widens formal
   coverage, because an error-severity lint finding excludes its requirement from the
   solver.`,
}

// ---------------------------------------------------------------------------
// 6. The state model — the authoring craft for the unbounded reachability tier
// ---------------------------------------------------------------------------

/**
 * How to AUTHOR a state model, measured on this build (G5, the G4 tier's craft half).
 *
 * ## Why this section is not "here are three commands"
 *
 * `state`, `state-initial`, and `classify` are in the manifest with their full flag
 * documentation, so a reference table here would be the duplication the thin-pointer rule
 * forbids. What the manifest cannot say is the DECISION PROCEDURE: which requirements
 * deserve a state variable at all, how to tell an effect from a constraint when the prose
 * reads like both, and what `frame` actually costs you.
 *
 * ## The V16 rationale, in plain language
 *
 * The one genuinely subtle thing in the whole tier is `frame`, and the reason it is subtle
 * is a MEASUREMENT rather than a design taste. On a 3-variable model whose `alarm` is
 * written by NO requirement, `frame: stable` returns UNREACHABLE *with an inductive
 * invariant* while nothing-assumed returns REACHABLE — and `alarm` is genuinely reachable.
 * So under a frame the solver proves a FALSE answer and hands back a certificate for it.
 * That is why `volatile` is the default and why declaring `stable` shows up in the output
 * as a named hypothesis rather than as a stronger proof.
 *
 * The section says that without the hazard numbering, because an author does not need to
 * know it is called V16 — they need to know that a frame declaration is a claim about
 * their system that the tool will hold them to.
 *
 * ## Every transcript below is REAL
 *
 * The four steps (prove → violate → fix → re-prove) were run against the built CLI on the
 * real hex-bonk `TX-C1`, and `craft.test.ts` re-runs the same document through the real
 * `check` operation and asserts the same four verdicts. The numbers in the section are the
 * numbers that came back, including the ones that are inconvenient — TX-C1 proves
 * PROVED_UNDER_HYPOTHESES rather than frame-closed, because with two state variables the
 * nothing-assumed run is essentially always reachable. Writing `PROVED` there would have
 * been a nicer story and a fiction.
 */
const STATE_MODEL: CraftSection = {
  id: 'state-model',
  title: 'Authoring a state model, so `check` can prove your invariants',
  summary:
    'Declare variables, classify responses as effect-or-constraint, choose a frame — and read PROVED_UNDER_HYPOTHESES correctly.',
  codes: [
    'FND_REACHABILITY_PROVED',
    'FND_REACHABILITY_UNDER_HYPOTHESES',
    'FND_REACHABILITY_VIOLATED',
    'FND_REACHABILITY_UNKNOWN',
    'FND_REACHABILITY_NOT_CHECKED',
  ],
  body: `The tiers in the sections above compare requirements against EACH OTHER. A state
model buys something different: \`check\` proves your invariants over **every reachable
state of the system your requirements describe**, with no bound on how many steps it takes
to get there — and when an invariant is violable, it hands back the exact sequence of your
own requirements that violates it.

That is the capability. It is off until you author it, and it discloses its own absence:
a document with no state model gets \`FND_REACHABILITY_NOT_CHECKED\` rather than silence,
because a question never asked reads exactly like a question answered cleanly.

### When to declare a state variable

Not for every noun. Declare a variable when **two or more requirements disagree about the
same piece of mutable system state, and no single requirement contains the disagreement.**
That is the defect class this tier finds and the other tiers structurally cannot: the
contradiction is not between two sentences, it is in the ORDER the sentences allow.

The mechanical test, in order:

1. **Is there something the system REMEMBERS between events?** A lock that is held or free,
   a run that is pending or running, a retry counter. If every requirement is a pure
   input→output rule with no memory, there is no state model to write and the propositional
   tiers already cover you.
2. **Do at least two requirements CHANGE it?** One writer is not an ordering problem. The
   interesting models have an acquire and a release, an enqueue and a dequeue, a start and a
   timeout.
3. **Is there something you believe is always true of it?** "At most one holder." "The
   counter never exceeds the limit." "Nothing waits on a free lock." If you cannot state
   such a sentence, you have a state model with nothing to prove.

If all three hold, declare it. If only 1 and 2 hold, the model will run and prove nothing —
you will get \`FND_REACHABILITY_NOT_CHECKED\` telling you no requirement carries a
constraint, which is the honest report.

**Keep it small, and keep the integers bounded.** \`--type int --min 0 --max 3\` is a
finite-domain variable, which is what lets a query be DECIDED rather than merely attempted.
An unbounded integer is where \`FND_REACHABILITY_UNKNOWN\` with reason \`undecidable\`
comes from, and its remedy is to bound the domain — more time will not help.

### Effect or constraint: the classification procedure

Every classified response is exactly one of two things, and the prose will not tell you
which — the same sentence can read as either. Ask **does this response CHANGE the state, or
RESTRICT it?**

| | \`effect\` | \`constraint\` |
|---|---|---|
| What it is | a TRANSITION the system may take | a PREDICATE that must hold in every reachable state |
| Expression | \`when <guard>: <var> := <value>\` | a boolean predicate over the variables |
| What the tier does with it | builds the transition relation | tries to VIOLATE it |
| Assignment vs comparison | \`:=\` assigns | \`=\` compares |

The reliable discriminator: **an effect names a moment, a constraint names a forever.** If
you can point at the event during which the response happens, it is an effect. If the
response is a property you would check at any instant, it is a constraint.

Two consequences worth knowing before you classify:

- **A requirement classified \`effect\` with no guard fires from EVERY state.** That is the
  sound default — it admits more transitions, so it proves strictly less — but it is almost
  never what a triggered requirement means. **The guard is what an EARS trigger means
  formally**, and you write it explicitly because the tool will not guess it from your
  prose \`trigger\` slot: guessing would make the solver prove the wrong thing confidently.
  So an \`event-driven\` requirement whose trigger is "an agent worker claims a run" gets a
  guard like \`when held = 0\`, expressing the same condition over declared variables.
- **Every name in every expression must already be declared.** \`classify\` refuses an
  undeclared reference at authoring time — measured: \`"held" is not a declared state
  variable\` at \`ERR_USAGE\` — rather than accepting it. That refusal is load-bearing:
  reaching the Horn encoder, an undeclared name produces an UNKILLABLE solver hang, not an
  error message. The same rule blocks \`state --remove\` on a variable expressions still
  reference, and names the requirements that reference it.

### The declared-vars-only rule

**The state model is a CLOSED vocabulary.** The only names an expression may use are the
ones \`symspec state\` declared, plus integer literals, \`true\`/\`false\`, and the enum
members you listed in \`--domain\`. There is no implicit variable, no inferred type, and no
name that springs into existence by being written.

That is stricter than it needs to be for the encoder and exactly as strict as it needs to be
for you: a typo'd variable in a constraint would otherwise become a fresh unconstrained
variable, the predicate would be trivially satisfiable, and the tool would report a proof of
something you did not write. Declared-vars-only converts that into a usage error you fix in
one command.

The grammar the expressions live in is small on purpose: comparisons
(\`= != < <= > >=\`), \`+\` and \`-\` on ints, \`and\`/\`or\`/\`not\`, parentheses. **No
multiplication** (it makes the transition relation nonlinear, where an unbounded solver hang
was measured), no quantifiers, no chained comparisons — write \`a < b and b < c\`. And
\`< <= > >=\` are INTEGER-ONLY, because an enum has a declared domain, not an order.

### Choosing a frame, per variable

\`--frame\` answers one question about ONE variable: **does it persist across a step that
does not write it?**

- **\`volatile\` (the default)** — it may change freely in any step. Nothing is assumed.
- **\`stable\`** — it changes ONLY when some requirement's effect changes it.

\`stable\` is the stronger assumption and it is a claim about your system that the document
does not otherwise make. Here is why the default runs the other way, measured: on a model
whose \`alarm\` variable is written by NO requirement, the framed run returns UNREACHABLE
**with an inductive invariant** while the nothing-assumed run returns REACHABLE — and
\`alarm\` is genuinely reachable. Under the frame the solver proves a false answer and hands
back a certificate for it. A frame-by-default tool would therefore certify fictions, so
\`volatile\` is the default and the safe direction is the one that proves less.

What that means in practice is the verdict you will actually see most often:

- **\`FND_REACHABILITY_PROVED\`** — proved with nothing assumed. Frame-closed, and the
  strongest thing the tier says. Realistically a property of single-variable models.
- **\`FND_REACHABILITY_UNDER_HYPOTHESES\`** — proved only once the unwritten variables are
  held fixed. The message NAMES the variables relied upon together with the requirements
  that write them, says **THE DOCUMENT DOES NOT STATE THAT**, and DEMOTES \`verified\`. With
  more than one state variable this is the honest common outcome, not a failure.

So do not chase \`PROVED\`. Declaring everything \`stable\` does not upgrade the verdict —
it TIGHTENS the disclosed hypothesis, because the tier re-runs with your declared set and
names exactly what you wrote down instead of all N variables. The discharge is to author the
requirements that justify the assumption, which is spec work rather than a flag.

### The worked example: the real TX-C1, proved and then broken

Measured on the built CLI, on the hex-bonk \`agent-run-triggers\` production requirement:

> **TX-C1** — The run service shall assign runs that share a conversation the Procrastinate
> lock keyed on the conversation id so they execute sequentially.

That is a mutual-exclusion invariant. Two variables and three effects express the lock's
lifecycle.

**Step 1 — declare, classify, and PROVE.**

\`\`\`bash
symspec init ./requirements.json
cat > plan.jsonl <<'OPS'
{"op":"state","name":"held","type":"int","min":0,"max":3,"initial":"held = 0"}
{"op":"state","name":"queued","type":"bool","initial":"queued = false"}
{"op":"add","key":"TX-A1","patternType":"event-driven","trigger":"an agent worker claims a run","systemName":"run service","systemResponse":"acquire the conversation lock"}
{"op":"add","key":"TX-A2","patternType":"event-driven","trigger":"a run reaches a terminal state","systemName":"run service","systemResponse":"release the conversation lock"}
{"op":"add","key":"TX-A3","patternType":"event-driven","trigger":"a run for a locked conversation is queued","systemName":"run service","systemResponse":"mark the run waiting"}
{"op":"add","key":"TX-C1","patternType":"ubiquitous","systemName":"run service","systemResponse":"hold at most one conversation lock at a time"}
{"op":"classify","ref":"TX-A1","kind":"effect","expression":"when held = 0: held := held + 1, queued := false"}
{"op":"classify","ref":"TX-A2","kind":"effect","expression":"when held = 1: held := held - 1"}
{"op":"classify","ref":"TX-A3","kind":"effect","expression":"when held = 1: queued := true"}
{"op":"classify","ref":"TX-C1","kind":"constraint","expression":"held <= 1"}
OPS
symspec apply --ops plan.jsonl
symspec check --field data.reachability
\`\`\`

\`\`\`json
{"variables":2,"effects":3,"constraints":1,"proved":0,
 "provedUnderHypotheses":1,"violated":0,"unknown":0,"elapsedMs":337,"timeoutMs":2000}
\`\`\`

TX-C1 holds — and the verdict is \`PROVED_UNDER_HYPOTHESES\`, not \`PROVED\`, exactly as
the frame section predicts. The finding says so and names the hypothesis:

\`\`\`
TX-C1: PROVED_UNDER_HYPOTHESES — no reachable state violates this constraint, ASSUMING
these variables change only when a requirement changes them: held (written by TX-A1,
TX-A2); queued (written by TX-A1, TX-A3). THE DOCUMENT DOES NOT STATE THAT.
\`\`\`

**Step 2 — add a second invariant that sounds obviously true, and watch it FAIL.**

\`\`\`bash
symspec add --key TX-C2 --pattern-type ubiquitous --system-name "run service" \\
  --system-response "hold the waiting flag only while the conversation lock is held"
symspec classify TX-C2 --kind constraint --expression "not (queued and held = 0)"
symspec check --field data.reachability
\`\`\`

\`\`\`json
{"variables":2,"effects":3,"constraints":2,"proved":0,
 "provedUnderHypotheses":1,"violated":1,"unknown":0,"elapsedMs":537,"timeoutMs":2000}
\`\`\`

Exit **1**, through the existing contract — the error-severity finding lands in
\`counts.error\`, so nothing about the exit mapping had to learn about reachability. And the
finding hands back the path:

\`\`\`
TX-C2: a reachable state VIOLATES this constraint. The solver reached it by firing:
init -> TX-A1 -> TX-A3 -> TX-A2 -> TX-C2. Proven over all reachable states with no bound.
\`\`\`

Read that trace as a sentence about your own document: acquire the lock (TX-A1), a second
run queues behind it (TX-A3), the first run finishes and releases (TX-A2) — and now a run is
waiting on a free lock. **"Nothing waits for a free lock" is FALSE of the system as
specified**, and it is false for an ordering reason no single requirement contains. This is
the defect class a spec review misses.

**Step 3 — fix the REQUIREMENT, not the constraint.**

The temptation is to weaken TX-C2 until it passes. The trace says otherwise: the fault is
that TX-A2 releases the lock without clearing the waiting flag.

\`\`\`bash
symspec classify TX-A2 --kind effect \\
  --expression "when held = 1: held := held - 1, queued := false"
symspec check --field data.reachability
\`\`\`

\`\`\`json
{"variables":2,"effects":3,"constraints":2,"proved":0,
 "provedUnderHypotheses":2,"violated":0,"unknown":0,"elapsedMs":350,"timeoutMs":2000}
\`\`\`

Exit **0**. Both invariants now hold, and the change was to the requirement the trace
blamed. That is what makes the report a work list rather than a verdict: \`violated\` fell
1 → 0 and \`provedUnderHypotheses\` rose 1 → 2, so the gradient moved in the direction the
repair intended.

### Reading the other two verdicts

- **\`FND_REACHABILITY_UNKNOWN\`** — the solver did not decide, so NOTHING is claimed and
  \`verified\` demotes. The message states which of two causes applies, because they need
  opposite remedies and the solver cannot be asked: a timed-out Spacer query reports its
  reason as the literal string \`"ok"\`, so the distinction is derived from measured elapsed
  time against the budget. Budget exhaustion → raise \`--reachability-timeout-ms\` (this
  tier's own per-query bound, which inherits \`--timeout-ms\` when absent). Genuine
  undecidability → bound the integer domains; more time will not help.
- **\`FND_REACHABILITY_NOT_CHECKED\`** — a coverage DISCLOSURE, not a defect. It fires when
  no state model is committed, when variables are declared but nothing is classified, and —
  the one worth watching for — when **the model admits no transitions at all**, i.e. no
  requirement is classified \`effect\`. Measured on a document with one variable and one
  constraint and zero effects: the constraint reports \`PROVED\` **and** the disclosure
  fires, because with no transitions the only reachable state is the initial one and an
  invariant that holds there holds almost vacuously. A \`PROVED\` on an effect-free model is
  not evidence about a running system, and the disclosure is what stops you reading it as
  one.`,
}

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

/**
 * Every craft section, in the order an author meets them: pick the pattern, align the
 * vocabulary, decompose, avoid the smells, then see the whole loop worked through.
 *
 * Both rendered surfaces iterate THIS array. Adding a section makes it appear in the
 * skill body and in `AGENTS.md` with no other edit — the same property the operations
 * table gives the CLI.
 */
export const CRAFT_SECTIONS: readonly CraftSection[] = [
  PATTERN_SELECTION,
  VOCABULARY_FIRST,
  DECOMPOSITION,
  ANTI_PATTERN_SECTION,
  WORKED_EXAMPLE,
  // LAST, and the position is a claim about the reading order rather than an append. The
  // state model is the only optional half of the tool: an author who never declares a
  // variable still gets every tier above, while an author who starts here without the
  // vocabulary discipline has a document whose reachability proofs are about requirements
  // the propositional tiers never compared. Craft before capability.
  STATE_MODEL,
] as const

/** Every code any craft section names, deduplicated. Asserted to exist in the
 * catalog, so no section can teach a code the tool does not emit. */
export const craftCodes = (): readonly string[] => [
  ...new Set(CRAFT_SECTIONS.flatMap((s) => s.codes)),
]

/**
 * Render the craft corpus as a Markdown section body, at a caller-chosen heading depth.
 *
 * `depth` exists because the two consumers nest differently: the installed skill body
 * puts craft under an `##` heading, while `AGENTS.md` puts it under `##` with `###`
 * subsections. Passing the depth in — rather than post-processing the string — keeps the
 * heading levels correct in both without either surface rewriting the other's output.
 */
export const renderCraft = (depth: 2 | 3 = 2): string => {
  const h = '#'.repeat(depth)
  const sub = '#'.repeat(depth + 1)
  return CRAFT_SECTIONS.map((section) => {
    // The anti-pattern body carries its own `###` sub-headings; shift them to sit one
    // level under whatever depth the caller asked for.
    const body = section.body.replace(/^### /gm, `${sub} `)
    return `${h} ${section.title}\n\n${body}`
  }).join('\n\n')
}

/** A one-line-per-section table of contents, for a surface that wants a summary. */
export const craftContents = (): readonly { readonly title: string; readonly summary: string }[] =>
  CRAFT_SECTIONS.map((s) => ({ title: s.title, summary: s.summary }))
