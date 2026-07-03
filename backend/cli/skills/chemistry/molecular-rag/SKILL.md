---
name: molecular-rag
description: Retrieve structurally similar compounds with known properties from ChEMBL/ZINC to ground predictions and inform optimization. Based on MolRAG (Xian 2025, ACL).
category: chemistry
license: MIT
metadata:
    skill-author: Synthetic Sciences
version: 1.0.0
tags: [drug-discovery, RAG, retrieval, ChEMBL, analog-search, grounding]
dependencies: ["rdkit-pypi", "requests", "pandas"]
---

# Molecular RAG (Retrieval-Augmented Generation)

## Overview

LLMs hallucinate molecular properties. This skill grounds predictions by retrieving structurally similar compounds with experimentally measured properties from ChEMBL and ZINC. When the agent says "this compound should have good hERG safety," it can now check what happened with similar compounds in real assays.

Based on:
- **MolRAG** (Xian et al., 2025, ACL): RAG for molecular property prediction — retrieves similar compounds to ground LLM predictions

## When to Use This Skill

- **Before property prediction**: Retrieve analogs with known properties for context
- **Lead optimization**: Find what modifications worked for similar scaffolds
- **Novelty assessment**: Check if your generated molecule is truly novel or already known
- **SAR grounding**: Ground structure-activity reasoning in experimental data

**Do NOT use this skill for:**
- Bulk database queries (use `chembl-database` or `pubchem-database` directly)
- De novo generation (use `denovo-design`)

### Related Skills
- **chembl-database**: Direct ChEMBL API access
- **pubchem-database**: PubChem compound lookup
- **zinc-database**: ZINC compound search
- **admet-reasoning**: Interpret properties of retrieved analogs

## Installation

```bash
pip install rdkit-pypi requests pandas
```

## Core Workflows

### 1. Find Similar Compounds with Known Properties

```bash
python scripts/retrieve_analogs.py \
    --smiles "c1ccc(NC(=O)c2ccccc2Cl)cc1" \
    --similarity-threshold 0.6 \
    --max-results 20 \
    --output analogs.json
```

### 2. Target-Specific Analog Search

```bash
python scripts/retrieve_analogs.py \
    --smiles "c1ccc(NC(=O)c2ccccc2Cl)cc1" \
    --target CHEMBL25 \
    --output target_analogs.json
```

### 3. SAR Context for Optimization

```bash
python scripts/retrieve_analogs.py \
    --smiles "c1ccc(NC(=O)c2ccccc2Cl)cc1" \
    --include-activities \
    --output sar_context.json
```

## Script Reference

| Script | Purpose | Key Outputs |
|--------|---------|-------------|
| `retrieve_analogs.py` | Find similar compounds with experimental data | JSON with analogs, similarities, bioactivities |
