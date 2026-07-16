# Standard NMR Libraries

Use these as the default comparison set for this skill.

## BMRB Metabolomics

- URL: https://bmrb.io/metabolomics/
- Best for:
  - metabolite-heavy or biofluid-like samples
  - peak-list style comparisons
  - solvent and field-aware matching

## HMDB 1D NMR

- URL: https://hmdb.ca/spectra/nmr_one_d
- Best for:
  - metabolomics-adjacent biological samples
  - curated metabolite reference spectra

## SDBS

- Intro: https://sdbs.db.aist.go.jp/Htmls/Introduction_eng.html
- Search: https://sdbs.db.aist.go.jp/SearchResult.aspx
- Best for:
  - small organic molecules
  - common synthetic compounds, solvents, and reagents

## nmrshiftdb2

- URL: https://nmrshiftdb.nmr.uni-koeln.de/nmrshiftdbhtml/t1.html
- Best for:
  - broader organic chemistry coverage
  - structure-aware comparison and prediction support

## Comparison rules

- match nucleus first
- match solvent second
- match field strength third
- if those do not align, downgrade confidence explicitly
- if the spectrum suggests multiple components, do not force a single-compound answer

## Local candidate format

Export or transcribe candidate peak lists into JSON:

```json
{
  "candidates": [
    {
      "name": "candidate name",
      "nucleus": "1H",
      "solvent": "D2O",
      "field_mhz": 600,
      "source": "BMRB",
      "url": "https://example.org/reference-entry",
      "peaks": [1.234, 3.456, 7.89]
    }
  ]
}
```

Alternatively use CSV with one peak per row and columns `name,nucleus,position,solvent,field_mhz,source,url`. Keep the source URL with every candidate so a reviewer can inspect the original spectrum and metadata.
