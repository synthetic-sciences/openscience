# OpenCode's harness and the scientific runtime

Source review: 7 September 2026. OpenCode checkout
`337fd144d2ba144743368f78d9579a99cce175bd`; current upstream HEAD checked at
`e207624c48159b03dbe17dbc8e51bbcf23e72df5`. The prompt, session, provider, tool,
agent and plugin source discussed here is identical at those commits. The newer
commit changes dependency versions and an OpenAI SDK patch, discussed separately.
OpenScience comparison starts at `dddb8bbf0a63b9e62d0314c4e55b009921a3760b`.
This is an upstream source-and-test review, not a fresh execution of OpenCode's
test suite or a model evaluation. Fresh OpenScience regression and fixture results
are recorded separately with the local implementation artifacts.

The design correction is straightforward: **a shared loop need not use identical
instructions for every model**. OpenCode's established session path combines
model-family prompts, tool conventions and transport adaptations. OpenScience
should preserve its scientific contract while evaluating concise model-specific
interaction guidance. Required API and lifecycle corrections belong in runtime
code and do not depend on a prompt experiment succeeding.

## First identify which OpenCode runtime is executing

The repository currently contains multiple execution paths. Treating all source
files as one active harness would give the wrong comparison.

| Path                                       | Entry and behavior                                                                                                                                                                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Established session loop, AI SDK transport | `/session/*` handlers call the legacy session service. It uses the provider-prompt catalog below and broad provider transforms. The normal app probes `/global/health` first and selects this protocol when it succeeds against the combined server.                                             |
| Established loop, native LLM adapter       | A per-request opt-in transport inside that same loop. It shares request preparation but has a separate eligibility check and conversion path. Installed support in the standalone LLM package does not imply that every session request can use it.                                              |
| Core V2 session runner                     | `/api/session/:sessionID/prompt` calls the new core runner. Its built-in Build agent has a short single-sentence header plus assembled baseline context; it does **not** route through the legacy model-family prompt catalog. Its provider resolver and tool materialization are also distinct. |

Both HTTP surfaces are mounted in the combined server. V2 route availability does
not mean every app session uses V2. Conversely, a standalone V2 server is not covered
by a description of only the old loop. Sources:
[combined routes](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/server/routes/instance/httpapi/server.ts#L274-L304),
[app protocol selection](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/app/src/utils/server-protocol.ts#L24-L34),
[V2 request assembly](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/core/src/session/runner/llm.ts#L196-L223), and
[V2 built-in agents](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/core/src/plugin/agent.ts#L12-L13).

This matters for benchmarking: freeze the executable, route, backend and config,
not just the name “OpenCode.” The thin V2 header is not evidence that removing
legacy model adaptation improves task success; the richer old prompts are not
evidence that every added instruction is necessary.

## Actual model-family prompt routing

In the established loop, an explicit `agent.prompt` wins. Otherwise
`SystemPrompt.provider(model)` selects by the **wire API model ID**, with a
provider-ID fallback for Kimi. The order of conditions matters; this is not a
single prompt per hosting company. A Claude model accessed through a relay can
still receive the Claude prompt.

| Matching rule, in order                                                                        | File            |                Raw UTF-8 bytes | Notable emphasis in the actual text                                                                                                |
| ---------------------------------------------------------------------------------------------- | --------------- | -----------------------------: | ---------------------------------------------------------------------------------------------------------------------------------- |
| API ID contains `muse`                                                                         | `meta.txt`      | 9,159 before name substitution | Named model identity and detailed interactive task/tool guidance.                                                                  |
| Contains `gpt-4`, `o1` or `o3`                                                                 | `beast.txt`     |                         11,080 | Persistent stepwise investigation, implementation and validation.                                                                  |
| Contains `gpt`, then `codex`                                                                   | `codex.txt`     |                          7,390 | Coding workflow, search/edit conventions, environment and output discipline.                                                       |
| Other API ID containing `gpt`                                                                  | `gpt.txt`       |                          9,284 | Autonomous execution, minimal changes, patch editing, explicit parallel-tool and communication conventions.                        |
| Contains `gemini-`                                                                             | `gemini.txt`    |                         15,372 | Detailed workflow and execution/validation instructions.                                                                           |
| Contains `claude`                                                                              | `anthropic.txt` |                          8,212 | Concise interaction, frequent task tracking and proactive focused delegation.                                                      |
| Lowercased ID contains `trinity`                                                               | `trinity.txt`   |                          7,748 | Very brief answers and sequential, one-tool-at-a-time work.                                                                        |
| Lowercased ID contains `kimi`, or provider is `kimi-for-coding`, `moonshotai`, `moonshotai-cn` | `kimi.txt`      |                          8,695 | Concrete tool execution, parallel independent calls, explicit file/environment handling, including research/data-processing tasks. |
| Otherwise                                                                                      | `default.txt`   |                          8,528 | General coding-agent workflow and tool guidance.                                                                                   |

Source: [routing function](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/session/system.ts#L29-L50)
and [prompt directory](https://github.com/anomalyco/opencode/tree/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/session/prompt).
Bytes were counted from the pinned files; these are not provider-token counts or
total request sizes. Most ID checks are case-sensitive, while Trinity/Kimi use
lowercasing. Reusing the idea does not require copying these substring rules.

The differences are substantive. GPT asks for a particular parallel-call wrapper
and patch editing; Trinity asks for sequential tools; Claude stresses task tracking
and delegation. These instructions are tied to a tool surface and product style.
They are neither interchangeable nor automatically appropriate for a scientific
agent. Sources: [GPT](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/session/prompt/gpt.txt),
[Trinity](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/session/prompt/trinity.txt),
[Claude](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/session/prompt/anthropic.txt).

Two tempting filenames, `copilot-gpt-5.txt` and `plan-reminder-anthropic.txt`, have
no references in the inspected repository. They are not active routing evidence.
Similarly, title, compaction, Explore and configured-agent prompts have their own
selection paths. A directory listing is not a reliable prompt architecture map.

## Follow assembly through the API request

The established request preparation performs these operations:

1. Select the explicit agent header or model-family fallback.
2. Append session-supplied environment, instructions, MCP/skill context and the
   current user's custom system context.
3. Invoke `experimental.chat.system.transform`.
4. Preserve the first block when unchanged and regroup appended material into
   another block. This preserves a cache-friendly layout; it does not guarantee a
   cache hit or keep dynamic context out of the first block.
5. Merge default, model, agent and selected-variant options, then invoke parameter
   and header hooks.
6. Convert the assembled instructions and messages into the selected transport.

The OpenAI OAuth test is a **provider/auth route** check. It places the assembled
system text into the API `instructions` option rather than selecting a new family
prompt. A model with `codex` in its API ID independently selects `codex.txt`.
Do not conflate those decisions. Source:
[request preparation](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/session/llm/request.ts).

OpenScience's current transport differs deliberately. Default Research supplies
its short header first; an ordinary request sends assembled system messages,
while `openai-codex` OAuth sends the Research header once as `instructions` and the
remaining context in a user-role message. Distinct custom agent contracts and
plugin output are preserved. The existing real `LLM.stream` request fixture
checks this boundary. Moving every piece into the same field merely to match
OpenCode would be a behavioral change requiring its own compatibility evidence.

## Model adaptation is larger than prompt text

The provider layer is a contract between model capabilities, API semantics and
tools. It includes:

- **Reasoning and sampling:** only valid parameter names and values for the chosen
  model/transport; model, agent and variant precedence; different settings for
  auxiliary calls; valid output budgets.
- **History and reasoning replay:** preserving required reasoning/signature
  metadata, normalizing tool-call/result IDs and ordering, and handling model or
  provider changes without replaying unsupported records.
- **Schemas and tool surfaces:** legal JSON Schema forms, model-appropriate editing
  tools, batched-call handling, dynamic/MCP tool exposure and permission filtering.
- **Media and observations:** unsupported-part handling, provider-specific image
  formats, truncation with retrievable output, and pairing results with invocations.
- **Caching and affinity:** provider-option namespaces, cache annotations and
  session affinity. Record actual cache usage; a stable string hash is insufficient.
- **Execution outcomes:** tool-call repair, actual local tool-result feedback,
  cancellation, context overflow and retry classification.

Sources: [provider transforms](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/provider/transform.ts),
[tool registry](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/tool/registry.ts), and
[LLM dispatch](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/session/llm.ts).
OpenScience already implements substantial provider adaptation through
`ProviderTransform`, provider plugins, tool-schema normalization, request-context
telemetry and replay guards. Inspect the final request before concluding an
adaptation is absent because it is not in a prompt file.

The latest upstream dependency change illustrates this boundary. It updates the
OpenAI/Azure SDK versions and removes client-side stripping of configured `flex`
and `priority` service tiers from Chat and Responses requests. This allows a
configured value to reach the server; it neither grants entitlement nor selects
priority automatically. Source:
[the current SDK patch](https://github.com/anomalyco/opencode/blob/e207624c48159b03dbe17dbc8e51bbcf23e72df5/patches/%40ai-sdk%252Fopenai%403.0.88.patch).
Do not blindly copy a dependency bump across OpenScience's existing provider
fixes. Capture representative requests and check API behavior in a separate change.

The new native path is not complete generation-setting parity. At this pin its
Anthropic lowering handles enabled token-budget thinking but does not lower all
legacy adaptive effort/display/binding settings. Its Gemini lowering handles
thinking budgets but omits the newer thinking-level field; Gemini is also outside
the current V2 session resolver. Source:
[native Anthropic lowering](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/llm/src/protocols/anthropic-messages.ts#L493-L503),
[native Gemini lowering](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/llm/src/protocols/gemini.ts#L292-L299), and
[V2 resolver](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/core/src/session/runner/model.ts#L131-L179).
A transport fallback gate can pass while a particular setting is still lost.

Some schema conversions are lossy: changing tuple shapes, flattening unions or
stringifying enums may change the advertised contract. Retain the original local
validator and test scientific parameter semantics after projection. Suitable next
OpenScience fixtures cover signed empty Anthropic reasoning, empty interleaved
reasoning fields, nested/nullable scientific and MCP schemas, and explicit settings
through direct versus cloud routes. These are source-backed comparison targets,
not reproduced production failures in this review.

## Lifecycle lessons that affect scientific work

OpenCode's established loop checks actual local tool calls before interpreting a
provider finish reason as completion. Some providers emit `stop` alongside a tool
call. A local result still needs to return to the model; provider-executed tools
and cleanup-interrupted orphans are excluded. Source:
[continuation check](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/session/prompt.ts#L1103-L1115).
This exposed a reproducible OpenScience gap: a local tool ran once, but a `stop`
label prevented the second request and final answer. The bounded correction uses
qualified local outcomes while preserving text-only completion, cancellation,
overflow recovery and configured step-limit termination.

The V2 runner mechanically removes tools on its final configured step and selects
`toolChoice: none`. OpenScience currently sends a last-step reminder and records a
partial terminal outcome, while tools remain available on that step. These are
different budget semantics. A future final-handoff improvement should be tested
against child-task results and real message limits; it is not part of the small
continuation correction. Source:
[V2 final-step assembly](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/core/src/session/runner/llm.ts#L202-L222).

Compaction and recovery also require a state contract. Preserve factual tool/job
outcomes and file references; do not rerun a completed scientific experiment merely
because its conversational explanation was compacted. Different loops have
different context epochs, replay, overflow and continuation mechanisms. Importing
one numerical compaction threshold without those surrounding rules is unsafe.
OpenScience's current-turn preflight, bounded overflow handling, durable carriers
and recovery records are useful existing infrastructure to retain.

Preserve OpenScience's refusal to automatically redispatch after tool side effects
have started. OpenCode's established loop has a broader retry path, including
cases after a tool has begun; copying that policy could duplicate experiments.
The current OpenScience cross-message tool repetition check is also stronger than
checking only the latest assistant message. These are reasons to compare concrete
failure behavior rather than replace the loop wholesale.

OpenScience now records a content-filter failure even when partial text exists,
while preserving that text and completed tool actions. A local streaming-provider
regression exercises the public runtime API: one write completes before filtered
text arrives, the run fails, and neither an exact request retry nor re-entering the
session loop repeats the provider request or write. This correction is separate
from tool continuation. OpenCode also records a content-filter error with partial
output. Source:
[OpenCode finish handling](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/session/processor.ts).

## OpenScience implementation boundary

Default Research retains its explicit scientific header. Since v2.0.94 that
header (`agent/prompt/researchagent-test.txt`) follows the shape of OpenCode's
`gpt-astra.txt`: a Harness section that tells the model how its output renders
(narration between tool calls, the last message as the answer), then
Communication with Autonomy, Progress, Questions and Final answer, then the
scientific specifics (evidence and files, manuscripts and figures). Working-folder
routing stays in the environment block rather than the header, and the effort,
delegation and independence postures stay in the per-request reminder. Session
assembly adds workspace, project, skill and user context, while provider
transforms handle API shape, reasoning, tools, media, cache and errors. Custom-agent prompt replacement
and internal title/compaction contracts remain separate. The allowed tool set and
permission system are authoritative; domain procedures live in skills.

The existing system-transform plugin hook can modify system context. Its presence
does not imply a separate model-prompt registry or automatic routing policy.
`SessionHarness` captures selected contracts and schemas, not a complete
post-serialization request or provider bill.

The reproduced continuation failure is an independently tested lifecycle fix.
Deterministic contract fixtures establish API and execution behavior, while native
scientific scores require actual evaluation. The five-lane qualification
requirements in [the scientific harness plan](scientific-harness-design.md) remain
unchanged; OpenCode's prompt variety does not establish scientific benchmark gains.

## Audit, 13 September 2026

OpenCode checkout `95daf90670b7c039c436c85537da5fbfe2205b41` (`/tmp/opencode`),
read against OpenScience at the commit that removed Fusion. The two harnesses
share an ancestor and the same loop shape; the differences below are the ones
that decide behaviour.

### Header

|                          | OpenCode                                                                                                                                                                                                                                                                                  | OpenScience                                                                                                                                                                                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Selection                | `SystemPrompt.provider(model)` picks a model-family file by wire model id: `anthropic.txt` (8.2 kB), `gpt.txt`, `gpt-astra.txt` (46 lines, GPT-6), `codex.txt`, `beast.txt`, `gemini.txt`, `meta.txt`, `kimi.txt`, `trinity.txt`, else `default.txt`. `agent.prompt` replaces the header. | One model-agnostic header for Research, `agent/prompt/researchagent-test.txt` + `session/prompt/response.txt` (~60 lines, the shape of `gpt-astra.txt`). `agent.prompt` replaces it for custom and internal agents. `SystemPrompt.provider` is only the fallback for agents without a header. |
| Content                  | Coding: TodoWrite discipline, proactive Task delegation, concise CLI output, code references.                                                                                                                                                                                             | Research: how output renders, autonomy sized to the request, when to report and when to ask, the final-answer shape, evidence and files, manuscripts sized to the request. No task-list ritual.                                                                                               |
| Context after the header | `<env>` (cwd, worktree, git, platform, date), `<available_references>`, AGENTS.md / CLAUDE.md / CONTEXT.md (first match up the tree, global first), `config.instructions` paths and URLs, skills, MCP instructions, `user.system`.                                                        | `<env>` with project, project files, session scratch, Results, access mode, connected folders; the working-folder routing rules; project instructions; the `<core-skills>` index (15 core skills, one line each, plus the cloud-compute and databases pointers); then the system reminders.   |
| Reminders                | Plan mode and the plan→build switch are synthetic **user** parts (`reminders.ts`).                                                                                                                                                                                                        | Effort, delegation, independence, quick/direct routes and study mode are **system** context (`insertReminders`); nothing is injected as a user message. Older synthetic reminders in saved sessions are moved into system context on read.                                                    |

### Loop

Both run the AI SDK stream through a processor with a step counter, `agent.steps`
as the cap and a synthetic "max steps reached, text only" assistant message at the
last step. Both treat `tool-calls`/`unknown` as non-terminal and keep going when a
provider reports `stop` with unresolved tool calls. OpenCode's doom-loop guard is
three identical tool calls → a `doom_loop` permission ask; OpenScience's
`tool-retry-guard` is per-tool (repeated fetches, transfers, writes) and answers
the model with what to change instead of asking the user. Retries: both
exponential with jitter, five attempts, provider `retry-after` honoured; neither
retries context overflow.

Compaction: OpenCode compacts when usage reaches `limit.input − min(20k, output)`
and writes a fixed-section summary (Objective, Important Details, Work State,
Next Move, Relevant Files), preserving the newest ~15k tokens of turns and pruning
old tool outputs separately. OpenScience compacts proactively, on overflow and on
`/compact`, writes a handoff with the same kind of sections plus the child-work
record, keeps the protected newest context, and stops proactive compaction for the
session after ineffective rounds so a runaway session cannot spin. Both fold the
previous summary into the next instead of re-summarising raw history.

### Workers

|           | OpenCode                                                                                                                                                                                                                                                                                                                                                 | OpenScience                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Profiles  | `build`, `plan` (primary); `general`, `explore` (subagent); `compaction`, `title`, `summary` internal. Configured agents default to mode `all`.                                                                                                                                                                                                          | `research` (primary), `plan` (primary, hidden); `explore`, `execute` (subagent); specialists `ml`, `biology`, `physics`, `chemistry`, `critique` as a `specialist` layer on those profiles; `compaction`, `title` internal; domain compatibility agents hidden.                                                                                                                                                                                                                     |
| Task tool | `description`, `prompt`, `subagent_type`, `task_id` (resume), `command`, experimental `background`. Depth limit 1 (`subagent_depth`), so children cannot dispatch. Foreground call waits for the child's final text, returned as `<task_result>`. No concurrency cap. Child inherits the parent's model and variant unless the agent configures a model. | `description`, `prompt`, `subagent_type`, `specialist`, `session_id` (continue). Only the lead dispatches; children get `task: false`. Concurrency `MAX_CHILD_AGENTS = max(2, cores)`, compute workers capped separately. A durable `TaskAttempt` makes a dispatch restart-safe; the child runs in an isolated workspace and hands back saved Results. Worker model from Customize → Models, else the lead's model; a worker on the lead's model now inherits its reasoning effort. |
| Strategy  | One: fresh child per call, parallel calls in one message.                                                                                                                                                                                                                                                                                                | Now one: the same. Fusion (a bound persistent worker with handoff budgets) is removed.                                                                                                                                                                                                                                                                                                                                                                                              |
| Posture   | The Claude header says "use the Task tool proactively"; the Task description says launch agents concurrently whenever possible.                                                                                                                                                                                                                          | Delegation is a setting (Off / Auto / High) plus Independence; the reminder says one worker per independent branch with a bound and a definition of done, and that checking the lead's own output is never delegated.                                                                                                                                                                                                                                                               |

### Reasoning

Option assembly is the same family of code in both: OpenAI Responses get
`reasoningEffort` + `reasoningSummary` + `include: ["reasoning.encrypted_content"]`
with `store: false`; Anthropic gets `thinking: { type: "adaptive" }` + `effort` (or
`budgetTokens` on older models); Gemini gets `thinkingConfig.includeThoughts` with
`thinkingLevel` or a budget; OpenRouter gets `reasoning: { effort }`. Reasoning
parts persist as `{ text, metadata, time }` and replay with `providerMetadata`;
both drop replay when the model changes.

Differences after this audit:

- **Depth.** OpenCode leaves the provider default (medium for GPT-5, cycled with
  `ctrl+t`). OpenScience now defaults the composer's effort to **high** whenever a
  model offers it; the picker keeps every level. A worker on the lead's model
  inherits that effort.
- **Summary detail.** OpenCode requests `reasoningSummary: "auto"`. OpenScience
  requests `"detailed"` from the GPT-5/GPT-6/o3/o4/codex families on direct OpenAI,
  Azure and Codex OAuth, and `"auto"` elsewhere (Copilot, o1, o3-mini). Through
  OpenRouter the summary depth is OpenRouter's to choose; a phase it returns as
  `[REDACTED]` has no readable text on any client.
- **Display.** OpenCode's TUI shows a collapsed block with elapsed time. The
  workspace shows a "Thought Ns" row with the summary as Markdown; consecutive
  parts fold into one row; a phase the provider kept private is a label with its
  duration and nothing to open, never a placeholder sentence.

### Core skills and the research loop

The skill index is the main structural difference from OpenCode, which has skills
but no always-present index. Research carries `<core-skills>` every turn: the
fifteen core procedures in workflow order with one line each, the cloud-compute and
database library pointers, and the rule to load one skill by exact name when the
request matches. Bodies never preload. A loaded skill's `allowed-tools` unlocks
those tools for the loading agent. The `/` menu in the workspace mirrors the same
order. Autoresearch is a core skill plus the `study`/`experiments` tools and the
study driver: the driver watches runs, enforces kill criteria and budgets, wakes
the session with "Study update" user messages, and the study reminder in system
context carries the objective, baseline, best, queue, budget, directives and
lessons every turn, so the loop survives compaction.

## State after the harness refinement (13 September 2026)

The refinement described in `opencode-core-for-science.md` closed most of the
gaps this note recorded, against OpenCode commit
`95daf90670b7c039c436c85537da5fbfe2205b41`:

| Concern          | OpenCode                                                                                               | OpenScience now                                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header selection | `SystemPrompt.provider` by wire model id, one file per family                                          | The same routing (`anthropic`, `gpt-astra`, `gpt`, `codex`, `gemini`, `default`) with the coding sections replaced by one shared `{{SCIENCE}}` block; `research` and `plan` carry no prompt of their own |
| Tool visibility  | Permission ruleset only                                                                                | Permission ruleset plus a shared default set, skill `allowed-tools` unlocks and per-agent allow rules; no keyword selection                                                                              |
| Agents           | build, plan, general, explore, compaction, title, summary                                              | research, plan, explore, five specialists from one template plus a `<domain-skills>` index, compaction, title, summary; no models in code                                                                |
| Task tool        | `subagent_type` = agent name, `task_id`, `subagent_depth`, same directory, `<task_result>`, background | The same contract, keeping the restart-safe attempt record and structured execution receipts                                                                                                             |
| Compaction       | Template with Objective / Work State / Next Move                                                       | The same shape plus Deliverables (verbatim) and Findings so far; the root user message is pinned ahead of every summary; `todowrite` results are never pruned                                            |
| Loop extensions  | None                                                                                                   | `loop.before_finish` and `loop.guard` hooks; the switchable units `redirect`, `deliverables`, `budget`, `cost`, `headless-policy`, `durable-jobs`, `workers`                                             |
| Headless run     | n/a                                                                                                    | `--delegation`, `--worker-model`, `--autonomy`, `--deadline`; child events tagged with `parentID`; usage rolled into `done.children`                                                                     |

What still differs deliberately: the `<core-skills>` index in the lead's
context, the `literature` and `recall` tools, the Results store and the
autoresearch tools (skill-unlocked), and the posture reminder as a runtime
setting rather than header text.
