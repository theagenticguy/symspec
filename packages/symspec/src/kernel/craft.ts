/**
 * THE AUTHORING-CRAFT CORPUS — how to author a sound spec, not merely which commands
 * exist (spec AC-A-6, donor AC-3-6).
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
 */

// ---------------------------------------------------------------------------
// The section shape
// ---------------------------------------------------------------------------

/**
 * One craft section — a heading, a body, and (optionally) the codes it teaches.
 *
 * `codes` is not decoration: `craft.test.ts` asserts every code named here exists in
 * the unified catalog, so a section cannot teach an agent to look for a code the tool
 * does not emit. That failure mode is exactly what `GTWR_R20_PURPOSE` did in the donor
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
 * The donor's surfaces taught the reactive loop — write, check, read the demotions,
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
   that react to the same event. Context groups are keyed on it.
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
 * The donor surfaces list the four relations in the `--relation` flag description and
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
