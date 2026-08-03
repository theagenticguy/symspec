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
 * ## Why `ops` is empty for every G2a reason, and that is not a stub
 *
 * `Repair.ops` are ready-to-apply document-op records (the JSONL stream `import`
 * consumes). Every G2a demotion discharges through a COMMAND, not an op record,
 * and for a reason worth stating: the discharges are `glossary add` / `antonym add`
 * / `waive add` / a human rewrite, and the first three are commands whose op
 * records do not exist until the G2b ops land. Emitting a speculative op record
 * for a command whose shape is not yet fixed would be a guess an agent would then
 * apply. An empty `ops` with a correct `commands` is the honest shape; G2b fills
 * `ops` when the op vocabulary is real.
 *
 * The one reason with NO command at all is `uncovered-requirement`: the discharge
 * is a human rewrite ("share guard/response vocabulary"), and there is no command
 * that performs it. Synthesizing `symspec update …` there would be inventing
 * content. So it gets a repair with two empty arrays, which the envelope helper
 * OMITS — absence of a repair is the honest signal that no mechanical fix exists.
 */

import type { Repair } from '../kernel/envelope.ts'
import type { CheckFinding, CoverageDemotion } from './donor/pipeline/check.ts'
import type { Exclusion } from './donor/pipeline/gate.ts'

/** The reason strings a {@link CoverageDemotion} may carry. */
export type DemotionReason = CoverageDemotion['reason']

/**
 * The run-scoped facts a repair needs beyond the demotion itself.
 *
 * `exclusionsById` is the join that resolves `<blocking-code>`: the AC-3-7 gate
 * recorded the blocking findings as evidence, and this is how they reach the
 * repair. `findingsById` resolves the verb/quantity pairs an
 * `antonym add`/`glossary add` command needs.
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
  /** The document path, so every command is copy-pasteable as-is. */
  readonly docPath: string
}

/** A repair with nothing in it — the honest shape when no mechanical fix exists. */
const NO_REPAIR: Repair = { ops: [], commands: [] }

/**
 * Suggest a doubled budget, floored so a tiny budget does not suggest a tinier
 * one. Doubling rather than a fixed number because the right budget scales with
 * the document, and the run's own figure is the only evidence available.
 */
const raisedBudget = (current: number | undefined): number =>
  current === undefined ? 10_000 : Math.max(2_000, current * 2)

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
      // becomes a CONCRETE waive command. One per code, because waiving is
      // per-code and an agent should be able to discharge them one at a time and
      // re-check between.
      const codes = [...new Set(exclusion.findings.map((f) => f.code))].sort()
      return {
        ops: [],
        commands: [
          // Look first: the honest primary repair is to fix the sentence, and an
          // agent cannot rewrite what it has not read.
          `symspec show ${id} ${context.docPath}`,
          ...codes.map(
            (code) =>
              `symspec waive add ${code} --ref ${id} --reason "reviewed: <why this finding does not apply>" ${context.docPath}`,
          ),
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
        ops: [],
        commands: [
          `symspec waive add FND_RELATIONAL_UNCHECKED --reason "hand-verified: <the aggregate/relational constraint you checked>" ${context.docPath}`,
          `symspec check ${context.docPath}`,
        ],
      }

    // ---------------------------------------------------------------------
    // Run-scoped reasons: the repair is a different INVOCATION, not an edit
    // ---------------------------------------------------------------------
    case 'solver-budget-exhausted':
      return {
        ops: [],
        commands: [
          `symspec check ${context.docPath} --solver-budget-ms ${raisedBudget(context.solverBudgetMs)}`,
        ],
      }

    case 'semantic-tier-skipped':
      // G2a ships no semantic tier, so the repair is the command that WILL supply
      // it. Named as the future invocation rather than omitted, because an agent
      // reading a demotion needs to know the tier is absent by configuration — not
      // that its document is at fault. G2b makes this command real.
      return { ops: [], commands: [`symspec check ${context.docPath} --semantic`] }

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
 * Extract the runnable command a propose-only finding already names, plus the
 * re-check that closes the loop.
 *
 * The semantic/quantity-alias findings BUILD their suggested invocation into their
 * message with the real verb heads or quantity labels substituted (see
 * `donor/formal/semantic.ts` and `donor/formal/quantity-alias.ts`). So the command
 * is READ from the finding, never reconstructed — which means it cannot drift from
 * what the finding advises, and a future change to the advice propagates for free.
 *
 * Backticked-command extraction rather than a bespoke field on the finding: adding
 * a field would edit a transplanted tier file and break the verbatim guard, for a
 * value the message already contains. When the ops land in G2b and findings carry
 * structured suggestions natively, this parse goes away.
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
  const commands = extractSymspecCommands(finding.message)
  if (commands.length === 0) {
    // The finding named no command. Fall back to the reviewed waiver, which is a
    // legitimate discharge for a propose-only candidate the author has triaged.
    return {
      ops: [],
      commands: [
        `symspec waive add ${code} --reason "triaged: <why this candidate is not a conflict>" ${context.docPath}`,
        `symspec check ${context.docPath}`,
      ],
    }
  }
  return { ops: [], commands: [...commands, `symspec check ${context.docPath}`] }
}

/**
 * Pull every backticked `symspec …` invocation out of a finding message, in order,
 * deduplicated.
 *
 * Deliberately narrow: it matches only a backtick-delimited run that STARTS with
 * `symspec `, so surrounding prose, quoted code strings, and inline `code` spans
 * that are not commands are all ignored. A message that mentions two alternatives
 * (`antonym add` if opposites, `glossary add` if synonyms) yields both, in the
 * order the message presents them — which is the order the finding's own reasoning
 * recommends trying them.
 */
const extractSymspecCommands = (message: string): readonly string[] => {
  const found: string[] = []
  for (const match of message.matchAll(/`(symspec [^`]+)`/g)) {
    const command = match[1]
    if (command !== undefined && !found.includes(command)) found.push(command)
  }
  return found
}
