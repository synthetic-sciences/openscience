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
model options and API serialization are separate steps. Do not infer active routing
from a prompt filename: several files serve hidden compatibility profiles.

```text
Agent registry + selected model + current user message
    -> select agent header, otherwise generic fallback
    -> environment, project instructions, applicable skills and mode reminders
    -> system-transform plugin, then parameter/header hooks
    -> provider message/tool normalization and inference options
    -> provider API
```

### Header selection

`src/agent/agent.ts` currently assigns the default `research` agent
`SystemPrompt.response(PROMPT_RESEARCH_AGENT_TEST)`: the short
`agent/prompt/researchagent-test.txt` plus `session/prompt/response.txt`.
Despite its historical filename, this is the active default Research header.
`agent/prompt/research.txt` is a longer compatibility workflow; it is not the
ordinary Research header.

`LLM.prompts` in `src/session/llm.ts` selects an explicit `agent.prompt` first.
If none exists, `SystemPrompt.provider(model, direct, inspection)` supplies a
fallback. That fallback currently ignores model identity and selects the common
core/direct/inspection contract. Adding model routing only inside
`SystemPrompt.provider` would therefore **not affect default Research**.

An agent's configured `prompt` replaces its built-in header. Preserve this
behavior for custom agents and internal title/compaction agents. The
[OpenCode harness comparison](docs/notes/opencode-harness-comparison.md) documents
upstream prompt selection and contrasts it with this current behavior.

### Context and reminders

`src/session/prompt.ts` assembles the current environment, project instructions,
and applicable reminder context before invoking `LLM.stream`. The filesystem
snapshot determines whether tools work in isolated scratch or the durable project.
Minimal Research avoids the generic compute and research-contract preambles.
Its system skill catalog is included for an explicit slash-skill invocation;
skill/tool discovery remains available through the existing tool layer.

`insertReminders` supplies ordinary mode/effort guidance in system context and
moves old synthetic user reminders into that context when reading saved sessions.
It preserves the durable history. Domain compatibility profiles can receive their
longer workflow reminder; default Research receives only its applicable effort
reminder. This is not a universal second prompt injected as a user message.

Direct and inspection routing also change tool/context selection. Because
`agent.prompt` wins header selection, those routes do not replace the default
Research header with `direct.txt` or `inspection.txt`.

### Provider transport and plugins

On ordinary routes, `LLM.stream` joins the selected header, caller system context,
last-user custom system context and applicable plan instructions into a system
block. `experimental.chat.system.transform` can transform or append blocks. An
empty replacement restores the original; appended blocks are regrouped when the
first block is unchanged. `chat.params` and `chat.headers` then adjust inference
parameters and request headers. `ProviderTransform.message` normalizes both
streaming and non-streaming SDK requests, including media, tool IDs, reasoning
replay, cache annotations and provider-option namespaces.

The `openai-codex` OAuth route uses a distinct transport: default Research's header
is sent once through `options.instructions`, and the remaining assembled context
is sent as a user-role message. For a non-Research agent with its own prompt, that
agent contract stays in context while the generic instructions occupy the API
instructions field. Do not duplicate either field or apply this rule to every
OpenAI-compatible provider. An explicit `chat.params` plugin can change options;
the actual serialized request remains the evidence.

Inference settings follow provider defaults, model options, tier options, agent
options and the selected variant, followed by plugin adjustments. A tier may route
to another underlying model. Inspect the resolved route and outgoing parameters,
not only the displayed model name or an effort label.

### Active prompt files

| File                                                                                        | Role                                                             |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `agent/prompt/researchagent-test.txt` + `session/prompt/response.txt`                       | Default Research header and writing defaults                     |
| `session/prompt/core.txt`                                                                   | Generic fallback for agents without their own header             |
| `session/prompt/direct.txt`, `inspection.txt`                                               | Narrow generic fallbacks and compatibility routing inputs        |
| `agent/prompt/research.txt`, `biology.txt`, `physics.txt`, `ml.txt`, `write.txt`            | Longer compatibility workflows selected through reminder routing |
| `agent/prompt/explore.txt`, `literature-review.txt`, `critique.txt`, `physics-critique.txt` | Explicit hidden-agent headers                                    |
| `agent/prompt/compaction.txt`, `title.txt`                                                  | Internal summarization and UI-label agents                       |
| `session/prompt/plan.txt`, `build-switch.txt`, `max-steps.txt`                              | Plan, mode-transition and step-limit guidance                    |

## Agent registry

`src/agent/agent.ts` defines built-in profiles and merges configured overrides.
`research` is the user-facing default and plan-exit target. Explore and Execute
are hidden task profiles; `plan` is read-only. Domain and older task profiles
remain hidden compatibility routes. `compaction` and `title` are internal agents.
A custom agent can be configured under `openscience.json` -> `agent` or created
through the agent CLI.

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
