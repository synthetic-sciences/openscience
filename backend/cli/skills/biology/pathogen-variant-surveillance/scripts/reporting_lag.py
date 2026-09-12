#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Measure how long sequences take to appear, and how far back to trust the data.

The single most common way to get variant surveillance wrong is to compute
prevalence over the last few weeks. Those weeks are not a sample of what was
circulating -- they are a sample of whichever laboratories report fastest, and
they keep growing for months. This script measures that filling-in curve from
the instance itself and turns it into a cutoff date.

    python3 reporting_lag.py --instance sars-cov-2 --where country=USA
    python3 reporting_lag.py --instance h5n1 --target 0.8

Method: take monthly collection cohorts old enough to have settled, group each
by submission date, and compute what fraction of the cohort's present-day total
had arrived by each lag. Averaging across cohorts gives the curve.

The curve is a **lower bound** on the true lag: a cohort's denominator is what
has arrived so far, and even old cohorts still gain sequences. Treat the
recommended cutoff as the least conservative one defensible.
"""
from __future__ import annotations

import argparse
import sys
from datetime import date, timedelta

from lapis_client import (
    LapisError,
    aggregated,
    data_version,
    describe_instance,
    emit,
    pick_date_field,
    range_keys,
    resolve_base_url,
)

COLUMNS = ("lag_days", "mean_complete", "min_complete", "max_complete", "cohorts")
OFFSETS = (7, 14, 21, 30, 45, 60, 90, 120, 180)


def month_window(anchor: date, months_back: int) -> tuple[date, date]:
    """First and last day of the month ``months_back`` before ``anchor``."""
    total = anchor.year * 12 + (anchor.month - 1) - months_back
    year, month = divmod(total, 12)
    first = date(year, month + 1, 1)
    nxt = date(year + 1, 1, 1) if month == 11 else date(year, month + 2, 1)
    return first, nxt - timedelta(days=1)


def cohort_curve(
    base_url: str,
    filters: dict,
    submission_field: str,
    cohort_end: date,
) -> tuple[dict[int, float], int, int] | None:
    """Cumulative completeness by lag for one collection cohort.

    Returns ``(curve, dated, undated)``. Sequences with no parseable submission
    date are excluded from the denominator rather than counted as never having
    arrived — the question is "of the ones we can date, how fast did they come"
    — but they are returned so the caller can say how many were set aside.
    """
    rows = aggregated(base_url, filters, [submission_field])
    lags: list[tuple[int, int]] = []
    dated = 0
    undated = 0
    for row in rows:
        value = str(row.get(submission_field) or "")
        n = int(row.get("count") or 0)
        try:
            submitted = date.fromisoformat(value[:10])
        except ValueError:
            undated += n
            continue
        lags.append((max(0, (submitted - cohort_end).days), n))
        dated += n
    if dated == 0:
        return None
    lags.sort()
    curve: dict[int, float] = {}
    for offset in OFFSETS:
        arrived = sum(n for lag, n in lags if lag <= offset)
        curve[offset] = arrived / dated
    return curve, dated, undated


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Measure sequence reporting lag and recommend a trust cutoff.",
    )
    parser.add_argument("--instance", default="sars-cov-2", help="registry name (default: sars-cov-2)")
    parser.add_argument("--base-url", help="any other LAPIS deployment")
    parser.add_argument("--date-field", help="override the auto-detected collection-date column")
    parser.add_argument("--submission-field", help="override the auto-detected submission-date column")
    parser.add_argument("--where", action="append", default=[], metavar="KEY=VALUE",
                        help="extra filter, repeatable (lag differs sharply by country)")
    parser.add_argument("--cohorts", type=int, default=6, help="monthly cohorts to average (default: 6)")
    parser.add_argument("--skip-months", type=int, default=3,
                        help="most recent months to exclude as unsettled (default: 3)")
    parser.add_argument("--target", type=float, default=0.9,
                        help="completeness the cutoff should reach (default: 0.9)")
    parser.add_argument("--until", help="anchor date, YYYY-MM-DD (default: today)")
    parser.add_argument("--format", choices=("table", "tsv", "json"), default="table")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    try:
        base_url = resolve_base_url(args.instance, args.base_url)
        schema = describe_instance(base_url)
        collection_field = pick_date_field(schema, "collection", args.date_field)
        submission_field = pick_date_field(schema, "submission", args.submission_field)
        if collection_field == submission_field:
            raise LapisError(
                f"collection and submission both resolved to {collection_field!r}; "
                "the lag would be identically zero. Set --submission-field explicitly."
            )
        where: dict[str, str] = {}
        for pair in args.where:
            key, sep, value = pair.partition("=")
            if not sep or key.split(".")[0] not in schema["types"]:
                raise LapisError(f"bad --where {pair!r}")
            where[key] = value
    except LapisError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    anchor = date.fromisoformat(args.until) if args.until else date.today()
    from_key, to_key = range_keys(collection_field)

    curves: list[dict[int, float]] = []
    sizes: list[int] = []
    undated_total = 0
    try:
        for back in range(args.skip_months, args.skip_months + max(1, args.cohorts)):
            start, end = month_window(anchor, back)
            result = cohort_curve(
                base_url,
                {from_key: start.isoformat(), to_key: end.isoformat(), **where},
                submission_field,
                end,
            )
            if result:
                curve, dated, undated = result
                curves.append(curve)
                sizes.append(dated)
                undated_total += undated
    except LapisError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if not curves:
        print(
            "error: no cohort in the requested range holds any sequence. "
            "Widen --where, raise --cohorts, or lower --skip-months.",
            file=sys.stderr,
        )
        return 1

    rows = []
    for offset in OFFSETS:
        values = [c[offset] for c in curves]
        rows.append(
            {
                "lag_days": offset,
                "mean_complete": f"{sum(values) / len(values):.3f}",
                "min_complete": f"{min(values):.3f}",
                "max_complete": f"{max(values):.3f}",
                "cohorts": len(values),
            }
        )

    reached = [o for o in OFFSETS if sum(c[o] for c in curves) / len(curves) >= args.target]
    print(emit(rows, COLUMNS, args.format))

    sys.stdout.flush()
    if args.format != "json":
        print(
            f"\n# {schema['name']} via {base_url} | data version {data_version(base_url)}"
            f"\n# collection dates from {collection_field}, submission from {submission_field}"
            f"\n# {len(curves)} monthly cohorts, {sum(sizes)} datable sequences"
            + (f" ({undated_total} excluded for having no submission date)"
               if undated_total else "")
            + (f" | filters {where}" if where else ""),
            file=sys.stderr,
        )
        if reached:
            cutoff = anchor - timedelta(days=reached[0])
            print(
                f"# {args.target:.0%} of a cohort has arrived by {reached[0]} days.\n"
                f"# Trust collection dates up to {cutoff.isoformat()}; treat anything "
                f"later as provisional.",
                file=sys.stderr,
            )
        else:
            print(
                f"# no lag up to {OFFSETS[-1]} days reaches {args.target:.0%} completeness "
                f"(best {max(sum(c[o] for c in curves) / len(curves) for o in OFFSETS):.0%}). "
                f"Recent weeks cannot support a prevalence estimate here.",
                file=sys.stderr,
            )
        print(
            "# This curve is a lower bound: cohort denominators are still growing.",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
