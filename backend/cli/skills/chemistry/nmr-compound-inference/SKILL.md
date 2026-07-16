---
name: nmr-compound-inference
description: Analyze local 1D 1H or 13C NMR spectra, extract peaks, compare them with local reference exports from BMRB, HMDB, SDBS, nmrshiftdb2, or curated libraries, and produce a ranked candidate report with mismatch evidence. Use for Bruker, NMRPipe, or two-column ppm/intensity data when compound identification or spectrum triage is requested.
category: chemistry
---

# NMR Compound Inference

Analyze a local 1D spectrum, generate evidence artifacts, and rank compounds from supplied reference data. Treat the result as inference until orthogonal evidence confirms identity.

## Best fit

- `1H` and `13C` 1D spectra
- Bruker processed `pdata`, Bruker raw `fid`, NMRPipe 1D files, or two-column `ppm,intensity` text exports
- Samples with one dominant component

## Required inputs

- local spectrum path
- preferably nucleus, solvent, and field strength
- any sample context that narrows candidate chemistry

## Dependencies

Install dependencies from this skill directory:

```bash
# Conda
conda env create -f environment.yml
conda activate openscience-nmr

# pip
python3 -m pip install nmrglue numpy matplotlib
```

This skill depends on the upstream `nmrglue` package and does not bundle the `nmrglue` source code.

## Workflow

1. Read `references/standard-libraries.md`. Obtain candidate peak data from the source most appropriate for the sample, and normalize it to the documented JSON or CSV schema.

2. Run the helper to generate the evidence package and rank the supplied library:

```bash
python3 scripts/nmr_candidate_report.py \
  --input "<path-to-spectrum>" \
  --output-dir "./outputs/$(date +%F)" \
  --nucleus "1H" \
  --library "<reference-candidates.json>"
```

Pass multiple `--library` arguments when candidates come from several sources. Include metadata for better ranking:

```bash
python3 scripts/nmr_candidate_report.py \
  --input "<path-to-spectrum>" \
  --output-dir "./outputs/$(date +%F)" \
  --nucleus "1H" \
  --solvent "D2O" \
  --field-mhz 600 \
  --library "<bmrb-export.json>" \
  --library "<curated-candidates.csv>"
```

3. Review the generated outputs:
   - `spectrum.png` — Plot of the processed spectrum
   - `peak_table.csv` — Extracted peak positions and intensities
   - `analysis_summary.json` — Structured summary for downstream processing
   - `analysis_report.md` — Human-readable report with search recommendations

4. Inspect each candidate's matched peaks, missing reference peaks, unmatched observed peaks, solvent/field metadata, and source URL. Do not report a top hit without discussing the mismatches.

5. Return a report with:
   - problem type
   - what data was analyzed
   - plot path
   - major peaks
   - library links searched
   - top 1-3 ranked candidates, scores, and direct source links
   - confidence, mismatch notes, and what would disambiguate the call

## Comparison rules

The helper performs one-to-one ppm matching, uses a default tolerance of `0.08 ppm` for `1H` and `0.8 ppm` for `13C`, and penalizes solvent and field mismatches. Override `--tolerance-ppm` when linewidth, referencing, or acquisition conditions justify it.

When interpreting results:

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
- Use the nucleus-specific pattern hints only as broad heuristics. The `13C` regions are not interpreted with `1H` ranges.

## Upstream references

- nmrglue GitHub: https://github.com/jjhelmus/nmrglue
- nmrglue documentation: https://nmrglue.readthedocs.io/
