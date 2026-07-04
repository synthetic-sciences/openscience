#!/usr/bin/env python3
"""Simulate restriction enzyme digestion of a DNA sequence.

Finds recognition sites for one or more restriction enzymes, computes
fragment sizes (supporting both linear and circular DNA), and exports
fragments as multi-FASTA plus a summary report.

Usage:
    python restriction_digest.py --sequence SEQ --enzymes EcoRI,BamHI [options]

Examples:
    # Digest a circular plasmid with two enzymes
    python restriction_digest.py \\
        --sequence plasmid.fasta \\
        --enzymes EcoRI,BamHI \\
        --circular \\
        --output-dir digest_results

    # Digest a raw linear sequence
    python restriction_digest.py \\
        --sequence GAATTCAAAGGATCCTTTTGAATTC \\
        --enzymes EcoRI,BamHI
"""

import argparse
import csv
import os
import sys

from Bio import SeqIO
from Bio.Restriction import RestrictionBatch, Analysis
from Bio.Seq import Seq
from Bio.SeqRecord import SeqRecord
from Bio.SeqUtils import gc_fraction


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_sequence(path_or_seq: str) -> str:
    """Return an uppercase DNA string from a FASTA path or raw sequence."""
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


def parse_enzyme_names(csv_string: str) -> list[str]:
    """Split a comma-separated enzyme list, stripping whitespace."""
    return [e.strip() for e in csv_string.split(",") if e.strip()]


def compute_fragments_linear(seq_len: int, cut_positions: list[int]) -> list[tuple[int, int, int]]:
    """Return (start, end, size) tuples for a linear digest.

    *cut_positions* are 1-based positions (Bio.Restriction convention).
    """
    # Convert to 0-based sorted cut points
    cuts = sorted(set(cut_positions))
    boundaries = [0] + cuts + [seq_len]
    fragments = []
    for i in range(len(boundaries) - 1):
        s = boundaries[i]
        e = boundaries[i + 1]
        fragments.append((s, e, e - s))
    return fragments


def compute_fragments_circular(seq_len: int, cut_positions: list[int]) -> list[tuple[int, int, int]]:
    """Return (start, end, size) tuples for a circular digest.

    When DNA is circular the last fragment wraps from the last cut to the
    first cut through the origin.
    """
    if not cut_positions:
        return [(0, seq_len, seq_len)]
    cuts = sorted(set(cut_positions))
    fragments = []
    for i in range(len(cuts)):
        s = cuts[i]
        e = cuts[(i + 1) % len(cuts)]
        size = (e - s) % seq_len
        if size == 0:
            size = seq_len  # single cut on circular = full length
        fragments.append((s, e, size))
    return fragments


# ---------------------------------------------------------------------------
# Core
# ---------------------------------------------------------------------------

def run_digest(seq_str: str, enzyme_names: list[str], circular: bool):
    """Run the digest and return structured results.

    Returns
    -------
    results : dict
        enzyme_results : dict[str, list[int]]   cut positions per enzyme
        all_cuts       : list[int]               merged sorted cut list
        fragments      : list[(start, end, size)]
        seq_len        : int
    """
    seq_obj = Seq(seq_str)

    # Build restriction batch
    try:
        rb = RestrictionBatch(enzyme_names)
    except Exception as exc:
        raise ValueError(f"Invalid enzyme name(s): {exc}") from exc

    ana = Analysis(rb, seq_obj, linear=not circular)
    raw = ana.full()

    enzyme_results: dict[str, list[int]] = {}
    all_cuts: list[int] = []
    for enz, positions in raw.items():
        name = str(enz)
        enzyme_results[name] = sorted(positions)
        all_cuts.extend(positions)

    all_cuts = sorted(set(all_cuts))

    if circular:
        fragments = compute_fragments_circular(len(seq_str), all_cuts)
    else:
        fragments = compute_fragments_linear(len(seq_str), all_cuts)

    return {
        "enzyme_results": enzyme_results,
        "all_cuts": all_cuts,
        "fragments": fragments,
        "seq_len": len(seq_str),
    }


def extract_fragment_sequences(seq_str: str, fragments, circular: bool) -> list[str]:
    """Extract the actual nucleotide strings for each fragment."""
    seqs = []
    n = len(seq_str)
    for start, end, size in fragments:
        if circular and end <= start:
            frag = seq_str[start:] + seq_str[:end]
        else:
            frag = seq_str[start:end]
        seqs.append(frag)
    return seqs


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

def print_report(results: dict, circular: bool):
    topo = "circular" if circular else "linear"
    print(f"=== Restriction Digest Report ({topo}, {results['seq_len']} bp) ===\n")

    for enz, positions in sorted(results["enzyme_results"].items()):
        n = len(positions)
        pos_str = ", ".join(str(p) for p in positions) if positions else "none"
        print(f"  {enz}: {n} site(s) at position(s) {pos_str}")

    total_cuts = len(results["all_cuts"])
    print(f"\nTotal cut sites: {total_cuts}")

    if total_cuts == 0:
        print("No cuts — sequence remains intact.")
        return

    frags = results["fragments"]
    sizes = sorted([f[2] for f in frags], reverse=True)
    print(f"Number of fragments: {len(frags)}")
    print(f"Fragment sizes (descending): {', '.join(str(s) for s in sizes)} bp")
    print(f"Sum of fragments: {sum(sizes)} bp")


def save_fragments_fasta(seq_str: str, results: dict, circular: bool, outdir: str):
    frags = results["fragments"]
    frag_seqs = extract_fragment_sequences(seq_str, frags, circular)
    records = []
    for idx, (fseq, (s, e, sz)) in enumerate(zip(frag_seqs, frags), 1):
        rec = SeqRecord(
            Seq(fseq),
            id=f"fragment_{idx}",
            description=f"start={s} end={e} size={sz}bp",
        )
        records.append(rec)
    path = os.path.join(outdir, "fragments.fasta")
    SeqIO.write(records, path, "fasta")
    print(f"\nFragments saved to {path}")


def save_summary_csv(results: dict, outdir: str):
    path = os.path.join(outdir, "digest_summary.csv")
    with open(path, "w", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["enzyme", "num_sites", "positions"])
        for enz, positions in sorted(results["enzyme_results"].items()):
            writer.writerow([enz, len(positions), ";".join(str(p) for p in positions)])
        writer.writerow([])
        writer.writerow(["fragment_index", "start", "end", "size_bp"])
        for idx, (s, e, sz) in enumerate(results["fragments"], 1):
            writer.writerow([idx, s, e, sz])
    print(f"Digest summary saved to {path}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Simulate restriction enzyme digestion of a DNA sequence."
    )
    p.add_argument(
        "--sequence",
        required=True,
        help="Path to a FASTA file or a raw DNA sequence string.",
    )
    p.add_argument(
        "--enzymes",
        required=True,
        help="Comma-separated list of restriction enzymes (e.g. EcoRI,BamHI).",
    )
    p.add_argument(
        "--circular",
        action="store_true",
        default=False,
        help="Treat the sequence as circular DNA (default: linear).",
    )
    p.add_argument(
        "--output-dir",
        default=None,
        help="Directory for output files (fragments FASTA + summary CSV).",
    )
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)

    try:
        seq_str = load_sequence(args.sequence)
    except Exception as exc:
        print(f"ERROR: Could not load sequence: {exc}", file=sys.stderr)
        sys.exit(1)

    enzyme_names = parse_enzyme_names(args.enzymes)
    if not enzyme_names:
        print("ERROR: No enzyme names provided.", file=sys.stderr)
        sys.exit(1)

    try:
        results = run_digest(seq_str, enzyme_names, args.circular)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    print_report(results, args.circular)

    if args.output_dir:
        os.makedirs(args.output_dir, exist_ok=True)
        save_fragments_fasta(seq_str, results, args.circular, args.output_dir)
        save_summary_csv(results, args.output_dir)


if __name__ == "__main__":
    main()
