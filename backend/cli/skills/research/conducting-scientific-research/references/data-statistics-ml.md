# Data, statistics, machine learning, and figures

## Intake

Before modeling, inspect file inventory, schema, row and column counts, identifiers, target definition, units, missingness, duplicates, ranges, categorical levels, timestamps, grouping variables, and train/test provenance. Hash or version material inputs.

Create a data dictionary when names or encodings are not self-explanatory. Resolve unit, build, label, and join mismatches explicitly; do not silently coerce them.

## Statistics

Identify the sampling unit and dependence structure. Match the model to outcome type, design, repeated measures, clustering, censoring, zero inflation, and missingness. Report effect sizes and uncertainty. Check assumptions and influence, not only a p-value.

Adjust for multiplicity when the inferential family requires it and state the family. For causal claims, define treatment, outcome, estimand, time zero, confounders, mediators, colliders, interference assumptions, positivity, and sensitivity analyses. Predictive accuracy is not causal identification.

## Machine learning

Choose validation from the data-generating process. Use grouped, temporal, spatial, nested, or entity-level splits when random rows would leak information. Fit every learned preprocessing step inside each training fold. Use out-of-fold predictions for stacking and error analysis.

Compare against a trivial and a strong conventional baseline. Track seeds, split definitions, features, hyperparameters, runtime, and failures. Evaluate calibration, subgroup behavior, robustness, and distribution shift when relevant. Do not tune to the held-out test set or public leaderboard.

## Figures

Choose the plot from the scientific question and data shape. Label axes, units, transformations, sample sizes, uncertainty, and aggregation. Do not use a visual encoding that hides distribution or dependence. Save the data or code behind the figure, render it, and inspect the actual image before saving the artifact.
