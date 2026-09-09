# Fusion: a persistent, cheaper worker for the Research lead

Fusion is an opt-in execution strategy for the Research agent. The model the
user selected stays the lead: it decides what to test, writes briefs, reviews
decisive evidence and writes the answer. One persistent worker — the model
chosen under **Customize → Models → Worker model** — executes substantial,
well-specified work in its own durable child session, and the same worker is
resumed for related work instead of a fresh child being spawned per Task call.

It follows Cognition's Devin Fusion "sidekick" pattern: two fully capable
agents with their own persistent, separately cached contexts; the lead takes
minimal actions, reads only what it must, delegates and monitors, and owns the
plan, the interpretation of ambiguity and the final review. Dynamic mid-session
routing (switching the model at a compaction boundary) is deliberately _not_
part of this build; see "Stages" below.

## Decisions taken

| Question                  | Decision                                                                                                                                                                                                                                                          | Why                                                                                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where does Fusion live?   | A `strategy` field on the existing delegation settings (`parallel` \| `fusion`), persisted per user message and carried through compaction like the other delegation fields.                                                                                      | Research stays the single visible agent; no new persona, provider or model id. Ordinary Research is untouched when the strategy is `parallel`.                                                      |
| Which worker?             | The configured worker model, else the lead's own model. The exact model and route are frozen into the binding.                                                                                                                                                    | "Different" is not "cheaper"; the user picks the pair from connected routes. Freezing the model means a later preference change starts a new lineage rather than silently re-routing a live worker. |
| One worker or many?       | One bound worker per lead session for the `execute` profile. `explore` (read-only research fan-out) is unchanged.                                                                                                                                                 | Proposal constraint 1: one mutating worker, no nested delegation, no concurrent mutation of the same resources.                                                                                     |
| How is the worker reused? | The Task tool resolves the binding itself. The lead does not need to remember a `session_id`; an explicit `session_id` still wins.                                                                                                                                | Models forget ids; the runtime should not depend on prose to keep one lineage.                                                                                                                      |
| Handoff discipline        | The worker receives a Fusion brief contract (status vocabulary, evidence, lead-owned decisions) and the lead a Fusion posture in its effort reminder.                                                                                                             | Borrowed from opencode-fusion's five-part handoff and the proposal's brief contract.                                                                                                                |
| Budgets                   | Handoffs per user turn are capped (default 6) with a model-facing error at the cap; cumulative worker usage is accounted in the binding. Step and wall-time limits stay with the existing child machinery.                                                        | Ordinary Research keeps its Normal/Ultra caps; Fusion needs bounded repair rounds without loosening them.                                                                                           |
| Authority                 | Every dispatch re-runs the Task permission ask and the isolated-workspace handoff grant; the worker keeps only its own session grants. Publication (`artifact`) and paid compute (`compute_job`) stay lead-owned because the `execute` profile never offers them. | Proposal constraint 3 and the registry allowlists.                                                                                                                                                  |
| Waiting                   | Blocking handoffs. The lead's provider call is suspended while the worker runs; no polling calls are made.                                                                                                                                                        | Stage B scope. Asynchronous collaboration is Stage C.                                                                                                                                               |
| Cost                      | Each handoff records the worker's usage in the Task result; the binding keeps the cumulative total; the UI shows lead plus worker cost.                                                                                                                           | Displayed parent cost was not whole-run cost.                                                                                                                                                       |

## State

`backend/cli/src/session/fusion.ts` owns one durable record per lead session,
stored at `["fusion", parentSessionID]`:

```
version, parentSessionID, workerSessionID, worker: { providerID, modelID },
policy: { version, maxHandoffsPerTurn }, generation, handoffs,
usage: { cost, tokens }, lastResult?: { callID, outcome, stopReason, at },
createdAt, updatedAt
```

- **Binding** is created on the first `execute` dispatch under Fusion and reused
  by every later one. Concurrent dispatches serialize on a per-parent lock so
  two Task calls in the same step cannot mint two workers.
- **Lineage** changes (generation + 1, fresh child) when the configured worker
  model differs from the bound one. The previous child remains a normal child
  session; nothing is deleted.
- **Turn budget** counts handoffs whose parent user message is the current one;
  the cap is enforced before any child work is dispatched and reported to the
  model as a typed error that names the recovery (finish directly or ask).
- **Usage** is the child turn's cost and tokens as already summarized by the
  Task tool, added to the binding after each handoff.

Four kinds of state remain distinct, as the proposal asks: conversation
history (durable), provider prompt cache (opportunistic), kernel state
(process-local, session-owned) and files/evidence (explicit, transferable).
A resumed binding guarantees the history, not a cache hit or a live kernel.

## Prompts

- Lead (`researchEffortReminder`, Fusion strategy): the worker pair, what to
  delegate (extraction against a defined question, dataset inspection,
  implementing a specified analysis, reproducing a figure from pinned inputs,
  checks, formatting, repairing a known error), what to keep (which claim is
  tested, whether data supports it, fitting/model assumptions,
  inclusion/exclusion, leakage, interpretation, conclusions), the five-part
  brief (objective, inputs/files, interfaces, constraints, verification), and
  that the runtime resumes the same worker for `execute` work.
- Worker (`childGuidance`, Fusion): report status as completed / partial /
  blocked / needs-decision; list outputs, actual checks and results,
  limitations and decisions needed; report conflicting inputs before making a
  methodological choice; never launch paid compute or publish.

## Product surface

- Tools popover → Delegation: a **Fusion** switch with the pair
  ("Lead: <model> · Worker: <worker model>"). When no worker model is
  configured the switch still works (same model, persistent context) and says so.
- Delegation cards show the Fusion badge, the worker model and the handoff
  number; the session cost readout adds the worker's cost.

## Stages

- **A — observability and contract tests** (this build): one parent → one
  worker under concurrent dispatch and restart; continuation preserves context
  without widening authority; budgets hold across follow-up turns; outcomes stay
  distinguishable; every billable phase is attributed (`test/tool/fusion*.test.ts`).
- **B — fixed-pair persistent delegation** (this build): the binding, policy
  and prompts above.
- **C — asynchronous collaboration**: per-worker serialized mailbox, durable
  assignment/result ids, acknowledged delivery, cancellation ownership, restart
  reconciliation. Not started.
- **D — model routing**: explicit escalation signals and eligibility checks
  first; compaction-boundary switches only once the fixed pair is measurable.
  Not started.

## What this does not claim

No savings figure is established here. Cognition's numbers (35% → "up to
60%", 41% with Fable 5) are their harness on FrontierCode, not OpenScience on
scientific tasks. Measure frontier-only, cheap-only and the fixed pair on the
same task families with metered usage, estimated cost and billed spend kept
separate, before quoting any percentage.
