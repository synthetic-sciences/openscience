# Surveillance caveats

Genomic surveillance data is a convenience sample of a convenience sample: someone had to be
tested, the specimen had to be selected for sequencing, the sequence had to pass QC, and a
laboratory had to submit it. Every number below survives that funnel. The caveats here are the
difference between a defensible statement and a confident wrong one.

## Reporting lag is the dominant error

**Recent weeks are not a sample of what was circulating. They are a sample of whoever reports
fastest.** Measured on the open SARS-CoV-2 instance, US sequences, six monthly cohorts:

| Days after collection | Share of the cohort that has arrived |
| --- | --- |
| 7 | 29% |
| 14 | 46% |
| 30 | 68% |
| 60 | 87% |
| 90 | 94% |
| 180 | 100% |

H5N1 is far slower: 0% at 14 days, 15% at 30 days, 85% at 60 days.

Two things follow.

**The denominator for the last several weeks is a fraction of its final size.** A collection week
that will eventually hold 200 sequences may hold 20 today, and those 20 come disproportionately
from the fastest-reporting laboratories — which are geographically and institutionally clustered.
The resulting proportion is not merely noisy, it is *biased*, and no confidence interval accounts
for that bias.

**A "new variant" can be an artifact of who reported first.** A lineage that looks like it appeared
last week may simply be the lineage of the laboratory with the shortest turnaround.

Run `reporting_lag.py` for the instance and country in question — the curve differs sharply
between them — and treat the cutoff it prints as the boundary of interpretable data.
`lineage_prevalence.py` flags weeks whose denominator has not filled in and excludes them from
growth fits by default.

The measured curve is a **lower bound**: it uses each cohort's present-day total as the
denominator, and even year-old cohorts still gain sequences.

## Sampling and ascertainment bias

Sequence counts are not case counts, and nothing in this data corrects for:

- **Which specimens get sequenced.** Programmes variously prioritise travellers, hospitalised
  patients, outbreak investigations, S-gene target failures, or a random subsample. The
  SARS-CoV-2 instance carries a `samplingStrategy` field that is frequently null.
- **Where.** Sequencing capacity is concentrated. A global proportion is close to a weighted
  average of a handful of well-resourced countries. Filter to a geography you can interpret, and
  say which.
- **Who.** Host matters outside human pathogens. For H5N1 the same clade in `Bos taurus`,
  `Gallus gallus`, and wild birds represents entirely different epidemiology; an unfiltered clade
  count silently pools them.
- **QC.** Sequences failing coverage thresholds are absent, and failure is not random with respect
  to lineage — a lineage with a primer-dropout region is under-represented exactly where the
  dropout matters.

None of this is fixable from the API. It is reportable, and the honest form is "X% of *sequenced
specimens meeting these filters*", never "X% of infections".

## Denominators

Decide explicitly, and state it:

- **Exact name vs. including descendants.** `XFG` alone is 4 sequences; `XFG*` is 640. Almost
  every question about a lineage's importance means the second.
- **Geography.** `--where country=USA` and no filter answer different questions.
- **Window.** A 26-week window and a 4-week window can invert the apparent ranking of two lineages.
  Windows are widened to whole ISO weeks so every row covers the same number of days.
- **Undated sequences.** Sequences with no usable collection date are excluded from weekly bins;
  `lineage_prevalence.py` reports how many rather than dropping them silently. Note that they are
  still counted by the descendant check, which is why that check compares two counts of the same
  kind rather than a count against a sum of bins — mixing the two made every lineage with undated
  sequences look as though it had descendants it does not.
- **Unassigned calls.** The most frequent value in a lineage column is sometimes null or
  `unassigned`. Discovery mode skips those, but they stay in the denominator, which is correct:
  they were sequenced, they just were not classified.

## Intervals

Proportions carry **Wilson score intervals**. The normal-approximation (Wald) interval is wrong in
exactly the situations surveillance produces constantly: it leaves the unit interval for small
`n`, and collapses to zero width at `p = 0`, which would report "0.0% (0.0–0.0)" for a lineage seen
zero times in 20 sequences. Wilson gives 0–17% there, which is the honest answer.

The interval covers **binomial sampling error only**. It does not cover reporting bias, geographic
clustering, or lineage-assignment error, all of which are typically larger. Two intervals
overlapping is weak evidence of no difference; two not overlapping is not proof of one.

## Growth estimates

`--growth` fits a weighted least-squares line to the log-odds of the proportion against time,
weighting each week by `n·p·(1−p)` and applying a Haldane–Anscombe 0.5 correction so 0 and 1 stay
finite.

**What it is:** a description of how the log-odds of this lineage among sequenced specimens moved
over this window, in this place.

**What it is not:** a fitness estimate, a transmissibility estimate, or a forecast. A logistic
model assumes two competing populations under constant conditions. Real windows contain changing
sequencing programmes, shifting geography, holidays, and multiple co-circulating lineages.

Two guards keep the interval honest.

**Observation thresholds.** With the continuity correction alone, a lineage observed **zero** times
in every week still produces p = 0.5/(n+1), which drifts purely with the denominator. A shrinking
denominator then manufactures a tight, confident-looking positive slope for a lineage nobody has
seen — this was observed in testing, at +0.105/week with a CI excluding zero, for a lineage with
no observations at all. `logit_slope()` therefore requires at least 5 observations across at least
3 non-empty weeks and returns nothing otherwise. Do not lower those thresholds to get a number.

**Dispersion clamped at 1.** The standard error uses a quasi-binomial dispersion estimated from the
residuals, floored at 1. With inverse-variance weights the model's own scale *is* 1, so an estimate
below it means a short series happened to sit near the line — not that the slope is better
determined than binomial sampling allows. Letting that through would report an interval narrower
than the data supports. Above 1 the estimate is kept, so genuine overdispersion widens the interval
as it should. The reported `dispersion` is worth reading: well above 1 means the weekly points
scatter far more than binomial sampling explains, which usually means the denominator's composition
is changing and the slope is describing that rather than the lineage.

When quoting a slope, give the window, the geography, the number of weeks, and the interval, and
call it descriptive.

## Reproducibility

The database changes daily. A result without `dataVersion`, the instance, the filters, and the
window cannot be reproduced or audited — the same query will simply return different numbers.
Every script prints all four. Keep them with the figure.

Open GenBank-derived instances hold a subset of what GISAID holds. Absolute counts here are lower
than GISAID-derived figures; proportions are usually comparable but not identical. Do not mix the
two in one table.

## What this data cannot support

- **Case counts, incidence, or severity.** Sequences are not cases; there is no denominator of
  infections and no outcome data.
- **Clinical interpretation.** Nothing here speaks to how a patient should be treated.
- **Outbreak-response or public-health recommendations.** Those require case surveillance,
  local context, and authority this data does not carry.
- **Claims about a lineage's biology from its frequency.** A rising proportion is consistent with
  higher transmissibility, immune escape, a founder effect, a single outbreak in one facility, or
  a change in who is being sequenced. Frequency alone does not distinguish them.
- **Absence.** "Zero sequences" means zero *sequenced and submitted* specimens under these
  filters. With H5N1 at 15% completeness after 30 days, recent absence is close to uninformative.
  Check whether the name is even valid first — on an unindexed column, a typo returns 0 rather
  than an error.
