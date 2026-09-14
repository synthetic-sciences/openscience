# Harness refinement plan (dev handoff)

Status: approved design, 13 September 2026. This is the work order for the
OpenScience harness refinement. It contains everything the implementer needs:
the intent, the current state with file pointers, the target design, and the
work packages with acceptance criteria. Benchmarking is out of scope for this
plan and starts only after the work below is merged.

Read `AGENTS.md` (repository map, commands, conventions) and `CLAUDE.md`
(prompt architecture) first. Both remain authoritative; this plan changes
several facts they describe (the default header, tool selection, the agent
registry), so update them in the final work package.

## 1. Intent

OpenScience is a fork of OpenCode. The goal of this refinement is to make the
harness as small and functional as OpenCode's `build` agent path while being a
research harness: science lives in skills, agents, headers and a handful of
switchable units, not in the loop. Concretely:

- Tool visibility derives from permissions, as in OpenCode. No keyword
  heuristics.
- The default `research` agent receives a model-family header selected by wire
  model id, modelled on OpenCode's family files, with the coding sections
  replaced by science sections.
- Agents are `research`, `plan`, `explore`, five specialists, and the internal
  `compaction`, `title`, `summary`. No `critique` agent, no `execute`/`general`
  profile, no hidden domain compatibility profiles, no quick/direct/inspection
  routes.
- Delegation follows OpenCode's Task tool contract (agent name as
  `subagent_type`, `task_id` resume, depth limit from config, same working
  directory, `<task_result>` output, background mode), without a concurrency
  cap.
- No model is hardcoded on any agent. Recommended defaults are documented
  configuration.
- A small set of harness units, each with a config switch, deliver context at
  the point in the loop where it matters: headless policy, loop redirect,
  deliverables checklist and pre-finish check, time/compute budget, cost
  visibility, durable local jobs, worker streaming.
- Everything must remain a good default for an interactive user. Nothing in
  the harness may know a benchmark's name, paths, rubric vocabulary or task
  identity.

## 2. Reference material

OpenCode at commit `95daf90670b7c039c436c85537da5fbfe2205b41` (11 Sep 2026).
A checkout may exist at `/tmp/opencode`; if not:

```bash
git clone https://github.com/anomalyco/opencode /tmp/opencode
git -C /tmp/opencode checkout 95daf90670b7c039c436c85537da5fbfe2205b41
```

Files to model on (all under `packages/opencode/src` unless noted):

| Purpose                                   | File                                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Family headers                            | `session/prompt/anthropic.txt` (105 lines), `gpt-astra.txt` (46), `gpt.txt` (107), `codex.txt` (79), `gemini.txt` (155), `default.txt` (95) |
| Header routing by wire model id           | `session/system.ts` (`SystemPrompt.provider`)                                                                                               |
| Agents and permission rulesets            | `agent/agent.ts` (`build`, `plan`, `general`, `explore`, `compaction`, `title`, `summary`)                                                  |
| Internal agent prompts                    | `agent/prompt/compaction.txt`, `title.txt`, `summary.txt`, `explore.txt`                                                                    |
| Tool registry and model-conditional tools | `tool/registry.ts` (`apply_patch` for `gpt-` models, `websearch` provider gating, `question` client gating)                                 |
| Task tool contract                        | `tool/task.ts`, `tool/task.txt`                                                                                                             |
| Compaction constants and template         | `session/compaction.ts` (`PRUNE_PROTECT`, `PRUNE_MINIMUM`, summary template sections)                                                       |
| Core V2 (reference only, not the target)  | `packages/core/src/plugin/agent.ts`, `packages/core/src/system-context/*`                                                                   |

`docs/notes/opencode-harness-comparison.md` records the earlier comparison and
must stay accurate after this work.

## 3. Current state (facts the implementer relies on)

Paths are relative to `backend/cli/src` unless noted. Line numbers are
approximate at the time of writing.

### Loop and context

- `session/prompt.ts` (3,873 lines). `SessionPrompt.prompt` (~325),
  `SessionPrompt.loop` (~1756), private `execute` (~733). Tools are attached in
  `resolveTools` (~1897–2200). Loop guards: output-limit stall stop (~964),
  text doom-loop stop (~1045–1058). System block assembly ~1509. Reminders in
  `insertReminders` (~2916) and `researchEffortReminder` (~2253), which renders
  effort, delegation level and independence posture.
- `session/processor.ts` (1,482 lines). Line ~857: a denied tool call breaks
  the loop unless `experimental.continue_loop_on_deny` is true.
- `session/tool-selection.ts` (317 lines). `ToolSelection.relevant` exposes
  tools by regex on the user message (`edits`, `python`, `todo`, `compute_job`,
  biology queries, `science_*`), plus `quick`, `direct`, `inspection` routes.
  `activation` collects `allowed_tools` from loaded skills; `enabled` applies
  permissions. Used from `prompt.ts` at ~990, ~1507–1518, ~1849–1869,
  ~1972–1998, ~2044, ~2069–2084, ~2958.
- `session/system.ts` (280 lines). `SystemPrompt.environment` (~207) renders
  `<env>` (model id, project, session, directories, Results, access mode,
  connected folders, git, platform, date) plus workspace routing prose.
  `SystemPrompt.coreSkills` (~154) renders `<core-skills>`.
  `SystemPrompt.provider(_model, direct, inspection)` (~32) ignores the model
  and returns `core.txt`/`direct.txt`/`inspection.txt`.
- `session/compaction.ts` (802 lines). Prune protects the newest 40k tool
  tokens, never prunes `skill`/`artifact` parts; summary uses the hidden
  `compaction` agent and `agent/prompt/compaction.txt` (a generic "summarize
  the conversation" prompt); circuit breaker after ineffective rounds.
- `session/message-v2.ts`. `filterCompacted` (~1369) presents
  `[summary, retained tail, continuation]`; the root user message is inside the
  summarized head. `DelegationSettings` (~31): `level` off/light/standard/high,
  optional `workerModel`, `autonomy` interactive/balanced/autonomous.
- `session/tool-retry-guard.ts`: per-tool retry guards (apply_patch, webfetch,
  kernels) that answer the model with what to change. Keep.
- `session/harness.ts`: `SessionHarness` fingerprints selected contract bytes
  and schemas; tests in `test/session/harness.test.ts`.

### Agents, tools, prompts

- `agent/agent.ts` (652 lines). `Agent.compute` (~158) defines `research`
  (prompt `SystemPrompt.response(PROMPT_RESEARCH_AGENT_TEST)`), a hidden
  `researchagent-test` alias, hidden `biology`, `physics`, `ml`, `chemistry`,
  `write`, `plan`, `execute`, `task`, `explore`, `literature-review`,
  `critique`, `physics-critique`, and internal `compaction`, `title`.
- `agent/specialist.ts` (121 lines): the specialist layer applied on top of
  Task profiles (`ml`, `biology`, `physics`, `chemistry`, `critique`), with the
  `<domain-skills>` index.
- `agent/prompt/`: `researchagent-test.txt` (the active Research header, ~30
  lines) + `session/prompt/response.txt` (writing defaults); compatibility
  prompts `research.txt`, `biology.txt`, `physics.txt`, `ml.txt`, `write.txt`;
  `explore.txt`, `literature-review.txt`, `critique.txt`,
  `physics-critique.txt`; internal `compaction.txt`, `title.txt`.
  `session/prompt/`: `core.txt`, `direct.txt`, `inspection.txt`, `plan.txt`,
  `build-switch.txt`, `max-steps.txt`, `response.txt`.
- `tool/registry.ts` (336 lines) registers ~34 tools: ApplyPatch, Artifact,
  Bash, Batch, CodeSearch, ComputeJob, Edit, Experiments, GenerateImage, Glob,
  Grep, Invalid, Lsp, Modal, Notebook, PlanEnter, PlanExit, PlanWrite,
  ProviderCompute, Python, Question, RKernel, R, Read, ResearchContract,
  ResearchSearch, ScientificCapability, Skill, Study, Task, TodoRead,
  TodoWrite, WebFetch, Write, plus `query_*` biology tools, `science_*`
  connectors, `atlas*`, `provenance_*`, MCP and plugin tools.
- `tool/task.ts` (810 lines). `DELEGATION_PROFILES = ["explore", "execute"]`,
  `specialist` parameter, `session_id` continuation, `MAX_CHILD_AGENTS`,
  durable `TaskAttempt`, isolated worker workspace with artifact handoff,
  worker model resolution `settings.workerModel ?? agent.model ?? leadModel`
  (~475–528), children denied `task`/`question`/todo tools.
- `tool/truncation.ts`. `Truncate.hint` tells the model to use the Task tool
  whenever the agent's permission allows `task`, regardless of whether
  delegation is enabled for the session.
- `tool/bash.txt` says shell children die when the call ends and to use
  `compute_job` for durable work, and to use `research_search`/`webfetch` for
  the web. `tool/bash.ts`: no default timeout (`DEFAULT_TIMEOUT = 0`).
- `tool/compute-job.ts`: local target needs no approval; remote targets
  (`modal`, `ssh`) go through approval.
- `config/config.ts` `Config.Agent` (~887): `model`, `temperature`, `top_p`,
  `prompt`, `tools` (deprecated), `disable`, `description`, `mode`, `hidden`,
  `options`, `color`, `steps`, `permission`.
- `skill/skill.ts`: frontmatter `allowed-tools`/`allowed_tools` (~123, ~222);
  `Skill.compute` (~277); bundled skills under `backend/cli/skills/<category>/`
  (354 `SKILL.md`; 15 `core`). `OPENSCIENCE_DISABLE_BUNDLED_SKILLS` in
  `flag/flag.ts`.

### Headless run and adapter

- `cli/cmd/run.ts` (723 lines). Options at ~477–548: `command`, `continue`,
  `session`, `workspace`, `model`, `agent`, `format`, `file`, `title`,
  `attach`, `auto-approve`, `deny-prompts`, `variant`, `effort`, `bare`.
  `QUESTION_DENY` session rule (~38). `related()` tracks the session family
  for permission routing (~235–246). A `question.asked` event is rejected and
  sets `rejected = true` (~396–402), which becomes status `rejected` and a
  non-zero exit code (~459–461). `delegation = policy === "allow" ? false :
undefined` (~410–412): auto-approve disables delegation because the JSON
  stream subscribes to root-session parts only.
- `cli/run-events.ts`: JSON Lines schema (`user`, `tool_use`, `step_start`,
  `step_finish`, `reasoning`, `text`, `permission`, `error`, `done` with
  summed tokens and cost).
- `tooling/harbor/openscience_harbor/agent.py`: `DEFAULT_CONFIG` denies
  `research_search`, `atlas`, `atlas_write`, `remote_compute`, `modal`,
  `provider_compute`, `compute_job`; kwargs `skills`, `binary`,
  `binary_sha256`, `cwd`, `openscience_config`, `variant`, `effort`, `agent`;
  runs `openscience run --format json --auto-approve --workspace project`.
  `tooling/harbor/openscience_harbor/trajectory.py` converts the stream to
  ATIF and withholds totals when a `task` call is observed.
- `tooling/plugin/src/index.ts` hooks: `event`, `config`, `tool`, `connector`,
  `auth`, `chat.message`, `chat.params`, `chat.headers`, `permission.ask`,
  `command.execute.before`, `tool.execute.before/after`,
  `experimental.chat.messages.transform`, `experimental.chat.system.transform`,
  `experimental.session.compacting`, `experimental.text.complete`, `dispose`.

## 4. Target design

### 4.1 Tool surface

Visibility is decided only by (a) the agent's permission ruleset, (b) session
`tools` overrides, (c) `allowed_tools` of skills loaded in the current task
epoch, and (d) model/client conditions listed below. `tool-selection.ts` is
deleted; `resolveTools` uses `enabled` + activation only.

Default set offered to `research` (14):

`bash`, `read`, `glob`, `grep`, `edit` + `write` (or `apply_patch` instead of
both when the wire model id contains `gpt-` and neither `gpt-4` nor `oss`,
OpenCode's rule), `webfetch`, `research_search` (only when a search provider
is configured; hidden otherwise), `todowrite` (always), `task`, `skill`,
`question` (interactive clients only; hidden when the session cannot ask),
`python`, `compute_job`, `artifact`. `invalid` remains the internal repair
tool.

Unlocked by skill `allowed_tools` or by an agent's permission ruleset:
`r`, `rkernel`, `notebook`, `query_ensembl`, `query_kegg`, `query_ncbi_gene`,
`query_pdb`, `query_pubmed`, `query_string`, `query_uniprot`,
`science_list_dbs`, `science_search`, `science_fetch`, `experiments`, `study`,
`generate_image`, `lsp`, `codesearch`, `modal`, `provider_compute`,
`remote_compute`, `plan_enter`/`plan_exit` (plan agent), MCP and plugin tools.

Removed from the model-facing surface (code may remain if other subsystems
depend on it, but nothing registers them as model tools): `batch`, `todoread`,
`planwrite`, `research_contract`, `scientific_capability`, `atlas`,
`atlas_record`, `provenance_*`.

Every tool description must only reference tools that can be offered in the
same session. `bash.txt` mentions `compute_job` and `research_search`; render
those sentences conditionally or make them neutral ("use the durable job tool
when it is available").

### 4.2 Model-family headers

`agent/prompt/` gets `anthropic.txt`, `gpt-astra.txt`, `gpt.txt`, `codex.txt`,
`gemini.txt`, `default.txt`. `SystemPrompt.provider(model)` selects by wire
model id with OpenCode's ordering (contains `gpt-4`/`o1`/`o3` → a
`beast`-style file is not needed; treat as `gpt`; `codex` → `codex.txt`;
other `gpt` → `gpt.txt`; `gpt-6`/`astra` → `gpt-astra.txt`; `gemini-` →
`gemini.txt`; `claude` → `anthropic.txt`; otherwise `default.txt`). `research`
has no `prompt` of its own and takes the family header; any agent with
`prompt` set replaces it, as today. `session/prompt/response.txt` stays
appended.

Each file is OpenCode's skeleton for that family with the coding-specific
sections replaced by three science sections shared verbatim across families:

- Evidence and files (existing text from `researchagent-test.txt`).
- Methods and deliverables: when outputs are specified, write the exact
  deliverables (paths, formats, columns/keys/shapes, units, rounding, naming,
  tie-breaks, exclusions, method constraints) as a checklist before computing
  and check each mechanically before finishing; read every supplied spec,
  schema, README and self-checker first; treat method guidance and each clause
  of the question as binding, implement the specified chain rather than a
  proxy, keep stated definitions and tool flags, anchor conclusions to the
  named entities; identifiers, versions and dates may postdate training, verify
  by lookup rather than doubting them; when code will run on unseen inputs,
  implement the general method and test it on perturbed inputs, fix seeds and
  thread counts; do not declare completion while deliverables are missing and
  budget remains; never write synthetic or placeholder values, write real
  partial results and name the gap; record decisions, alternatives and
  parameters in the trace, report raw and adjusted statistics with the test
  justified, state uncertainty, cite sources or mark values as computed from
  the provided data; ask for the smallest sufficient tool output.
- Manuscripts and figures (existing text).

Family-specific material to keep from OpenCode: Claude's todo discipline,
objectivity and Task-for-search policy; GPT-6's channel semantics, bias to
action, no unsolicited disclaimers, no over-testing; GPT-5's `apply_patch`
rule, parallel wrapper, formatting rules (no nested bullets, no em dashes, no
interjection openers), persistence; Codex's question policy and final-answer
style; Gemini's understand → plan → implement → verify workflow, brevity and
"keep going until resolved". Remove references to OpenCode docs, `ctrl+p`,
GitHub issues, frontend design, and git-commit etiquette that does not apply.
The delegation sentence in each file is replaced by a slot for the posture
reminder (the runtime setting stays authoritative).

Size budget: no family file longer than its OpenCode counterpart plus 25
lines. `researchagent-test.txt`, `core.txt`, `direct.txt`, `inspection.txt`
and the compatibility prompts are deleted once the fingerprint fixtures are
updated.

### 4.3 Agents

Built-in agents, none with a `model` field:

| Agent                                           | Mode             | Prompt                                                                                                                                                                                | Permissions                                                                                                      |
| ----------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `research`                                      | primary, default | none (family header)                                                                                                                                                                  | default set above; `question` allow; `plan_enter` allow                                                          |
| `plan`                                          | primary          | family header + `session/prompt/plan.txt`                                                                                                                                             | edits denied except plan files; `plan_exit` allow; `question` allow                                              |
| `explore`                                       | subagent         | short scout prompt (literature, data, code; read-only; absolute paths; thoroughness levels), modelled on OpenCode `explore.txt`                                                       | `read`, `glob`, `grep`, `webfetch`, `research_search`, `bash` read-only usage per prompt; everything else denied |
| `ml`, `biology`, `physics`, `chemistry`, `data` | subagent         | one specialist template + a `<domain-skills>` index for the agent's skill categories (`data` covers data engineering, coding, visualization, cloud compute: pipelines and processing) | default set minus `task`, `question`, `todowrite`; domain tools from its categories allowed                      |
| `compaction`, `title`, `summary`                | primary, hidden  | OpenCode's prompts, adapted (see 4.5)                                                                                                                                                 | all tools denied                                                                                                 |

Removed: `execute`, `task`, `write`, `literature-review`, `critique`,
`physics-critique`, the `researchagent-test` alias, `agent/specialist.ts`, and
the quick/direct/inspection routing. Users define further specialists in
`openscience.json` under `agent`; the shipped five are the template. Recommended
models are documented, not coded: `explore` → `google/gemini-3.8-flash`,
specialists → `openai/gpt-5.6-sol`, lead → `openai/gpt-6-astra` or
`anthropic/claude-fable-5.1`. The Customize → Models picker and
`DelegationSettings.workerModel` keep working; the identity that headless runs
record must list the resolved model per agent.

Review is a command, not an agent: `/review` runs the lead with the
`peer-review` skill against the current deliverables checklist. Add `/init`
(writes the project `AGENTS.md` with research context: question, data
locations, conventions, deliverables), `/reproduce`, `/literature` as command
templates under the existing command mechanism.

### 4.4 Task tool

Rewrite `tool/task.ts` on OpenCode's contract:

- Parameters: `description`, `prompt`, `subagent_type` (any agent whose mode
  is `subagent` or `all`), `task_id` (resume the same child session), optional
  `command`, `background` (boolean).
- Depth: walk parent ids; refuse when depth ≥ `config.subagent_depth`
  (default 1). No `MAX_CHILD_AGENTS`.
- Permission: ask `task` with pattern `subagent_type`; the headless policy
  answers it.
- Child session: `parentID`, title `"<description> (@<agent> subagent)"`,
  permissions derived from the parent plus denies for `todowrite` and `task`
  unless the agent's own ruleset allows them.
- Model: the agent's configured model, else the parent's; variant inherited
  only when the child has no configured model; when the child has its own
  model, use the per-agent `variant` from config if set (add
  `Config.Agent.variant`).
- Working directory: the parent's. Remove the isolated worker workspace and
  the artifact-handoff requirement.
- Output: `<task id="…" state="completed|error"><summary/><task_result>last
text</task_result></task>`. On a child provider error or final tool error,
  return `state="error"` with the partial text instead of failing the call.
- Background: start through the existing durable attempt machinery; return
  immediately with `state="running"`; on completion inject a synthetic text
  part into the parent session so the lead's loop wakes; tell the lead not to
  poll.
- Keep the restart-safe `TaskAttempt` record internally.
- The tool description lists the available subagents with their descriptions
  (OpenCode `describeTask`), replacing `{agents}` in `tool/task.txt`.

### 4.5 Memory and compaction

- `filterCompacted` presents the root user message verbatim before the
  summary in every compacted view.
- Compaction prompt: OpenCode's `compaction.txt` role text plus our template
  with sections Objective; Deliverables (verbatim); Findings so far, with
  numbers; Work state; Next move; Relevant files. Prior summary folded forward
  as OpenCode does (`SUMMARY_UPDATE_INSTRUCTIONS`). Constants stay as today.
- `todowrite` parts join `skill` and `artifact` as never-pruned.
- `summary` agent: a lab-notebook entry of 2–3 sentences (what was measured,
  what was produced, what remains), used where the workspace shows a session
  summary.
- New tool `recall`: search earlier context windows of this session (compacted
  head, via the message store) and saved tool outputs (`Truncate` files
  granted to the session) by regex; returns matches with offsets; default in
  `research`.

### 4.6 Headless `run`

- New options: `--delegation off|light|standard|high`, `--worker-model
provider/model`, `--autonomy interactive|balanced|autonomous` (default
  `autonomous` under `--auto-approve`), `--deadline <seconds>`.
- Under `--auto-approve`: delegation is no longer forced off; set
  `experimental.continue_loop_on_deny` for the session; answer a
  `question.asked` event with its first (recommended) option and emit a
  `question` event, never set `rejected`.
- Stream child-session events: subscribe to the session family, tag every
  event with `sessionID` and `parentID`, and roll child tokens and cost into
  `done`. Extend `run-events.ts` accordingly (`parentID` optional on `Base`;
  `done` gains `children: [{sessionID, agent, model, tokens, cost}]`).
- Tools denied for the session must not appear in the offered schema.

### 4.7 Harness units

Config namespace `harness: { <unit>: boolean }` (all default on). Each unit is
a bundled plugin module under `backend/cli/src/harness/<unit>.ts` using the
existing plugin hooks plus two new hook points added to the loop:

- `loop.before_finish` — the model returned a final answer with no tool calls;
  a unit may return a message to inject and continue, at most N times per
  turn.
- `loop.guard` — a repetition guard tripped (text loop, output-limit stall,
  repeated identical tool calls or same-cause tool failures); a unit may return
  a redirect message; if none does, the loop stops as today.

Units:

- `headless-policy` — the behaviour in 4.6; also hides denied tools from the
  schema.
- `redirect` — on the first `loop.guard` trip inject: "The same failure has
  occurred three times. Diagnose the root cause, then change tool, library or
  method, or split the step; do not retry as-is." Stop on the second trip.
- `deliverables` — on the first user message detect explicit output
  specifications (paths, file names with extensions, "write … to", schema or
  column lists, format words); when detected, ensure `todowrite` is offered and
  keep the root instruction pinned (4.5). At `loop.before_finish`, if the
  checklist names file paths, run mechanical checks (exists, regular file,
  non-empty, parses for csv/tsv/json/npz/npy/parquet/toml/yaml, no NaN/Inf
  where numeric, no placeholder tokens such as `TODO`/`placeholder`/`dummy`,
  duplicate ids where an id column is evident) and inject one message listing
  failures; at most two rounds.
- `budget` — read `--deadline` and cgroup limits (`/sys/fs/cgroup/cpu.max`,
  `/sys/fs/cgroup/memory.max`, fallbacks `os.cpus()`, `os.totalmem()`); add
  `Compute: N CPUs, M GiB` and `Time budget: Xh, elapsed Ym` to `<env>`;
  inject a one-line reminder at 50% and 85% of the deadline; at
  `loop.before_finish` with deliverables unchecked and >15% budget left, inject
  "time remains; continue, or write the best real version of the missing
  outputs".
- `cost` — accumulate step usage; render `Spent so far: $x (y tokens)` beside
  the time budget; set cache-friendly provider options in `chat.params` where
  the provider supports them; optional soft ceiling (`harness.cost.max_usd`)
  that injects a wrap-up reminder, never a hard stop.
- `durable-jobs` — hint consistency: `Truncate.hint` offers Task only when
  delegation is enabled for the session; `bash.txt` sentences about
  `compute_job`/`research_search` render only when those tools are offered.
- `workers` — the streaming and roll-up in 4.6 (implemented in `run.ts`, the
  unit only owns the switch and defaults).

### 4.8 Harbor adapter

`tooling/harbor/openscience_harbor/agent.py`: allow `compute_job` (local
target; verify `{"kind":"modal"}` still fails closed), set
`experimental.continue_loop_on_deny: true`, add kwargs `delegation`,
`worker_model`, `autonomy`, `deadline` mapped to the new `run` flags, and pass
the Harbor task's agent timeout as `deadline` when available. Update
`trajectory.py` to include child steps as ATIF subagent references and to
count child usage in totals instead of withholding them when a `task` call
appears. Update `tooling/harbor/README.md` and tests.

### 4.9 Skills

- New core skill `execution-hygiene`: detach and poll long jobs, checkpoint,
  fix seeds and BLAS thread caps, chunked I/O and explicit dtypes, clean
  end-to-end rerun before finishing when budget allows, verify against the
  verifier's resource limits rather than the agent's. Place it in the core
  index after `compute`.
- New convention skills (authored from public documentation only; never from
  benchmark task instructions, rubrics, solutions or target papers; record the
  sources in each SKILL.md): `statistical-conventions` (test selection
  including ordered-trend tests, raw and adjusted reporting, effect sizes),
  `lean4-mathlib`, `coq`, `cheminformatics-definitions` (Lipinski vs RDKit
  counts, TPSA variants, QED, standard InChIKey, protonation, canonical
  SMILES), `structure-analysis` (chain/entity/HETATM resolution, H-bond
  geometry criteria), `patent-mining`, `geoscience-data` (NetCDF, GeoTIFF,
  CRS), `energy-systems`, `astronomy-inference`, `atomistic-workflows`,
  `analysis-report` (trace/report template for rubric-graded analysis).
- `<core-skills>` keeps research-workflow order.

## 5. Work packages

Each package is one reviewable change with its own tests under
`backend/cli/test/<area>` (see `AGENTS.md`: new backend tests go in the
directory whose shard they belong to; tests are hermetic; no mocks where the
real implementation can run). Run `bun run --cwd backend/cli test` and
`bun run typecheck` before opening each PR. Do not bump package versions.

### WP0 — Baseline

- Branch from `main`. Confirm the OpenCode reference checkout.
- Run the backend suite once and record the pass count.
- Read `docs/notes/opencode-harness-comparison.md`.

### WP1 — Tool surface by permission

Files: `session/tool-selection.ts` (delete), `session/prompt.ts`
(`resolveTools`, the call sites listed in §3), `tool/registry.ts`,
`tool/bash.txt`, `tool/truncation.ts`, `agent/agent.ts` (permissions),
`skill/skill.ts` (unchanged unless activation needs a helper).

Changes: implement §4.1. Add the `apply_patch`-for-GPT rule, the
`research_search` provider gate and the `question` client gate in the registry
selection step. Remove `batch`, `todoread`, `planwrite`, `research_contract`,
`scientific_capability`, `atlas*`, `provenance_*` from the model-facing
registry. Make `bash.txt` conditional and `Truncate.hint` delegation-aware
(pass the session's delegation state into the hint).

Acceptance:

- `test/session/toolset.test.ts` (rewrite) asserts the `research` default set
  is exactly the 14 names for a non-GPT model, and `apply_patch` replaces
  `edit`/`write` for `openai/gpt-5.6-sol`; asserts `r` appears only after a
  skill with `allowed_tools: [r]` is loaded; asserts `question` is absent when
  the session cannot ask.
- `test/tool/truncation.test.ts` asserts the hint never mentions Task when
  delegation is off.
- `test/session/tool-selection.test.ts` and `test/eval/tool-routing.test.ts`
  are removed or reduced to activation/enabled behaviour.
- `SessionHarness` fingerprints updated deliberately (schema set changed).

### WP2 — Agents

Files: `agent/agent.ts`, `agent/specialist.ts` (delete), `agent/prompt/*`
(remove compatibility prompts; add `specialist.txt` template and
`summary.txt`), `config/config.ts` (`Config.Agent.variant`), `session/prompt.ts`
(remove quick/direct/inspection routing and `SKILL_ROUTING_AGENTS` special
cases), `session/system.ts` (remove `direct`/`inspection` parameters).

Changes: implement §4.3. Specialist agents are built from one template plus
their skill categories; `data` is new. No agent sets `model`. Add commands
`/init`, `/review`, `/reproduce`, `/literature` through the existing bundled
command mechanism (`command/index.ts`, templates under `command/template/`;
`initialize.txt` already exists and becomes the research-context `/init`).

Acceptance:

- `test/agent/agent.test.ts` asserts the exact built-in agent list, modes,
  hidden flags, that no built-in agent has a `model`, and that
  `agent.biology.model` from config resolves for the child.
- `test/tool/task-profiles.test.ts` replaced by tests that `subagent_type`
  accepts any subagent name and rejects primaries and unknown names.
- Docs: `frontend/docs` agents page lists the agents and the recommended
  model configuration snippet.

### WP3 — Task tool

Files: `tool/task.ts`, `tool/task.txt`, `session/prompt.ts` (delegation
gating uses `subagent_depth`), `config/config.ts` (`subagent_depth`).

Changes: implement §4.4.

Acceptance:

- `test/tool/task-handoff.test.ts` and `test/tool/task-outcome-recovery.test.ts`
  updated: `<task_result>` shape, partial text on child error, `task_id`
  resume continues the same session, depth limit refusal with the config
  message, no concurrency cap (dispatch 3× cores concurrently in a fixture),
  child writes land in the parent's directory, background dispatch returns
  `state="running"` and later injects a synthetic completion part into the
  parent session.
- `test/session/delegation.test.ts` asserts variant inheritance rules and the
  per-agent `variant` override.

### WP4 — Headless run and adapter

Files: `cli/cmd/run.ts`, `cli/run-events.ts`, `tooling/harbor/openscience_harbor/agent.py`,
`tooling/harbor/openscience_harbor/trajectory.py`, `tooling/harbor/tests/*`,
`tooling/harbor/README.md`, `evals/science-harness/campaign.py` (pass-through
of the new `--ak` kwargs only).

Changes: implement §4.6 and §4.8.

Acceptance:

- `test/cli/run-policy.test.ts` extended: under `--auto-approve` a question is
  answered with the recommended option and the run ends `completed`; a denied
  tool call does not end the run; `--delegation standard` streams child events
  with `parentID` and `done.children` sums match the child `step_finish`
  totals; `--deadline` appears in the environment block.
- `tooling/harbor/tests/test_trajectory.py` covers a stream with child events:
  totals include children, subagent refs emitted, `usage_complete` true.
- `tooling/harbor/tests/test_agent.py` covers the new kwargs and the
  `compute_job` allow with remote targets still denied.

### WP5 — Model-family headers

Files: `agent/prompt/{anthropic,gpt-astra,gpt,codex,gemini,default}.txt`
(new), `session/system.ts` (`SystemPrompt.provider` routing), `agent/agent.ts`
(`research` without `prompt`), `session/harness.ts` fixtures, deletions listed
in §4.2.

Changes: implement §4.2. Write the science sections once and include them
from each family file at build time or duplicate them verbatim with a test
that asserts byte equality across files.

Acceptance:

- `test/session/harness.test.ts` fixtures per family: the selected header for
  `anthropic/claude-fable-5.1`, `openai/gpt-6-astra`, `openai/gpt-5.6-sol`,
  `google/gemini-3.8-flash`, and an unknown id; each within the size budget;
  science sections identical across files; no file mentions OpenCode, ctrl+p,
  GitHub issues or frontend design.
- `test/session/llm.test.ts` request fixture still shows the header first and
  the assembled context after it, including the `openai-codex` OAuth route.

### WP6 — Memory, compaction, recall

Files: `session/message-v2.ts` (`filterCompacted`), `session/compaction.ts`,
`agent/prompt/compaction.txt`, `tool/recall.ts` (new), `tool/registry.ts`.

Changes: implement §4.5.

Acceptance:

- `test/session/compaction.test.ts`: after compaction the root user message
  bytes are present before the summary; the summary follows the template
  section order; `todowrite` parts survive pruning; prior summary folding.
- `test/tool/recall.test.ts`: finds a string in a pruned tool output and in
  the compacted head; respects the session grant boundary.

### WP7 — Harness units and hook points

Files: `session/prompt.ts` (add `loop.before_finish` and `loop.guard` calls
at the finish decision and at the guard trip sites, ~964 and ~1045 and the
repeated-tool-failure path), `tooling/plugin/src/index.ts` (hook types),
`harness/*.ts` (new units), `config/config.ts` (`harness` namespace),
`session/system.ts` (`<env>` additions provided by units).

Changes: implement §4.7. Units are ordinary plugins registered at boot when
their switch is on; they hold per-session state in a module map keyed by
session id and clear it on session end.

Acceptance (one test file per unit under `test/session/harness-units/`):

- `redirect`: a fixture provider that returns the same failing bash call three
  times sees the redirect message once, and the loop stops only on the second
  trip.
- `deliverables`: an instruction naming three output files yields a checklist
  before the first tool call; at finish with one file missing, the model
  receives exactly one message naming it; with all present, no injection.
- `budget`: `<env>` shows compute and budget lines from a fake cgroup; the
  50% and 85% reminders fire once each with a fake clock.
- `cost`: spend line updates after each step; soft ceiling injects once.
- Switching any unit off removes its behaviour and its `<env>` lines.

### WP8 — Skills

Files: `backend/cli/skills/core/execution-hygiene/SKILL.md`, new convention
skills under their categories, `session/system.ts` core order if needed.

Acceptance: `test/skill/*` catalog tests updated for the new names and the
core order; each new SKILL.md has a `sources` section; no skill text names a
benchmark, task id, verifier path or rubric.

### WP9 — Cleanup and documentation

- Remove dead prompt files and code paths (compatibility agents, routes,
  `specialist.ts`, `tool-selection.ts`, Batch/TodoRead/PlanWrite registrations,
  ResearchContract/ScientificCapability/Atlas model tools).
- Update `CLAUDE.md` (prompt architecture: header selection is now by model
  family; the active prompt table), `AGENTS.md` if commands changed,
  `docs/notes/opencode-harness-comparison.md` (state after this work), and the
  `frontend/docs/src/content/openscience/` pages `agents.mdx`,
  `configuration.mdx` (`harness`, `subagent_depth`, `agent.<name>.variant`,
  recommended models), `built-in-tools.mdx`, `commands.mdx`, and
  `automation.mdx` (the new `run` flags).
- `CHANGELOG.md` under Unreleased: one line per user-visible change.
- Regenerate the SDK if `backend/cli/src/server` changed
  (`./tooling/repo/generate.ts`).

## 6. Guardrails

- No benchmark names, task ids, output paths, rubric vocabulary or verifier
  behaviour anywhere in prompts, skills, units or tests. Fixtures use invented
  file names.
- No model ids in agent definitions. Recommended models live in documentation
  and sample configuration only.
- Header growth per family is bounded (§4.2). If a behaviour can be delivered
  by a unit at a precise point in the loop, it does not go in the header.
- Keep: `ToolRetryGuard`, the continuation-after-local-tool fix, the rule
  against automatic redispatch after tool side effects, the restart-safe
  `TaskAttempt`, the `<core-skills>` index, `artifact`/Results, the experiments
  store and autoresearch tools (now skill-unlocked).
- Out of scope: runner extraction, the Core-V2 style system-context sources,
  RLM-style context tools beyond `recall`, skill induction, any campaign or
  benchmark run.
- Conventions from `AGENTS.md` apply: one function unless composable, no
  `any`, early returns, Bun APIs, comments explain why, tests test behaviour
  not text.

## 7. Definition of done

- All work packages merged; backend suite, typecheck and `bun run check`
  green; Harbor adapter tests green.
- A headless smoke run (`openscience run --format json --auto-approve
--workspace project --delegation standard --deadline 600 -- "<small task
with two output files>"`) on a local Docker container shows: family header
  selected for the model, 14 tools offered, checklist written, child events
  with `parentID`, `done.children` populated, deliverables check at finish,
  exit code 0 with no `rejected` status.
- Documentation updated as in WP9. Hand back to the benchmark owner.
