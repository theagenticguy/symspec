/**
 * MCP server exposing the Change-record API as MCP tools.
 *
 * Each tool's input shape is imported from `core/schema.ts` — the same
 * zod schemas that define on-disk and in-memory shapes are reused here, so
 * the JSON Schema the LLM sees in `tools/list` carries the rich .describe()
 * text we author once. There is no second schema layer to drift.
 *
 * Tool design notes (tuned for Opus 4.7):
 *   - Tool names follow noun_verb (requirement_create) so an agent that lists
 *     tools sees them grouped by domain object.
 *   - Each tool description follows: <what it does> / <when to use it> /
 *     <returns + side effects> / <idempotency + error modes>.
 *   - Per-argument descriptions live on the field schemas in core/schema.ts
 *     and explain semantics, format, and at least one concrete example.
 *   - Tools that mutate the graph end their description with a hint about
 *     when to call `analysis_run` next, so the model knows the verification
 *     half of the loop without being told inline.
 */

import { existsSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { analyze, summarizeFindings } from '../core/analyze.js'
import {
  applyChange,
  emptyDoc,
  getRequirement,
  listRequirements,
  loadDoc,
  newId,
  saveDoc,
} from '../core/doc.js'
import {
  RelationshipAddInputShape,
  RelationshipRemoveInputShape,
  RequirementCreateInputShape,
  RequirementDeleteInputShape,
  RequirementUpdateInputShape,
} from '../core/schema.js'
import { exportSysml } from '../core/sysml-export.js'

const DOC_PATH = process.env.SYMSPEC_DOC ?? './requirements.automerge'
const lines = (...xs: string[]) => xs.join('\n')

async function ensureDoc() {
  if (!existsSync(DOC_PATH)) await saveDoc(emptyDoc(), DOC_PATH)
}

const server = new McpServer({
  name: 'symspec',
  version: '0.1.0',
})

// ---------------------------------------------------------------------------
// Mutation tools
// ---------------------------------------------------------------------------

server.registerTool(
  'requirement_create',
  {
    title: 'Create requirement',
    description: lines(
      'Create a new EARS requirement node and return its assigned UUID.',
      'Use this once per requirement you intend to author; the runtime generates the UUID, renders the canonical sentence,',
      "and applies sensible defaults (priority='medium', status='draft', empty edge arrays).",
      'Pre-condition/trigger are not enforced here even when the pattern wants them — the analysis pass surfaces missing slots',
      'as findings rather than rejecting the create, so you can author a stub and refine it incrementally.',
      'After creating a batch of requirements, call analysis_run to surface any missing-slot or structural findings.',
    ),
    inputSchema: RequirementCreateInputShape,
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async (args) => {
    await ensureDoc()
    const doc = await loadDoc(DOC_PATH)
    const id = newId()
    const next = applyChange(doc, {
      kind: 'CreateRequirement',
      id,
      attrs: args,
    })
    await saveDoc(next, DOC_PATH)
    const r = getRequirement(next, id)!
    return {
      content: [
        {
          type: 'text',
          text: `Created ${id}\n${r.sentence}`,
        },
      ],
    }
  },
)

server.registerTool(
  'requirement_update',
  {
    title: 'Update requirement attribute',
    description: lines(
      'Patch exactly one typed attribute on an existing requirement.',
      'Use for incremental refinement: tightening a trigger, escalating priority, moving status forward through draft→approved→implemented→verified.',
      'If you update any EARS structural slot (patternType, preCondition, trigger, systemName, systemResponse) the canonical sentence is automatically re-rendered;',
      'metadata edits (priority, status, verificationMethod) leave the sentence alone.',
      'Pass value=null to clear an optional attribute (preCondition, trigger, verificationMethod). Nulling a required attribute throws.',
      'Errors when id does not resolve to a current requirement.',
    ),
    inputSchema: RequirementUpdateInputShape,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (args) => {
    await ensureDoc()
    const doc = await loadDoc(DOC_PATH)
    const next = applyChange(doc, {
      kind: 'UpdateAttribute',
      id: args.id,
      attr: args.attr,
      value: args.value,
    })
    await saveDoc(next, DOC_PATH)
    return {
      content: [{ type: 'text', text: `Updated ${args.id}.${args.attr}` }],
    }
  },
)

server.registerTool(
  'relationship_add',
  {
    title: 'Add relationship edge',
    description: lines(
      'Add a typed directional edge from one requirement to another (derives | satisfies | verifies | refines).',
      'Use to express requirement decomposition, satisfaction of higher-level goals, verification links, or refinement chains.',
      'Idempotent — adding the same edge twice produces a single edge, so retries are safe.',
      'Errors when the source requirement does not exist. If the target later disappears (e.g., concurrent delete on another replica),',
      'the edge survives and becomes a dangling reference, which analysis_run will surface.',
    ),
    inputSchema: RelationshipAddInputShape,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (args) => {
    await ensureDoc()
    const doc = await loadDoc(DOC_PATH)
    const next = applyChange(doc, {
      kind: 'AddRelationship',
      from: args.from,
      relation: args.relation,
      to: args.to,
    })
    await saveDoc(next, DOC_PATH)
    return {
      content: [
        {
          type: 'text',
          text: `${args.from} -${args.relation}-> ${args.to}`,
        },
      ],
    }
  },
)

server.registerTool(
  'relationship_remove',
  {
    title: 'Remove relationship edge',
    description: lines(
      'Remove a typed directional edge between two requirements.',
      'Use to retract a decomposition, satisfaction, verification, or refinement claim that no longer holds.',
      "No-op if the edge isn't present, including if the source requirement was already deleted — safe to call defensively.",
      'Does not delete either endpoint node.',
    ),
    inputSchema: RelationshipRemoveInputShape,
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async (args) => {
    await ensureDoc()
    const doc = await loadDoc(DOC_PATH)
    const next = applyChange(doc, {
      kind: 'RemoveRelationship',
      from: args.from,
      relation: args.relation,
      to: args.to,
    })
    await saveDoc(next, DOC_PATH)
    return {
      content: [
        {
          type: 'text',
          text: `removed ${args.from} -${args.relation}-> ${args.to}`,
        },
      ],
    }
  },
)

server.registerTool(
  'requirement_delete',
  {
    title: 'Delete requirement',
    description: lines(
      'Tombstone a requirement, removing it from the document.',
      'Use when a requirement has been retracted, superseded, or merged into another.',
      'Inbound edges from surviving requirements become dangling references — they are not auto-removed.',
      'After a delete, you should call analysis_run; the dangling-reference findings tell you which',
      'surviving requirements still pointed at the deleted node so you can rewire or remove those edges.',
      'No-op-ish behavior on a non-existent id is not provided: the delete will simply leave the doc unchanged for a missing id,',
      'but you should not rely on that — verify the id first if it matters.',
    ),
    inputSchema: RequirementDeleteInputShape,
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async (args) => {
    await ensureDoc()
    const doc = await loadDoc(DOC_PATH)
    const next = applyChange(doc, { kind: 'DeleteRequirement', id: args.id })
    await saveDoc(next, DOC_PATH)
    return { content: [{ type: 'text', text: `Deleted ${args.id}` }] }
  },
)

// ---------------------------------------------------------------------------
// Read / inspection tools
// ---------------------------------------------------------------------------

server.registerTool(
  'requirements_list',
  {
    title: 'List requirements',
    description: lines(
      'List all current requirements in the document as a compact JSON array.',
      'Each entry contains the id, pattern type, priority, status, and rendered EARS sentence —',
      'enough to scan the spec at a glance without fetching every full node.',
      'Use before mutating to find the UUID of a requirement you intend to update or link to.',
    ),
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    await ensureDoc()
    const doc = await loadDoc(DOC_PATH)
    const items = listRequirements(doc).map((r) => ({
      id: r.id,
      patternType: r.patternType,
      priority: r.priority,
      status: r.status,
      sentence: r.sentence,
    }))
    return {
      content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
    }
  },
)

server.registerTool(
  'analysis_run',
  {
    title: 'Run consistency analysis',
    description: lines(
      'Run the integrity / consistency analysis pass over the converged document and return findings.',
      'Findings cover: dangling references (edges pointing at deleted or never-existed UUIDs), missing EARS slots required by a pattern type,',
      'cycles in the derives DAG (decomposition must be acyclic), and orphaned nodes (no inbound or outbound edges).',
      'Call this after a batch of mutations to verify the graph is consistent; an empty findings list means the doc is clean.',
      'Findings are intentionally surfaced rather than prevented at write time — this lets concurrent replicas converge first',
      'and lets you author incrementally without the runtime rejecting half-finished requirements.',
      'This is a read operation: it does not modify the document.',
    ),
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    await ensureDoc()
    const doc = await loadDoc(DOC_PATH)
    const findings = analyze(doc)
    return {
      content: [
        { type: 'text', text: summarizeFindings(findings) },
        { type: 'text', text: JSON.stringify(findings, null, 2) },
      ],
    }
  },
)

server.registerTool(
  'sysml_export',
  {
    title: 'Export to SysML v2 JSON',
    description: lines(
      'Export the requirements graph to SysML-v2-flavored JSON for interchange with other tools.',
      'Each requirement becomes a RequirementUsage element with typed attributes (patternType, preCondition, trigger, systemName,',
      'systemResponse, priority, status, verificationMethod) and the rendered sentence as documentation.',
      'Each outbound edge becomes a typed relationship element (DeriveRequirement, Satisfy, Verify, Refine).',
      'Use as a hand-off to a downstream SysML v2 server, a static analyzer, or a documentation pipeline.',
      'Read-only.',
    ),
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    await ensureDoc()
    const doc = await loadDoc(DOC_PATH)
    return {
      content: [{ type: 'text', text: JSON.stringify(exportSysml(doc), null, 2) }],
    }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
