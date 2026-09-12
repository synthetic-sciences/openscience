---
name: hypotheses
description: Turns a research direction into testable hypotheses with predictions, competing explanations and the experiments that discriminate between them, including the design (controls, randomization, blocking), sample size or seed count, the pre-specified analysis, and the result that would falsify each hypothesis. Use when a question needs to become a study, before data is collected or runs are launched, or when an observation needs candidate explanations. For generating directions use brainstorming; for running the loop use autoresearch.
summary: "Turn a direction into falsifiable hypotheses and the discriminating experiment, powered."
category: core
role: workflow
allowed-tools: [Read, Write, glob, grep, python, webfetch]
license: MIT
version: 1.0.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
  adapted-from: K-Dense hypothesis-generation and scientific-critical-thinking (MIT)
---

# Hypotheses

A hypothesis is a statement the world could contradict, paired with the observation that
would contradict it. Everything else is a theme. The work here is turning a direction into
statements of that kind, and designing the smallest experiment that tells them apart.

## Rules

1. **Falsifiable, specific, mechanistic.** "Method A improves accuracy" is a theme. "Under
   label noise above 20%, A's margin over B grows with noise because A's loss saturates on
   mislabeled examples" is a hypothesis: direction, condition, mechanism, and a prediction
   that could fail.
2. **Always at least two.** The hypothesis and the best competing explanation for the same
   observation (confound, artifact, simpler mechanism). An experiment that cannot separate
   them is not yet designed.
3. **Predictions before data.** For each hypothesis, the observable pattern if it is true
   and if it is false, written down before the experiment. Pre-specify the primary outcome,
   the analysis and the decision rule.
4. **Power the study.** Seeds, samples or replicates chosen from the expected effect size
   and variance, not from habit. Three seeds detect only large effects; say what the study
   can and cannot detect.
5. **Control what could explain the result otherwise.** Randomize assignment, block on
   known nuisance factors, include the positive and negative controls that show the
   measurement works.
6. **Cheap discriminating experiments first.** Order experiments by information per unit
   cost; the first one should be able to kill at least one hypothesis.

## Workflow

- [ ] State the observation or question and what is already known about it.
- [ ] Write two to four hypotheses with mechanisms; include the null and the confound.
- [ ] For each, the predictions if true and if false; mark which predictions differ.
- [ ] Design the discriminating experiment; check it against `references/experimental-design.md`.
- [ ] Choose n; write the analysis plan; define the decision rule.
- [ ] Hand over as a study plan, or start it with autoresearch.

**Hypotheses.** Use `references/quality-criteria.md` as the bar: testable, specific,
grounded in a mechanism or prior evidence, scoped to conditions, and different from its
competitors in at least one prediction. Name the variables: independent, dependent,
controlled, and the confounds you cannot control.

**Design.** Pick the design from `references/design-patterns.md` (between-subjects,
within-subjects, factorial, crossover, ablation ladder, dose-response, natural
experiment). Randomize what can be randomized; block or stratify what cannot; hold the
evaluation fixed across arms. For computational studies: same data and splits for every
arm, seeds fixed and varied together, the budget equalized, the metric defined once.

**Sample size.** Estimate the effect size you care about and the variance from a pilot,
prior work or a tracked run. Compute n or the seed count for the power you want; a quick
simulation in Python is more honest than a formula applied to the wrong test. When a
library skill helps, `statistical-power` and `experimental-design` in the library carry
the formulas and package calls. State the minimum detectable effect in the plan.

**Analysis plan.** The primary outcome and its test (paired or unpaired, correction for
multiple comparisons, the model if regression), secondary outcomes labelled as such, how
outliers and missing data are handled, and the exact criterion for each hypothesis's
verdict. Written before any result is seen.

## Deliverable

```markdown
## Question
## Known
## Hypotheses
H1: <statement>. Mechanism: <...>. Predicts: <if true> / <if false>.
H2 (competing): ...
H0: ...
## Discriminating experiment
Design, arms, controls, randomization, fixed evaluation.
n / seeds: <value>, detects effects ≥ <MDE> at power <p>.
Primary outcome and test; decision rule per hypothesis.
## Order of experiments and cost
## Risks: confounds not controlled, measurement validity, external validity
```

## Before you hand it over

- Each hypothesis has a prediction that would falsify it.
- At least one experiment separates every pair of hypotheses that matter.
- n and the minimum detectable effect are stated with their basis.
- The analysis plan is complete enough that a second person would reach the same verdict
  from the same data.
