#!/usr/bin/env python3
"""
NMF Metagene Extraction from Gene Expression Matrices

Performs Non-negative Matrix Factorization (NMF) on a genes-by-samples
expression matrix to identify metagene programs. Extracts the W matrix
(gene loadings per component) and H matrix (sample weights per component),
ranks genes within each metagene, and reports top contributing genes.

Usage:
    python nmf_metagenes.py --expression expr_matrix.csv --output-dir nmf_results/
    python nmf_metagenes.py --expression expr.tsv --n-components 8 --top-genes 30
    python nmf_metagenes.py --expression rpkm.csv --n-components 3 --max-iter 1000

Examples:
    # Default 5 components, top 20 genes per component
    python nmf_metagenes.py --expression counts_normalized.csv --output-dir results/

    # Identify 10 metagene programs with extended iterations
    python nmf_metagenes.py --expression tpm_matrix.tsv --n-components 10 --max-iter 1000

    # Quick exploratory run with 3 components
    python nmf_metagenes.py --expression fpkm.csv --n-components 3 --top-genes 50

Dependencies: pandas, numpy, scikit-learn, scipy
"""

import argparse
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.spatial.distance import pdist, squareform
from scipy.cluster.hierarchy import linkage, fcluster
from sklearn.decomposition import NMF
from sklearn.preprocessing import normalize


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_expression_matrix(path):
    """
    Load a gene expression matrix from CSV or TSV.

    Expected format: rows = genes, columns = samples.
    First column (or index) contains gene identifiers.

    Returns:
        DataFrame with genes as index and samples as columns.
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Expression file not found: {path}")

    # Detect separator
    with open(path) as fh:
        first_line = fh.readline()
    sep = "\t" if "\t" in first_line else ","

    df = pd.read_csv(path, sep=sep, index_col=0)

    # Drop any fully-null rows or columns
    df = df.dropna(how="all", axis=0)
    df = df.dropna(how="all", axis=1)

    # Ensure numeric
    df = df.apply(pd.to_numeric, errors="coerce")
    df = df.dropna(how="all", axis=0)

    print(f"Loaded expression matrix: {df.shape[0]} genes x {df.shape[1]} samples")
    return df


def prepare_matrix(df):
    """
    Prepare expression matrix for NMF.

    - Clips negative values to 0 (NMF requires non-negative input)
    - Removes genes with zero variance
    - Removes genes that are all zeros

    Returns:
        Cleaned DataFrame, list of removed gene names.
    """
    # Clip negatives
    n_negative = (df.values < 0).sum()
    if n_negative > 0:
        print(f"Clipping {n_negative:,} negative values to 0")
    df = df.clip(lower=0)

    # Remove all-zero genes
    row_sums = df.sum(axis=1)
    zero_mask = row_sums == 0
    n_zero = zero_mask.sum()
    if n_zero > 0:
        print(f"Removing {n_zero:,} genes with all-zero expression")
    removed_genes = list(df.index[zero_mask])
    df = df[~zero_mask]

    # Remove zero-variance genes
    row_var = df.var(axis=1)
    lowvar_mask = row_var == 0
    n_lowvar = lowvar_mask.sum()
    if n_lowvar > 0:
        print(f"Removing {n_lowvar:,} zero-variance genes")
        removed_genes.extend(list(df.index[lowvar_mask]))
    df = df[~lowvar_mask]

    print(f"Matrix after cleaning: {df.shape[0]} genes x {df.shape[1]} samples")
    return df, removed_genes


# ---------------------------------------------------------------------------
# NMF decomposition
# ---------------------------------------------------------------------------

def run_nmf(df, n_components=5, max_iter=500, random_state=42):
    """
    Run NMF on the expression matrix.

    Parameters:
        df: DataFrame (genes x samples), must be non-negative.
        n_components: Number of metagene components.
        max_iter: Maximum iterations for the NMF solver.
        random_state: Random seed for reproducibility.

    Returns:
        W: DataFrame (genes x components) — gene loadings
        H: DataFrame (components x samples) — sample weights
        model: Fitted NMF model
    """
    X = df.values

    print(f"\nRunning NMF with {n_components} components (max_iter={max_iter})...")
    model = NMF(
        n_components=n_components,
        init="nndsvda",
        max_iter=max_iter,
        random_state=random_state,
        l1_ratio=0.0,
        alpha_W=0.0,
        alpha_H=0.0,
    )

    W = model.fit_transform(X)
    H = model.components_

    # Reconstruction error
    reconstruction = W @ H
    error = np.mean((X - reconstruction) ** 2)
    relative_error = np.linalg.norm(X - reconstruction) / np.linalg.norm(X)

    component_names = [f"Metagene_{i + 1}" for i in range(n_components)]

    W_df = pd.DataFrame(W, index=df.index, columns=component_names)
    H_df = pd.DataFrame(H, index=component_names, columns=df.columns)

    print(f"NMF converged in {model.n_iter_} iterations")
    print(f"Reconstruction error (MSE):  {error:.6f}")
    print(f"Relative Frobenius error:    {relative_error:.4f} ({relative_error * 100:.1f}%)")

    return W_df, H_df, model


def extract_top_genes(W_df, top_n=20):
    """
    For each metagene component, rank genes by their loading weight
    and return the top N genes.

    Returns:
        dict mapping component name to list of (gene, weight) tuples.
    """
    top_genes = {}
    for component in W_df.columns:
        sorted_genes = W_df[component].sort_values(ascending=False)
        top = [(gene, round(weight, 6)) for gene, weight in sorted_genes.head(top_n).items()]
        top_genes[component] = top
    return top_genes


def compute_component_similarity(H_df):
    """
    Compute pairwise cosine similarity between metagene sample-weight
    profiles to assess component redundancy.

    Returns:
        DataFrame of pairwise similarities.
    """
    H_norm = normalize(H_df.values, axis=1)
    sim = H_norm @ H_norm.T
    sim_df = pd.DataFrame(sim, index=H_df.index, columns=H_df.index)
    return sim_df


def compute_sample_assignments(H_df):
    """
    Assign each sample to the dominant metagene (highest weight).

    Returns:
        Series mapping sample names to dominant metagene.
    """
    assignments = H_df.idxmax(axis=0)
    assignments.name = "dominant_metagene"
    return assignments


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def save_results(W_df, H_df, top_genes, model, output_dir):
    """Save all NMF results to output directory."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # W matrix (gene loadings)
    W_df.to_csv(output_dir / "metagene_loadings_W.csv")

    # H matrix (sample weights)
    H_df.to_csv(output_dir / "sample_weights_H.csv")

    # Top genes per component
    rows = []
    for component, genes in top_genes.items():
        for rank, (gene, weight) in enumerate(genes, 1):
            rows.append({
                "component": component,
                "rank": rank,
                "gene": gene,
                "weight": weight,
            })
    top_genes_df = pd.DataFrame(rows)
    top_genes_df.to_csv(output_dir / "top_genes_per_component.csv", index=False)

    # Sample assignments
    assignments = compute_sample_assignments(H_df)
    assign_df = pd.DataFrame({"sample": assignments.index, "dominant_metagene": assignments.values})
    assign_df.to_csv(output_dir / "sample_assignments.csv", index=False)

    # Component similarity
    sim_df = compute_component_similarity(H_df)
    sim_df.to_csv(output_dir / "component_similarity.csv")

    print(f"\nFiles saved to {output_dir}/:")
    print(f"  metagene_loadings_W.csv       ({W_df.shape[0]} genes x {W_df.shape[1]} components)")
    print(f"  sample_weights_H.csv          ({H_df.shape[0]} components x {H_df.shape[1]} samples)")
    print(f"  top_genes_per_component.csv   ({len(rows)} entries)")
    print(f"  sample_assignments.csv        ({len(assignments)} samples)")
    print(f"  component_similarity.csv      ({sim_df.shape[0]}x{sim_df.shape[1]})")


def print_summary(W_df, H_df, top_genes, model):
    """Print a concise summary of NMF results."""
    n_components = W_df.shape[1]
    n_genes = W_df.shape[0]
    n_samples = H_df.shape[1]

    # Reconstruction quality
    relative_error = model.reconstruction_err_ / np.linalg.norm(
        model.components_) if hasattr(model, "reconstruction_err_") else None

    print("\n" + "=" * 60)
    print("NMF METAGENE EXTRACTION SUMMARY")
    print("=" * 60)
    print(f"Input matrix:     {n_genes} genes x {n_samples} samples")
    print(f"Components (k):   {n_components}")
    print(f"Iterations:       {model.n_iter_}")

    # Component variance contribution (fraction of total weight)
    component_sums = W_df.sum(axis=0)
    total_weight = component_sums.sum()
    print(f"\nComponent weight distribution:")
    for comp in W_df.columns:
        pct = component_sums[comp] / total_weight * 100
        bar = "#" * int(pct / 2)
        print(f"  {comp:<14s}: {pct:5.1f}%  {bar}")

    # Sample assignment distribution
    assignments = compute_sample_assignments(H_df)
    assign_counts = assignments.value_counts()
    print(f"\nSample assignment distribution:")
    for comp, count in assign_counts.items():
        print(f"  {comp:<14s}: {count:>4} samples ({count / n_samples * 100:.1f}%)")

    # Top genes per component
    print(f"\nTop genes per metagene:")
    for component, genes in top_genes.items():
        gene_names = [g[0] for g in genes[:10]]
        print(f"  {component}:")
        print(f"    {', '.join(gene_names)}")

    # Component similarity check
    sim_df = compute_component_similarity(H_df)
    np.fill_diagonal(sim_df.values, 0)
    max_sim = sim_df.max().max()
    if max_sim > 0.8:
        idx = np.unravel_index(sim_df.values.argmax(), sim_df.shape)
        print(f"\n  WARNING: High similarity ({max_sim:.3f}) between "
              f"{sim_df.index[idx[0]]} and {sim_df.columns[idx[1]]}")
        print(f"  Consider reducing n_components.")

    print("=" * 60)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="NMF metagene extraction from gene expression matrices.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --expression counts.csv --output-dir nmf_results/
  %(prog)s --expression tpm.tsv --n-components 8 --top-genes 30 --output-dir results/
  %(prog)s --expression fpkm.csv --n-components 3 --max-iter 1000
        """,
    )
    parser.add_argument("--expression", required=True,
                        help="Path to expression matrix (CSV/TSV, genes x samples)")
    parser.add_argument("--n-components", type=int, default=5,
                        help="Number of NMF components / metagenes (default: 5)")
    parser.add_argument("--max-iter", type=int, default=500,
                        help="Maximum NMF iterations (default: 500)")
    parser.add_argument("--top-genes", type=int, default=20,
                        help="Number of top genes to report per component (default: 20)")
    parser.add_argument("--output-dir", default=None,
                        help="Directory to save results (default: nmf_results/)")
    parser.add_argument("--seed", type=int, default=42,
                        help="Random seed for reproducibility (default: 42)")

    args = parser.parse_args()

    if args.output_dir is None:
        args.output_dir = "nmf_results"

    print(f"Expression file: {args.expression}")
    print(f"Components:      {args.n_components}")
    print(f"Max iterations:  {args.max_iter}")
    print(f"Top genes:       {args.top_genes}")
    print(f"Output dir:      {args.output_dir}")

    # Load and prepare
    df = load_expression_matrix(args.expression)
    df, removed = prepare_matrix(df)

    if df.shape[0] < args.n_components:
        print(f"ERROR: Not enough genes ({df.shape[0]}) for {args.n_components} components.",
              file=sys.stderr)
        sys.exit(1)
    if df.shape[1] < args.n_components:
        print(f"ERROR: Not enough samples ({df.shape[1]}) for {args.n_components} components.",
              file=sys.stderr)
        sys.exit(1)

    # Run NMF
    W_df, H_df, model = run_nmf(
        df,
        n_components=args.n_components,
        max_iter=args.max_iter,
        random_state=args.seed,
    )

    # Extract top genes
    top_genes = extract_top_genes(W_df, top_n=args.top_genes)

    # Save
    save_results(W_df, H_df, top_genes, model, args.output_dir)

    # Print summary
    print_summary(W_df, H_df, top_genes, model)


if __name__ == "__main__":
    main()
