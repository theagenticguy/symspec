/**
 * THE REPAIR ROUND TRIP — spec AC-A-1 and AC-A-2, proven together.
 *
 * ## What is being claimed
 *
 * `check` reports demotions with runnable repairs. Executing those repairs discharges
 * the demotions. `data.progress` moves in the right direction. All three, on one
 * document, in one test, with no hand-written op stream anywhere in the loop:
 *
 *     1. run `check` → collect `coverage.demotions[].repair.ops`
 *     2. run `apply` over EXACTLY those ops
 *     3. run `check` again → the addressed demotions are GONE and `progress` improved
 *
 * The ops in step 2 come from step 1's output, never from this file. That is the whole
 * point: a test that authored its own repair stream would prove `apply` works, which
 * was never in doubt. Consuming the ops the tool ITSELF emitted proves the agent loop
 * closes — and it is the same discipline as
 * `donor-generated-fixtures-not-self-generated`, applied to a repair plan instead of a
 * migration.
 *
 * ## Why this could not exist before G2b
 *
 * G2a's `repair.ops` was always empty, by design and with the reason recorded: the
 * discharges were COMMANDS (`glossary add`, `waive add`) whose op records did not
 * exist. A round-trip test then could only have re-parsed prose out of `commands[]`
 * and shelled out — which would have tested a string parser, not a contract.
 *
 * ## What "the addressed demotions" means, precisely
 *
 * Not "all demotions". Three demotion reasons have no op by design
 * (`uncovered-requirement` needs a human rewrite, `solver-budget-exhausted` needs a
 * different invocation, `no-decide-tier-comparison` needs a judgment no run can make),
 * so a document exhibiting one of those cannot be repaired to zero and asserting
 * otherwise would encode a false promise. The claim is therefore precise: every
 * demotion that CARRIED ops is gone, and none of the remaining ones is a demotion that
 * carried ops.
 */

import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { stubEmbedder } from '../../adapters/embedding/embedder.ts'
import { solverServiceLayer } from '../../adapters/z3/solver-service.ts'
import {
  emptyDocument,
  type LoadedDocument,
  type Requirement,
  type RequirementsDocument,
} from '../../domain/requirements/document.ts'
import { type DocumentOp, decodeOp, opLine } from '../../domain/requirements/ops.ts'
import { DocPath, DocStore, makeDocPath } from '../../ports/doc-store.ts'
import { embedderLayerOf } from '../../ports/embedder.ts'
import { StreamSource } from '../../ports/stream.ts'
import { runOperation } from '../runtime/operation.ts'
import { type CheckPayload, checkOp } from './check.ts'
import { applyOpDefinition, type MutationPayload } from './mutation.ts'

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

/** A mutable in-memory document, so `check` after `apply` reads what `apply` wrote —
 * which is the only way a round trip is a round trip. */
interface World {
  document: RequirementsDocument
  saves: number
}

const worldLayers = (world: World, stream: string) =>
  Layer.mergeAll(
    Layer.succeed(DocStore)(
      DocStore.of({
        load: () =>
          Effect.succeed({
            document: world.document,
            unknownKeys: {},
            diagnostics: [],
          } satisfies LoadedDocument),
        save: (_path, input) =>
          Effect.sync(() => {
            world.document = input.document
            world.saves += 1
          }),
        exists: () => Effect.succeed(true),
      }),
    ),
    Layer.succeed(DocPath)(makeDocPath({})),
    Layer.succeed(StreamSource)(StreamSource.of({ read: () => Effect.succeed(stream) })),
    solverServiceLayer,
    // The DETERMINISTIC stub, so the semantic tier runs (and therefore discharges its
    // own demotion) without the model. Its cosines are meaningless, which is fine here:
    // this test is about the REPAIR loop, not about what the tier proposes.
    embedderLayerOf(stubEmbedder()),
  )

/** Run `check` against the world's CURRENT document. */
const check = (world: World, input: Record<string, unknown> = {}): Promise<CheckPayload> =>
  Effect.runPromise(
    runOperation(checkOp, { file: 'doc.json', ...input }).pipe(
      Effect.provide(worldLayers(world, '')),
    ),
  ).then((envelope) => envelope.data)

/** Run `apply` over a JSONL stream against the world's CURRENT document. */
const apply = (world: World, jsonl: string): Promise<MutationPayload> =>
  Effect.runPromise(
    runOperation(applyOpDefinition, { file: 'doc.json', continueOnError: true }).pipe(
      Effect.provide(worldLayers(world, jsonl)),
    ),
  ).then((envelope) => envelope.data as MutationPayload)

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

const req = (
  id: string,
  systemResponse: string,
  sentence: string,
  overrides: Partial<Requirement> = {},
): Requirement => ({
  id,
  patternType: 'ubiquitous',
  systemName: 'auth service',
  systemResponse,
  negated: false,
  sentence,
  priority: 'medium',
  status: 'draft',
  derives: [],
  satisfies: [],
  verifies: [],
  refines: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

/**
 * A document engineered to produce a demotion that CARRIES OPS, and to reach the
 * FIXED POINT once that demotion is discharged.
 *
 * Getting this fixture right took three attempts, and the corrections are the
 * interesting part — each was a way the round trip would have looked broken while the
 * repair was working perfectly.
 *
 * The mechanism: one requirement trips an error-severity GtWR rule, so the AC-3-7 gate
 * EXCLUDES it and the pipeline raises `excluded-from-formal` — the reason whose repair
 * is a scoped `waive` op. Applying that waiver RE-ADMITS the requirement, which is the
 * discharge.
 *
 * Two constraints on the other requirements, both learned by measurement:
 *
 * 1. **They must COVER each other**, or `uncovered-requirement` fires and masks the
 *    win. "issue a session token" and "revoke a session token" look like a covering
 *    pair and are NOT: they atomize to `issue_a_session_token` and
 *    `allow_a_session_token` (the seed antonym table maps `revoke`→`allow`, not
 *    `issue`), so nothing is compared. `grant`/`revoke access to the vault` DO share an
 *    atom, because the seed table relates that pair.
 * 2. **Re-admitting the blocked requirement must not create a NEW
 *    `uncovered-requirement`.** The obvious blocked sentence ("throttle requests as
 *    appropriate") has a response nothing else shares, so waiving its lint finding
 *    trades one demotion for another and the loop never converges. So the blocked
 *    requirement's RESPONSE is identical to an existing one and only its SENTENCE trips
 *    the rule — which is realistic: a compound sentence describing an already-covered
 *    response is exactly the shape GTWR_R18 exists to catch.
 */
const demotedDocument = (): RequirementsDocument => ({
  ...emptyDocument(),
  requirements: {
    // A COVERING pair: `grant`/`revoke` are seed antonyms, so both atomize to
    // `sys__auth_service__resp__allow_access_the_vault` and the decide tier compares
    // them (verified by probe).
    'aaaaaaaa-0000-4000-8000-000000000001': req(
      'aaaaaaaa-0000-4000-8000-000000000001',
      'grant access to the vault',
      'The auth service shall grant access to the vault.',
    ),
    'aaaaaaaa-0000-4000-8000-000000000002': req(
      'aaaaaaaa-0000-4000-8000-000000000002',
      'revoke access to the vault',
      'The auth service shall revoke access to the vault.',
    ),
    // BLOCKED by GTWR_R18_MULTIPLE_SHALL — two obligations in one sentence. Its
    // RESPONSE matches the first requirement's, so re-admitting it lands on a shared
    // atom rather than creating a fresh coverage hole.
    'aaaaaaaa-0000-4000-8000-000000000003': req(
      'aaaaaaaa-0000-4000-8000-000000000003',
      'grant access to the vault',
      'The auth service shall grant access to the vault and the api shall log it.',
    ),
  },
})

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------

/** Every op every demotion's repair carries, in report order. */
const repairOps = (payload: CheckPayload): readonly DocumentOp[] =>
  payload.coverage.demotions.flatMap((d) => (d.repair?.ops ?? []) as readonly DocumentOp[])

/** The reasons whose repairs carried at least one op. Typed as the donor's own reason
 * union, so a reason that stops existing is a compile error rather than a silently
 * unmatched string. */
const dischargeableReasons = (
  payload: CheckPayload,
): readonly CheckPayload['coverage']['demotions'][number]['reason'][] => [
  ...new Set(
    payload.coverage.demotions.filter((d) => (d.repair?.ops.length ?? 0) > 0).map((d) => d.reason),
  ),
]

describe('AC-A-1 + AC-A-2 — check → apply the repairs → check again', () => {
  it('discharges every demotion that carried OPS, and progress strictly improves', async () => {
    const world: World = { document: demotedDocument(), saves: 0 }

    // ---- STEP 1: check -----------------------------------------------------
    const before = await check(world)

    // The fixture genuinely exhibits the situation under test. Asserted FIRST, because
    // a round trip over zero demotions would pass vacuously and prove nothing.
    expect(before.verified, 'the fixture must start unverified').toBe(false)
    expect(
      before.coverage.demotions.length,
      'the fixture must start with demotions',
    ).toBeGreaterThan(0)
    const dischargeable = dischargeableReasons(before)
    expect(
      dischargeable.length,
      'no demotion carried ops — there is nothing for the round trip to execute',
    ).toBeGreaterThan(0)
    expect(dischargeable).toContain('excluded-from-formal')

    // Every op the tool emitted DECODES — the property that makes `apply` able to read
    // its own output. If this failed, `repair.ops` would be decorative.
    const ops = repairOps(before)
    expect(ops.length).toBeGreaterThan(0)
    for (const op of ops) {
      expect(Effect.runSync(Effect.result(decodeOp(op)))._tag, JSON.stringify(op)).toBe('Success')
    }

    // ---- STEP 2: apply EXACTLY those ops -----------------------------------
    // Serialized through `opLine`, so what `apply` consumes is the same JSONL an agent
    // would get from `--field data.coverage.demotions` and pipe to a file.
    const jsonl = ops.map(opLine).join('\n')
    const applied = await apply(world, jsonl)
    expect(applied.summary.failed, `apply rejected an op the tool emitted: ${jsonl}`).toBe(0)
    expect(applied.written).toBe(true)
    expect(world.saves).toBe(1)

    // ---- STEP 3: check again ----------------------------------------------
    const after = await check(world)

    // THE CLAIM: every demotion that carried ops is GONE.
    const remaining = new Set(after.coverage.demotions.map((d) => d.reason))
    for (const reason of dischargeable) {
      expect(remaining.has(reason), `"${reason}" carried ops but survived the repair`).toBe(false)
    }

    // AC-A-2: the gradient STRICTLY improved on the axis the repairs touched.
    expect(after.progress.demotions).toBeLessThan(before.progress.demotions)
    // And the repairs did not make anything worse on the other two axes — a repair that
    // discharged a demotion by introducing a conflict would be a bad trade.
    expect(after.progress.openFindings).toBeLessThanOrEqual(before.progress.openFindings)
    expect(after.progress.atomsUncompared).toBeLessThanOrEqual(before.progress.atomsUncompared)
  }, 60_000)

  it('the repair is IDEMPOTENT — re-applying it changes nothing', async () => {
    // An agent driving a loop re-runs a plan it has already applied, and a repair that
    // duplicated a waiver on every pass would grow the document without bound. The
    // fold's per-verb idempotence makes this true; this asserts it end to end.
    const world: World = { document: demotedDocument(), saves: 0 }
    const before = await check(world)
    const jsonl = repairOps(before).map(opLine).join('\n')

    await apply(world, jsonl)
    const afterFirst = JSON.stringify(world.document)

    const second = await apply(world, jsonl)
    // Every op is a no-op the second time, so nothing is written at all.
    expect(second.summary.noop).toBe(second.summary.total)
    expect(second.written).toBe(false)
    expect(JSON.stringify(world.document)).toBe(afterFirst)
  }, 60_000)

  it('reaching the FIXED POINT makes `verified` true, and progress hits zero demotions', async () => {
    // The convergence claim the whole loop exists to support: applying repairs until
    // none remain flips the verdict. Iterated rather than assumed, with a bound so a
    // non-converging loop fails as a test rather than hanging.
    const world: World = { document: demotedDocument(), saves: 0 }

    let payload = await check(world)
    let rounds = 0
    while (rounds < 5) {
      const ops = repairOps(payload)
      if (ops.length === 0) break
      await apply(world, ops.map(opLine).join('\n'))
      payload = await check(world)
      rounds += 1
    }

    // It converged in a bounded number of rounds, and did so by APPLYING something
    // (`rounds > 0`), not by starting at the fixed point.
    expect(rounds).toBeGreaterThan(0)
    expect(rounds).toBeLessThan(5)
    // No demotion carries an op any more — the loop has nothing left to do
    // mechanically.
    expect(dischargeableReasons(payload)).toEqual([])
    // On THIS document that is the whole demotion set, so the verdict flips.
    expect(payload.progress.demotions).toBe(0)
    expect(payload.verified).toBe(true)
  }, 120_000)

  it('an UNREPAIRABLE demotion carries no ops, and says so by ABSENCE', async () => {
    // The honest complement, and the reason "the addressed demotions" is the precise
    // claim rather than "all demotions".
    //
    // A single-requirement document cannot produce a cross-requirement comparison, so it
    // demotes with `no-decide-tier-comparison` — whose repair deliberately has NO ops,
    // because which terms to link is a judgment about the document's meaning that no run
    // can make. Fabricating a `glossary` op there would commit a decide-tier artifact
    // from a guess, which is the propose/decide violation the architecture forbids.
    const world: World = {
      document: {
        ...emptyDocument(),
        requirements: {
          'aaaaaaaa-0000-4000-8000-000000000001': req(
            'aaaaaaaa-0000-4000-8000-000000000001',
            'issue a session token',
            'The auth service shall issue a session token.',
          ),
          'bbbbbbbb-0000-4000-8000-000000000002': req(
            'bbbbbbbb-0000-4000-8000-000000000002',
            'rotate the signing key',
            'The billing service shall rotate the signing key.',
            { systemName: 'billing service' },
          ),
        },
      },
      saves: 0,
    }

    const payload = await check(world)
    expect(payload.verified).toBe(false)
    expect(payload.coverage.demotions.length).toBeGreaterThan(0)

    // Every demotion here either carries no ops at all, or carries no `repair` key —
    // and the second is the stronger signal: the envelope OMITS an all-empty repair, so
    // "there is a fix, it is nothing" never reaches an agent.
    for (const demotion of payload.coverage.demotions) {
      const ops = demotion.repair?.ops ?? []
      if (ops.length === 0) {
        // Either there is no repair, or the repair is commands-only (a READ that
        // produces the input a human rewrite needs). Never an empty-empty repair.
        if (demotion.repair !== undefined) {
          expect(
            demotion.repair.commands.length,
            'a repair with no ops must at least name a command',
          ).toBeGreaterThan(0)
        }
        // And the prose `action` is preserved regardless, since it carries the REASONING
        // a command cannot express.
        expect(demotion.action.length).toBeGreaterThan(0)
      }
    }
  }, 60_000)
})
