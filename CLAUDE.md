# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**AppliedScience (`openscience`)** is an open-source, model-agnostic AI research agent for ML engineering and scientific work. Built with Bun and TypeScript, it ships as native binaries for Linux, macOS, and Windows.

- **npm package**: `@synsci/openscience`
- **Binary name**: `openscience`
- **Config dir**: `~/.config/openscience/` (also `~/.openscience/`; legacy `~/.synsc` auto-migrates)
- **Config file**: `openscience.json`
- **Provider ID**: `synsci` (Atlas wire contract, do not rename)

## Commands

```bash
# Install and run from source
bun install
bun dev                        # equivalent to the built `openscience` binary
bun dev <directory>            # run in a specific directory
bun dev serve                  # headless API server (port 4096)
bun dev web                    # start server and open workspace

# Checks (run all before pushing)
bun run typecheck              # type-check all packages via turbo
bun test --cwd backend/cli     # run full test suite
bunx prettier --check .        # formatting check
bun run check                  # typecheck + test combined

# Format
bun run format                 # write formatting fixes

# Run a single test file
bun test --cwd backend/cli src/path/to/file.test.ts

# Build standalone binary
./backend/cli/script/build.ts --single
# output: ./backend/cli/dist/@synsci/openscience-<platform>/bin/openscience

# Frontend UI dev (run alongside `bun dev serve`)
bun run --cwd frontend/workspace dev    # http://localhost:5173

# Docs / landing site
bun run --cwd frontend/docs dev
bun run --cwd frontend/landing dev

# Regenerate SDK after changing the server API
./tooling/repo/generate.ts
```

## Repository Structure

Single git repo, organized by runtime boundary:

```
backend/cli          CLI, server, agent runtime, tools, skills, provider integrations
frontend/workspace   Browser workspace UI (SolidJS), embedded in the CLI binary
frontend/ui          Shared component and theme library
frontend/docs        Astro documentation and session-share site
tooling/sdk/js       TypeScript SDK generated from the server's OpenAPI contract
tooling/plugin       Plugin runtime (@synsci/plugin)
tooling/launcher     `npx synsci` installer shim
tooling/repo         Release automation and SDK generation
```

## Prompt Architecture (Dual-Layer)

Prompts are assembled in two layers — this requires reading two files to understand:

```
User request with agent name (e.g., "research")
  │
  ├─ Layer 1: SYSTEM role ← provider-neutral product contract
  │   src/session/system.ts → always injects src/session/prompt/core.txt
  │   (augmented with working dir, date, available skills, plan-mode directives)
  │
  └─ Layer 2: USER role injection ← agent workflow prompt
      src/session/prompt.ts → insertReminders() if-chains on agent name
      prompt files live in src/agent/prompt/{agent}.txt
```

**Session-level utility prompts** (`src/session/prompt/`):

| File | Purpose |
|------|---------|
| `core.txt` | Provider-neutral operating contract (Layer 1) |
| `plan.txt` | Read-only plan mode |
| `build-switch.txt` | Plan → build mode transition |
| `max-steps.txt` | Step-limit reminder |

**Agent prompts** (`src/agent/prompt/`):

| File | Agent |
|------|-------|
| `research.txt` | `research` (default harness) |
| `biology.txt` | `biology` |
| `physics.txt` | `physics` |
| `ml.txt` | `ml` |
| `critique.txt` | `critique` |
| `physics-critique.txt` | `physics-critique` |
| `reviewer.txt` | `reviewer` |
| `literature-review.txt` | `literature-review` |
| `write.txt` | `write` |
| `explore.txt` | `explore` |
| `compaction.txt` | `compaction` (system) |
| `title.txt` | `title` (system) |

## Agent Registry (`src/agent/agent.ts`)

| Agent | Mode | Hidden | Purpose |
|-------|------|--------|---------|
| `research` | primary | | Default entry point |
| `biology` | subagent | | Bioinformatics / wet-lab specialist |
| `physics` | subagent | | Simulation / numerical specialist |
| `ml` | subagent | | Training / evaluation specialist |
| `write` | subagent | | Scientific writing (LaTeX, grants) |
| `plan` | primary | | Read-only plan mode |
| `explore` | subagent | | Fast read-only codebase search |
| `literature-review` | subagent | | PRISMA systematic review |
| `critique` | subagent | | Scientific error detection (read-only) |
| `physics-critique` | subagent | | PDE/PINN validation (read-only) |
| `reviewer` | subagent | | Blind adversarial reviewer |
| `task` | subagent | | General-purpose child agent |
| `compaction` | primary | ✓ | Summarizes session history |
| `title` | primary | ✓ | Generates session titles |

Custom agents: add to `openscience.json` under the `agent` key.

## RCA & Debugging Guide

**Agent misbehaving? Trace the prompt chain:**

1. **Which agent is active?** → `src/agent/agent.ts` — find by name, check `mode`, `model`, `prompt`, `permission`, `steps`
2. **Which prompt is injected?** → `src/session/prompt.ts` — follow `insertReminders` by agent name
3. **Which system prompt?** → `src/session/system.ts` — `SystemPrompt.provider(model)` returns the shared product contract

| Symptom | Likely cause | Where to look |
|---------|-------------|--------------|
| Agent over-processes simple requests | Workflow prompt too procedural | `src/agent/prompt/{agent}.txt` |
| Wrong model used | Agent/model config incorrect | `src/agent/agent.ts` + `openscience.json` |
| Agent delegates excessively | Task contract lost the zero-child default | `src/tool/task.txt` + `src/session/prompt/core.txt` |
| Review runs on trivial work | Review threshold too broad | `src/agent/prompt/{agent}.txt` + `reviewer.txt` |
| Sub-agent returns empty | Context window exhaustion or bad prompt | `src/agent/agent.ts` — check subagent `steps` limit |
| Custom agent not appearing | Wrong config or `mode` | `openscience.json` `agent` key → `src/agent/agent.ts` |

## Style Guide

- **No `let`** — use `const`. For conditional values, use ternaries or IIFEs, not `let` + if/else.
- **No `else`** — prefer early returns.
- **Single-word variable names** where possible; avoid camelCase compounds.
- **No unnecessary destructuring** — use `obj.a` and `obj.b` instead of `const { a, b } = obj`.
- **No `try`/`catch`** where possible; prefer `.catch(...)`.
- **No `any` type**.
- **No mocks in tests** — test real implementations only; do not duplicate logic in tests.
- Use **Bun APIs** (`Bun.file()`, etc.) instead of Node equivalents.
- Rely on **type inference**; avoid explicit type annotations unless exporting or clarifying.
- Keep logic in **one function** unless it is genuinely reusable.

## Notes

- To regenerate the JavaScript SDK, run `./tooling/repo/generate.ts` from the repo root.
- **Use parallel tools whenever applicable.**
- The default branch is `main`.
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or irreversibility.
