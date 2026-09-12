#!/usr/bin/env python3
"""Allometric scaling, maturation, and first-in-human starting dose.

Two different jobs share this script because they share a failure mode: taking
a number derived for one purpose and using it for another. An HED is not a
starting dose. A NOAEL-derived MRSD is not appropriate for an agonist
immunomodulator. Allometry with a fixed 0.75 exponent describes clearance in
adults and is wrong in neonates unless maturation is modelled separately.

    python3 allometry_and_fih.py --scale --cl 5 --weight-from 70 --weight-to 15
    python3 allometry_and_fih.py --scale --cl 5 --weight-from 70 --weight-to 6 --pma-weeks 44
    python3 allometry_and_fih.py --exponent -i species.csv
    python3 allometry_and_fih.py --fih --noael rat=50,dog=10 --safety-factor 10 --human-weight 60
    python3 allometry_and_fih.py --mabel --ec50 2.5 --target-occupancy 0.2 --cl 0.2 --weight 70

``--exponent`` input is a table of ``species,weight,cl`` for cross-species
regression.
"""

from __future__ import annotations

import argparse
import math
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

# FDA, "Estimating the Maximum Safe Starting Dose in Initial Clinical Trials
# for Therapeutics in Adult Healthy Volunteers" (July 2005), Table 1. Km is the
# body-weight-to-surface-area factor; HED in mg/kg = animal mg/kg * Km_animal /
# Km_human.
KM_FACTORS = {
    "human-adult": (60.0, 37.0),
    "human-child": (20.0, 25.0),
    "mouse": (0.020, 3.0),
    "hamster": (0.080, 5.0),
    "rat": (0.150, 6.0),
    "ferret": (0.300, 7.0),
    "guinea-pig": (0.400, 8.0),
    "rabbit": (1.8, 12.0),
    "dog": (10.0, 20.0),
    "monkey": (3.0, 12.0),
    "marmoset": (0.350, 6.0),
    "squirrel-monkey": (0.600, 7.0),
    "baboon": (12.0, 20.0),
    "micro-pig": (20.0, 27.0),
    "mini-pig": (40.0, 35.0),
}

# Anderson & Holford sigmoidal maturation on post-menstrual age. The defaults
# are the widely used generic clearance values; a drug with a known
# ontogeny profile should override them.
DEFAULT_TM50_WEEKS = 54.2
DEFAULT_MATURATION_HILL = 3.92


def maturation_fraction(pma_weeks: float, tm50: float = DEFAULT_TM50_WEEKS, hill: float = DEFAULT_MATURATION_HILL) -> float:
    """Fraction of adult clearance attributable to enzyme maturation."""
    if pma_weeks <= 0:
        raise InputError("post-menstrual age must be positive")
    return pma_weeks**hill / (tm50**hill + pma_weeks**hill)


def allometric(value: float, weight_from: float, weight_to: float, exponent: float) -> float:
    return value * (weight_to / weight_from) ** exponent


def hed_mg_per_kg(animal_dose_mg_kg: float, species: str) -> float:
    if species not in KM_FACTORS:
        raise InputError(f"unknown species {species!r}; known: {', '.join(sorted(KM_FACTORS))}")
    _, km_animal = KM_FACTORS[species]
    _, km_human = KM_FACTORS["human-adult"]
    return animal_dose_mg_kg * km_animal / km_human


# ---------------------------------------------------------------- exponent


def fit_exponent(weights: np.ndarray, values: np.ndarray) -> dict[str, float]:
    """Log-log regression of a parameter on body weight across species."""
    if len(weights) < 3:
        raise InputError("cross-species regression needs at least 3 species")
    x = np.log(weights)
    y = np.log(values)
    n = len(x)
    slope, intercept = np.polyfit(x, y, 1)
    fitted = intercept + slope * x
    ss_res = float(np.sum((y - fitted) ** 2))
    ss_tot = float(np.sum((y - y.mean()) ** 2))
    se_slope = math.sqrt(ss_res / (n - 2) / float(np.sum((x - x.mean()) ** 2))) if n > 2 else float("nan")
    return {
        "exponent": float(slope),
        "coefficient": float(math.exp(intercept)),
        "se_exponent": se_slope,
        "ci95_low": float(slope - 1.96 * se_slope),
        "ci95_high": float(slope + 1.96 * se_slope),
        "r2": 1.0 - ss_res / ss_tot if ss_tot > 0 else float("nan"),
        "n_species": n,
    }


def rule_of_exponents(exponent: float) -> str:
    """Mahmood & Balian's rule of exponents, stated with its own caveat."""
    if exponent < 0.55:
        return "below 0.55: simple allometry is unreliable; human clearance is likely overpredicted"
    if exponent <= 0.70:
        return "0.55-0.70: simple allometry"
    if exponent <= 1.00:
        return "0.71-1.00: apply the maximum-life-span-potential correction"
    return "above 1.00: apply the brain-weight correction; predictions are poor in this range"


# --------------------------------------------------------------------- CLI


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Allometric scaling, paediatric maturation, and first-in-human dose estimation.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    mode = parser.add_argument_group("mode (choose one)")
    mode.add_argument("--scale", action="store_true", help="scale parameters between two body weights")
    mode.add_argument("--exponent", action="store_true", help="estimate the allometric exponent from species data")
    mode.add_argument("--fih", action="store_true", help="NOAEL-based human equivalent dose and MRSD")
    mode.add_argument("--mabel", action="store_true", help="minimum anticipated biological effect level")

    parser.add_argument("-i", "--input", help="species table for --exponent (species,weight,cl)")
    parser.add_argument("--cl", type=float, help="clearance at the reference weight")
    parser.add_argument("--volume", type=float, help="volume at the reference weight")
    parser.add_argument("--weight-from", type=float, default=70.0, help="reference weight, kg (default: 70)")
    parser.add_argument("--weight-to", type=float, help="target weight, kg")
    parser.add_argument("--cl-exponent", type=float, default=0.75)
    parser.add_argument("--v-exponent", type=float, default=1.0)
    parser.add_argument("--pma-weeks", type=float, help="post-menstrual age; adds a maturation factor")
    parser.add_argument("--tm50", type=float, default=DEFAULT_TM50_WEEKS)
    parser.add_argument("--maturation-hill", type=float, default=DEFAULT_MATURATION_HILL)

    parser.add_argument("--noael", help="comma-separated species=mg/kg, e.g. rat=50,dog=10")
    parser.add_argument("--safety-factor", type=float, default=10.0)
    parser.add_argument("--human-weight", type=float, default=60.0, help="kg, for converting MRSD to a total dose")

    parser.add_argument("--ec50", type=float, help="in vitro potency (same units as the target concentration)")
    parser.add_argument("--target-occupancy", type=float, default=0.10, help="fraction of target engagement to aim for")
    parser.add_argument("--weight", type=float, default=70.0)
    parser.add_argument("--mabel-safety-factor", type=float, default=1.0)
    add_format_argument(parser)
    return parser


def run(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    chosen = [m for m in ("scale", "exponent", "fih", "mabel") if getattr(args, m)]
    if len(chosen) != 1:
        raise InputError("choose exactly one of --scale, --exponent, --fih, --mabel")
    report = Report()

    if args.scale:
        if args.weight_to is None:
            raise InputError("--scale needs --weight-to")
        if args.cl is None and args.volume is None:
            raise InputError("--scale needs --cl and/or --volume")
        rows = []
        maturation = maturation_fraction(args.pma_weeks, args.tm50, args.maturation_hill) if args.pma_weeks else 1.0
        if args.cl is not None:
            size_only = allometric(args.cl, args.weight_from, args.weight_to, args.cl_exponent)
            rows.append(
                {
                    "parameter": "CL",
                    "reference": args.cl,
                    "exponent": args.cl_exponent,
                    "size_scaled": size_only,
                    "maturation_factor": maturation,
                    "final": size_only * maturation,
                }
            )
        if args.volume is not None:
            size_only = allometric(args.volume, args.weight_from, args.weight_to, args.v_exponent)
            rows.append(
                {
                    "parameter": "V",
                    "reference": args.volume,
                    "exponent": args.v_exponent,
                    "size_scaled": size_only,
                    "maturation_factor": 1.0,
                    "final": size_only,
                }
            )
        report.table(f"scaled from {args.weight_from} kg to {args.weight_to} kg", rows)
        report.note("volume is not matured: maturation describes eliminating capacity, not distribution space")
        if args.pma_weeks:
            report.scalar("post_menstrual_age_weeks", args.pma_weeks)
            report.scalar("maturation_fraction_of_adult_cl", maturation)
            report.note(
                f"maturation uses TM50 = {args.tm50} weeks PMA and Hill = {args.maturation_hill} "
                "(Anderson & Holford). These are generic clearance values; substitute drug-specific "
                "ontogeny where it is known, because the difference in a neonate is several-fold."
            )
        else:
            if args.weight_to < 20:
                report.finding(
                    "scaling to a body weight below 20 kg with size alone. Below roughly 2 years of age, "
                    "clearance is limited by enzyme and renal maturation, not by size; supply --pma-weeks "
                    "or the prediction will overestimate clearance, in a neonate by several fold."
                )
        report.note("allometry is a covariate model for size, not evidence of a mechanism")

    elif args.exponent:
        if not args.input:
            raise InputError("--exponent needs -i with columns species,weight,cl")
        rows = read_table(args.input)
        require_columns(rows, ["weight", "cl"], str(args.input))
        weights = np.asarray([parse_float(r["weight"], "weight") for r in rows], dtype=float)
        values = np.asarray([parse_float(r["cl"], "cl") for r in rows], dtype=float)
        if np.any(weights <= 0) or np.any(values <= 0):
            raise InputError("weights and clearances must be positive")
        fit = fit_exponent(weights, values)
        for key, value in fit.items():
            report.scalar(key, value)
        report.scalar("rule_of_exponents", rule_of_exponents(fit["exponent"]))
        report.table(
            "observed vs fitted",
            [
                {
                    "species": r.get("species", f"#{i + 1}"),
                    "weight_kg": w,
                    "cl_observed": v,
                    "cl_fitted": fit["coefficient"] * w ** fit["exponent"],
                    "fold_error": (fit["coefficient"] * w ** fit["exponent"]) / v,
                }
                for i, (r, w, v) in enumerate(zip(rows, weights, values))
            ],
        )
        if fit["n_species"] < 4:
            report.finding(
                f"exponent estimated from {fit['n_species']} species; the confidence interval "
                f"({fit['ci95_low']:.2f} to {fit['ci95_high']:.2f}) is too wide to distinguish 0.75 from "
                "most alternatives"
            )
        if not (fit["ci95_low"] <= 0.75 <= fit["ci95_high"]):
            report.note("the 95% interval excludes 0.75; a fixed-exponent model would be misspecified here")
        report.note(
            "Cross-species allometry predicts human clearance within 2-fold about half the time. Treat "
            "it as one input to the starting dose, never as the sole basis."
        )

    elif args.fih:
        if not args.noael:
            raise InputError("--fih needs --noael, e.g. --noael rat=50,dog=10")
        entries = []
        for chunk in args.noael.split(","):
            if "=" not in chunk:
                raise InputError(f"--noael entries look like species=mg/kg; got {chunk!r}")
            species, dose_text = chunk.split("=", 1)
            species = species.strip().lower()
            dose = parse_float(dose_text, f"NOAEL for {species}")
            if dose is None or dose <= 0:
                raise InputError(f"NOAEL for {species} must be positive")
            hed = hed_mg_per_kg(dose, species)
            weight, km = KM_FACTORS[species]
            entries.append(
                {
                    "species": species,
                    "noael_mg_kg": dose,
                    "reference_weight_kg": weight,
                    "km": km,
                    "divide_by": KM_FACTORS["human-adult"][1] / km,
                    "hed_mg_kg": hed,
                }
            )
        report.table("human equivalent dose by species", entries)
        most_sensitive = min(entries, key=lambda e: e["hed_mg_kg"])
        mrsd = most_sensitive["hed_mg_kg"] / args.safety_factor
        report.scalar("most_sensitive_species", most_sensitive["species"])
        report.scalar("lowest_hed_mg_kg", most_sensitive["hed_mg_kg"])
        report.scalar("safety_factor", args.safety_factor)
        report.scalar("mrsd_mg_kg", mrsd)
        report.scalar("mrsd_total_mg", mrsd * args.human_weight)
        report.note(
            "HED conversion uses body-surface-area scaling from FDA's 2005 maximum-safe-starting-dose "
            "guidance, Table 1. It applies to small molecules; for biologics whose clearance is not "
            "surface-area-related, mg/kg or exposure matching is generally more appropriate."
        )
        report.note(
            "The most sensitive species is used unless there is a justified reason to prefer another - "
            "for example a species known not to be pharmacologically responsive."
        )
        if args.safety_factor < 10:
            report.finding(
                f"safety factor of {args.safety_factor} is below the default 10; a reduction has to be "
                "justified, and an increase is expected for steep dose-response, irreversible toxicity, "
                "novel targets, or nonlinear PK"
            )
        report.finding(
            "MRSD from a NOAEL is not appropriate on its own for agonist immunomodulators or other "
            "agents with a plausible risk of severe on-target toxicity - compute MABEL as well and take "
            "the lower value"
        )

    else:  # --mabel
        if args.ec50 is None:
            raise InputError("--mabel needs --ec50")
        if not 0 < args.target_occupancy < 1:
            raise InputError("--target-occupancy must be between 0 and 1")
        if args.cl is None:
            raise InputError("--mabel needs --cl to convert a target concentration into a dose")
        target_conc = args.ec50 * args.target_occupancy / (1.0 - args.target_occupancy)
        # Steady-state-equivalent dose to reach the target average concentration.
        dose_rate = target_conc * args.cl
        report.scalar("ec50", args.ec50)
        report.scalar("target_receptor_occupancy", args.target_occupancy)
        report.scalar("target_concentration", target_conc)
        report.scalar("clearance", args.cl)
        report.scalar("dose_rate_for_target_concentration", dose_rate)
        report.scalar("dose_rate_with_safety_factor", dose_rate / args.mabel_safety_factor)
        report.note(
            "MABEL derives the starting dose from the lowest exposure expected to produce any biological "
            "effect, using in vitro potency in human cells plus target expression - not from the NOAEL. "
            "It became the expected approach for agonist immunomodulators after TGN1412."
        )
        report.note(
            "The occupancy-to-concentration step assumes simple 1:1 binding at equilibrium and no "
            "target-mediated disposition. For a drug with appreciable TMDD, occupancy at a given free "
            "concentration is not a fixed function and this calculation understates the dose needed."
        )
        report.finding(
            "MABEL requires human-cell in vitro potency, target expression in the relevant tissue, and "
            "a defined concentration-occupancy relationship. Confirm all three are drug-specific before "
            "using this number."
        )

    return report.emit(args.format)


if __name__ == "__main__":
    raise SystemExit(main_wrapper(run))
