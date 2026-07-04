#!/usr/bin/env python3
"""
Predict N-linked and O-linked glycosylation sites in protein sequences.

Scans for canonical N-glycosylation sequons (N-X-S/T where X != P) and
identifies O-glycosylation hotspot regions based on Ser/Thr density in
a sliding window. Accounts for proline-mediated suppression effects.

Usage:
    predict_glycosylation.py --sequence MNKTSLYIFLIFLAG --output-dir ./results
    predict_glycosylation.py --sequence protein.fasta --output-dir ./results --threshold 0.25

Examples:
    # Predict from inline sequence
    python predict_glycosylation.py --sequence "MKNSTLYNRTSGQPN" --output-dir ./glyc_out

    # Predict from FASTA file
    python predict_glycosylation.py --sequence myprotein.fasta --output-dir ./glyc_out

    # Adjust O-glycosylation density threshold
    python predict_glycosylation.py --sequence myprotein.fasta --output-dir ./glyc_out --threshold 0.25

    # Custom sliding window size
    python predict_glycosylation.py --sequence myprotein.fasta --output-dir ./glyc_out --window-size 15
"""

import argparse
import csv
import os
import re
import sys


def read_sequence(sequence_input):
    """Read protein sequence from a string or FASTA file.

    Parameters
    ----------
    sequence_input : str
        Either a raw amino acid string or a path to a FASTA file.

    Returns
    -------
    tuple
        (header, sequence) where header is the FASTA header or 'input_sequence'.
    """
    if os.path.isfile(sequence_input):
        return parse_fasta(sequence_input)
    seq = sequence_input.strip().upper()
    if not re.match(r"^[ACDEFGHIKLMNPQRSTVWY]+$", seq):
        raise ValueError(
            f"Invalid amino acid characters in sequence: "
            f"{set(seq) - set('ACDEFGHIKLMNPQRSTVWY')}"
        )
    return "input_sequence", seq


def parse_fasta(filepath):
    """Parse a single-record FASTA file.

    Parameters
    ----------
    filepath : str
        Path to a FASTA file.

    Returns
    -------
    tuple
        (header, sequence) for the first record found.

    Raises
    ------
    ValueError
        If the file contains no valid FASTA records.
    """
    header = None
    seq_lines = []
    with open(filepath, "r") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            if line.startswith(">"):
                if header is not None:
                    break
                header = line[1:].strip()
            else:
                seq_lines.append(line.upper())
    if header is None:
        header = os.path.basename(filepath)
    sequence = "".join(seq_lines)
    if not sequence:
        raise ValueError(f"No sequence data found in {filepath}")
    sequence = re.sub(r"[^A-Z]", "", sequence)
    return header, sequence


def predict_n_glycosylation(sequence):
    """Find N-glycosylation sequons (N-X-S/T, X != P).

    Also annotates cases where the position following S/T is proline,
    which may reduce glycosylation efficiency.

    Parameters
    ----------
    sequence : str
        Protein sequence in single-letter amino acid code.

    Returns
    -------
    list of dict
        Each dict contains: position (1-based), motif, flanking_sequence,
        confidence_note.
    """
    sites = []
    seq_len = len(sequence)
    for i in range(seq_len - 2):
        if sequence[i] != "N":
            continue
        x_residue = sequence[i + 1]
        st_residue = sequence[i + 2]
        if x_residue == "P":
            continue
        if st_residue not in ("S", "T"):
            continue
        motif = sequence[i : i + 3]
        flank_start = max(0, i - 5)
        flank_end = min(seq_len, i + 3 + 5)
        flanking = sequence[flank_start:flank_end]
        confidence = "canonical_sequon"
        if i + 3 < seq_len and sequence[i + 3] == "P":
            confidence = "reduced_efficiency_proline_after_sequon"
        if i > 0 and sequence[i - 1] == "P":
            confidence = "reduced_efficiency_proline_before_asn"
        sites.append(
            {
                "position": i + 1,
                "type": "N-glycosylation",
                "motif": motif,
                "flanking_sequence": flanking,
                "confidence_note": confidence,
            }
        )
    return sites


def predict_o_glycosylation_hotspots(sequence, window_size=11, threshold=0.3):
    """Identify O-glycosylation hotspot regions via Ser/Thr density.

    Uses a sliding window to calculate S+T density. Regions exceeding
    the threshold are merged and reported. Proline neighbors to S/T
    residues are noted as potentially reducing O-glycosylation probability.

    Parameters
    ----------
    sequence : str
        Protein sequence in single-letter amino acid code.
    window_size : int
        Size of the sliding window (default 11).
    threshold : float
        Minimum S+T fraction to flag a hotspot (default 0.3).

    Returns
    -------
    list of dict
        Each dict contains: position (center, 1-based), type, motif,
        flanking_sequence, confidence_note.
    """
    seq_len = len(sequence)
    if seq_len < window_size:
        return []

    hotspot_positions = set()
    half_w = window_size // 2

    for i in range(seq_len - window_size + 1):
        window = sequence[i : i + window_size]
        st_count = window.count("S") + window.count("T")
        density = st_count / window_size
        if density > threshold:
            for j in range(i, i + window_size):
                if sequence[j] in ("S", "T"):
                    hotspot_positions.add(j)

    sites = []
    for pos in sorted(hotspot_positions):
        flank_start = max(0, pos - 5)
        flank_end = min(seq_len, pos + 6)
        flanking = sequence[flank_start:flank_end]
        residue = sequence[pos]
        confidence = "o_glyc_hotspot"
        if pos > 0 and sequence[pos - 1] == "P":
            confidence = "reduced_probability_proline_neighbor"
        elif pos < seq_len - 1 and sequence[pos + 1] == "P":
            confidence = "reduced_probability_proline_neighbor"
        sites.append(
            {
                "position": pos + 1,
                "type": "O-glycosylation",
                "motif": residue,
                "flanking_sequence": flanking,
                "confidence_note": confidence,
            }
        )
    return sites


def merge_hotspot_regions(o_sites):
    """Merge adjacent O-glycosylation sites into contiguous regions.

    Parameters
    ----------
    o_sites : list of dict
        O-glycosylation site predictions sorted by position.

    Returns
    -------
    list of tuple
        Each tuple is (start_pos, end_pos) in 1-based coordinates.
    """
    if not o_sites:
        return []
    positions = [s["position"] for s in o_sites]
    regions = []
    start = positions[0]
    end = positions[0]
    for pos in positions[1:]:
        if pos <= end + 2:
            end = pos
        else:
            regions.append((start, end))
            start = pos
            end = pos
    regions.append((start, end))
    return regions


def build_annotated_sequence(sequence, n_sites, o_sites, line_width=60):
    """Build a text representation of the sequence with glycosylation annotations.

    N-glyc sites are marked with '^' below, O-glyc hotspots with 'o'.

    Parameters
    ----------
    sequence : str
        Protein sequence.
    n_sites : list of dict
        N-glycosylation predictions.
    o_sites : list of dict
        O-glycosylation predictions.
    line_width : int
        Characters per line for wrapping.

    Returns
    -------
    str
        Annotated sequence text.
    """
    n_positions = {s["position"] - 1 for s in n_sites}
    o_positions = {s["position"] - 1 for s in o_sites}

    annotation = []
    for i in range(len(sequence)):
        if i in n_positions and i in o_positions:
            annotation.append("*")
        elif i in n_positions:
            annotation.append("^")
        elif i in o_positions:
            annotation.append("o")
        else:
            annotation.append(" ")

    lines = []
    for start in range(0, len(sequence), line_width):
        end = min(start + line_width, len(sequence))
        pos_label = f"{start + 1:>6}"
        lines.append(f"{pos_label}  {sequence[start:end]}")
        ann_segment = "".join(annotation[start:end])
        if ann_segment.strip():
            lines.append(f"{'':>6}  {ann_segment}")
        lines.append("")

    legend = [
        "Legend: ^ = N-glycosylation sequon, o = O-glycosylation hotspot, * = both",
    ]
    return "\n".join(lines) + "\n" + "\n".join(legend)


def write_predictions_csv(filepath, all_sites):
    """Write prediction results to CSV.

    Parameters
    ----------
    filepath : str
        Output CSV file path.
    all_sites : list of dict
        Combined N- and O-glycosylation predictions.
    """
    fieldnames = ["position", "type", "motif", "flanking_sequence", "confidence_note"]
    with open(filepath, "w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        for site in sorted(all_sites, key=lambda s: s["position"]):
            writer.writerow(site)


def print_summary(header, sequence, n_sites, o_sites, o_regions):
    """Print prediction summary to stdout.

    Parameters
    ----------
    header : str
        Sequence identifier.
    sequence : str
        Protein sequence.
    n_sites : list of dict
        N-glycosylation predictions.
    o_sites : list of dict
        O-glycosylation predictions.
    o_regions : list of tuple
        Merged O-glycosylation hotspot regions.
    """
    print(f"Glycosylation Prediction Report")
    print(f"{'=' * 50}")
    print(f"Sequence: {header}")
    print(f"Length:   {len(sequence)} aa")
    print()
    print(f"N-glycosylation sites: {len(n_sites)}")
    if n_sites:
        for s in n_sites:
            note = ""
            if "reduced" in s["confidence_note"]:
                note = f"  ({s['confidence_note']})"
            print(
                f"  Position {s['position']:>5}: {s['motif']}  "
                f"flanking=[{s['flanking_sequence']}]{note}"
            )
    print()
    print(f"O-glycosylation hotspot residues: {len(o_sites)}")
    print(f"O-glycosylation hotspot regions:  {len(o_regions)}")
    if o_regions:
        for start, end in o_regions:
            print(f"  Region: {start}-{end} ({end - start + 1} residues)")
    pro_reduced = [s for s in o_sites if "proline" in s["confidence_note"]]
    if pro_reduced:
        print(f"  (of which {len(pro_reduced)} have proline-reduced probability)")
    print()
    total = len(n_sites) + len(o_sites)
    print(f"Total predicted glycosylation-related positions: {total}")


def main():
    parser = argparse.ArgumentParser(
        description="Predict N- and O-glycosylation sites in protein sequences.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Notes:\n"
            "  N-glycosylation: canonical N-X-S/T sequon (X != P)\n"
            "  O-glycosylation: sliding window S/T density analysis\n"
            "  Proline neighbors reduce glycosylation probability\n"
        ),
    )
    parser.add_argument(
        "--sequence",
        required=True,
        help="Protein sequence string or path to a FASTA file",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Directory for output files",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=0.3,
        help="O-glycosylation S/T density threshold (default: 0.3)",
    )
    parser.add_argument(
        "--window-size",
        type=int,
        default=11,
        help="Sliding window size for O-glycosylation (default: 11)",
    )
    args = parser.parse_args()

    try:
        header, sequence = read_sequence(args.sequence)
    except (ValueError, FileNotFoundError) as exc:
        print(f"Error reading sequence: {exc}", file=sys.stderr)
        sys.exit(1)

    if len(sequence) < 3:
        print("Error: sequence must be at least 3 residues long.", file=sys.stderr)
        sys.exit(1)

    n_sites = predict_n_glycosylation(sequence)
    o_sites = predict_o_glycosylation_hotspots(
        sequence, window_size=args.window_size, threshold=args.threshold
    )
    o_regions = merge_hotspot_regions(o_sites)

    os.makedirs(args.output_dir, exist_ok=True)

    csv_path = os.path.join(args.output_dir, "glycosylation_predictions.csv")
    write_predictions_csv(csv_path, n_sites + o_sites)

    annotated_path = os.path.join(args.output_dir, "annotated_sequence.txt")
    annotated_text = build_annotated_sequence(sequence, n_sites, o_sites)
    with open(annotated_path, "w") as fh:
        fh.write(f">{header}\n")
        fh.write(annotated_text)

    print_summary(header, sequence, n_sites, o_sites, o_regions)
    print()
    print(f"Output files:")
    print(f"  Predictions CSV:     {csv_path}")
    print(f"  Annotated sequence:  {annotated_path}")


if __name__ == "__main__":
    main()
