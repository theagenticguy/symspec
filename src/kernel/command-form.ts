/**
 * THE COMMAND SURFACE IS FLAT — and one vendored spelling disagrees.
 *
 * Every operation is `symspec <op>` with flags and positionals. None has a nested
 * verb, so `glossary`, `antonym` and `waive` take their arguments POSITIONALLY:
 * `symspec glossary <canonical> <alias>`.
 *
 * The engine tier spells those three with an `add` — `symspec glossary add
 * "a" "b"` — because that is `import`'s v2 op-stream side-table grammar
 * (`operations/import.ts` parses exactly that form off a stream). Two grammars share a
 * spelling and only one of them is a shell command: run the `add` form and `add` binds
 * to the first positional, the extra argument fails, and the CLI prints usage.
 *
 * Both places that publish a command as a COMMAND — `kernel/catalog.ts`, whose
 * `commands` field `explain` and `manifest` hand an agent, and `formal/repair.ts`,
 * whose `repair.commands` the agent contract says to run verbatim — normalize through
 * here. That is why this module is kernel-level rather than living next to either
 * consumer: it is one fact about the CLI's own surface, and two copies of it would be
 * the drift the rest of this tree is built to prevent.
 *
 * Why it matters more than a typo: a command that prints usage exits 0. An agent reads
 * success, concludes the repair applied, re-checks, and finds nothing moved — which is
 * indistinguishable from a repair that was a legitimate no-op. The movement signal the
 * whole loop branches on reads as "change approach" when the truth is "that command
 * does not exist".
 */

/** The three operations whose vendored spelling carries an `add` the CLI rejects. */
const NESTED_VERB = /^symspec (glossary|antonym|waive) add(?=\s|$)/

/**
 * Rewrite a command into the form the CLI accepts.
 *
 * Scoped to {@link NESTED_VERB} on purpose. A general "drop the second word" rule would
 * corrupt `symspec check ./requirements.json`, where the second word is a positional the
 * CLI wants, and `symspec add --pattern-type …`, where `add` IS the operation.
 */
export const runnable = (command: string): string =>
  command.replace(NESTED_VERB, (_, operation: string) => `symspec ${operation}`)

/**
 * Rewrite every backticked `symspec …` span inside a paragraph of advice.
 *
 * The vendored tier writes its remedy into the finding's own `message`, the demotion's
 * `action`, and the coverage row's `suggestion` — prose a human reads and copies out of
 * `--pretty`. Normalizing only the machine `commands` field would leave the tool
 * printing two spellings of one command in adjacent fields of the same envelope, and
 * the one a person actually copies would be the broken one.
 *
 * Only backtick-delimited spans are touched, so surrounding sentences and any requirement
 * text quoted into the message are left exactly as they are.
 */
export const runnableInProse = (prose: string): string =>
  prose.replace(/`(symspec [^`]+)`/g, (_, command: string) => `\`${runnable(command)}\``)
