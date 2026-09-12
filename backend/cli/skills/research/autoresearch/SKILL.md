---
name: autoresearch
description: Run a hill-climbing research study over many training or analysis runs with the study and experiments tools, one metric, a baseline, an idea queue ranked by expected value, and a keep-or-revert ledger.
category: research
---

# Autoresearch

A study turns "make this metric better" into a loop that runs for hours or days without losing the thread. You own the science: which ideas to try, how to implement them, what a result means. OpenScience owns the clock: it tracks every metric the script logs, notices when a run ends, kills runs that break the study's criteria, keeps the budget, renders the ledger, and wakes this session with a "Study update" whenever there is news.

## Before the study

1. Agree the objective with the user: one metric, its direction, the budget (runs, hours, or spend), the compute target, how many runs may be live at once, and the kill criteria. Confirm with one question if any of these would change the outcome.
2. Look at the code and data first. A study needs a training or analysis script the harness can run repeatedly with different configuration, and a fixed evaluation that computes the metric. Do not change the evaluation once the baseline has run.
3. Create the study with `study create`. Then propose the baseline with priority 1000 and the first ideas with `study propose`.
4. If the study's review gate is on (the default), delegate a read-only critique of the training and evaluation code to the `critique` agent through the Task tool before the baseline runs, and fix anything it marks blocking. A baseline built on a leaking split or a misspelled metric wastes every run after it. An idea has a title, what it changes, why it should help, an expected improvement in metric units times your confidence, and the configuration it needs.

## Every run

- The script imports `openscience_track` (or `wandb`, which is shimmed) and logs the study metric every evaluation, plus anything else worth a curve: `track.log({"val_loss": v, "lr": lr}, step=step)`. Set `track.summary["val_loss"]` to the final value and call `track.finish()`.
- Start exactly one run per idea with `study start`, passing the command and the configuration the idea needs. Never start a second run for the same idea; propose a new idea if a variant is worth trying.
- Keep up to the study's concurrency live. While runs are live, implement the next idea or wait with `compute_job wait`; do not poll with shell sleeps.
- When a "Study update" reports a run ended, read its numbers with `experiments compare` (or `experiments series` when the curve matters), decide keep or revert against the baseline and the best, and record the verdict with `study record`: the analysis, a conclusion, and any lesson that should shape later ideas. Mark the first reference run with `baseline: true`.
- A killed run is data, not an error: record why it diverged and what that rules out.

## Judgement

- Rank by expected value, but keep a few cheap, orthogonal ideas in the queue so a plateau does not stall the study.
- Do not repeat a configuration that already has a run. Check `study status` before proposing.
- Prefer changes to the training script over changes to the evaluation. If the evaluation is wrong, stop and say so.
- Ask only when input or authority is missing. Do not ask whether to continue while budget remains.
- When the budget or target is reached, or the queue is empty and no idea is worth its cost, conclude with `study conclude`: what was learned, the best configuration with its metric, and what remains open. The ledger files (`study.md`, `ideas.md`, `results.tsv`, `lessons.md`) in the working folder are the record; the Experiments pane shows the same data live.

## Writing up

For a paper or report, load the writing skills and build from the ledger and the tracked runs: the baseline, the best configuration, the ablations that changed the metric, and the figures the data supports. Kept runs are claims with evidence; reverted runs are the ablations that make the claims honest.
