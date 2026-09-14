---
name: autoresearch
description: Runs a hill-climbing study over many training or analysis runs with the study and experiments tools, one metric and direction, a baseline, ideas ranked by expected value, exactly one run per idea, kill criteria and a budget, verdicts with analysis and lessons, and a conclusion. Use for autoresearch, hyperparameter or ablation sweeps left to run, "make this metric better", or any loop of experiments the user wants driven for hours. For a single reproduction use reproduce; for designing the study's hypotheses first use hypotheses.
summary: "Hill-climb one metric over many runs as a study: baseline, ideas, kill rules, budget."
category: core
role: workflow
allowed-tools: [Read, Write, Edit, Bash, python, study, experiments, compute_job, task]
license: MIT
version: 1.2.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
---

# Autoresearch

A study turns "make this metric better" into a loop that runs for hours or days without
losing the thread. You own the science: which ideas to try, how to implement them, what a
result means. OpenScience owns the clock: it tracks every metric the script logs, notices
when a run ends, kills runs that break the study's criteria, keeps the budget, renders the
ledger, and wakes this session with a "Study update" whenever there is news.

## Before the study

1. Agree the objective with the user: one metric, its direction, the budget, the compute
   target, how many runs may be live at once, and the kill criteria. The budget is a spend
   decision and belongs to this study alone: never carry one over from an earlier study or
   an earlier instruction in the session. If the request names no budget, ask once, with a
   recommendation (a time budget such as 2 hours with a per-run kill rule, or a target
   value), even under an autonomous setting. Everything else, infer or default.
2. Read the code and data first. A study needs a training or analysis script the harness
   can run repeatedly with different configuration, and a fixed evaluation that computes
   the metric. The evaluation does not change once the baseline has run.
3. Create the study with `study create`. Propose the baseline with priority 1000 and at
   least three first ideas with `study propose`, of different kinds (a different component,
   objective, data treatment or search strategy each), not three magnitudes of one knob. An
   idea has a title, what it changes, why it should help, an expected improvement in metric
   units times your confidence, and the configuration it needs; a configuration already in
   the study is rejected. The hypotheses skill is the tool for turning a vague direction
   into ideas worth queueing.
4. If the review gate is on (the default), get a read-only critique of the training and
   evaluation code before the baseline runs: load the peer-review skill and read it
   yourself, or delegate one read to an `explore` worker (Task tool,
   `subagent_type: "explore"`) with the file paths and the angle (leakage, metric
   definition, split hygiene). Fix anything marked blocking. A baseline built on a leaking
   split or a misspelled metric wastes every run after it.

## Every run

- The script imports `openscience_track` (or `wandb`, which is shimmed) and logs the study
  metric at every evaluation plus anything worth a curve:
  `track.log({"val_loss": v, "lr": lr}, step=step)`. It sets `track.summary["val_loss"]`
  to the final value and calls `track.finish()`.
- Start exactly one run per idea with `study start`, passing the command and the
  configuration the idea needs. Never start a second run for the same idea; propose a
  new idea if a variant is worth trying.
- Keep up to the study's concurrency live, and keep at least three ideas queued so a free
  slot never waits on you; propose in batches when the queue thins.
- When runs finish within a few minutes, stay in the turn: `compute_job wait` for the run,
  record it, start the next. Wake-ups are for runs that outlast a turn. While a long run is
  live, implement the next idea rather than idling.
- When a "Study update" reports a run ended, read its numbers with `experiments compare`
  (or `experiments series` when the curve matters), decide keep or revert against the
  baseline and the best, and record the verdict with `study record`: the analysis, a
  conclusion, and any lesson that should shape later ideas. Mark the first reference run
  with `baseline: true`.
- A killed run is data, not an error: record why it diverged and what that rules out.

## Steering

The user can add a directive from the Autoresearch pane or in chat while the study runs.
A directive is a standing rule for the rest of the study (it appears in your study
reminder): re-rank the queue and change the next run to honour it, and say what changed.
Every sixth run, and whenever four runs in a row fail to beat the best, step back: re-read
the lessons, name the kinds of change tried, drop near-duplicates, and change the kind of
idea rather than its magnitude.

## Judgement

- Rank by expected value, but keep a few cheap, orthogonal ideas in the queue so a plateau
  does not stall the study.
- Do not repeat a configuration that already has a run; check `study status` before
  proposing.
- Prefer changes to the training script over changes to the evaluation. If the evaluation
  is wrong, stop and say so.
- Ask only when input or authority is missing. Do not ask whether to continue while budget
  remains.
- When the budget or target is reached, or the queue is empty and no idea is worth its
  cost, conclude with `study conclude`: what was learned, the best configuration with its
  metric, and what remains open. The ledger files (`study.md`, `ideas.md`, `results.tsv`,
  `lessons.md`) in the working folder are the record; the Autoresearch pane shows the same
  data live.

## Writing up

For a paper or report, load ml-paper-writing or paper-writing and build from the ledger
and the tracked runs: the baseline, the best configuration, the ablations that changed the
metric, and the figures the data supports (figures skill). Kept runs are claims with
evidence; reverted runs are the ablations that make the claims honest.
