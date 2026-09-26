---
name: analysis-report
description: Writes the trace and report for an analysis whose output a reader will judge, restating the question with its binding clauses, recording data provenance, the method with every parameter that matters, results with raw and adjusted numbers and uncertainty, the checks performed, limitations, a decision log of alternatives considered and why they were rejected, and the exact commands that reproduce every number, using the Markdown skeleton included here. Use when delivering any quantitative analysis, model comparison, data audit or computational experiment to a person who did not watch the work; use paper-writing for manuscripts and ml-paper-writing for machine-learning papers.
summary: "The trace a reader will judge: every clause mapped to a step with its code and number, provenance, results, checks, decisions, rerun; prescribed headings verbatim."
category: core
role: support
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

1. **The request's specification is the primary analysis.** A grouping rule the request
   states (a median split, a tertile, a named marker), a named tissue, timepoint,
   population, comparison arm, test, threshold or output is what is computed first and
   reported first, exactly as written, on exactly the population named. Your better
   method is welcome: it is run as well and reported as a sensitivity analysis beside
   the requested one, never in its place. Substituting the "right" method for the
   requested one is the most common way a correct analysis scores as a wrong one.
   Restate the question with its binding clauses: population, time window, inclusion
   and exclusion rules, the exact metric and its unit, the direction that counts as
   better, thresholds, and what would count as "no effect". Quote the original wording
   where it is ambiguous and state the reading you adopted. Then map every clause to a
   numbered step in the Method: a question that specifies a chain (classify, then
   weight, then integrate) or a construct (a monotone trend across ordered grades, not
   a difference somewhere) is answered by implementing that chain step by step, and a
   two-part question gets two answered parts. A single proxy for the chain, or an
   omnibus test for the construct, is a different analysis.
   Then, before any analysis runs, write the checklist the report must satisfy and
   keep it beside the plan: every clause of the question; every group, stratum,
   endpoint or comparison it names or implies (a treatment's control, a mutation's
   wild-type, the reference arm, the second endpoint); every output it asks for (a
   figure counts); and the standard readings a reviewer of this data type expects
   beyond the primary result — a set- or pathway-level view for gene-level results,
   the field's standard model beside any custom test, sensitivity to the key
   threshold, the named entities interpreted mechanistically. The Results address
   each item by name; the answer answers each clause. A definition the question
   gives — a median within a group, a condition at every timepoint, a one-directional
   hypothesis, separate test families — is applied as written, with any objection
   recorded beside it, never substituted; and every definition is scoped to the
   population the question names: a threshold is computed within that group, an
   implied cohort restriction is applied before the analysis, and a "top N" is
   exactly N.
2. **Provenance for every input.** File or URL, version or release, access date, size, row
   count, checksum, and the filters applied before analysis, with a row-count flow that
   shows how many records left at each step and why. Before the first filter, list the
   distinct values and counts of every column you filter or group on, read from the
   file rather than assumed from its name (which code is the baseline level, which
   categories belong in a denominator, how missingness is coded), and name the unit of
   analysis.
3. **Method with parameters.** Every non-default parameter and every default that matters
   (two-sided test, Welch correction, random seed, tolerance, solver), with software
   versions. The exact call beats a prose paraphrase of it: under each step, paste the
   code that ran, verbatim and copy-pasteable, followed by the quantitative intermediate
   it produced (a count, a dimension, a p-value). A step described in prose without its
   code and number cannot be checked and, to a reader grading the text, did not happen.
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
9. **Interpretation is a deliverable, and the answer is committed.** Numbers live in
   Results; claims live in Interpretation, and Interpretation is graded as hard as the
   numbers. Answer the question in one sentence at the top and again at the end, as
   the best-supported answer with a confidence and the single caveat most likely to
   change it. "Cannot be determined", "the data do not establish" and a direction left
   unnamed are not answers where the data bear on the question; state the reading the
   evidence favours and what would overturn it. Anchor the interpretation to what the
   question names: one paragraph per named phenotype, group, contrast or pathway. For
   each entity the result turns on, give the mechanism (with a reference), its
   functional role, the clinical or translational implication (a therapy, a
   biomarker, a target, a risk), and the next experiment that would test it. These are
   hypotheses: label them as such and give them. "Not necessary", "beyond the data",
   "would be speculative" and "cannot be inferred from observational data" are
   refusals a reader scores as no interpretation at all; a labelled hypothesis with a
   reference is what they expect. When the question asks for candidates, experiments
   or drugs, name specific ones with a reference. "Trends" and "consistent with" are
   the phrasing a grader halves. References ground the claims that need grounding,
   one each, and then stop: a reference search that outlasts the analysis adds nothing
   the report can use.
10. **Consistency pass before delivery.** Numbers in prose equal numbers in tables equal
    numbers in output files; every referenced path exists; every claim points at a
    result; no placeholder remains.
11. **Prescribed structure wins.** When the request fixes the headings, their order or
    their names, use them verbatim in place of the template below and keep every one,
    even where a section is short; a reader grading the text looks for its headings
    first. Where limitations or references are called for, they are sections with
    content, not a closing sentence.
12. **The answer file is the answer, not a pointer.** When the request asks for a
    separate plain answer beside the trace, it carries the direction, the counts and
    statistics, the named entities, the mechanism in one paragraph and the limitation
    in one line, in the language of the question; a grader reading it alone should
    reach the same conclusion as one reading the trace. Nothing that the trace
    concludes is left out of it, and it does not exceed what the trace supports.
13. **Write the report; do not build it.** A builder script that assembles the trace,
    a validator that counts its code blocks, a placeholder scanner: none of these is
    graded and each costs the minutes a further analysis would have used. The checks
    a judged report needs are that the prescribed headings and files exist and that
    the numbers in prose match the tables; that is a five-line check, run once.

## The standard readings, by kind of data

The checklist in rule 1 asks for "the standard readings a reviewer of this data type
expects". These are they: what a specialist runs before answering anything else, with
the field's default resource and output. When the request names a method, that method
is primary and these are secondary; when it does not, the reading below is primary and
your own choice is the sensitivity analysis. Both are reported: coverage is how a
careful analyst hedges a reviewer.

- **Expression contrast** (bulk RNA counts; proteomics or metabolomics intensities):
  a count or intensity model (DESeq2, edgeR, limma-voom) with shrunken effect sizes;
  ranked GSEA on MSigDB Hallmark first, then GO, KEGG, Reactome, with NES, adjusted p
  and leading edge per contrast; across conditions or cell types compare the pathway
  tables, not the gene lists; over-representation as the secondary reading; the counts
  at each threshold (adjusted p, |log2FC| at the field's cut) stated.
- **Baseline signatures across groups**: variance filtering, scaled PCA, an unsupervised
  clustering (k-means or hierarchical) before the labels are read, then label
  agreement and a similarity matrix; a PCA or UMAP figure.
- **Chromatin differential** (ATAC, ChIP, histone marks): a union or consensus peak set
  across samples; counts over it from the alignments when they are present; a
  differential model (DESeq2, edgeR, DiffBind) with explicit counts of gained and lost
  regions; annotation into promoter, exon, intron and intergenic with an enrichment
  test against unchanged regions; nearest-gene and pathway readings; motif enrichment
  when the question is regulatory.
- **Single cell**: QC, normalisation, highly variable genes, scaling, PCA, neighbours,
  clustering, UMAP, in that order; markers per cluster and an annotation; data-driven
  thresholds (percentiles, mixture fits) rather than fixed raw counts; per-sample
  composition with a test.
- **Cohort genomics** (called mutations and copy number): the cohort readings in
  `cancer-genomics-analysis` (per-sample calls with the definition stated; pathway
  frequency as the union of altered samples with the canonical member list; the
  reference or naive group beside the group of interest; the strata of the phenotype's
  known driver; co-occurrence or mutual exclusivity; clinical association).
- **Survival**: Kaplan-Meier with log-rank for every named group in one figure; Cox with
  hazard ratio and CI against the named reference group; every group the request names
  in the same table.
- **Correlation and association screens**: rank by effect size and by significance and
  report both top lists; FDR; a combined score when several axes are asked (the product
  of the effects); the field's model (limma-voom; a mixed model for repeated measures)
  beside a rank correlation.
- **Networks and modules** (WGCNA and kin): restrict to the population the question
  names; batch-correct; a QC figure; the module-trait table; pathway annotation of
  every module; hub genes.
- **GWAS, colocalisation, fine-mapping**: the allele frequencies and sample sizes the
  method's formulae need; the posterior per locus; the reference panel named.
- **Biomarker or target lists**: druggability with counts per gene from a drug-gene
  resource; multi-cancer breadth; a known-marker sanity check; a follow-up experiment
  per top candidate.

Where two defaults exist (the default background beside the measured background, mean
beside median, the named collection beside another), run both and lead with the
field's.

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
Columns filtered or grouped on, with their distinct values and counts as read from the
file: ... Unit of analysis: ...

## 3. Method
Step 1 — <clause of the question it answers>. Decision and rationale: ...
```python
# the code that ran, verbatim
```
Result: <count, dimension or statistic this step produced>
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
