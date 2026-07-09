---
name: nmr-compound-inference
description: Analyze 1D 1H or 13C NMR data with nmrglue, generate spectrum plots and peak tables, compare against standard NMR libraries such as BMRB, HMDB, SDBS, and nmrshiftdb2, then produce a ranked candidate-compound report with evidence, caveats, and direct links.
category: chemistry
license: MIT
metadata:
    skill-author: Robin Wu (Yaobin29)
version: 1.0.0
author: Robin Wu
tags: [NMR, Spectroscopy, Cheminformatics, Compound Identification, nmrglue, Bruker, Metabolomics]
dependencies: ["nmrglue", "numpy", "matplotlib"]
---

# NMR Compound Inference

Use this skill to analyze a local 1D NMR dataset, generate a figure and peak list, search standard reference libraries, and infer the most likely compound or a short ranked candidate list.

## Best fit

- `1H` and `13C` 1D spectra
- Bruker processed `pdata`, Bruker raw `fid`, NMRPipe 1D files, or two-column `ppm,intensity` text exports
- Samples with one dominant component

## Required inputs

- local spectrum path
- preferably nucleus, solvent, and field strength
- any sample context that narrows candidate chemistry

## Dependencies

Install dependencies via Conda (recommended) or pip:

```bash
# Conda
conda env create -f environment.yml
conda activate robin-nmr-compound-inference

# pip
python3 -m pip install nmrglue numpy matplotlib
```

This skill depends on the upstream `nmrglue` package and does not bundle the `nmrglue` source code.

## Workflow

1. Run the helper script to generate the evidence package:

```bash
python3 scripts/nmr_candidate_report.py \
  --input "<path-to-spectrum>" \
  --output-dir "./outputs/$(date +%F)" \
  --nucleus "1H"
```

Optional metadata for better matching:

```bash
python3 scripts/nmr_candidate_report.py \
  --input "<path-to-spectrum>" \
  --output-dir "./outputs/$(date +%F)" \
  --nucleus "1H" \
  --solvent "D2O" \
  --field-mhz 600
```

2. Review the generated outputs:
   - `spectrum.png` — Plot of the processed spectrum
   - `peak_table.csv` — Extracted peak positions and intensities
   - `analysis_summary.json` — Structured summary for downstream processing
   - `analysis_report.md` — Human-readable report with search recommendations

3. Read `references/standard-libraries.md` and search the relevant library sites:
   - BMRB Metabolomics: https://bmrb.io/metabolomics/
   - HMDB 1D NMR: https://hmdb.ca/spectra/nmr_one_d
   - SDBS: https://sdbs.db.aist.go.jp/SearchResult.aspx
   - nmrshiftdb2: https://nmrshiftdb.nmr.uni-koeln.de/nmrshiftdbhtml/t1.html

4. Return a report with:
   - problem type
   - what data was analyzed
   - plot path
   - major peaks
   - library links searched
   - top 1-3 candidate compounds
   - confidence, mismatch notes, and what would disambiguate the call

## Comparison rules

When comparing against reference libraries:

1. Match nucleus first
2. Match solvent second
3. Match field strength third
4. If those do not align, downgrade confidence explicitly
5. If the spectrum suggests multiple components, do not force a single-compound answer

## Guardrails

- Do not overclaim exact identity from a weak or low-resolution spectrum.
- Treat this as ranked inference unless the library match is unusually strong.
- Penalize mismatches in nucleus, solvent, field strength, or obvious peak pattern.
- If the input is raw FID and the result is magnitude-mode rather than properly phased, say that explicitly.

## Upstream references

- nmrglue GitHub: https://github.com/jjhelmus/nmrglue
- nmrglue documentation: https://nmrglue.readthedocs.io/
