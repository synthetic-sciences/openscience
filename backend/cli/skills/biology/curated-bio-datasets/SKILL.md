---
name: curated-bio-datasets
description: Guide to accessing curated biological datasets for computational biology. COSMIC cancer data, GTEx expression, GWAS catalog, GeneBass exome variants, BioGRID interactions, MSigDB gene sets, DisGeNET disease-gene associations, and GO ontology. For specific database APIs use individual database skills (cosmic-database, gwas-database, etc.).
category: biology
license: MIT license
metadata:
    skill-author: InkVell Inc.
---

# Curated Bio-Datasets: Biological Datasets Guide

## Overview

Curated Bio-Datasets provides a comprehensive guide to accessing and working with major curated biological datasets. This skill covers COSMIC cancer genomics data, GTEx tissue expression data, GWAS Catalog SNP-trait associations, GeneBass exome-wide association results, BioGRID protein-protein interaction data, MSigDB gene set collections, DisGeNET disease-gene associations, and Gene Ontology resources. Each section includes download patterns, file formats, parsing code, and integration examples.

## When to Use This Skill

- Downloading and parsing COSMIC cancer gene census data
- Accessing GTEx tissue-level expression data (TPM matrices, eQTLs)
- Querying the GWAS Catalog for SNP-trait associations
- Working with GeneBass exome-wide burden test results
- Building protein-protein interaction networks from BioGRID
- Loading MSigDB gene sets for pathway enrichment analysis
- Querying DisGeNET for disease-gene associations
- Working with Gene Ontology terms and hierarchies

**Related Skills:** For specific database API access use dedicated skills: `cosmic-database`, `gwas-database`, `ensembl-database`, `kegg-database`, `reactome-database`.

## Installation

```bash
uv pip install pandas requests networkx gseapy numpy
```

## Quick Start

```python
import pandas as pd

# Load MSigDB gene sets (GMT format) for enrichment analysis
def parse_gmt(gmt_path):
    gene_sets = {}
    with open(gmt_path) as f:
        for line in f:
            parts = line.strip().split('\t')
            name = parts[0]
            genes = parts[2:]  # Skip description
            gene_sets[name] = genes
    return gene_sets

# Example: run enrichment with gseapy
import gseapy as gp
enr = gp.enrichr(gene_list=['TP53', 'BRCA1', 'ATM', 'CHEK2', 'PTEN'],
                 gene_sets='MSigDB_Hallmark_2020', outdir=None)
print(enr.results[['Term', 'Adjusted P-value', 'Overlap']].head())
```

## Core Capabilities

### 1. COSMIC Cancer Datasets

Access the Catalogue of Somatic Mutations in Cancer.

```python
import pandas as pd

# COSMIC Cancer Gene Census
# Download from: https://cancer.sanger.ac.uk/census (requires free registration)
# File: cancer_gene_census.csv

def load_cosmic_census(census_path='cancer_gene_census.csv'):
    """Load and parse COSMIC Cancer Gene Census."""
    df = pd.read_csv(census_path)

    print(f"Total cancer genes: {len(df)}")
    print(f"\nTier distribution:")
    print(df['Tier'].value_counts())

    print(f"\nRole in Cancer:")
    roles = df['Role in Cancer'].str.split(', ').explode()
    print(roles.value_counts())

    print(f"\nTop mutation types:")
    mut_types = df['Mutation Types'].str.split(', ').explode()
    print(mut_types.value_counts().head(5))

    return df

def filter_census_by_cancer(census_df, cancer_type):
    """Filter census for a specific cancer type."""
    mask = census_df['Tumour Types(Somatic)'].str.contains(cancer_type, case=False, na=False)
    filtered = census_df[mask]
    print(f"Genes associated with '{cancer_type}': {len(filtered)}")
    return filtered

# COSMIC somatic mutations
# Download: CosmicMutantExportCensus.tsv.gz
def load_cosmic_mutations(mutations_path):
    """Load COSMIC somatic mutation data."""
    df = pd.read_csv(mutations_path, sep='\t', low_memory=False)
    print(f"Total mutations: {len(df)}")
    print(f"Unique genes: {df['Gene name'].nunique()}")
    print(f"Mutation types:\n{df['Mutation Description'].value_counts().head()}")
    return df

# COSMIC resistance mutations
# Useful for pharmacogenomics studies
def get_resistance_genes(census_df):
    """Extract genes with known drug resistance mutations."""
    mask = census_df['Mutation Types'].str.contains('resistance', case=False, na=False) | \
           census_df['Role in Cancer'].str.contains('resistance', case=False, na=False)
    return census_df[mask][['Gene Symbol', 'Mutation Types', 'Role in Cancer']]
```

### 2. GTEx Tissue Expression

Access the Genotype-Tissue Expression project data.

```python
import pandas as pd
import requests

# GTEx Portal API
GTEX_API = 'https://gtexportal.org/api/v2'

def get_gtex_gene_expression(gene_symbol, dataset_id='gtex_v8'):
    """Get median gene expression across tissues from GTEx API."""
    url = f"{GTEX_API}/expression/medianGeneExpression"
    params = {
        'geneSymbol': gene_symbol,
        'datasetId': dataset_id,
    }
    response = requests.get(url, params=params)
    if response.status_code != 200:
        print(f"Error: {response.status_code}")
        return None

    data = response.json()
    if 'data' not in data:
        print("No data returned")
        return None

    df = pd.DataFrame(data['data'])
    df = df.sort_values('median', ascending=False)

    print(f"Expression of {gene_symbol} across {len(df)} tissues:")
    print(df[['tissueSiteDetailId', 'median']].head(10).to_string(index=False))
    return df

# GTEx bulk download patterns
# TPM matrix: GTEx_Analysis_2017-06-05_v8_RNASeQCv1.1.9_gene_tpm.gct.gz
# Sample annotations: GTEx_Analysis_v8_Annotations_SampleAttributesDS.txt
# eQTL: GTEx_Analysis_v8_eQTL.tar

def load_gtex_tpm(tpm_path):
    """Load GTEx TPM matrix (GCT format)."""
    df = pd.read_csv(tpm_path, sep='\t', skiprows=2)
    genes = df['Name']
    descriptions = df['Description']
    expression = df.iloc[:, 2:]

    print(f"Genes: {len(genes)}")
    print(f"Samples: {expression.shape[1]}")
    return df
```

### 3. GWAS Catalog

Access SNP-trait association data.

```python
import pandas as pd

# Download: https://www.ebi.ac.uk/gwas/api/search/downloads/full
# File: gwas_catalog_v1.0.2-associations_e*.tsv

def load_gwas_catalog(catalog_path):
    """Load GWAS Catalog associations."""
    df = pd.read_csv(catalog_path, sep='\t', low_memory=False)

    print(f"Total associations: {len(df)}")
    print(f"Unique traits: {df['DISEASE/TRAIT'].nunique()}")
    print(f"Unique SNPs: {df['SNPS'].nunique()}")

    return df

def search_gwas_by_trait(catalog_df, trait_keyword, pvalue_threshold=5e-8):
    """Search GWAS catalog for a trait."""
    mask = catalog_df['DISEASE/TRAIT'].str.contains(trait_keyword, case=False, na=False)

    # Filter by p-value
    filtered = catalog_df[mask].copy()
    filtered['P-VALUE'] = pd.to_numeric(filtered['P-VALUE'], errors='coerce')
    filtered = filtered[filtered['P-VALUE'] < pvalue_threshold]

    filtered = filtered.sort_values('P-VALUE')

    print(f"Associations for '{trait_keyword}': {len(filtered)}")
    if len(filtered) > 0:
        print(filtered[['SNPS', 'MAPPED_GENE', 'P-VALUE', 'OR or BETA']].head(10))
    return filtered

def search_gwas_by_gene(catalog_df, gene_symbol):
    """Search GWAS catalog for associations near a gene."""
    mask = catalog_df['MAPPED_GENE'].str.contains(gene_symbol, case=False, na=False) | \
           catalog_df['REPORTED GENE(S)'].str.contains(gene_symbol, case=False, na=False)
    results = catalog_df[mask].sort_values('P-VALUE')
    print(f"GWAS hits near {gene_symbol}: {len(results)}")
    return results
```

### 4. GeneBass Exome Data

Access exome-wide association results.

```python
import pandas as pd

# GeneBass: https://genebass.org/
# Bulk download: results per phenotype in TSV format

def load_genebass_results(results_path, gene=None, pvalue_threshold=2.5e-6):
    """Load GeneBass exome-wide association results.

    Args:
        results_path: path to GeneBass results TSV
        gene: optional gene filter
        pvalue_threshold: exome-wide significance threshold
    """
    df = pd.read_csv(results_path, sep='\t')

    if gene:
        df = df[df['gene_symbol'] == gene]

    # Filter significant results
    sig = df[df['pvalue'] < pvalue_threshold]

    print(f"Total results: {len(df)}")
    print(f"Significant (p < {pvalue_threshold}): {len(sig)}")

    if len(sig) > 0:
        print("\nTop hits:")
        print(sig[['gene_symbol', 'annotation', 'pvalue', 'beta']].head(10))

    return df

# Burden test categories
# pLoF: predicted loss of function
# missense: missense variants
# synonymous: synonymous (used as negative control)
def compare_burden_tests(results_df, gene):
    """Compare burden test results across variant categories."""
    gene_data = results_df[results_df['gene_symbol'] == gene]
    for ann in ['pLoF', 'missense|LC', 'synonymous']:
        subset = gene_data[gene_data['annotation'] == ann]
        if len(subset) > 0:
            row = subset.iloc[0]
            print(f"{ann}: p={row['pvalue']:.2e}, beta={row.get('beta', 'N/A')}")
```

### 5. Protein Interaction Networks

Build and analyze networks from BioGRID data.

```python
import pandas as pd
import networkx as nx

# Download: https://thebiogrid.org/downloads/archives/Latest%20Release
# File: BIOGRID-ALL-LATEST.tab3.zip

def load_biogrid(biogrid_path, organism=9606, experiment_types=None):
    """Load BioGRID protein-protein interaction data.

    Args:
        biogrid_path: path to BioGRID tab3 file
        organism: NCBI taxonomy ID (9606 = human)
        experiment_types: list of experiment types to include
    """
    cols = ['BioGRID Interaction ID', 'Official Symbol Interactor A',
            'Official Symbol Interactor B', 'Organism ID Interactor A',
            'Organism ID Interactor B', 'Experimental System',
            'Experimental System Type', 'Throughput']

    df = pd.read_csv(biogrid_path, sep='\t', usecols=cols, low_memory=False)

    # Filter by organism
    df = df[(df['Organism ID Interactor A'] == organism) &
            (df['Organism ID Interactor B'] == organism)]

    # Filter by experiment type
    if experiment_types:
        df = df[df['Experimental System'].isin(experiment_types)]

    print(f"Interactions: {len(df)}")
    print(f"Unique proteins: {pd.concat([df['Official Symbol Interactor A'],
                                          df['Official Symbol Interactor B']]).nunique()}")
    print(f"\nExperiment types:\n{df['Experimental System'].value_counts().head()}")
    return df

def build_ppi_network(biogrid_df, genes_of_interest=None):
    """Build NetworkX graph from BioGRID interactions."""
    G = nx.Graph()

    for _, row in biogrid_df.iterrows():
        a = row['Official Symbol Interactor A']
        b = row['Official Symbol Interactor B']
        if a != b:  # Exclude self-interactions
            if G.has_edge(a, b):
                G[a][b]['weight'] += 1
            else:
                G.add_edge(a, b, weight=1)

    print(f"Network: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges")

    # Subnetwork for genes of interest
    if genes_of_interest:
        # Include 1st-degree neighbors
        neighbors = set()
        for gene in genes_of_interest:
            if gene in G:
                neighbors.update(G.neighbors(gene))
        subgraph_nodes = set(genes_of_interest) | neighbors
        subG = G.subgraph(subgraph_nodes)
        print(f"Subnetwork: {subG.number_of_nodes()} nodes, {subG.number_of_edges()} edges")

        # Hub analysis
        degrees = dict(subG.degree())
        hubs = sorted(degrees.items(), key=lambda x: x[1], reverse=True)[:10]
        print("Top hubs:")
        for gene, deg in hubs:
            print(f"  {gene}: degree={deg}")

        return subG

    return G
```

### 6. MSigDB Gene Sets

Load and use MSigDB gene set collections.

```python
import pandas as pd

# Download GMT files from: https://www.gsea-msigdb.org/gsea/msigdb/collections.jsp
# Collections: H (hallmark), C1-C8

def parse_gmt(gmt_path):
    """Parse GMT (Gene Matrix Transposed) file format."""
    gene_sets = {}
    with open(gmt_path) as f:
        for line in f:
            parts = line.strip().split('\t')
            name = parts[0]
            description = parts[1]
            genes = [g for g in parts[2:] if g]
            gene_sets[name] = {'description': description, 'genes': genes}

    print(f"Loaded {len(gene_sets)} gene sets from {gmt_path}")
    sizes = [len(gs['genes']) for gs in gene_sets.values()]
    print(f"Gene set sizes: {min(sizes)}-{max(sizes)} (median: {sorted(sizes)[len(sizes)//2]})")
    return gene_sets

def enrichment_with_msigdb(gene_list, collection='MSigDB_Hallmark_2020'):
    """Run enrichment analysis using MSigDB via gseapy."""
    import gseapy as gp

    enr = gp.enrichr(gene_list=gene_list, gene_sets=collection, outdir=None)
    results = enr.results[enr.results['Adjusted P-value'] < 0.05]

    print(f"Significant pathways (padj < 0.05): {len(results)}")
    if len(results) > 0:
        print(results[['Term', 'Adjusted P-value', 'Overlap', 'Combined Score']].head(10))
    return enr

# Available collections via gseapy
MSIGDB_COLLECTIONS = {
    'H': 'MSigDB_Hallmark_2020',          # 50 hallmark gene sets
    'C2_CP': 'KEGG_2021_Human',           # Canonical pathways
    'C5_GO_BP': 'GO_Biological_Process_2021',  # GO biological process
    'C5_GO_MF': 'GO_Molecular_Function_2021',  # GO molecular function
    'C5_GO_CC': 'GO_Cellular_Component_2021',  # GO cellular component
    'C7': 'Immunologic_Signature',        # Immunologic signatures
}
```

### 7. DisGeNET & OMIM

Access disease-gene association databases.

```python
import pandas as pd
import requests

# DisGeNET: https://www.disgenet.org/downloads
# Download: curated_gene_disease_associations.tsv.gz

def load_disgenet(disgenet_path):
    """Load DisGeNET disease-gene associations."""
    df = pd.read_csv(disgenet_path, sep='\t')

    print(f"Total associations: {len(df)}")
    print(f"Unique genes: {df['geneSymbol'].nunique()}")
    print(f"Unique diseases: {df['diseaseName'].nunique()}")
    return df

def search_disgenet_by_gene(disgenet_df, gene_symbol, min_score=0.3):
    """Find diseases associated with a gene."""
    results = disgenet_df[disgenet_df['geneSymbol'] == gene_symbol]
    results = results[results['score'] >= min_score]
    results = results.sort_values('score', ascending=False)

    print(f"Diseases associated with {gene_symbol} (score >= {min_score}): {len(results)}")
    if len(results) > 0:
        print(results[['diseaseName', 'score', 'NofPmids']].head(10))
    return results

def search_disgenet_by_disease(disgenet_df, disease_keyword, min_score=0.3):
    """Find genes associated with a disease."""
    mask = disgenet_df['diseaseName'].str.contains(disease_keyword, case=False, na=False)
    results = disgenet_df[mask]
    results = results[results['score'] >= min_score]
    results = results.sort_values('score', ascending=False)

    print(f"Genes associated with '{disease_keyword}': {len(results)}")
    if len(results) > 0:
        print(results[['geneSymbol', 'diseaseName', 'score']].head(15))
    return results
```

### 8. Gene Ontology

Work with GO terms and hierarchies.

```python
import json
import requests

# GO OBO file: http://purl.obolibrary.org/obo/go.obo
# GO JSON: https://purl.obolibrary.org/obo/go.json

def parse_go_obo(obo_path):
    """Parse Gene Ontology OBO file."""
    terms = {}
    current = None

    with open(obo_path) as f:
        for line in f:
            line = line.strip()
            if line == '[Term]':
                current = {}
            elif line == '' and current is not None:
                if 'id' in current:
                    terms[current['id']] = current
                current = None
            elif current is not None and ':' in line:
                key, value = line.split(': ', 1)
                if key in ('id', 'name', 'namespace', 'def'):
                    current[key] = value
                elif key == 'is_a':
                    current.setdefault('parents', []).append(value.split(' ! ')[0])
                elif key == 'is_obsolete' and value == 'true':
                    current = None

    print(f"GO terms: {len(terms)}")
    namespaces = {}
    for t in terms.values():
        ns = t.get('namespace', 'unknown')
        namespaces[ns] = namespaces.get(ns, 0) + 1
    print(f"Namespaces: {namespaces}")
    return terms

def get_ancestors(terms, go_id, max_depth=10):
    """Get all ancestor terms of a GO term."""
    ancestors = set()
    queue = [go_id]
    depth = 0

    while queue and depth < max_depth:
        next_queue = []
        for term_id in queue:
            if term_id in terms:
                parents = terms[term_id].get('parents', [])
                for parent in parents:
                    if parent not in ancestors:
                        ancestors.add(parent)
                        next_queue.append(parent)
        queue = next_queue
        depth += 1

    return ancestors

def lookup_go_term(go_id):
    """Look up a GO term using the QuickGO API."""
    url = f"https://www.ebi.ac.uk/QuickGO/services/ontology/go/terms/{go_id}"
    response = requests.get(url, headers={'Accept': 'application/json'})

    if response.status_code == 200:
        data = response.json()
        if 'results' in data and len(data['results']) > 0:
            term = data['results'][0]
            print(f"GO:{go_id}")
            print(f"  Name: {term.get('name')}")
            print(f"  Namespace: {term.get('aspect')}")
            print(f"  Definition: {term.get('definition', {}).get('text', 'N/A')[:200]}")
            return term
    return None
```

## Typical Workflows

### Workflow 1: Download and Filter COSMIC Cancer Gene Census

```python
census = load_cosmic_census('cancer_gene_census.csv')
breast_genes = filter_census_by_cancer(census, 'breast')
print(f"\nBreast cancer genes: {list(breast_genes['Gene Symbol'].head(20))}")
```

### Workflow 2: Build Protein Interaction Network from BioGRID

```python
biogrid = load_biogrid('BIOGRID-ALL-LATEST.tab3.txt',
                        experiment_types=['Affinity Capture-MS', 'Two-hybrid'])
G = build_ppi_network(biogrid, genes_of_interest=['TP53', 'BRCA1', 'ATM'])
```

### Workflow 3: Run Pathway Enrichment with MSigDB Gene Sets

```python
gene_list = ['TP53', 'BRCA1', 'ATM', 'CHEK2', 'PTEN', 'RB1', 'CDKN2A']
enr = enrichment_with_msigdb(gene_list, collection='MSigDB_Hallmark_2020')
```

## Best Practices

1. **COSMIC access** — requires free registration; respect data license terms; use COSMIC CGC for curated cancer genes, full dataset for comprehensive analysis
2. **GTEx** — use median TPM for tissue comparisons; raw counts for differential analysis; eQTL data for variant interpretation
3. **GWAS Catalog** — apply genome-wide significance threshold (5e-8); check LD with lead SNP; use mapped genes, not just reported genes
4. **BioGRID** — filter by experiment type for quality; "Affinity Capture-MS" and "Two-hybrid" are highest confidence; weight edges by evidence count
5. **MSigDB** — Hallmark gene sets are most interpretable; use C2 (curated) for canonical pathways; C5 (GO) for biological process analysis
6. **DisGeNET** — filter by score (>0.3 for moderate confidence); prioritize curated sources; cross-reference with OMIM for Mendelian diseases
7. **File sizes** — COSMIC full mutation export is ~30GB; GTEx TPM matrix is ~2GB; download and process locally, don't reload repeatedly

## Troubleshooting

**Problem:** COSMIC download requires authentication
**Solution:** Register for free account at cancer.sanger.ac.uk. Use SFTP or download from the web portal. Academic license is free.

**Problem:** GTEx API returns empty results
**Solution:** Check gene symbol is HUGO-approved. Try ENSG ID instead. GTEx v8 uses GRCh38 coordinates.

**Problem:** BioGRID file too large to load
**Solution:** Use organism filter during loading. Read in chunks with `chunksize` parameter. Pre-filter with command-line tools (grep).

**Problem:** gseapy enrichment returns no results
**Solution:** Ensure gene symbols match the gene set database (HUGO symbols). Check that gene list has >5 genes. Try different collections.

## Resources

- [COSMIC](https://cancer.sanger.ac.uk/cosmic)
- [GTEx Portal](https://gtexportal.org/)
- [GWAS Catalog](https://www.ebi.ac.uk/gwas/)
- [GeneBass](https://genebass.org/)
- [BioGRID](https://thebiogrid.org/)
- [MSigDB](https://www.gsea-msigdb.org/gsea/msigdb/)
- [DisGeNET](https://www.disgenet.org/)
- [Gene Ontology](http://geneontology.org/)
