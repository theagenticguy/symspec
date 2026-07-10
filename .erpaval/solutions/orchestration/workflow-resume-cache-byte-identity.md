---
title: Workflow resume replays only byte-identical (prompt, opts) agent calls — edit mid-run with cache discipline
track: knowledge
category: orchestration
module: Workflow tool (resumeFromRunId)
component: claude-code
severity: medium
tags: [workflow, resume, cache, model-override, mid-run-edit]
applies_when:
  - stopping a running Workflow to change models/prompts, then resuming with resumeFromRunId
  - deciding where to put dynamic content (e.g. wave notes) inside agent prompts
pattern: |
  Workflow resume caches completed agent() calls keyed on the exact (prompt,
  opts) pair. Two practical consequences hit this session:

  1. When flipping remaining tasks to a different model mid-run, completed
     tasks' entries must stay BYTE-IDENTICAL — including opts. We flipped
     Waves 5-8 to opus but deliberately left already-completed T-AC-6-5 at
     'sonnet' so it replayed from cache instead of re-running.
     For shared call sites (e.g. a gate agent inside the wave loop), apply
     conditional opts: `...(w >= RESUME_POINT ? { model: 'opus' } : {})`.

  2. Prompts that embed upstream results (a gate prompt containing the wave's
     result notes) cache-miss on resume when re-run agents return slightly
     different notes text. Harmless if the step is idempotent (our gates
     re-ran and found nothing to fix), but wasteful — prefer pointing such
     prompts at files on disk over inlining volatile text.

  Also: results journal to journal.jsonl only at completion. Stopping a run
  mid-flight loses in-flight agents' results even when their file writes
  landed — on resume those tasks re-run. Check the tasks/ dir mtimes vs the
  journal before assuming resume state.
example_files:
  - .erpaval/sessions/session-9c8371/tasks/gate-wave-4.md
---

# Why this matters

Mid-run model/prompt changes are routine in long fan-outs (user preference
changes, cost tuning). Without cache discipline a resume silently re-executes
hours of completed work — or worse, double-writes files.

# What NOT to do

Do not "clean up" a completed task's opts for consistency when editing the
script for resume — that consistency costs a full re-run of the task.
