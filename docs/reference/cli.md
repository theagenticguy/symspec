# symspec · CLI reference

The `req` CLI is a commander-based wrapper around the core Change-record API. Entry: `bin/req.mjs:1-2` → `src/cli/index.ts:205`. Every command loads the doc, applies one Change, saves; commands map 1:1 to Change records or to read operations on the loaded doc.

Run via:

```bash
pnpm cli <subcommand> [args...]
# or
./bin/req.mjs <subcommand> [args...]
```

## `req init <file>`

```
req init reqs.automerge
```

Create an empty doc (`schemaVersion: 1, requirements: {}`) and save it to `<file>` (`src/cli/index.ts:40-46`).

## `req add <file>`

```
req add reqs.automerge \
  --pattern <p> --system <s> --response <r> \
  [--trigger <t>] [--pre <p>] [--priority <p>]
```

Create a new requirement; UUID is generated server-side and printed (`src/cli/index.ts:48-76`).

| Flag | Required | Notes |
|---|---|---|
| `--pattern` | yes | one of `ubiquitous \| event-driven \| state-driven \| optional-feature \| unwanted-behavior` (`src/core/schema.ts:26-32`) |
| `--system` | yes | system name; no leading `the` (`src/core/schema.ts:108-113`) |
| `--response` | yes | system response; no leading `shall` (`src/core/schema.ts:115-123`) |
| `--trigger` | conditional | required for `event-driven` and `unwanted-behavior` patterns (`src/core/schema.ts:99-106`) |
| `--pre` | conditional | required for `state-driven` and `optional-feature` patterns (`src/core/schema.ts:88-96`) |
| `--priority` | no | default `medium`; one of `low \| medium \| high \| critical` (`src/core/schema.ts:35`) |

Pattern-required slots are not enforced at create time; the analysis pass surfaces missing slots as findings instead (`src/core/analyze.ts:46-64`).

## `req update <file> <id> <attr> <value>`

```
req update reqs.automerge <uuid> trigger "the user submits valid credentials"
req update reqs.automerge <uuid> verificationMethod null
```

Patch one typed attribute. The string `"null"` (literal) is converted to a JS `null` to clear an optional attribute; nulling a required attribute throws (`src/cli/index.ts:78-91`, `src/core/doc.ts:110-113`). EARS slot edits re-render the sentence; metadata edits don't (`src/core/doc.ts:118-127`).

## `req derive <file> <fromId> <toId>`

```
req derive reqs.automerge <parent> <child>
```

Add a `derives` edge (`src/cli/index.ts:93-106`). The `derives` DAG must be acyclic — cycles surface as `CycleDetected` findings (`src/core/analyze.ts:67-76`).

## `req satisfy <file> <fromId> <toId>`

```
req satisfy reqs.automerge <impl> <goal>
```

Add a `satisfies` edge (`src/cli/index.ts:108-121`).

## `req remove-edge <file> <fromId> <relation> <toId>`

```
req remove-edge reqs.automerge <fromId> derives <toId>
```

Remove a typed edge. `<relation>` must be one of `derives | satisfies | verifies | refines` (`src/cli/index.ts:123-141`). No-op if the edge isn't present.

## `req delete <file> <id>`

```
req delete reqs.automerge <uuid>
```

Tombstone a requirement. Inbound edges from surviving requirements become dangling references and are surfaced by `analyze` (`src/cli/index.ts:143-151`, `src/core/doc.ts:151-157`).

## `req list <file>`

```
req list reqs.automerge
```

Print one block per requirement: `<id>  [<pattern>, <priority>, <status>]` followed by the rendered sentence (`src/cli/index.ts:153-162`).

## `req show <file> <id>`

```
req show reqs.automerge <uuid>
```

Print the full JSON of one requirement; exits 1 if not found (`src/cli/index.ts:164-175`).

## `req analyze <file>`

```
req analyze reqs.automerge
```

Run `analyze()` and print the human-readable summary (`src/cli/index.ts:177-184`). A clean doc prints `No findings — graph is consistent.` (`src/core/analyze.ts:143`).

## `req export <file>`

```
req export reqs.automerge > spec.sysml.json
```

Print the SysML-v2-flavored JSON projection to stdout (`src/cli/index.ts:186-192`). The shape is `{ '@context': 'https://www.omg.org/spec/SysML/v2', schemaVersion, elements: RequirementUsage[], relationships: (DeriveRequirement|Satisfy|Verify|Refine)[] }` (`src/core/sysml-export.ts:35-40`, `src/core/sysml-export.ts:84-89`).

## `req merge <a> <b> <out>`

```
req merge alice.automerge bob.automerge merged.automerge
```

Load two replicas, call `Automerge.merge`, save (`src/cli/index.ts:194-203`). Exposed for demonstration; in normal use Automerge merges implicitly when both replicas operate on the same doc.

## See also

- [Module map](../architecture/module-map.md)
- [System overview](../architecture/system-overview.md)
- [MCP tool reference](rpc-tools.md)
- [Data flow](../architecture/data-flow.md)
