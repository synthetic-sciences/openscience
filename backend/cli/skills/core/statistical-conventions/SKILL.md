---
name: statistical-conventions
description: Chooses and reports statistical tests the way a careful referee expects, deciding paired versus unpaired and parametric versus rank-based from the design, using ordered-trend tests such as Jonckheere-Terpstra and Cochran-Armitage for dose or grade levels, correcting for multiple comparisons with Bonferroni, Holm or Benjamini-Hochberg and showing raw and adjusted p-values side by side, giving effect sizes such as Cohen's d, Cliff's delta and odds ratios with confidence intervals, bootstrapping intervals when no formula applies, and stating checked assumptions, exact p-values and degrees of freedom. Use whenever an analysis will report a p-value, a group difference, a trend across ordered categories or a correlation; use statistical-power for sample-size planning and experimental-design for laying out the study.
summary: "Name the unit of analysis, pick the test the design and construct call for, correct for multiplicity, report effect sizes, CIs and exact p."
category: core
role: support
allowed-tools: [Read, Bash, python]
license: MIT
version: 1.0.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
---

# Statistical conventions

The design and the measurement scale choose the test, not the size of the p-value it
yields. Every reported number travels with the quantity it estimates, its uncertainty, the
assumption it rests on, and the software that computed it.

## Choosing the test

1. **Design first.** The same units measured twice (before and after, matched pairs, two
   methods on the same samples) are paired: `scipy.stats.ttest_rel`, `wilcoxon`.
   Independent groups: `ttest_ind(a, b, equal_var=False)` (Welch; use Student's only when
   equal variances are a design fact, and say so), `mannwhitneyu`. Three or more groups:
   `f_oneway` or `kruskal`; repeated measures across blocks: `friedmanchisquare`. Name
   the unit of analysis before choosing: observations nested in a unit (cells within a
   donor, trials within a participant, technical replicates within a sample, regions
   within a patient) are aggregated to that unit (a per-donor proportion or mean) or
   fitted with a mixed model before any test. Testing the nested observations as if
   independent inflates n by orders of magnitude and makes every p-value meaningless.
2. **Scale and distribution.** Ordinal outcomes, heavy skew, small n with outliers, or
   censored-at-a-bound measurements call for rank-based tests (Mann-Whitney, Wilcoxon
   signed-rank, Kruskal-Wallis, Spearman `spearmanr`, Kendall `kendalltau`). Continuous,
   roughly symmetric data with adequate n use the t family. Check rather than assume:
   `shapiro` (informative for modest n only), a Q-Q plot, `levene` for variances. Name what
   you looked at; a normality test on n = 5 or n = 5000 says little on its own.
   Intensity measurements (proteomics and metabolomics signal, microarray and normalized
   expression values, fluorescence, concentrations spanning decades) are compared on the
   log2 scale: the difference of log2 means is the fold-change the question asks about,
   and a t-test on the linear values tests the wrong quantity. "Normalized", "imputed" or
   "batch-corrected" does not mean "log-transformed": values in the thousands or millions
   are linear, and the transform is part of the prescribed workflow even when the
   instruction does not spell it out. The scale is decided per step, not once for the
   pipeline: the statistics you compute (means, fold-changes, t-tests, correlations) take
   log2; a tool that is handed the expression matrix (GSEA, clustering, a named pipeline)
   takes the columns the task names, as supplied, unless the task or the tool's own
   documentation says to transform them. When the two readings give different calls, run
   both, say which the task's wording supports, and report the other as a sensitivity.
   Say which scale each statistic was computed on.
3. **Ordered categories need a trend test, not an omnibus test.** Doses, grades, stages,
   exposure levels: Jonckheere-Terpstra for a continuous or ordinal outcome across ordered
   groups (R `clinfun::jonckheere.test`, `PMCMRplus::jonckheereTest`,
   `DescTools::JonckheereTerpstraTest`); Cochran-Armitage for a binary outcome across
   ordered groups (R `stats::prop.trend.test`, `DescTools::CochranArmitageTest`; Python
   `statsmodels.stats.contingency_tables.Table(counts).test_ordinal_association()`, whose
   default scores give Cochran-Armitage); Page's L for ordered treatments in a blocked
   design (`scipy.stats.page_trend_test`). A Kruskal-Wallis p says "some group differs"; it
   is not evidence of a monotone trend. State the scores assigned to the levels.
4. **Counts and proportions.** `chi2_contingency` (state whether Yates' `correction` was
   applied), `fisher_exact` when any expected count is below five, `barnard_exact` or
   `boschloo_exact` as more powerful exact alternatives. Odds ratio with interval:
   `statsmodels.stats.contingency_tables.Table2x2(t).oddsratio_confint()`; risk ratio via
   `riskratio_confint()`. Report the 2x2 table itself, not only the ratio.
5. **Correlation.** Pearson for a linear relation between roughly bivariate-normal
   variables, Spearman otherwise; give r with its interval
   (`scipy.stats.pearsonr(x, y).confidence_interval()`) and n. Correlation on aggregated
   means is not correlation on individuals; say which level the r describes.

6. **The field's model is the primary analysis.** For the data type in front of you,
   the analysis a reader of the field expects is the one to run first and report as the
   result: a count model with dispersion and shrinkage (DESeq2, edgeR, limma-voom) for
   RNA-seq counts rather than a t-test on log-CPM; a paired or mixed model for repeated
   measures; a colocalization method for shared genetic signals; Kaplan–Meier with the
   log-rank test and a Cox model against the reference group for survival; dimensionality
   reduction before clustering for single-cell and screening matrices, with the clustering
   method the question names when it names one. A simpler custom test is a sensitivity
   check reported beside the standard one, not its replacement. For gene-level results a
   set- or pathway-level reading is part of the analysis, not an extra.
7. **Words that pick the quantity.** "Strongest", "largest", "most changed" and "top"
   rank by effect size (the correlation, the fold-change, the difference); "most
   significant" ranks by adjusted p. A question that asks which is strongest is not
   answered by a p-value ordering, and a "top N" is exactly N items.
8. **A threshold is a filter, not a test.** A set selected by a fold-change or a
   read-count cutoff carries a p-value and an FDR per element, or it is a candidate list
   and is called one.
9. **Named sets come whole.** A pathway or gene set the question names is taken from a
   canonical source (MSigDB Hallmark, KEGG, Reactome, GO) with the source and version
   named; a hand-picked subset answers a different question. Enrichment is tested
   against the universe of genes actually tested, stated explicitly.
10. **Scope every definition to the population the question names.** A threshold or
   median is computed within that group, not the whole cohort; a cohort restriction the
   question implies is applied before the analysis; test families are formed within the
   unit of comparison the question names, one adjustment per family.

## Multiplicity

11. Fix the family of hypotheses before looking at results, and report its size m. Holm
   controls the family-wise error rate with no extra assumptions and is uniformly more
   powerful than Bonferroni, so prefer it when Bonferroni is what a reader expects;
   Benjamini-Hochberg controls the false discovery rate and suits screens with many
   hypotheses. `statsmodels.stats.multitest.multipletests(p, alpha=0.05, method="holm")`
   also accepts `"bonferroni"`, `"fdr_bh"`, `"fdr_by"`, `"sidak"`, `"hommel"`. Put raw
   and adjusted p in adjacent columns of the same table with the method and m in the
   caption. Never show only one of the two.

## Effect sizes and intervals

12. A p-value without an effect size is half a result. Cohen's d with pooled SD, or Hedges'
   g with the small-sample correction (`pingouin.compute_effsize(x, y, eftype="cohen")` or
   `"hedges"`); Cliff's delta for rank comparisons, delta = 2U / (n1 n2) - 1 from the
   Mann-Whitney U, equivalently 2 CLES - 1 (`eftype="CLES"`); odds or risk ratios for binary
   outcomes; r itself for associations. Every effect size gets a confidence interval.
   Labels such as "medium" need the threshold source and a caveat that thresholds are
   field-dependent.
13. **Bootstrap** when the sampling distribution is not standard (medians, ratios,
    differences of AUCs, Cliff's delta): `scipy.stats.bootstrap((x, y), statistic)` with
    `n_resamples=9999`, `method="BCa"`, `confidence_level=0.95`, a seeded generator
    (`rng=` in current SciPy, `random_state=` in older releases), `paired=True` for
    paired data.
   Report the number of resamples, the method (percentile, basic, BCa) and the seed.
   `scipy.stats.permutation_test` gives an exact-in-spirit p for the same statistic.

## Reporting

14. Exact p to two significant figures (p = 0.031, p = 0.0042); write `p < 0.001` only below
   that threshold; never `p = 0.000`, `p = 0`, or a bare `n.s.`. One-sided tests only when
   pre-specified, stated as such.
15. Test statistic with degrees of freedom and sample sizes: t(23.4) = 2.41 (Welch degrees
    of freedom are fractional; do not round them to an integer), F(2, 57) = 4.10,
    chi-square(3) = 8.2 with N, U = 412 with n1 and n2, W for Wilcoxon, z for large-sample
    approximations together with whether an exact method or continuity correction was
    used.
16. Descriptives per group: n, mean (SD) for parametric comparisons, median [IQR] for
    rank-based ones, missing-data counts and how they were handled.
17. A complete sentence: "Group A exceeded B (median 4.2 vs 3.1; Mann-Whitney U = 412,
    n = 24 and 26, p = 0.008; Cliff's delta = 0.41, 95% BCa bootstrap CI 0.12 to 0.66;
    Holm-adjusted p = 0.024 over m = 3 comparisons)."

## A quantity the model constrains

18. **When the answer is a feature of a fitted curve** — where it peaks, crosses zero,
    changes sign, saturates — check whether the form you chose fixes that feature by
    construction before you read the number off it. A curve made symmetric about a point
    puts its extremum at that point for every dataset that could ever be measured; a
    two-parameter exponential puts its asymptote at zero; a model without a phase term
    puts its maximum at the phase you assumed. What such a fit reports is the constraint,
    not an estimate, and no amount of predictive accuracy turns it into one. Fit the freer
    form that lets the feature move, report where the data put it with an interval, and use
    the constrained form to ask whether the data are consistent with the constraint — never
    to supply the value.
19. **Parsimony ranks predictions; it does not tell you what is identifiable.** AIC, AICc,
    BIC and a term's p-value answer whether an extra parameter earns its place in a
    forecast. They do not answer whether the quantity you have to report can be estimated
    without it. A phase, offset or shape term that is "not significant" at a dozen points
    is usually unresolved rather than absent — its interval covers the constrained value
    and the fitted one alike — and dropping it does not move the estimate onto the
    constrained value, it deletes the estimate and leaves the assumption in its place. When
    a selection criterion and the reported feature disagree, give the interval from the
    freer fit, say that the constrained model is not excluded, and do not let a model
    chosen for prediction decide a number the data were collected to locate.

## Checklist

- [ ] Design named (paired or independent, number of groups, ordered or not) and the
      unit of analysis stated, with nested observations aggregated to it.
- [ ] For a reported feature of a fitted curve: the freer form fitted, the feature's
      interval given, and no value taken from a constraint that fixes it.
- [ ] Assumptions checked and the checks named.
- [ ] Test named with library and version.
- [ ] Raw and adjusted p in one table with method and m.
- [ ] Effect size with confidence interval for every comparison.
- [ ] Exact p, statistic, degrees of freedom, n.
- [ ] Seed recorded for any resampling.
- [ ] The field's standard model run as the primary analysis for the data type, a
      set-level reading given for gene-level results, and any custom test reported as
      a sensitivity beside it.
- [ ] Rankings by the quantity the words pick (effect size for "strongest"), sets
      selected by a threshold carrying p and FDR, named gene sets taken whole from a
      named source, the enrichment universe stated.
- [ ] Every threshold, restriction and test family scoped to the population the
      question names.

## Sources

- SciPy statistical functions: https://docs.scipy.org/doc/scipy/reference/stats.html
- `scipy.stats.bootstrap`: https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.bootstrap.html
- statsmodels `multipletests`: https://www.statsmodels.org/stable/generated/statsmodels.stats.multitest.multipletests.html
- statsmodels `Table.test_ordinal_association`: https://www.statsmodels.org/stable/generated/statsmodels.stats.contingency_tables.Table.test_ordinal_association.html
- R `prop.trend.test`: https://stat.ethz.ch/R-manual/R-devel/library/stats/html/prop.trend.test.html
- pingouin `compute_effsize`: https://pingouin-stats.org/build/html/generated/pingouin.compute_effsize.html
- Wasserstein and Lazar (2016), The ASA statement on p-values: https://doi.org/10.1080/00031305.2016.1154108
- APA Style, numbers and statistics guidelines: https://apastyle.apa.org/style-grammar-guidelines/numbers-statistics
