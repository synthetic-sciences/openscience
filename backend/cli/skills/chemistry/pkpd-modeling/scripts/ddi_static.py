#!/usr/bin/env python3
"""Drug-drug interaction prediction: ICH M12 basic models and the mechanistic static model.

ICH M12 (Step 4, 2024) sets out a stepwise risk assessment: in vitro data feed
basic models whose cut-offs decide whether a clinical study is needed, and a
mechanistic static or PBPK model can be used to refine a positive basic-model
signal. The basic models are deliberately conservative — they are designed to
over-predict, so a negative result is meaningful and a positive one is only a
trigger for further work.

    python3 ddi_static.py --basic --ki 0.5 --imax 2.0 --fu 0.05 --dose 100
    python3 ddi_static.py --basic --tdi --ki-inact 1.2 --kinact 0.04 --imax 2.0 --fu 0.05
    python3 ddi_static.py --msm --ki 0.5 --imax 2.0 --fu 0.05 --dose 100 --fm 0.9 --fg 0.7

All concentrations are in the same molar or mass units as Ki, KI and EC50. The
script does not know your units and cannot check them; a Ki in micromolar
against an Imax in ng/mL is a silent, and common, error.
"""

from __future__ import annotations

import argparse
from typing import Sequence

from _common import InputError, Report, add_format_argument, main_wrapper

# ICH M12 basic-model cut-offs.
CUTOFF_R1_HEPATIC = 1.02
CUTOFF_R1_GUT = 11.0
CUTOFF_R2_TDI = 1.25
CUTOFF_R3_INDUCTION = 0.80
CUTOFF_TRANSPORTER_HEPATIC_UPTAKE = 1.1
CUTOFF_TRANSPORTER_INTESTINAL = 10.0
CUTOFF_TRANSPORTER_RENAL = 0.1

# Default intestinal dissolution volume used to form the nominal gut
# concentration, and the hepatic blood flow used for the inlet concentration.
GUT_VOLUME_ML = 250.0
HEPATIC_BLOOD_FLOW_L_H = 97.0
DEFAULT_KDEG_HEPATIC = 0.0005  # per minute; roughly a 23 h enzyme half-life


def r1_reversible(i_conc: float, ki: float) -> float:
    """Basic reversible inhibition ratio, ``1 + [I]/Ki``."""
    if ki <= 0:
        raise InputError("Ki must be positive")
    return 1.0 + i_conc / ki


def r2_time_dependent(i_conc: float, ki_inact: float, kinact: float, kdeg: float) -> float:
    """Basic TDI ratio, ``(kobs + kdeg) / kdeg``."""
    if ki_inact <= 0 or kdeg <= 0:
        raise InputError("KI and kdeg must be positive")
    kobs = kinact * i_conc / (ki_inact + i_conc)
    return (kobs + kdeg) / kdeg


def r3_induction(i_conc: float, emax: float, ec50: float, scaling: float = 1.0) -> float:
    """Basic induction ratio; values at or below 0.80 flag a potential inducer."""
    if ec50 <= 0:
        raise InputError("EC50 must be positive")
    return 1.0 / (1.0 + scaling * emax * i_conc / (ec50 + i_conc))


def inlet_concentration(imax: float, fu: float, dose: float, fa: float, fg: float, ka: float, blood_ratio: float = 1.0) -> float:
    """Maximum unbound hepatic inlet concentration.

    ``Iu,inlet,max = fu * (Imax + Fa*Fg*ka*Dose / (Qh*RB))``. This is the
    concentration the liver actually sees during absorption, which is higher
    than systemic Imax and is what M12 asks for in hepatic uptake-transporter
    assessments.
    """
    portal = fa * fg * ka * dose / (HEPATIC_BLOOD_FLOW_L_H * blood_ratio)
    return fu * (imax + portal)


def mechanistic_static(
    ih: float,
    ig: float,
    fm: float,
    fg: float,
    ki: float | None = None,
    ki_inact: float | None = None,
    kinact: float | None = None,
    kdeg_h: float = DEFAULT_KDEG_HEPATIC,
    kdeg_g: float = 0.0005,
    ind_emax: float = 0.0,
    ind_ec50: float | None = None,
    ind_scaling: float = 1.0,
) -> dict[str, float]:
    """Mechanistic static model AUC ratio, combining reversible, TDI and induction terms.

    ``AUCR = 1/(Ag*Bg*Cg*(1-Fg) + Fg) * 1/(Ah*Bh*Ch*fm + (1-fm))``

    The two fractions that dominate the answer are ``fm`` (the fraction of
    systemic clearance through the affected enzyme) and ``Fg`` (the fraction
    escaping gut metabolism). A perpetrator cannot raise the victim's AUC more
    than ``1/(1-fm)`` however potent it is, so an fm assumed at 1.0 when it is
    really 0.7 changes an unbounded prediction into a 3.3-fold ceiling.
    """
    def terms(i_conc: float, kdeg: float) -> tuple[float, float, float]:
        a = 1.0 / (1.0 + i_conc / ki) if ki else 1.0
        if ki_inact and kinact:
            b = kdeg / (kdeg + kinact * i_conc / (ki_inact + i_conc))
        else:
            b = 1.0
        c = 1.0 + ind_scaling * ind_emax * i_conc / (ind_ec50 + i_conc) if ind_ec50 else 1.0
        return a, b, c

    ah, bh, ch = terms(ih, kdeg_h)
    ag, bg, cg = terms(ig, kdeg_g)
    gut = 1.0 / (ag * bg * cg * (1.0 - fg) + fg)
    hepatic = 1.0 / (ah * bh * ch * fm + (1.0 - fm))
    return {
        "Ah_reversible": ah,
        "Bh_tdi": bh,
        "Ch_induction": ch,
        "Ag_reversible": ag,
        "Bg_tdi": bg,
        "Cg_induction": cg,
        "gut_component": gut,
        "hepatic_component": hepatic,
        "auc_ratio": gut * hepatic,
        "maximum_possible_auc_ratio": 1.0 / (1.0 - fm) if fm < 1 else float("inf"),
    }


def classify(auc_ratio: float) -> str:
    """FDA/ICH perpetrator classification bands for an AUC ratio."""
    if auc_ratio >= 5.0:
        return "strong inhibitor (AUCR >= 5)"
    if auc_ratio >= 2.0:
        return "moderate inhibitor (2 <= AUCR < 5)"
    if auc_ratio >= 1.25:
        return "weak inhibitor (1.25 <= AUCR < 2)"
    if auc_ratio > 0.8:
        return "no clinically relevant effect predicted (0.8 < AUCR < 1.25)"
    if auc_ratio > 0.5:
        return "weak inducer (0.5 < AUCR <= 0.8)"
    if auc_ratio > 0.2:
        return "moderate inducer (0.2 < AUCR <= 0.5)"
    return "strong inducer (AUCR <= 0.2)"


# --------------------------------------------------------------------- CLI


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="ICH M12 basic DDI models and the mechanistic static model.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--basic", action="store_true", help="run the basic models and report against their cut-offs")
    parser.add_argument("--msm", action="store_true", help="run the mechanistic static model")

    parser.add_argument("--imax", type=float, help="maximum total systemic plasma concentration of the perpetrator")
    parser.add_argument("--fu", type=float, default=1.0, help="unbound fraction in plasma (default: 1.0)")
    parser.add_argument("--dose", type=float, help="perpetrator molar dose, for the gut concentration")
    parser.add_argument("--ka", type=float, default=0.1, help="perpetrator absorption rate constant, per min (default: 0.1)")
    parser.add_argument("--fa", type=float, default=1.0, help="fraction absorbed (default: 1.0)")
    parser.add_argument("--fg-perpetrator", type=float, default=1.0, help="perpetrator gut availability (default: 1.0)")
    parser.add_argument("--blood-ratio", type=float, default=1.0, help="blood-to-plasma ratio (default: 1.0)")

    parser.add_argument("--ki", type=float, help="reversible inhibition constant")
    parser.add_argument("--tdi", action="store_true", help="evaluate time-dependent inhibition")
    parser.add_argument("--ki-inact", type=float, help="KI for time-dependent inactivation")
    parser.add_argument("--kinact", type=float, help="maximum inactivation rate constant, per min")
    parser.add_argument("--kdeg", type=float, default=DEFAULT_KDEG_HEPATIC, help="hepatic enzyme degradation rate, per min")
    parser.add_argument("--ind-emax", type=float, default=0.0, help="maximum fold induction minus one")
    parser.add_argument("--ind-ec50", type=float, help="induction EC50")
    parser.add_argument("--ind-scaling", type=float, default=1.0, help="induction scaling factor d (default: 1.0)")

    parser.add_argument("--fm", type=float, help="fraction of victim clearance via the affected enzyme")
    parser.add_argument("--fg", type=float, default=1.0, help="victim fraction escaping gut metabolism (default: 1.0)")
    parser.add_argument("--transporter", choices=("hepatic-uptake", "intestinal", "renal"), help="also run the transporter basic model")
    parser.add_argument("--transporter-ki", type=float)
    add_format_argument(parser)
    return parser


def run(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.basic == args.msm:
        raise InputError("choose exactly one of --basic or --msm")
    if args.imax is None:
        raise InputError("--imax is required")
    if not 0 < args.fu <= 1:
        raise InputError("--fu must be in (0, 1]")

    report = Report()
    unbound = args.imax * args.fu
    gut = (args.dose / (GUT_VOLUME_ML / 1000.0)) if args.dose else None
    report.scalar("imax_total", args.imax)
    report.scalar("imax_unbound", unbound)
    if gut is not None:
        report.scalar("gut_concentration", gut)
    report.note(
        "Units are not checked. Ki, KI, EC50, Imax and dose must all be expressed on the same molar "
        "basis; the gut concentration is dose divided by 250 mL."
    )

    if args.basic:
        rows = []
        if args.ki:
            r1 = r1_reversible(unbound, args.ki)
            rows.append(
                {
                    "model": "reversible inhibition, hepatic",
                    "value": r1,
                    "cutoff": f">= {CUTOFF_R1_HEPATIC}",
                    "triggers_study": r1 >= CUTOFF_R1_HEPATIC,
                    "basis": "1 + Imax,u/Ki",
                }
            )
            if gut is not None:
                r1g = r1_reversible(gut, args.ki)
                rows.append(
                    {
                        "model": "reversible inhibition, intestinal (CYP3A4)",
                        "value": r1g,
                        "cutoff": f">= {CUTOFF_R1_GUT}",
                        "triggers_study": r1g >= CUTOFF_R1_GUT,
                        "basis": "1 + Igut/Ki, Igut = dose/250 mL",
                    }
                )
        if args.tdi:
            if not (args.ki_inact and args.kinact):
                raise InputError("--tdi needs --ki-inact and --kinact")
            r2 = r2_time_dependent(unbound * 50.0, args.ki_inact, args.kinact, args.kdeg)
            rows.append(
                {
                    "model": "time-dependent inhibition, hepatic",
                    "value": r2,
                    "cutoff": f">= {CUTOFF_R2_TDI}",
                    "triggers_study": r2 >= CUTOFF_R2_TDI,
                    "basis": "(kobs + kdeg)/kdeg at 50 x Imax,u",
                }
            )
        if args.ind_ec50 and args.ind_emax:
            r3 = r3_induction(unbound * 10.0, args.ind_emax, args.ind_ec50, args.ind_scaling)
            rows.append(
                {
                    "model": "induction",
                    "value": r3,
                    "cutoff": f"<= {CUTOFF_R3_INDUCTION}",
                    "triggers_study": r3 <= CUTOFF_R3_INDUCTION,
                    "basis": "1/(1 + d*Emax*I/(EC50+I)) at 10 x Imax,u",
                }
            )
        if args.transporter:
            if not args.transporter_ki:
                raise InputError("--transporter needs --transporter-ki")
            if args.transporter == "hepatic-uptake":
                if args.dose is None:
                    raise InputError("hepatic uptake needs --dose for the inlet concentration")
                conc = inlet_concentration(args.imax, args.fu, args.dose, args.fa, args.fg_perpetrator, args.ka, args.blood_ratio)
                value = 1.0 + conc / args.transporter_ki
                cutoff, triggers = CUTOFF_TRANSPORTER_HEPATIC_UPTAKE, value >= CUTOFF_TRANSPORTER_HEPATIC_UPTAKE
                basis = "1 + Iu,inlet,max/Ki,u (OATP1B1/1B3)"
            elif args.transporter == "intestinal":
                if gut is None:
                    raise InputError("intestinal transporter assessment needs --dose")
                value = gut / args.transporter_ki
                cutoff, triggers = CUTOFF_TRANSPORTER_INTESTINAL, value >= CUTOFF_TRANSPORTER_INTESTINAL
                basis = "Igut/IC50 (P-gp, BCRP)"
            else:
                value = unbound / args.transporter_ki
                cutoff, triggers = CUTOFF_TRANSPORTER_RENAL, value >= CUTOFF_TRANSPORTER_RENAL
                basis = "Imax,u/Ki (OAT, OCT, MATE)"
            rows.append(
                {
                    "model": f"transporter inhibition, {args.transporter}",
                    "value": value,
                    "cutoff": f">= {cutoff}",
                    "triggers_study": triggers,
                    "basis": basis,
                }
            )
        if not rows:
            raise InputError("--basic needs at least one of --ki, --tdi, or --ind-ec50 with --ind-emax")
        report.table("ICH M12 basic models", rows)
        for row in rows:
            if row["triggers_study"]:
                report.finding(
                    f"{row['model']}: {row['value']:.4g} meets the cut-off {row['cutoff']} - a clinical "
                    "DDI study or a refined mechanistic/PBPK assessment is indicated"
                )
        report.note(
            "Basic models are intentionally conservative. A result below the cut-off supports not "
            "studying the interaction; a result above it is a trigger for further evaluation, not a "
            "prediction of clinical magnitude."
        )

    else:
        if args.fm is None:
            raise InputError("--msm needs --fm")
        if not 0 < args.fm <= 1:
            raise InputError("--fm must be in (0, 1]")
        if not 0 < args.fg <= 1:
            raise InputError("--fg must be in (0, 1]")
        result = mechanistic_static(
            ih=unbound,
            ig=gut if gut is not None else 0.0,
            fm=args.fm,
            fg=args.fg,
            ki=args.ki,
            ki_inact=args.ki_inact if args.tdi else None,
            kinact=args.kinact if args.tdi else None,
            kdeg_h=args.kdeg,
            ind_emax=args.ind_emax,
            ind_ec50=args.ind_ec50,
            ind_scaling=args.ind_scaling,
        )
        report.table("mechanistic static model", [{"term": k, "value": v} for k, v in result.items()])
        report.scalar("predicted_auc_ratio", result["auc_ratio"])
        report.scalar("classification", classify(result["auc_ratio"]))
        report.note(
            f"With fm = {args.fm}, no inhibitor of this pathway can raise the victim AUC above "
            f"{result['maximum_possible_auc_ratio']:.2f}-fold. If the prediction approaches that "
            "ceiling, fm is doing more work than the inhibition constants."
        )
        if gut is None:
            report.note("no --dose given, so the intestinal component was evaluated at zero inhibitor concentration")
        if args.fm > 0.95:
            report.finding(
                f"fm = {args.fm} implies almost all clearance goes through one enzyme. This is rarely "
                "established and it drives the prediction; state the evidence for it or run a sensitivity "
                "analysis across a plausible range."
            )
        if result["auc_ratio"] >= 2.0:
            report.finding(
                f"predicted AUC ratio {result['auc_ratio']:.2f} - {classify(result['auc_ratio'])}; "
                "a clinical evaluation and labelling implications follow"
            )
        report.note(
            "The mechanistic static model assumes a single constant perpetrator concentration and no "
            "time course. It is a screening refinement; where the interaction is decision-relevant, "
            "ICH M12 points to PBPK with a verified perpetrator model."
        )

    return report.emit(args.format)


if __name__ == "__main__":
    raise SystemExit(main_wrapper(run))
