#!/usr/bin/env python3
"""
Download and process COSMIC Cancer Gene Census data.

Parses Cancer Gene Census CSV exports from COSMIC (Catalogue of Somatic
Mutations in Cancer), filters by tier and hallmark annotations, and produces
summary statistics of oncogenes, tumor suppressor genes, and tumour type
distributions.

Usage:
    download_cosmic.py --input cancer_gene_census.csv --output-dir ./cosmic_out
    download_cosmic.py --input census.csv --filter-tier 1 --output-dir ./cosmic_out

Examples:
    # Process full Cancer Gene Census
    python download_cosmic.py --input cancer_gene_census.csv --output-dir ./cosmic_results

    # Filter to Tier 1 genes only
    python download_cosmic.py --input cancer_gene_census.csv --filter-tier 1 --output-dir ./cosmic_results

    # Filter by hallmark and output as JSON
    python download_cosmic.py \\
        --input cancer_gene_census.csv \\
        --filter-hallmarks "genome instability and mutation,sustaining proliferative signalling" \\
        --format json \\
        --output-dir ./cosmic_results

    # Show download instructions (no input file)
    python download_cosmic.py --output-dir ./cosmic_results
"""

import argparse
import csv
import json
import os
import sys
from collections import Counter


COSMIC_DOWNLOAD_INSTRUCTIONS = """
COSMIC Cancer Gene Census Download Instructions
================================================

COSMIC requires a free academic or paid commercial account for data access.

1. Register at: https://cancer.sanger.ac.uk/cosmic/register
2. Navigate to: https://cancer.sanger.ac.uk/census
3. Download the Cancer Gene Census CSV file
4. Re-run this script with --input <downloaded_file.csv>

Alternative: Use the COSMIC command-line tool:
    pip install cosmic-cli
    cosmic download --name CancerGeneCensus

Expected CSV columns:
    Gene Symbol, Name, Entrez GeneId, Genome Location, Tier,
    Hallmark, Chr Band, Somatic, Germline, Tumour Types(Somatic),
    Tumour Types(Germline), Cancer Syndrome, Tissue Type,
    Molecular Genetics, Role in Cancer, Mutation Types,
    Translocation Partner, Other Germline Mut, Other Syndrome
"""

# Expected column names in COSMIC Cancer Gene Census CSV
COL_GENE = "Gene Symbol"
COL_NAME = "Name"
COL_TIER = "Tier"
COL_HALLMARK = "Hallmark"
COL_ROLE = "Role in Cancer"
COL_MUTATION_TYPES = "Mutation Types"
COL_TUMOUR_SOMATIC = "Tumour Types(Somatic)"
COL_TUMOUR_GERMLINE = "Tumour Types(Germline)"
COL_MOLECULAR = "Molecular Genetics"
COL_ENTREZ = "Entrez GeneId"


def parse_census_csv(filepath):
    """Parse COSMIC Cancer Gene Census CSV file.

    Parameters
    ----------
    filepath : str
        Path to the Cancer Gene Census CSV file.

    Returns
    -------
    list of dict
        Each dict represents a gene record with standardized keys.

    Raises
    ------
    ValueError
        If required columns are missing from the CSV.
    """
    records = []
    with open(filepath, "r", encoding="utf-8", errors="replace") as fh:
        reader = csv.DictReader(fh)
        fieldnames = reader.fieldnames
        if fieldnames is None:
            raise ValueError(f"Empty CSV file: {filepath}")

        required = [COL_GENE, COL_TIER, COL_ROLE]
        missing = [col for col in required if col not in fieldnames]
        if missing:
            available = ", ".join(fieldnames[:10])
            raise ValueError(
                f"Missing required columns: {missing}. "
                f"Available columns include: {available}..."
            )

        for row in reader:
            gene = row.get(COL_GENE, "").strip()
            if not gene:
                continue

            tier_str = row.get(COL_TIER, "").strip()
            try:
                tier = int(tier_str)
            except (ValueError, TypeError):
                tier = 0

            hallmark_raw = row.get(COL_HALLMARK, "").strip()
            hallmarks = [h.strip().lower() for h in hallmark_raw.split(",") if h.strip()]

            role_raw = row.get(COL_ROLE, "").strip()
            roles = [r.strip().lower() for r in role_raw.split(",") if r.strip()]

            mutation_raw = row.get(COL_MUTATION_TYPES, "").strip()
            mutation_types = [m.strip() for m in mutation_raw.split(",") if m.strip()]

            tumour_somatic_raw = row.get(COL_TUMOUR_SOMATIC, "").strip()
            tumour_somatic = [
                t.strip() for t in tumour_somatic_raw.split(",") if t.strip()
            ]

            tumour_germline_raw = row.get(COL_TUMOUR_GERMLINE, "").strip()
            tumour_germline = [
                t.strip() for t in tumour_germline_raw.split(",") if t.strip()
            ]

            records.append(
                {
                    "gene": gene,
                    "name": row.get(COL_NAME, "").strip(),
                    "entrez_id": row.get(COL_ENTREZ, "").strip(),
                    "tier": tier,
                    "hallmarks": hallmarks,
                    "role_in_cancer": roles,
                    "mutation_types": mutation_types,
                    "tumour_types_somatic": tumour_somatic,
                    "tumour_types_germline": tumour_germline,
                    "molecular_genetics": row.get(COL_MOLECULAR, "").strip(),
                }
            )

    return records


def filter_records(records, filter_tier=None, filter_hallmarks=None):
    """Filter gene records by tier and/or hallmark annotations.

    Parameters
    ----------
    records : list of dict
        Parsed gene census records.
    filter_tier : int or None
        If specified, keep only genes with this tier value.
    filter_hallmarks : set or None
        If specified, keep only genes annotated with at least one of these hallmarks.

    Returns
    -------
    list of dict
        Filtered records.
    """
    filtered = records

    if filter_tier is not None:
        filtered = [r for r in filtered if r["tier"] == filter_tier]

    if filter_hallmarks:
        hallmarks_lower = {h.lower() for h in filter_hallmarks}

        def has_hallmark(record):
            return bool(set(record["hallmarks"]) & hallmarks_lower)

        filtered = [r for r in filtered if has_hallmark(r)]

    return filtered


def compute_summary(records):
    """Compute summary statistics over gene census records.

    Parameters
    ----------
    records : list of dict
        Filtered gene census records.

    Returns
    -------
    dict
        Summary statistics including counts by tier, role, and top tumour types.
    """
    tier_counts = Counter()
    role_counts = Counter()
    tumour_counter = Counter()
    hallmark_counter = Counter()
    mutation_counter = Counter()

    for r in records:
        tier_counts[r["tier"]] += 1
        for role in r["role_in_cancer"]:
            if "oncogene" in role:
                role_counts["oncogene"] += 1
            elif "tsg" in role or "tumor suppressor" in role:
                role_counts["TSG"] += 1
            elif "fusion" in role:
                role_counts["fusion"] += 1
            else:
                role_counts[role] += 1
        for t in r["tumour_types_somatic"] + r["tumour_types_germline"]:
            tumour_counter[t] += 1
        for h in r["hallmarks"]:
            hallmark_counter[h] += 1
        for m in r["mutation_types"]:
            mutation_counter[m] += 1

    return {
        "total_genes": len(records),
        "tier_counts": dict(tier_counts.most_common()),
        "role_counts": dict(role_counts.most_common()),
        "top_tumour_types": tumour_counter.most_common(20),
        "top_hallmarks": hallmark_counter.most_common(15),
        "top_mutation_types": mutation_counter.most_common(10),
    }


def save_filtered_genes(records, filepath, output_format="csv"):
    """Save filtered gene list.

    Parameters
    ----------
    records : list of dict
        Filtered gene census records.
    filepath : str
        Output file path.
    output_format : str
        'csv' or 'json'.
    """
    if output_format == "json":
        with open(filepath, "w") as fh:
            json.dump(records, fh, indent=2, default=str)
    else:
        fieldnames = [
            "gene",
            "name",
            "tier",
            "role_in_cancer",
            "hallmarks",
            "mutation_types",
            "tumour_types_somatic",
            "molecular_genetics",
        ]
        with open(filepath, "w", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=fieldnames, extrasaction="ignore")
            writer.writeheader()
            for r in sorted(records, key=lambda x: (x["tier"], x["gene"])):
                row = dict(r)
                row["role_in_cancer"] = "; ".join(r["role_in_cancer"])
                row["hallmarks"] = "; ".join(r["hallmarks"])
                row["mutation_types"] = "; ".join(r["mutation_types"])
                row["tumour_types_somatic"] = "; ".join(r["tumour_types_somatic"])
                writer.writerow(row)


def save_summary(summary, filepath):
    """Save summary statistics to CSV.

    Parameters
    ----------
    summary : dict
        Summary statistics from compute_summary().
    filepath : str
        Output CSV file path.
    """
    with open(filepath, "w", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["category", "item", "count"])
        writer.writerow(["total", "genes", summary["total_genes"]])
        for tier, count in sorted(summary["tier_counts"].items()):
            writer.writerow(["tier", f"tier_{tier}", count])
        for role, count in summary["role_counts"].items():
            writer.writerow(["role", role, count])
        for tumour, count in summary["top_tumour_types"]:
            writer.writerow(["tumour_type", tumour, count])
        for hallmark, count in summary["top_hallmarks"]:
            writer.writerow(["hallmark", hallmark, count])
        for mutation, count in summary["top_mutation_types"]:
            writer.writerow(["mutation_type", mutation, count])


def print_summary(summary, filter_tier=None, filter_hallmarks=None):
    """Print summary to stdout.

    Parameters
    ----------
    summary : dict
        Summary statistics.
    filter_tier : int or None
        Tier filter that was applied.
    filter_hallmarks : set or None
        Hallmark filter that was applied.
    """
    print("COSMIC Cancer Gene Census Summary")
    print("=" * 50)
    if filter_tier is not None:
        print(f"Filter: Tier {filter_tier}")
    if filter_hallmarks:
        print(f"Filter: Hallmarks = {', '.join(filter_hallmarks)}")
    print()
    print(f"Total genes: {summary['total_genes']}")
    print()
    print("Genes by tier:")
    for tier, count in sorted(summary["tier_counts"].items()):
        print(f"  Tier {tier}: {count}")
    print()
    print("Genes by role:")
    for role, count in summary["role_counts"].items():
        print(f"  {role:<20} {count}")
    print()
    print("Top tumour types (somatic + germline):")
    for tumour, count in summary["top_tumour_types"][:10]:
        print(f"  {tumour:<40} {count}")
    print()
    if summary["top_hallmarks"]:
        print("Top hallmarks:")
        for hallmark, count in summary["top_hallmarks"][:10]:
            print(f"  {hallmark:<50} {count}")
    print()
    if summary["top_mutation_types"]:
        print("Top mutation types:")
        for mutation, count in summary["top_mutation_types"]:
            print(f"  {mutation:<30} {count}")


def main():
    parser = argparse.ArgumentParser(
        description="Download and process COSMIC Cancer Gene Census data.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "COSMIC requires registration for data access.\n"
            "Run without --input to see download instructions.\n"
        ),
    )
    parser.add_argument(
        "--input",
        default=None,
        help="Path to downloaded Cancer Gene Census CSV file",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Directory for output files",
    )
    parser.add_argument(
        "--filter-tier",
        choices=["1", "2", "all"],
        default="all",
        help="Filter by tier (1, 2, or all; default: all)",
    )
    parser.add_argument(
        "--filter-hallmarks",
        default=None,
        help="Comma-separated Cancer Gene Census hallmarks to filter by",
    )
    parser.add_argument(
        "--format",
        choices=["csv", "json"],
        default="csv",
        help="Output format for filtered gene list (default: csv)",
    )
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)

    if args.input is None:
        print(COSMIC_DOWNLOAD_INSTRUCTIONS)
        instructions_path = os.path.join(args.output_dir, "download_instructions.txt")
        with open(instructions_path, "w") as fh:
            fh.write(COSMIC_DOWNLOAD_INSTRUCTIONS)
        print(f"Instructions saved to: {instructions_path}")
        sys.exit(0)

    if not os.path.isfile(args.input):
        print(f"Error: input file not found: {args.input}", file=sys.stderr)
        print("Run without --input to see download instructions.", file=sys.stderr)
        sys.exit(1)

    try:
        records = parse_census_csv(args.input)
    except ValueError as exc:
        print(f"Error parsing CSV: {exc}", file=sys.stderr)
        sys.exit(1)

    if not records:
        print("Error: no gene records found in CSV.", file=sys.stderr)
        sys.exit(1)

    print(f"Loaded {len(records)} genes from COSMIC Cancer Gene Census.")

    filter_tier = None
    if args.filter_tier != "all":
        filter_tier = int(args.filter_tier)

    filter_hallmarks = None
    if args.filter_hallmarks:
        filter_hallmarks = {h.strip() for h in args.filter_hallmarks.split(",")}

    filtered = filter_records(records, filter_tier=filter_tier,
                              filter_hallmarks=filter_hallmarks)

    if not filtered:
        print("Warning: no genes remaining after filtering.", file=sys.stderr)
        sys.exit(0)

    summary = compute_summary(filtered)

    ext = "json" if args.format == "json" else "csv"
    genes_path = os.path.join(args.output_dir, f"cosmic_genes_filtered.{ext}")
    save_filtered_genes(filtered, genes_path, output_format=args.format)

    stats_path = os.path.join(args.output_dir, "cosmic_summary_stats.csv")
    save_summary(summary, stats_path)

    print()
    print_summary(summary, filter_tier=filter_tier, filter_hallmarks=filter_hallmarks)
    print()
    print("Output files:")
    print(f"  Filtered genes:  {genes_path}")
    print(f"  Summary stats:   {stats_path}")


if __name__ == "__main__":
    main()
