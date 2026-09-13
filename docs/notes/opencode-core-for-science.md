# OpenCode core for science: implementation plan

Status: implementation plan for the approved harness refinement
(`docs/notes/harness-refinement-plan.md`, 13 September 2026). This note is the
synthesis the implementer works from: the decisions that resolve the work
order's open points, the order of the changes, and what each package leaves
behind. Benchmarking is out of scope; nothing here knows a benchmark's name.

## Principle

The harness is OpenCode's Build path with science in three places: skills,
agents and headers, and a handful of switchable units that deliver context at
the exact point in the loop where it matters. The loop itself does not know
about science, deliverables or budgets; the units do, through two hook points.

## Decisions

1. **Visibility is permission plus unlock.** A tool is offered when the
   agent's ruleset (merged with the session ruleset and the message's `tools`
   overrides) does not deny it, and it is either in the agent's default set,
   unlocked by a skill loaded in the current task epoch (`allowed-tools`), or
   named by an explicit allow rule in the agent's ruleset. The default set for
   `research` is the fourteen tools of the work order; specialists get the
   default set minus `task`, `question`, `todowrite` plus their domain tools
   through explicit allow rules. Keyword selection (`tool-selection.ts`) is
   deleted; `apply_patch` replaces `edit`+`write` for GPT-family models by
   wire id, `research_search` needs a configured provider, `question` needs a
   client that can ask.
2. **One header per model family**, selected by wire model id in
   `SystemPrompt.provider`. Each family file is OpenCode's skeleton with the
   coding sections replaced by a `{{SCIENCE}}` slot that the runtime fills with
   one shared block (`agent/prompt/science.txt`: Evidence and files; Methods
   and deliverables; Manuscripts and figures), so the science text is identical
   across families by construction. `response.txt` stays appended. `research`
   and `plan` have no prompt of their own; every agent with a `prompt` still
   replaces the header.
3. **Agents**: `research`, `plan`, `explore`, `ml`, `biology`, `physics`,
   `chemistry`, `data`, and the internal `compaction`, `title`, `summary`. No
   built-in agent carries a model; recommended models live in documentation
   and sample configuration. Specialists are built from one template plus a
   `<domain-skills>` index of their skill categories. Review is the `/review`
   command; `/init`, `/reproduce` and `/literature` are command templates.
4. **Task tool** on OpenCode's contract (`description`, `prompt`,
   `subagent_type`, `task_id`, `command`, `background`), depth from
   `subagent_depth` (default 1), child permissions derived from the parent with
   `todowrite` and `task` denied unless the agent allows them, the parent's
   working directory, `<task_result>` output with partial text on error,
   background completion injected into the parent as a synthetic message. The
   restart-safe `TaskAttempt` record stays; the isolated worker workspace, the
   artifact handoff requirement, `MAX_CHILD_AGENTS` and the `specialist`
   parameter go.
5. **Memory**: the root user message is pinned verbatim ahead of the summary
   in every compacted view; the compaction template gains Deliverables
   (verbatim) and Findings so far, with numbers; `todowrite` parts join skill
   and artifact as never pruned; `summary` writes a lab-notebook entry; a
   `recall` tool searches earlier context windows and saved tool outputs of the
   session by regex.
6. **Headless run**: `--delegation`, `--worker-model`, `--autonomy`,
   `--deadline`; under `--auto-approve` delegation stays on, questions are
   answered with the recommended option, denied tool calls continue the loop,
   denied tools are hidden from the schema; child-session events are streamed
   with `parentID` and rolled into `done.children`. The deadline travels on the
   user message (`deadline`, epoch ms) so an attached server sees it too.
7. **Units** are internal plugins under `src/harness/`, each behind
   `harness.<unit>` (default on): `headless-policy`, `redirect`,
   `deliverables`, `budget`, `cost`, `durable-jobs`, `workers`. The loop gains
   `loop.before_finish` (final answer with no tool calls; a unit may return a
   message to inject, bounded per turn) and `loop.guard` (a repetition guard
   tripped; a unit may return a redirect, otherwise the loop stops as today).
   Units contribute `<env>` lines through an `env.lines` hook.

## Order

| Step | Package   | Leaves behind                                                             |
| ---- | --------- | ------------------------------------------------------------------------- |
| 1    | WP1 + WP2 | permission-based tool surface, final agent list, routes removed, commands |
| 2    | WP5       | family headers with the shared science block, routing by wire id          |
| 3    | WP3       | Task tool on the OpenCode contract, background mode                       |
| 4    | WP6       | pinned root, compaction template, `summary`, `recall`                     |
| 5    | WP7       | hook points and the seven units with tests                                |
| 6    | WP4       | `run` flags, child streaming, Harbor adapter                              |
| 7    | WP8       | execution-hygiene and convention skills                                   |
| 8    | WP9       | dead code removed, docs, changelog, SDK                                   |

Each step is one local commit on `harness-core`; nothing is pushed until the
owner has tested the branch.

## Status (14 September 2026)

Implemented on the `harness-core` branch, every package above, with these
deviations from the work order recorded deliberately:

- The Research default set has sixteen tools, not fourteen: `literature`
  (shipped in v2.0.96 after the work order was written) and `recall` (which
  §4.5 asks for as a default) join the fourteen.
- Children keep their own scratch for staged inputs and side outputs but work
  in the parent's directory through a shared working-root grant; that is the
  same working directory without letting a worker's attachments land in the
  project.
- The `summary` agent exists with its lab-notebook prompt and is not yet wired
  to a workspace surface; the workspace still shows the diff summary.
- `experimental.batch_tool` and `experimental.plan_mode` remain accepted
  configuration keys with no effect, so older configuration files still load.
- Live runs during review: a delegated run, a deliverables-check run, a
  background-worker run and a Codex-route run, each converted to ATIF with
  child documents and roll-up totals validated by Harbor's model.

## Guardrails

No benchmark names, task ids, output paths, rubric words or verifier
behaviour anywhere; fixtures use invented file names. No model ids on agents.
Header growth bounded to the OpenCode counterpart plus 25 lines. Keep
`ToolRetryGuard`, the continuation-after-local-tool fix, no automatic
redispatch after tool side effects, the restart-safe `TaskAttempt`, the
`<core-skills>` index, artifact/Results, the experiments store and the
autoresearch tools (skill-unlocked).
