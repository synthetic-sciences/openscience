#!/usr/bin/env python3
"""
Calculate Tumor Mutational Burden (TMB) from a VCF File

Counts nonsynonymous coding mutations (missense, nonsense, frameshift) using
SnpEff/VEP ANN annotations and normalizes by the genomic region size to
produce a TMB score in mutations per megabase (mut/Mb). Supports both
whole-genome/exome (default 38 Mb) and targeted panel workflows (via BED).

Usage:
    python calculate_tmb.py --vcf somatic.vcf.gz
    python calculate_tmb.py --vcf panel.vcf.gz --target-bed panel_regions.bed
    python calculate_tmb.py --vcf tumor.vcf --min-af 0.10 --output-dir results/

Examples:
    # WGS with default genome size (38 Mb coding region)
    python calculate_tmb.py --vcf wgs_somatic.vcf.gz --output-dir tmb_results/

    # Targeted panel with BED file defining covered regions
    python calculate_tmb.py --vcf panel.vcf.gz --target-bed panel.bed --output-dir tmb_results/

    # Stricter filtering
    python calculate_tmb.py --vcf tumor.vcf.gz --min-af 0.10 --min-depth 30

Dependencies: cyvcf2 (preferred) or pyvcf3, pandas, numpy
"""

import argparse
import json
import os
import sys
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd


# ---------------------------------------------------------------------------
# ANN parsing helpers
# ---------------------------------------------------------------------------

# SnpEff ANN consequence terms that count as nonsynonymous coding
NONSYNONYMOUS_TERMS = {
    # SnpEff terms
    "missense_variant",
    "nonsense_variant",
    "stop_gained",
    "stop_lost",
    "start_lost",
    "frameshift_variant",
    "splice_acceptor_variant",
    "splice_donor_variant",
    "disruptive_inframe_insertion",
    "disruptive_inframe_deletion",
    "inframe_insertion",
    "inframe_deletion",
    # VEP terms (some overlap)
    "missense_variant",
    "stop_gained",
    "stop_lost",
    "start_lost",
    "frameshift_variant",
    "splice_acceptor_variant",
    "splice_donor_variant",
    "protein_altering_variant",
}

# Broader set of all coding consequences (including synonymous)
CODING_TERMS = NONSYNONYMOUS_TERMS | {
    "synonymous_variant",
    "initiator_codon_variant",
    "coding_sequence_variant",
}


def parse_ann_field(ann_string):
    """
    Parse a SnpEff/VEP ANN INFO field value.

    Returns list of dicts with keys: allele, annotation, impact, gene, feature_type,
    feature_id, biotype, hgvs_c, hgvs_p.
    """
    annotations = []
    if not ann_string:
        return annotations

    for entry in str(ann_string).split(","):
        fields = entry.split("|")
        if len(fields) < 4:
            continue
        annotations.append({
            "allele": fields[0].strip(),
            "annotation": fields[1].strip(),
            "impact": fields[2].strip(),
            "gene": fields[3].strip(),
            "feature_type": fields[4].strip() if len(fields) > 4 else "",
            "feature_id": fields[5].strip() if len(fields) > 5 else "",
            "biotype": fields[7].strip() if len(fields) > 7 else "",
            "hgvs_c": fields[9].strip() if len(fields) > 9 else "",
            "hgvs_p": fields[10].strip() if len(fields) > 10 else "",
        })
    return annotations


def classify_mutation(ann_annotations):
    """
    From a list of ANN annotations for one variant, determine the most
    impactful nonsynonymous consequence category.

    Returns: (is_nonsynonymous: bool, category: str, gene: str, detail: str)
    """
    best_category = None
    best_gene = ""
    best_detail = ""

    impact_rank = {"HIGH": 4, "MODERATE": 3, "LOW": 2, "MODIFIER": 1}

    for ann in ann_annotations:
        consequences = [c.strip() for c in ann["annotation"].split("&")]
        for csq in consequences:
            if csq in NONSYNONYMOUS_TERMS:
                rank = impact_rank.get(ann["impact"], 0)
                if best_category is None or rank > impact_rank.get(best_category, 0):
                    # Map to a readable category
                    if csq in ("missense_variant", "protein_altering_variant"):
                        best_category = "missense"
                    elif csq in ("stop_gained", "nonsense_variant", "stop_lost", "start_lost"):
                        best_category = "nonsense"
                    elif csq == "frameshift_variant":
                        best_category = "frameshift"
                    elif csq in ("splice_acceptor_variant", "splice_donor_variant"):
                        best_category = "splice_site"
                    elif "inframe" in csq:
                        best_category = "inframe_indel"
                    else:
                        best_category = csq
                    best_gene = ann["gene"]
                    best_detail = ann.get("hgvs_p", "")
                    # HIGH is max, stop early
                    if rank == 4:
                        return True, best_category, best_gene, best_detail

    if best_category is not None:
        return True, best_category, best_gene, best_detail
    return False, "non_coding_or_synonymous", "", ""


# ---------------------------------------------------------------------------
# BED interval helpers
# ---------------------------------------------------------------------------

def calculate_bed_coverage(bed_path):
    """
    Calculate total covered region size in megabases from a BED file.

    Handles overlapping intervals by merging them per chromosome.
    Returns: total covered bases, total covered Mb
    """
    bed_path = Path(bed_path)
    if not bed_path.exists():
        raise FileNotFoundError(f"BED file not found: {bed_path}")

    intervals = {}
    with open(bed_path) as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or line.startswith("track") or line.startswith("browser"):
                continue
            parts = line.split("\t")
            if len(parts) < 3:
                continue
            chrom = parts[0]
            start = int(parts[1])
            end = int(parts[2])
            intervals.setdefault(chrom, []).append((start, end))

    # Merge overlapping intervals per chromosome
    total_bases = 0
    for chrom in intervals:
        sorted_ivs = sorted(intervals[chrom])
        merged = [sorted_ivs[0]]
        for start, end in sorted_ivs[1:]:
            if start <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(merged[-1][1], end))
            else:
                merged.append((start, end))
        for start, end in merged:
            total_bases += end - start

    total_mb = total_bases / 1_000_000
    return total_bases, total_mb


# ---------------------------------------------------------------------------
# VCF parsing
# ---------------------------------------------------------------------------

def _try_import_cyvcf2():
    try:
        import cyvcf2
        return cyvcf2
    except ImportError:
        return None


def _try_import_pyvcf3():
    try:
        import vcf
        return vcf
    except ImportError:
        return None


def parse_variants_cyvcf2(vcf_path, min_af, min_depth):
    """Parse VCF with cyvcf2 and classify each variant."""
    cyvcf2 = _try_import_cyvcf2()
    if cyvcf2 is None:
        raise ImportError("cyvcf2 not installed")

    reader = cyvcf2.VCF(str(vcf_path))
    mutations = []
    total = 0
    filtered = 0

    for variant in reader:
        total += 1

        # Depth filter
        dp = variant.INFO.get("DP")
        if dp is None:
            try:
                dp_arr = variant.format("DP")
                if dp_arr is not None:
                    dp = int(dp_arr[0][0])
            except (KeyError, IndexError, TypeError):
                dp = None
        if dp is not None and dp < min_depth:
            filtered += 1
            continue

        # AF filter
        af = variant.INFO.get("AF")
        if isinstance(af, (tuple, list)):
            af = af[0]
        if af is None:
            try:
                ad = variant.format("AD")
                if ad is not None and ad.shape[1] >= 2:
                    ref_c = int(ad[0][0])
                    alt_c = int(ad[0][1])
                    tot = ref_c + alt_c
                    af = alt_c / tot if tot > 0 else 0.0
            except (KeyError, IndexError, TypeError):
                af = None
        if af is not None and af < min_af:
            filtered += 1
            continue

        # Parse ANN
        ann_value = variant.INFO.get("ANN")
        annotations = parse_ann_field(ann_value)
        is_nonsyn, category, gene, hgvs_p = classify_mutation(annotations)

        mutations.append({
            "chrom": variant.CHROM,
            "pos": variant.POS,
            "ref": variant.REF,
            "alt": ",".join(str(a) for a in variant.ALT),
            "qual": variant.QUAL if variant.QUAL is not None else np.nan,
            "dp": dp if dp is not None else np.nan,
            "af": round(af, 4) if af is not None else np.nan,
            "is_nonsynonymous": is_nonsyn,
            "category": category,
            "gene": gene,
            "hgvs_p": hgvs_p,
        })

    reader.close()
    return mutations, total, filtered


def parse_variants_pyvcf3(vcf_path, min_af, min_depth):
    """Parse VCF with pyvcf3 and classify each variant."""
    vcf_mod = _try_import_pyvcf3()
    if vcf_mod is None:
        raise ImportError("pyvcf3 not installed")

    reader = vcf_mod.Reader(filename=str(vcf_path))
    mutations = []
    total = 0
    filtered = 0

    for record in reader:
        total += 1

        dp = record.INFO.get("DP")
        if isinstance(dp, list):
            dp = dp[0]
        if dp is None and record.samples:
            try:
                dp = record.samples[0]["DP"]
            except (KeyError, AttributeError):
                dp = None
        if dp is not None and dp < min_depth:
            filtered += 1
            continue

        af = record.INFO.get("AF")
        if isinstance(af, list):
            af = af[0]
        if af is None and record.samples:
            try:
                ad = record.samples[0]["AD"]
                if ad and len(ad) >= 2:
                    tot = sum(ad)
                    af = ad[1] / tot if tot > 0 else 0.0
            except (KeyError, AttributeError, TypeError):
                af = None
        if af is not None and af < min_af:
            filtered += 1
            continue

        ann_value = record.INFO.get("ANN")
        ann_str = ""
        if ann_value:
            ann_str = ann_value if isinstance(ann_value, str) else ",".join(str(a) for a in ann_value)
        annotations = parse_ann_field(ann_str)
        is_nonsyn, category, gene, hgvs_p = classify_mutation(annotations)

        mutations.append({
            "chrom": record.CHROM,
            "pos": record.POS,
            "ref": str(record.REF),
            "alt": ",".join(str(a) for a in record.ALT),
            "qual": record.QUAL if record.QUAL is not None else np.nan,
            "dp": dp if dp is not None else np.nan,
            "af": round(af, 4) if af is not None else np.nan,
            "is_nonsynonymous": is_nonsyn,
            "category": category,
            "gene": gene,
            "hgvs_p": hgvs_p,
        })

    return mutations, total, filtered


def parse_variants(vcf_path, min_af, min_depth):
    """Parse VCF with cyvcf2 (preferred) or pyvcf3 fallback."""
    try:
        result = parse_variants_cyvcf2(vcf_path, min_af, min_depth)
        print("VCF parser: cyvcf2")
        return result
    except ImportError:
        pass
    try:
        result = parse_variants_pyvcf3(vcf_path, min_af, min_depth)
        print("VCF parser: pyvcf3")
        return result
    except ImportError:
        pass
    print("ERROR: Neither cyvcf2 nor pyvcf3 is installed.", file=sys.stderr)
    print("Install one with: pip install cyvcf2  OR  pip install pyvcf3", file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------------------
# TMB calculation
# ---------------------------------------------------------------------------

def calculate_tmb(vcf_path, target_bed=None, genome_size_mb=38.0,
                  min_af=0.05, min_depth=10, output_dir=None):
    """
    Calculate Tumor Mutational Burden.

    Parameters:
        vcf_path: Path to VCF file.
        target_bed: Optional BED file defining panel/capture regions.
        genome_size_mb: Default covered region size in Mb for WGS/WES (default 38).
        min_af: Minimum allele frequency.
        min_depth: Minimum read depth.
        output_dir: Directory to write results.

    Returns:
        dict with TMB value, classification, and breakdown.
    """
    vcf_path = Path(vcf_path)
    if not vcf_path.exists():
        raise FileNotFoundError(f"VCF file not found: {vcf_path}")

    # Determine covered region size
    if target_bed:
        total_bases, covered_mb = calculate_bed_coverage(target_bed)
        print(f"Panel BED:       {target_bed}")
        print(f"Covered region:  {total_bases:,} bp ({covered_mb:.2f} Mb)")
    else:
        covered_mb = genome_size_mb
        print(f"Genome size:     {covered_mb:.1f} Mb (coding region estimate)")

    if covered_mb <= 0:
        raise ValueError("Covered region size must be > 0 Mb")

    # Parse variants
    mutations, total_variants, filtered_count = parse_variants(vcf_path, min_af, min_depth)
    df = pd.DataFrame(mutations)

    if df.empty:
        print("\nWARNING: No variants found after filtering.", file=sys.stderr)
        return {
            "tmb": 0.0,
            "classification": "Low",
            "nonsynonymous_count": 0,
            "total_variants": total_variants,
            "covered_mb": covered_mb,
            "breakdown": {},
        }

    # Count nonsynonymous
    nonsyn_mask = df["is_nonsynonymous"] == True  # noqa: E712
    nonsyn_df = df[nonsyn_mask]
    nonsyn_count = len(nonsyn_df)

    # TMB
    tmb = nonsyn_count / covered_mb

    # Classification
    if tmb < 6:
        classification = "Low"
    elif tmb <= 20:
        classification = "Intermediate"
    else:
        classification = "High"

    # Mutation type breakdown
    breakdown = Counter(nonsyn_df["category"].tolist())

    # Top mutated genes
    gene_counts = Counter(g for g in nonsyn_df["gene"].tolist() if g)

    result = {
        "tmb": round(tmb, 2),
        "classification": classification,
        "nonsynonymous_count": nonsyn_count,
        "total_variants": total_variants,
        "passed_filters": len(df),
        "filtered_out": filtered_count,
        "covered_mb": round(covered_mb, 2),
        "breakdown": dict(breakdown),
        "top_mutated_genes": dict(gene_counts.most_common(20)),
    }

    # Save outputs
    if output_dir:
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        # Full mutation table
        df.to_csv(output_dir / "all_mutations.csv", index=False)

        # Nonsynonymous only
        if not nonsyn_df.empty:
            nonsyn_df.to_csv(output_dir / "nonsynonymous_mutations.csv", index=False)

        # TMB summary JSON
        with open(output_dir / "tmb_summary.json", "w") as fh:
            json.dump(result, fh, indent=2)

        print(f"\nResults saved to: {output_dir}/")

    return result


def print_tmb_report(result):
    """Print a formatted TMB report to stdout."""
    print("\n" + "=" * 60)
    print("TUMOR MUTATIONAL BURDEN (TMB) REPORT")
    print("=" * 60)
    print(f"TMB:                {result['tmb']:.2f} mutations/Mb")
    print(f"Classification:     {result['classification']}")
    print(f"  Low:    <6 mut/Mb")
    print(f"  Intermediate: 6-20 mut/Mb")
    print(f"  High:   >20 mut/Mb")
    print("-" * 60)
    print(f"Total variants in VCF:       {result['total_variants']:>8,}")
    print(f"Passed quality filters:      {result['passed_filters']:>8,}")
    print(f"Filtered out:                {result['filtered_out']:>8,}")
    print(f"Nonsynonymous coding:        {result['nonsynonymous_count']:>8,}")
    print(f"Covered region:              {result['covered_mb']:>8.2f} Mb")

    breakdown = result.get("breakdown", {})
    if breakdown:
        print(f"\nMutation type breakdown:")
        for mtype, count in sorted(breakdown.items(), key=lambda x: -x[1]):
            pct = count / result["nonsynonymous_count"] * 100 if result["nonsynonymous_count"] > 0 else 0
            print(f"  {mtype:<24s}: {count:>5,} ({pct:5.1f}%)")

    top_genes = result.get("top_mutated_genes", {})
    if top_genes:
        print(f"\nTop mutated genes:")
        for gene, count in list(top_genes.items())[:10]:
            print(f"  {gene:<16s}: {count:>3} mutations")

    print("=" * 60)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Calculate Tumor Mutational Burden (TMB) from a VCF file.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --vcf somatic.vcf.gz --output-dir tmb_results/
  %(prog)s --vcf panel.vcf.gz --target-bed panel.bed --output-dir tmb_results/
  %(prog)s --vcf tumor.vcf --min-af 0.10 --min-depth 30
        """,
    )
    parser.add_argument("--vcf", required=True, help="Path to input VCF or VCF.gz file")
    parser.add_argument("--target-bed", default=None,
                        help="BED file defining targeted/captured regions (for panel TMB)")
    parser.add_argument("--genome-size", type=float, default=38.0,
                        help="Coding region size in Mb for WGS/WES (default: 38.0)")
    parser.add_argument("--min-af", type=float, default=0.05,
                        help="Minimum allele frequency (default: 0.05)")
    parser.add_argument("--min-depth", type=int, default=10,
                        help="Minimum read depth (default: 10)")
    parser.add_argument("--output-dir", default=None,
                        help="Directory to save results (default: current directory)")

    args = parser.parse_args()

    print(f"Input VCF:   {args.vcf}")
    print(f"Filters:     AF>={args.min_af}, DP>={args.min_depth}")

    result = calculate_tmb(
        vcf_path=args.vcf,
        target_bed=args.target_bed,
        genome_size_mb=args.genome_size,
        min_af=args.min_af,
        min_depth=args.min_depth,
        output_dir=args.output_dir,
    )

    print_tmb_report(result)


if __name__ == "__main__":
    main()
