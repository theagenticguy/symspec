/**
 * `import` — consume a v4 reproduce-op stream into a v3 document.
 *
 * ## This IS the v2 migration story, in one command
 *
 * v3 has no read-compatibility with v2 by design. The migration is not a
 * converter but a REPLAY: v4 already emits, on its `ERR_SCHEMA_VERSION`
 * path, the exact op stream that rebuilds a document — one `add` record per
 * requirement in dependency order, then the edge ops, then shell commands for the
 * three side tables its `apply` had no op for, then an explicit statement of what
 * does NOT reproduce. `import` is the consumer of that stream, so the whole
 * migration is `<v4 reproduce output> | symspec import`.
 *
 * Nothing is guessed. v4's stream is derivable precisely because the
 * document it came from already parsed, and everything the stream cannot carry is
 * DISCLOSED rather than silently approximated.
 *
 * ## One stream, three record kinds
 *
 * v4's own machine contract, honored verbatim (it is stated inside the
 * payload, so an agent can follow it without reading either source):
 *
 * - a line starting with `{` is one JSONL OP RECORD;
 * - a line starting with `symspec ` is a SHELL COMMAND for a side table;
 * - anything else is prose.
 *
 * v5 adds one spelling on top: a `#gap ` line carries a v4 gap forward, so a
 * single file round-trips the disclosures too instead of stranding them in a
 * transcript. Blank lines and any other prose are skipped, because a real stream
 * harvested from `suggestions[]` has step headers in it and failing on prose would
 * make the pipe useless.
 *
 * ## The side tables travel as COMMANDS, and are EXECUTED not just recorded
 *
 * v4 could not express glossary/antonym/waiver rows as `apply` ops, so it
 * emitted them as `symspec glossary add …` / `antonym add …` / `waive add …`
 * command lines. Discarding them would silently drop three tables — the hex-bonk
 * `agent-run-triggers` document alone carries 8 reasoned waivers, and losing them
 * would resurrect 8 knowingly-accepted findings on the next `check`. So `import`
 * PARSES and EXECUTES those command lines into the document it is building.
 *
 * That is deliberately a narrow, closed parser over three known command shapes,
 * not a shell. It recognizes exactly what v4 emits and reports anything
 * else as unrecognized rather than attempting it.
 *
 * ## Forward references by key, and why order still does not matter
 *
 * v4 emits edge ops AFTER every `add`, so a naive in-order fold works. But
 * a hand-written or reordered stream should not silently lose edges, so `import`
 * folds in TWO PASSES: every `add` first, then every edge and command. An edge
 * therefore resolves against the COMPLETE requirement set, and a `to` written as a
 * stable key resolves even if the target was added later in the file.
 *
 * ## Where the stream comes from
 *
 * `StreamSource` (`./stream.ts`) — a service, so this operation is unit-testable
 * without a subprocess. It lived in THIS file through G1b, when `import` was its
 * only consumer; G2b's `parse` and `apply` read text the same way, so it moved
 * rather than having them depend on `import` for a reason no reader could infer.
 *
 * ## Unresolvable edges are DROPPED and DISCLOSED, never invented
 *
 * An edge whose `from` or `to` names nothing in the finished document cannot be
 * written: v3 requires edge targets to be UUIDs, and fabricating one would put a
 * dangling reference in the file while claiming a successful import. Such an edge
 * is dropped and reported in `unresolved[]` with the ref that failed. That mirrors
 * v4's own treatment of dangling edges in its reproduce plan — disclose,
 * do not paper over.
 */

import { Effect, Schema } from 'effect'
import {
  type AntonymPair,
  DOC_VERSION,
  EARS_PATTERNS,
  emptyDocument,
  type GlossaryEntry,
  PRIORITIES,
  RELATIONS,
  RESPONSE_KINDS,
  type Relation,
  type Requirement,
  type RequirementsDocument,
  STATUSES,
  VERIFICATION_METHODS,
  type Waiver,
} from '../../domain/requirements/document.ts'
import { renderSentence } from '../../domain/requirements/render.ts'
import { resolveId } from '../../domain/requirements/resolve.ts'
import { DOC_PATH_CONVENTION, DocPath, DocStore } from '../../ports/doc-store.ts'
import { ErrDocExists, ErrUsage } from '../../ports/errors.ts'
import { StreamSource } from '../../ports/stream.ts'
import { ok } from '../runtime/envelope.ts'
import { defineOperation } from '../runtime/operation.ts'

// ---------------------------------------------------------------------------
// The op-record schema
// ---------------------------------------------------------------------------

/** The four edge-creating op verbs → the schema relation each adds.
 *
 * The INVERSE of v4's `RELATION_REPRODUCE_OP`. Typed as a total
 * `Record<…, Relation>` so adding a relation to `RELATIONS` fails to compile until
 * this table is extended — the same construction v4 used to keep its two
 * tables from drifting, and `import.test.ts` asserts they are exact inverses. */
export const EDGE_OP_RELATION: Record<'derive' | 'satisfy' | 'verify' | 'refine', Relation> = {
  derive: 'derives',
  satisfy: 'satisfies',
  verify: 'verifies',
  refine: 'refines',
}

/** The edge op verbs, derived from the table so the two cannot disagree. */
export const EDGE_OPS = Object.keys(EDGE_OP_RELATION) as readonly (keyof typeof EDGE_OP_RELATION)[]

/**
 * One `{"op":"add", …}` record.
 *
 * Mirrors v4's `ReproduceAddOp` field for field, plus `responseKind` — the
 * v3 field v4 cannot emit but a hand-written or v5-generated stream can, so
 * an import is not artificially limited to what v2 could express.
 *
 * `id` is OPTIONAL: v4 always carries the original UUID (which is what
 * keeps a UUID-scoped waiver and every reproduced edge resolving), but a
 * hand-written stream authoring NEW requirements should not have to mint UUIDs.
 * When absent one is derived deterministically — see {@link derivedId}.
 *
 * Decoded with `{onExcessProperty:'error'}`, so a misspelled op field is a loud
 * per-record failure rather than a silently dropped value. That is the whole
 * reason this is a schema and not a cast.
 */
const AddOp = Schema.Struct({
  op: Schema.Literal('add'),
  id: Schema.optionalKey(Schema.String),
  key: Schema.optionalKey(Schema.String),
  patternType: Schema.Literals(EARS_PATTERNS),
  preCondition: Schema.optionalKey(Schema.String),
  trigger: Schema.optionalKey(Schema.String),
  systemName: Schema.String,
  systemResponse: Schema.String,
  negated: Schema.optionalKey(Schema.Boolean),
  responseKind: Schema.optionalKey(Schema.Literals(RESPONSE_KINDS)),
  priority: Schema.optionalKey(Schema.Literals(PRIORITIES)),
  status: Schema.optionalKey(Schema.Literals(STATUSES)),
  verificationMethod: Schema.optionalKey(Schema.Literals(VERIFICATION_METHODS)),
  verificationNote: Schema.optionalKey(Schema.String),
})

/** One edge op record. `from`/`to` accept a UUID OR a stable key — resolution goes
 * through the same `resolveId` chokepoint everything else uses. */
const EdgeOp = Schema.Struct({
  op: Schema.Literals(['derive', 'satisfy', 'verify', 'refine']),
  from: Schema.String,
  to: Schema.String,
})

/** A structured side-table record — the alternative to v4's command lines,
 * for a producer that would rather emit JSON than shell. Same effect either way. */
const GlossaryOp = Schema.Struct({
  op: Schema.Literal('glossary'),
  canonical: Schema.String,
  alias: Schema.String,
})

const AntonymOp = Schema.Struct({
  op: Schema.Literal('antonym'),
  a: Schema.String,
  b: Schema.String,
})

const WaiveOp = Schema.Struct({
  op: Schema.Literal('waive'),
  code: Schema.String,
  reason: Schema.String,
  ref: Schema.optionalKey(Schema.String),
})

/** Every op record kind, as one union. */
const ImportOp = Schema.Union([AddOp, EdgeOp, GlossaryOp, AntonymOp, WaiveOp])
type ImportOp = typeof ImportOp.Type
type AddOpRecord = typeof AddOp.Type

const decodeOp = Schema.decodeUnknownEffect(ImportOp, { onExcessProperty: 'error' })

// ---------------------------------------------------------------------------
// Parsing the stream
// ---------------------------------------------------------------------------

/** What one non-op line of the stream turned out to be. */
type ParsedLine =
  | { readonly kind: 'op'; readonly line: number; readonly raw: unknown }
  | { readonly kind: 'command'; readonly line: number; readonly text: string }
  | { readonly kind: 'gap'; readonly text: string }
  | { readonly kind: 'skip' }

/** One line that could not be understood, with enough context to fix it. */
interface StreamProblem {
  readonly line: number
  readonly detail: string
}

/**
 * Classify each line of the stream.
 *
 * Prose is SKIPPED rather than rejected, because a real stream harvested from a
 * v4 `suggestions[]` array is interleaved with step headers ("Step 2 — write
 * the following 47 op record(s)…"). Failing on prose would make the one-pipe
 * migration impossible; silently skipping an op record would be much worse, which
 * is why the `{`-prefix rule is v4's own published contract rather than a
 * heuristic.
 *
 * A line that STARTS with `{` but is not valid JSON is a genuine problem and is
 * reported — that is a corrupted op record, not prose.
 */
const classifyLine = (raw: string, line: number): ParsedLine | StreamProblem => {
  const text = raw.trim()
  if (text.length === 0) return { kind: 'skip' }
  if (text.startsWith('#gap ')) return { kind: 'gap', text: text.slice('#gap '.length).trim() }
  if (text.startsWith('#')) return { kind: 'skip' }
  if (text.startsWith('{')) {
    try {
      return { kind: 'op', line, raw: JSON.parse(text) as unknown }
    } catch (cause) {
      return {
        line,
        detail: `Line starts with "{" but is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      }
    }
  }
  if (text.startsWith('symspec ')) return { kind: 'command', line, text }
  return { kind: 'skip' }
}

/** Narrow a classified line to the problem branch. */
const isProblem = (value: ParsedLine | StreamProblem): value is StreamProblem => !('kind' in value)

// ---------------------------------------------------------------------------
// Side-table command parsing
// ---------------------------------------------------------------------------

/**
 * Split a command line into shell-ish tokens, honoring single quotes.
 *
 * A NARROW tokenizer, matching exactly what v4's `quoteArg` produces:
 * bare tokens when unambiguous, single-quoted otherwise, with an embedded quote
 * written `'\''`. It is not a shell and must not become one — the values here are
 * arbitrary human prose (a waiver reason is a whole sentence), and the only thing
 * needed is to get that prose back out of one line intact.
 */
export const tokenizeCommand = (line: string): readonly string[] => {
  const tokens: string[] = []
  let current = ''
  let inQuote = false
  let started = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (inQuote) {
      if (ch === "'") {
        // v4 writes an embedded quote as '\'' — closing the quote, emitting
        // an escaped quote, reopening. Detect that exact sequence and fold it back
        // into one literal quote character.
        if (line.slice(i, i + 4) === `'\\''`) {
          current += "'"
          i += 3
          continue
        }
        inQuote = false
        continue
      }
      current += ch
      continue
    }
    if (ch === "'") {
      inQuote = true
      started = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (started) tokens.push(current)
      current = ''
      started = false
      continue
    }
    current += ch
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

/**
 * Read a `--flag value` pair out of a token list, returning the value and the
 * tokens with the pair removed. Returns `undefined` for the value when the flag is
 * absent or has nothing after it.
 */
const takeFlag = (
  tokens: readonly string[],
  flag: string,
): { readonly value: string | undefined; readonly rest: readonly string[] } => {
  const idx = tokens.indexOf(flag)
  if (idx === -1 || idx + 1 >= tokens.length) return { value: undefined, rest: tokens }
  return {
    value: tokens[idx + 1],
    rest: [...tokens.slice(0, idx), ...tokens.slice(idx + 2)],
  }
}

/**
 * Parse one v4 side-table command into the op record it is equivalent to.
 *
 * The three recognized shapes, exactly as `reproduce.ts` emits them:
 *
 *   symspec glossary add <canonical> <alias>
 *   symspec antonym add <a> <b>
 *   symspec waive add <code> --reason <reason> [--ref <uuid>]
 *
 * Anything else returns `undefined` and is reported as unrecognized — a closed
 * parser that says "I do not know this" beats an open one that half-executes
 * something.
 */
export const parseSideTableCommand = (line: string): ImportOp | undefined => {
  const tokens = tokenizeCommand(line)
  if (tokens[0] !== 'symspec' || tokens[2] !== 'add') return undefined
  const subject = tokens[1]

  if (subject === 'glossary') {
    const [canonical, alias] = [tokens[3], tokens[4]]
    if (canonical === undefined || alias === undefined) return undefined
    return { op: 'glossary', canonical, alias }
  }

  if (subject === 'antonym') {
    const [a, b] = [tokens[3], tokens[4]]
    if (a === undefined || b === undefined) return undefined
    return { op: 'antonym', a, b }
  }

  if (subject === 'waive') {
    const afterReason = takeFlag(tokens, '--reason')
    const afterRef = takeFlag(afterReason.rest, '--ref')
    const code = afterRef.rest[3]
    if (code === undefined || afterReason.value === undefined) return undefined
    return {
      op: 'waive',
      code,
      reason: afterReason.value,
      ...(afterRef.value !== undefined ? { ref: afterRef.value } : {}),
    }
  }

  return undefined
}

// ---------------------------------------------------------------------------
// Folding ops into a document
// ---------------------------------------------------------------------------

/**
 * A deterministic UUID for an `add` op that carries none.
 *
 * v5 (like v4) refuses to mint a RANDOM id during an import, because a
 * random id makes the same input produce a different document on every run — which
 * would break the determinism claim the whole tool rests on, and make an import
 * impossible to diff. Instead the id is DERIVED from the record's identifying
 * content (its key if it has one, else its EARS slots) via a stable hash, so
 * re-importing the same stream produces byte-identical output.
 *
 * `deriveUuidV5`-shaped output without a crypto dependency: a 128-bit value from a
 * doubled FNV-1a over the content, formatted with the version-4 nibbles so it
 * satisfies the document schema's UUID check. Collision risk is irrelevant at
 * document scale, and the input is content the author chose — two requirements with
 * identical slots and no key ARE the same requirement, so colliding is arguably
 * correct.
 */
const derivedId = (op: AddOpRecord): string => {
  const seed =
    op.key !== undefined
      ? `key:${op.key}`
      : `slots:${op.patternType}|${op.systemName}|${op.systemResponse}|${op.preCondition ?? ''}|${op.trigger ?? ''}`
  const hex = (offset: number): string => {
    let h = 0x811c9dc5 ^ offset
    for (let i = 0; i < seed.length; i += 1) {
      h ^= seed.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h.toString(16).padStart(8, '0')
  }
  const a = hex(0)
  const b = hex(1)
  const c = hex(2)
  const d = hex(3)
  // Version nibble 4 and variant nibble 8 so the result is a well-formed UUIDv4
  // by shape — which is what the schema's `isUUID` check requires.
  return `${a}-${b.slice(0, 4)}-4${b.slice(5, 8)}-8${c.slice(1, 4)}-${c.slice(4, 8)}${d}`
}

/** The accumulating result of a fold. */
interface FoldState {
  readonly document: RequirementsDocument
  readonly requirements: Record<string, Requirement>
  readonly glossary: GlossaryEntry[]
  readonly antonyms: AntonymPair[]
  readonly waivers: Waiver[]
  readonly unresolved: { readonly op: string; readonly ref: string; readonly detail: string }[]
  readonly duplicates: string[]
}

/** Add one requirement, or report a duplicate id/key rather than overwriting. */
const applyAdd = (state: FoldState, op: AddOpRecord, timestamp: string): void => {
  const id = op.id ?? derivedId(op)

  if (state.requirements[id] !== undefined) {
    state.duplicates.push(`id ${id}`)
    return
  }
  if (op.key !== undefined) {
    const taken = Object.values(state.requirements).some((r) => r.key === op.key)
    if (taken) {
      state.duplicates.push(`key ${op.key}`)
      return
    }
  }

  const negated = op.negated ?? false
  const requirement: Requirement = {
    id,
    ...(op.key !== undefined ? { key: op.key } : {}),
    patternType: op.patternType,
    ...(op.preCondition !== undefined ? { preCondition: op.preCondition } : {}),
    ...(op.trigger !== undefined ? { trigger: op.trigger } : {}),
    systemName: op.systemName,
    systemResponse: op.systemResponse,
    negated,
    ...(op.responseKind !== undefined ? { responseKind: op.responseKind } : {}),
    // `sentence` is RE-RENDERED, never carried on the op — v4 deliberately
    // omits it because it is a denormalized view of the slots, so it comes back
    // for free and cannot arrive inconsistent with the slots it describes.
    sentence: renderSentence({
      patternType: op.patternType,
      preCondition: op.preCondition,
      trigger: op.trigger,
      systemName: op.systemName,
      systemResponse: op.systemResponse,
      negated,
    }),
    priority: op.priority ?? 'medium',
    status: op.status ?? 'draft',
    ...(op.verificationMethod !== undefined ? { verificationMethod: op.verificationMethod } : {}),
    ...(op.verificationNote !== undefined ? { verificationNote: op.verificationNote } : {}),
    derives: [],
    satisfies: [],
    verifies: [],
    refines: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  state.requirements[id] = requirement
}

/**
 * Add one edge, resolving both endpoints through the single chokepoint.
 *
 * Idempotent: adding an edge that is already present is a no-op, so replaying a
 * stream never produces a duplicate edge. An endpoint that resolves to nothing is
 * DROPPED and disclosed — writing it would put a non-UUID in an edge array (which
 * the schema rejects) or a dangling reference in the file (which would make the
 * import a lie).
 */
const applyEdge = (state: FoldState, op: typeof EdgeOp.Type): void => {
  const snapshot: RequirementsDocument = { ...state.document, requirements: state.requirements }
  const relation = EDGE_OP_RELATION[op.op]
  const fromId = resolveId(snapshot, op.from)
  const toId = resolveId(snapshot, op.to)

  if (fromId === undefined) {
    state.unresolved.push({
      op: op.op,
      ref: op.from,
      detail: `The \`from\` ref "${op.from}" matches no imported requirement (tried as a UUID, then as a stable key), so the ${relation} edge to "${op.to}" was NOT created.`,
    })
    return
  }
  if (toId === undefined) {
    state.unresolved.push({
      op: op.op,
      ref: op.to,
      detail: `The \`to\` ref "${op.to}" matches no imported requirement (tried as a UUID, then as a stable key), so the ${relation} edge from "${op.from}" was NOT created.`,
    })
    return
  }

  const source = state.requirements[fromId]
  if (source === undefined) return
  if (source[relation].includes(toId)) return
  state.requirements[fromId] = { ...source, [relation]: [...source[relation], toId] }
}

/** Apply a glossary record, merging aliases into an existing canonical entry
 * rather than creating a second entry for the same phrase — v4 emits one
 * command PER ALIAS, so a naive append would produce N single-alias entries where
 * the source document had one N-alias entry. */
const applyGlossary = (state: FoldState, op: typeof GlossaryOp.Type): void => {
  const existing = state.glossary.find((e) => e.canonical === op.canonical)
  if (existing === undefined) {
    state.glossary.push({ canonical: op.canonical, aliases: [op.alias] })
    return
  }
  if (existing.aliases.includes(op.alias)) return
  state.glossary[state.glossary.indexOf(existing)] = {
    canonical: existing.canonical,
    aliases: [...existing.aliases, op.alias],
  }
}

/** Apply an antonym record. The pair is UNORDERED, so (a,b) and (b,a) are the same
 * entry and the second is a no-op. */
const applyAntonym = (state: FoldState, op: typeof AntonymOp.Type): void => {
  const present = state.antonyms.some(
    (p) => (p.a === op.a && p.b === op.b) || (p.a === op.b && p.b === op.a),
  )
  if (!present) state.antonyms.push({ a: op.a, b: op.b })
}

/**
 * Apply a waiver record, resolving an optional requirement scope through the same
 * chokepoint so a scope written as a key lands as the UUID the schema requires.
 *
 * A scope that does not resolve drops the SCOPE, not the waiver: an unscoped
 * waiver is broader than intended but still suppresses the finding the author
 * decided to accept, whereas dropping the waiver would resurrect a
 * knowingly-accepted finding. The widening is disclosed in `unresolved[]`.
 */
const applyWaive = (state: FoldState, op: typeof WaiveOp.Type): void => {
  if (op.ref === undefined) {
    state.waivers.push({ code: op.code, reason: op.reason })
    return
  }
  const snapshot: RequirementsDocument = { ...state.document, requirements: state.requirements }
  const scoped = resolveId(snapshot, op.ref)
  if (scoped === undefined) {
    state.unresolved.push({
      op: 'waive',
      ref: op.ref,
      detail: `The waiver scope "${op.ref}" matches no imported requirement, so the waiver for ${op.code} was imported UNSCOPED (document-wide) rather than dropped — dropping it would resurrect a finding someone reviewed and accepted.`,
    })
    state.waivers.push({ code: op.code, reason: op.reason })
    return
  }
  state.waivers.push({ code: op.code, requirementId: scoped, reason: op.reason })
}

/** What the fold produced. */
export interface ImportResult {
  readonly document: RequirementsDocument
  readonly counts: {
    readonly requirements: number
    readonly edges: number
    readonly glossary: number
    readonly antonyms: number
    readonly waivers: number
  }
  readonly opsRead: number
  readonly commandsRead: number
  readonly linesSkipped: number
  readonly gaps: readonly string[]
  readonly unresolved: readonly {
    readonly op: string
    readonly ref: string
    readonly detail: string
  }[]
  readonly duplicates: readonly string[]
  readonly problems: readonly StreamProblem[]
}

/**
 * Fold a whole op stream into a v3 document. Pure apart from the supplied
 * `timestamp`, which is injected rather than read from a clock so an import is
 * reproducible and testable.
 *
 * TWO PASSES: every `add` first, then every edge and side-table record. That is
 * what makes a forward key reference resolve regardless of line order — v4
 * already emits dependency-ordered streams, but a hand-written one should not
 * silently lose edges for putting them first.
 */
export const foldImportStream = (
  text: string,
  timestamp: string,
): Effect.Effect<ImportResult, never> =>
  Effect.gen(function* () {
    const classified = text.split('\n').map((line, i) => classifyLine(line, i + 1))
    const problems: StreamProblem[] = classified.filter(isProblem)
    const lines = classified.filter((c): c is ParsedLine => !isProblem(c))

    const gaps = lines.filter((l) => l.kind === 'gap').map((l) => l.text)
    const linesSkipped = lines.filter((l) => l.kind === 'skip').length
    const commandLines = lines.filter(
      (l): l is Extract<ParsedLine, { kind: 'command' }> => l.kind === 'command',
    )
    const opLines = lines.filter((l): l is Extract<ParsedLine, { kind: 'op' }> => l.kind === 'op')

    // Decode every op record. A record that fails the schema is a PROBLEM, not a
    // crash: an import over 82 records should report the one bad line, not abort
    // and leave the caller guessing which.
    const ops: { readonly line: number; readonly op: ImportOp }[] = []
    for (const entry of opLines) {
      const decoded = yield* Effect.result(decodeOp(entry.raw))
      if (decoded._tag === 'Failure') {
        problems.push({
          line: entry.line,
          detail: `Op record rejected: ${String(decoded.failure).replace(/\s*\n\s*/g, ' ')}`,
        })
        continue
      }
      ops.push({ line: entry.line, op: decoded.success })
    }

    // Side-table commands become ops, so both spellings converge on one code path.
    for (const entry of commandLines) {
      const parsed = parseSideTableCommand(entry.text)
      if (parsed === undefined) {
        problems.push({
          line: entry.line,
          detail: `Unrecognized \`symspec\` command; import understands only \`glossary add\`, \`antonym add\`, and \`waive add\`: ${entry.text}`,
        })
        continue
      }
      ops.push({ line: entry.line, op: parsed })
    }

    const state: FoldState = {
      document: emptyDocument(),
      requirements: {},
      glossary: [],
      antonyms: [],
      waivers: [],
      unresolved: [],
      duplicates: [],
    }

    // PASS 1 — every requirement, so pass 2 resolves against the complete set.
    for (const { op } of ops) if (op.op === 'add') applyAdd(state, op, timestamp)

    // PASS 2 — edges and side tables.
    for (const { op } of ops) {
      switch (op.op) {
        case 'add':
          break
        case 'derive':
        case 'satisfy':
        case 'verify':
        case 'refine':
          applyEdge(state, op)
          break
        case 'glossary':
          applyGlossary(state, op)
          break
        case 'antonym':
          applyAntonym(state, op)
          break
        case 'waive':
          applyWaive(state, op)
          break
      }
    }

    const document: RequirementsDocument = {
      ...state.document,
      requirements: state.requirements,
      glossary: state.glossary,
      antonyms: state.antonyms,
      waivers: state.waivers,
    }

    let edges = 0
    for (const r of Object.values(state.requirements)) {
      for (const relation of RELATIONS) edges += r[relation].length
    }

    return {
      document,
      counts: {
        requirements: Object.keys(state.requirements).length,
        edges,
        glossary: state.glossary.length,
        antonyms: state.antonyms.length,
        waivers: state.waivers.length,
      },
      opsRead: opLines.length,
      commandsRead: commandLines.length,
      linesSkipped,
      gaps,
      unresolved: state.unresolved,
      duplicates: state.duplicates,
      problems,
    }
  })

// ---------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------

/**
 * `import` — build a v3 document from an op stream on stdin or `--file`.
 *
 * ## It refuses to clobber, like `init`
 *
 * The output path is guarded by `ERR_DOC_EXISTS` unless `--force`, for the same
 * reason: an import that silently replaced a hand-authored document would be
 * unrecoverable, and an agent must be able to try one speculatively.
 *
 * ## It reports, it does not judge
 *
 * The payload carries what was imported AND everything that was not: `gaps[]`
 * passed through from v4 verbatim, `unresolved[]` for edges dropped and
 * waiver scopes widened, `duplicates[]` for records that would have overwritten,
 * and `problems[]` for lines it could not read. Every one of those is a fact the
 * caller needs and none of them is a failure — an import that got 82 of 82
 * requirements and disclosed one un-reproducible timestamp gap SUCCEEDED, and
 * saying otherwise would train an agent to ignore the exit code.
 */
export const importOp = defineOperation({
  name: 'import',
  summary: 'Import a reproduce-op stream (JSONL on stdin or --file) into a new v3 document',
  type: 'import',
  input: Schema.Struct({
    file: Schema.withDecodingDefaultKey<Schema.optionalKey<Schema.NullOr<Schema.String>>>(
      Effect.succeed(null),
    )(
      Schema.optionalKey(
        Schema.NullOr(Schema.String).annotate({
          default: null,
          description: [
            'Path to the op-stream file to read. When omitted, the stream is read from STDIN.',
            'The stream is the one the v4 CLI emits on its ERR_SCHEMA_VERSION path: one JSONL',
            '`{"op":…}` record per line, optional `symspec glossary/antonym/waive add` command lines,',
            'and optional `#gap <text>` lines carrying the v4 disclosures forward.',
            'Example: --file ./ops.jsonl',
          ].join('\n'),
        }),
      ),
    ),
    doc: Schema.withDecodingDefaultKey<Schema.optionalKey<Schema.NullOr<Schema.String>>>(
      Effect.succeed(null),
    )(
      Schema.optionalKey(
        Schema.NullOr(Schema.String).annotate({
          default: null,
          description: [
            'Path to WRITE the resulting v3 document to.',
            DOC_PATH_CONVENTION,
            'Example: --doc ./requirements.json',
          ].join('\n'),
        }),
      ),
    ),
    force: Schema.withDecodingDefaultKey<Schema.Boolean>(Effect.succeed(false))(
      Schema.Boolean.annotate({
        default: false,
        description: [
          'Overwrite an existing document at the output path.',
          'Without this, an existing file is an ERR_DOC_EXISTS failure and is left completely intact.',
        ].join('\n'),
      }),
    ),
    dryRun: Schema.withDecodingDefaultKey<Schema.Boolean>(Effect.succeed(false))(
      Schema.Boolean.annotate({
        default: false,
        description: [
          'Read and fold the stream, report exactly what WOULD be imported, and write nothing.',
          'Use this to inspect gaps, unresolved refs, and problems before committing to a file.',
        ].join('\n'),
      }),
    ),
  }),
  handler: (input) =>
    Effect.gen(function* () {
      const docPath = yield* DocPath
      const store = yield* DocStore
      const reader = yield* StreamSource
      const target = docPath.resolve(input.doc)

      if (!input.dryRun && !input.force && (yield* store.exists(target))) {
        return yield* Effect.fail(
          new ErrDocExists({
            error: `A document already exists at ${target}; import refused to overwrite it.`,
            suggestions: [
              'Pass --force to replace it, or --doc <path> to write elsewhere.',
              'Pass --dry-run to see what the import would produce without writing anything.',
              'The existing file was NOT modified.',
            ],
            repair: { ops: [], commands: [`symspec list ${target}`] },
          }),
        )
      }

      const text = yield* reader.read(input.file)
      if (text.trim().length === 0) {
        return yield* Effect.fail(
          new ErrUsage({
            error:
              input.file === null
                ? 'No op stream on stdin. Pipe the records in, or pass --file <path>.'
                : `The op stream at ${input.file} is empty.`,
            suggestions: [
              'Pipe a stream: `<producer> | symspec import --doc ./requirements.json`.',
              'Or read a file: `symspec import --file ./ops.jsonl --doc ./requirements.json`.',
              'The stream is the v4 CLI`s ERR_SCHEMA_VERSION op records, one JSON object per line.',
            ],
          }),
        )
      }

      const timestamp = new Date().toISOString()
      const result = yield* foldImportStream(text, timestamp)

      if (!input.dryRun) yield* store.save(target, { document: result.document })

      return ok('import', {
        path: target,
        docVersion: DOC_VERSION,
        written: !input.dryRun,
        source: input.file ?? 'stdin',
        imported: result.counts,
        stream: {
          opsRead: result.opsRead,
          commandsRead: result.commandsRead,
          linesSkipped: result.linesSkipped,
        },
        // Passed through VERBATIM from v4. These are the things the op
        // stream provably does not carry, and restating them in v5's own words
        // would risk softening a disclosure someone wrote precisely.
        gaps: result.gaps,
        unresolved: result.unresolved,
        duplicates: result.duplicates,
        problems: result.problems,
      })
    }),
})
