#!/usr/bin/env python3
"""Evaluate accuracy and precision per ICH Q2(R2) 3.3.

Accuracy is reported as mean recovery with a confidence interval, which is what
Q2(R2) 3.3.1.4 asks for -- a bare mean is not sufficient. Precision is
decomposed into repeatability and intermediate precision by a one-way
random-effects model, because pooling all results into a single standard
deviation understates the day-to-day variability the procedure will actually
show in routine use.

    python3 check_accuracy_precision.py --input ap.csv
    python3 check_accuracy_precision.py -i ap.csv --accuracy-limit 2 --rsd-limit 2
    python3 check_accuracy_precision.py -i ap.csv --design-check assay --format json

Input columns:
  level      nominal / added concentration (groups the accuracy analysis)
  measured   measured or recovered concentration
  group      optional: day, analyst, instrument or run -- the intermediate
             precision factor. Without it only repeatability is estimated.

Exit codes: 0 no findings, 1 findings raised, 2 bad input.
"""

from __future__ import annotations

import argparse
import math
import sys

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))

from _common import (  # noqa: E402
    EXIT_FINDINGS,
    EXIT_OK,
    InputError,
    add_common_args,
    emit,
    finding,
    mean,
    note,
    one_way_components,
    parse_rows,
    read_input,
    require_columns,
    rsd_percent,
    run_cli,
    sample_sd,
    sd_confidence_interval,
    t_ppf,
    to_float,
)

# ICH Q2(R2) 3.3.2.1 minima, used only to comment on the design. Either option
# is sufficient on its own.
DESIGN_MINIMA = {
    "assay": {
        "range_determinations": 9,
        "range_levels": 3,
        "single_level_determinations": 6,
        "note": "9 determinations across the range (3x3), or 6 at 100% of test concentration",
    },
    "impurity": {
        "range_determinations": 9,
        "range_levels": 3,
        "single_level_determinations": 6,
        "note": "9 determinations across the range (3x3), or 6 at 100% of test concentration",
    },
}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Check accuracy and precision from validation data."
    )
    parser.add_argument("--input", "-i", help="CSV/TSV/JSON file, or '-' for stdin")
    parser.add_argument("--accuracy-limit", type=float, default=None,
                        help="flag a level whose mean recovery deviates more than this %% "
                             "from 100%%")
    parser.add_argument("--rsd-limit", type=float, default=None,
                        help="flag repeatability or intermediate precision %%RSD above this")
    parser.add_argument("--ci-level", type=float, default=0.95,
                        help="confidence level for accuracy intervals (default 0.95)")
    parser.add_argument("--sd-ci-level", type=float, default=0.90,
                        help="confidence level for SD intervals (default 0.90)")
    parser.add_argument("--design-check", choices=sorted(DESIGN_MINIMA), default=None,
                        help="comment on the design against Q2(R2) recommended minima")
    parser.add_argument("--require-ci-within-limit", action="store_true",
                        help="require the whole accuracy CI inside the limit, not just the mean")
    add_common_args(parser)
    args = parser.parse_args()

    if not 0.5 <= args.ci_level < 1.0:
        raise InputError("--ci-level must be in [0.5, 1)")

    rows = parse_rows(read_input(args.input), args.input)
    require_columns(rows, ["level", "measured"])
    has_group = "group" in rows[0]

    records = []
    for i, r in enumerate(rows):
        records.append(
            {
                "level": to_float(r["level"], "level", i),
                "measured": to_float(r["measured"], "measured", i),
                "group": (r.get("group") or "all").strip() or "all",
            }
        )

    findings: list[str] = []

    # ---------------- Accuracy ----------------
    levels = sorted({rec["level"] for rec in records})
    accuracy_rows = []
    all_recoveries: list[float] = []
    for level in levels:
        vals = [rec["measured"] for rec in records if rec["level"] == level]
        if level == 0:
            raise InputError("a nominal level of 0 cannot be used for recovery")
        recoveries = [100.0 * v / level for v in vals]
        all_recoveries.extend(recoveries)
        m = mean(recoveries)
        n = len(recoveries)
        if n >= 2:
            sd = sample_sd(recoveries)
            half = t_ppf(0.5 + args.ci_level / 2.0, n - 1) * sd / math.sqrt(n)
            lo, hi = m - half, m + half
        else:
            sd, lo, hi = float("nan"), float("nan"), float("nan")
        accuracy_rows.append(
            {
                "level": level,
                "n": n,
                "mean_measured": mean(vals),
                "mean_recovery_pct": m,
                "bias_pct": m - 100.0,
                "sd_recovery_pct": sd,
                f"ci{int(args.ci_level * 100)}_low": lo,
                f"ci{int(args.ci_level * 100)}_high": hi,
            }
        )
        if args.accuracy_limit is not None:
            if abs(m - 100.0) > args.accuracy_limit:
                findings.append(
                    f"level {level:g}: mean recovery {m:.2f}% is {m - 100.0:+.2f}% from nominal, "
                    f"outside +/-{args.accuracy_limit:g}%"
                )
            elif args.require_ci_within_limit and math.isfinite(lo):
                if lo < 100.0 - args.accuracy_limit or hi > 100.0 + args.accuracy_limit:
                    findings.append(
                        f"level {level:g}: mean recovery {m:.2f}% is inside "
                        f"+/-{args.accuracy_limit:g}% but its "
                        f"{int(args.ci_level * 100)}% CI ({lo:.2f}, {hi:.2f}) is not -- the data "
                        "do not demonstrate accuracy at this limit"
                    )

    # ---------------- Precision ----------------
    # Precision is estimated WITHIN each concentration level. Pooling levels
    # together would let the 80/100/120 spread masquerade as imprecision.
    pct = int(args.sd_ci_level * 100)
    precision_rows: list[dict] = []

    def precision_block(label: str, groups: dict[str, list[float]], reference: float | None):
        """Append rows for one level (or for the normalised all-levels view)."""
        try:
            comp = one_way_components(groups)
        except InputError as exc:
            vals = [v for vs in groups.values() for v in vs]
            if len(vals) < 2:
                note(f"{label}: too few values for a precision estimate")
                return None
            sd = sample_sd(vals)
            base = reference if reference else abs(mean(vals))
            rsd = 100.0 * sd / base if base else float("nan")
            lo, hi = sd_confidence_interval(sd, len(vals) - 1, args.sd_ci_level)
            precision_rows.append(
                {"level": label, "component": "repeatability only", "sd": sd, "rsd_pct": rsd,
                 "df": len(vals) - 1, f"ci{pct}_low_sd": lo, f"ci{pct}_high_sd": hi}
            )
            note(f"{label}: intermediate precision not estimated ({exc})")
            return None

        base = reference if reference else abs(comp.grand_mean)

        def as_rsd(sd: float) -> float:
            return 100.0 * sd / base if base else float("nan")

        sr_lo, sr_hi = sd_confidence_interval(
            comp.sd_repeatability, comp.df_within, args.sd_ci_level
        )
        sat_df = comp.satterthwaite_df()
        si_lo, si_hi = sd_confidence_interval(comp.sd_intermediate, sat_df, args.sd_ci_level)
        precision_rows.extend(
            [
                {"level": label, "component": "repeatability (within group)",
                 "sd": comp.sd_repeatability, "rsd_pct": as_rsd(comp.sd_repeatability),
                 "df": comp.df_within, f"ci{pct}_low_sd": sr_lo, f"ci{pct}_high_sd": sr_hi},
                {"level": label, "component": "between-group", "sd": comp.sd_between,
                 "rsd_pct": as_rsd(comp.sd_between), "df": comp.df_between,
                 f"ci{pct}_low_sd": float("nan"), f"ci{pct}_high_sd": float("nan")},
                {"level": label, "component": "intermediate precision (total)",
                 "sd": comp.sd_intermediate, "rsd_pct": as_rsd(comp.sd_intermediate),
                 "df": sat_df, f"ci{pct}_low_sd": si_lo, f"ci{pct}_high_sd": si_hi},
            ]
        )
        if comp.sd_between == 0.0:
            note(
                f"{label}: between-group variance estimated as zero (MS_between <= MS_within); "
                "the groups are indistinguishable at this level"
            )
        if not comp.balanced:
            note(f"{label}: unbalanced design, effective group size {comp.n_effective:.3f}")
        if args.rsd_limit is not None:
            for name, value in (
                ("repeatability", as_rsd(comp.sd_repeatability)),
                ("intermediate precision", as_rsd(comp.sd_intermediate)),
            ):
                if math.isfinite(value) and value > args.rsd_limit:
                    findings.append(
                        f"{label}: {name} {value:.3f}% RSD exceeds the stated "
                        f"{args.rsd_limit:g}% limit"
                    )
        return comp

    if has_group:
        for level in levels:
            groups: dict[str, list[float]] = {}
            for rec in records:
                if rec["level"] == level:
                    groups.setdefault(rec["group"], []).append(rec["measured"])
            precision_block(f"{level:g}", groups, reference=abs(level))

        # Level-independent view: recovery as % of nominal, pooled across levels.
        norm_groups: dict[str, list[float]] = {}
        for rec in records:
            norm_groups.setdefault(rec["group"], []).append(
                100.0 * rec["measured"] / rec["level"]
            )
        if len(norm_groups) >= 2:
            precision_block("all (% of nominal)", norm_groups, reference=100.0)
    else:
        for level in levels:
            vals = [rec["measured"] for rec in records if rec["level"] == level]
            if len(vals) < 2:
                continue
            sd = sample_sd(vals)
            lo, hi = sd_confidence_interval(sd, len(vals) - 1, args.sd_ci_level)
            rsd = 100.0 * sd / abs(level)
            precision_rows.append(
                {"level": f"{level:g}", "component": "repeatability (no group column)",
                 "sd": sd, "rsd_pct": rsd, "df": len(vals) - 1,
                 f"ci{pct}_low_sd": lo, f"ci{pct}_high_sd": hi}
            )
            if args.rsd_limit is not None and rsd > args.rsd_limit:
                findings.append(
                    f"{level:g}: repeatability {rsd:.3f}% RSD exceeds {args.rsd_limit:g}%"
                )
        note(
            "no `group` column, so only repeatability was estimated. Q2(R2) 3.3.2.2 expects "
            "intermediate precision from different days, analysts or equipment"
        )

    naive = rsd_percent([rec["measured"] for rec in records])
    if len(levels) > 1:
        note(
            f"a single SD over every result regardless of level would report {naive:.3f}% RSD, "
            "which is a range effect and not precision. Precision is reported per level below"
        )

    # ---------------- Design commentary ----------------
    if args.design_check:
        # Q2(R2) 3.3.2.1 offers two alternatives, and either one is sufficient:
        #   (a) >=9 determinations covering the reportable range (e.g. 3 levels x 3), or
        #   (b) >=6 determinations at 100% of the test concentration.
        # Flag only when neither holds. Requiring 9 unconditionally would raise a
        # finding against a design the guideline explicitly permits.
        spec = DESIGN_MINIMA[args.design_check]
        option_a = len(records) >= spec["range_determinations"] and len(levels) >= spec["range_levels"]
        per_level = {lv: sum(1 for r in records if r["level"] == lv) for lv in levels}
        best_single = max(per_level.values())
        option_b = best_single >= spec["single_level_determinations"]
        if option_a:
            note(
                f"design satisfies Q2(R2) 3.3.2.1 option (a): {len(records)} determinations "
                f"across {len(levels)} levels"
            )
        elif option_b:
            note(
                f"design satisfies Q2(R2) 3.3.2.1 option (b): {best_single} determinations at a "
                "single level. Note that option (b) gives no information about precision "
                "across the range"
            )
        else:
            findings.append(
                f"repeatability design meets neither Q2(R2) 3.3.2.1 option: "
                f"{len(records)} determinations across {len(levels)} level(s), with at most "
                f"{best_single} at any one level. Option (a) needs "
                f"{spec['range_determinations']} across at least {spec['range_levels']} levels; "
                f"option (b) needs {spec['single_level_determinations']} at 100% of the test "
                "concentration"
            )

    if args.format == "json":
        emit([{"accuracy": accuracy_rows, "precision": precision_rows,
               "overall_mean_recovery_pct": mean(all_recoveries),
               "findings": findings}], "json")
    else:
        emit(accuracy_rows, args.format)
        print()
        emit(precision_rows, args.format)

    note(
        "Q2(R2) 3.3.1.4: report accuracy as mean percent recovery, or the difference from the "
        "accepted true value, with a 100(1-alpha)% confidence interval"
    )
    note(
        "Q2(R2) 3.3.2.2: intermediate precision covers days, environmental conditions, analysts "
        "and equipment; the effects need not be studied individually"
    )
    for f in findings:
        finding(f)
    if not findings:
        note("no findings against the checks that were run")
    note("this tool does not decide that accuracy or precision is acceptable")
    return EXIT_FINDINGS if findings else EXIT_OK


if __name__ == "__main__":
    run_cli(main)
