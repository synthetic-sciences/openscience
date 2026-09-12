---
name: delegation
description: Delegates independent work to worker agents through the Task tool, choosing between the explore and execute profiles and the ML, biology, physics and chemistry specialists, writing a self-contained brief for a worker that cannot see the conversation, setting boundaries on files and compute, and reading the handoff back critically. Use before dispatching a worker or interpreting its result, and when deciding whether a task should be delegated at all. Never delegate the literature retrieval loop or a step of an experiment loop already underway.
summary: "When and how to hand independent work to a worker or specialist; the brief and the handoff."
category: core
role: support
allowed-tools: [task]
license: MIT
version: 1.0.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
  adapted-from: alphaXiv OpenResearch orx-agent-delegation (MIT)
---

# Delegation

A worker is a second agent that starts with an empty transcript. It can do independent
work in parallel and bring back a decision-ready handoff; it cannot read your mind, your
conversation, or the user's intent. Delegation pays when the task has a clean boundary
and a brief can carry everything the worker needs. Otherwise it costs latency, tokens
and coherence, and the work is better done here.

## When to delegate

Delegate when all of these hold:

- The work is independent of the step you are on: surveying an unfamiliar codebase,
  running and reporting an isolated experiment, drafting a section from finished results,
  auditing a long artifact, reproducing a claim in parallel with other work.
- You can write down the goal, the inputs, the constraints and the definition of done
  without reference to "what we discussed".
- The result can be checked when it comes back (a number to compare, a file to open, a
  report against a checklist).
- The Delegation setting allows it (Off means do it here; Auto means when it clearly
  helps; High means prefer it for parallelizable phases).

Never delegate:

- the literature retrieval loop: ranking candidates is the judgement, and a worker ranks
  for a different question (load literature-review and run it yourself);
- a step inside an experiment loop already underway, where the next action depends on the
  last result you saw;
- anything requiring the user's answer to a question the worker cannot ask.

## Choosing the worker

| Need | `subagent_type` | `specialist` |
| --- | --- | --- |
| Read and report: codebase survey, artifact audit, options analysis | `explore` | optional |
| Build or run: implement, execute, produce files or results | `execute` | optional |
| Independent critical read of a draft or analysis | `explore` | `critique` (read-only; reports BLOCKING and observations) |
| Domain-heavy phase: training or fine-tuning setup, omics pipeline, PDE solver, docking | `execute` or `explore` | `ml`, `biology`, `physics`, `chemistry` |

A specialist worker keeps the Research contract and gains its domain contract, the full
index of its skill library and its domain tools (the biology specialist can query UniProt,
PDB, Ensembl, KEGG, PubMed directly). Use one when most of the phase sits in that domain;
for mixed work a general worker that loads a skill is enough.

## The brief

The worker sees only the brief. Include, in this order:

1. **Goal**: one sentence, what done looks like.
2. **Context**: project, relevant paths, the metric or question, what has been tried.
3. **Inputs**: exact files, run ids, URLs, data locations. Paths must exist and be readable
   from the worker's workspace (the lead's scratch is read-only for it; it writes under
   its own workspace and saves outputs as artifacts).
4. **Constraints**: what not to touch, what not to change (the evaluation, the metric,
   frozen files), time or cost limits.
5. **Compute authorization**: exactly which runs it may launch, on which target, with what
   budget. Say "no compute jobs" explicitly when none are authorized; a worker otherwise
   assumes the normal research loop is available.
6. **Output**: the files or numbers to return and the sections its handoff should use
   (Outcome, Findings, Evidence, Changes, Limitations, Next action).
7. **Definition of done**: the concrete check that ends the task.

Write it as the worker's user message; keep your own voice out of it. A brief that fits in
five lines usually means the task should be done here; a brief that needs a page means
the task is worth a worker.

## Reading the handoff

- Verify before you build on it: open the file, compare the number, rerun the smallest
  check. A saved artifact proves an output exists, not that it is right.
- Treat the worker's inference as inference; its evidence as evidence. If the handoff does
  not separate them, ask for the separation or check yourself.
- A partial result is normal; the handoff says what remains. Decide whether to continue
  the same worker (`session_id`), start another, or finish here.
- Do not repeat the worker's diary to the user. Report the outcome and what changed.

## Concurrency and limits

Several workers may run at once for genuinely parallel phases (a sweep across datasets, a
survey split by subsystem). Workers cannot spawn workers. Publishing (pushing, releasing,
uploading) stays with you. Each worker costs a full model context; three workers for a
task one skill load would have solved is the common mistake.
