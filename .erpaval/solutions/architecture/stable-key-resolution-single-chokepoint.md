---
title: Add key⇄UUID addressing at the one resolver every id-command funnels through — six commands get keys for free
track: knowledge
category: architecture
module: src/cli/errors.ts, src/core/doc.ts
component: commander
severity: medium
tags: [agent-friendly-cli, stable-keys, addressing, requireRequirement, resolveRequirement, single-chokepoint]
applies_when:
  - adding a human-friendly alternate handle (key/slug) alongside a UUID id
  - every command already validates its id through one guard
  - you want the new addressing everywhere without touching every command
pattern: |
  symspec addresses requirements by minted UUID; authors want a
  stable human key ("G1") usable wherever a UUID is. The whole surface got that
  from TWO small edits, because every id-taking command (show/update/derive/
  satisfy/remove-edge/delete) already funnels its raw `<id>` through ONE guard:
  `requireRequirement(doc, ref)` in cli/errors.ts.
    1. A pure resolver in core/doc.ts: resolveRequirement(doc, ref) tries a
       UUID-shaped ref in the O(1) map first, else scans for `.key === ref`.
       (resolveId returns the UUID.)
    2. requireRequirement delegates to it instead of `doc.requirements[id]`.
  Now all six commands accept a key OR a UUID, and the Change records still use
  the RESOLVED UUID (runUpdate/runUpdateMany use target.value.id, never the raw
  ref) so edges/persistence stay UUID-keyed. Keys are IMMUTABLE (not in
  UPDATABLE_ATTRS) and unique (ERR_DUPLICATE_KEY at add), so a key is as safe to
  reference as the UUID. Key format is a FLAGLESS regex (KEY_PATTERN) — Zod 4's
  z.toJSONSchema throws on a flagged pattern, and the manifest derivation runs it.
example_files:
  - src/core/doc.ts
  - src/cli/errors.ts
  - src/core/schema.ts
---

# Why this matters

Adding an alternate addressing scheme naively means editing every command. When
the codebase already has a single validate-and-narrow chokepoint, extend THAT —
the change is O(1) commands, not O(n), and impossible to apply inconsistently.
The batch `apply` op refs reuse the same resolveId, so keys work there too.

# What NOT to do

Do not resolve keys in each command. Do not build the Change with the raw ref
(a key would fail `d.requirements[key]`) — always thread the resolved UUID. Do
not make the key regex flagged (case-insensitive `i` etc.) — z.toJSONSchema
throws and the manifest build dies. Do not put key in UPDATABLE_ATTRS — a
mutable key breaks the "as safe as a UUID" guarantee.
