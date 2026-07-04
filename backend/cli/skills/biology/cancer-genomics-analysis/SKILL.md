---
name: cancer-genomics-analysis
description: Computational cancer genomics workflows. Somatic mutation detection and annotation, structural variation characterization, copy number analysis, tumor purity/ploidy estimation, NMF metagene extraction, and DNA damage response network analysis. For cancer mutation databases use cosmic-database; for variant clinical significance use clinvar-database.
category: biology
license: MIT license
metadata:
    skill-author: InkVell Inc.
---

# Cancer Genomics Analysis: Computational Workflows

## Overview

Cancer Genomics Analysis provides computational pipelines for processing and interpreting cancer genomics data. This skill covers somatic mutation detection and annotation (GATK Mutect2 integration), structural variation characterization, copy number analysis (CNVkit workflows), tumor purity and ploidy estimation, NMF-based metagene extraction from expression data, DNA damage response network analysis, and tumor mutational burden calculation. All workflows produce quantitative outputs suitable for clinical interpretation and publication.

## When to Use This Skill

- Processing somatic variant calls from tumor-normal paired sequencing
- Annotating VCF files with gene names, functional impact, and clinical significance
- Detecting and classifying structural variants (deletions, duplications, inversions, translocations)
- Running copy number analysis pipelines (coverage, segmentation, calling)
- Estimating tumor purity and ploidy from sequencing data
- Extracting gene expression signatures via NMF (metagene programs)
- Analyzing DNA damage response pathway disruption in tumors
- Calculating tumor mutational burden for immunotherapy biomarker assessment

**Related Skills:** For cancer mutation databases use `cosmic-database`. For variant clinical significance use `clinvar-database`. For gene annotations use `ensembl-database`. For pathway enrichment use `kegg-database` or `reactome-database`.

## Installation

```bash
uv pip install pyvcf3 cyvcf2 pysam scikit-learn networkx gseapy pandas numpy matplotlib
```

For command-line tools (optional):
```bash
# GATK, SnpEff, CNVkit are installed separately
# conda install -c bioconda gatk4 snpeff cnvkit
```

## Quick Start

```python
import cyvcf2
import pandas as pd

# Parse somatic VCF
vcf = cyvcf2.VCF('somatic_mutations.vcf.gz')
variants = []
for v in vcf:
    if v.FILTER is None or v.FILTER == 'PASS':
        variants.append({
            'chrom': v.CHROM, 'pos': v.POS,
            'ref': v.REF, 'alt': ','.join(v.ALT),
            'qual': v.QUAL,
            'depth': v.INFO.get('DP'),
            'af': v.INFO.get('AF')
        })

df = pd.DataFrame(variants)
print(f"PASS variants: {len(df)}")
print(df.head())
```

## Core Capabilities

### 1. VCF Parsing & Variant Processing

Read, filter, and annotate variant calls.

```python
import cyvcf2
import pandas as pd

def parse_vcf(vcf_path, min_qual=30, min_dp=10, min_af=0.05):
    """Parse VCF with quality filters."""
    vcf = cyvcf2.VCF(vcf_path)
    variants = []

    for v in vcf:
        # Apply filters
        if v.FILTER is not None and v.FILTER != 'PASS':
            continue

        dp = v.INFO.get('DP', 0)
        af_values = v.INFO.get('AF')
        af = af_values if isinstance(af_values, float) else (af_values[0] if af_values else 0)

        if v.QUAL and v.QUAL < min_qual:
            continue
        if dp < min_dp:
            continue
        if af < min_af:
            continue

        variants.append({
            'chrom': v.CHROM, 'pos': v.POS,
            'ref': v.REF, 'alt': ','.join(v.ALT),
            'qual': v.QUAL, 'dp': dp, 'af': af,
            'gene': v.INFO.get('ANN', '').split('|')[3] if v.INFO.get('ANN') else ''
        })

    return pd.DataFrame(variants)

df = parse_vcf('tumor_somatic.vcf.gz')
print(f"Filtered variants: {len(df)}")
print(f"Genes affected: {df['gene'].nunique()}")
```

### 2. Somatic Mutation Detection

GATK Mutect2 workflow patterns.

```python
import subprocess

def run_mutect2(tumor_bam, normal_bam, reference, output_vcf,
                gnomad_resource=None, pon=None):
    """Run GATK Mutect2 for somatic variant calling."""
    cmd = [
        'gatk', 'Mutect2',
        '-R', reference,
        '-I', tumor_bam,
        '-I', normal_bam,
        '-tumor', 'TUMOR',
        '-normal', 'NORMAL',
        '-O', output_vcf
    ]
    if gnomad_resource:
        cmd.extend(['--germline-resource', gnomad_resource])
    if pon:
        cmd.extend(['-pon', pon])

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"Mutect2 failed: {result.stderr}")
    return output_vcf

def filter_mutect_calls(raw_vcf, filtered_vcf, reference):
    """Apply Mutect2 filters."""
    cmd = [
        'gatk', 'FilterMutectCalls',
        '-R', reference,
        '-V', raw_vcf,
        '-O', filtered_vcf
    ]
    subprocess.run(cmd, capture_output=True, text=True, check=True)
    return filtered_vcf

def annotate_with_snpeff(vcf_path, output_vcf, genome='GRCh38.105'):
    """Annotate variants with SnpEff."""
    cmd = f"snpEff ann {genome} {vcf_path} > {output_vcf}"
    subprocess.run(cmd, shell=True, capture_output=True, text=True, check=True)
    return output_vcf
```

### 3. Structural Variation Detection

Classify and annotate structural variants.

```python
import cyvcf2
import pandas as pd

def parse_sv_vcf(vcf_path):
    """Parse structural variant VCF (LUMPY/Manta/Delly format)."""
    vcf = cyvcf2.VCF(vcf_path)
    svs = []

    for v in vcf:
        svtype = v.INFO.get('SVTYPE', 'UNKNOWN')
        svlen = abs(v.INFO.get('SVLEN', 0)) if v.INFO.get('SVLEN') else 0
        end = v.INFO.get('END', v.POS)
        pe = v.INFO.get('PE', 0)  # Paired-end support
        sr = v.INFO.get('SR', 0)  # Split-read support

        svs.append({
            'chrom': v.CHROM, 'pos': v.POS, 'end': end,
            'svtype': svtype, 'svlen': svlen,
            'pe_support': pe, 'sr_support': sr,
            'qual': v.QUAL, 'filter': v.FILTER or 'PASS'
        })

    df = pd.DataFrame(svs)
    return df

sv_df = parse_sv_vcf('structural_variants.vcf')
print("SV type distribution:")
print(sv_df['svtype'].value_counts())
print(f"\nMedian SV length: {sv_df[sv_df['svlen'] > 0]['svlen'].median():.0f} bp")
```

### 4. Copy Number Analysis

CNVkit-based workflow for copy number profiling.

```python
import subprocess
import pandas as pd
import numpy as np

def cnvkit_pipeline(tumor_bam, normal_bam, reference, target_bed, output_dir):
    """Run CNVkit copy number analysis pipeline."""
    # Step 1: Coverage
    subprocess.run([
        'cnvkit.py', 'coverage', tumor_bam, target_bed,
        '-o', f'{output_dir}/tumor.targetcoverage.cnn'
    ], check=True)

    # Step 2: Reference from normal
    subprocess.run([
        'cnvkit.py', 'reference', f'{output_dir}/normal.targetcoverage.cnn',
        '-f', reference, '-o', f'{output_dir}/reference.cnn'
    ], check=True)

    # Step 3: Fix and segment
    subprocess.run([
        'cnvkit.py', 'fix', f'{output_dir}/tumor.targetcoverage.cnn',
        f'{output_dir}/tumor.antitargetcoverage.cnn',
        f'{output_dir}/reference.cnn',
        '-o', f'{output_dir}/tumor.cnr'
    ], check=True)

    subprocess.run([
        'cnvkit.py', 'segment', f'{output_dir}/tumor.cnr',
        '-o', f'{output_dir}/tumor.cns'
    ], check=True)

    return f'{output_dir}/tumor.cns'

def parse_cnvkit_segments(cns_path):
    """Parse CNVkit segmentation output."""
    df = pd.read_csv(cns_path, sep='\t')
    # Classify events
    df['call'] = 'neutral'
    df.loc[df['log2'] > 0.3, 'call'] = 'gain'
    df.loc[df['log2'] > 0.8, 'call'] = 'amplification'
    df.loc[df['log2'] < -0.3, 'call'] = 'loss'
    df.loc[df['log2'] < -1.0, 'call'] = 'deep_deletion'

    print("Copy number events:")
    print(df['call'].value_counts())
    return df

def estimate_purity_ploidy(segments_df):
    """Estimate tumor purity and ploidy from segments."""
    # Simplified approach using segment log2 ratios
    log2_values = segments_df['log2'].values
    weights = segments_df['end'] - segments_df['start']

    # Weighted median for ploidy shift
    weighted_median = np.average(log2_values, weights=weights)
    estimated_ploidy = 2 * (2 ** weighted_median)

    # Purity from deviation of peaks from integer CN
    # (simplified — full methods use allele frequencies)
    deviation = np.std(log2_values)
    estimated_purity = min(1.0, deviation * 2)  # Rough heuristic

    return {'purity': estimated_purity, 'ploidy': estimated_ploidy}
```

### 5. NMF Metagene Extraction

Extract gene expression programs using Non-negative Matrix Factorization.

```python
from sklearn.decomposition import NMF
import numpy as np
import pandas as pd

def extract_metagenes(expression_matrix, n_components=5, top_genes=50):
    """Extract metagene programs from expression matrix via NMF.

    Args:
        expression_matrix: genes x samples DataFrame (non-negative values)
        n_components: number of metagene programs to extract
        top_genes: number of top genes to report per metagene
    """
    # Ensure non-negative
    X = expression_matrix.values
    X = np.clip(X, 0, None)

    # Fit NMF
    model = NMF(n_components=n_components, init='nndsvda', random_state=42,
                max_iter=500, l1_ratio=0.5)
    W = model.fit_transform(X)  # genes x components (gene weights)
    H = model.components_        # components x samples (sample coefficients)

    # Extract top genes per metagene
    metagenes = {}
    for k in range(n_components):
        gene_weights = pd.Series(W[:, k], index=expression_matrix.index)
        top = gene_weights.nlargest(top_genes)
        metagenes[f'Metagene_{k+1}'] = top

    # Reconstruction error
    recon_error = model.reconstruction_err_
    print(f"Reconstruction error: {recon_error:.4f}")

    return metagenes, W, H, model

def optimal_rank_selection(expression_matrix, k_range=range(2, 11)):
    """Select optimal NMF rank using cophenetic correlation."""
    from scipy.cluster.hierarchy import cophenet, linkage
    from scipy.spatial.distance import pdist

    X = np.clip(expression_matrix.values, 0, None)
    scores = {}

    for k in k_range:
        # Run NMF multiple times
        consensus = np.zeros((X.shape[1], X.shape[1]))
        n_runs = 20
        for i in range(n_runs):
            model = NMF(n_components=k, init='random', random_state=i, max_iter=300)
            H = model.fit_transform(X.T).T  # Transpose for sample clustering
            assignments = np.argmax(H, axis=0)
            for a in range(X.shape[1]):
                for b in range(X.shape[1]):
                    if assignments[a] == assignments[b]:
                        consensus[a, b] += 1
        consensus /= n_runs

        # Cophenetic correlation
        Z = linkage(pdist(1 - consensus), method='average')
        coph_corr, _ = cophenet(Z, pdist(1 - consensus))
        scores[k] = coph_corr
        print(f"k={k}: cophenetic correlation = {coph_corr:.4f}")

    optimal_k = max(scores, key=scores.get)
    print(f"\nOptimal rank: {optimal_k}")
    return optimal_k, scores
```

### 6. DNA Damage Response Network

Analyze DDR pathway disruption in tumors.

```python
import networkx as nx
import numpy as np
import pandas as pd

# Core DDR genes
DDR_GENES = [
    'TP53', 'BRCA1', 'BRCA2', 'ATM', 'ATR', 'CHEK1', 'CHEK2',
    'RAD51', 'PALB2', 'XRCC1', 'PARP1', 'MLH1', 'MSH2', 'MSH6',
    'ERCC1', 'XPA', 'XPC', 'POLH', 'REV3L', 'FANCA', 'FANCD2'
]

def build_ddr_network(expression_df, ddr_genes=DDR_GENES, threshold=0.5):
    """Build DDR correlation network from expression data."""
    # Filter to DDR genes present in data
    available = [g for g in ddr_genes if g in expression_df.index]
    ddr_expr = expression_df.loc[available]

    # Compute correlation matrix
    corr = ddr_expr.T.corr(method='spearman')

    # Build network
    G = nx.Graph()
    for i, g1 in enumerate(available):
        for j, g2 in enumerate(available):
            if i < j and abs(corr.loc[g1, g2]) > threshold:
                G.add_edge(g1, g2, weight=corr.loc[g1, g2])

    return G, corr

def compare_ddr_networks(tumor_expr, normal_expr, ddr_genes=DDR_GENES):
    """Identify disrupted DDR edges in tumor vs normal."""
    G_tumor, corr_tumor = build_ddr_network(tumor_expr, ddr_genes)
    G_normal, corr_normal = build_ddr_network(normal_expr, ddr_genes)

    # Find disrupted edges
    disrupted = []
    for u, v, d in G_normal.edges(data=True):
        normal_corr = d['weight']
        tumor_corr = corr_tumor.loc[u, v] if u in corr_tumor.index and v in corr_tumor.columns else 0
        delta = abs(normal_corr - tumor_corr)
        if delta > 0.3:
            disrupted.append({
                'gene1': u, 'gene2': v,
                'normal_corr': normal_corr, 'tumor_corr': tumor_corr,
                'delta': delta
            })

    return pd.DataFrame(disrupted).sort_values('delta', ascending=False)
```

### 7. Tumor Mutational Burden

Calculate TMB for immunotherapy biomarker assessment.

```python
import cyvcf2

def calculate_tmb(vcf_path, exome_size_mb=35.0, min_af=0.05, min_dp=10):
    """Calculate tumor mutational burden (mutations per Mb)."""
    vcf = cyvcf2.VCF(vcf_path)
    nonsynonymous_count = 0
    total_pass = 0

    for v in vcf:
        if v.FILTER and v.FILTER != 'PASS':
            continue

        dp = v.INFO.get('DP', 0)
        af = v.INFO.get('AF', 0)
        if isinstance(af, tuple):
            af = af[0]

        if dp < min_dp or af < min_af:
            continue

        total_pass += 1

        # Check for nonsynonymous (requires SnpEff/VEP annotation)
        ann = v.INFO.get('ANN', '')
        if ann and ('missense' in ann.lower() or 'nonsense' in ann.lower() or
                    'frameshift' in ann.lower() or 'stop_gained' in ann.lower()):
            nonsynonymous_count += 1

    tmb = total_pass / exome_size_mb
    tmb_nonsynonymous = nonsynonymous_count / exome_size_mb

    print(f"Total PASS variants: {total_pass}")
    print(f"Nonsynonymous variants: {nonsynonymous_count}")
    print(f"TMB (all): {tmb:.1f} mut/Mb")
    print(f"TMB (nonsynonymous): {tmb_nonsynonymous:.1f} mut/Mb")

    # Classification
    if tmb >= 10:
        classification = 'TMB-High'
    elif tmb >= 5:
        classification = 'TMB-Intermediate'
    else:
        classification = 'TMB-Low'
    print(f"Classification: {classification}")

    return {'tmb': tmb, 'tmb_nonsyn': tmb_nonsynonymous, 'class': classification}
```

## Typical Workflows

### Workflow 1: Complete Somatic Mutation Calling and Annotation

```python
import subprocess

# 1. Call variants
run_mutect2('tumor.bam', 'normal.bam', 'ref.fa', 'raw.vcf')

# 2. Filter
filter_mutect_calls('raw.vcf', 'filtered.vcf', 'ref.fa')

# 3. Annotate
annotate_with_snpeff('filtered.vcf', 'annotated.vcf')

# 4. Parse and analyze
df = parse_vcf('annotated.vcf')
print(f"Somatic mutations: {len(df)}")
print(f"Most mutated genes:")
print(df['gene'].value_counts().head(10))
```

### Workflow 2: Copy Number Analysis with Purity Estimation

```python
# 1. Run CNVkit pipeline
cns_file = cnvkit_pipeline('tumor.bam', 'normal.bam', 'ref.fa', 'targets.bed', 'cnv_output/')

# 2. Parse segments
segments = parse_cnvkit_segments(cns_file)

# 3. Estimate purity/ploidy
estimates = estimate_purity_ploidy(segments)
print(f"Estimated purity: {estimates['purity']:.2f}")
print(f"Estimated ploidy: {estimates['ploidy']:.2f}")

# 4. Identify focal events
focal = segments[(segments['call'].isin(['amplification', 'deep_deletion'])) &
                  (segments['end'] - segments['start'] < 5e6)]
print(f"\nFocal events: {len(focal)}")
print(focal[['chromosome', 'start', 'end', 'gene', 'log2', 'call']])
```

### Workflow 3: NMF Extraction of Gene Expression Signatures

```python
import pandas as pd

# 1. Load expression matrix (genes x samples, non-negative)
expr = pd.read_csv('tpm_matrix.csv', index_col=0)
expr = expr.clip(lower=0)

# 2. Select optimal rank
optimal_k, scores = optimal_rank_selection(expr, k_range=range(2, 8))

# 3. Extract metagenes
metagenes, W, H, model = extract_metagenes(expr, n_components=optimal_k)

# 4. Interpret metagenes with enrichment
import gseapy as gp
for name, genes in metagenes.items():
    enr = gp.enrichr(gene_list=list(genes.index), gene_sets='KEGG_2021_Human', outdir=None)
    top_pathway = enr.results.iloc[0]['Term'] if len(enr.results) > 0 else 'None'
    print(f"{name}: top pathway = {top_pathway}")
    print(f"  Top genes: {', '.join(genes.index[:5])}")
```

## Best Practices

1. **Always use paired tumor-normal** for somatic calling — tumor-only mode has high false positive rates
2. **Filter aggressively** — apply PASS filter, minimum depth (>10x), minimum allele frequency (>5% for WES)
3. **Annotate with standard tools** — SnpEff or VEP for functional annotation; validate key variants in ClinVar
4. **Check purity before CNV analysis** — low purity tumors underestimate copy number changes
5. **NMF requires non-negative input** — use TPM or RPKM, not log-transformed values
6. **TMB calculation** — use consistent exome size (typically 30-40 Mb); nonsynonymous variants only for clinical interpretation
7. **Validate key findings** in COSMIC and ClinVar databases

## Troubleshooting

**Problem:** VCF parsing fails with cyvcf2
**Solution:** Ensure VCF is bgzip-compressed and tabix-indexed. Use `bcftools view -O z -o out.vcf.gz in.vcf && tabix -p vcf out.vcf.gz`.

**Problem:** CNVkit segmentation produces too many small segments
**Solution:** Increase segmentation threshold with `--threshold` parameter. Merge adjacent segments with similar log2 ratios.

**Problem:** NMF produces unstable results across runs
**Solution:** Use `init='nndsvda'` for deterministic initialization. Run cophenetic correlation analysis to verify rank stability.

**Problem:** TMB calculation gives unexpectedly high values
**Solution:** Verify exome capture size. Check for germline contamination (apply germline resource filter). Ensure proper Mutect2 filtering.

## Resources

- [GATK Best Practices](https://gatk.broadinstitute.org/hc/en-us/sections/360007226651-Best-Practices-Workflows)
- [CNVkit Documentation](https://cnvkit.readthedocs.io/)
- [SnpEff Documentation](https://pcingola.github.io/SnpEff/)
- [COSMIC Database](https://cancer.sanger.ac.uk/cosmic)
- [ClinVar](https://www.ncbi.nlm.nih.gov/clinvar/)
