# CLAUDE.md: OpenScience

Read `AGENTS.md` first: repository map, commands, conventions, and the CI/release
rules. This file keeps the product facts and the prompt-architecture guide that
help when the shipped agent misbehaves.

## Product facts

**OpenScience (`openscience`)** is an open-source, model-agnostic AI research agent for ML engineering and scientific work. Built with Bun and TypeScript, it ships as native binaries for Linux, macOS, and Windows.

- **npm package**: `@synsci/openscience`
- **Binary name**: `openscience`
- **Config dir**: `~/.config/openscience/` (override with `OPENSCIENCE_CONFIG_DIR`)
- **Data root**: `~/.openscience/` by default (relocatable; legacy `synsc` data imports automatically)
- **Config file**: `openscience.json`
- **Provider ID**: `synsci` (Atlas wire contract, do not rename)

## Prompt Architecture (Dual-Layer)

The CLI uses a **dual-layer prompt system**: provider-level system prompts + agent-level workflow prompts.

```
User request with agent name (e.g., "research")
  │
  ├─ Layer 1: SYSTEM role ← provider-neutral product contract
  │   src/session/system.ts supplies one contract to every model
  │
  └─ Layer 2: USER role injection ← agent prompt (task-specific)
      src/session/prompt.ts selects by agent name + tier
```

### Session prompts (`src/session/prompt/`)

| File                                | Purpose                                  |
| ----------------------------------- | ---------------------------------------- |
| `core.txt`                          | Provider-neutral operating contract      |
| `plan.txt`                          | Read-only Plan mode contract             |
| `build-switch.txt`, `max-steps.txt` | Mode transition and step-limit utilities |

Routing logic: `src/session/system.ts` supplies the same product contract to every model.

### Agent prompts (`src/agent/prompt/`)

| File                    | Active role                                    |
| ----------------------- | ---------------------------------------------- |
| `research.txt`          | `research`, the single user-facing harness     |
| `explore.txt`           | Hidden Explore profile and compatibility alias |
| `biology.txt`           | Hidden domain compatibility profile            |
| `physics.txt`           | Hidden domain compatibility profile            |
| `ml.txt`                | Hidden domain compatibility profile            |
| `write.txt`             | Hidden writing compatibility profile           |
| `literature-review.txt` | Hidden literature-review compatibility profile |
| `critique.txt`          | Hidden critique compatibility profile          |
| `physics-critique.txt`  | Hidden physics-critique compatibility profile  |
| `compaction.txt`        | Hidden system agent                            |
| `title.txt`             | Hidden system agent                            |

`execute` uses the shared execution contract rather than a separate prompt file. Plan mode lives in `src/session/prompt/plan.txt`. Routing logic in `src/session/prompt.ts` injects the Research effort contract and preserves the hidden compatibility prompts.

### Agent registry (`src/agent/agent.ts`)

Defines built-in agents with `Agent.Info` schema: `name`, `mode` (primary/subagent/all), `hidden`, `model`, `prompt`, `permission`, `temperature`, `steps`.

**Default harness**: `research` (the single user-facing default; also the plan-exit target)
**Internal task profiles**: `explore`, `execute` (hidden; selected by work type rather than domain branding)
**Mode**: `plan` (read-only)
**Compatibility profiles** (hidden): `task`, `biology`, `physics`, `ml`, `write`, `literature-review`, `critique`, `physics-critique`
**System agents**: `compaction`, `title`

Custom agents can be added via config file (`openscience.json` → `agent` key). See `src/cli/cmd/agent.ts` for the creation CLI.

## RCA & Debugging Guide

### Agent misbehaving? Trace the prompt chain:

1. **Which agent is active?** → `src/agent/agent.ts`, find the agent by name, check its `mode`, `model`, `prompt` fields
2. **Which prompt is injected?** → `src/session/prompt.ts`, follow the `input.agent.name` switch
3. **Which system prompt?** → `src/session/system.ts`, `SystemPrompt.provider(model)` returns the shared product contract

### Common failure patterns:

| Symptom                               | Likely cause                                                        | Where to look                                              |
| ------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------- |
| Agent over-processes a simple request | Workflow prompt is too procedural                                   | `src/agent/prompt/{agent}.txt`, preserve adaptive behavior |
| Wrong model used                      | Agent/model config incorrect                                        | `src/agent/agent.ts` + `openscience.json` `agent` config   |
| Agent delegates excessively           | Delegation posture or independent-work guidance regressed           | `src/tool/task.txt` + `src/session/prompt.ts`              |
| Delegation loops or stalls            | Task profile, capacity queue, or durable-attempt contract regressed | `src/tool/task.ts` + `src/session/loop-state.ts`           |
| Sub-agent returns empty               | Context exhaustion, provider failure, or a custom-agent step limit  | `src/agent/agent.ts` + child session trace                 |
| Custom agent not appearing            | Config not in `openscience.json` or wrong `mode`                    | Config file `agent` key → `src/agent/agent.ts`             |

### Key files for prompt debugging (read these first):

```
src/agent/agent.ts          # Agent definitions, what agents exist and their config
src/agent/prompt/*.txt      # Agent behavior, what the agent is told to do
src/session/prompt.ts       # Routing, which prompt gets injected for which agent
src/session/system.ts       # Provider routing, which system prompt for which model
```
