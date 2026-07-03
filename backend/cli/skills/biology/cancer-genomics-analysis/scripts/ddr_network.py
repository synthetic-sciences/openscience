#!/usr/bin/env python3
"""
DNA Damage Response (DDR) Network Analysis

Builds a co-expression network of canonical DDR pathway genes from an
expression matrix, calculates centrality metrics, identifies hub genes,
and optionally integrates mutation data to highlight synthetic lethality
candidates.

Usage:
    python ddr_network.py --expression expr_matrix.csv --output-dir ddr_results/
    python ddr_network.py --expression tpm.csv --mutations somatic_muts.csv --output-dir results/
    python ddr_network.py --expression counts.tsv --output-dir network/ --corr-threshold 0.6

Examples:
    # Basic DDR co-expression network
    python ddr_network.py --expression normalized_counts.csv --output-dir ddr_network/

    # Integrate mutation data for synthetic lethality analysis
    python ddr_network.py --expression tpm.csv --mutations mutations.csv --output-dir ddr_network/

    # Adjust correlation threshold
    python ddr_network.py --expression fpkm.csv --corr-threshold 0.6 --output-dir results/

Dependencies: pandas, numpy, scipy, networkx, scikit-learn
"""

import argparse
import json
import sys
from itertools import combinations
from pathlib import Path

import networkx as nx
import numpy as np
import pandas as pd
from scipy import stats


# ---------------------------------------------------------------------------
# Canonical DDR gene set
# ---------------------------------------------------------------------------

DDR_GENES = [
    # Core DNA damage sensors
    "ATM", "ATR", "ATRIP", "RAD50", "MRE11", "NBN",
    # Signal transducers
    "CHEK1", "CHEK2", "H2AX", "H2AFX", "MDC1",
    # Homologous recombination (HR)
    "BRCA1", "BRCA2", "RAD51", "RAD51B", "RAD51C", "RAD51D",
    "PALB2", "BARD1", "BRIP1", "XRCC2", "XRCC3",
    # Non-homologous end joining (NHEJ)
    "XRCC4", "XRCC5", "XRCC6", "LIG4", "DCLRE1C", "PRKDC",
    # PARP-mediated repair
    "PARP1", "PARP2",
    # Mismatch repair (MMR)
    "MLH1", "MSH2", "MSH6", "PMS2",
    # Tumor suppressors / effectors
    "TP53", "CDKN2A", "RB1",
    # Fanconi anemia pathway
    "FANCA", "FANCD2",
    # Nucleotide excision repair (NER)
    "ERCC1", "ERCC2", "XPA", "XPC",
]


def get_ddr_gene_set():
    """Return the canonical DDR gene set as a Python set (uppercase)."""
    return set(g.upper() for g in DDR_GENES)


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_expression(path):
    """
    Load expression matrix (genes x samples).

    Accepts CSV or TSV. First column/index = gene identifiers.
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Expression file not found: {path}")

    with open(path) as fh:
        first_line = fh.readline()
    sep = "\t" if "\t" in first_line else ","

    df = pd.read_csv(path, sep=sep, index_col=0)
    df = df.apply(pd.to_numeric, errors="coerce")
    df = df.dropna(how="all", axis=0).dropna(how="all", axis=1)

    # Normalize gene names to uppercase for matching
    df.index = df.index.str.upper().str.strip()

    print(f"Expression matrix: {df.shape[0]} genes x {df.shape[1]} samples")
    return df


def load_mutations(path):
    """
    Load mutation data.

    Expected columns: gene, sample (and optional: mutation_type, effect).
    Gene and sample columns can also be named GENE/SAMPLE, Hugo_Symbol/Tumor_Sample_Barcode.
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Mutations file not found: {path}")

    with open(path) as fh:
        first_line = fh.readline()
    sep = "\t" if "\t" in first_line else ","

    df = pd.read_csv(path, sep=sep)
    df.columns = df.columns.str.strip()

    # Normalize column names
    col_map = {}
    for col in df.columns:
        lower = col.lower()
        if lower in ("gene", "hugo_symbol", "gene_name", "gene_symbol"):
            col_map[col] = "gene"
        elif lower in ("sample", "tumor_sample_barcode", "sample_id", "sample_name"):
            col_map[col] = "sample"
        elif lower in ("mutation_type", "variant_classification", "effect", "consequence"):
            col_map[col] = "mutation_type"
    df = df.rename(columns=col_map)

    if "gene" not in df.columns:
        raise ValueError("Mutations file must have a 'gene' column (or Hugo_Symbol)")
    if "sample" not in df.columns:
        raise ValueError("Mutations file must have a 'sample' column (or Tumor_Sample_Barcode)")

    df["gene"] = df["gene"].str.upper().str.strip()
    print(f"Mutations loaded: {len(df)} mutations across {df['sample'].nunique()} samples")
    return df


# ---------------------------------------------------------------------------
# Network construction
# ---------------------------------------------------------------------------

def subset_ddr_genes(expr_df):
    """
    Subset expression matrix to DDR genes present in the data.

    Returns:
        Subsetted DataFrame, list of found genes, list of missing genes.
    """
    ddr_set = get_ddr_gene_set()
    found = [g for g in expr_df.index if g in ddr_set]
    missing = sorted(ddr_set - set(found))

    if not found:
        raise ValueError("No DDR genes found in the expression matrix. "
                         "Check that gene names match (expected HGNC symbols like ATM, BRCA1).")

    sub_df = expr_df.loc[found]
    print(f"\nDDR genes found: {len(found)} / {len(ddr_set)}")
    if missing:
        print(f"DDR genes missing from expression data: {', '.join(missing[:15])}"
              + ("..." if len(missing) > 15 else ""))

    return sub_df, found, missing


def build_correlation_network(expr_df, threshold=0.5, method="pearson"):
    """
    Build a co-expression network from pairwise correlations.

    Parameters:
        expr_df: DataFrame (genes x samples), subset to DDR genes.
        threshold: Minimum |r| to create an edge.
        method: Correlation method ('pearson' or 'spearman').

    Returns:
        networkx.Graph with edge attributes (weight=|r|, r=correlation, pvalue).
    """
    genes = list(expr_df.index)
    n_genes = len(genes)

    G = nx.Graph()
    G.add_nodes_from(genes)

    n_tested = 0
    n_significant = 0

    for i in range(n_genes):
        for j in range(i + 1, n_genes):
            g1 = genes[i]
            g2 = genes[j]

            x = expr_df.loc[g1].values.astype(float)
            y = expr_df.loc[g2].values.astype(float)

            # Remove NaN pairs
            mask = ~(np.isnan(x) | np.isnan(y))
            if mask.sum() < 5:
                continue

            x_clean = x[mask]
            y_clean = y[mask]

            n_tested += 1

            if method == "spearman":
                r, pval = stats.spearmanr(x_clean, y_clean)
            else:
                r, pval = stats.pearsonr(x_clean, y_clean)

            if np.isnan(r):
                continue

            if abs(r) >= threshold:
                n_significant += 1
                G.add_edge(g1, g2,
                           weight=abs(r),
                           r=round(r, 4),
                           pvalue=pval,
                           direction="positive" if r > 0 else "negative")

    print(f"\nCorrelation network (threshold |r| >= {threshold}):")
    print(f"  Pairs tested:     {n_tested}")
    print(f"  Significant edges: {n_significant}")
    print(f"  Nodes: {G.number_of_nodes()}, Edges: {G.number_of_edges()}")

    return G


# ---------------------------------------------------------------------------
# Network analysis
# ---------------------------------------------------------------------------

def calculate_centrality(G):
    """
    Calculate node centrality metrics.

    Returns:
        DataFrame with degree, betweenness, closeness, and eigenvector centrality.
    """
    if G.number_of_nodes() == 0:
        return pd.DataFrame()

    degree = dict(G.degree())
    degree_cent = nx.degree_centrality(G)
    betweenness = nx.betweenness_centrality(G, weight="weight")

    # Closeness and eigenvector only on connected components
    closeness = {}
    eigenvector = {}
    for component in nx.connected_components(G):
        sub = G.subgraph(component)
        if len(sub) >= 2:
            close = nx.closeness_centrality(sub)
            closeness.update(close)
            try:
                eigen = nx.eigenvector_centrality_numpy(sub, weight="weight")
                eigenvector.update(eigen)
            except (nx.NetworkXError, np.linalg.LinAlgError):
                for node in sub.nodes():
                    eigenvector[node] = 0.0
        else:
            for node in sub.nodes():
                closeness[node] = 0.0
                eigenvector[node] = 0.0

    # Isolated nodes
    for node in G.nodes():
        if node not in closeness:
            closeness[node] = 0.0
        if node not in eigenvector:
            eigenvector[node] = 0.0

    cent_df = pd.DataFrame({
        "gene": list(G.nodes()),
        "degree": [degree.get(n, 0) for n in G.nodes()],
        "degree_centrality": [round(degree_cent.get(n, 0), 4) for n in G.nodes()],
        "betweenness_centrality": [round(betweenness.get(n, 0), 4) for n in G.nodes()],
        "closeness_centrality": [round(closeness.get(n, 0), 4) for n in G.nodes()],
        "eigenvector_centrality": [round(eigenvector.get(n, 0), 4) for n in G.nodes()],
    })

    cent_df = cent_df.sort_values("degree", ascending=False).reset_index(drop=True)
    return cent_df


def identify_hub_genes(cent_df, top_n=5):
    """Identify hub genes ranked by degree centrality."""
    hubs = cent_df.head(top_n)
    return hubs


def identify_network_modules(G, resolution=1.0):
    """
    Detect community structure using greedy modularity.

    Returns:
        dict mapping gene -> community_id
    """
    if G.number_of_edges() == 0:
        return {node: 0 for node in G.nodes()}

    communities = nx.community.greedy_modularity_communities(G, weight="weight")
    membership = {}
    for idx, community in enumerate(communities):
        for gene in community:
            membership[gene] = idx

    return membership


# ---------------------------------------------------------------------------
# Mutation integration & synthetic lethality
# ---------------------------------------------------------------------------

def annotate_mutations(cent_df, mutations_df, expr_df):
    """
    Annotate DDR genes with mutation information.

    Adds columns: is_mutated, n_samples_mutated, mutation_frequency.
    """
    ddr_genes = set(cent_df["gene"].values)
    ddr_muts = mutations_df[mutations_df["gene"].isin(ddr_genes)]

    n_samples = expr_df.shape[1]
    mut_counts = ddr_muts.groupby("gene")["sample"].nunique().to_dict()

    cent_df = cent_df.copy()
    cent_df["n_samples_mutated"] = cent_df["gene"].map(lambda g: mut_counts.get(g, 0))
    cent_df["mutation_frequency"] = cent_df["n_samples_mutated"] / n_samples
    cent_df["is_mutated"] = cent_df["n_samples_mutated"] > 0

    return cent_df


def find_synthetic_lethality_candidates(cent_df, G, mutations_df):
    """
    Identify potential synthetic lethality candidates.

    Logic: If gene A is frequently mutated AND is strongly co-expressed with
    gene B (high edge weight in the network), then gene B may be a synthetic
    lethality target when gene A is lost.

    Returns:
        DataFrame of candidate pairs with scores.
    """
    mutated_genes = cent_df[cent_df["is_mutated"]]["gene"].tolist()
    if not mutated_genes:
        return pd.DataFrame()

    candidates = []
    for mut_gene in mutated_genes:
        if mut_gene not in G:
            continue
        neighbors = G[mut_gene]
        mut_freq = cent_df.loc[cent_df["gene"] == mut_gene, "mutation_frequency"].iloc[0]

        for neighbor, edge_data in neighbors.items():
            r_val = edge_data.get("r", 0)
            weight = edge_data.get("weight", 0)

            # Synthetic lethality candidates: strong positive correlation
            # (co-regulated, so loss of one stresses the pathway)
            # OR strong negative correlation (antagonistic, loss exposes vulnerability)
            score = mut_freq * weight

            candidates.append({
                "mutated_gene": mut_gene,
                "partner_gene": neighbor,
                "mutation_frequency": round(mut_freq, 4),
                "correlation": r_val,
                "abs_correlation": weight,
                "sl_score": round(score, 4),
                "direction": edge_data.get("direction", ""),
                "rationale": _sl_rationale(mut_gene, neighbor, r_val, mut_freq),
            })

    if not candidates:
        return pd.DataFrame()

    cand_df = pd.DataFrame(candidates)
    cand_df = cand_df.sort_values("sl_score", ascending=False).reset_index(drop=True)
    return cand_df


def _sl_rationale(mut_gene, partner, r, freq):
    """Generate a brief rationale for the synthetic lethality prediction."""
    if r > 0:
        return (f"{mut_gene} (mutated in {freq:.0%} samples) is positively co-expressed "
                f"with {partner} (r={r:.2f}). Loss of {mut_gene} function may create "
                f"dependency on {partner} for pathway compensation.")
    else:
        return (f"{mut_gene} (mutated in {freq:.0%} samples) is negatively correlated "
                f"with {partner} (r={r:.2f}). Antagonistic relationship suggests "
                f"{partner} inhibition may be lethal when {mut_gene} is lost.")


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def save_results(G, cent_df, modules, sl_candidates, output_dir):
    """Save all results to output directory."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # GraphML network
    graphml_path = output_dir / "ddr_network.graphml"
    # Add community info to node attributes
    for node in G.nodes():
        G.nodes[node]["community"] = modules.get(node, -1)
        row = cent_df[cent_df["gene"] == node]
        if not row.empty:
            G.nodes[node]["degree"] = int(row["degree"].iloc[0])
            G.nodes[node]["betweenness"] = float(row["betweenness_centrality"].iloc[0])
            if "is_mutated" in row.columns:
                G.nodes[node]["is_mutated"] = bool(row["is_mutated"].iloc[0])
                G.nodes[node]["mutation_frequency"] = float(row["mutation_frequency"].iloc[0])
    nx.write_graphml(G, str(graphml_path))

    # Centrality CSV
    cent_df.to_csv(output_dir / "centrality_metrics.csv", index=False)

    # Module assignments
    mod_df = pd.DataFrame([
        {"gene": gene, "community": comm} for gene, comm in modules.items()
    ])
    mod_df.to_csv(output_dir / "network_modules.csv", index=False)

    # Edge list
    edges = []
    for u, v, data in G.edges(data=True):
        edges.append({
            "gene_1": u,
            "gene_2": v,
            "correlation": data.get("r", 0),
            "abs_correlation": data.get("weight", 0),
            "pvalue": data.get("pvalue", np.nan),
            "direction": data.get("direction", ""),
        })
    if edges:
        edge_df = pd.DataFrame(edges)
        edge_df.to_csv(output_dir / "network_edges.csv", index=False)

    # Synthetic lethality candidates
    if sl_candidates is not None and not sl_candidates.empty:
        sl_candidates.to_csv(output_dir / "synthetic_lethality_candidates.csv", index=False)

    print(f"\nFiles saved to {output_dir}/:")
    print(f"  ddr_network.graphml            (network for Cytoscape/Gephi)")
    print(f"  centrality_metrics.csv         ({len(cent_df)} genes)")
    print(f"  network_modules.csv            ({len(mod_df)} genes, "
          f"{mod_df['community'].nunique()} modules)")
    print(f"  network_edges.csv              ({len(edges)} edges)")
    if sl_candidates is not None and not sl_candidates.empty:
        print(f"  synthetic_lethality_candidates.csv ({len(sl_candidates)} candidates)")


def print_summary(G, cent_df, modules, sl_candidates):
    """Print a formatted summary of the DDR network analysis."""
    print("\n" + "=" * 60)
    print("DDR NETWORK ANALYSIS SUMMARY")
    print("=" * 60)

    print(f"Network:   {G.number_of_nodes()} nodes, {G.number_of_edges()} edges")

    # Connected components
    components = list(nx.connected_components(G))
    print(f"Connected components: {len(components)}")
    if len(components) > 1:
        sizes = sorted([len(c) for c in components], reverse=True)
        print(f"  Component sizes: {sizes}")

    # Density
    density = nx.density(G)
    print(f"Network density: {density:.4f}")

    # Modules
    n_modules = len(set(modules.values()))
    print(f"Modules detected: {n_modules}")

    # Hub genes
    print(f"\nHub genes (top 5 by degree):")
    hubs = identify_hub_genes(cent_df, top_n=5)
    for _, row in hubs.iterrows():
        mut_status = ""
        if "is_mutated" in row.index and row["is_mutated"]:
            mut_status = f" [MUTATED in {row['mutation_frequency']:.0%} samples]"
        print(f"  {row['gene']:<10s}  degree={int(row['degree']):>2}  "
              f"betweenness={row['betweenness_centrality']:.3f}  "
              f"community={modules.get(row['gene'], '?')}{mut_status}")

    # Edge weight distribution
    if G.number_of_edges() > 0:
        weights = [d["weight"] for _, _, d in G.edges(data=True)]
        r_values = [d["r"] for _, _, d in G.edges(data=True)]
        n_pos = sum(1 for r in r_values if r > 0)
        n_neg = sum(1 for r in r_values if r < 0)
        print(f"\nEdge correlations:")
        print(f"  Positive: {n_pos}  Negative: {n_neg}")
        print(f"  |r| range: [{min(weights):.3f}, {max(weights):.3f}]  "
              f"median: {np.median(weights):.3f}")

    # Mutation integration
    if "is_mutated" in cent_df.columns:
        n_mutated = cent_df["is_mutated"].sum()
        print(f"\nDDR genes with mutations: {n_mutated} / {len(cent_df)}")
        if n_mutated > 0:
            top_mut = cent_df[cent_df["is_mutated"]].nlargest(5, "mutation_frequency")
            for _, row in top_mut.iterrows():
                print(f"  {row['gene']:<10s}  mutated in {row['n_samples_mutated']} samples "
                      f"({row['mutation_frequency']:.1%})")

    # Synthetic lethality
    if sl_candidates is not None and not sl_candidates.empty:
        print(f"\nTop synthetic lethality candidates:")
        for _, row in sl_candidates.head(5).iterrows():
            print(f"  {row['mutated_gene']:<10s} <-> {row['partner_gene']:<10s}  "
                  f"r={row['correlation']:+.3f}  score={row['sl_score']:.4f}")

    print("=" * 60)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="DDR pathway co-expression network analysis.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --expression counts.csv --output-dir ddr_results/
  %(prog)s --expression tpm.csv --mutations muts.csv --output-dir results/
  %(prog)s --expression fpkm.csv --corr-threshold 0.6 --output-dir network/
        """,
    )
    parser.add_argument("--expression", required=True,
                        help="Path to expression matrix (CSV/TSV, genes x samples)")
    parser.add_argument("--mutations", default=None,
                        help="Optional CSV with gene + sample columns for mutation data")
    parser.add_argument("--output-dir", default=None,
                        help="Directory to save results (default: ddr_results/)")
    parser.add_argument("--corr-threshold", type=float, default=0.5,
                        help="Minimum |r| for network edges (default: 0.5)")
    parser.add_argument("--corr-method", choices=["pearson", "spearman"], default="pearson",
                        help="Correlation method (default: pearson)")

    args = parser.parse_args()

    if args.output_dir is None:
        args.output_dir = "ddr_results"

    print(f"Expression:    {args.expression}")
    if args.mutations:
        print(f"Mutations:     {args.mutations}")
    print(f"Corr threshold: |r| >= {args.corr_threshold}")
    print(f"Corr method:   {args.corr_method}")
    print(f"Output dir:    {args.output_dir}")

    # Load data
    expr_df = load_expression(args.expression)

    mutations_df = None
    if args.mutations:
        mutations_df = load_mutations(args.mutations)

    # Subset to DDR genes
    ddr_expr, found_genes, missing_genes = subset_ddr_genes(expr_df)

    # Build network
    G = build_correlation_network(
        ddr_expr,
        threshold=args.corr_threshold,
        method=args.corr_method,
    )

    # Centrality
    cent_df = calculate_centrality(G)

    # Modules
    modules = identify_network_modules(G)

    # Mutation integration
    sl_candidates = None
    if mutations_df is not None:
        cent_df = annotate_mutations(cent_df, mutations_df, expr_df)
        sl_candidates = find_synthetic_lethality_candidates(cent_df, G, mutations_df)

    # Save
    save_results(G, cent_df, modules, sl_candidates, args.output_dir)

    # Print summary
    print_summary(G, cent_df, modules, sl_candidates)


if __name__ == "__main__":
    main()
