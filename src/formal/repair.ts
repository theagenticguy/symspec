/**
 * REPAIR SYNTHESIS — turning every demotion into a `{ops[], commands[]}` an agent
 * can apply without reading prose (spec AC-A-1).
 *
 * ## What the donor left to the agent, and what this closes
 *
 * The donor's `CoverageDemotion` carries `action: string` — a paragraph of prose
 * naming the discharging command, e.g.
 *
 *   "Alternatively, `symspec waive add <blocking-code> --ref <id> --reason "…"`"
 *
 * Two things make that a poor agent contract. First, an agent must PARSE prose to
 * find the command, and there is no guarantee the sentence structure is stable.
 * Second — and this is the load-bearing part — `<blocking-code>` is a literal
 * PLACEHOLDER. The pipeline knows exactly which codes blocked the requirement (the
 * gate carried them as evidence), but the demotion's action text does not join
 * them in. So an agent following the instruction verbatim runs
 * `symspec waive add <blocking-code>` and gets a usage error.
 *
 * This module does that join. For every demotion reason, {@link repairForDemotion}
 * returns a `Repair` whose `commands` are RUNNABLE — no placeholders, no prose to
 * parse — resolving `<blocking-code>` from the run's own excluded-requirement
 * evidence and `<a>`/`<b>` from the finding that raised the demotion.
 *
 * The donor's `action` prose is PRESERVED alongside, unchanged. It carries the
 * *reasoning* (why waiving cannot discharge a coverage fact, why re-admission is
 * defensible), which a runnable command cannot express, and dropping it would lose
 * the honesty the demotion-only doctrine rests on. The repair is additive: prose
 * for a human, ops and commands for an agent.
 *
 * ## `ops` are REAL as of G2b (spec AC-A-1)
 *
 * G2a shipped this module with an always-empty `ops` and a header note explaining
 * why: the discharges are `glossary add` / `antonym add` / `waive add`, and those
 * were COMMANDS whose op records did not exist yet. Emitting a speculative record
 * for a shape that was not fixed would have been a guess an agent then applied.
 *
 * `core/ops.ts` fixed the shape, so `ops` now carries the actual `DocumentOp`
 * records — decodable by `apply` BY CONSTRUCTION, since the finding emits from the
 * same union `apply` decodes. That closes the loop the donor could not:
 *
 *     symspec check --field data.coverage.demotions   # read the plan
 *     symspec apply --ops plan.jsonl                  # execute it
 *     symspec check                                   # the demotions are gone
 *
 * `commands` is PRESERVED alongside, and not as legacy. Two of the discharges are
 * genuinely not ops — `--solver-budget-ms` is a different INVOCATION, and a
 * `show`/`list` read is what an agent needs before it can author a rewrite — so a
 * repair that carried only ops would have to either omit those or fabricate an op
 * that performs them.
 *
 * ## Where `ops` is still empty, and why each is honest rather than unfinished
 *
 * - `uncovered-requirement` — the discharge is a REWRITE. No op performs one, and
 *   synthesizing `{"op":"update","attr":"systemResponse","value":"…"}` would mean
 *   inventing the replacement text, which is the one thing a repair must never do.
 *   It carries the two READS that produce the input for a rewrite instead.
 * - `solver-budget-exhausted` — the discharge is a different invocation, not a
 *   document change.
 * - `no-decide-tier-comparison` — WHICH terms to link is a judgment about the
 *   document's meaning that no run can make. A fabricated `glossary` op here would
 *   be the propose/decide violation the whole architecture forbids: it would commit
 *   a decide-tier artifact from a guess.
 *
 * In each case the honest signal is a repair with commands and no ops, or (for a
 * genuinely mechanical-fix-free reason) no repair at all — the envelope helper OMITS
 * an all-empty repair, so "there is a repair, it is nothing" never reaches an agent.
 */

import type { DocumentOp } from '../core/ops.ts'
import type { CheckFinding, CoverageDemotion } from '../donor/pipeline/check.ts'
import type { Exclusion } from '../donor/pipeline/gate.ts'
import { runnable } from '../kernel/command-form.ts'
import type { Repair } from '../kernel/envelope.ts'

/** The reason strings a {@link CoverageDemotion} may carry. */
export type DemotionReason = CoverageDemotion['reason']

/**
 * The run-scoped facts a repair needs beyond the demotion itself.
 *
 * `exclusionsById` is the join that resolves `<blocking-code>`: the AC-3-7 gate
 * recorded the blocking findings as evidence, and this is how they reach the
 * repair. `findingsById` resolves the verb/quantity pairs an `antonym`/`glossary`
 * command needs.
 */
export interface RepairContext {
  /** Gate exclusions, indexed by requirement id — the `<blocking-code>` source. */
  readonly exclusionsById: ReadonlyMap<string, Exclusion>
  /** Every kept finding, so a demotion can reach the finding that raised it. */
  readonly findings: readonly CheckFinding[]
  /**
   * The `--solver-budget-ms` the run used, for the raise-the-budget command.
   *
   * `optionalKey` rather than `number | undefined`: under
   * `exactOptionalPropertyTypes` an unbounded run OMITS the key, which is the same
   * absence-is-absence convention the donor `CheckOptions` uses, so the caller can
   * spread its options straight in with no `undefined` widening.
   */
  readonly solverBudgetMs?: number
  /**
   * The MEASURED budget recommendation from `data.budgetHint`, when the run produced
   * one (G3, AC-A-8).
   *
   * Threaded in rather than recomputed, because the repair command and the hint are
   * two renderings of ONE answer to "what budget should I use" and they must not
   * disagree. G2a's `raisedBudget` doubling is kept as the fallback for a caller with
   * no measurement (a direct library call, a test), so this module still works
   * standalone — but when a hint exists it WINS, and `repair.test.ts` asserts the two
   * numbers are equal rather than merely both plausible.
   */
  readonly recommendedBudgetMs?: number
  /** The document path, so every command is copy-pasteable as-is. */
  readonly docPath: string
}

/** A repair with nothing in it — the honest shape when no mechanical fix exists. */
const NO_REPAIR: Repair = { ops: [], commands: [] }

/**
 * The budget to recommend in a raise-the-budget command.
 *
 * PREFERS the measured recommendation from `data.budgetHint` (G3): that number is
 * extrapolated from the work the run actually completed and the time it actually took,
 * so it lands in one hop where doubling takes several — from a 500ms budget on a
 * 60-requirement document, doubling needs seven `check` runs to reach a working figure
 * and each one pays the full truncated cost.
 *
 * Falls back to the G2a doubling when no measurement is available (a direct library
 * call, a unit test), floored so a tiny budget does not suggest a tinier one. The
 * fallback stays because this module must work without the caller having measured
 * anything — but it is a guess that happens to converge, not evidence, and the header
 * says so.
 */
const raisedBudget = (current: number | undefined, recommended: number | undefined): number =>
  recommended ?? (current === undefined ? 10_000 : Math.max(2_000, current * 2))

/**
 * Build the runnable repair for one demotion.
 *
 * Exhaustive over {@link DemotionReason} by construction: the `switch` returns in
 * every arm and the function's return type has no `undefined`, so adding a reason
 * to the donor's union without handling it here is a compile error rather than a
 * silently repair-less demotion.
 */
export const repairForDemotion = (demotion: CoverageDemotion, context: RepairContext): Repair => {
  switch (demotion.reason) {
    // ---------------------------------------------------------------------
    // THE PLACEHOLDER JOIN — the one the donor left to the agent
    // ---------------------------------------------------------------------
    case 'excluded-from-formal': {
      const id = demotion.requirementIds[0]
      if (id === undefined) return NO_REPAIR
      const exclusion = context.exclusionsById.get(id)
      // A parse failure has no blocking CODE to waive — there is no finding, the
      // sentence simply did not parse. So the only repair is to look at it, which
      // `show` does. Waiving nothing would be the wrong instruction.
      if (exclusion === undefined || exclusion.reason === 'parse-failure') {
        return { ops: [], commands: [`symspec show ${id} ${context.docPath}`] }
      }
      // The join: the gate carried the blocking findings as evidence, so each
      // becomes a CONCRETE waive — one per code, because waiving is per-code and an
      // agent should be able to discharge them one at a time and re-check between.
      const codes = [...new Set(exclusion.findings.map((f) => f.code))].sort()
      return {
        // REAL OPS (G2b). Each is a `{"op":"waive"}` record `apply` decodes, scoped
        // to the excluded requirement so it suppresses that finding THERE rather
        // than document-wide. The reason carries a PLACEHOLDER an agent must replace
        // — deliberately, because a waiver's whole value is its audit trail and
        // synthesizing a justification would be the tool lying on the author's
        // behalf. An agent that applies these unedited commits a visible
        // `<why this finding does not apply>`, which is the honest failure mode.
        ops: codes.map(
          (code) =>
            ({
              op: 'waive',
              code,
              ref: id,
              reason: 'reviewed: <why this finding does not apply>',
            }) satisfies DocumentOp,
        ),
        commands: [
          // Look FIRST: the honest primary repair is to fix the sentence, and an
          // agent cannot rewrite what it has not read. A waiver is the fallback, not
          // the recommendation — which is why the read leads and the ops are second.
          `symspec show ${id} ${context.docPath}`,
          `symspec check ${context.docPath}`,
        ],
      }
    }

    // ---------------------------------------------------------------------
    // Reasons whose discharging command is named by the RAISING FINDING
    // ---------------------------------------------------------------------
    case 'open-opposition-candidate':
      // The finding message carries the two verb heads and the exact
      // `antonym add`/`glossary add` invocation; extracting them is a join on the
      // finding, not a guess.
      return fromFindingMessage(demotion, context, 'FND_OPPOSITION_CANDIDATE')

    case 'quantity-alias-candidate':
      return fromFindingMessage(demotion, context, 'FND_QUANTITY_ALIAS_CANDIDATE')

    case 'relational-reasoning-not-attempted':
      // Aggregate/cross-quantity reasoning was NOT ATTEMPTED — there is no command
      // that attempts it. The only mechanical discharge is a reviewed waiver, which
      // is legitimate here (unlike for a coverage FACT) because the author can
      // genuinely hand-verify the aggregate. So: waive, with the reason slot left
      // for the agent to fill from its own verification.
      return {
        ops: [
          {
            op: 'waive',
            code: 'FND_RELATIONAL_UNCHECKED',
            reason: 'hand-verified: <the aggregate/relational constraint you checked>',
          } satisfies DocumentOp,
        ],
        commands: [`symspec check ${context.docPath}`],
      }

    // ---------------------------------------------------------------------
    // Run-scoped reasons: the repair is a different INVOCATION, not an edit
    // ---------------------------------------------------------------------
    case 'solver-budget-exhausted':
      return {
        ops: [],
        commands: [
          `symspec check ${context.docPath} --solver-budget-ms ${raisedBudget(context.solverBudgetMs, context.recommendedBudgetMs)}`,
        ],
      }

    case 'semantic-tier-skipped':
      // NO OPS, and that is right: the tier was skipped by CONFIGURATION, so the
      // document is not at fault and no document change discharges it. The repair is
      // the invocation that runs the tier. As of G2b `--semantic` defaults ON, so
      // reaching this demotion means someone passed `--semantic=false` or the model
      // was unavailable — hence naming the env var too.
      return {
        ops: [],
        commands: [
          `symspec check ${context.docPath} --semantic`,
          `SYMSPEC_EMBED_ALLOW_REMOTE=1 symspec check ${context.docPath}`,
        ],
      }

    case 'no-decide-tier-comparison':
      // No two requirements shared an atom. The mechanical lever is a glossary or
      // antonym link — but WHICH terms to link is a judgment about the document's
      // meaning that no run can make. So the command is the inspection that lets an
      // agent decide, not a fabricated link.
      return { ops: [], commands: [`symspec list ${context.docPath}`] }

    // ---------------------------------------------------------------------
    // The reason whose repair is INPUT, not an edit
    // ---------------------------------------------------------------------
    case 'uncovered-requirement': {
      // The discharge is a REWRITE: give the requirement vocabulary in common with
      // the requirements it relates to. No command performs a rewrite, and
      // synthesizing `symspec update --system-response "…"` would be inventing the
      // replacement text — the one thing a repair must never do.
      //
      // But "no command fixes this" is not the same as "no command helps". An agent
      // cannot rewrite a requirement it has not read, and it cannot choose shared
      // vocabulary without seeing what the rest of the document says. So the repair
      // is the two READS that produce exactly that input, in the order an agent
      // needs them: the requirement itself, then the document it must blend into.
      //
      // This is the honest middle: every demotion carries a runnable `repair`
      // (AC-A-1), and none of them pretends to author content.
      const id = demotion.requirementIds[0]
      if (id === undefined) return NO_REPAIR
      return {
        ops: [],
        commands: [
          `symspec show ${id} ${context.docPath}`,
          `symspec list ${context.docPath}`,
          `symspec check ${context.docPath}`,
        ],
      }
    }
  }
}

/**
 * Build the repair for a PROPOSE-ONLY candidate, from the finding that raised it.
 *
 * The semantic/quantity-alias findings BUILD their suggested invocation into their
 * message with the real verb heads or quantity labels substituted (see
 * `donor/formal/semantic.ts` and `donor/formal/quantity-alias.ts`). So the advice is
 * READ from the finding, never reconstructed — which means it cannot drift from what
 * the finding says, and a future change to the wording propagates for free.
 *
 * ## The ONE reason this reason's `ops` are only the WAIVER
 *
 * An opposition candidate's message deliberately offers TWO mutually-exclusive
 * remedies — an `antonym` link if the verbs are opposites, a `glossary` link if they
 * are synonyms — with an explicit warning that committing the wrong one MANUFACTURES
 * a false contradiction. Embeddings cannot tell which, because antonyms embed CLOSE.
 *
 * So emitting both as ops would hand an agent a plan that is wrong half the time and
 * catastrophic in one direction, and emitting one would be the tool picking — which is
 * exactly the propose/decide violation the architecture forbids. The commands carry
 * both, in the order the finding recommends trying them, for a reviewer to choose
 * from; the OP is the third, always-safe discharge: a reviewed WAIVER, which records
 * "I triaged this and it is not a conflict" without asserting anything about the
 * vocabulary.
 *
 * That is the honest shape: mechanically applicable where the choice is safe, prose
 * where a human or agent has to decide.
 */
const fromFindingMessage = (
  demotion: CoverageDemotion,
  context: RepairContext,
  code: string,
): Repair => {
  const ids = new Set(demotion.requirementIds)
  const finding = context.findings.find(
    (f) => f.code === code && f.requirementIds.some((id) => ids.has(id)),
  )
  if (finding === undefined) return NO_REPAIR

  // The always-safe discharge, as a real op. Scoped to the requirements the candidate
  // names when there is exactly one, document-wide otherwise — a waiver scoped to the
  // wrong requirement would suppress nothing.
  const scoped = demotion.requirementIds.length === 1 ? demotion.requirementIds[0] : undefined
  const waive: DocumentOp = {
    op: 'waive',
    code,
    reason: 'triaged: <why this candidate is not a conflict>',
    ...(scoped !== undefined ? { ref: scoped } : {}),
  }

  const advice = extractSymspecCommands(finding.message)
  return {
    ops: [waive],
    commands: [
      // The finding's own two alternatives FIRST, because deciding the vocabulary is
      // the better outcome — a committed glossary or antonym link lets the solver
      // PROVE or dismiss the conflict, where a waiver only records that someone
      // looked. The waiver op is the fallback for when neither applies.
      ...advice,
      `symspec check ${context.docPath}`,
    ],
  }
}

/**
 * Pull every backticked `symspec …` invocation out of a finding message, in order,
 * deduplicated, in the form the CLI accepts.
 *
 * Deliberately narrow: it matches only a backtick-delimited run that STARTS with
 * `symspec `, so surrounding prose, quoted code strings, and inline `code` spans
 * that are not commands are all ignored. A message that mentions two alternatives
 * (an antonym link if the verbs are opposites, a glossary link if they are synonyms)
 * yields both, in the order the message presents them — which is the order the
 * finding's own reasoning recommends trying them.
 *
 * ## Why the rewrite lives HERE
 *
 * An agent runs these verbatim — that is the contract this module exists to honour,
 * and the reason the header calls them RUNNABLE. A command that prints usage is
 * worse than no command: the agent reads exit 0, concludes the repair applied, and
 * re-checks to find nothing moved, which is indistinguishable from a repair that was
 * a legitimate no-op. So validity is enforced at the one seam every extracted command
 * passes through, rather than trusted at each of the eight messages that build one.
 *
 * The messages themselves are the frozen vendored tier and cannot be edited, so
 * normalizing on read is also the only place the fix can go. Deduplication happens
 * AFTER the rewrite, so two spellings of one command collapse to one entry.
 */
const extractSymspecCommands = (message: string): readonly string[] => {
  const found: string[] = []
  for (const match of message.matchAll(/`(symspec [^`]+)`/g)) {
    const command = match[1]
    if (command === undefined) continue
    const normalized = runnable(command)
    if (!found.includes(normalized)) found.push(normalized)
  }
  return found
}
