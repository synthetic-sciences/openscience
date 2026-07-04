#!/usr/bin/env python3
"""Design PCR primers using primer3-py.

Wraps the primer3 ``design_primers()`` API to produce ranked primer
pairs for a given template and target region.  Reports sequences, Tm,
GC%, self-complementarity, hairpin scores, and penalty values.

Usage:
    python design_primers.py --template SEQ --target-start POS --target-length LEN [options]

Examples:
    # Design 5 primer pairs for a 200-bp target starting at position 100
    python design_primers.py \\
        --template my_gene.fasta \\
        --target-start 100 \\
        --target-length 200 \\
        --output-dir primer_out

    # Custom product size and Tm
    python design_primers.py \\
        --template ATGCCC...NNN \\
        --target-start 50 \\
        --target-length 300 \\
        --product-min 200 \\
        --product-max 800 \\
        --tm-opt 62 \\
        --num-return 10
"""

import argparse
import csv
import os
import sys

import primer3
from Bio import SeqIO


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_sequence(path_or_seq: str) -> str:
    """Return an uppercase DNA string from a FASTA file or raw sequence."""
    if os.path.isfile(path_or_seq):
        record = SeqIO.read(path_or_seq, "fasta")
        return str(record.seq).upper()
    cleaned = "".join(path_or_seq.split()).upper()
    valid = set("ACGTNRYSWKMBDHV")
    if all(c in valid for c in cleaned):
        return cleaned
    raise ValueError(
        f"Input is neither a valid FASTA file nor a DNA sequence: {path_or_seq[:60]}..."
    )


# ---------------------------------------------------------------------------
# Primer design core
# ---------------------------------------------------------------------------

def run_primer3(template: str, target_start: int, target_length: int,
                product_min: int, product_max: int, tm_opt: float,
                num_return: int) -> dict:
    """Call primer3.design_primers() and return the raw result dict."""
    seq_args = {
        "SEQUENCE_TEMPLATE": template,
        "SEQUENCE_TARGET": [target_start, target_length],
    }

    global_args = {
        "PRIMER_NUM_RETURN": num_return,
        "PRIMER_OPT_TM": tm_opt,
        "PRIMER_MIN_TM": tm_opt - 5.0,
        "PRIMER_MAX_TM": tm_opt + 5.0,
        "PRIMER_OPT_SIZE": 20,
        "PRIMER_MIN_SIZE": 18,
        "PRIMER_MAX_SIZE": 27,
        "PRIMER_MAX_POLY_X": 4,
        "PRIMER_PRODUCT_SIZE_RANGE": [[product_min, product_max]],
        "PRIMER_SALT_MONOVALENT": 50.0,
        "PRIMER_DNA_CONC": 250.0,
        "PRIMER_THERMODYNAMIC_OLIGO_ALIGNMENT": 1,
        "PRIMER_THERMODYNAMIC_TEMPLATE_ALIGNMENT": 1,
    }

    result = primer3.design_primers(seq_args, global_args)
    return result


def extract_pairs(raw: dict) -> list[dict]:
    """Parse the primer3 result dict into a list of primer-pair records."""
    count = raw.get("PRIMER_PAIR_NUM_RETURNED", 0)
    pairs: list[dict] = []

    for i in range(count):
        left_seq = raw.get(f"PRIMER_LEFT_{i}_SEQUENCE", "")
        right_seq = raw.get(f"PRIMER_RIGHT_{i}_SEQUENCE", "")

        left_pos, left_len = raw.get(f"PRIMER_LEFT_{i}", (0, 0))
        right_pos, right_len = raw.get(f"PRIMER_RIGHT_{i}", (0, 0))

        pair = {
            "rank": i + 1,
            "left_seq": left_seq,
            "right_seq": right_seq,
            "left_start": left_pos,
            "left_len": left_len,
            "right_start": right_pos,
            "right_len": right_len,
            "left_tm": round(raw.get(f"PRIMER_LEFT_{i}_TM", 0.0), 1),
            "right_tm": round(raw.get(f"PRIMER_RIGHT_{i}_TM", 0.0), 1),
            "left_gc": round(raw.get(f"PRIMER_LEFT_{i}_GC_PERCENT", 0.0), 1),
            "right_gc": round(raw.get(f"PRIMER_RIGHT_{i}_GC_PERCENT", 0.0), 1),
            "left_self_any_th": round(raw.get(f"PRIMER_LEFT_{i}_SELF_ANY_TH", 0.0), 1),
            "right_self_any_th": round(raw.get(f"PRIMER_RIGHT_{i}_SELF_ANY_TH", 0.0), 1),
            "left_self_end_th": round(raw.get(f"PRIMER_LEFT_{i}_SELF_END_TH", 0.0), 1),
            "right_self_end_th": round(raw.get(f"PRIMER_RIGHT_{i}_SELF_END_TH", 0.0), 1),
            "left_hairpin_th": round(raw.get(f"PRIMER_LEFT_{i}_HAIRPIN_TH", 0.0), 1),
            "right_hairpin_th": round(raw.get(f"PRIMER_RIGHT_{i}_HAIRPIN_TH", 0.0), 1),
            "pair_compl_any_th": round(raw.get(f"PRIMER_PAIR_{i}_COMPL_ANY_TH", 0.0), 1),
            "pair_compl_end_th": round(raw.get(f"PRIMER_PAIR_{i}_COMPL_END_TH", 0.0), 1),
            "product_size": raw.get(f"PRIMER_PAIR_{i}_PRODUCT_SIZE", 0),
            "pair_penalty": round(raw.get(f"PRIMER_PAIR_{i}_PENALTY", 0.0), 3),
            "left_penalty": round(raw.get(f"PRIMER_LEFT_{i}_PENALTY", 0.0), 3),
            "right_penalty": round(raw.get(f"PRIMER_RIGHT_{i}_PENALTY", 0.0), 3),
        }
        pairs.append(pair)

    return pairs


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def print_report(pairs: list[dict], target_start: int, target_length: int):
    print(f"=== Primer Design Results ===")
    print(f"Target region: {target_start}..{target_start + target_length} "
          f"({target_length} bp)\n")

    if not pairs:
        print("No primer pairs found. Try relaxing constraints.")
        return

    print(f"{'#':<4} {'Product':<9} {'Penalty':<9} {'Fwd Tm':<8} {'Rev Tm':<8} "
          f"{'Fwd GC%':<9} {'Rev GC%':<9} {'Fwd Hairpin':<13} {'Rev Hairpin':<13}")
    print("-" * 92)

    for p in pairs:
        print(
            f"{p['rank']:<4} {p['product_size']:<9} {p['pair_penalty']:<9.3f} "
            f"{p['left_tm']:<8} {p['right_tm']:<8} "
            f"{p['left_gc']:<9} {p['right_gc']:<9} "
            f"{p['left_hairpin_th']:<13} {p['right_hairpin_th']:<13}"
        )

    print()
    for p in pairs:
        print(f"Pair {p['rank']}:")
        print(f"  Forward : {p['left_seq']}  (pos {p['left_start']}, {p['left_len']} nt)")
        print(f"  Reverse : {p['right_seq']}  (pos {p['right_start']}, {p['right_len']} nt)")
        print(f"  Product : {p['product_size']} bp")
        print(f"  Tm      : fwd={p['left_tm']} C, rev={p['right_tm']} C")
        print(f"  GC%     : fwd={p['left_gc']}%, rev={p['right_gc']}%")
        print(f"  Self-comp (any): fwd={p['left_self_any_th']} C, rev={p['right_self_any_th']} C")
        print(f"  Self-comp (end): fwd={p['left_self_end_th']} C, rev={p['right_self_end_th']} C")
        print(f"  Hairpin : fwd={p['left_hairpin_th']} C, rev={p['right_hairpin_th']} C")
        print(f"  Pair compl (any/end): {p['pair_compl_any_th']} / {p['pair_compl_end_th']} C")
        print(f"  Penalty : pair={p['pair_penalty']}, fwd={p['left_penalty']}, rev={p['right_penalty']}")
        print()


def save_csv(pairs: list[dict], outdir: str):
    os.makedirs(outdir, exist_ok=True)
    path = os.path.join(outdir, "primers.csv")

    fieldnames = [
        "rank", "left_seq", "right_seq",
        "left_start", "left_len", "right_start", "right_len",
        "product_size",
        "left_tm", "right_tm",
        "left_gc", "right_gc",
        "left_self_any_th", "right_self_any_th",
        "left_self_end_th", "right_self_end_th",
        "left_hairpin_th", "right_hairpin_th",
        "pair_compl_any_th", "pair_compl_end_th",
        "pair_penalty", "left_penalty", "right_penalty",
    ]

    with open(path, "w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for p in pairs:
            writer.writerow(p)

    print(f"Primers CSV saved to {path}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Design PCR primers using primer3-py."
    )
    p.add_argument(
        "--template",
        required=True,
        help="Path to a FASTA file or a raw DNA sequence string.",
    )
    p.add_argument(
        "--target-start",
        type=int,
        required=True,
        help="0-based start position of the target region on the template.",
    )
    p.add_argument(
        "--target-length",
        type=int,
        required=True,
        help="Length of the target region to amplify (bp).",
    )
    p.add_argument(
        "--product-min",
        type=int,
        default=150,
        help="Minimum acceptable product size in bp (default: 150).",
    )
    p.add_argument(
        "--product-max",
        type=int,
        default=500,
        help="Maximum acceptable product size in bp (default: 500).",
    )
    p.add_argument(
        "--tm-opt",
        type=float,
        default=60.0,
        help="Optimal primer Tm in degrees C (default: 60.0).",
    )
    p.add_argument(
        "--num-return",
        type=int,
        default=5,
        help="Number of primer pairs to return (default: 5).",
    )
    p.add_argument(
        "--output-dir",
        default=None,
        help="Directory for output CSV file.",
    )
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)

    try:
        template = load_sequence(args.template)
    except Exception as exc:
        print(f"ERROR: Could not load template: {exc}", file=sys.stderr)
        sys.exit(1)

    if args.target_start < 0 or args.target_start >= len(template):
        print(
            f"ERROR: --target-start {args.target_start} is out of range "
            f"(template length = {len(template)}).",
            file=sys.stderr,
        )
        sys.exit(1)

    if args.target_start + args.target_length > len(template):
        print(
            f"ERROR: Target region extends past template end "
            f"(start={args.target_start}, length={args.target_length}, "
            f"template={len(template)}).",
            file=sys.stderr,
        )
        sys.exit(1)

    if args.product_min > args.product_max:
        print(
            f"ERROR: --product-min ({args.product_min}) exceeds "
            f"--product-max ({args.product_max}).",
            file=sys.stderr,
        )
        sys.exit(1)

    raw = run_primer3(
        template,
        args.target_start,
        args.target_length,
        args.product_min,
        args.product_max,
        args.tm_opt,
        args.num_return,
    )

    # Check for primer3-level errors
    explain_left = raw.get("PRIMER_LEFT_EXPLAIN", "")
    explain_right = raw.get("PRIMER_RIGHT_EXPLAIN", "")
    explain_pair = raw.get("PRIMER_PAIR_EXPLAIN", "")

    pairs = extract_pairs(raw)
    print_report(pairs, args.target_start, args.target_length)

    if explain_left or explain_right or explain_pair:
        print("Primer3 diagnostics:")
        if explain_left:
            print(f"  Left  : {explain_left}")
        if explain_right:
            print(f"  Right : {explain_right}")
        if explain_pair:
            print(f"  Pair  : {explain_pair}")

    if args.output_dir and pairs:
        save_csv(pairs, args.output_dir)


if __name__ == "__main__":
    main()
