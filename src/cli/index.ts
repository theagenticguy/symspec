/**
 * `req` CLI — thin wrapper around the core Change-record API.
 *
 * Commands:
 *   req init <file>
 *   req add <file> --pattern <p> --system <s> --response <r> [...]
 *   req update <file> <id> <attr> <value>
 *   req derive <file> <fromId> <toId>
 *   req satisfy <file> <fromId> <toId>
 *   req remove-edge <file> <fromId> <relation> <toId>
 *   req delete <file> <id>
 *   req list <file>
 *   req show <file> <id>
 *   req analyze <file>
 *   req export <file>
 *   req merge <a.automerge> <b.automerge> <out.automerge>
 */

import { Command } from 'commander'
import { analyze, summarizeFindings } from '../core/analyze.js'
import {
  applyChange,
  emptyDoc,
  getRequirement,
  listRequirements,
  loadDoc,
  merge,
  newId,
  saveDoc,
} from '../core/doc.js'
import { EARS_PATTERNS, RELATIONS } from '../core/schema.js'
import { exportSysml } from '../core/sysml-export.js'

const program = new Command()
program
  .name('req')
  .description('EARS-validated requirements graph CLI (Automerge + SysML v2)')
  .version('0.1.0')

program
  .command('init <file>')
  .description('create an empty requirements document')
  .action(async (file: string) => {
    await saveDoc(emptyDoc(), file)
    console.log(`Initialized empty requirements doc at ${file}`)
  })

program
  .command('add <file>')
  .description('create a new requirement')
  .requiredOption('--pattern <p>', `EARS pattern type (${EARS_PATTERNS.join('|')})`)
  .requiredOption('--system <s>', "system name (the X in 'the X shall...')")
  .requiredOption('--response <r>', 'system response (what X shall do)')
  .option('--trigger <t>', 'trigger clause (for event-driven/unwanted)')
  .option('--pre <p>', 'pre-condition (for state-driven/optional)')
  .option('--priority <p>', 'priority (low|medium|high|critical)', 'medium')
  .action(async (file: string, opts: Record<string, string>) => {
    const doc = await loadDoc(file)
    const id = newId()
    const next = applyChange(doc, {
      kind: 'CreateRequirement',
      id,
      attrs: {
        patternType: opts.pattern,
        systemName: opts.system,
        systemResponse: opts.response,
        trigger: opts.trigger,
        preCondition: opts.pre,
        priority: opts.priority,
      },
    })
    await saveDoc(next, file)
    const r = getRequirement(next, id)!
    console.log(`Created ${id}`)
    console.log(`  ${r.sentence}`)
  })

program
  .command('update <file> <id> <attr> <value>')
  .description('update a typed attribute on a requirement')
  .action(async (file: string, id: string, attr: string, value: string) => {
    const doc = await loadDoc(file)
    const next = applyChange(doc, {
      kind: 'UpdateAttribute',
      id,
      attr,
      value: value === 'null' ? null : value,
    })
    await saveDoc(next, file)
    console.log(`Updated ${id}.${attr}`)
  })

program
  .command('derive <file> <fromId> <toId>')
  .description('add a deriveReqt edge: fromId derives toId')
  .action(async (file: string, fromId: string, toId: string) => {
    const doc = await loadDoc(file)
    const next = applyChange(doc, {
      kind: 'AddRelationship',
      from: fromId,
      relation: 'derives',
      to: toId,
    })
    await saveDoc(next, file)
    console.log(`${fromId} -derives-> ${toId}`)
  })

program
  .command('satisfy <file> <fromId> <toId>')
  .description('add a satisfy edge: fromId satisfies toId')
  .action(async (file: string, fromId: string, toId: string) => {
    const doc = await loadDoc(file)
    const next = applyChange(doc, {
      kind: 'AddRelationship',
      from: fromId,
      relation: 'satisfies',
      to: toId,
    })
    await saveDoc(next, file)
    console.log(`${fromId} -satisfies-> ${toId}`)
  })

program
  .command('remove-edge <file> <fromId> <relation> <toId>')
  .description('remove a relationship edge')
  .action(async (file: string, fromId: string, relation: string, toId: string) => {
    const rels = RELATIONS as readonly string[]
    if (!rels.includes(relation)) {
      console.error(`unknown relation: ${relation}`)
      process.exit(1)
    }
    const doc = await loadDoc(file)
    const next = applyChange(doc, {
      kind: 'RemoveRelationship',
      from: fromId,
      relation,
      to: toId,
    })
    await saveDoc(next, file)
    console.log(`removed ${fromId} -${relation}-> ${toId}`)
  })

program
  .command('delete <file> <id>')
  .description('delete a requirement (tombstone)')
  .action(async (file: string, id: string) => {
    const doc = await loadDoc(file)
    const next = applyChange(doc, { kind: 'DeleteRequirement', id })
    await saveDoc(next, file)
    console.log(`Deleted ${id}`)
  })

program
  .command('list <file>')
  .description('list all requirements')
  .action(async (file: string) => {
    const doc = await loadDoc(file)
    for (const r of listRequirements(doc)) {
      console.log(`${r.id}  [${r.patternType}, ${r.priority}, ${r.status}]`)
      console.log(`  ${r.sentence}`)
    }
  })

program
  .command('show <file> <id>')
  .description('print the full JSON of one requirement')
  .action(async (file: string, id: string) => {
    const doc = await loadDoc(file)
    const r = getRequirement(doc, id)
    if (!r) {
      console.error(`not found: ${id}`)
      process.exit(1)
    }
    console.log(JSON.stringify(r, null, 2))
  })

program
  .command('analyze <file>')
  .description('run the analysis pass and print findings')
  .action(async (file: string) => {
    const doc = await loadDoc(file)
    const findings = analyze(doc)
    console.log(summarizeFindings(findings))
  })

program
  .command('export <file>')
  .description('export to SysML-v2-flavored JSON (stdout)')
  .action(async (file: string) => {
    const doc = await loadDoc(file)
    console.log(JSON.stringify(exportSysml(doc), null, 2))
  })

program
  .command('merge <a> <b> <out>')
  .description('merge two .automerge replicas into <out>')
  .action(async (a: string, b: string, out: string) => {
    const docA = await loadDoc(a)
    const docB = await loadDoc(b)
    const merged = merge(docA, docB)
    await saveDoc(merged, out)
    console.log(`Merged ${a} + ${b} -> ${out}`)
  })

program.parseAsync(process.argv)
