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

## Prompt architecture

In this guide, `src/...` paths are relative to `backend/cli`; prompt paths such as
`agent/prompt/...` and `session/prompt/...` are relative to `backend/cli/src`.

The Research loop is shared across providers. Prompt selection, scientific context,
model options and API serialization are separate steps. The harness is OpenCode's
Build path with science in skills, agents, headers and a few switchable units;
the loop itself knows nothing about science, deliverables or budgets.

```text
Agent registry + selected model + current user message
    -> agent prompt, otherwise the model-family header with the science block
    -> environment (+ harness env lines), project instructions, core-skills index, posture reminder
    -> system-transform plugin, then parameter/header hooks
    -> provider message/tool normalization and inference options
    -> provider API
    -> on a final answer or a tripped guard, the harness units may continue or redirect
```

### Header selection

`LLM.prompts` in `src/session/llm.ts` selects an explicit `agent.prompt` first.
An agent without one (`research`, `plan`) receives the model-family header:
`SystemPrompt.provider(model)` in `src/session/system.ts` routes by wire model
id in OpenCode's order (`gpt-4`/`o1`/`o3` and other `gpt` → `gpt.txt`;
`gpt-6`/`astra` → `gpt-astra.txt`; `codex` → `codex.txt`; `gemini-` →
`gemini.txt`; `claude` → `anthropic.txt`; otherwise `default.txt`). Each family
file carries one `{{SCIENCE}}` slot that the runtime fills with
`agent/prompt/science.txt` (Evidence and files; Methods and deliverables;
Manuscripts and figures), so the science text is byte-identical across
families. `session/prompt/response.txt` is appended to every header.

Specialist agents (`ml`, `biology`, `physics`, `chemistry`, `data`) have their
own prompt: `agent/prompt/specialist.txt` with the same `{{SCIENCE}}` slot and
a `{{DOMAIN_SKILLS}}` slot that `SystemPrompt.render` fills from the agent's
skill categories at prompt time. An agent's configured `prompt` replaces its
built-in header, as before. On the `openai-codex` OAuth route a primary agent's
header travels in `options.instructions`; a worker's prompt stays in context
beneath the family header.

### Context and reminders

`src/session/prompt.ts` assembles the environment (`SystemPrompt.environment`,
including lines the harness units add through the `env.lines` hook: compute,
time budget, spend), project instructions, the `<core-skills>` index for the
lead (or the full catalog on an explicit `/skill` invocation), and the system
reminders before invoking `LLM.stream`. The one standing reminder is the
posture line from `researchEffortReminder` (effort, delegation level,
independence); Plan receives `session/prompt/plan.txt` instead. There is no
keyword-based tool selection and no quick/direct/inspection routing.

### Tool surface

`ToolRegistry.tools` in `src/tool/registry.ts` offers a tool when the agent's
ruleset does not deny it (`ToolVisibility.enabled`) and it is in the shared
default set, unlocked by a skill loaded in the current task epoch
(`allowed-tools`), or named by an explicit allow rule of the agent
(`Agent.Info.unlocks`). `apply_patch` replaces `edit`/`write` for GPT-family
wire ids; `research_search` needs a configured search provider; `question`
needs a client that can ask. `src/tool/visibility.ts` holds the rules.

### Harness units and hook points

`src/harness/*` are internal plugins registered at boot behind
`harness.<unit>` config switches (all on by default): `redirect`,
`deliverables`, `budget`, `cost`, plus the switches `headless-policy`,
`durable-jobs`, `workers`. The loop offers two hook points: `loop.before_finish`
(the model returned a final answer; a unit may inject a bounded continuation)
and `loop.guard` (a repetition guard tripped; a unit may redirect instead of
stopping). Injected continuations are durable synthetic user messages of kind
`harness`.

### Provider transport and plugins

On ordinary routes, `LLM.stream` joins the selected header, caller system context,
last-user custom system context into a system block.
`experimental.chat.system.transform` can transform or append blocks. An
empty replacement restores the original; appended blocks are regrouped when the
first block is unchanged. `chat.params` and `chat.headers` then adjust inference
parameters and request headers. `ProviderTransform.message` normalizes both
streaming and non-streaming SDK requests, including media, tool IDs, reasoning
replay, cache annotations and provider-option namespaces.

Inference settings follow provider defaults, model options, tier options, agent
options and the selected variant, followed by plugin adjustments. A tier may route
to another underlying model. Inspect the resolved route and outgoing parameters,
not only the displayed model name or an effort label.

### Active prompt files

| File                                                                                              | Role                                                                |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `agent/prompt/{anthropic,gpt-astra,gpt,codex,gemini,default}.txt` + `session/prompt/response.txt` | Model-family headers for research and plan, with writing defaults   |
| `agent/prompt/science.txt`                                                                        | The shared science block filled into every `{{SCIENCE}}` slot       |
| `agent/prompt/specialist.txt`                                                                     | The specialist worker template (`{{SCIENCE}}`, `{{DOMAIN_SKILLS}}`) |
| `agent/prompt/explore.txt`                                                                        | The scout worker                                                    |
| `agent/prompt/compaction.txt`, `title.txt`, `summary.txt`                                         | Internal summarization, UI-label and lab-notebook agents            |
| `session/prompt/plan.txt`, `build-switch.txt`, `max-steps.txt`                                    | Plan, mode-transition and step-limit guidance                       |
| `tool/task.txt`, `tool/recall.txt`, `tool/literature.txt`                                         | Tool contracts the model reads                                      |

## Agent registry

`src/agent/agent.ts` defines the built-in profiles and merges configured
overrides: `research` (primary, default), `plan` (primary, hidden), `explore`
(subagent), the specialists `ml`, `biology`, `physics`, `chemistry`, `data`
(subagents built from one template plus their skill categories), and the
internal `compaction`, `title`, `summary`. No built-in agent carries a model;
`agent.<name>.model`, `.variant` and `.skills` in `openscience.json` configure
one, and a configured `permission` rule that names a tool unlocks it for that
agent. Recommended models live in the documentation.

## Trace a behavior problem

1. Resolve the active agent, its configured prompt and permissions in
   `src/agent/agent.ts`; check the actual model/API/auth route.
2. Follow header selection through `LLM.prompts`, then context and reminders in
   `src/session/prompt.ts`. Compare the current user turn with resumed history.
3. Inspect plugin transforms, the exact offered tools and schemas, and the final
   provider request. `SessionHarness` fingerprints selected contract bytes and
   schemas; it does not by itself prove the entire final wire payload or billing.
4. Check `src/provider/transform.ts`, the selected provider/plugin implementation
   and SDK patches for option names, tool/result formats, cache and reasoning
   requirements. Prompt prose cannot repair an invalid API request.
5. For premature stops or repeated turns, inspect actual tool outcomes, terminal
   errors, cancellation and `src/session/loop-state.ts`. A provider finish label
   alone is not always a reliable indication that a local tool result was consumed.

Use local request fixtures before paid model comparisons. Keep model-specific
prompt quality experiments separate from required transport and lifecycle fixes.
