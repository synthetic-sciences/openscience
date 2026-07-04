#!/usr/bin/env python3
"""
Parse MSigDB GMT files for pathway enrichment analysis.

Reads Gene Matrix Transposed (GMT) format files from the Molecular Signatures
Database (MSigDB), optionally filters by collection or keyword, and performs
overlap enrichment analysis against a user-provided gene list using Fisher's
exact test and hypergeometric p-values.

Usage:
    parse_msigdb.py --gmt h.all.v2024.1.Hs.symbols.gmt --output-dir ./msigdb_out
    parse_msigdb.py --gmt c2.cp.kegg.gmt --gene-list my_genes.txt --output-dir ./enrichment

Examples:
    # Parse and summarize a GMT file
    python parse_msigdb.py --gmt h.all.v2024.1.Hs.symbols.gmt --output-dir ./results

    # Filter by collection prefix
    python parse_msigdb.py --gmt msigdb.v2024.1.Hs.symbols.gmt --collection C2 --output-dir ./results

    # Search for specific pathway keywords
    python parse_msigdb.py --gmt c2.all.v2024.1.Hs.symbols.gmt --search "WNT" --output-dir ./results

    # Enrichment analysis with a gene list
    python parse_msigdb.py \\
        --gmt h.all.v2024.1.Hs.symbols.gmt \\
        --gene-list differentially_expressed.txt \\
        --output-dir ./enrichment_results

    # Combined: filter collection, search, and enrich
    python parse_msigdb.py \\
        --gmt msigdb.v2024.1.Hs.symbols.gmt \\
        --collection C5 \\
        --search "IMMUNE" \\
        --gene-list query_genes.txt \\
        --output-dir ./immune_enrichment
"""

import argparse
import csv
import math
import os
import sys
from collections import OrderedDict


def parse_gmt(filepath):
    """Parse a GMT (Gene Matrix Transposed) format file.

    GMT format: each line is tab-separated with:
        gene_set_name \\t description \\t gene1 \\t gene2 \\t ...

    Parameters
    ----------
    filepath : str
        Path to the GMT file.

    Returns
    -------
    OrderedDict
        Keys are gene set names. Values are dicts with 'description' and
        'genes' (set of gene symbols).

    Raises
    ------
    ValueError
        If the file is empty or has no valid gene sets.
    """
    gene_sets = OrderedDict()
    with open(filepath, "r", encoding="utf-8", errors="replace") as fh:
        for line_num, line in enumerate(fh, 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) < 3:
                continue
            name = parts[0].strip()
            description = parts[1].strip()
            genes = {g.strip().upper() for g in parts[2:] if g.strip()}
            if not name or not genes:
                continue
            gene_sets[name] = {
                "description": description,
                "genes": genes,
            }
    if not gene_sets:
        raise ValueError(f"No valid gene sets found in {filepath}")
    return gene_sets


def filter_by_collection(gene_sets, collection_prefix):
    """Filter gene sets by MSigDB collection prefix.

    MSigDB collections: H (hallmark), C1-C8. Gene set names typically
    start with the collection prefix (e.g., HALLMARK_, KEGG_, GO_).

    Parameters
    ----------
    gene_sets : OrderedDict
        Parsed gene sets.
    collection_prefix : str
        Collection prefix to filter (e.g., 'H', 'C2', 'C5').

    Returns
    -------
    OrderedDict
        Filtered gene sets.
    """
    prefix_map = {
        "H": ["HALLMARK_"],
        "C1": ["chr"],
        "C2": ["KEGG_", "REACTOME_", "BIOCARTA_", "PID_", "WP_", "WIKIPATHWAYS_"],
        "C3": ["MIR-", "TFBS_", "TFT_", "V$"],
        "C4": ["CGN_", "CM_", "GNF2_"],
        "C5": ["GO_", "GOBP_", "GOCC_", "GOMF_", "HP_", "HPO_"],
        "C6": ["ONCOGENIC_"],
        "C7": ["IMMUNESIGDB_", "GSE"],
        "C8": ["CELL_TYPE_"],
    }
    prefix = collection_prefix.upper()
    prefixes = prefix_map.get(prefix, [prefix + "_", prefix + ":"])

    filtered = OrderedDict()
    for name, data in gene_sets.items():
        name_upper = name.upper()
        if any(name_upper.startswith(p.upper()) for p in prefixes):
            filtered[name] = data
    return filtered


def filter_by_keyword(gene_sets, keyword):
    """Filter gene sets whose name contains the keyword (case-insensitive).

    Parameters
    ----------
    gene_sets : OrderedDict
        Parsed gene sets.
    keyword : str
        Keyword to search for in gene set names.

    Returns
    -------
    OrderedDict
        Filtered gene sets.
    """
    kw = keyword.upper()
    filtered = OrderedDict()
    for name, data in gene_sets.items():
        if kw in name.upper():
            filtered[name] = data
    return filtered


def load_gene_list(filepath):
    """Load a gene list from a text file.

    Parameters
    ----------
    filepath : str
        Path to a file with one gene symbol per line.

    Returns
    -------
    set
        Set of gene symbols (uppercase).
    """
    genes = set()
    with open(filepath, "r") as fh:
        for line in fh:
            gene = line.strip().upper()
            if gene and not gene.startswith("#"):
                genes.add(gene)
    if not genes:
        raise ValueError(f"No genes found in {filepath}")
    return genes


def _log_factorial(n):
    """Compute log(n!) using Stirling's approximation for large n.

    Parameters
    ----------
    n : int
        Non-negative integer.

    Returns
    -------
    float
        log(n!).
    """
    if n < 0:
        return 0.0
    if n <= 1:
        return 0.0
    return sum(math.log(i) for i in range(2, n + 1))


def _log_comb(n, k):
    """Compute log(C(n, k)).

    Parameters
    ----------
    n : int
        Total items.
    k : int
        Items chosen.

    Returns
    -------
    float
        log(C(n, k)).
    """
    if k < 0 or k > n:
        return float("-inf")
    return _log_factorial(n) - _log_factorial(k) - _log_factorial(n - k)


def hypergeometric_pvalue(k, M, n, N):
    """Compute hypergeometric test p-value (upper tail).

    P(X >= k) where X ~ Hypergeometric(M, n, N).

    Parameters
    ----------
    k : int
        Observed overlap (successes in sample).
    M : int
        Population size (total genes in background).
    n : int
        Number of successes in population (gene set size).
    N : int
        Sample size (query gene list size).

    Returns
    -------
    float
        P-value for observing k or more overlapping genes.
    """
    if k <= 0:
        return 1.0
    if M <= 0 or n <= 0 or N <= 0:
        return 1.0

    pvalue = 0.0
    max_k = min(n, N)
    for i in range(k, max_k + 1):
        log_p = _log_comb(n, i) + _log_comb(M - n, N - i) - _log_comb(M, N)
        pvalue += math.exp(log_p)

    return min(pvalue, 1.0)


def fisher_exact_test(k, M, n, N):
    """Compute Fisher's exact test p-value (one-sided, greater).

    Uses the hypergeometric distribution. For large datasets, consider
    scipy.stats.fisher_exact for better numerical precision.

    Parameters
    ----------
    k : int
        Observed overlap.
    M : int
        Background size.
    n : int
        Gene set size.
    N : int
        Query list size.

    Returns
    -------
    float
        One-sided p-value (enrichment).
    """
    return hypergeometric_pvalue(k, M, n, N)


def jaccard_index(set_a, set_b):
    """Compute Jaccard similarity index.

    Parameters
    ----------
    set_a : set
        First set.
    set_b : set
        Second set.

    Returns
    -------
    float
        Jaccard index (intersection / union).
    """
    if not set_a and not set_b:
        return 0.0
    intersection = len(set_a & set_b)
    union = len(set_a | set_b)
    return intersection / union if union > 0 else 0.0


def compute_enrichment(gene_sets, query_genes, background_size=20000):
    """Compute overlap enrichment for each gene set against query genes.

    Parameters
    ----------
    gene_sets : OrderedDict
        Parsed gene sets.
    query_genes : set
        Set of query gene symbols.
    background_size : int
        Estimated number of protein-coding genes (default: 20000).

    Returns
    -------
    list of dict
        Enrichment results sorted by p-value (ascending).
    """
    results = []
    M = max(background_size, len(query_genes))

    for name, data in gene_sets.items():
        gs_genes = data["genes"]
        overlap = query_genes & gs_genes
        k = len(overlap)
        n = len(gs_genes)
        N = len(query_genes)

        pvalue = fisher_exact_test(k, M, n, N)
        jaccard = jaccard_index(query_genes, gs_genes)

        results.append(
            {
                "gene_set": name,
                "description": data["description"],
                "gene_set_size": n,
                "overlap_count": k,
                "overlap_genes": sorted(overlap),
                "pvalue": pvalue,
                "jaccard": jaccard,
                "fold_enrichment": (k / N) / (n / M) if n > 0 and N > 0 else 0.0,
            }
        )

    results.sort(key=lambda x: (x["pvalue"], -x["overlap_count"]))
    return results


def benjamini_hochberg(results):
    """Apply Benjamini-Hochberg FDR correction to enrichment results.

    Parameters
    ----------
    results : list of dict
        Enrichment results with 'pvalue' field, assumed already sorted by pvalue.

    Returns
    -------
    list of dict
        Same results with added 'fdr' field.
    """
    n = len(results)
    if n == 0:
        return results

    for i, r in enumerate(results):
        rank = i + 1
        fdr = r["pvalue"] * n / rank
        r["fdr"] = min(fdr, 1.0)

    min_fdr = 1.0
    for i in range(n - 1, -1, -1):
        if results[i]["fdr"] < min_fdr:
            min_fdr = results[i]["fdr"]
        else:
            results[i]["fdr"] = min_fdr

    return results


def save_filtered_gmt(gene_sets, filepath):
    """Save filtered gene sets in GMT format.

    Parameters
    ----------
    gene_sets : OrderedDict
        Gene sets to save.
    filepath : str
        Output file path.
    """
    with open(filepath, "w") as fh:
        for name, data in gene_sets.items():
            genes = "\t".join(sorted(data["genes"]))
            fh.write(f"{name}\t{data['description']}\t{genes}\n")


def save_enrichment_csv(results, filepath):
    """Save enrichment results to CSV.

    Parameters
    ----------
    results : list of dict
        Enrichment results.
    filepath : str
        Output CSV file path.
    """
    fieldnames = [
        "gene_set",
        "description",
        "gene_set_size",
        "overlap_count",
        "overlap_genes",
        "pvalue",
        "fdr",
        "jaccard",
        "fold_enrichment",
    ]
    with open(filepath, "w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        for r in results:
            row = dict(r)
            row["overlap_genes"] = "; ".join(r["overlap_genes"])
            row["pvalue"] = f"{r['pvalue']:.6e}"
            row["fdr"] = f"{r.get('fdr', 1.0):.6e}"
            row["jaccard"] = f"{r['jaccard']:.6f}"
            row["fold_enrichment"] = f"{r['fold_enrichment']:.3f}"
            writer.writerow(row)


def print_summary(gene_sets, filtered_sets, enrichment_results=None, query_genes=None):
    """Print analysis summary to stdout.

    Parameters
    ----------
    gene_sets : OrderedDict
        Original (pre-filter) gene sets.
    filtered_sets : OrderedDict
        Gene sets after filtering.
    enrichment_results : list of dict or None
        Enrichment results, if computed.
    query_genes : set or None
        Query gene list, if provided.
    """
    print("MSigDB GMT Analysis Summary")
    print("=" * 50)
    print(f"Total gene sets loaded:    {len(gene_sets)}")
    print(f"Gene sets after filtering: {len(filtered_sets)}")

    if filtered_sets:
        all_genes = set()
        sizes = []
        for data in filtered_sets.values():
            all_genes.update(data["genes"])
            sizes.append(len(data["genes"]))
        print(f"Unique genes across sets:  {len(all_genes)}")
        print(f"Gene set size range:       {min(sizes)}-{max(sizes)}")
        print(f"Median gene set size:      {sorted(sizes)[len(sizes) // 2]}")
    print()

    if query_genes is not None:
        print(f"Query genes: {len(query_genes)}")
        print()

    if enrichment_results:
        significant = [r for r in enrichment_results if r.get("fdr", r["pvalue"]) < 0.05]
        print(f"Enriched pathways (FDR < 0.05): {len(significant)}")
        print()
        top_n = min(20, len(enrichment_results))
        print(f"Top {top_n} enriched pathways:")
        print(
            f"  {'Gene Set':<50} {'Overlap':>8} {'P-value':>12} "
            f"{'FDR':>12} {'Fold':>8}"
        )
        print(f"  {'-' * 92}")
        for r in enrichment_results[:top_n]:
            name = r["gene_set"]
            if len(name) > 48:
                name = name[:45] + "..."
            fdr = r.get("fdr", r["pvalue"])
            print(
                f"  {name:<50} {r['overlap_count']:>4}/{r['gene_set_size']:<4}"
                f" {r['pvalue']:>12.4e} {fdr:>12.4e} {r['fold_enrichment']:>7.2f}x"
            )
            if r["overlap_count"] > 0 and r["overlap_count"] <= 10:
                genes_str = ", ".join(r["overlap_genes"])
                print(f"  {'':>50} genes: {genes_str}")


def main():
    parser = argparse.ArgumentParser(
        description="Parse MSigDB GMT files for pathway enrichment input.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "MSigDB GMT files can be downloaded from:\n"
            "  https://www.gsea-msigdb.org/gsea/msigdb/collections.jsp\n"
            "\n"
            "Collections: H (hallmark), C1 (positional), C2 (curated),\n"
            "  C3 (regulatory), C4 (computational), C5 (ontology),\n"
            "  C6 (oncogenic), C7 (immunologic), C8 (cell type)\n"
        ),
    )
    parser.add_argument(
        "--gmt",
        required=True,
        help="Path to GMT file",
    )
    parser.add_argument(
        "--collection",
        default=None,
        help="Filter by MSigDB collection (H, C2, C5, C7, etc.)",
    )
    parser.add_argument(
        "--search",
        default=None,
        help="Keyword to filter gene set names (case-insensitive)",
    )
    parser.add_argument(
        "--gene-list",
        default=None,
        help="Optional file with query genes for overlap enrichment (one per line)",
    )
    parser.add_argument(
        "--background-size",
        type=int,
        default=20000,
        help="Background gene count for enrichment test (default: 20000)",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Directory for output files",
    )
    args = parser.parse_args()

    if not os.path.isfile(args.gmt):
        print(f"Error: GMT file not found: {args.gmt}", file=sys.stderr)
        sys.exit(1)

    try:
        gene_sets = parse_gmt(args.gmt)
    except ValueError as exc:
        print(f"Error parsing GMT: {exc}", file=sys.stderr)
        sys.exit(1)

    print(f"Loaded {len(gene_sets)} gene sets from {os.path.basename(args.gmt)}")

    filtered = gene_sets

    if args.collection:
        filtered = filter_by_collection(filtered, args.collection)
        print(f"After collection filter ({args.collection}): {len(filtered)} gene sets")

    if args.search:
        filtered = filter_by_keyword(filtered, args.search)
        print(f"After keyword filter ('{args.search}'): {len(filtered)} gene sets")

    if not filtered:
        print("Warning: no gene sets remaining after filtering.", file=sys.stderr)
        sys.exit(0)

    os.makedirs(args.output_dir, exist_ok=True)

    gmt_out = os.path.join(args.output_dir, "filtered_gene_sets.gmt")
    save_filtered_gmt(filtered, gmt_out)

    enrichment_results = None
    query_genes = None

    if args.gene_list:
        if not os.path.isfile(args.gene_list):
            print(f"Error: gene list file not found: {args.gene_list}", file=sys.stderr)
            sys.exit(1)
        try:
            query_genes = load_gene_list(args.gene_list)
        except ValueError as exc:
            print(f"Error: {exc}", file=sys.stderr)
            sys.exit(1)

        print(f"Loaded {len(query_genes)} query genes for enrichment analysis.")
        enrichment_results = compute_enrichment(
            filtered, query_genes, background_size=args.background_size
        )
        enrichment_results = benjamini_hochberg(enrichment_results)

        enrichment_path = os.path.join(args.output_dir, "enrichment_results.csv")
        save_enrichment_csv(enrichment_results, enrichment_path)

    print()
    print_summary(gene_sets, filtered, enrichment_results, query_genes)
    print()
    print("Output files:")
    print(f"  Filtered GMT:        {gmt_out}")
    if enrichment_results is not None:
        enrichment_path = os.path.join(args.output_dir, "enrichment_results.csv")
        print(f"  Enrichment results:  {enrichment_path}")


if __name__ == "__main__":
    main()
