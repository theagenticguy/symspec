import type { Command } from 'commander'
import { describe, expect, it } from 'vitest'
import { program } from '../index.js'
import { buildManifest } from '../manifest.js'

/**
 * Manifest ↔ parser round-trip (the bulletproofing).
 *
 * `manifest.test.ts` pins every documented field's description TEXT against its
 * Zod source, but never against the actual commander `.option()`/`.argument()`
 * registrations in `index.ts`. That gap let the flagship `apply` bug through:
 * the manifest told an agent to pass `apply --file`, while commander only
 * registers `apply --doc`, so the documented call returned ERR_USAGE.
 *
 * These tests close the gap by INTROSPECTING the exported commander `program`
 * (side-effect-free — importing `index.ts` no longer runs the CLI) and
 * asserting that every field the manifest documents actually parses on its
 * command. The two sides are independent sources — the Zod `.describe()` corpus
 * vs the commander registrations — so a mismatch between them fails here.
 *
 * The core assertion (`documented --flag is registered`) is deliberately strong
 * enough to catch exactly the `apply` class of bug: see the dedicated
 * regression test at the bottom for the proof.
 */

/** camelCase / already-kebab field name → the kebab CLI long it maps to. */
const kebab = (s: string): string => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)

/** First ``--flag`` token embedded in a field description, if any. */
function explicitFlag(description: string): string | undefined {
  return description.match(/`(--[a-z][a-z0-9-]*)/)?.[1]
}

/** Manifest command name → its commander command (top-level). */
function commanderCommand(name: string): Command | undefined {
  return program.commands.find((c) => c.name() === name)
}

/**
 * The tokens a commander command (and, for parent commands like `glossary` /
 * `waive`, its subcommands) actually accepts: registered option longs,
 * registered positional-argument names, and — for grouped commands — the
 * subcommand names (which the manifest models as an `op` enum).
 */
function accepted(name: string): {
  options: Set<string>
  positionals: Set<string>
  subcommands: Set<string>
} {
  const cmd = commanderCommand(name)
  const options = new Set<string>()
  const positionals = new Set<string>()
  const subcommands = new Set<string>()
  if (cmd === undefined) return { options, positionals, subcommands }
  const collect = (c: Command): void => {
    for (const o of c.options) if (o.long !== undefined) options.add(o.long)
    for (const a of c.registeredArguments) positionals.add(a.name())
  }
  collect(cmd)
  for (const sub of cmd.commands) {
    subcommands.add(sub.name())
    collect(sub)
  }
  return { options, positionals, subcommands }
}

/**
 * Positional field-name renames: the manifest names a positional by its domain
 * concept, commander sometimes by a longer label. These are the same argument.
 */
const POSITIONAL_ALIAS: Record<string, Record<string, string>> = {
  update: { id: 'ref' },
  derive: { from: 'fromId', to: 'toId' },
  satisfy: { from: 'fromId', to: 'toId' },
  // AC-1-8 — the two edge commands added alongside derive/satisfy share their
  // positional naming, so they share the alias. This test caught the drift the
  // moment they were registered, which is exactly its job.
  verify: { from: 'fromId', to: 'toId' },
  refine: { from: 'fromId', to: 'toId' },
  'remove-edge': { from: 'fromId', to: 'toId' },
}

/**
 * `update` folds its `attr` / `value` operands into a single variadic `[rest…]`
 * positional (it multiplexes single/multi/bulk surfaces onto one command), so
 * those manifest fields are carried by `rest`, not by a same-named positional.
 */
const VARIADIC_CARRIER: Record<string, Record<string, string>> = {
  update: { attr: 'rest', value: 'rest' },
}

type ManifestArgs = {
  properties?: Record<string, { description?: string; enum?: string[] }>
}

function fieldsOf(cmdName: string): Record<string, { description?: string; enum?: string[] }> {
  const cmd = buildManifest().commands.find((c) => c.name === cmdName)
  return (cmd?.arguments as ManifestArgs).properties ?? {}
}

const commandNames = buildManifest().commands.map((c) => c.name)

describe('manifest ↔ commander parser round-trip', () => {
  it('every manifest command exists in the commander program', () => {
    for (const name of commandNames) {
      expect(commanderCommand(name), `no commander command registered for "${name}"`).toBeDefined()
    }
  })

  it('every documented `--flag` field is registered as an option on its command', () => {
    // The STRONG assertion: a field whose description embeds an explicit
    // `--flag` (every doc-path option and every check knob) must have that
    // exact flag registered. Description text and commander registration are
    // independent sources — this is where the `apply --doc`/`--file` drift dies.
    for (const name of commandNames) {
      const { options } = accepted(name)
      for (const [field, schema] of Object.entries(fieldsOf(name))) {
        const flag = explicitFlag(schema.description ?? '')
        if (flag === undefined) continue
        expect(
          options.has(flag),
          `${name}.${field} documents "${flag}" but commander registers only [${[...options].join(', ')}]`,
        ).toBe(true)
      }
    }
  })

  it('every documented field parses on its command (positional / option / subcommand)', () => {
    // The full round-trip: EVERY documented field must map to something the
    // parser accepts — a registered option, a registered positional (modulo the
    // known renames / variadic carriers), or, for grouped commands, the `op`
    // enum values matching the subcommand names.
    for (const name of commandNames) {
      const { options, positionals, subcommands } = accepted(name)
      const posAlias = POSITIONAL_ALIAS[name] ?? {}
      const carrier = VARIADIC_CARRIER[name] ?? {}
      for (const [field, schema] of Object.entries(fieldsOf(name))) {
        const desc = schema.description ?? ''

        // 1. Explicit `--flag` option (covered strongly above; re-checked here
        //    so this loop is a complete accounting of every field).
        const flag = explicitFlag(desc)
        if (flag !== undefined) {
          expect(options.has(flag), `${name}.${field}: option ${flag} not registered`).toBe(true)
          continue
        }

        // 2. A positional-described doc path (docPathArg) must have a positional.
        if (/\bpositional\b/i.test(desc)) {
          expect(
            positionals.size,
            `${name}.${field}: no positional argument registered`,
          ).toBeGreaterThan(0)
          continue
        }

        // 3. A grouped-command selector (glossary/waive `op`) enumerates the
        //    subcommand names.
        if (field === 'op' && schema.enum !== undefined) {
          for (const v of schema.enum) {
            expect(subcommands.has(v), `${name}.op="${v}" has no matching subcommand`).toBe(true)
          }
          continue
        }

        // 4. A domain field: accepted as the kebab-cased option, as a
        //    same-named positional, via a positional rename, or via the
        //    variadic carrier that multiplexes it.
        const asOption = `--${kebab(field)}`
        const asPositional = posAlias[field] ?? field
        const asCarrier = carrier[field]
        const ok =
          options.has(asOption) ||
          positionals.has(asPositional) ||
          (asCarrier !== undefined && positionals.has(asCarrier))
        expect(
          ok,
          `${name}.${field}: not accepted as ${asOption}, positional "${asPositional}"${asCarrier ? ` or variadic "${asCarrier}"` : ''} — options [${[...options].join(', ')}] positionals [${[...positionals].join(', ')}]`,
        ).toBe(true)
      }
    }
  })

  it('catches the apply --doc/--file bug: apply documents --doc, registers --doc, and NOT --file', () => {
    // PROOF the round-trip is meaningful, not a tautology. The manifest models
    // apply's doc path with a description that embeds `--doc`; commander
    // registers `--doc` and does NOT register `--file`. Had apply reverted to
    // the shared `docFileOpt` (documenting `--file`), the strong assertion above
    // would extract `--file` from the description and fail here, because the
    // commander `apply` command only accepts `--doc`.
    const applyFields = fieldsOf('apply')
    const docDesc = applyFields.doc?.description ?? ''
    expect(explicitFlag(docDesc)).toBe('--doc')

    const { options } = accepted('apply')
    expect(options.has('--doc')).toBe(true)
    // The bug was documenting a flag the parser rejects. Prove apply would
    // REJECT `--file`, so a manifest that documented `--file` would be a lie.
    expect(options.has('--file')).toBe(false)

    // Reconstruct the OLD buggy description and show the checker flags it: the
    // extracted flag (`--file`) is absent from apply's registered options.
    const buggyDocDesc =
      'Path to the requirements document, supplied as the `--file <path>` option.'
    const buggyFlag = explicitFlag(buggyDocDesc)
    expect(buggyFlag).toBe('--file')
    expect(options.has(buggyFlag as string)).toBe(false)
  })
})
