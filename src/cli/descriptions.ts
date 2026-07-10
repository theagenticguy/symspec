/**
 * Single-source command help/summary prose (AC-6-9).
 *
 * The prior MCP tool descriptions carried the best command documentation —
 * a what / when / returns / idempotency structure tuned for an agent. That
 * surface is deleted in v2 (AC-8-1), but the prose is the superior copy, so
 * this module ports it into the CLI: every command's Commander `.description()`
 * AND the manifest's per-command `summary` read from the ONE map here, so the
 * two agent-facing surfaces can never drift (AC-6-9; AC-7-5 single-source).
 *
 * ## Command surface
 *
 * The inventory is exactly the commands the CLI ships — no upgrade/import
 * command. Each description states what the command does, when to reach for
 * it, what it returns, and its idempotency, in terms of the current CLI only.
 *
 * ## Shape
 *
 * {@link COMMAND_DESCRIPTIONS} maps each command name to its full multi-line
 * help text. {@link COMMAND_SUMMARIES} maps each to the one-line summary the
 * manifest carries (the first sentence of the full text). `cli/index.ts` wires
 * the full text into `.description()`; `cli/manifest.ts` reads the summaries.
 *
 * Cite: AC-6-9 (port the superior prior tool descriptions into command help +
 * manifest); AC-7-5 (one corpus drives every agent surface); SC-1/SC-2 (v2 on
 * its own terms, no upgrade/import command); orchestrator decision 8.
 */

const lines = (...xs: string[]): string => xs.join('\n')

/** One command name in the v2 inventory (mirrors `cli/types-enum.ts`, minus `error`). */
export type CommandName =
  | 'manifest'
  | 'init'
  | 'add'
  | 'update'
  | 'parse'
  | 'check'
  | 'certify'
  | 'list'
  | 'show'
  | 'derive'
  | 'satisfy'
  | 'remove-edge'
  | 'delete'
  | 'export'
  | 'glossary'
  | 'download-model'

/**
 * Full what / when / returns / idempotency help text per command. Wired into
 * each command's Commander `.description()` and the source of the manifest
 * summaries, so the two agent-facing surfaces read from one map.
 */
export const COMMAND_DESCRIPTIONS: Record<CommandName, string> = {
  manifest: lines(
    'Emit the self-describing manifest — the whole command surface as one JSON blob.',
    'Fetch this once before driving symspec: it lists every command, each command argument schema',
    '(derived from the same Zod fields the runtime validates against), the stable ERR_*/GTWR_*/FND_*',
    'code catalogs an agent switches on, the closed envelope `type` set, and the live `backends`',
    'availability report (z3-wasm, external z3/cvc5 binaries, Lean toolchain) so you can query-then-decide',
    'before invoking `certify` or `--solver`. Read-only; does not touch any document.',
  ),
  init: lines(
    'Create an empty requirements document at the resolved path.',
    'Use once to start a new spec before adding requirements.',
    'Writes a pretty-printed, sorted-key JSON file atomically; returns the resolved path.',
    'Not idempotent in intent — re-running overwrites the file with a fresh empty document.',
  ),
  add: lines(
    'Create a new EARS requirement and return its assigned UUID.',
    'Use once per requirement you intend to author, from either structured EARS slots or, via --from-parse,',
    'a single line of prose run through the tiered parse ladder. The runtime mints the UUID (unless you pass',
    "--id), renders the canonical sentence, and applies defaults (priority='medium', status='draft', empty",
    'edge arrays). Pre-condition/trigger are not enforced here even when the pattern wants them — `symspec check`',
    'surfaces missing slots as findings rather than rejecting the create, so you can author a stub and refine it.',
    'After adding a batch of requirements, run `symspec check` to surface any missing-slot or structural findings.',
    'Not idempotent — each call creates a distinct requirement (a supplied --id that already exists errors).',
  ),
  update: lines(
    'Patch exactly one typed attribute on an existing requirement.',
    'Use for incremental refinement: tightening a trigger, escalating priority, moving status forward through',
    'draft -> approved -> implemented -> verified. Updating any EARS structural slot (patternType, preCondition,',
    'trigger, systemName, systemResponse) automatically re-renders the canonical sentence; metadata edits',
    '(priority, status, verificationMethod) leave the sentence alone.',
    'Pass --clear to remove an optional attribute (preCondition, trigger, verificationMethod); clearing a required',
    'attribute errors. The literal string "null" is stored as text, never interpreted as a clear.',
    'Errors when the id does not resolve to a current requirement. Idempotent: re-applying the same set is a no-op.',
  ),
  parse: lines(
    'Parse natural-language requirement prose into structured EARS slots.',
    'Use to turn a requirement sentence (or a whole file / stdin of them, one per line) into EARS slots without',
    'hand-authoring them. Each line runs through the Tier-1 regex cascade, escalating to the Tier-2 wink-nlp parser',
    'and, on hard failure, a Tier-3 structured error carrying a stable ERR_PARSE_* code, the recovered partial slots,',
    'and mechanical rewrite suggestions. A no-modal prose line (a bullet with no obligation) is reported as skipped,',
    'not an error. Returns per-line results plus an { ok, skipped, error } summary. Read-only; does not create anything.',
  ),
  check: lines(
    'Run the full linter loop over the document and return findings in one envelope.',
    'Use after a batch of mutations to verify the spec: this wires all tiers into one pass — Tier-0 structural checks',
    '(dangling references, missing EARS slots required by a pattern, cycles in the derives DAG, orphaned nodes), the',
    'INCOSE GtWR + free-tier lint rules (stable codes, severities, character spans, rewrite suggestions), and the',
    'in-process SMT formal tier (contradiction, subsumption, redundancy, vacuity, completeness heuristic). The formal',
    'tier is sound modulo atomization: every reported conflict is real, but silence is not a consistency certificate,',
    'and contextual ambiguity is not checked (it is punted to you). Statements that fail a parse or a blocking surface',
    'check are excluded from the formal layer so the SMT tier never sees unsound input. Exit code 0 means no',
    'error-severity finding, 1 means the pass/fail gate failed on findings, 2 means an operational error. Read-only.',
  ),
  certify: lines(
    'Emit and kernel-check an optional Lean 4 proof artifact for the document.',
    'Use when you need a durable, kernel-checked certificate beyond the default SMT tier. Generates one batched',
    'core-Lean file (no Mathlib, no lake), runs it through `lean --json`, and maps the result to FND_CERTIFIED with',
    '`#print axioms` provenance or FND_CERTIFY_FAILED. Requires a Lean toolchain: if none is discoverable it returns',
    'ERR_LEAN_TOOLCHAIN_MISSING and never affects any prior SMT result. Strictly opt-in — the default `symspec check`',
    'never invokes Lean. On success, retains the .lean file plus a pinned lean-toolchain as a re-checkable artifact.',
  ),
  list: lines(
    'List all current requirements in the document.',
    'Each entry carries the id, pattern type, priority, status, and rendered EARS sentence — enough to scan the spec',
    'at a glance without fetching every full node.',
    'Use before mutating to find the UUID of a requirement you intend to update or link to. Read-only and idempotent.',
  ),
  show: lines(
    'Print the full record of one requirement by UUID.',
    'Use to inspect every field (all slots, metadata, and outbound edges) of a single requirement before editing it.',
    'Errors when the id does not resolve to a current requirement. Read-only and idempotent.',
  ),
  derive: lines(
    'Add a derives edge — the source requirement decomposes into the target.',
    'Use to express requirement decomposition; the derives DAG must stay acyclic (cycles are surfaced by `symspec check`).',
    'Idempotent — adding the same edge twice produces a single edge, so retries are safe.',
    'Errors when the source requirement does not exist. If the target is later deleted, the edge survives and becomes a',
    'dangling reference, which `symspec check` surfaces.',
  ),
  satisfy: lines(
    'Add a satisfies edge — the source requirement satisfies the goal expressed by the target.',
    'Use to link an implementation-level requirement back to a higher-level goal.',
    'Idempotent — adding the same edge twice produces a single edge, so retries are safe.',
    'Errors when the source requirement does not exist. A later-deleted target leaves a dangling reference for `symspec check`.',
  ),
  'remove-edge': lines(
    'Remove a typed directional edge between two requirements (derives | satisfies | verifies | refines).',
    'Use to retract a decomposition, satisfaction, verification, or refinement claim that no longer holds.',
    "No-op if the edge isn't present, including if the source requirement was already deleted — safe to call defensively.",
    'Does not delete either endpoint node.',
  ),
  delete: lines(
    'Tombstone a requirement, removing it from the document.',
    'Use when a requirement has been retracted, superseded, or merged into another.',
    'Inbound edges from surviving requirements become dangling references — they are not auto-removed. After a delete,',
    'run `symspec check`; the dangling-reference findings tell you which survivors still pointed at the deleted node so',
    'you can rewire or remove those edges. Deleting a missing id leaves the document unchanged rather than erroring.',
  ),
  export: lines(
    'Export the requirements graph to SysML-v2-flavored JSON for interchange with other tools.',
    'Each requirement becomes a RequirementUsage element with typed attributes and the rendered sentence as',
    'documentation; each outbound edge becomes a typed relationship element (DeriveRequirement, Satisfy, Verify, Refine).',
    'Use as a hand-off to a downstream SysML v2 server, a static analyzer, or a documentation pipeline. Read-only.',
  ),
  glossary: lines(
    "Manage the document's committed synonym glossary: `glossary add <canonical> <alias>`, `glossary remove <canonical> <alias>`, `glossary list`.",
    'The formal tier canonicalizes response atoms through this glossary (AC-9-2), so agent-confirmed synonyms like',
    '"issue a session token" ≡ "issue a login credential" collide on one atom and a paraphrased contradiction becomes provable by `check`.',
    'This is the DECIDE half of the semantic tier: `check --semantic` only PROPOSES entries (FND_SIMILAR_SEMANTIC); confirming them here is what changes a verdict.',
    'add is idempotent; remove of an absent alias is a no-op; list is read-only. Mutating ops re-save the document.',
  ),
  'download-model': lines(
    'Pre-fetch and cache the semantic tier embedding model so `check --semantic` runs fully offline afterward.',
    'Downloads the pinned BGE model (~110 MB) plus its tokenizer from a frozen HuggingFace revision into the local',
    'cache (SYMSPEC_MODEL_DIR / XDG_CACHE_HOME / ~/.cache), verifying every asset against a pinned sha256 so a corrupt',
    'or tampered download fails instead of poisoning embeddings. Idempotent: already-cached assets are reported and skipped.',
    'Run once on a networked machine to warm the cache for air-gapped or CI use; the default `check` never needs it.',
  ),
}

/**
 * One-line summary per command — the first line of its full help text — for the
 * manifest's `summary` field, so the manifest and the CLI help share one source.
 */
export const COMMAND_SUMMARIES: Record<CommandName, string> = Object.fromEntries(
  (Object.entries(COMMAND_DESCRIPTIONS) as [CommandName, string][]).map(([name, text]) => [
    name,
    text.split('\n')[0] ?? '',
  ]),
) as Record<CommandName, string>
