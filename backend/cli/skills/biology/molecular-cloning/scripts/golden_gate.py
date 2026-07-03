#!/usr/bin/env python3
"""Simulate Golden Gate (Type IIS) assembly from a set of DNA parts.

Each part in the input multi-FASTA is expected to carry flanking Type IIS
recognition sites (BsaI or BpiI).  The tool digests each part, extracts
the 4-bp sticky-end overhangs, validates overhang compatibility, and
predicts the assembled product by ligating fragments in overhang order.

Usage:
    python golden_gate.py --parts parts.fasta [options]

Examples:
    # Default BsaI assembly
    python golden_gate.py --parts gg_parts.fasta --output-dir gg_out

    # BpiI assembly
    python golden_gate.py --parts parts.fasta --enzyme BpiI --output-dir gg_out
"""

import argparse
import csv
import os
import sys
from dataclasses import dataclass, field

from Bio import SeqIO
from Bio.Seq import Seq
from Bio.SeqRecord import SeqRecord
from Bio.SeqUtils import gc_fraction

import numpy as np


# ---------------------------------------------------------------------------
# Enzyme definitions  (recognition site, cut offset from 5' end of rec site)
# ---------------------------------------------------------------------------

ENZYME_DB = {
    "BsaI": {
        "site": "GGTCTC",
        "cut_offset": 7,     # cuts 1 nt downstream of site on sense strand
        "overhang_len": 4,
    },
    "BpiI": {
        "site": "GAAGAC",
        "cut_offset": 8,     # cuts 2 nt downstream on sense strand
        "overhang_len": 4,
    },
}


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class CutSite:
    """One Type IIS cut site on a part."""
    position: int        # 0-based start of recognition site on sense strand
    strand: str          # '+' or '-'
    overhang: str        # 4-bp overhang left after digestion
    overhang_rc: str     # reverse complement of overhang


@dataclass
class DigestedPart:
    """A part after Type IIS digestion."""
    name: str
    original_seq: str
    insert: str          # sequence between the two cut sites (excised fragment)
    left_overhang: str   # 4-bp 5' overhang on the insert
    right_overhang: str  # 4-bp 3' overhang on the insert
    cut_sites: list[CutSite] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def reverse_complement(seq: str) -> str:
    return str(Seq(seq).reverse_complement())


def find_sites(seq: str, enzyme: str) -> list[CutSite]:
    """Find all Type IIS recognition sites on both strands."""
    info = ENZYME_DB[enzyme]
    site = info["site"]
    site_rc = reverse_complement(site)
    cut_off = info["cut_offset"]
    oh_len = info["overhang_len"]
    seq_upper = seq.upper()

    sites: list[CutSite] = []

    # Sense strand hits
    start = 0
    while True:
        idx = seq_upper.find(site, start)
        if idx == -1:
            break
        cut_pos = idx + cut_off
        if cut_pos + oh_len <= len(seq_upper):
            oh = seq_upper[cut_pos : cut_pos + oh_len]
            sites.append(CutSite(idx, "+", oh, reverse_complement(oh)))
        start = idx + 1

    # Antisense strand hits (site_rc on sense strand)
    start = 0
    while True:
        idx = seq_upper.find(site_rc, start)
        if idx == -1:
            break
        # For antisense recognition, the cut is upstream of the site
        cut_pos = idx - oh_len
        if cut_pos >= 0:
            oh = seq_upper[cut_pos : cut_pos + oh_len]
            sites.append(CutSite(idx, "-", oh, reverse_complement(oh)))
        start = idx + 1

    return sorted(sites, key=lambda s: s.position)


def digest_part(name: str, seq: str, enzyme: str) -> DigestedPart:
    """Digest a single part and extract the insert with overhangs."""
    sites = find_sites(seq, enzyme)

    if len(sites) < 2:
        raise ValueError(
            f"Part '{name}' has {len(sites)} {enzyme} site(s); need exactly 2."
        )
    if len(sites) > 2:
        raise ValueError(
            f"Part '{name}' has {len(sites)} {enzyme} sites; need exactly 2."
        )

    info = ENZYME_DB[enzyme]
    oh_len = info["overhang_len"]
    cut_off = info["cut_offset"]

    # Determine the two cut coordinates on the sense strand
    s1, s2 = sites[0], sites[1]

    # Compute actual cut positions that bound the insert
    if s1.strand == "+":
        left_cut = s1.position + cut_off
    else:
        left_cut = s1.position - oh_len

    if s2.strand == "-":
        right_cut = s2.position
    else:
        right_cut = s2.position + cut_off + oh_len

    # Ensure ordering
    if left_cut > right_cut:
        left_cut, right_cut = right_cut, left_cut
        s1, s2 = s2, s1

    insert = seq[left_cut:right_cut].upper()
    left_oh = insert[:oh_len]
    right_oh = insert[-oh_len:]

    return DigestedPart(
        name=name,
        original_seq=seq,
        insert=insert,
        left_overhang=left_oh,
        right_overhang=right_oh,
        cut_sites=sites,
    )


# ---------------------------------------------------------------------------
# Overhang validation
# ---------------------------------------------------------------------------

def validate_overhangs(parts: list[DigestedPart]) -> list[str]:
    """Check for palindromic or duplicate overhangs. Return warning strings."""
    issues: list[str] = []
    seen: dict[str, str] = {}

    for p in parts:
        for oh, label in [(p.left_overhang, "left"), (p.right_overhang, "right")]:
            # Palindrome check
            if oh == reverse_complement(oh):
                issues.append(
                    f"Part '{p.name}' {label} overhang {oh} is palindromic "
                    f"(self-complementary) — may ligate in either orientation."
                )
            # Duplicate check
            key = oh
            if key in seen and seen[key] != f"{p.name}:{label}":
                issues.append(
                    f"Duplicate overhang {oh}: found in {seen[key]} and {p.name}:{label}."
                )
            seen[key] = f"{p.name}:{label}"

    return issues


# ---------------------------------------------------------------------------
# Assembly simulation
# ---------------------------------------------------------------------------

def assemble(parts: list[DigestedPart]) -> tuple[str, list[str]]:
    """Ligate digested parts by matching complementary overhangs.

    Returns (assembled_sequence, ordered_part_names).
    """
    if not parts:
        raise RuntimeError("No parts to assemble.")

    # Build a lookup: right_overhang -> part (each part's right OH matches
    # the next part's left OH)
    by_right: dict[str, DigestedPart] = {}
    by_left: dict[str, DigestedPart] = {}
    for p in parts:
        by_right[p.right_overhang] = p
        by_left[p.left_overhang] = p

    # Find the starting part: its left overhang is not the right overhang
    # of any other part
    all_right_ohs = {p.right_overhang for p in parts}
    starters = [p for p in parts if p.left_overhang not in all_right_ohs]

    if len(starters) == 0:
        # Circular assembly — pick first part
        starters = [parts[0]]
    if len(starters) > 1:
        raise RuntimeError(
            f"Ambiguous assembly: {len(starters)} potential start parts. "
            f"Check overhang design."
        )

    ordered: list[DigestedPart] = [starters[0]]
    used = {starters[0].name}
    current = starters[0]

    while len(ordered) < len(parts):
        next_oh = current.right_overhang
        nxt = by_left.get(next_oh)
        if nxt is None or nxt.name in used:
            break
        ordered.append(nxt)
        used.add(nxt.name)
        current = nxt

    if len(ordered) != len(parts):
        raise RuntimeError(
            f"Could only order {len(ordered)}/{len(parts)} parts. "
            f"Overhang chain is broken."
        )

    # Build assembled sequence: first part's full insert, then each
    # subsequent part's insert minus the shared overhang
    oh_len = len(ordered[0].left_overhang)
    assembled = ordered[0].insert
    for p in ordered[1:]:
        assembled += p.insert[oh_len:]  # skip the left overhang (already present)

    return assembled, [p.name for p in ordered]


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

def print_report(parts: list[DigestedPart], issues: list[str],
                 assembled: str, order: list[str]):
    print("=== Golden Gate Assembly Simulation ===\n")
    print(f"Parts: {len(parts)}")
    for p in parts:
        print(f"  {p.name}: insert {len(p.insert)} bp, "
              f"overhangs [{p.left_overhang}] ... [{p.right_overhang}]")

    print(f"\nAssembly order: {' -> '.join(order)}")
    print(f"Overhang pairs:")
    for i in range(len(parts) - 1):
        p_cur = next(p for p in parts if p.name == order[i])
        p_nxt = next(p for p in parts if p.name == order[i + 1])
        print(f"  {order[i]} [{p_cur.right_overhang}] <-> [{p_nxt.left_overhang}] {order[i+1]}")

    print(f"\nAssembled product: {len(assembled)} bp, "
          f"GC = {round(gc_fraction(assembled) * 100, 1)}%")

    if issues:
        print("\nWarnings:")
        for w in issues:
            print(f"  ! {w}")
    else:
        print("\nNo overhang issues detected.")


def save_outputs(assembled: str, parts: list[DigestedPart], order: list[str],
                 issues: list[str], outdir: str):
    os.makedirs(outdir, exist_ok=True)

    # Assembled FASTA
    rec = SeqRecord(
        Seq(assembled),
        id="assembled_product",
        description=f"len={len(assembled)} parts={len(parts)}",
    )
    fasta_path = os.path.join(outdir, "assembled.fasta")
    SeqIO.write(rec, fasta_path, "fasta")
    print(f"\nAssembled sequence saved to {fasta_path}")

    # Report CSV
    report_path = os.path.join(outdir, "assembly_report.csv")
    with open(report_path, "w", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["order", "part_name", "insert_length", "left_overhang", "right_overhang"])
        for idx, name in enumerate(order, 1):
            p = next(pp for pp in parts if pp.name == name)
            writer.writerow([idx, p.name, len(p.insert), p.left_overhang, p.right_overhang])
        writer.writerow([])
        writer.writerow(["assembled_length", len(assembled)])
        writer.writerow(["gc_pct", round(gc_fraction(assembled) * 100, 1)])
        if issues:
            writer.writerow([])
            writer.writerow(["warnings"])
            for w in issues:
                writer.writerow([w])
    print(f"Assembly report saved to {report_path}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Simulate Golden Gate (Type IIS) assembly of DNA parts."
    )
    p.add_argument(
        "--parts",
        required=True,
        help="Multi-FASTA file with parts carrying flanking Type IIS sites.",
    )
    p.add_argument(
        "--enzyme",
        default="BsaI",
        choices=list(ENZYME_DB.keys()),
        help="Type IIS enzyme (default: BsaI).",
    )
    p.add_argument(
        "--output-dir",
        default=None,
        help="Directory for output files (assembled FASTA + report).",
    )
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)

    if not os.path.isfile(args.parts):
        print(f"ERROR: Parts file not found: {args.parts}", file=sys.stderr)
        sys.exit(1)

    records = list(SeqIO.parse(args.parts, "fasta"))
    if len(records) < 2:
        print("ERROR: Need at least 2 parts for assembly.", file=sys.stderr)
        sys.exit(1)

    # Digest each part
    digested: list[DigestedPart] = []
    for rec in records:
        try:
            dp = digest_part(rec.id, str(rec.seq).upper(), args.enzyme)
            digested.append(dp)
        except ValueError as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            sys.exit(1)

    # Validate overhangs
    issues = validate_overhangs(digested)

    # Assemble
    try:
        assembled, order = assemble(digested)
    except RuntimeError as exc:
        print(f"ERROR: Assembly failed: {exc}", file=sys.stderr)
        sys.exit(1)

    # Report
    print_report(digested, issues, assembled, order)

    if args.output_dir:
        save_outputs(assembled, digested, order, issues, args.output_dir)


if __name__ == "__main__":
    main()
