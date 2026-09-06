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

One unresolved compatibility case deserves a separate fixture: OpenScience's
content-filter error helper currently reports an error only when no partial text
exists. A filtered partial answer can therefore appear completed to the runtime.
OpenCode records a content-filter error even with partial output. Retain the
partial answer, expose the failure and avoid automatic retries if this is changed;
the continuation correction does not address that case. Source:
[OpenCode finish handling](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/session/processor.ts).

## Recommended OpenScience design

Keep four distinct layers, with a small optional addition at the second layer:

```text
Scientific contract        question, evidence, methods, uncertainty, useful outputs
Model interaction profile  tested guidance for this model and offered tool interface
Invocation context        workspace, project rules, relevant skills, files and state
Transport adapter         API shape, reasoning, tools, media, cache and error semantics
```

The scientific contract belongs to Research and stays consistent across models.
The model profile is deterministic request preparation, not another LLM deciding
how to prompt the first one. It should be empty by default until evaluated, or
explicitly selected as an experiment. Select using resolved model identity,
transport and capabilities; a relay provider name alone cannot identify a family.
Unknown models retain the current known-working fallback.

The appropriate insertion point is shared header/request preparation used by both
actual dispatch and context preflight. Routing only in `SystemPrompt.provider`
would miss default Research because its explicit `agent.prompt` overrides that
function. Keep custom-agent replacement semantics, narrow routes and internal
title/compaction contracts explicit. Avoid adding a second global agent registry.

A profile may explain tool-call discipline or an observed tendency to skip useful
validation. It must not invent tools, require a coding-specific artifact, redefine
workspace permissions, claim an environment is unsandboxed, or override a requested
scientific method. The actual allowed tool set and permission system remain
authoritative. Domain procedures continue to live in skills; providers do not own
separate copies of biology, physics or chemistry workflows.

Version each evaluated profile and record its content hash, exact serialized bytes,
tool/schema identity, resolved model/options, route and cache usage. Extend existing
`SessionHarness` records only when an added field is required for attribution.
That manifest currently captures selected contract and schemas, not a complete
post-serialization request or provider bill.

## Experiments before changing defaults

| Comparison                                               | Hold constant                                                          | Measure                                                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Current Research vs a compact model profile              | Model snapshot, native task, tools, scientific instructions and budget | Native score, invalid calls, repaired calls, missed tools, completion, input/cache/output usage and latency |
| Plain tool calls vs a supported parallel/batch interface | Available operations, permissions and total work                       | Successful call completion, dependency mistakes, request count and wall time                                |
| Existing context policy vs compact factual recovery      | Task, model, saved outcomes and access                                 | Recovery accuracy, duplicate side effects, retained failures and rediscovery cost                           |
| Fixed model vs bounded selective assistance              | Task envelope, declared spend cap and capability access                | Native quality, complete lead/child/retry cost and elapsed time                                             |

Run deterministic contract fixtures first. Keep prompt-quality trials separate
from mandatory API/lifecycle fixes. Use a development panel, freeze the profile,
then evaluate held-out tasks with paired assignments. Report each benchmark in its
native metric and preserve unsuccessful attempts. The five-lane qualification
requirements in [the scientific harness plan](scientific-harness-design.md) remain
unchanged; OpenCode prompt variety does not establish scientific benchmark gains.

For the plugin ecosystem, retain existing tools, connectors, skills and runtime
clients. A trusted plugin can already contribute model-aware system text through
the system-transform hook; use that seam for bounded experiments. A future public
profile contribution should be optional, inspectable and compatible with current
plugins. Avoid a permanent prompt block from every installed extension on every
turn; test discovery and activation before changing current exposure behavior.

No new provider prompt family, automatic router or mandatory multi-agent workflow
is enabled by this review. The source change addresses a reproduced lifecycle
failure. The model-profile proposal is ready for controlled evaluation, not claimed
to outperform the current Research prompt.
