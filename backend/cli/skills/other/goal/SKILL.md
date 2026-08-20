---
name: goal
description: Set an explicit objective, success criteria, and stopping conditions for the current OpenScience session.
---

# Goal

Use this skill when the user invokes `/goal` or asks OpenScience to work toward a concrete outcome over multiple turns.

## Contract

Establish the session goal as a compact completion contract:

- Objective: the specific outcome the user wants.
- Success criteria: the checks that prove the outcome is reached.
- Constraints: files, branches, budgets, tools, credentials, publishing rules, or safety limits the user names.
- Stop conditions: complete, blocked, cancelled, budget exhausted, or superseded by a newer user instruction.

If the user provided enough detail, proceed without another question. Ask only when the missing detail would make the work unsafe, irreversible, or impossible to verify.

## Execution

1. Restate the goal briefly in working terms.
2. Keep a short visible checklist while working.
3. Prefer real verification over confidence: tests, builds, local runs, screenshots, logs, or provider/API checks as appropriate.
4. Persist durable checkpoints in project files, commits, PRs, or Atlas records when the user asks for persistence or the repository already uses that workflow.
5. Update the user when the goal changes, a stop condition is hit, or verification gives new evidence.

## Completion

Before calling the goal complete, verify each success criterion with fresh evidence. If the goal is blocked, report the exact blocker, the evidence gathered, and the smallest user or external action that would unblock it.
