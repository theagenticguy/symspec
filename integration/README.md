# Integration with ERPAVal (or any Claude Code project)

Three artifacts to drop in.

## 1. The skill — `skills/symspec/SKILL.md`

Copy `SKILL.md` into `skills/symspec/` of your plugin or project. This is the primary surface that tells Claude when and how to invoke the MCP. Trigger conditions, mental model, workflows, and anti-patterns are all here. Lazy-loaded — only consumes context once it's matched.

## 2. The MCP server config — addition to `.mcp.json`

`mcp-config.json` is a snippet. Merge it into your existing `.mcp.json` under `mcpServers`. Adjust:

- `ERPAVAL_ROOT` — path to your local checkout of this POC (or vendor `poc/` into your plugin and reference it directly).
- `REQ_DOC` — per-session graph file. `${SPEC_SLUG}` is illustrative; substitute however your launcher resolves the current spec slug.
- Bedrock env vars — override model ids if your account uses different inference profile names. `BEDROCK_ARBITER_EFFORT` accepts `low | medium | high | xhigh | max`.

## 3. The CLAUDE.md addendum

`CLAUDE.md.snippet` is one short section pointing at the skill from the project's root CLAUDE.md. This is what makes the skill discoverable without forcing Claude to scan the skills directory cold every session.

## Wiring it into ERPAVal's CL-RIGOR → EARS substep

The skill is designed to be the destination of the `CL-RIGOR → contract-unclear → EARS` route. When that classifier fires, Claude loads `symspec`, runs the **author_new_spec** workflow against the session's spec directory, and at the end exports the SysML JSON that Plan reads. ERPAVal's existing markdown `spec.md` becomes a derived view; the graph is authoritative.

## How to validate the wiring

1. Start a Claude Code session inside a project that has the skill installed and the MCP configured.
2. Ask: "spec out a new account-lockout policy in EARS."
3. Expected: Claude invokes the `symspec` skill, calls `requirements_list` first, then `requirement_create` for each criterion, then `relationship_add` for the derives DAG, then `analysis_run`, and shows you the findings.

If Claude instead writes `spec.md` directly as prose, the skill description's triggers are not firing strongly enough — run `meta-prompt-optimizer` over the SKILL.md frontmatter description.
