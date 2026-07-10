---
title: Background subagents sometimes stop instantly with 0 tool calls — SendMessage nudge recovers them reliably
track: bug
category: orchestration
module: multi-agent fan-outs (Agent tool, run_in_background)
component: claude-code
severity: medium
tags: [subagent, fan-out, background-agent, sendmessage, harness-glitch]
applies_when:
  - a background Agent completes in <15s with usage showing 0 tool_uses
  - the completion "result" is harness boilerplate (skill lists, system-context echoes), not task output
pattern: |
  In large parallel fan-outs (10+ background agents launched in one message),
  a fraction of agents (5/11 in one batch, 2/7 and 1/3 in others) terminate
  immediately: 0 tool calls, ~34k tokens, and a "result" that is clearly
  echoed system-reminder boilerplate rather than work. The files they own are
  untouched.

  Recovery that worked 100% of the time (8/8 across this session):
  send a SendMessage to the agent id with a short "You stopped without doing
  any work (0 tool calls). Execute your assigned task now, exactly as
  originally prompted: <one-paragraph restatement incl. absolute paths>".
  The agent resumes from its transcript with full original context and
  completes normally.

  Detection heuristic for the orchestrator: treat (tool_uses == 0) on a
  completion notification as "did not start", never as "done". Also verify
  the agent's owned files/log exist on disk before counting it complete.
example_files:
  - .erpaval/sessions/session-9c8371/tasks/T-AC-2-8.md
---

# Why this matters

A 0-tool-call completion looks identical to a success in the notification
stream. If the orchestrator trusts it, a whole task silently drops out of a
wave and the gap only surfaces at the next integration gate (or worse, ship).

# What NOT to do

Do not respawn a fresh agent for the same task — the original agent resumes
cheaper (context already loaded) and a fresh spawn risks duplicate/conflicting
writes if the original wakes later.
