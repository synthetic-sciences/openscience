#!/usr/bin/env python3
"""
Build protein-protein interaction networks from BioGRID tab-delimited data.

Parses BioGRID tab3 format TSV files, filters by organism (default: human,
taxonomy 9606), experiment type, and minimum publication support. Constructs
a networkx graph and computes standard network topology metrics.

Usage:
    build_ppi_network.py --biogrid-file BIOGRID-ALL-4.4.tab3.txt --output-dir ./ppi_out
    build_ppi_network.py --biogrid-file BIOGRID.txt --gene-list my_genes.txt --output-dir ./ppi_out

Examples:
    # Build full human interactome from BioGRID download
    python build_ppi_network.py --biogrid-file BIOGRID-ALL-4.4.232.tab3.txt --output-dir ./network

    # Extract subnetwork for specific genes with experiment filter
    python build_ppi_network.py \\
        --biogrid-file BIOGRID-ALL-4.4.232.tab3.txt \\
        --gene-list cancer_genes.txt \\
        --experiment-types "Affinity Capture-MS,Two-hybrid" \\
        --min-publications 2 \\
        --output-dir ./cancer_ppi

    # Filter by minimum publication support
    python build_ppi_network.py \\
        --biogrid-file BIOGRID-ALL-4.4.232.tab3.txt \\
        --min-publications 3 \\
        --output-dir ./high_conf_ppi
"""

import argparse
import csv
import os
import sys
from collections import Counter, defaultdict

try:
    import networkx as nx
except ImportError:
    print(
        "Error: networkx is required. Install with: pip install networkx",
        file=sys.stderr,
    )
    sys.exit(1)


# BioGRID tab3 column indices (0-based)
COL_OFFICIAL_SYMBOL_A = 7
COL_OFFICIAL_SYMBOL_B = 8
COL_EXPERIMENTAL_SYSTEM = 11
COL_PUBMED_ID = 14
COL_ORGANISM_A = 15
COL_ORGANISM_B = 16

HUMAN_TAXID = "9606"


def load_gene_list(filepath):
    """Load a gene list from a text file (one gene per line).

    Parameters
    ----------
    filepath : str
        Path to a text file with one gene symbol per line.

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


def parse_biogrid(filepath, organism_taxid=HUMAN_TAXID, experiment_types=None,
                  min_publications=1):
    """Parse BioGRID tab3 TSV and extract interactions.

    Parameters
    ----------
    filepath : str
        Path to BioGRID tab3 format TSV file.
    organism_taxid : str
        NCBI taxonomy ID to filter both interactors (default: 9606 for human).
    experiment_types : set or None
        If provided, only include interactions with matching experimental system.
    min_publications : int
        Minimum number of publications supporting the interaction (default: 1).

    Returns
    -------
    list of dict
        Each dict has keys: gene_a, gene_b, experiment, pubmed_id.
    """
    interactions = []
    pair_pubmeds = defaultdict(set)
    pair_experiments = defaultdict(set)

    with open(filepath, "r", encoding="utf-8", errors="replace") as fh:
        reader = csv.reader(fh, delimiter="\t")
        header = next(reader, None)
        if header is None:
            raise ValueError(f"Empty file: {filepath}")

        for row_num, row in enumerate(reader, start=2):
            if len(row) <= max(COL_OFFICIAL_SYMBOL_A, COL_OFFICIAL_SYMBOL_B,
                               COL_EXPERIMENTAL_SYSTEM, COL_PUBMED_ID,
                               COL_ORGANISM_A, COL_ORGANISM_B):
                continue

            org_a = row[COL_ORGANISM_A].strip()
            org_b = row[COL_ORGANISM_B].strip()
            if organism_taxid and (org_a != organism_taxid or org_b != organism_taxid):
                continue

            gene_a = row[COL_OFFICIAL_SYMBOL_A].strip().upper()
            gene_b = row[COL_OFFICIAL_SYMBOL_B].strip().upper()
            experiment = row[COL_EXPERIMENTAL_SYSTEM].strip()
            pubmed = row[COL_PUBMED_ID].strip()

            if not gene_a or not gene_b:
                continue
            if gene_a == "-" or gene_b == "-":
                continue

            if experiment_types and experiment not in experiment_types:
                continue

            pair = tuple(sorted([gene_a, gene_b]))
            pair_pubmeds[pair].add(pubmed)
            pair_experiments[pair].add(experiment)

    for pair, pubmeds in pair_pubmeds.items():
        if len(pubmeds) < min_publications:
            continue
        interactions.append(
            {
                "gene_a": pair[0],
                "gene_b": pair[1],
                "experiments": pair_experiments[pair],
                "publication_count": len(pubmeds),
            }
        )

    return interactions


def build_network(interactions, gene_list=None):
    """Build a networkx Graph from parsed interactions.

    Parameters
    ----------
    interactions : list of dict
        Parsed interaction records.
    gene_list : set or None
        If provided, extract subnetwork containing only these genes and their
        direct neighbors.

    Returns
    -------
    networkx.Graph
        Interaction network with edge attributes.
    """
    G = nx.Graph()

    for ix in interactions:
        gene_a = ix["gene_a"]
        gene_b = ix["gene_b"]
        if gene_a == gene_b:
            continue
        if G.has_edge(gene_a, gene_b):
            G[gene_a][gene_b]["weight"] += ix["publication_count"]
            G[gene_a][gene_b]["experiments"].update(ix["experiments"])
        else:
            G.add_edge(
                gene_a,
                gene_b,
                weight=ix["publication_count"],
                experiments=set(ix["experiments"]),
            )

    if gene_list:
        gene_list_upper = {g.upper() for g in gene_list}
        present = gene_list_upper & set(G.nodes())
        if not present:
            print(
                f"Warning: none of the {len(gene_list)} query genes found in network.",
                file=sys.stderr,
            )
            return nx.Graph()
        neighbors = set()
        for gene in present:
            neighbors.update(G.neighbors(gene))
        subgraph_nodes = present | neighbors
        G = G.subgraph(subgraph_nodes).copy()

    return G


def compute_statistics(G):
    """Compute network topology statistics.

    Parameters
    ----------
    G : networkx.Graph
        The interaction network.

    Returns
    -------
    dict
        Network statistics including node/edge counts, density,
        clustering, and hub genes.
    """
    stats = {
        "node_count": G.number_of_nodes(),
        "edge_count": G.number_of_edges(),
        "density": nx.density(G) if G.number_of_nodes() > 1 else 0.0,
        "avg_clustering": 0.0,
        "connected_components": 0,
        "hub_genes": [],
        "degree_distribution": Counter(),
    }

    if G.number_of_nodes() == 0:
        return stats

    stats["connected_components"] = nx.number_connected_components(G)
    stats["avg_clustering"] = nx.average_clustering(G)

    degrees = dict(G.degree())
    stats["degree_distribution"] = Counter(degrees.values())

    sorted_by_degree = sorted(degrees.items(), key=lambda x: x[1], reverse=True)
    stats["hub_genes"] = sorted_by_degree[:10]

    return stats


def save_graphml(G, filepath):
    """Save network in GraphML format.

    Converts set-valued edge attributes to comma-separated strings
    for GraphML compatibility.

    Parameters
    ----------
    G : networkx.Graph
        The interaction network.
    filepath : str
        Output file path.
    """
    G_export = G.copy()
    for u, v, data in G_export.edges(data=True):
        if "experiments" in data and isinstance(data["experiments"], set):
            data["experiments"] = ",".join(sorted(data["experiments"]))
    nx.write_graphml(G_export, filepath)


def save_edge_list(G, filepath):
    """Save edge list as CSV.

    Parameters
    ----------
    G : networkx.Graph
        The interaction network.
    filepath : str
        Output CSV file path.
    """
    with open(filepath, "w", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["gene_a", "gene_b", "weight", "experiments"])
        for u, v, data in sorted(G.edges(data=True)):
            experiments = data.get("experiments", set())
            if isinstance(experiments, set):
                experiments = ",".join(sorted(experiments))
            writer.writerow([u, v, data.get("weight", 1), experiments])


def save_statistics(stats, filepath):
    """Save network statistics to CSV.

    Parameters
    ----------
    stats : dict
        Network statistics from compute_statistics().
    filepath : str
        Output CSV file path.
    """
    with open(filepath, "w", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["metric", "value"])
        writer.writerow(["node_count", stats["node_count"]])
        writer.writerow(["edge_count", stats["edge_count"]])
        writer.writerow(["density", f"{stats['density']:.6f}"])
        writer.writerow(["avg_clustering", f"{stats['avg_clustering']:.6f}"])
        writer.writerow(["connected_components", stats["connected_components"]])
        for rank, (gene, degree) in enumerate(stats["hub_genes"], 1):
            writer.writerow([f"hub_gene_{rank}", f"{gene} (degree={degree})"])


def print_summary(stats, gene_list=None):
    """Print network summary to stdout.

    Parameters
    ----------
    stats : dict
        Network statistics from compute_statistics().
    gene_list : set or None
        Query gene list, if provided.
    """
    print("PPI Network Summary")
    print("=" * 50)
    if gene_list:
        print(f"Query genes:           {len(gene_list)}")
    print(f"Nodes (genes):         {stats['node_count']}")
    print(f"Edges (interactions):  {stats['edge_count']}")
    print(f"Network density:       {stats['density']:.6f}")
    print(f"Avg clustering coeff:  {stats['avg_clustering']:.6f}")
    print(f"Connected components:  {stats['connected_components']}")
    print()
    if stats["hub_genes"]:
        print("Top hub genes (by degree):")
        for rank, (gene, degree) in enumerate(stats["hub_genes"], 1):
            print(f"  {rank:>2}. {gene:<15} degree={degree}")
    print()
    if stats["degree_distribution"]:
        degrees = stats["degree_distribution"]
        max_degree = max(degrees.keys())
        avg_degree = sum(k * v for k, v in degrees.items()) / sum(degrees.values())
        print(f"Degree statistics:")
        print(f"  Max degree:  {max_degree}")
        print(f"  Avg degree:  {avg_degree:.1f}")


def main():
    parser = argparse.ArgumentParser(
        description="Build protein-protein interaction network from BioGRID data.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "BioGRID data can be downloaded from:\n"
            "  https://downloads.thebiogrid.org/BioGRID/Release-Archive/\n"
            "\n"
            "Use the tab3 format (BIOGRID-ALL-*.tab3.txt).\n"
        ),
    )
    parser.add_argument(
        "--biogrid-file",
        required=True,
        help="Path to BioGRID tab3 TSV file",
    )
    parser.add_argument(
        "--gene-list",
        default=None,
        help="Optional file with genes of interest (one per line)",
    )
    parser.add_argument(
        "--experiment-types",
        default=None,
        help='Comma-separated experiment type filter (e.g., "Affinity Capture-MS,Two-hybrid")',
    )
    parser.add_argument(
        "--min-publications",
        type=int,
        default=1,
        help="Minimum publication count per interaction (default: 1)",
    )
    parser.add_argument(
        "--organism",
        default=HUMAN_TAXID,
        help=f"NCBI taxonomy ID to filter (default: {HUMAN_TAXID} for human)",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Directory for output files",
    )
    args = parser.parse_args()

    if not os.path.isfile(args.biogrid_file):
        print(f"Error: BioGRID file not found: {args.biogrid_file}", file=sys.stderr)
        sys.exit(1)

    gene_list = None
    if args.gene_list:
        if not os.path.isfile(args.gene_list):
            print(f"Error: gene list file not found: {args.gene_list}", file=sys.stderr)
            sys.exit(1)
        try:
            gene_list = load_gene_list(args.gene_list)
            print(f"Loaded {len(gene_list)} query genes.")
        except ValueError as exc:
            print(f"Error: {exc}", file=sys.stderr)
            sys.exit(1)

    experiment_types = None
    if args.experiment_types:
        experiment_types = {e.strip() for e in args.experiment_types.split(",")}
        print(f"Filtering experiment types: {experiment_types}")

    print(f"Parsing BioGRID file: {args.biogrid_file}")
    print(f"  Organism filter: {args.organism}")
    print(f"  Min publications: {args.min_publications}")

    try:
        interactions = parse_biogrid(
            args.biogrid_file,
            organism_taxid=args.organism,
            experiment_types=experiment_types,
            min_publications=args.min_publications,
        )
    except (ValueError, FileNotFoundError) as exc:
        print(f"Error parsing BioGRID: {exc}", file=sys.stderr)
        sys.exit(1)

    print(f"Parsed {len(interactions)} interactions after filtering.")

    if not interactions:
        print("Warning: no interactions found after filtering.", file=sys.stderr)
        sys.exit(0)

    G = build_network(interactions, gene_list=gene_list)
    stats = compute_statistics(G)

    os.makedirs(args.output_dir, exist_ok=True)

    graphml_path = os.path.join(args.output_dir, "ppi_network.graphml")
    save_graphml(G, graphml_path)

    edgelist_path = os.path.join(args.output_dir, "edge_list.csv")
    save_edge_list(G, edgelist_path)

    stats_path = os.path.join(args.output_dir, "network_statistics.csv")
    save_statistics(stats, stats_path)

    print()
    print_summary(stats, gene_list=gene_list)
    print()
    print("Output files:")
    print(f"  GraphML:           {graphml_path}")
    print(f"  Edge list CSV:     {edgelist_path}")
    print(f"  Statistics CSV:    {stats_path}")


if __name__ == "__main__":
    main()
