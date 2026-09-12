---
name: reproduce
description: Reproduces a paper's result, a claim, an artifact or a previous run with the target and success criterion frozen first, the canonical code path run before any substitute, exact inputs, environment, seeds and commands captured, and a verdict from a fixed set, reproduced, reproduced within tolerance, partially reproduced, not reproduced, or untestable. Use for "reproduce", "replicate", "re-run", "does this hold", or checking a result before building on it. Not for open-ended exploration or for improving the result (use autoresearch).
summary: "Reproduce a paper result or run with the target frozen first; verdict from a fixed set."
category: core
role: workflow
allowed-tools: [Read, Write, Edit, Bash, python, glob, grep, webfetch, compute_job, experiments]
license: MIT
version: 1.0.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
---

# Reproduce

A reproduction is a measurement of a claim. Its value comes from deciding, before anything
runs, exactly what number would count as success, and from writing down exactly what was
run so the next person can measure it again. A reproduction that adjusts its target after
seeing the result is not one.

## Non-negotiables

1. **Freeze the target first.** The claim, the metric and its direction, the expected value
   with its uncertainty, the tolerance, and the dataset, split and conditions it applies
   to, written down before execution. If the source gives no uncertainty, choose a
   tolerance and say why.
2. **Canonical path before substitutes.** Run the authors' code, config, checkpoint and
   data as released. Only when that path is unavailable or broken, build a replacement,
   and mark the result as a reimplementation.
3. **Capture everything that determines the number.** Code revision (and whether the tree
   was dirty), data identity and version, environment and package versions, hardware,
   seeds, the exact command, elapsed time, and every warning.
4. **Isolate and preserve.** New outputs go to a fresh directory; existing outputs are never
   overwritten. Raw logs stay separate from derived summaries.
5. **Do not fix the result.** A failing reproduction is a finding. Debugging is allowed
   until the canonical path runs as intended; changing hyperparameters, filters or metrics
   to get closer to the paper is a new experiment, reported as such.
6. **One verdict, from the fixed set.**

## Workflow

- [ ] Resolve the exact target and write the admission record.
- [ ] Recover inputs: code, data, environment, configuration, checkpoint.
- [ ] Run the canonical path (compute_job for anything longer than a few minutes).
- [ ] Capture outputs; compute the metric the frozen way; compare with tolerance.
- [ ] Verdict and record.

**Admission record** (write it to `reproduction/<name>/target.md`):

```markdown
Claim: <sentence from the source, quoted>            Source: <doi/arXiv/section/table>
Metric: <name>, <direction>   Expected: <value ± uncertainty or interval>   Tolerance: <value, reason>
Data: <name, version, split, filters, license/access>   Conditions: <seeds, budget, hardware>
Canonical path: <repo, commit, command>               Missing: <what could not be recovered>
```

**Inputs.** Pin the repository commit named in the paper or its release tag; download data
by the authors' script; build the environment from their lock file where one exists and
record what changed when it does not resolve. Missing inputs are listed in the record, not
silently substituted.

**Execution.** Runs longer than a few minutes go through `compute_job` with a name that
carries the target, so they are tracked and can be resumed after an interruption. Log the
exact command and its exit code. For stochastic results run the seed count the paper used
(or at least three) and report the spread. Track metrics with `openscience_track` when
the script permits, so the curves survive.

**Comparison.** Compute the metric with the frozen definition, from the raw outputs, in a
fresh process. Report the reproduced value with its spread, the expected value, the
absolute and relative difference, and whether it lies within tolerance. Check the checks
that apply: leakage-safe split, checkpoint actually loaded, units, the same evaluation
subset.

## Verdict

| Verdict | Meaning |
| --- | --- |
| Reproduced | canonical path, within tolerance |
| Reproduced within tolerance | difference explained (hardware nondeterminism, version drift) and inside the stated tolerance |
| Partially reproduced | some claims or conditions hold, others do not; each listed |
| Not reproduced | canonical path ran; the number is outside tolerance |
| Untestable | inputs unavailable or path broken beyond repair; what is missing named |

Write `reproduction/<name>/report.md`: the admission record, the environment capture, the
command log, the results table, the verdict, and what a reader should try next. A
reimplementation says so in its first line.

## Before you hand it over

- The target was written before the run and was not edited after.
- Every number in the report traces to a raw output file in the reproduction directory.
- The verdict is one of the five, with the difference and tolerance shown.
- Untested claims and unrecoverable inputs are listed, not implied fine.
