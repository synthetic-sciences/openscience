---
name: analysis-report
description: Writes the trace and report for an analysis whose output a reader will judge, restating the question with its binding clauses, recording data provenance, the method with every parameter that matters, results with raw and adjusted numbers and uncertainty, the checks performed, limitations, a decision log of alternatives considered and why they were rejected, and the exact commands that reproduce every number, using the Markdown skeleton included here. Use when delivering any quantitative analysis, model comparison, data audit or computational experiment to a person who did not watch the work; use paper-writing for manuscripts and ml-paper-writing for machine-learning papers.
summary: "Report template; question, provenance, method, results, checks, decisions, rerun."
category: writing
allowed-tools: [Read, Write, Edit, glob, grep]
license: MIT
version: 1.0.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
---

# Analysis report

The reader did not watch you work and will decide whether to trust the number. The report
has to let them confirm you answered the question actually asked, see every choice that
could have moved the result, and rerun it without asking you anything.

## Rules

1. **Restate the question with its binding clauses.** Population, time window, inclusion
   and exclusion rules, the exact metric and its unit, the direction that counts as
   better, thresholds, and what would count as "no effect". Quote the original wording
   where it is ambiguous and state the reading you adopted.
2. **Provenance for every input.** File or URL, version or release, access date, size, row
   count, checksum, and the filters applied before analysis, with a row-count flow that
   shows how many records left at each step and why.
3. **Method with parameters.** Every non-default parameter and every default that matters
   (two-sided test, Welch correction, random seed, tolerance, solver), with software
   versions. The exact call beats a prose paraphrase of it.
4. **Results with uncertainty.** Primary number first, with its interval or SD and n, raw
   and adjusted values side by side, units on everything, decimals consistent with the
   precision the data support. Tables for more than three numbers; figures with labelled
   axes and units, saved to files that the report references by path.
5. **Checks performed.** What you did to catch your own errors: sanity bounds,
   recomputation by another route, sensitivity to a dropped subset or a different seed,
   unit tests on the pipeline, reconciliation against a known value.
6. **Limitations.** Data quality, assumptions untested or violated, confounders, scope of
   generalization, and what the analysis cannot distinguish between.
7. **Decision log.** Every fork where a reasonable analyst could have gone the other way:
   the choice, the alternatives, why this one, and the alternative's result when it was
   cheap to run. A reviewer reads this section first.
8. **Reproducibility.** The ordered commands or script that regenerate every number and
   figure from raw inputs, the environment specification, runtime and resources needed,
   and the output paths.
9. **Separate results from interpretation.** Numbers live in Results; claims live in
   Interpretation. Answer the question in one sentence at the top and again at the end
   with the single caveat most likely to change it.
10. **Consistency pass before delivery.** Numbers in prose equal numbers in tables equal
    numbers in output files; every referenced path exists; every claim points at a
    result; no placeholder remains.

## Template

````markdown
# <Question, phrased as a question or a testable claim>

**Answer.** One sentence with the primary number, its uncertainty and direction.
Confidence: high / medium / low, and the one caveat that could flip it.

## 1. Question
- Original wording: "..."
- Binding clauses: population = ..., window = ..., metric = ..., unit = ...,
  threshold = ..., direction = ...
- Interpretation choices: ...

## 2. Data provenance
| Source | Version / release | Access date | Rows in | Rows out | Filter | Checksum |
| --- | --- | --- | --- | --- | --- | --- |

## 3. Method
- Preprocessing: ...
- Model or test: `exact.call(arg=value, ...)`
- Parameters and defaults that matter: ...
- Software: python 3.x, package==version, ...

## 4. Results
| Quantity | Estimate | 95% CI | n | Raw p | Adjusted p (method, m) | Notes |
| --- | --- | --- | --- | --- | --- | --- |
Figures: `figures/fig1.png` (what it shows).

## 5. Checks performed
- ...

## 6. Limitations
- ...

## 7. Decision log
| Decision | Chosen | Alternatives | Why | Effect of alternative (if run) |
| --- | --- | --- | --- | --- |

## 8. Reproducibility
```bash
# From the repository root; about X min on N CPUs, Y GB RAM, no network needed.
python scripts/01_prepare.py --in data/raw.csv --out data/clean.parquet
python scripts/02_analyze.py --seed 0 --out results/
```
Environment: `requirements.lock`. Outputs: `results/summary.csv`, `figures/`.

## 9. Interpretation
- What the result means for the question, and what it does not settle.
````

## Sources

- Sandve et al. (2013), Ten simple rules for reproducible computational research: https://doi.org/10.1371/journal.pcbi.1003285
- Wilkinson et al. (2016), The FAIR guiding principles for scientific data management: https://doi.org/10.1038/sdata.2016.18
- The Turing Way, guide for reproducible research: https://book.the-turing-way.org/reproducible-research/reproducible-research
- Gelman and Loken (2013), The garden of forking paths: http://www.stat.columbia.edu/~gelman/research/unpublished/p_hacking.pdf
- Wasserstein and Lazar (2016), The ASA statement on p-values: https://doi.org/10.1080/00031305.2016.1154108
- Nygard (2011), Documenting architecture decisions: https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions
- EQUATOR Network reporting guidelines: https://www.equator-network.org/
