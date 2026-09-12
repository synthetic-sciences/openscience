#!/usr/bin/env python3
"""Bioequivalence assessment: average BE, reference-scaled BE, and sample size.

Three separate criteria live under the word "bioequivalence" and they are not
interchangeable. Average BE puts a 90% confidence interval for the geometric
mean ratio inside 80.00-125.00%. EMA's ABEL widens those limits as a function
of the reference within-subject variability. FDA's RSABE replaces the interval
criterion altogether with a scaled linearised bound. Applying the wrong one, or
scaling without a replicate design, is a refuse-to-file class of error.

    python3 bioequivalence.py -i be.csv --design 2x2 --metric auc
    python3 bioequivalence.py -i be.csv --design replicate --metric cmax --scaling both
    python3 bioequivalence.py --power --cv 0.30 --gmr 0.95 --target-power 0.80

Input columns: ``subject``, ``treatment`` (T or R), ``value``, plus
``sequence`` and ``period`` for crossover designs. Replicate designs simply
have more than one record per subject per treatment.
"""

from __future__ import annotations

import argparse
import math
from dataclasses import dataclass
from typing import Sequence

import numpy as np

from _common import (
    InputError,
    Report,
    add_format_argument,
    main_wrapper,
    parse_float,
    read_table,
    require_columns,
)

try:
    from scipy.stats import chi2, norm
    from scipy.stats import t as t_dist
except ImportError as exc:  # pragma: no cover
    raise SystemExit("bioequivalence.py needs scipy: uv pip install scipy") from exc


# The FDA regulatory constant: ln(1.25) / 0.25, the point at which the scaled
# criterion coincides with the conventional limits at sigma_w0 = 0.25.
THETA_FDA = math.log(1.25) / 0.25
# EMA's ABEL widening coefficient, and the CVwR at which widening is capped.
K_ABEL = 0.760
CV_ABEL_CAP = 0.50
SWR_ABEL_CAP = math.sqrt(math.log(1.0 + CV_ABEL_CAP**2))
CV_SCALING_THRESHOLD = 0.30


def cv_from_s2(s2: float) -> float:
    return math.sqrt(math.exp(s2) - 1.0)


def s2_from_cv(cv: float) -> float:
    return math.log(1.0 + cv**2)


# ------------------------------------------------------------------ average BE


@dataclass
class AverageBE:
    gmr: float
    ci_low: float
    ci_high: float
    df: int
    se: float
    cv_within: float | None
    n_subjects: int
    method: str


def crossover_2x2(records: list[dict], design: str = "2x2") -> AverageBE:
    """Crossover analysis via within-subject period differences.

    Averaging the sequence-specific mean differences cancels the period effect
    exactly, which is the whole reason a crossover is run. The estimate and its
    standard error are identical to what a sequence/subject(sequence)/period/
    treatment ANOVA gives on balanced or unbalanced data, without building the
    design matrix.

    For replicate designs each subject's repeated administrations are averaged
    before differencing, which is the same intra-subject contrast the FDA
    reference-scaled procedure is built on. The within-subject CV reported for a
    replicate design is therefore a T-and-R mixture; the reference-specific
    ``CVwR`` used for scaling comes from ``reference_variability`` instead.
    """
    by_subject: dict[str, dict[str, list[float]]] = {}
    sequences: dict[str, str] = {}
    for row in records:
        by_subject.setdefault(row["subject"], {}).setdefault(row["treatment"], []).append(row["logvalue"])
        if row.get("sequence"):
            sequences[row["subject"]] = row["sequence"]

    differences: dict[str, list[float]] = {}
    for subject, treatments in by_subject.items():
        if "T" not in treatments or "R" not in treatments:
            continue  # incomplete subject: dropped, as in the standard analysis
        diff = float(np.mean(treatments["T"])) - float(np.mean(treatments["R"]))
        sequence = sequences.get(subject, "?")
        differences.setdefault(sequence, []).append(diff)

    total = sum(len(v) for v in differences.values())
    if total < 3:
        raise InputError("fewer than 3 subjects completed both treatments")

    if len(differences) < 2:
        # No sequence information: fall back to a paired analysis and say so.
        values = np.asarray(next(iter(differences.values())))
        n = len(values)
        estimate = float(values.mean())
        se = float(values.std(ddof=1) / math.sqrt(n))
        df = n - 1
        s2w = float(values.var(ddof=1)) / 2.0
        method = "paired (no sequence column: period effects are NOT removed)"
    else:
        means = {seq: float(np.mean(v)) for seq, v in differences.items()}
        estimate = float(np.mean(list(means.values())))
        pooled_num = sum(float(np.var(v, ddof=1)) * (len(v) - 1) for v in differences.values() if len(v) > 1)
        pooled_den = sum(len(v) - 1 for v in differences.values())
        s2d = pooled_num / pooled_den if pooled_den else float("nan")
        se = math.sqrt(s2d / 4.0 * sum(1.0 / len(v) for v in differences.values()))
        df = pooled_den
        s2w = s2d / 2.0
        method = (
            "replicate crossover (subject means differenced; period effect removed)"
            if design == "replicate"
            else "2x2 crossover (period effect removed)"
        )

    crit = float(t_dist.ppf(0.95, df))
    return AverageBE(
        gmr=math.exp(estimate),
        ci_low=math.exp(estimate - crit * se),
        ci_high=math.exp(estimate + crit * se),
        df=df,
        se=se,
        cv_within=cv_from_s2(s2w) if s2w > 0 else None,
        n_subjects=total,
        method=method,
    )


def parallel_design(records: list[dict]) -> AverageBE:
    test = np.asarray([r["logvalue"] for r in records if r["treatment"] == "T"])
    ref = np.asarray([r["logvalue"] for r in records if r["treatment"] == "R"])
    if len(test) < 2 or len(ref) < 2:
        raise InputError("a parallel design needs at least 2 subjects per arm")
    n1, n2 = len(test), len(ref)
    pooled = ((n1 - 1) * test.var(ddof=1) + (n2 - 1) * ref.var(ddof=1)) / (n1 + n2 - 2)
    se = math.sqrt(pooled * (1.0 / n1 + 1.0 / n2))
    df = n1 + n2 - 2
    estimate = float(test.mean() - ref.mean())
    crit = float(t_dist.ppf(0.95, df))
    return AverageBE(
        gmr=math.exp(estimate),
        ci_low=math.exp(estimate - crit * se),
        ci_high=math.exp(estimate + crit * se),
        df=df,
        se=se,
        cv_within=cv_from_s2(float(pooled)),  # total, not within-subject
        n_subjects=n1 + n2,
        method="parallel (pooled variance; the CV shown is total, not within-subject)",
    )


# -------------------------------------------------------------- scaled BE


@dataclass
class ReferenceVariability:
    s2wr: float
    df: int
    n_subjects: int

    @property
    def swr(self) -> float:
        return math.sqrt(self.s2wr)

    @property
    def cvwr(self) -> float:
        return cv_from_s2(self.s2wr)


def reference_variability(records: list[dict]) -> ReferenceVariability:
    """Within-subject variance of the reference, from replicated R administrations."""
    numerator = 0.0
    df = 0
    subjects = 0
    for subject in {r["subject"] for r in records}:
        values = [r["logvalue"] for r in records if r["subject"] == subject and r["treatment"] == "R"]
        if len(values) < 2:
            continue
        numerator += float(np.var(values, ddof=1)) * (len(values) - 1)
        df += len(values) - 1
        subjects += 1
    if df == 0:
        raise InputError(
            "no subject received the reference more than once. Reference-scaling requires a replicate "
            "design (partial replicate RRT/RTR/TRR or full replicate RTRT/TRTR) - it cannot be applied "
            "to a 2x2 study whatever the observed variability."
        )
    return ReferenceVariability(s2wr=numerator / df, df=df, n_subjects=subjects)


def abel_limits(rv: ReferenceVariability) -> tuple[float, float, bool]:
    """EMA widened acceptance limits. Returns (low, high, widened)."""
    if rv.cvwr <= CV_SCALING_THRESHOLD:
        return 0.80, 1.25, False
    swr = min(rv.swr, SWR_ABEL_CAP)
    return math.exp(-K_ABEL * swr), math.exp(K_ABEL * swr), True


def rsabe_bound(estimate: float, se: float, df_point: int, rv: ReferenceVariability) -> dict[str, float]:
    """FDA reference-scaled criterion via the Hyslop linearised 95% upper bound.

    The criterion is ``(mu_T - mu_R)^2 - theta^2 * s2wR <= 0``. Its upper
    confidence bound is not the sum of the two separate bounds; Hyslop's method
    combines them as ``E + H + sqrt((Eh-E)^2 + (Hh-H)^2)``, which is what the
    FDA progesterone guidance implements.
    """
    e_point = estimate**2
    e_bound = (abs(estimate) + float(t_dist.ppf(0.95, df_point)) * se) ** 2
    h_point = -(THETA_FDA**2) * rv.s2wr
    h_bound = -(THETA_FDA**2) * rv.s2wr * rv.df / float(chi2.ppf(0.05, rv.df))
    upper = e_point + h_point + math.sqrt((e_bound - e_point) ** 2 + (h_bound - h_point) ** 2)
    return {
        "criterion_point_estimate": e_point + h_point,
        "criterion_95_upper_bound": upper,
        "passes_scaled_criterion": float(upper <= 0.0),
    }


# ------------------------------------------------------------- power / N


def tost_power(n_total: int, cv: float, gmr: float, design: str = "2x2", limits: tuple[float, float] = (0.80, 1.25)) -> float:
    """Exact TOST power by integrating over the sampling distribution of s.

    Treating the standard error as known — the normal approximation that
    appears in most quick calculations — overstates power at the sample sizes
    bioequivalence studies actually use. This integrates the conditional power
    over the chi distribution of the estimated standard deviation, which agrees
    with Owen's Q to numerical precision.
    """
    sigma = math.sqrt(s2_from_cv(cv))
    delta = math.log(gmr)
    theta_low, theta_high = math.log(limits[0]), math.log(limits[1])

    if design == "parallel":
        df = n_total - 2
        factor = math.sqrt(2.0 / (n_total / 2.0))  # equal arms
    elif design == "2x2":
        df = n_total - 2
        factor = math.sqrt(2.0 / n_total)
    else:  # 3- or 4-period replicate, treated as a crossover with more df
        df = 2 * n_total - 3
        factor = math.sqrt(1.0 / n_total)
    if df < 1:
        return 0.0

    crit = float(t_dist.ppf(0.95, df))
    # s^2 * df / sigma^2 ~ chi2_df
    grid = np.linspace(1e-6, 1 - 1e-6, 2001)
    chi_values = chi2.ppf(grid, df)
    s_values = np.sqrt(chi_values / df) * sigma
    se_values = s_values * factor
    upper = (theta_high - crit * se_values - delta) / (sigma * factor)
    lower = (theta_low + crit * se_values - delta) / (sigma * factor)
    conditional = np.clip(norm.cdf(upper) - norm.cdf(lower), 0.0, 1.0)
    return float(np.mean(conditional))


def sample_size(cv: float, gmr: float, target: float, design: str = "2x2", limits: tuple[float, float] = (0.80, 1.25)) -> tuple[int, float]:
    step = 2 if design != "parallel" else 2
    for n in range(4, 5002, step):
        power = tost_power(n, cv, gmr, design, limits)
        if power >= target:
            return n, power
    raise InputError("no sample size below 5000 reaches the target power; the GMR is too far from 1")


# --------------------------------------------------------------------- CLI


def load_records(args: argparse.Namespace) -> list[dict]:
    rows = read_table(args.input)
    require_columns(rows, [args.subject_column, args.treatment_column, args.value_column], str(args.input))
    records = []
    for index, row in enumerate(rows, start=1):
        treatment = row[args.treatment_column].strip().upper()
        if treatment in {"T", "TEST"}:
            treatment = "T"
        elif treatment in {"R", "REF", "REFERENCE"}:
            treatment = "R"
        else:
            raise InputError(f"row {index}: treatment must be T or R, got {row[args.treatment_column]!r}")
        value = parse_float(row[args.value_column], f"{args.value_column} (row {index})")
        if value is None or value <= 0:
            raise InputError(f"row {index}: value must be positive to log-transform, got {value!r}")
        records.append(
            {
                "subject": row[args.subject_column].strip(),
                "treatment": treatment,
                "value": value,
                "logvalue": math.log(value),
                "sequence": (row.get("sequence") or "").strip().upper(),
                "period": (row.get("period") or "").strip(),
            }
        )
    return records


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Average, reference-scaled, and prospective bioequivalence calculations.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("-i", "--input")
    parser.add_argument("--design", choices=("2x2", "parallel", "replicate"), default="2x2")
    parser.add_argument("--metric", default="", help="label for the metric being tested, used in output only")
    parser.add_argument("--subject-column", default="subject")
    parser.add_argument("--treatment-column", default="treatment")
    parser.add_argument("--value-column", default="value")
    parser.add_argument(
        "--scaling",
        choices=("none", "abel", "rsabe", "both"),
        default="none",
        help="reference-scaled criteria to apply (replicate designs only)",
    )
    parser.add_argument("--limits", default="0.80,1.25", help="acceptance limits for average BE (default: 0.80,1.25)")
    parser.add_argument("--nti", action="store_true", help="narrow therapeutic index: apply 90.00-111.11%% limits")
    parser.add_argument("--power", action="store_true", help="prospective power / sample size instead of an analysis")
    parser.add_argument("--cv", type=float, help="assumed within-subject CV (as a fraction) for --power")
    parser.add_argument("--gmr", type=float, default=0.95, help="assumed true GMR for --power (default: 0.95)")
    parser.add_argument("--target-power", type=float, default=0.80)
    parser.add_argument("--n", type=int, help="compute power at this N instead of solving for N")
    add_format_argument(parser)
    return parser


def run(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    report = Report()

    limits = (0.90, 1.1111) if args.nti else tuple(float(x) for x in args.limits.split(","))
    if len(limits) != 2 or limits[0] >= limits[1]:
        raise InputError(f"--limits must be low,high with low < high; got {args.limits!r}")

    if args.power:
        if args.cv is None:
            raise InputError("--power needs --cv")
        if args.n:
            power = tost_power(args.n, args.cv, args.gmr, args.design, limits)
            report.scalar("n_total", args.n)
            report.scalar("power", power)
        else:
            n, power = sample_size(args.cv, args.gmr, args.target_power, args.design, limits)
            report.scalar("n_total_required", n)
            report.scalar("achieved_power", power)
        report.scalar("assumed_cv_within", args.cv)
        report.scalar("assumed_gmr", args.gmr)
        report.scalar("acceptance_limits", f"{limits[0]:.4f}-{limits[1]:.4f}")
        report.note(
            "Power is computed exactly by integrating over the sampling distribution of the estimated "
            "standard deviation; the normal approximation overstates it at these sample sizes."
        )
        report.note(
            "Sample size is driven far more by the assumed GMR than by CV. Assuming GMR = 1.00 rather "
            "than 0.95 typically halves the calculated N and is the most common way a BE study ends up "
            "underpowered."
        )
        return report.emit(args.format)

    if not args.input:
        raise InputError("give -i INPUT for an analysis, or --power for a sample-size calculation")

    records = load_records(args)
    label = args.metric or args.value_column

    result = parallel_design(records) if args.design == "parallel" else crossover_2x2(records, args.design)
    passes = limits[0] <= result.ci_low and result.ci_high <= limits[1]

    report.scalar("metric", label)
    report.scalar("design", args.design)
    report.scalar("analysis", result.method)
    report.scalar("n_subjects", result.n_subjects)
    report.scalar("gmr_pct", 100.0 * result.gmr)
    report.scalar("ci90_low_pct", 100.0 * result.ci_low)
    report.scalar("ci90_high_pct", 100.0 * result.ci_high)
    report.scalar("acceptance_limits_pct", f"{100 * limits[0]:.2f}-{100 * limits[1]:.2f}")
    report.scalar("average_be_met", passes)
    report.scalar("degrees_of_freedom", result.df)
    if result.cv_within is not None:
        report.scalar(
            "cv_within_pct" if args.design != "replicate" else "cv_within_pct_T_and_R_mixture",
            100.0 * result.cv_within,
        )

    if not passes:
        report.finding(
            f"{label}: the 90% CI ({100 * result.ci_low:.2f}-{100 * result.ci_high:.2f}%) is not contained "
            f"in {100 * limits[0]:.2f}-{100 * limits[1]:.2f}%; average bioequivalence is not demonstrated"
        )
    if args.nti:
        report.note("narrow therapeutic index limits applied (90.00-111.11%)")

    if args.scaling != "none":
        if args.design != "replicate":
            raise InputError(
                "reference-scaling requires --design replicate. High observed variability in a 2x2 study "
                "does not license widening: without replicated reference administrations there is no "
                "estimate of within-subject reference variability to scale to."
            )
        rv = reference_variability(records)
        report.scalar("cvwr_pct", 100.0 * rv.cvwr)
        report.scalar("swr", rv.swr)
        report.scalar("cvwr_degrees_of_freedom", rv.df)
        report.scalar("subjects_with_replicated_reference", rv.n_subjects)

        rows = []
        if args.scaling in {"abel", "both"}:
            low, high, widened = abel_limits(rv)
            abel_pass = low <= result.ci_low and result.ci_high <= high and limits[0] <= result.gmr <= limits[1]
            rows.append(
                {
                    "criterion": "EMA ABEL",
                    "applicable": "yes" if rv.cvwr > CV_SCALING_THRESHOLD else "no (CVwR <= 30%)",
                    "limits_pct": f"{100 * low:.2f}-{100 * high:.2f}",
                    "widened": widened,
                    "point_estimate_constraint": "80.00-125.00%",
                    "met": abel_pass,
                }
            )
            if widened and rv.cvwr > CV_ABEL_CAP:
                report.note(
                    f"CVwR is {100 * rv.cvwr:.1f}%, above the 50% cap; ABEL limits are frozen at "
                    "69.84-143.19% rather than widening further."
                )
            if not abel_pass:
                report.finding(f"{label}: EMA ABEL criterion not met")
        if args.scaling in {"rsabe", "both"}:
            estimate = math.log(result.gmr)
            scaled = rsabe_bound(estimate, result.se, result.df, rv)
            point_ok = limits[0] <= result.gmr <= limits[1]
            applicable = rv.cvwr >= CV_SCALING_THRESHOLD
            met = bool(scaled["passes_scaled_criterion"]) and point_ok
            rows.append(
                {
                    "criterion": "FDA RSABE",
                    "applicable": "yes" if applicable else "no (CVwR < 30%: use unscaled ABE)",
                    "limits_pct": "linearised scaled bound",
                    "widened": applicable,
                    "point_estimate_constraint": "80.00-125.00%",
                    "met": met if applicable else passes,
                }
            )
            report.scalar("rsabe_criterion_point", scaled["criterion_point_estimate"])
            report.scalar("rsabe_criterion_95_upper_bound", scaled["criterion_95_upper_bound"])
            if applicable and not met:
                report.finding(f"{label}: FDA RSABE criterion not met")
        report.table("reference-scaled criteria", rows)
        report.note(
            "ABEL and RSABE are different criteria and can disagree on the same dataset. Which one "
            "applies is decided by the regulator the application goes to, and must be pre-specified."
        )

    report.note("all statistics computed on the natural-log scale; ratios are geometric means")
    return report.emit(args.format)


if __name__ == "__main__":
    raise SystemExit(main_wrapper(run))
