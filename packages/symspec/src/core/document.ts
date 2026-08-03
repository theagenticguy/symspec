/**
 * DOCUMENT FORMAT v3 — the on-disk requirements document, as an Effect Schema.
 *
 * ## What changed from v2, and why there is no read-compat
 *
 * v2 (the donor's `src/core/schema.ts`, Zod) is a `schemaVersion: 2` object with
 * a UUID-keyed requirements map, four typed edge arrays per requirement, and
 * three side tables (glossary / antonyms / waivers). v3 keeps every one of those
 * — the semantics of a requirements document did not change — and adds the two
 * things v2 could only bolt on afterwards:
 *
 * 1. **{@link StateModel}** — declared state variables, first-class from day one.
 *    Donor spec 003's Wave 2 needed these for the Spacer reachability chain and
 *    had to retrofit them onto a `z.object` in strip mode. Retrofitting is
 *    exactly how V27 happened (see below).
 * 2. **`responseKind`** on every requirement — `'effect' | 'constraint'`, the
 *    authoring-time classification the reachability encoder needs to know whether
 *    a response is a state TRANSITION or an INVARIANT. OPTIONAL at authoring, so
 *    a v3 document without it is fully valid; but the FIELD exists in the schema
 *    from the first commit, so supplying one later is data entry rather than a
 *    format migration.
 *
 * The version tag is renamed `docVersion` (not `schemaVersion`) on purpose: a v2
 * file and a v3 file are then distinguishable by KEY, not just by value, so a v2
 * document handed to v5 fails with a precise, actionable error instead of being
 * misread as "v3 with a wrong version number". The migration path is one-shot:
 * `symspec-v4 <cmd> <v2doc>` on a bumped version emits the reproduce op stream,
 * and `symspec import` consumes it (see `../operations/import.ts`).
 *
 * ## THE V27 LESSON — unknown top-level keys are DISCLOSED, never stripped
 *
 * Donor finding V27 (spec 003, verified): `RequirementsDocSchema` was a plain
 * `z.object`, i.e. Zod's default STRIP mode, and every mutation round-tripped
 * through `safeParse` and wrote the stripped result back. Measured consequence: a
 * document carrying a `stateModel` key loaded and checked fine, but after ONE
 * `symspec add` the key was GONE — no error, no warning, no finding. Forward
 * compatibility was read-only, and because a reachability proof is CONDITIONAL on
 * the state model, the next `check` silently fell back to "no state model" and
 * demoted with the cause invisible.
 *
 * The donor's own recommendation, adopted here verbatim, is that all three of the
 * obvious options are wrong:
 *
 * - STRIP (Zod default / `onExcessProperty: 'ignore'`) — the V27 defect itself.
 * - PASSTHROUGH (`onExcessProperty: 'preserve'`) — round-trips UNVALIDATED data
 *   into a file the formal tier reads. A typo'd `requirments` key would persist
 *   forever, looking authoritative.
 * - STRICT (`onExcessProperty: 'error'`) — breaks the forward-read compatibility
 *   that works today: a document written by a NEWER symspec becomes unreadable
 *   by an older one, for a key the older one does not even need.
 *
 * So {@link decodeDocument} does the fourth thing: it decodes STRICTLY (so a
 * misspelled key inside a requirement, an unknown edge relation, or a bad enum
 * value is still a hard failure) while treating unknown TOP-LEVEL keys as a
 * separate, deliberate channel — {@link DocumentDiagnostic}s at `info` grade,
 * carried on the load result and preserved on the document value so a save
 * writes them back. Never silently dropped, never a hard failure.
 *
 * The scope is deliberately TOP-LEVEL ONLY. A top-level key is the granularity at
 * which a future symspec adds a whole new table (`stateModel` was exactly that
 * shape), and preserving one costs nothing because no existing code reads it. An
 * unknown key INSIDE a requirement is a different animal: requirements are what
 * the formal tier encodes, so an unrecognized field there is far more likely a
 * typo than a forward-compat table, and letting it through would mean the
 * atomizer silently ignoring data an author believed was load-bearing.
 *
 * ## Every field carries a `description`
 *
 * The manifest, `--help`, and the generated agent docs (G5) are all projections
 * of these annotations — there is no second corpus of prose. `defineOperation`
 * throws at construction time on a field with no reachable description, so the
 * discipline is enforced rather than merely intended.
 *
 * ## Two beta.102 traps this module works around
 *
 * - `Schema.Record(uuidSchema, …)` SILENTLY DROPS entries whose key fails the key
 *   schema — even with `{onExcessProperty:'error', errors:'all'}` (probed). A
 *   requirements map keyed by a mistyped UUID would decode to a document that is
 *   simply MISSING that requirement, with no error. {@link RequirementsMap}
 *   therefore keys on `Schema.String` and enforces UUID-ness with
 *   `Schema.isPropertyNames(Uuid)`, which FAILS loudly. See the module note there.
 * - `.annotate({default})` applied AFTER `withDecodingDefaultKey` does not reach
 *   the JSON Schema; it must sit on the INNER schema (probed). {@link withDefault}
 *   encapsulates the correct order so no field site can get it wrong.
 */

import { Effect, Schema } from 'effect'
import { renderSentence } from './render.ts'

// ---------------------------------------------------------------------------
// The version tag
// ---------------------------------------------------------------------------

/**
 * The current document-format version. A document declaring anything else is an
 * `ERR_SCHEMA_VERSION` failure carrying the migration path, never a silent
 * best-effort read.
 *
 * DISTINCT from both the envelope's `apiVersion` and the package `VERSION`: the
 * three move independently and conflating them is how a wire-compat question
 * becomes a release question.
 */
export const DOC_VERSION = 3 as const

/** The type of {@link DOC_VERSION}. */
export type DocVersion = typeof DOC_VERSION

// ---------------------------------------------------------------------------
// Closed enums — the shared vocabulary
// ---------------------------------------------------------------------------

/** The five EARS templates. Verbatim from the donor's `EARS_PATTERNS`. */
export const EARS_PATTERNS = [
  'ubiquitous',
  'event-driven',
  'state-driven',
  'optional-feature',
  'unwanted-behavior',
] as const
export type EarsPattern = (typeof EARS_PATTERNS)[number]

/** Business priority. Verbatim from the donor's `PRIORITIES`. */
export const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const
export type Priority = (typeof PRIORITIES)[number]

/** Lifecycle status. Verbatim from the donor's `STATUSES`. */
export const STATUSES = ['draft', 'approved', 'implemented', 'verified'] as const
export type Status = (typeof STATUSES)[number]

/** SysML-style verification method. Verbatim from the donor's `VERIFICATION_METHODS`. */
export const VERIFICATION_METHODS = ['test', 'inspection', 'analysis', 'demonstration'] as const
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number]

/** The four typed edge relations. Verbatim from the donor's `RELATIONS`. */
export const RELATIONS = ['derives', 'satisfies', 'verifies', 'refines'] as const
export type Relation = (typeof RELATIONS)[number]

/**
 * How a requirement's response relates to the state model — NEW in v3.
 *
 * - `'effect'` — the response CHANGES state. Encodes as a transition: a
 *   post-state predicate over the declared variables.
 * - `'constraint'` — the response RESTRICTS state. Encodes as an invariant that
 *   must hold in every reachable state.
 *
 * The distinction is not cosmetic: a Horn/Spacer encoding needs it to decide
 * whether a requirement contributes a transition rule or a safety property, and
 * guessing it from the response text is exactly the kind of inference the
 * propose/decide split forbids on the decide side. Optional at authoring so a
 * document is never blocked on a classification the author has not made; the
 * reachability wave (G4) reports an unclassified response as a demotion with the
 * supplying command, rather than assuming a default.
 */
export const RESPONSE_KINDS = ['effect', 'constraint'] as const
export type ResponseKind = (typeof RESPONSE_KINDS)[number]

/** The declared TYPE of a state variable — NEW in v3. */
export const STATE_VAR_TYPES = ['bool', 'int', 'enum'] as const
export type StateVarType = (typeof STATE_VAR_TYPES)[number]

// ---------------------------------------------------------------------------
// Atomic field schemas
// ---------------------------------------------------------------------------

/** Multi-line description builder, so a description is assembled from named
 * pieces rather than copy-pasted. */
const lines = (...xs: readonly string[]): string => xs.join('\n')

/**
 * A UUID string. `Schema.isUUID()` lowers to a `pattern` + `format: 'uuid'` in
 * the JSON Schema, so the manifest publishes the real constraint.
 */
export const Uuid = Schema.String.pipe(Schema.check(Schema.isUUID()))

/**
 * The stable-human-key format: 1–64 chars of `[A-Za-z0-9._-]`, at least one
 * non-digit (so `42` can never be a key and key-vs-number is unambiguous), and a
 * leading alphanumeric.
 *
 * FLAGLESS regex, carried over from the donor for the same reason: it is lowered
 * into the published JSON Schema as a `pattern`, and a JSON-Schema `pattern` has
 * no flags to carry an `i` into. (The donor's Zod path threw outright on a
 * flagged pattern; beta.102 does not throw, which would make a flagged regex a
 * SILENT mismatch between what the manifest advertises and what the code
 * enforces — a worse failure, so the rule stands.)
 */
export const KEY_PATTERN = /^(?=.*[A-Za-z._-])[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** A stable human key. */
export const Key = Schema.String.pipe(Schema.check(Schema.isPattern(KEY_PATTERN)))

/** A non-empty string — the shape every prose slot takes. */
const NonEmpty = Schema.String.pipe(Schema.check(Schema.isMinLength(1)))

/**
 * Attach a decoding default AND make it visible in the JSON Schema, in the one
 * order that works on beta.102.
 *
 * `withDecodingDefaultKey` does not emit `default` into the JSON Schema (known
 * trap #4), so the value must ALSO be annotated. The non-obvious part, verified
 * by probe: the annotation must sit on the INNER schema. Annotating the result of
 * `.pipe(withDecodingDefaultKey(...))` produces a JSON Schema with NO default at
 * all — the annotation lands on the wrapper the lowering discards. Encapsulating
 * both halves here means no field site can get the order wrong, and
 * `defineOperation`'s assertion (which fails on an optional field with no visible
 * default) has nothing left to catch.
 *
 * ## Do NOT wrap in `optionalKey` yourself
 *
 * `withDecodingDefaultKey` ALREADY makes the key optional on the ENCODED side —
 * its declared result is `decodeTo<S, optionalKey<toEncoded<S>>>`. Adding an
 * explicit `Schema.optionalKey(...)` around the inner schema makes the field
 * optional on the TYPE side too, which is wrong twice over: a decoded document
 * would type `requirements?: …` even though decoding always materializes it, so
 * every read site would need a needless `?.` or `??`, and the compiler would stop
 * catching a genuinely missing field. Optional in `Encoded` (the file may omit
 * it), required in `Type` (the decoded value always has it) is exactly the
 * contract a default expresses.
 *
 * ## Why the call is not a `.pipe(...)`
 *
 * `schema.pipe(withDecodingDefaultKey(...))` is a TS2684 inside a generic helper:
 * `pipe` types its `this` as the concrete `S`, and the compiler cannot prove the
 * annotated schema is that same `S` for an arbitrary subtype. Applying the
 * combinator directly with `S['Rebuild']` spelled out sidesteps it with no cast
 * and no `any`. At a concrete field site `.pipe` infers fine — this is purely the
 * cost of factoring the annotate/default pairing into one helper, which is worth
 * paying to make the ordering unforgettable.
 */
const withDefault = <S extends Schema.Top>(
  schema: S,
  value: S['Type'] & S['Encoded'],
  description: string,
) =>
  Schema.withDecodingDefaultKey<S['Rebuild']>(Effect.succeed(value))(
    schema.annotate({ default: value, description }),
  )

// ---------------------------------------------------------------------------
// Field descriptions — the single prose corpus
// ---------------------------------------------------------------------------

const patternTypeDescription = lines(
  'Which EARS template this requirement uses.',
  'Determines which structural slots are mandatory and how the canonical sentence renders:',
  "  - ubiquitous: an always-true rule. Renders 'The <system> shall <response>.' Use for invariants that hold without precondition or trigger.",
  "  - event-driven: triggered by an event. Requires `trigger`. Renders 'When <trigger>, the <system> shall <response>.'",
  "  - state-driven: active while a state holds. Requires `preCondition`. Renders 'While <preCondition>, the <system> shall <response>.'",
  "  - optional-feature: feature-gated behavior. Requires `preCondition`. Renders 'Where <preCondition>, the <system> shall <response>.'",
  "  - unwanted-behavior: error/failure handling. Requires `trigger`. Renders 'If <trigger>, then the <system> shall <response>.'",
  "Example: 'event-driven' for 'When the user submits valid credentials, the auth service shall issue a session token.'",
)

const preConditionDescription = lines(
  'Pre-condition clause that must hold for the requirement to apply.',
  'Required for state-driven and optional-feature patterns; optional elsewhere.',
  "Phrase as a state, not an event — present-tense, no leading 'while' or 'where' (the renderer adds those).",
  "Examples: 'maintenance mode is enabled'; 'the tenant has SSO configured'.",
)

const triggerDescription = lines(
  'Trigger clause: the event whose occurrence activates the requirement.',
  'Required for event-driven and unwanted-behavior patterns; optional elsewhere.',
  "Phrase as a discrete event in present tense, no leading 'when' or 'if' (the renderer adds those).",
  "Examples: 'the user submits valid credentials'; 'five consecutive failed logins occur within 10 minutes'.",
)

const systemNameDescription = lines(
  "The subject of the requirement — the 'X' in 'the X shall ...'.",
  "Always renders with a leading 'the', so omit any leading article here.",
  "Examples: 'auth service'; 'checkout pipeline'; 'payments gateway'.",
)

const systemResponseDescription = lines(
  "What the system shall do — the verb phrase following 'shall'.",
  "Phrase as an imperative-style verb phrase; do not include the word 'shall' itself.",
  "Do NOT bake negation into this text with a leading 'not'/'never' — express a prohibition by",
  'leaving the response POSITIVE and setting the `negated` flag instead.',
  'Should be testable: an outside observer should be able to confirm whether the behavior occurred.',
  "Examples: 'issue a session token'; 'lock the account for 15 minutes'.",
)

const negatedDescription = lines(
  'Response-polarity flag. `true` means the requirement PROHIBITS the response —',
  "it renders 'shall not <systemResponse>' and encodes as the negated atom for the formal tier.",
  "Keep `systemResponse` POSITIVE and set this flag; never bake a leading 'not' into the response text.",
  "This is what lets 'shall X' and 'shall not X' share one atom at opposite polarity, so the",
  'contradiction checker sees them as opposites rather than as two unrelated strings.',
  'Defaults to false. Examples: false for "issue a session token"; true to prohibit it.',
)

const responseKindDescription = lines(
  'How this requirement`s response relates to the declared state model (NEW in v3).',
  '  - effect:     the response CHANGES state — encodes as a transition over `stateModel.variables`.',
  '  - constraint: the response RESTRICTS state — encodes as an invariant that must hold in every reachable state.',
  'Optional at authoring: a document with no classification is fully valid, and the reachability',
  'tier reports an unclassified response as a demotion carrying the command that supplies it,',
  'rather than guessing. Supply it when the requirement participates in a reachability question.',
  "Examples: 'effect' for 'transition the run to RUNNING'; 'constraint' for 'never hold more than one lock'.",
)

const priorityDescription = lines(
  "Business priority of the requirement. Defaults to 'medium'.",
  '  - low:      nice-to-have; can slip releases without business impact.',
  '  - medium:   default; expected for current release but not blocking.',
  '  - high:     committed for current release; missing it would be a meaningful regression.',
  '  - critical: cannot ship without it; affects safety, compliance, or core revenue.',
)

const statusDescription = lines(
  "Lifecycle status. Defaults to 'draft'.",
  '  - draft:       under specification, not yet agreed.',
  '  - approved:    accepted by stakeholders; ready to be implemented.',
  '  - implemented: code exists that the team believes satisfies the requirement.',
  '  - verified:    independently confirmed (tests pass, review accepted, etc.).',
)

const verificationMethodDescription = lines(
  'How this requirement will be checked (SysML-style verification method). Optional.',
  '  - test:          automated or scripted test executes the behavior.',
  '  - inspection:    code or artifact review.',
  '  - analysis:      static analysis, model checking, or formal proof.',
  '  - demonstration: live walkthrough or manual check.',
)

const verificationNoteDescription = lines(
  'Free-text verification-plan note — the open companion to the closed `verificationMethod` enum.',
  'Records the concrete evidence plan the 4-value enum cannot capture: which suite, which theorem,',
  'which harness. Optional. Does not affect the formal tier or the canonical sentence.',
  "Examples: 'Hypothesis property suite in tests/property/test_auth.py'; 'integration test in it/auth_flow_test.ts'.",
)

const idDescription = lines(
  'Stable UUID identifying the requirement node.',
  'Assigned once at creation and never reused. All edges reference nodes by this UUID,',
  'so renaming a requirement or reordering the document never breaks a reference.',
  "Example: '550e8400-e29b-41d4-a716-446655440000'",
)

const keyDescription = lines(
  'Optional stable human key — a short slug you choose (e.g. "G1", "AUTH-3", "TX-B6").',
  'Assigned once at create time and NEVER changed, so it is as safe to reference as the UUID.',
  'Every ref-taking operation accepts a key wherever it accepts a UUID, so a whole document can be',
  'driven in human terms with no label-to-UUID sidecar map. Must be unique within the document',
  '(duplicates are ERR_DUPLICATE_KEY). Format: 1-64 chars of letters, digits, hyphen, underscore, dot;',
  'must contain at least one non-digit so a key can never be mistaken for a bare number.',
  "Examples: 'G1'; 'AUTH-3'; 'perf.p99'.",
)

const sentenceDescription = lines(
  'Canonical EARS sentence rendered from the structured slots above.',
  'Maintained automatically — every write path re-renders it whenever an EARS slot changes.',
  'Stored as a denormalized view so reviewers can scan the document as prose and `git diff` reads.',
  'Do not write it directly; update the slot fields instead.',
)

const edgeDescription = (relation: Relation, semantics: string): string =>
  lines(
    `Outbound ${relation} edges from this requirement. Each entry is the UUID of a target requirement.`,
    semantics,
    'Dangling targets (UUIDs that no longer resolve) are surfaced as findings by `check`, not rejected at',
    'write time — writes stay permissive so the graph can be built in any order; integrity is a lint',
    'concern, not a write barrier.',
  )

// ---------------------------------------------------------------------------
// The state model — first-class from day one
// ---------------------------------------------------------------------------

const stateVarNameDescription = lines(
  'The variable name, as referenced by requirement predicates and by the reachability encoder.',
  'Use a stable identifier-shaped noun: letters, digits, underscore, dot. Case-sensitive.',
  "Examples: 'run_state'; 'lock_held'; 'retry_count'.",
)

/**
 * A declared BOOLEAN state variable. Carries no domain — the domain is `{true,
 * false}` by construction, and admitting a `domain` key here would let a document
 * claim a boolean with three values.
 */
const BoolVar = Schema.Struct({
  name: NonEmpty.annotate({ description: stateVarNameDescription }),
  type: Schema.Literal('bool').annotate({
    description:
      'Discriminant: a two-valued variable. Its domain is {true,false} and is not declared.',
  }),
  initial: Schema.optionalKey(
    NonEmpty.annotate({
      description: lines(
        'Optional initial-state predicate over this variable, as a text expression the reachability',
        'encoder parses (G4). Omit when the initial value is unconstrained — an omitted initial is a',
        "genuine 'any value' rather than an implied false, and the encoder treats it that way.",
        "Examples: 'lock_held = false'.",
      ),
    }),
  ),
}).annotate({
  description: 'A declared boolean state variable.',
})

/**
 * A declared INTEGER state variable with an optional bounded domain. Bounds are
 * what make a Horn encoding finite-state where it can be, so they are worth
 * declaring even though they are optional.
 */
const IntVar = Schema.Struct({
  name: NonEmpty.annotate({ description: stateVarNameDescription }),
  type: Schema.Literal('int').annotate({
    description: 'Discriminant: an integer variable, optionally bounded by `domain`.',
  }),
  domain: Schema.optionalKey(
    Schema.Struct({
      min: Schema.optionalKey(
        Schema.Int.annotate({ description: 'Inclusive lower bound. Omit for unbounded below.' }),
      ),
      max: Schema.optionalKey(
        Schema.Int.annotate({ description: 'Inclusive upper bound. Omit for unbounded above.' }),
      ),
    }).annotate({
      description: lines(
        'Optional inclusive integer bounds. Declaring both makes the variable finite-domain, which is',
        'what lets a reachability query be decided rather than merely attempted.',
      ),
    }),
  ),
  initial: Schema.optionalKey(
    NonEmpty.annotate({
      description: lines(
        'Optional initial-state predicate over this variable. Omit when unconstrained.',
        "Examples: 'retry_count = 0'.",
      ),
    }),
  ),
}).annotate({ description: 'A declared integer state variable with an optional bounded domain.' })

/**
 * A declared ENUM state variable. `domain` is REQUIRED: an enum with no members
 * is not a variable, it is a typo, and accepting one would let the encoder
 * silently produce an empty state space.
 */
const EnumVar = Schema.Struct({
  name: NonEmpty.annotate({ description: stateVarNameDescription }),
  type: Schema.Literal('enum').annotate({
    description:
      'Discriminant: a finite symbolic variable. `domain` lists its members and is REQUIRED.',
  }),
  domain: Schema.Array(NonEmpty)
    .pipe(Schema.check(Schema.isMinLength(1)))
    .annotate({
      description: lines(
        'The finite set of values this variable may take. At least one member — an enum with an empty',
        'domain would give the encoder an empty state space, so it is rejected rather than accepted as',
        "a vacuous declaration. Examples: ['PENDING','RUNNING','DONE','FAILED'].",
      ),
    }),
  initial: Schema.optionalKey(
    NonEmpty.annotate({
      description: lines(
        'Optional initial-state predicate over this variable. Omit when unconstrained.',
        "Examples: 'run_state = PENDING'.",
      ),
    }),
  ),
}).annotate({
  description: 'A declared enum state variable over a finite, explicitly listed domain.',
})

/**
 * One declared state variable, discriminated on `type`.
 *
 * A UNION rather than one struct with three optional domain shapes, because the
 * union makes the per-type rules structural: a bool cannot carry a domain (it is
 * an excess property), an enum cannot omit one (it is a missing key), and an int
 * may do either. Encoding those as runtime checks on a single struct would put
 * three rules in a validator function where the schema — and therefore the
 * manifest an agent reads — can state them itself.
 */
export const StateVariable = Schema.Union([BoolVar, IntVar, EnumVar])
export type StateVariable = typeof StateVariable.Type

/**
 * The document's STATE MODEL — the declared variables a reachability question is
 * asked over, plus an optional global initial-state predicate.
 *
 * First-class in the format from the first commit, which is the structural fix
 * for V27: there is no "retrofit a field into a strip-mode object" step to get
 * wrong, because the field was never absent.
 */
export const StateModel = Schema.Struct({
  variables: withDefault(
    Schema.Array(StateVariable),
    [],
    lines(
      'The declared state variables. Each is a bool, a bounded-or-unbounded int, or a finite enum.',
      'Requirement predicates and the reachability encoder both reference these by `name`, so a',
      'variable that is not declared here is not addressable — which is the point: the state space is',
      'explicit rather than inferred from response text.',
    ),
  ),
  initial: Schema.optionalKey(
    NonEmpty.annotate({
      description: lines(
        'Optional initial-state predicate over the whole model, as a text expression (G4 parses it).',
        'Use for cross-variable initial constraints a per-variable `initial` cannot express.',
        "Examples: 'run_state = PENDING and retry_count = 0'.",
      ),
    }),
  ),
}).annotate({
  description: lines(
    'The declared state model: the variables a reachability query ranges over, plus an optional',
    'global initial-state predicate. Present in the format from v3.0 so a state model can never be',
    'silently stripped by a mutation (donor finding V27).',
  ),
})
export type StateModel = typeof StateModel.Type

/** An EMPTY state model — the value `init` writes and the default for a document
 * that declares none. A function, not a constant, so no caller can mutate a
 * shared object. */
export const emptyStateModel = (): StateModel => ({ variables: [] })

// ---------------------------------------------------------------------------
// The requirement
// ---------------------------------------------------------------------------

/**
 * One EARS requirement node.
 *
 * The five EARS structural slots, the typed business metadata, the four edge
 * arrays, the stable identifiers, and — new in v3 — `responseKind`. Every
 * optional field is `optionalKey`, so an absent value is an ABSENT KEY rather
 * than `null`: that is the `exactOptionalPropertyTypes` discipline all the way
 * out to the wire, and it is what makes `--dense`'s "drop what the schema
 * re-supplies" projection lossless.
 */
export const Requirement = Schema.Struct({
  id: Uuid.annotate({ description: idDescription }),
  key: Schema.optionalKey(Key.annotate({ description: keyDescription })),
  patternType: Schema.Literals(EARS_PATTERNS).annotate({ description: patternTypeDescription }),
  preCondition: Schema.optionalKey(NonEmpty.annotate({ description: preConditionDescription })),
  trigger: Schema.optionalKey(NonEmpty.annotate({ description: triggerDescription })),
  systemName: NonEmpty.annotate({ description: systemNameDescription }),
  systemResponse: NonEmpty.annotate({ description: systemResponseDescription }),
  negated: withDefault(Schema.Boolean, false, negatedDescription),
  responseKind: Schema.optionalKey(
    Schema.Literals(RESPONSE_KINDS).annotate({ description: responseKindDescription }),
  ),
  sentence: Schema.String.annotate({ description: sentenceDescription }),
  priority: withDefault(Schema.Literals(PRIORITIES), 'medium', priorityDescription),
  status: withDefault(Schema.Literals(STATUSES), 'draft', statusDescription),
  verificationMethod: Schema.optionalKey(
    Schema.Literals(VERIFICATION_METHODS).annotate({
      description: verificationMethodDescription,
    }),
  ),
  verificationNote: Schema.optionalKey(
    NonEmpty.annotate({ description: verificationNoteDescription }),
  ),
  derives: withDefault(
    Schema.Array(Uuid),
    [],
    edgeDescription(
      'derives',
      'The derives graph must be acyclic — cycles are surfaced as findings by `check`.',
    ),
  ),
  satisfies: withDefault(
    Schema.Array(Uuid),
    [],
    edgeDescription(
      'satisfies',
      'Use to link an implementation-level requirement back to a higher-level goal.',
    ),
  ),
  verifies: withDefault(
    Schema.Array(Uuid),
    [],
    edgeDescription(
      'verifies',
      'Use on a verification requirement to point at the requirement it confirms.',
    ),
  ),
  refines: withDefault(
    Schema.Array(Uuid),
    [],
    edgeDescription(
      'refines',
      'Use when this requirement is a more specific restatement of the target.',
    ),
  ),
  createdAt: Schema.String.annotate({
    description: 'ISO-8601 UTC timestamp of creation. Set by the runtime, never by the caller.',
  }),
  updatedAt: Schema.String.annotate({
    description:
      'ISO-8601 UTC timestamp of the last accepted mutation. Set by the runtime on every write.',
  }),
}).annotate({
  description: lines(
    'A single EARS requirement node, SysML-v2-shaped. Combines the five EARS structural slots with',
    'typed business metadata, the optional v3 `responseKind` classification, and four arrays of typed',
    'outbound edges. `sentence` is a denormalized rendering of the slots, maintained automatically.',
  ),
})
export type Requirement = typeof Requirement.Type

// ---------------------------------------------------------------------------
// The requirements map — and the silent-drop trap it works around
// ---------------------------------------------------------------------------

/**
 * The flat requirements map, keyed by stable UUID.
 *
 * ## Why the key is `Schema.String` plus a `propertyNames` check, not `Uuid`
 *
 * `Schema.Record(Uuid, Requirement)` reads as the obvious spelling and is WRONG
 * on beta.102. Probed directly: decoding `{'not-a-uuid': {...}}` against
 * `Schema.Record(Uuid, …)` returns **Success with `{}`** — the entry is silently
 * DROPPED. `{onExcessProperty:'error'}` does not change it; neither does
 * `{errors:'all'}`. A record's key schema behaves as a FILTER, not a validator.
 *
 * For a requirements document that is the worst available failure: a file with
 * one mistyped UUID key loads clean and is simply missing a requirement, so every
 * downstream count, every edge that pointed at it, and every `check` verdict is
 * computed over silently truncated data. It is the same species as V27 — data
 * disappearing with no diagnostic — reached by a different route.
 *
 * `Schema.check(Schema.isPropertyNames(Uuid))` on a `Schema.String`-keyed record
 * FAILS instead (`Expected a UUID, got "nope" at ["nope"]`), and lowers to a
 * `propertyNames` constraint in the JSON Schema, so the manifest still publishes
 * the real rule. Verified in both directions in `document.test.ts`.
 */
export const RequirementsMap = Schema.Record(Schema.String, Requirement)
  .pipe(Schema.check(Schema.isPropertyNames(Uuid)))
  .annotate({
    description: lines(
      'Every requirement in the document, keyed by its stable UUID. A flat map (not a tree) because',
      'edges carry all the structure and positional indices would break every reference on a reorder.',
      'Every key must be a UUID and must equal its value`s `id`.',
    ),
  })

// ---------------------------------------------------------------------------
// The three side tables
// ---------------------------------------------------------------------------

/**
 * One glossary entry: a canonical response phrasing plus the aliases that mean
 * the same thing. Committed in the document, so the formal tier can treat
 * paraphrases as one atom deterministically — the semantic tier only PROPOSES
 * entries; this table is what the decide path consults.
 */
export const GlossaryEntry = Schema.Struct({
  canonical: NonEmpty.annotate({
    description: lines(
      'The canonical response phrasing every alias collapses to.',
      "Example: 'issue a session token'.",
    ),
  }),
  aliases: withDefault(
    Schema.Array(NonEmpty),
    [],
    lines(
      'Synonymous phrasings that atomize to the canonical phrase. Committing them here is what makes',
      'a paraphrased contradiction provable instead of merely suspected.',
      "Example: ['issue a login credential', 'grant an access token'].",
    ),
  ),
}).annotate({ description: 'A canonical phrase and its synonymous aliases.' })
export type GlossaryEntry = typeof GlossaryEntry.Type

/**
 * One committed antonym pair: two response verb-heads asserted to be polar
 * opposites, so `a X` and `b X` resolve to the SAME atom at OPPOSITE polarity.
 * The antonym analogue of the glossary — where that decides synonymy, this
 * decides opposition.
 */
export const AntonymPair = Schema.Struct({
  a: NonEmpty.annotate({
    description:
      'One response verb-head, normalized to the leading-verb key the atomizer looks up. Example: "open".',
  }),
  b: NonEmpty.annotate({
    description: 'The polar-opposite response verb-head, normalized the same way. Example: "shut".',
  }),
}).annotate({
  description: lines(
    'A committed pair of polar-opposite response verb-heads. The pair is UNORDERED — the signed',
    'union-find canonicalizes it — so (open,shut) and (shut,open) are the same entry.',
  ),
})
export type AntonymPair = typeof AntonymPair.Type

/**
 * One reviewed finding waiver: a deliberate, reasoned suppression of a finding
 * code, optionally scoped to one requirement. A waived finding is dropped from
 * `findings[]` and from the exit gate, and tallied under a `waived` counter — so
 * a heuristic false positive gets a dignified, auditable exit instead of
 * degrading the prose or being re-emitted on every run.
 */
export const Waiver = Schema.Struct({
  code: NonEmpty.annotate({
    description: lines(
      'The finding code to waive — a GTWR_*, FND_*, or other code emitted by `check`.',
      "Example: 'GTWR_R6_MISSING_UNITS'.",
    ),
  }),
  requirementId: Schema.optionalKey(
    Uuid.annotate({
      description: lines(
        'Optional UUID scope. When set, only findings of `code` that name this requirement are waived;',
        'when omitted, every finding of `code` is waived document-wide. Resolved from a key at waive',
        'time, so the STORED scope is always the stable UUID.',
      ),
    }),
  ),
  reason: NonEmpty.annotate({
    description: lines(
      'Why this finding is waived — the audit trail a future reader needs to tell triage from neglect.',
      "Example: 'RFC 9457 is a standard identifier, not a bare quantity missing units.'",
    ),
  }),
}).annotate({
  description: 'A reviewed, reasoned suppression of a finding code, optionally requirement-scoped.',
})
export type Waiver = typeof Waiver.Type

// ---------------------------------------------------------------------------
// Diagnostics — the V27 disclosure channel
// ---------------------------------------------------------------------------

/**
 * The closed set of diagnostic kinds a LOAD can report.
 *
 * `'unknown-top-level-key'` is the V27 channel: a key this build does not know,
 * preserved verbatim and disclosed. `'sentence-drift'` reports a stored
 * `sentence` the renderer would not produce from the requirement's own slots —
 * a hand edit that a future write will overwrite, which is worth saying out loud
 * BEFORE the overwrite rather than after.
 */
export const DIAGNOSTIC_KINDS = ['unknown-top-level-key', 'sentence-drift'] as const
export type DiagnosticKind = (typeof DIAGNOSTIC_KINDS)[number]

/**
 * One INFO-grade disclosure about a loaded document.
 *
 * `severity` is fixed at `'info'` and stated explicitly rather than implied,
 * because the exit contract reads `severity` structurally: `'error'` would gate
 * the process to exit 1, and a forward-compatible key is emphatically not a
 * build failure. Stating it keeps the grade a property of the data an agent can
 * read, not a convention it has to know.
 */
export interface DocumentDiagnostic {
  readonly kind: DiagnosticKind
  /** Always `'info'` — a disclosure, never a gate. */
  readonly severity: 'info'
  /** Human-readable statement of what was found. */
  readonly detail: string
  /** The document keys involved, when the diagnostic is key-scoped. */
  readonly keys?: readonly string[]
  /** The requirement ids involved, when the diagnostic is requirement-scoped. */
  readonly requirementIds?: readonly string[]
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/**
 * The v3 requirements document, as persisted.
 *
 * This schema names every key v3 KNOWS. It is decoded with
 * `{onExcessProperty:'error'}`, so the unknown-top-level-key case never reaches
 * it — {@link decodeDocument} partitions those out first and reports them.
 */
export const RequirementsDocument = Schema.Struct({
  docVersion: Schema.Literal(DOC_VERSION).annotate({
    description: lines(
      'The document-format version. Exactly 3 for this format.',
      'Named `docVersion` (not v2`s `schemaVersion`) so a v2 file and a v3 file differ by KEY, and a v2',
      'document handed to v5 fails with the migration path instead of being misread as a v3 with a',
      'wrong number. Distinct from the envelope `apiVersion` and the package version.',
    ),
  }),
  requirements: withDefault(
    RequirementsMap,
    {},
    lines(
      'Every requirement, keyed by stable UUID. Defaults to {} so a freshly initialized document is',
      'valid with no requirements at all.',
    ),
  ),
  stateModel: withDefault(
    StateModel,
    { variables: [] },
    lines(
      'The declared state model (v3). Present in the format from day one — never retrofitted — so a',
      'mutation cannot strip it (donor finding V27). Defaults to an empty model.',
    ),
  ),
  glossary: withDefault(
    Schema.Array(GlossaryEntry),
    [],
    lines(
      'Committed synonym groups. The formal tier canonicalizes response atoms through this list, so a',
      'paraphrased conflict is provable rather than merely suspected. Defaults to [].',
    ),
  ),
  antonyms: withDefault(
    Schema.Array(AntonymPair),
    [],
    lines(
      'Committed antonym pairs. Extends the code-committed seed table so opposite response verbs',
      'collapse to one atom at opposite polarity and a contradiction is provable. Defaults to [].',
    ),
  ),
  waivers: withDefault(
    Schema.Array(Waiver),
    [],
    lines(
      'Reviewed finding waivers. `check` drops any finding matching a waiver from findings[] and from',
      'the exit gate, reporting the count under `waived` so a suppressed baseline stays visible.',
      'Defaults to [].',
    ),
  ),
}).annotate({
  description: lines(
    'The whole requirements document as persisted to disk: a version tag, the UUID-keyed requirement',
    'map, the declared state model, and the three committed side tables (glossary, antonyms,',
    'waivers). Unknown TOP-LEVEL keys are preserved and disclosed as info diagnostics rather than',
    'stripped (donor finding V27); unknown keys anywhere deeper are a hard failure.',
  ),
})
export type RequirementsDocument = typeof RequirementsDocument.Type

/** The set of top-level keys this build knows, derived from the schema itself so
 * it cannot drift from the fields. */
export const KNOWN_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(
  Object.keys(RequirementsDocument.fields),
)

/**
 * A loaded document plus everything the load DISCLOSED.
 *
 * `unknownKeys` carries the preserved values of top-level keys this build does
 * not know, so a save writes them back byte-for-byte and forward compatibility is
 * READ-AND-WRITE rather than read-only. `diagnostics` is the agent-facing
 * statement of the same fact, plus any sentence drift.
 */
export interface LoadedDocument {
  readonly document: RequirementsDocument
  /** Unknown top-level keys, preserved verbatim so a save round-trips them. */
  readonly unknownKeys: Readonly<Record<string, unknown>>
  /** Info-grade disclosures. Empty for a document this build fully understands. */
  readonly diagnostics: readonly DocumentDiagnostic[]
}

/** An EMPTY v3 document — what `init` writes. A function so no caller shares
 * mutable state with another. */
export const emptyDocument = (): RequirementsDocument => ({
  docVersion: DOC_VERSION,
  requirements: {},
  stateModel: emptyStateModel(),
  glossary: [],
  antonyms: [],
  waivers: [],
})

// ---------------------------------------------------------------------------
// Decoding — the V27-safe path
// ---------------------------------------------------------------------------

/** Narrow an unknown value to a plain record. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Split a raw parsed value into the keys v3 knows and the keys it does not.
 *
 * Pure and total: a non-object input yields no known keys and no unknown keys,
 * leaving the decode below to produce the real error message. Exported because
 * `store.ts`'s version check needs to read `docVersion` off a value it has not
 * decoded yet.
 */
export const partitionTopLevelKeys = (
  raw: unknown,
): { readonly known: Record<string, unknown>; readonly unknown: Record<string, unknown> } => {
  if (!isRecord(raw)) return { known: {}, unknown: {} }
  const known: Record<string, unknown> = {}
  const unknownKeys: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (KNOWN_TOP_LEVEL_KEYS.has(k)) known[k] = v
    else unknownKeys[k] = v
  }
  return { known, unknown: unknownKeys }
}

/**
 * The diagnostic for a set of preserved unknown top-level keys. Returns an empty
 * array when there are none, so the caller never has to branch.
 */
const unknownKeyDiagnostics = (
  unknownKeys: Readonly<Record<string, unknown>>,
): readonly DocumentDiagnostic[] => {
  const keys = Object.keys(unknownKeys).sort()
  if (keys.length === 0) return []
  return [
    {
      kind: 'unknown-top-level-key',
      severity: 'info',
      detail:
        `${keys.length} top-level key(s) are not part of document format v${DOC_VERSION} and are ` +
        `not interpreted by this build: ${keys.join(', ')}. They are PRESERVED verbatim — a save ` +
        'writes them back unchanged — so a document written by a newer symspec survives a round trip ' +
        'through this one. If a key is a typo rather than a newer feature, remove it; nothing reads it.',
      keys,
    },
  ]
}

/**
 * The diagnostic for requirements whose stored `sentence` differs from what the
 * renderer produces from their own slots.
 *
 * Worth disclosing at LOAD rather than at the write that overwrites it: a hand
 * edit to `sentence` is invisible until some unrelated mutation re-renders it,
 * at which point the edit vanishes and looks like the tool corrupting the file.
 * Saying it up front makes the next re-render expected instead of surprising.
 */
const sentenceDriftDiagnostics = (doc: RequirementsDocument): readonly DocumentDiagnostic[] => {
  const drifted = Object.keys(doc.requirements)
    .sort()
    .filter((id) => {
      const r = doc.requirements[id]
      return r !== undefined && renderSentence(r) !== r.sentence
    })
  if (drifted.length === 0) return []
  return [
    {
      kind: 'sentence-drift',
      severity: 'info',
      detail:
        `${drifted.length} requirement(s) store a \`sentence\` that differs from the one the EARS ` +
        'renderer produces from their own slots. `sentence` is a denormalized view, so the next write ' +
        'that touches an EARS slot will replace the stored text with the rendered form: ' +
        `${drifted.join(', ')}.`,
      requirementIds: drifted,
    },
  ]
}

/**
 * Decode a raw parsed JSON value into a {@link LoadedDocument}.
 *
 * The whole V27 mitigation, in three steps:
 *
 * 1. PARTITION the top level into known and unknown keys.
 * 2. Decode ONLY the known keys, with `{onExcessProperty:'error'}` — so a
 *    misspelled field inside a requirement, an unknown edge relation, a bad enum
 *    value, or a non-UUID map key is still a HARD failure. Strictness is not
 *    weakened anywhere except the one place forward compatibility needs it.
 * 3. Carry the unknown keys through on the result and report them as info
 *    diagnostics.
 *
 * The failure channel is `Schema.SchemaError`; the caller (`store.ts`) maps it
 * onto `ERR_DOC_PARSE` with the offending path in the message. The version check
 * is deliberately NOT here — `docVersion` is a `Schema.Literal(3)`, so a v2
 * document fails this decode with a message about `docVersion`, and `store.ts`
 * checks the version FIRST so the caller gets `ERR_SCHEMA_VERSION` and its
 * migration path instead.
 */
export const decodeDocument = (raw: unknown): Effect.Effect<LoadedDocument, Schema.SchemaError> => {
  const { known, unknown: unknownKeys } = partitionTopLevelKeys(raw)
  // A non-object input has no keys to partition, so hand the ORIGINAL value to
  // the decoder — otherwise `{}` would be decoded and the error would read
  // "missing docVersion" for an input that was actually a string or an array.
  const subject = isRecord(raw) ? known : raw
  return Effect.map(
    Schema.decodeUnknownEffect(RequirementsDocument, { onExcessProperty: 'error' })(subject),
    (document) => ({
      document,
      unknownKeys,
      diagnostics: [...unknownKeyDiagnostics(unknownKeys), ...sentenceDriftDiagnostics(document)],
    }),
  )
}

/**
 * Re-attach preserved unknown top-level keys to a document for serialization.
 *
 * This is the WRITE half of forward compatibility, and the half V27 was missing.
 * Known keys win on a collision, which cannot happen through
 * {@link partitionTopLevelKeys} (it puts a key in exactly one bucket) but is
 * stated explicitly because a caller could hand-build an `unknownKeys` map.
 */
export const withUnknownKeys = (
  document: RequirementsDocument,
  unknownKeys: Readonly<Record<string, unknown>>,
): Record<string, unknown> => ({ ...unknownKeys, ...document })
