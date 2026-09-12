#!/usr/bin/env python3
"""RELSA (RELative Severity Assessment) score — a faithful Python port.

Implements the four-step procedure of Talbot et al. (2022), Front. Vet. Sci.
9:937711, as coded in the R package ``mytalbot/RELSA``:

1. directionality — variables that *rise* under duress are "turned";
2. normalization — each variable divided by that animal's own baseline (100%);
3. reference set — the cohort of assumed greatest burden fixes the scale;
4. weights and score — per-variable deviation relative to the reference
   maximum, combined by a root-mean-square:

       delta_i(t)  = 100 - x_i(t)            (turned: x_i(t) - 100), floored at 0
       RW_i(t)     = delta_i(t) / |100 - max_i,ref|
       RELSA(t)    = sqrt( mean_i RW_i(t)^2 )   over non-missing i

RELSA = 0 means "at baseline"; RELSA = 1 means the animal reached the reference
set's maximum deviation; above 1 means it exceeded it. Missing variables are
dropped from the mean rather than imputed, so a score is defined whenever at
least one variable was measured.

Numerically reproduces the R package's published worked example (surgery
dataset, animal Ca_001) to the two decimals the package prints; see
``tests/relsa-severity-assessment/``.
"""

from __future__ import annotations

import argparse
import json
import sys
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from typing import Sequence

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _common import (  # noqa: E402
    ID_COL,
    TIME_COL,
    RelsaDataError,
    parse_list,
    percent_of_baseline,
    read_relsa_table,
    score_to_percent,
    validate,
    variable_columns,
)

BASELINE_PCT = 100.0


# --------------------------------------------------------------------------- #
# reference model
# --------------------------------------------------------------------------- #
@dataclass
class ReferenceModel:
    """The severity scale RELSA scores are relative to.

    ``maxsev`` is the most extreme normalized value each variable reached
    anywhere in the reference cohort (minimum, or maximum for turned
    variables); ``maxdelta`` is its distance from baseline, the denominator of
    every weight. A RELSA score is only interpretable together with the
    reference set that produced it, so record ``label`` in any report.
    """

    variables: tuple[str, ...]
    turned: tuple[str, ...]
    maxsev: dict[str, float]
    maxdelta: dict[str, float]
    n_animals: int
    n_rows: int
    label: str = ""
    baseline_time: float | list[float] | None = None
    notes: dict[str, str] = field(default_factory=dict)

    def to_json(self, path: str | Path) -> None:
        payload = {
            "variables": list(self.variables),
            "turned": list(self.turned),
            "maxsev": self.maxsev,
            "maxdelta": self.maxdelta,
            "n_animals": self.n_animals,
            "n_rows": self.n_rows,
            "label": self.label,
            "baseline_time": self.baseline_time,
            "notes": self.notes,
        }
        Path(path).write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")

    @classmethod
    def from_json(cls, path: str | Path) -> "ReferenceModel":
        payload = json.loads(Path(path).read_text())
        return cls(
            variables=tuple(payload["variables"]),
            turned=tuple(payload["turned"]),
            maxsev={k: float(v) for k, v in payload["maxsev"].items()},
            maxdelta={k: float(v) for k, v in payload["maxdelta"].items()},
            n_animals=int(payload["n_animals"]),
            n_rows=int(payload["n_rows"]),
            label=payload.get("label", ""),
            baseline_time=payload.get("baseline_time"),
            notes=payload.get("notes", {}),
        )

    def describe(self) -> str:
        rows = [
            f"reference model: {self.label or '(unlabelled)'}",
            f"  animals={self.n_animals}  rows={self.n_rows}  "
            f"baseline_time={self.baseline_time}",
            f"  {'variable':<12}{'turned':>8}{'max reached':>14}{'max delta':>12}",
        ]
        for var in self.variables:
            rows.append(
                f"  {var:<12}{'yes' if var in self.turned else 'no':>8}"
                f"{self.maxsev[var]:>14.2f}{self.maxdelta[var]:>12.2f}"
            )
        return "\n".join(rows)


def build_reference(
    frame: pd.DataFrame,
    variables: Sequence[str],
    turned: Sequence[str] = (),
    baseline_time: float | Sequence[float] | None = None,
    label: str = "",
) -> ReferenceModel:
    """Derive the reference scale from an already-normalized cohort.

    ``frame`` must be on the percent scale (baseline = 100) — run
    ``prepare`` or ``_common.percent_of_baseline`` first. ``turned`` names the
    variables whose *increase* signals worsening.
    """
    variables = list(variables)
    turned = [t for t in turned if t in variables]
    validate(frame, variables)

    maxsev: dict[str, float] = {}
    maxdelta: dict[str, float] = {}
    degenerate: list[str] = []
    for var in variables:
        col = pd.to_numeric(frame[var], errors="coerce").to_numpy(dtype=float)
        if not np.isfinite(col).any():
            raise RelsaDataError(
                f"variable {var!r} has no finite values in the reference set"
            )
        extreme = float(np.nanmax(col)) if var in turned else float(np.nanmin(col))
        maxsev[var] = extreme
        maxdelta[var] = abs(BASELINE_PCT - extreme)
        if maxdelta[var] == 0:
            degenerate.append(var)

    if degenerate:
        raise RelsaDataError(
            f"variables {degenerate} never deviate from baseline in the reference "
            "set, so their weight would divide by zero. Drop them, or choose a "
            "reference cohort that actually expresses the burden (the published "
            "models use the treatment group of assumed greatest severity)."
        )

    wrong_way = [
        v for v in variables if (maxsev[v] > BASELINE_PCT) != (v in turned)
    ]
    if wrong_way:
        warnings.warn(
            f"variables {wrong_way} deviate in the opposite direction to their "
            "declared directionality — check the `turned` list. A variable that "
            "only ever rises must be turned; one that only falls must not be.",
            stacklevel=2,
        )

    return ReferenceModel(
        variables=tuple(variables),
        turned=tuple(turned),
        maxsev=maxsev,
        maxdelta=maxdelta,
        n_animals=int(frame[ID_COL].nunique()),
        n_rows=int(len(frame)),
        label=label,
        baseline_time=(
            None
            if baseline_time is None
            else (float(baseline_time) if np.isscalar(baseline_time) else [float(t) for t in baseline_time])  # type: ignore[arg-type]
        ),
    )


# --------------------------------------------------------------------------- #
# score
# --------------------------------------------------------------------------- #
def relsa_weights(
    frame: pd.DataFrame,
    reference: ReferenceModel,
    drop: Sequence[str] = (),
    round_digits: int | None = 2,
) -> pd.DataFrame:
    """Per-variable RELSA weights (RW) for every animal and time point.

    Rounding to two decimals is the R package's behaviour and is applied to the
    deltas and to the weights, before the root-mean-square. Pass
    ``round_digits=None`` for full precision (scores then differ from R in the
    third decimal).
    """
    used = [v for v in reference.variables if v not in set(drop)]
    if not used:
        raise RelsaDataError("every reference variable was dropped")
    missing = [v for v in used if v not in frame.columns]
    if missing:
        raise RelsaDataError(
            f"variables {missing} are in the reference model but not in the data. "
            "The test set must carry the same variable names as the reference."
        )
    validate(frame, used)

    out = frame[[ID_COL, TIME_COL]].copy()
    for var in used:
        values = pd.to_numeric(frame[var], errors="coerce").to_numpy(dtype=float)
        delta = (
            values - BASELINE_PCT if var in reference.turned else BASELINE_PCT - values
        )
        delta = np.where(np.isfinite(delta), np.clip(delta, 0.0, None), np.nan)
        if round_digits is not None:
            delta = np.round(delta, round_digits)
        weight = delta / reference.maxdelta[var]
        if round_digits is not None:
            weight = np.round(weight, round_digits)
        out[var] = weight
    return out


def _warn_on_composition_change(scored: pd.DataFrame, used: Sequence[str]) -> None:
    """Warn when the set of available variables changes along an animal's trajectory.

    RELSA averages over whichever variables were measured, so a variable that
    appears or disappears mid-trajectory moves the score even when the animal's
    state is unchanged. In the published sepsis data, body weight is recorded
    only on the day of euthanasia; including it drops that animal's endpoint
    score from 0.93 to 0.83 purely by changing the mean's composition. Score the
    variables that are measured throughout, and keep the rest as separate
    endpoint criteria.
    """
    offenders: list[str] = []
    for animal, block in scored.groupby(ID_COL, sort=False):
        present = block[list(used)].notna()
        signatures = {tuple(row) for row in present.itertuples(index=False)}
        signatures.discard(tuple([False] * len(used)))  # fully missing rows are fine
        if len(signatures) > 1:
            varying = [
                var for var in used if present[var].nunique(dropna=False) > 1
            ]
            offenders.append(f"{animal}: {', '.join(varying)}")
    if offenders:
        warnings.warn(
            "the set of measured variables changes across time points, so RELSA "
            "scores along these trajectories are not strictly comparable — a "
            "variable appearing or disappearing shifts the score by itself: "
            + "; ".join(offenders[:5])
            + ("..." if len(offenders) > 5 else ""),
            stacklevel=3,
        )


def relsa_scores(
    frame: pd.DataFrame,
    reference: ReferenceModel,
    drop: Sequence[str] = (),
    round_digits: int | None = 2,
    keep_meta: bool = True,
) -> pd.DataFrame:
    """RELSA score per animal per time point, with the weights that produced it.

    Returns ``id``, ``time``, any metadata columns, one column per variable
    holding its weight, ``n_vars`` (variables available at that time point), and
    ``relsa``. Rows where every variable is missing get ``relsa = NaN``.
    """
    weights = relsa_weights(frame, reference, drop=drop, round_digits=round_digits)
    used = [c for c in weights.columns if c not in (ID_COL, TIME_COL)]

    matrix = weights[used].to_numpy(dtype=float)
    available = np.isfinite(matrix).sum(axis=1)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean_square = np.nansum(matrix**2, axis=1) / available
    score = np.sqrt(mean_square)
    score = np.where(available == 0, np.nan, score)
    if round_digits is not None:
        score = np.round(score, round_digits)

    out = weights.copy()
    out["n_vars"] = available
    out["relsa"] = score

    _warn_on_composition_change(out, used)

    if keep_meta:
        meta = [c for c in ("treatment", "condition") if c in frame.columns]
        if meta:
            labels = frame[[ID_COL, TIME_COL, *meta]]
            out = out.merge(labels, on=[ID_COL, TIME_COL], how="left")
            order = [ID_COL, TIME_COL, *meta, *used, "n_vars", "relsa"]
            out = out[order]
    return out


def prepare(
    frame: pd.DataFrame,
    normalize: Sequence[str] = (),
    baseline_time: float | Sequence[float] | None = None,
) -> pd.DataFrame:
    """Normalize the named variables to each animal's own baseline (= 100%).

    Variables *not* named are left untouched — that is the RELSA convention and
    it matters: body-weight change (bwc) and scores mapped with
    ``score_to_percent`` already sit on the percent scale, and normalizing them
    twice silently flattens them.
    """
    if not normalize:
        return frame.copy()
    return percent_of_baseline(frame, list(normalize), baseline_time=baseline_time)


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def _filter_group(frame: pd.DataFrame, pairs: Sequence[str]) -> pd.DataFrame:
    for pair in pairs:
        if "=" not in pair:
            raise SystemExit(f"--reference-group expects col=value, got {pair!r}")
        col, value = pair.split("=", 1)
        if col not in frame.columns:
            raise SystemExit(f"--reference-group column {col!r} not in data")
        frame = frame[frame[col].astype(str) == value]
        if frame.empty:
            raise SystemExit(f"--reference-group {pair!r} selected no rows")
    return frame


def _parse_score_scale(spec: str, frame: pd.DataFrame) -> tuple[str, tuple[float, float]]:
    """Parse ``COL=MAX`` or ``COL=MAX:BASELINE`` from --score-scale."""
    if "=" not in spec:
        raise SystemExit(f"--score-scale expects COL=MAX[:BASELINE], got {spec!r}")
    column, bounds = spec.split("=", 1)
    if column not in frame.columns:
        raise SystemExit(f"--score-scale column {column!r} not in data")
    parts = bounds.split(":")
    try:
        max_score = float(parts[0])
        baseline = float(parts[1]) if len(parts) > 1 else 0.0
    except ValueError:
        raise SystemExit(f"--score-scale bounds must be numeric, got {bounds!r}") from None
    return column, (max_score, baseline)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Compute RELSA severity scores for a RELSA-format table.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("data", help="CSV/TSV in RELSA long format (id, time, variables)")
    parser.add_argument(
        "--variables",
        help="comma-separated variables to score (default: every measurement column)",
    )
    parser.add_argument(
        "--turned",
        help="comma-separated variables that RISE under worsening severity "
        "(clinical scores, biomarkers, fever, tachycardia)",
    )
    parser.add_argument(
        "--normalize",
        help="comma-separated variables to divide by their own baseline; omit any "
        "variable already on a percent scale (bwc, mapped scores)",
    )
    parser.add_argument(
        "--score-scale",
        action="append",
        default=[],
        metavar="COL=MAX[:BASELINE]",
        help="map an ordinal severity score onto the percent scale, where MAX is "
        "the worst possible score and BASELINE the healthy one (default 0). "
        "Required for scores whose baseline is 0, which cannot be ratio-normalized. "
        "Implies the variable is turned and not normalized. Repeatable.",
    )
    parser.add_argument(
        "--baseline-time",
        help="time value(s) defining the baseline, comma-separated to average a "
        "window (default: each animal's first time point)",
    )
    parser.add_argument(
        "--reference-group",
        action="append",
        default=[],
        metavar="COL=VALUE",
        help="restrict the reference set, repeatable (e.g. treatment=CLP)",
    )
    parser.add_argument(
        "--reference-data",
        help="separate table for the reference set (default: the same file)",
    )
    parser.add_argument(
        "--load-reference", help="reuse a reference model saved by --save-reference"
    )
    parser.add_argument("--save-reference", help="write the reference model to JSON")
    parser.add_argument("--drop", help="comma-separated variables to exclude from scoring")
    parser.add_argument(
        "--full-precision",
        action="store_true",
        help="skip the 2-decimal rounding the R package applies",
    )
    parser.add_argument("--out", help="write scores to this CSV (default: stdout)")
    parser.add_argument("--id-col", default=ID_COL)
    parser.add_argument("--time-col", help="name of the time column, if not auto-detected")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    digits = None if args.full_precision else 2

    frame = read_relsa_table(args.data, id_col=args.id_col, time_col=args.time_col)
    normalize = parse_list(args.normalize)
    turned = parse_list(args.turned)
    variables = parse_list(args.variables) or variable_columns(frame)

    for spec in args.score_scale:
        column, bounds = _parse_score_scale(spec, frame)
        frame[column] = score_to_percent(frame[column], *bounds)
        if column not in turned:
            turned.append(column)
        if column in normalize:
            normalize.remove(column)
            print(
                f"note: {column} is mapped by --score-scale, so it is not "
                "baseline-normalized as well",
                file=sys.stderr,
            )
        if column not in variables:
            variables.append(column)

    baseline_time: float | list[float] | None = None
    if args.baseline_time:
        times = [float(t) for t in parse_list(args.baseline_time)]
        baseline_time = times[0] if len(times) == 1 else times

    prepared = prepare(frame, normalize=normalize, baseline_time=baseline_time)

    if args.load_reference:
        reference = ReferenceModel.from_json(args.load_reference)
    else:
        if args.reference_data:
            ref_raw = read_relsa_table(
                args.reference_data, id_col=args.id_col, time_col=args.time_col
            )
            ref_frame = prepare(ref_raw, normalize=normalize, baseline_time=baseline_time)
        else:
            ref_frame = prepared
        ref_frame = _filter_group(ref_frame, args.reference_group)
        label = args.reference_data or args.data
        if args.reference_group:
            label = f"{label} [{', '.join(args.reference_group)}]"
        reference = build_reference(
            ref_frame,
            variables=variables,
            turned=turned,
            baseline_time=baseline_time,
            label=label,
        )
    if args.save_reference:
        reference.to_json(args.save_reference)

    print(reference.describe(), file=sys.stderr)

    scores = relsa_scores(
        prepared, reference, drop=parse_list(args.drop), round_digits=digits
    )
    if args.out:
        scores.to_csv(args.out, index=False)
        print(f"wrote {len(scores)} rows to {args.out}", file=sys.stderr)
    else:
        scores.to_csv(sys.stdout, index=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
