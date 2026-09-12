---
name: ml-paper-writing
description: Writes and revises machine-learning papers for NeurIPS, ICML, ICLR, ACL, COLM and AAAI, from a research repository or a set of tracked runs to a compiling LaTeX draft in the venue's template, with the contribution stated as claims backed by experiments, ablations and honest baselines. Use for ML or AI conference papers, workshop papers, camera-ready preparation, and rebuttals. For journal articles and other fields use paper-writing; for references use citations; for figures use figures.
summary: "NeurIPS/ICML/ICLR/ACL/COLM/AAAI papers in the venue template, claims paid for by experiments."
category: core
role: workflow
allowed-tools: [Read, Write, Edit, Bash, glob, grep, experiments]
license: MIT
version: 1.0.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
  adapted-from: Orchestra AI-Research-SKILLs ml-paper-writing (MIT); K-Dense venue-templates (MIT); alphaXiv OpenResearch orx-paper (MIT)
---

# ML paper writing

An ML paper makes two or three claims and earns each with an experiment a reviewer could
not have predicted the outcome of. Reviewers at these venues read for the claims first,
then hunt for the ablation that would have falsified them. Write the paper the way they
read it.

## Non-negotiables

1. **Write the `.tex` in the venue's template**, in the working folder, and link it. Copy
   the class and style files from `assets/templates/<venue>/` beside the draft; keep the
   template's `\documentclass`, packages and anonymization mode. A conference class encodes
   the rules the submission is checked against.
2. **Claims are numbered and paid for.** The introduction ends with the contributions, each
   one a claim ("X improves Y by Z under W"), and each claim maps to a table or figure that
   tests it. A contribution without an experiment is a sentence to delete.
3. **Numbers come from runs.** Read them with the experiments tool or from the result files;
   never from memory or the paper's earlier draft. State seeds, variance and compute for
   every headline number.
4. **Baselines are strong and fair.** Same data, same budget, tuned as carefully as the
   method. A win over an untuned baseline is the finding reviewers reject first.
5. **Related work positions, it does not list.** Group prior work by the idea it shares
   with yours and say what is different, with citations resolved by the citations skill.
6. **Limitations are specific.** "Only evaluated on English" and "requires 8× the memory"
   are limitations; "future work could explore more datasets" is not.

## Workflow

- [ ] Understand the repo and results; confirm the contribution in one paragraph.
- [ ] Choose the venue and copy its template; fix the page budget.
- [ ] Build the claims-to-evidence table.
- [ ] Draft: method, experiments, results, related work, introduction, abstract.
- [ ] Figures and tables (figures skill); citations (citations skill).
- [ ] Compile, check the venue checklist, read the PDF as a reviewer.

**Starting from a repository.** Read `README`, `results/`, `configs/`, notebooks, any
`.bib`, and the tracked runs (`experiments runs`, `experiments compare`). Write the
contribution paragraph and show it with the first draft, not before: "I framed X as the
main contribution; the results that carry it are A and B" is a question the user can
answer while reading a full draft. Draft everything you can with confidence and flag the
rest.

**Claims table.** Before prose, a table: claim; the experiment that tests it; the table or
figure; the baseline; seeds and budget. Anything without a row is not in the paper.

**Structure.** Abstract (problem, approach, main result with a number, implication); 1
Introduction (problem, why hard, what we do, contributions); 2 Related work (or after
experiments, by venue convention); 3 Method (notation, the idea, the algorithm, what is
new versus borrowed); 4 Experiments (setup: data, baselines, metrics, compute; main
results; ablations; analysis); 5 Limitations; 6 Conclusion. Appendix: full hyperparameters,
extra results, proofs, compute statement. `references/writing-guide.md` has section-level
guidance and the sentence patterns strong papers use.

**Experiments section.** Setup first, in enough detail to reproduce: datasets and splits,
preprocessing, baselines and how they were tuned, metrics with direction, hardware and
wall-clock. Main results table with mean ± std over seeds and the number of seeds in the
caption; bold the best only when the gap exceeds the spread. Ablations remove one thing
at a time and answer "which part matters". Analysis explains a surprising result with a
plot, not a paragraph of speculation.

**Figures and tables.** The figures skill for plots (learning curves, scaling, comparisons,
Pareto, matrices), the schematics skill for the method overview. Every figure has a claim
in its caption; every table is referenced before it appears; units and uncertainty on
everything.

**Camera-ready and rebuttals.** For camera-ready: de-anonymize, add acknowledgements and
the code link, check the page budget with the venue's option, run the checklist
(`references/checklists.md`). For a rebuttal: quote each comment, answer directly with
evidence (a new number, a pointer to a table), state the change, and stay on the
reviewer's question.

## Venue notes

| Venue | Template | Notes |
| --- | --- | --- |
| NeurIPS | `assets/templates/neurips2025/` | 9 pages + references; paper checklist required at the end |
| ICML | `assets/templates/icml2026/` | 8 pages + references; impact statement |
| ICLR | `assets/templates/iclr2026/` | 9 pages + references; reproducibility statement encouraged |
| ACL family | `assets/templates/acl/` | 8 pages long / 4 short; limitations section mandatory |
| COLM | `assets/templates/colm2025/` | 9 pages; language-model focus |
| AAAI | `assets/templates/aaai2026/` | 7 pages + references; strict formatting |

`references/ml-conference-style.md` and `references/cs-conference-style.md` cover the
voice, section conventions and reviewer expectations of these venues;
`references/reviewer-guidelines.md` is what reviewers are told to look for, which is what
the draft is checked against.

## Before you hand it over

- Compiles with the venue class; page budget met; no `??` references, no overfull warnings
  that show.
- Every claim in the introduction has its table or figure; every number matches its source.
- Baselines' tuning is described; seeds and variance reported; compute stated.
- Citations resolved and verified; no arXiv citation for a paper that was published.
- Limitations specific; broader impact or ethics statement where the venue asks.
- The PDF read once as a reviewer, with the three most likely objections written down for
  the user.
