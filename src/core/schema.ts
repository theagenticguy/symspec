/**
 * Single source of truth for every schema in the system.
 *
 * Design rules:
 *   1. Every atomic field is declared once with a rich `.describe()` covering
 *      what the field is, why it exists, and at least one concrete example.
 *      These descriptions propagate into the JSON-Schema argument shapes that
 *      `symspec manifest` emits and into the generated agent docs — they are
 *      the primary surface a coding agent reads to decide how to populate
 *      each argument.
 *   2. The full RequirementSchema, the discriminated-union ChangeSchema, and
 *      the per-tool input shapes are all composed from the same atomic fields.
 *      Adding a new attribute means editing exactly one place.
 *   3. Descriptions follow a consistent shape:
 *        <one-line what>
 *        <why it matters / when it's used>
 *        Examples: <one or more concrete values>
 *      The LLM treats these as load-bearing documentation, not decoration.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Enum constants
// ---------------------------------------------------------------------------

export const EARS_PATTERNS = [
  'ubiquitous',
  'event-driven',
  'state-driven',
  'optional-feature',
  'unwanted-behavior',
] as const
export type EarsPattern = (typeof EARS_PATTERNS)[number]

export const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const
export type Priority = (typeof PRIORITIES)[number]

export const STATUSES = ['draft', 'approved', 'implemented', 'verified'] as const
export type Status = (typeof STATUSES)[number]

export const VERIFICATION_METHODS = ['test', 'inspection', 'analysis', 'demonstration'] as const
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number]

export const RELATIONS = ['derives', 'satisfies', 'verifies', 'refines'] as const
export type Relation = (typeof RELATIONS)[number]

export const UPDATABLE_ATTRS = [
  'patternType',
  'preCondition',
  'trigger',
  'systemName',
  'systemResponse',
  'priority',
  'status',
  'verificationMethod',
] as const
export type UpdatableAttr = (typeof UPDATABLE_ATTRS)[number]

/** Attrs that may legally be set to `null` (meaning "delete this optional field"). */
export const NULLABLE_ATTRS: ReadonlySet<UpdatableAttr> = new Set([
  'preCondition',
  'trigger',
  'verificationMethod',
])

// ---------------------------------------------------------------------------
// Description builders — kept as functions so each description can be assembled
// from named pieces and reused without copy-paste drift.
// ---------------------------------------------------------------------------

const lines = (...xs: string[]) => xs.join('\n')

const patternTypeDescription = lines(
  'Which EARS template this requirement uses.',
  'Determines which structural slots are mandatory and how the canonical sentence renders:',
  "  - ubiquitous: an always-true rule. Renders 'The <system> shall <response>.' Use for invariants that hold without precondition or trigger.",
  "    Example: 'The auth service shall log every authentication attempt in JSON.'",
  "  - event-driven: triggered by an event. Requires `trigger`. Renders 'When <trigger>, the <system> shall <response>.'",
  "    Example: 'When the user submits valid credentials, the auth service shall issue a session token.'",
  "  - state-driven: active while a state holds. Requires `preCondition`. Renders 'While <preCondition>, the <system> shall <response>.'",
  "    Example: 'While maintenance mode is on, the auth service shall reject all login attempts.'",
  "  - optional-feature: feature-gated behavior. Requires `preCondition`. Renders 'Where <preCondition>, the <system> shall <response>.'",
  "    Example: 'Where SSO is configured for the tenant, the auth service shall redirect login to the configured IdP.'",
  "  - unwanted-behavior: error/failure handling. Requires `trigger`. Renders 'If <trigger>, then the <system> shall <response>.'",
  "    Example: 'If five consecutive failed logins occur within 10 minutes, then the auth service shall lock the account for 15 minutes.'",
)

const preConditionDescription = lines(
  'Pre-condition clause that must hold for the requirement to apply.',
  'Required for state-driven and optional-feature patterns; optional elsewhere.',
  "Phrase as a state, not an event — present-tense, no leading 'while' or 'where' (those are added by the renderer).",
  'Examples:',
  "  - 'maintenance mode is enabled'",
  "  - 'the user has MFA enabled on their account'",
  "  - 'the tenant has SSO configured'",
)

const triggerDescription = lines(
  'Trigger clause: the event whose occurrence activates the requirement.',
  'Required for event-driven and unwanted-behavior patterns; optional elsewhere.',
  "Phrase as a discrete event in present tense, no leading 'when' or 'if' (the renderer adds those).",
  'Examples:',
  "  - 'the user submits valid credentials'",
  "  - 'the order is confirmed'",
  "  - 'five consecutive failed logins occur within 10 minutes'",
)

const systemNameDescription = lines(
  "The subject of the requirement — the 'X' in 'the X shall ...'.",
  "Always renders with a leading 'the', so omit any leading article here.",
  'Use a stable noun phrase that names a service, component, or actor in your system.',
  "Examples: 'auth service', 'checkout pipeline', 'payments gateway', 'mobile client'.",
)

const systemResponseDescription = lines(
  "What the system shall do — the verb phrase following 'shall'.",
  "Phrase as an imperative-style verb phrase; do not include the word 'shall' itself.",
  "Do NOT bake negation into this text with a leading 'not'/'never' — express a prohibition by",
  'leaving the response POSITIVE and setting the `negated` flag instead (see `negated`).',
  'Should be testable: an outside observer should be able to confirm whether the behavior occurred.',
  'Examples:',
  "  - 'issue a session token'",
  "  - 'lock the account for 15 minutes'",
  "  - 'reject all incoming login attempts'",
)

const negatedDescription = lines(
  'Response-polarity flag (AC-2-4). `true` means the requirement PROHIBITS the response —',
  "it renders 'shall not <systemResponse>' and encodes as ¬R for the formal tier.",
  "Keep `systemResponse` POSITIVE and set this flag; never bake a leading 'not' into the response",
  "text. This is what lets 'shall X' and 'shall not X' share one atom at opposite polarity, so the",
  'contradiction checker sees them as opposites (FND_CONTRADICTION) rather than as duplicate text.',
  "Defaults to false (a plain 'shall <response>' obligation).",
  'Examples: false for "issue a session token"; true for "issue a session token" (renders "shall not issue a session token").',
)

const priorityDescription = lines(
  "Business priority of the requirement. Defaults to 'medium' if omitted at create time.",
  '  - low:      nice-to-have; can slip releases without business impact.',
  '  - medium:   default; expected for current release but not blocking.',
  '  - high:     committed for current release; missing it would be a meaningful regression.',
  '  - critical: cannot ship without it; affects safety, compliance, or core revenue.',
)

const statusDescription = lines(
  "Lifecycle status. Defaults to 'draft' at create time.",
  '  - draft:       under specification, not yet agreed.',
  '  - approved:    accepted by stakeholders; ready to be implemented.',
  '  - implemented: code exists that the team believes satisfies the requirement.',
  '  - verified:    independently confirmed (tests pass, review accepted, etc.).',
)

const verificationMethodDescription = lines(
  'How this requirement will be checked (SysML-style verification method).',
  'Optional. Useful at hand-off to QA / verification engineering.',
  '  - test:          automated or scripted test executes the behavior.',
  '  - inspection:    code or artifact review.',
  '  - analysis:      static analysis, model checking, or formal proof.',
  '  - demonstration: live walkthrough or manual check.',
)

const idDescription = lines(
  'Stable UUID identifying the requirement node.',
  'Assigned once at creation and never reused. All edges reference nodes by this UUID,',
  'so renaming a requirement or reordering the document never breaks a reference.',
  "Example: '550e8400-e29b-41d4-a716-446655440000'",
)

const sentenceDescription = lines(
  'Canonical EARS sentence rendered from the structured slots above.',
  'Maintained automatically — the renderer re-runs whenever any EARS slot changes.',
  'Stored as a denormalized view so reviewers can scan the document as prose.',
  'Do not write directly; update the slot fields instead.',
)

const edgeArrayDescription = (relation: Relation, semantics: string, example: string) =>
  lines(
    `Outbound ${relation} edges from this requirement. Each entry is the UUID of a target requirement node.`,
    semantics,
    `Example target list: ${example}`,
    'Dangling targets (UUIDs that no longer resolve) are surfaced as findings by `symspec check`, not enforced at write time —',
    'writes stay permissive so you can build the graph in any order; integrity is a lint concern, not a write barrier.',
  )

const relationDescription = lines(
  'Which kind of relationship the edge represents (SysML-flavored requirement relations):',
  '  - derives:   the source decomposes into / produces the target. Forms the DAG used for cycle detection.',
  '  - satisfies: the source claims to satisfy a goal expressed by the target.',
  '  - verifies:  the source is a verification requirement that confirms the target.',
  '  - refines:   the source is a more detailed restatement of the target.',
)

const attrDescription = lines(
  'Which attribute to update.',
  'Allowed values are the EARS structural slots (patternType, preCondition, trigger, systemName, systemResponse)',
  'and the typed metadata (priority, status, verificationMethod).',
  'Updating any EARS slot triggers an automatic re-render of the canonical sentence; metadata updates do not.',
)

const attrValueDescription = lines(
  'New value for the attribute, or null to clear it.',
  "Pass a string for any non-null update; the runtime validates against the attribute's enum where applicable.",
  'Pass null only for optional attributes (preCondition, trigger, verificationMethod) — nulling a required',
  'attribute throws, since it would leave the requirement in an unrenderable state.',
)

// ---------------------------------------------------------------------------
// Atomic field schemas — every other schema in the project composes from these.
// ---------------------------------------------------------------------------

export const f = {
  id: z.string().uuid().describe(idDescription),
  patternType: z.enum(EARS_PATTERNS).describe(patternTypeDescription),
  preCondition: z.string().min(1).describe(preConditionDescription),
  trigger: z.string().min(1).describe(triggerDescription),
  systemName: z.string().min(1).describe(systemNameDescription),
  systemResponse: z.string().min(1).describe(systemResponseDescription),
  negated: z.boolean().describe(negatedDescription),
  sentence: z.string().describe(sentenceDescription),
  priority: z.enum(PRIORITIES).describe(priorityDescription),
  status: z.enum(STATUSES).describe(statusDescription),
  verificationMethod: z.enum(VERIFICATION_METHODS).describe(verificationMethodDescription),
  derives: z
    .array(z.string().uuid())
    .describe(
      edgeArrayDescription(
        'derives',
        'The derives DAG must be acyclic — cycles are surfaced as findings by `symspec check`.',
        "['7a1b...', 'c4f3...']",
      ),
    ),
  satisfies: z
    .array(z.string().uuid())
    .describe(
      edgeArrayDescription(
        'satisfies',
        'Use to link an implementation-level requirement back to a higher-level goal.',
        "['1f2e...']",
      ),
    ),
  verifies: z
    .array(z.string().uuid())
    .describe(
      edgeArrayDescription(
        'verifies',
        'Use on a verification requirement to point at the requirement it confirms.',
        "['9d8c...']",
      ),
    ),
  refines: z
    .array(z.string().uuid())
    .describe(
      edgeArrayDescription(
        'refines',
        'Use when this requirement is a more specific restatement of the target.',
        "['3b2a...']",
      ),
    ),
  createdAt: z
    .string()
    .describe('ISO-8601 UTC timestamp of creation. Set by the runtime, not the caller.'),
  updatedAt: z
    .string()
    .describe(
      'ISO-8601 UTC timestamp of the last accepted Change. Updated by the runtime on every applyChange.',
    ),
  relation: z.enum(RELATIONS).describe(relationDescription),
  attr: z.enum(UPDATABLE_ATTRS).describe(attrDescription),
  attrValue: z.union([z.string(), z.null()]).describe(attrValueDescription),
}

// ---------------------------------------------------------------------------
// Composed schemas
// ---------------------------------------------------------------------------

export const RequirementSchema = z
  .object({
    id: f.id,
    patternType: f.patternType,
    preCondition: f.preCondition.optional(),
    trigger: f.trigger.optional(),
    systemName: f.systemName,
    systemResponse: f.systemResponse,
    negated: f.negated.default(false),
    sentence: f.sentence,
    priority: f.priority.default('medium'),
    status: f.status.default('draft'),
    verificationMethod: f.verificationMethod.optional(),
    derives: f.derives.default([]),
    satisfies: f.satisfies.default([]),
    verifies: f.verifies.default([]),
    refines: f.refines.default([]),
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  })
  .describe(
    lines(
      'A single EARS requirement node, SysML-v2-shaped.',
      'Combines the five EARS structural slots (patternType + preCondition + trigger + systemName + systemResponse)',
      'with typed business metadata (priority, status, verificationMethod) and four arrays of typed outbound edges.',
      'The `sentence` field is a denormalized rendering of the EARS slots, maintained automatically.',
      'Every node has a stable UUID so edges survive renames and reorders of the document.',
    ),
  )
export type Requirement = z.infer<typeof RequirementSchema>

/**
 * Load-time schema for the whole on-disk document (AC-1-4). Keys the flat
 * `requirements` map by UUID — `z.record(f.id, RequirementSchema)` rejects
 * any non-UUID key up front, matching AC-1-2's "keyed by stable UUID" shape.
 * `schemaVersion` is validated as an integer only; whether it equals the
 * CURRENT `SCHEMA_VERSION` is a separate, disjoint check (AC-1-9,
 * `ERR_SCHEMA_VERSION`) performed in `load.ts` after this schema already
 * accepted the document as well-formed v2-shaped JSON.
 */
/**
 * One glossary entry (AC-9-1): a canonical response phrasing plus the alias
 * phrasings that mean the same thing. Agent-confirmed synonyms live here, in
 * the committed document, so the formal tier can treat "issue a session token"
 * and "issue a login credential" as one atom (INCOSE C11 term-consistency).
 * The semantic-similarity tier only PROPOSES entries; this committed list is
 * the deterministic bridge the SMT verdict path actually consults.
 */
export const GlossaryEntrySchema = z
  .object({
    canonical: z
      .string()
      .min(1)
      .describe('The canonical response phrasing all aliases collapse to.'),
    aliases: z
      .array(z.string().min(1))
      .describe('Synonymous phrasings that atomize to the canonical phrase.'),
  })
  .describe('A canonical phrase and its synonymous aliases (AC-9-1).')

export const RequirementsDocSchema = z
  .object({
    schemaVersion: z.number().int(),
    requirements: z.record(f.id, RequirementSchema),
    glossary: z
      .array(GlossaryEntrySchema)
      .default([])
      .describe(
        lines(
          'Agent-confirmed synonym groups (AC-9-1). Optional; defaults to []. The formal tier',
          'canonicalizes response atoms through this list so paraphrased conflicts are provable.',
        ),
      ),
  })
  .describe(
    lines(
      'The whole requirements document as persisted to disk: a schema version tag, the',
      'flat UUID-keyed map of requirement nodes, and an optional synonym glossary. Validated',
      'at load time (AC-1-4) — a document that is not valid JSON, or is valid JSON that fails',
      'this schema, is rejected with ERR_DOC_PARSE before any command runs.',
    ),
  )

/** What a caller may legally supply when creating a requirement. */
export const CreateRequirementAttrsSchema = z
  .object({
    patternType: f.patternType,
    systemName: f.systemName,
    systemResponse: f.systemResponse,
    negated: f.negated.optional(),
    trigger: f.trigger.optional(),
    preCondition: f.preCondition.optional(),
    priority: f.priority.optional(),
    status: f.status.optional(),
    verificationMethod: f.verificationMethod.optional(),
  })
  .describe(
    lines(
      'Initial attributes for a new requirement. The runtime fills in id, sentence, createdAt, updatedAt,',
      "and default values for omitted optional fields (priority='medium', status='draft', edges=[]).",
      'Pre-condition / trigger are not required at the schema level, but `symspec check` will flag a missing',
      'one for any pattern that requires it (e.g. an event-driven requirement with no trigger).',
    ),
  )

// ---------------------------------------------------------------------------
// Per-command input shapes (raw ZodRawShape objects reused by the CLI layer
// and the manifest). Each shape is the exact set of arguments the
// corresponding `symspec` command accepts.
// ---------------------------------------------------------------------------

export const RequirementCreateInputShape = {
  patternType: f.patternType,
  systemName: f.systemName,
  systemResponse: f.systemResponse,
  negated: f.negated.optional(),
  trigger: f.trigger.optional(),
  preCondition: f.preCondition.optional(),
  priority: f.priority.optional(),
  status: f.status.optional(),
  verificationMethod: f.verificationMethod.optional(),
}

export const RequirementUpdateInputShape = {
  id: f.id,
  attr: f.attr,
  value: f.attrValue,
}

export const RelationshipAddInputShape = {
  from: f.id.describe(
    lines(
      'Source requirement UUID — the origin of the edge.',
      'Must exist in the document at apply time, or the call errors.',
    ),
  ),
  relation: f.relation,
  to: f.id.describe(
    lines(
      'Target requirement UUID — the destination of the edge.',
      'May refer to a node that is later deleted; the resulting dangling reference is then surfaced',
      'as a finding by `symspec check` rather than being prevented at write time.',
    ),
  ),
}

export const RelationshipRemoveInputShape = {
  from: f.id.describe('Source requirement UUID (origin of the edge to remove).'),
  relation: f.relation,
  to: f.id.describe('Target requirement UUID (destination of the edge to remove).'),
}

export const RequirementDeleteInputShape = {
  id: f.id.describe(
    lines(
      'UUID of the requirement to delete.',
      'The node is removed from the document. Any inbound edges from other requirements become',
      'dangling references and will be surfaced by the next `symspec check` run.',
    ),
  ),
}

// ---------------------------------------------------------------------------
// Change records (the agent-facing transactional API). A Commit is a batch
// of Changes applied atomically by the runtime; each Change is independently
// schema-validated, idempotent where noted, and references elements by UUID.
// ---------------------------------------------------------------------------

export const ChangeSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('CreateRequirement'),
        id: f.id,
        attrs: CreateRequirementAttrsSchema,
      })
      .describe(
        'Create a new requirement with the given UUID and initial attrs. Throws on UUID collision.',
      ),
    z
      .object({
        kind: z.literal('UpdateAttribute'),
        id: f.id,
        attr: f.attr,
        value: f.attrValue,
      })
      .describe(
        "Patch one typed attribute. EARS slot updates re-render the canonical sentence; metadata updates don't. Null clears an optional attr; null on a required attr throws.",
      ),
    z
      .object({
        kind: z.literal('AddRelationship'),
        from: f.id,
        relation: f.relation,
        to: f.id,
      })
      .describe(
        'Add a typed edge from source to target. Idempotent — adding an existing edge is a no-op.',
      ),
    z
      .object({
        kind: z.literal('RemoveRelationship'),
        from: f.id,
        relation: f.relation,
        to: f.id,
      })
      .describe(
        'Remove a typed edge. No-op if the edge is not present, including if the source no longer exists.',
      ),
    z
      .object({
        kind: z.literal('DeleteRequirement'),
        id: f.id,
      })
      .describe(
        'Tombstone a requirement. Inbound edges from surviving nodes become dangling references surfaced by `symspec check`.',
      ),
  ])
  .describe(
    lines(
      'One operation in the agent-facing transactional API.',
      'Each Change is self-contained, schema-validated, and references elements by stable UUID rather than by JSON path —',
      'so a batch composed against one snapshot of the document still applies cleanly after unrelated nodes are added, removed, or reordered.',
      "A 'Commit' in our model is a list of Change records applied as a single unit by the runtime.",
    ),
  )
export type Change = z.infer<typeof ChangeSchema>

// ---------------------------------------------------------------------------
// EARS sentence renderer — implementation lives in render.ts (AC-1-3); kept
// as a small marker section here so the domain-model doc comment above and
// the renderer stay adjacent in the reading order this file has always had.
// The pure `renderSentence` function is defined in `render.ts` and
// re-exported below so existing importers of `schema.js` are unaffected.
// ---------------------------------------------------------------------------

export { renderSentence } from './render.js'

// ---------------------------------------------------------------------------
// Analysis findings
// ---------------------------------------------------------------------------

export type Finding =
  | {
      kind: 'DanglingReference'
      from: string
      relation: Relation
      to: string
      message: string
    }
  | {
      kind: 'MissingTrigger'
      id: string
      patternType: EarsPattern
      message: string
    }
  | {
      kind: 'MissingPreCondition'
      id: string
      patternType: EarsPattern
      message: string
    }
  | {
      kind: 'CycleDetected'
      nodes: string[]
      relation: Relation
      message: string
    }
  | { kind: 'OrphanRequirement'; id: string; message: string }
  | { kind: 'LeafUnverifiable'; id: string; message: string }

// ---------------------------------------------------------------------------
// Document shape
// ---------------------------------------------------------------------------

/**
 * The root on-disk document (AC-1-2): a schema version tag plus a flat map
 * keyed by UUID. The flat-map-by-UUID shape is the simplest structure for
 * stable cross-reference identity, since edges never depend on positional
 * indices.
 * {@link RequirementsDocSchema} is the load-time Zod validator for this
 * shape (AC-1-4); this hand-written type and that schema are kept
 * structurally identical (see `load.test.ts` / `schema.test.ts`).
 */
/** One committed synonym group (AC-9-1). See {@link GlossaryEntrySchema}. */
export type GlossaryEntry = {
  canonical: string
  aliases: string[]
}

export type RequirementsDoc = {
  schemaVersion: number
  requirements: Record<string, Requirement>
  glossary: GlossaryEntry[]
}

export const SCHEMA_VERSION = 2
