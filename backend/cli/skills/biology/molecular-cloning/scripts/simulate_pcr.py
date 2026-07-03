#!/usr/bin/env python3
"""Simulate PCR amplification from a DNA template and primer pair.

Predicts the amplicon sequence by locating forward and reverse primer
binding sites on the template, allowing a configurable number of 5'-end
mismatches.  Reports primer melting temperatures (nearest-neighbor),
amplicon length, GC content, and binding coordinates.

Usage:
    python simulate_pcr.py --template SEQ --forward FWD --reverse REV [options]

Examples:
    # From a FASTA file
    python simulate_pcr.py \\
        --template plasmid.fasta \\
        --forward ATGCGTACGTAGCTAG \\
        --reverse GCTAGCTAGCATCGAT \\
        --output amplicon.fasta

    # From a raw sequence string
    python simulate_pcr.py \\
        --template ATGCGTACGTAGCTAGAAAA...ATCGATGCTAGCTAGC \\
        --forward ATGCGTACGTAGCTAG \\
        --reverse GCTAGCTAGCATCGAT \\
        --max-mismatches 2
"""

import argparse
import os
import sys

from Bio import SeqIO
from Bio.Seq import Seq
from Bio.SeqRecord import SeqRecord
from Bio.SeqUtils import gc_fraction
from Bio.SeqUtils.MeltingTemp import Tm_NN


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_sequence(path_or_seq: str) -> str:
    """Return an uppercase DNA string from a FASTA file path or raw sequence."""
    if os.path.isfile(path_or_seq):
        record = SeqIO.read(path_or_seq, "fasta")
        return str(record.seq).upper()
    cleaned = "".join(path_or_seq.split()).upper()
    valid = set("ACGTNRYSWKMBDHV")
    if all(c in valid for c in cleaned):
        return cleaned
    raise ValueError(f"Input is neither a valid FASTA file nor a DNA sequence: {path_or_seq[:60]}...")


def reverse_complement(seq: str) -> str:
    return str(Seq(seq).reverse_complement())


def find_binding_site(template: str, primer: str, max_mismatches: int) -> int:
    """Find the leftmost binding position of *primer* on *template*.

    Mismatches are tolerated only at the 5' end of the primer; the 3' half
    must match exactly.  Returns the 0-based start index on the template or
    -1 if no site is found.
    """
    plen = len(primer)
    three_prime_len = plen // 2  # 3' half must be exact
    best_pos = -1
    best_mm = max_mismatches + 1

    for i in range(len(template) - plen + 1):
        window = template[i : i + plen]
        # Enforce exact 3' match
        if window[plen - three_prime_len :] != primer[plen - three_prime_len :]:
            continue
        mm = sum(1 for a, b in zip(window, primer) if a != b)
        if mm <= max_mismatches and mm < best_mm:
            best_mm = mm
            best_pos = i
    return best_pos


def compute_tm(primer_seq: str) -> float:
    """Nearest-neighbour Tm in degrees Celsius (50 mM Na+, 0.25 uM oligo)."""
    return round(Tm_NN(Seq(primer_seq), Na=50, dnac1=250, dnac2=0), 1)


# ---------------------------------------------------------------------------
# Core simulation
# ---------------------------------------------------------------------------

def simulate_pcr(template: str, fwd: str, rev: str, max_mismatches: int):
    """Return a dict with amplicon info or raise on failure."""
    fwd = fwd.upper()
    rev = rev.upper()

    # Forward primer binds sense strand
    fwd_pos = find_binding_site(template, fwd, max_mismatches)
    if fwd_pos == -1:
        raise RuntimeError(
            f"Forward primer binding site not found (max mismatches={max_mismatches})."
        )

    # Reverse primer binds antisense strand  ->  search for its reverse
    # complement on the sense strand
    rev_rc = reverse_complement(rev)
    rev_pos = find_binding_site(template, rev_rc, max_mismatches)
    if rev_pos == -1:
        raise RuntimeError(
            f"Reverse primer binding site not found (max mismatches={max_mismatches})."
        )

    # The amplicon spans from fwd_pos to rev_pos + len(rev) on the sense strand
    amp_start = fwd_pos
    amp_end = rev_pos + len(rev)
    if amp_end <= amp_start:
        raise RuntimeError(
            f"Primers bind in wrong order or overlap "
            f"(fwd @ {fwd_pos}, rev_rc @ {rev_pos})."
        )

    amplicon = template[amp_start:amp_end]
    fwd_tm = compute_tm(fwd)
    rev_tm = compute_tm(rev)
    gc = round(gc_fraction(amplicon) * 100, 1)

    return {
        "amplicon": amplicon,
        "length": len(amplicon),
        "fwd_pos": fwd_pos,
        "rev_pos": rev_pos,
        "fwd_tm": fwd_tm,
        "rev_tm": rev_tm,
        "gc_pct": gc,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Simulate PCR amplification and report amplicon metrics."
    )
    p.add_argument(
        "--template",
        required=True,
        help="Path to a FASTA file or a raw DNA sequence string.",
    )
    p.add_argument("--forward", required=True, help="Forward primer sequence (5'->3').")
    p.add_argument("--reverse", required=True, help="Reverse primer sequence (5'->3').")
    p.add_argument(
        "--max-mismatches",
        type=int,
        default=1,
        help="Max allowed mismatches at the 5' end of each primer (default: 1).",
    )
    p.add_argument(
        "--output",
        default=None,
        help="Output FASTA path for the amplicon (default: stdout only).",
    )
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)

    try:
        template = load_sequence(args.template)
    except Exception as exc:
        print(f"ERROR: Could not load template: {exc}", file=sys.stderr)
        sys.exit(1)

    try:
        result = simulate_pcr(template, args.forward, args.reverse, args.max_mismatches)
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    # ---- Report -----------------------------------------------------------
    print("=== PCR Simulation Results ===")
    print(f"Amplicon length : {result['length']} bp")
    print(f"GC content      : {result['gc_pct']}%")
    print(f"Forward primer  : Tm = {result['fwd_tm']} C, binds at position {result['fwd_pos']}")
    print(f"Reverse primer  : Tm = {result['rev_tm']} C, binds at position {result['rev_pos']} (rc on sense)")
    print(f"Tm difference   : {abs(result['fwd_tm'] - result['rev_tm']):.1f} C")
    if abs(result["fwd_tm"] - result["rev_tm"]) > 5:
        print("WARNING: Primer Tm difference exceeds 5 C; consider redesigning primers.")
    print()
    print(f"Amplicon sequence (first 80 nt):")
    print(f"  {result['amplicon'][:80]}{'...' if result['length'] > 80 else ''}")

    # ---- Save FASTA -------------------------------------------------------
    if args.output:
        record = SeqRecord(
            Seq(result["amplicon"]),
            id="pcr_amplicon",
            description=(
                f"len={result['length']} gc={result['gc_pct']}% "
                f"fwd_tm={result['fwd_tm']} rev_tm={result['rev_tm']}"
            ),
        )
        outdir = os.path.dirname(args.output)
        if outdir:
            os.makedirs(outdir, exist_ok=True)
        SeqIO.write(record, args.output, "fasta")
        print(f"\nAmplicon saved to {args.output}")


if __name__ == "__main__":
    main()
