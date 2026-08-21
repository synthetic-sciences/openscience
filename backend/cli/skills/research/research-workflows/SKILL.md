---
name: research-workflows
description: Execute rigorous planning, review, verification, reproduction, comparison, source-audit, and export workflows using OpenScience session state, artifacts, provenance, and compute. This internal skill backs the corresponding built-in slash commands.
category: research
entry: false
---

# Research Workflow Engine

Treat each workflow as a state machine, not a prose request. Follow the selected reference supplied with this skill. Do not substitute a generic answer for its admission checks, durable state updates, evidence collection, or terminal condition.

## State ownership

- Keep implementation steps in `planwrite` or `todowrite`; replace the complete list on every update and keep only genuinely active work in progress.
- Keep multi-stage scientific completion state in `research_contract`. Define the contract before expensive work, update a stage only at a real boundary, record every materially distinct failed candidate, and pass a check only after observing its evidence.
- Record reusable project method lessons only from a named evidence-backed trial. Treat a one-session lesson as tentative, reinforce it only from an independent session, and reject it explicitly when a later trial supplies counterevidence. Never turn a task-specific scientific claim into standing guidance.
- Keep files in the workspace or a writable connected project folder. Save durable Results through `artifact` with `action: save_file` only when the workflow calls for a reusable artifact, and keep exact claim lineage through provenance tools. Do not copy bulky file contents into conversational status text.
- Preserve a design manifest before execution when later claims depend on temporal freezing, and link producing runs to exact code, inputs, and outputs. A post-run checksum proves consistency, not preregistration.
- Treat jobs, kernels, reviewer findings, artifacts, and verification checks as authoritative session state. Never infer success from an assistant sentence when the recorded state disagrees.

## Execution protocol

1. Resolve the invocation target and current session state before selecting tools.
2. Read repository instructions and the complete relevant files, records, or sources. Diffs and summaries are navigation aids, not sufficient evidence.
3. Establish the decision criterion before execution. Separate observed facts, source claims, computed results, interpretations, and unknowns.
4. Use the narrowest real execution path that can answer the question. Preserve inputs and failed outcomes; do not silently change the target, metric, dataset, environment, or tolerance.
5. Flush durable state before expensive, destructive, or externally visible operations and immediately after their outcome becomes known. If interruption leaves an outcome unknown, mark it unknown and inspect before retrying.
6. Verify decisive outputs independently. A repeated explanation, mock, or second copy of the implementation is not an independent check.
7. Finish only in one terminal state defined by the selected workflow. State untested gaps explicitly.

## Tool discipline

- Use read-only inspection before mutation. Ask a question only when a missing choice materially changes the result and cannot be recovered from the request or state.
- Reuse existing scripts, environments, artifacts, and provenance records when valid. Create a small rerunnable driver when durable execution would otherwise depend on hidden kernel state.
- Use delegation only for independent branches with a clear return contract. Validate candidate findings before accepting them.
- Do not claim that a command, test, source read, compute run, review, export, or save occurred unless the observable record proves it.

## Output contract

Lead with the terminal state or findings. Include the exact target, evidence used, durable outputs, remaining gaps, and next discriminating action. Keep process narration out of the final result.
