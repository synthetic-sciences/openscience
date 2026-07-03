#!/usr/bin/env python3
"""
Parse and Filter VCF Files for Variant Analysis

Reads VCF files using cyvcf2 (with pyvcf3 fallback), extracts variant
information (CHROM, POS, REF, ALT, QUAL, depth, allele frequency), and
applies quality/depth/AF filters. Optionally restricts to variants in a
user-supplied gene list using SnpEff/VEP ANN annotations.

Usage:
    python parse_vcf.py --vcf sample.vcf.gz --output filtered.csv
    python parse_vcf.py --vcf sample.vcf --min-qual 50 --min-depth 20 --min-af 0.10
    python parse_vcf.py --vcf tumor.vcf.gz --gene-list genes.txt --output coding_variants.csv

Examples:
    # Basic filter with defaults (QUAL>=30, DP>=10, AF>=0.05)
    python parse_vcf.py --vcf somatic.vcf.gz --output filtered.csv

    # Strict filtering for high-confidence calls
    python parse_vcf.py --vcf somatic.vcf.gz --min-qual 100 --min-depth 30 --min-af 0.15

    # Restrict to a panel of cancer driver genes
    python parse_vcf.py --vcf wes.vcf.gz --gene-list cancer_drivers.txt --output drivers.csv

Dependencies: cyvcf2 (preferred) or pyvcf3, pandas, numpy
"""

import argparse
import csv
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd


# ---------------------------------------------------------------------------
# VCF reader abstraction
# ---------------------------------------------------------------------------

def _try_import_cyvcf2():
    """Attempt to import cyvcf2; return module or None."""
    try:
        import cyvcf2
        return cyvcf2
    except ImportError:
        return None


def _try_import_pyvcf3():
    """Attempt to import pyvcf3 (vcf module); return module or None."""
    try:
        import vcf  # pyvcf3
        return vcf
    except ImportError:
        return None


def _classify_variant(ref, alt):
    """Classify a variant as SNV, insertion, deletion, or MNV."""
    if len(ref) == 1 and len(alt) == 1:
        return "SNV"
    if len(ref) == 1 and len(alt) > 1:
        return "insertion"
    if len(ref) > 1 and len(alt) == 1:
        return "deletion"
    if len(ref) > 1 and len(alt) > 1:
        return "MNV"
    return "unknown"


def _extract_genes_from_ann(ann_string):
    """
    Extract gene names from a SnpEff/VEP ANN INFO field value.

    ANN format (pipe-separated): Allele|Annotation|Impact|Gene_Name|...
    Multiple annotations are comma-separated.
    """
    genes = set()
    if not ann_string:
        return genes
    for annotation in str(ann_string).split(","):
        fields = annotation.split("|")
        if len(fields) >= 4:
            gene = fields[3].strip()
            if gene:
                genes.add(gene)
    return genes


# ---------------------------------------------------------------------------
# Core parsing with cyvcf2
# ---------------------------------------------------------------------------

def parse_vcf_cyvcf2(vcf_path, min_qual, min_depth, min_af, gene_set):
    """Parse VCF using cyvcf2 and apply filters."""
    cyvcf2 = _try_import_cyvcf2()
    if cyvcf2 is None:
        raise ImportError("cyvcf2 is not installed")

    reader = cyvcf2.VCF(str(vcf_path))
    records = []
    total = 0
    skipped_qual = 0
    skipped_depth = 0
    skipped_af = 0
    skipped_gene = 0

    for variant in reader:
        total += 1

        # Quality filter
        qual = variant.QUAL
        if qual is None or qual < min_qual:
            skipped_qual += 1
            continue

        # Depth — try INFO/DP first, then FORMAT/DP for first sample
        dp = variant.INFO.get("DP")
        if dp is None and variant.num_het + variant.num_hom_alt + variant.num_hom_ref > 0:
            try:
                dp_arr = variant.format("DP")
                if dp_arr is not None:
                    dp = int(dp_arr[0][0])
            except (KeyError, IndexError, TypeError):
                dp = None
        if dp is not None and dp < min_depth:
            skipped_depth += 1
            continue

        # Allele frequency — try INFO/AF, then compute from FORMAT/AD
        af = variant.INFO.get("AF")
        if isinstance(af, (tuple, list)):
            af = af[0]
        if af is None:
            try:
                ad = variant.format("AD")
                if ad is not None and ad.shape[1] >= 2:
                    ref_count = int(ad[0][0])
                    alt_count = int(ad[0][1])
                    total_count = ref_count + alt_count
                    af = alt_count / total_count if total_count > 0 else 0.0
            except (KeyError, IndexError, TypeError):
                af = None
        if af is not None and af < min_af:
            skipped_af += 1
            continue

        # Gene filter via ANN
        ann_value = variant.INFO.get("ANN")
        genes_in_variant = set()
        if ann_value:
            genes_in_variant = _extract_genes_from_ann(ann_value)

        if gene_set and not genes_in_variant.intersection(gene_set):
            skipped_gene += 1
            continue

        # Build record for each ALT allele
        for i, alt_allele in enumerate(variant.ALT):
            alt_str = str(alt_allele)
            vtype = _classify_variant(variant.REF, alt_str)
            records.append({
                "CHROM": variant.CHROM,
                "POS": variant.POS,
                "REF": variant.REF,
                "ALT": alt_str,
                "QUAL": qual,
                "DP": dp if dp is not None else np.nan,
                "AF": round(af, 4) if af is not None else np.nan,
                "TYPE": vtype,
                "GENES": ",".join(sorted(genes_in_variant)) if genes_in_variant else "",
            })

    reader.close()

    stats = {
        "total": total,
        "skipped_qual": skipped_qual,
        "skipped_depth": skipped_depth,
        "skipped_af": skipped_af,
        "skipped_gene": skipped_gene,
    }
    return records, stats


# ---------------------------------------------------------------------------
# Core parsing with pyvcf3 (fallback)
# ---------------------------------------------------------------------------

def parse_vcf_pyvcf3(vcf_path, min_qual, min_depth, min_af, gene_set):
    """Parse VCF using pyvcf3 and apply filters."""
    vcf_mod = _try_import_pyvcf3()
    if vcf_mod is None:
        raise ImportError("pyvcf3 is not installed")

    reader = vcf_mod.Reader(filename=str(vcf_path))
    records = []
    total = 0
    skipped_qual = 0
    skipped_depth = 0
    skipped_af = 0
    skipped_gene = 0

    for record in reader:
        total += 1

        # Quality
        qual = record.QUAL
        if qual is None or qual < min_qual:
            skipped_qual += 1
            continue

        # Depth
        dp = record.INFO.get("DP")
        if isinstance(dp, list):
            dp = dp[0]
        if dp is None and record.samples:
            sample = record.samples[0]
            try:
                dp = sample["DP"]
            except (KeyError, AttributeError):
                dp = None
        if dp is not None and dp < min_depth:
            skipped_depth += 1
            continue

        # AF
        af = record.INFO.get("AF")
        if isinstance(af, list):
            af = af[0]
        if af is None and record.samples:
            sample = record.samples[0]
            try:
                ad = sample["AD"]
                if ad and len(ad) >= 2:
                    total_count = sum(ad)
                    af = ad[1] / total_count if total_count > 0 else 0.0
            except (KeyError, AttributeError, TypeError):
                af = None
        if af is not None and af < min_af:
            skipped_af += 1
            continue

        # Gene filter
        ann_value = record.INFO.get("ANN")
        genes_in_variant = set()
        if ann_value:
            ann_str = ann_value if isinstance(ann_value, str) else ",".join(str(a) for a in ann_value)
            genes_in_variant = _extract_genes_from_ann(ann_str)

        if gene_set and not genes_in_variant.intersection(gene_set):
            skipped_gene += 1
            continue

        for alt_allele in record.ALT:
            alt_str = str(alt_allele)
            vtype = _classify_variant(str(record.REF), alt_str)
            records.append({
                "CHROM": record.CHROM,
                "POS": record.POS,
                "REF": str(record.REF),
                "ALT": alt_str,
                "QUAL": qual,
                "DP": dp if dp is not None else np.nan,
                "AF": round(af, 4) if af is not None else np.nan,
                "TYPE": vtype,
                "GENES": ",".join(sorted(genes_in_variant)) if genes_in_variant else "",
            })

    stats = {
        "total": total,
        "skipped_qual": skipped_qual,
        "skipped_depth": skipped_depth,
        "skipped_af": skipped_af,
        "skipped_gene": skipped_gene,
    }
    return records, stats


# ---------------------------------------------------------------------------
# Unified parser
# ---------------------------------------------------------------------------

def parse_vcf(vcf_path, min_qual=30, min_depth=10, min_af=0.05, gene_list_path=None):
    """
    Parse and filter a VCF file.

    Parameters:
        vcf_path: Path to VCF (or VCF.gz) file.
        min_qual: Minimum QUAL score to keep a variant.
        min_depth: Minimum read depth (DP) to keep a variant.
        min_af: Minimum allele frequency to keep a variant.
        gene_list_path: Optional path to a file with one gene name per line.

    Returns:
        (DataFrame of filtered variants, dict of filter statistics)
    """
    vcf_path = Path(vcf_path)
    if not vcf_path.exists():
        raise FileNotFoundError(f"VCF file not found: {vcf_path}")

    gene_set = set()
    if gene_list_path:
        gene_list_path = Path(gene_list_path)
        if not gene_list_path.exists():
            raise FileNotFoundError(f"Gene list file not found: {gene_list_path}")
        with open(gene_list_path) as fh:
            for line in fh:
                gene = line.strip()
                if gene and not gene.startswith("#"):
                    gene_set.add(gene)
        print(f"Gene filter active: {len(gene_set)} genes loaded")

    # Try cyvcf2 first, fall back to pyvcf3
    try:
        records, stats = parse_vcf_cyvcf2(vcf_path, min_qual, min_depth, min_af, gene_set)
        print("VCF parser: cyvcf2")
    except ImportError:
        try:
            records, stats = parse_vcf_pyvcf3(vcf_path, min_qual, min_depth, min_af, gene_set)
            print("VCF parser: pyvcf3")
        except ImportError:
            print("ERROR: Neither cyvcf2 nor pyvcf3 is installed.", file=sys.stderr)
            print("Install one with:", file=sys.stderr)
            print("  pip install cyvcf2", file=sys.stderr)
            print("  pip install pyvcf3", file=sys.stderr)
            sys.exit(1)

    df = pd.DataFrame(records)
    return df, stats


def print_summary(df, stats):
    """Print a human-readable summary of filtering results."""
    passed = len(df)
    total = stats["total"]

    print("\n" + "=" * 60)
    print("VCF FILTERING SUMMARY")
    print("=" * 60)
    print(f"Total variants in VCF:      {total:>8,}")
    print(f"Passed all filters:         {passed:>8,}")
    print(f"  Removed by QUAL filter:   {stats['skipped_qual']:>8,}")
    print(f"  Removed by depth filter:  {stats['skipped_depth']:>8,}")
    print(f"  Removed by AF filter:     {stats['skipped_af']:>8,}")
    if stats["skipped_gene"] > 0:
        print(f"  Removed by gene filter:   {stats['skipped_gene']:>8,}")

    if not df.empty:
        print(f"\nVariant type breakdown (passed):")
        type_counts = df["TYPE"].value_counts()
        for vtype, count in type_counts.items():
            print(f"  {vtype:<12s}: {count:>6,}")

        if "QUAL" in df.columns and not df["QUAL"].isna().all():
            print(f"\nQuality scores (passed): "
                  f"median={df['QUAL'].median():.1f}, "
                  f"mean={df['QUAL'].mean():.1f}, "
                  f"range=[{df['QUAL'].min():.1f}, {df['QUAL'].max():.1f}]")

        if "AF" in df.columns and not df["AF"].isna().all():
            af_valid = df["AF"].dropna()
            if len(af_valid) > 0:
                print(f"Allele frequency (passed): "
                      f"median={af_valid.median():.4f}, "
                      f"mean={af_valid.mean():.4f}, "
                      f"range=[{af_valid.min():.4f}, {af_valid.max():.4f}]")

        # Chromosome distribution
        print(f"\nTop chromosomes:")
        chrom_counts = df["CHROM"].value_counts().head(5)
        for chrom, count in chrom_counts.items():
            print(f"  {chrom:<8s}: {count:>6,}")
    else:
        print("\nNo variants passed filters.")

    print("=" * 60)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Parse and filter VCF files for variant analysis.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --vcf somatic.vcf.gz --output filtered.csv
  %(prog)s --vcf tumor.vcf --min-qual 50 --min-depth 20 --min-af 0.10
  %(prog)s --vcf wes.vcf.gz --gene-list drivers.txt --output panel.csv
        """,
    )
    parser.add_argument("--vcf", required=True, help="Path to input VCF or VCF.gz file")
    parser.add_argument("--min-qual", type=float, default=30.0,
                        help="Minimum QUAL score (default: 30)")
    parser.add_argument("--min-depth", type=int, default=10,
                        help="Minimum read depth DP (default: 10)")
    parser.add_argument("--min-af", type=float, default=0.05,
                        help="Minimum allele frequency (default: 0.05)")
    parser.add_argument("--gene-list", default=None,
                        help="Path to file with gene names (one per line) to filter on")
    parser.add_argument("--output", default=None,
                        help="Output CSV path (default: <vcf_stem>_filtered.csv)")

    args = parser.parse_args()

    vcf_path = Path(args.vcf)
    output_path = args.output
    if output_path is None:
        stem = vcf_path.stem
        if stem.endswith(".vcf"):
            stem = stem[:-4]
        output_path = vcf_path.parent / f"{stem}_filtered.csv"
    else:
        output_path = Path(output_path)

    print(f"Input VCF:   {vcf_path}")
    print(f"Filters:     QUAL>={args.min_qual}, DP>={args.min_depth}, AF>={args.min_af}")
    if args.gene_list:
        print(f"Gene list:   {args.gene_list}")
    print(f"Output:      {output_path}")

    df, stats = parse_vcf(
        vcf_path,
        min_qual=args.min_qual,
        min_depth=args.min_depth,
        min_af=args.min_af,
        gene_list_path=args.gene_list,
    )

    # Save
    output_path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(output_path, index=False)
    print(f"\nFiltered variants saved to: {output_path}")

    print_summary(df, stats)


if __name__ == "__main__":
    main()
