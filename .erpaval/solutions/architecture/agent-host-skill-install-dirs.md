---
title: Install an agent skill by writing a host's dedicated skill/rule dir — never its root doc; generate the body from the manifest corpus so it can't drift
track: knowledge
category: architecture
module: src/cli/install/
component: commander
severity: medium
tags: [agent-friendly-cli, install, skill, agentskills, claude-code, cursor, codex, kiro, windsurf, copilot, single-source, idempotent-write]
applies_when:
  - shipping a CLI whose primary consumer is a coding agent and you want zero-config discovery
  - adding an `install`/`setup` command that wires a tool into whatever agent host is present
  - deciding between editing a host's root instruction file vs writing a dedicated unit
pattern: |
  Every capable coding-agent host has a DEDICATED skill/rule dir separate from
  its root instruction file — so you can add capability by writing a NEW file,
  never appending to CLAUDE.md/AGENTS.md/GEMINI.md (verified 2026-07):
    - .agents/skills/<name>/SKILL.md  — agentskills.io OPEN STANDARD, read by
      Claude Code, Cursor, AND Codex CLI. One file, three hosts. name+description
      frontmatter; model auto-loads the body when description matches the task.
    - .kiro/steering/<name>.md          (frontmatter: inclusion: fileMatch|always|manual)
    - .windsurf/rules/<name>.md         (frontmatter: trigger: model_decision|always_on|glob|manual)
    - .github/instructions/<name>.instructions.md  (frontmatter: applyTo: <glob>)
    - Cursor also: .cursor/rules/*.mdc  (description/globs/alwaysApply)
  NO dedicated always-on dir (root-doc-only → SKIP, don't edit): opencode
  (AGENTS.md only) and Gemini CLI (GEMINI.md only; .gemini/commands/*.toml is
  slash-invoked, not auto-loaded). Codex is NO LONGER AGENTS.md-only — it grew
  .agents/skills; don't assume otherwise.

  Architecture that falls out (mirrors codegraph's installer):
    - AgentTarget interface {supportsLocation, detect, install, uninstall,
      preview} + a registry; adding a host = one factory call. A shared
      makeSkillFileTarget carries all logic; each host is a {relPath, detectMarkers,
      frontmatter, supportsGlobal} config.
    - resolveTargets(auto|all|csv): `auto` = hosts whose marker dir exists;
      detection SEEDS the target set, never gates a write the user asked for.
    - Idempotent writes: writeManagedFile returns created|updated|unchanged
      (byte-equal → no write), removeManagedFile → removed|unchanged; reuse the
      existing atomicWriteFile (temp+rename). One skill = one whole file symspec
      owns, so NO marker-splicing needed (that's only for co-edited shared files).
    - Generate the skill BODY from the same single-source corpus as the manifest
      (COMMAND_SUMMARIES + SCOPE), and keep it a THIN POINTER ("run `X manifest`
      first" + the one honesty caveat), not a second copy of the docs — same
      anti-drift discipline as the generated AGENTS.md.
  YAML frontmatter caveat: quote description scalars and escape embedded quotes.
example_files:
  - src/cli/install/targets.ts
  - src/cli/install/skill-content.ts
  - src/cli/install/write-safety.ts
  - src/cli/install/run.ts
---

# Why this matters

An `install` that appends to CLAUDE.md/AGENTS.md is invasive and clobber-prone.
Every real host now has a dedicated skill/rule dir, so the correct move is to
write ONE self-contained file there — additive, idempotent, uninstallable, and
invisible to the user's own root doc. The `.agents/skills` open standard means a
single SKILL.md covers Claude Code + Cursor + Codex at once, so the host matrix
is small. Generating the body from the manifest corpus keeps the installed skill
from drifting the way a hand-written one would.

# What NOT to do

Do not edit a host's root instruction file. Do not treat Codex as AGENTS.md-only
(it has .agents/skills now). Do not force-write opencode/Gemini (no dedicated
always-on dir — report them skipped). Do not hand-write the skill body — derive
it from the same corpus the manifest uses. Do not marker-splice a file you own
whole; whole-file byte-equality is the idempotency check.
