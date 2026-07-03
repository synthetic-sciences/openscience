#!/usr/bin/env python3
"""ATAC-seq peak calling wrapper using MACS2.

Builds and executes MACS2 callpeak with standard ATAC-seq parameters
(--nomodel --shift -100 --extsize 200). Parses the narrowPeak output
to report peak statistics including total count, size distribution,
and chromosomal distribution.

Optionally runs MACS2 bdgdiff for differential peak analysis when
both treatment and control BAM files are provided.

Usage:
    python atac_peaks.py --treatment sample.bam --output-dir peaks/

Examples:
    # Basic ATAC-seq peak calling (human genome)
    python atac_peaks.py --treatment atac_sample.bam --output-dir atac_peaks

    # With control and mouse genome
    python atac_peaks.py --treatment atac_treat.bam --control atac_input.bam \\
        --genome-size mm --qvalue 0.01 --name experiment1 --output-dir peaks

    # Drosophila genome with custom prefix
    python atac_peaks.py --treatment fly_atac.bam --genome-size dm --name fly_exp \\
        --output-dir fly_peaks
"""

import argparse
import os
import subprocess
import sys

import numpy as np
import pandas as pd


GENOME_SIZE_MAP = {
    "hs": "hs",
    "mm": "mm",
    "dm": "dm",
    "ce": "ce",
}


def check_macs2():
    """Verify that MACS2 is installed and accessible.

    Returns
    -------
    str
        MACS2 version string.

    Raises
    ------
    RuntimeError
        If MACS2 is not found.
    """
    try:
        result = subprocess.run(
            ["macs2", "--version"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        version = result.stdout.strip() or result.stderr.strip()
        return version
    except FileNotFoundError:
        raise RuntimeError(
            "MACS2 not found. Install with: pip install macs2\n"
            "Or: conda install -c bioconda macs2"
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("MACS2 version check timed out.")


def build_callpeak_command(treatment, control, genome_size, qvalue, output_dir, name):
    """Build the MACS2 callpeak command for ATAC-seq.

    Uses standard ATAC-seq parameters:
      --nomodel: skip model building
      --shift -100: shift reads 100bp upstream
      --extsize 200: extend reads to 200bp (centers on Tn5 cut site)
      --keep-dup all: keep PCR duplicates (pre-dedup assumed)
      -B: generate bedGraph tracks

    Parameters
    ----------
    treatment : str
        Path to treatment BAM file.
    control : str or None
        Path to control BAM file, or None.
    genome_size : str
        MACS2 genome size string (hs, mm, dm, or numeric).
    qvalue : float
        Q-value threshold for peak calling.
    output_dir : str
        Output directory path.
    name : str
        Prefix for output files.

    Returns
    -------
    list of str
        Command as list of arguments.
    """
    cmd = [
        "macs2", "callpeak",
        "-t", treatment,
        "-f", "BAMPE",
        "-g", genome_size,
        "--nomodel",
        "--shift", "-100",
        "--extsize", "200",
        "--keep-dup", "all",
        "-q", str(qvalue),
        "--outdir", output_dir,
        "-n", name,
        "-B",
        "--call-summits",
    ]

    if control:
        cmd.extend(["-c", control])

    return cmd


def run_macs2(cmd):
    """Execute the MACS2 command.

    Parameters
    ----------
    cmd : list of str
        MACS2 command arguments.

    Returns
    -------
    subprocess.CompletedProcess
        Completed process result.

    Raises
    ------
    RuntimeError
        If MACS2 returns a non-zero exit code.
    """
    print(f"Running: {' '.join(cmd)}")

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=3600,
    )

    if result.stdout:
        for line in result.stdout.strip().split("\n")[:20]:
            print(f"  [MACS2] {line}")

    if result.stderr:
        for line in result.stderr.strip().split("\n")[:20]:
            print(f"  [MACS2 stderr] {line}")

    if result.returncode != 0:
        raise RuntimeError(
            f"MACS2 failed with exit code {result.returncode}.\n"
            f"stderr: {result.stderr[:500]}"
        )

    return result


def parse_narrowpeak(peak_file):
    """Parse MACS2 narrowPeak output file.

    NarrowPeak format (BED6+4):
        chrom, start, end, name, score, strand, signalValue, pValue, qValue, peak

    Parameters
    ----------
    peak_file : str
        Path to the narrowPeak file.

    Returns
    -------
    pd.DataFrame
        Parsed peaks with calculated width column.

    Raises
    ------
    FileNotFoundError
        If peak file does not exist.
    """
    if not os.path.isfile(peak_file):
        raise FileNotFoundError(f"Peak file not found: {peak_file}")

    columns = [
        "chrom", "start", "end", "name", "score", "strand",
        "signal_value", "p_value", "q_value", "peak_offset",
    ]

    df = pd.read_csv(peak_file, sep="\t", header=None, names=columns, comment="#")
    df["width"] = df["end"] - df["start"]

    return df


def report_peak_statistics(peaks):
    """Report summary statistics for called peaks.

    Parameters
    ----------
    peaks : pd.DataFrame
        Parsed narrowPeak dataframe with 'width' and 'chrom' columns.

    Returns
    -------
    dict
        Dictionary of statistics.
    """
    stats = {
        "total_peaks": len(peaks),
        "median_width": int(np.median(peaks["width"])),
        "mean_width": float(np.mean(peaks["width"])),
        "min_width": int(peaks["width"].min()),
        "max_width": int(peaks["width"].max()),
        "q25_width": int(np.percentile(peaks["width"], 25)),
        "q75_width": int(np.percentile(peaks["width"], 75)),
    }

    if "signal_value" in peaks.columns:
        stats["median_signal"] = float(np.median(peaks["signal_value"]))
        stats["max_signal"] = float(peaks["signal_value"].max())

    if "q_value" in peaks.columns:
        stats["median_qvalue"] = float(np.median(peaks["q_value"]))

    return stats


def report_chromosome_distribution(peaks, top_n=10):
    """Report peak counts per chromosome.

    Parameters
    ----------
    peaks : pd.DataFrame
        Parsed narrowPeak dataframe.
    top_n : int
        Number of top chromosomes to report.

    Returns
    -------
    pd.DataFrame
        Chromosome counts sorted descending.
    """
    chrom_counts = peaks["chrom"].value_counts().reset_index()
    chrom_counts.columns = ["chromosome", "peak_count"]
    chrom_counts["pct"] = 100.0 * chrom_counts["peak_count"] / len(peaks)
    return chrom_counts.head(top_n)


def run_bdgdiff(treatment_bdg, control_bdg, output_dir, name):
    """Run MACS2 bdgdiff for differential peak analysis.

    Parameters
    ----------
    treatment_bdg : str
        Path to treatment bedGraph file from callpeak.
    control_bdg : str
        Path to control bedGraph file from callpeak.
    output_dir : str
        Output directory.
    name : str
        Prefix for output files.

    Returns
    -------
    bool
        True if bdgdiff ran successfully, False otherwise.
    """
    if not os.path.isfile(treatment_bdg):
        print(f"WARNING: Treatment bedGraph not found: {treatment_bdg}")
        return False

    if not os.path.isfile(control_bdg):
        print(f"WARNING: Control bedGraph not found: {control_bdg}")
        return False

    cmd = [
        "macs2", "bdgdiff",
        "--t1", treatment_bdg,
        "--c1", control_bdg,
        "--outdir", output_dir,
        "-o",
        f"{name}_diff_cond1.bed",
        f"{name}_diff_cond2.bed",
        f"{name}_diff_common.bed",
    ]

    print(f"\nRunning differential analysis: {' '.join(cmd)}")

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)

        if result.returncode != 0:
            print(f"WARNING: bdgdiff failed: {result.stderr[:300]}")
            return False

        for suffix in ["cond1", "cond2", "common"]:
            bed_path = os.path.join(output_dir, f"{name}_diff_{suffix}.bed")
            if os.path.isfile(bed_path):
                n_lines = sum(1 for _ in open(bed_path))
                print(f"  Differential {suffix}: {n_lines} regions")

        return True

    except subprocess.TimeoutExpired:
        print("WARNING: bdgdiff timed out.")
        return False


def main():
    parser = argparse.ArgumentParser(
        description="ATAC-seq peak calling wrapper using MACS2."
    )
    parser.add_argument(
        "--treatment",
        required=True,
        help="Path to treatment BAM file.",
    )
    parser.add_argument(
        "--control",
        default=None,
        help="Path to control/input BAM file (optional).",
    )
    parser.add_argument(
        "--genome-size",
        default="hs",
        help="Effective genome size: hs (human), mm (mouse), dm (fly), or numeric value (default: hs).",
    )
    parser.add_argument(
        "--qvalue",
        type=float,
        default=0.05,
        help="Q-value (FDR) threshold for peak calling (default: 0.05).",
    )
    parser.add_argument(
        "--output-dir",
        default="atac_peaks_output",
        help="Output directory (default: atac_peaks_output).",
    )
    parser.add_argument(
        "--name",
        default="atac",
        help="Prefix for output files (default: atac).",
    )
    args = parser.parse_args()

    if not os.path.isfile(args.treatment):
        print(f"ERROR: Treatment BAM file not found: {args.treatment}", file=sys.stderr)
        sys.exit(1)

    if args.control and not os.path.isfile(args.control):
        print(f"ERROR: Control BAM file not found: {args.control}", file=sys.stderr)
        sys.exit(1)

    gsize = GENOME_SIZE_MAP.get(args.genome_size, args.genome_size)

    os.makedirs(args.output_dir, exist_ok=True)

    print("=" * 60)
    print("ATAC-seq PEAK CALLING")
    print("=" * 60)
    print(f"Treatment: {args.treatment}")
    print(f"Control:   {args.control or 'None'}")
    print(f"Genome:    {gsize}")
    print(f"Q-value:   {args.qvalue}")
    print(f"Prefix:    {args.name}")

    try:
        version = check_macs2()
        print(f"MACS2:     {version}")
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    cmd = build_callpeak_command(
        args.treatment, args.control, gsize, args.qvalue, args.output_dir, args.name
    )

    print(f"\n{'CALLING PEAKS':=^60}")
    try:
        run_macs2(cmd)
    except (RuntimeError, subprocess.TimeoutExpired) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    peak_file = os.path.join(args.output_dir, f"{args.name}_peaks.narrowPeak")

    try:
        peaks = parse_narrowpeak(peak_file)
    except FileNotFoundError:
        print(f"ERROR: Expected peak file not found: {peak_file}", file=sys.stderr)
        print("Check MACS2 output above for errors.")
        sys.exit(1)

    if peaks.empty:
        print("\nWARNING: No peaks were called. Consider adjusting q-value threshold.")
        sys.exit(0)

    stats = report_peak_statistics(peaks)

    print(f"\n{'PEAK STATISTICS':=^60}")
    print(f"\n  Total peaks:       {stats['total_peaks']:,}")
    print(f"  Median peak width: {stats['median_width']:,} bp")
    print(f"  Mean peak width:   {stats['mean_width']:.0f} bp")
    print(f"  Width range:       {stats['min_width']:,} - {stats['max_width']:,} bp")
    print(f"  Width IQR:         {stats['q25_width']:,} - {stats['q75_width']:,} bp")

    if "median_signal" in stats:
        print(f"  Median signal:     {stats['median_signal']:.2f}")
        print(f"  Max signal:        {stats['max_signal']:.2f}")

    chrom_dist = report_chromosome_distribution(peaks)
    print(f"\n  Top chromosomes by peak count:")
    for _, row in chrom_dist.iterrows():
        print(f"    {row['chromosome']:<10} {row['peak_count']:>6,} peaks ({row['pct']:.1f}%)")

    if args.control:
        print(f"\n{'DIFFERENTIAL ANALYSIS':=^60}")
        treat_bdg = os.path.join(args.output_dir, f"{args.name}_treat_pileup.bdg")
        ctrl_bdg = os.path.join(args.output_dir, f"{args.name}_control_lambda.bdg")
        run_bdgdiff(treat_bdg, ctrl_bdg, args.output_dir, args.name)

    print(f"\nOutput directory: {args.output_dir}")
    for fname in sorted(os.listdir(args.output_dir)):
        fpath = os.path.join(args.output_dir, fname)
        size = os.path.getsize(fpath)
        if size > 1024 * 1024:
            size_str = f"{size / (1024 * 1024):.1f} MB"
        elif size > 1024:
            size_str = f"{size / 1024:.1f} KB"
        else:
            size_str = f"{size} B"
        print(f"  {fname:<40} {size_str}")

    print("\n" + "=" * 60)
    print("PEAK CALLING COMPLETE")
    print("=" * 60)


if __name__ == "__main__":
    main()
