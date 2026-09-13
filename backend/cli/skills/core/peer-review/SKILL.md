---
name: peer-review
description: Reviews a manuscript, proposal, analysis or result the way a careful referee does, reading the whole artifact, checking the methods against the claims, the statistics against the design, the figures against the numbers, and reporting BLOCKING issues separately from observations, with a calibrated recommendation. Use for peer review, critical appraisal of a paper or claim, pre-submission review of the user's own draft, grant review, or evaluating research rigor. For fixing the text afterwards use paper-writing; for an independent second opinion delegate to the critique agent.
summary: "Referee a manuscript, proposal or result: BLOCKING vs observations, calibrated verdict."
category: core
role: workflow
allowed-tools: [Read, glob, grep, Bash, python, literature, webfetch, task]
license: MIT
version: 1.0.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
  adapted-from: K-Dense peer-review and scientific-critical-thinking (MIT)
---

# Peer review

A review's job is to tell the authors, and the editor, whether the evidence supports the
claims, and what would have to change if it does not. It is not a summary, not a list of
typos, and not an opinion about how interesting the topic is. Read everything, check
what can be checked, and separate what blocks from what would help.

## Non-negotiables

1. **Read the whole artifact** including appendices, supplementary tables, and code when it
   is provided. A review of the first eight pages is not a review.
2. **Check, do not just read.** Recompute a number when the inputs are there; rerun a
   provided analysis; compare a figure to the table it summarizes; check that the test
   matches the design (paired vs unpaired, multiple comparisons, dependence).
3. **BLOCKING or OBSERVATION, for every point.** Blocking means the central claim is not
   supported as written: leakage, a wrong test, an unfair baseline, a result that does not
   appear in the data, a claim outside the study's scope. Observations improve the paper
   but do not change whether it is right.
4. **Locate every issue.** Section, page, table, figure, equation, line. "The statistics
   are weak" is not a finding; "Table 2 reports p < 0.05 from a t-test on 3 seeds per
   condition without correction across 12 comparisons" is.
5. **Calibrate.** The recommendation follows from the blocking list, not from taste.
   `references/calibration.md` and `references/scoring-rubric.md` define the scale.
6. **Constructive and specific.** Each blocking issue names the fix or the experiment that
   would resolve it. Tone stays neutral; the authors are colleagues.

## Workflow

- [ ] Read fully; write the paper's claims in your own words (three lines).
- [ ] For each claim: the evidence offered, and whether it supports the claim as worded.
- [ ] Methods and statistics check (`references/statistical-pitfalls.md`, `references/common-issues.md`).
- [ ] Figures, tables and reporting check (`references/paper-mechanics.md`, `references/reporting-standards.md`).
- [ ] Reproducibility and ethics check.
- [ ] Classify, calibrate, write the report.

**Claims.** State what the paper claims to have shown, with the scope it claims (which
data, which conditions). Everything else is checked against this.

**Evidence per claim.** For each claim: which table, figure or theorem carries it; whether
the comparison is fair (same data, budget, tuning); whether the effect size clears the
variance (seeds, confidence intervals, n); whether the metric measures the claim; whether
a simpler explanation fits the same evidence.

**Methods and statistics.** Design matched to the question; randomization and controls;
sample size and power; the test's assumptions met; corrections for multiple comparisons;
leakage between train and test or between selection and evaluation; hyperparameter tuning
on the test set; reported variance. `references/evidence-hierarchy.md` for study designs,
`references/common-biases.md` and `references/logical-fallacies.md` for reasoning faults.

**Figures and reporting.** Every figure's claim visible without the prose; axes, units,
uncertainty; numbers in text equal to numbers in tables; reporting checklist for the field
(CONSORT, PRISMA, ARRIVE, the venue's reproducibility checklist).

**Reproducibility.** Code and data availability; enough detail to rerun; seeds; compute.
If code is attached, run the smallest thing that tests a central number.

**An independent second read.** When the artifact is long, the stakes are high, or your
own draft is under review, delegate one read to the critique reviewer (Task tool,
`subagent_type: "explore"`, `specialist: "critique"`) with the artifact paths and the
specific angle: statistics, leakage, claims versus evidence. It is read-only and reports
BLOCKING and OBSERVATION items. Merge its BLOCKING findings with yours; do not average
them away.

## Report

```markdown
## Summary
Three sentences: what the work claims, what it does, what the evidence shows.

## Blocking
1. [Section/Table] Issue. Why it undermines the claim. What would resolve it.

## Observations
- [Location] Suggestion.

## Recommendation
Accept / Minor revision / Major revision / Reject, with the one-sentence reason tied to the
blocking list. Confidence: high / medium / low, and why.
```

For the user's own draft, the same report, then the offer to fix the blocking items with
paper-writing. For grant review, `references/reviewer-expectations.md` covers criteria
and scoring conventions.

## Before you hand it over

- Every issue has a location and a fix.
- The recommendation follows from the blocking list; a paper with no blocking issues is not
  rejected for taste, and a paper with one is not accepted for polish.
- Numbers you recomputed are shown with your method.
- What you could not check is listed as unchecked, not assumed fine.
