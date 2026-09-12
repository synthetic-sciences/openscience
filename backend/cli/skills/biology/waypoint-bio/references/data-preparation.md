# Preparing data for Waypoint

## Waypoint format

Rows are samples. Two aligned list-columns, plus whatever labels you need.

| Column | Type | Required |
| --- | --- | --- |
| `Taxa` | `list[str]` — full lineage strings | yes |
| `Relative Abundances` | `list[float]` — same length and order as `Taxa` | yes |
| `Split` | `str` — `train` / `validation` / `test` | only when using `split_column` |
| *(any)* | scalar targets and covariates | as needed |

The DataFrame index holds the sample ID and is preserved through `embed`.

Use `.parquet`. CSV/TSV works but stores each list as its Python `repr`, parsed back with
`ast.literal_eval` — brittle and large.

```python
import pandas as pd

df = pd.DataFrame(
    {
        "Taxa": [["k__Bacteria; p__Firmicutes; c__Bacilli; o__Lactobacillales; f__Lactobacillaceae; g__Lactobacillus",
                  "k__Bacteria; p__Bacteroidota; c__Bacteroidia; o__Bacteroidales; f__Bacteroidaceae; g__Bacteroides"]],
        "Relative Abundances": [[0.41, 0.59]],
        "Group": ["Case"],
    },
    index=pd.Index(["sample_001"], name="sample_id"),
)
df.to_parquet("dataset.parquet")
```

## How taxonomy strings are read

`TaxonomicTokenizer` splits each lineage on `;`, strips whitespace, and inspects each segment's
three-character prefix:

| Prefix | Rank |
| --- | --- |
| `s__` | species |
| `g__` | genus |
| `f__` | family |
| `o__` | order |
| `c__` | class |
| `p__` | phylum |
| `k__` | kingdom |

With `taxon_rank: genus` and `fallback_to_higher_rank: true` (the published defaults), each lineage
becomes one token:

1. If a `g__` segment exists, that segment *including the prefix* is the token — `g__Lactobacillus`.
2. Otherwise the **most specific higher rank** present is used — a lineage stopping at
   `f__Lactobacillaceae` tokenises to `f__Lactobacillaceae`.
3. If nothing matches, the token is `<unk>`.

Consequences that bite:

- **Any prefix outside that table is invisible.** QIIME 2 / SILVA / Greengenes2 write the domain as
  `d__Bacteria`; `d__` is not in the table, so such a segment is skipped entirely. A lineage
  truncated at domain becomes `<unk>`. Rewrite `d__` to `k__`.
- **A `s__` species segment does not help by itself.** Species is *more* specific than genus, so
  fallback (which only goes up) cannot use it. A lineage with `s__` but no `g__` tokenises to
  whatever higher rank is present — or `<unk>` if none is. Keep the full lineage, not just the tip.
- **Separator is `;`, not `|`.** A `|`-joined MetaPhlAn lineage is one unsplittable segment. Its
  first three characters are `k__`, so it matches at kingdom rank and the *entire pipe-joined
  string* is returned as a single token — which is not in the vocabulary, so it becomes `<unk>`.
  Verified against `TaxonomicTokenizer` 1.0.2:
  `k__Bacteria|p__Firmicutes|g__Lactobacillus` extracts to itself, while the `;`-separated form
  extracts to `g__Lactobacillus`.
- **Bare names never tokenise.** `Lactobacillus` has no prefix. Use `prepare-dataset
  --taxonomy_format genus` to prefix them, accepting the loss of fallback.

## Token ordering and truncation

Samples are encoded as `[BOS] + ordered_token_ids + [EOS]`, padded to `max_length` (512).

Ordering is by **descending abundance z-score** — `(ra - mean) / std` per token, using
`token_std_means.parquet` from the checkpoint. This puts taxa that are unusually abundant *for that
taxon* first, rather than merely abundant. Without that file, ordering falls back to raw descending
abundance.

Because truncation is applied after ordering, a sample with more than 510 in-vocabulary taxa loses
its least distinctive ones. That is the intended behaviour, but it means `max_length` interacts with
how deeply you profiled.

## Out-of-vocabulary taxa

The vocabulary is frozen at pretraining time from the Atlas corpus. During `waypoint embed`, tokens
resolving to `<unk>` are dropped before ordering; during fine-tuning and benchmarking,
`filter_unk_taxa: true` does the same. Neither warns you.

Every Compass dataset carries out-of-vocabulary taxa, and the paper names this the models' key
limitation. Measure it before drawing conclusions:

```bash
python scripts/vocab_coverage.py --model outpost-bio/Waypoint-6m --data dataset.parquet
```

If coverage is poor, the usual causes are, in order: a different taxonomy database (SILVA vs. NCBI
vs. GTDB naming), the `d__` prefix problem, `|` separators, and genuinely novel environments.

## Converting profiler output

`waypoint prepare-dataset` reads a plain abundance matrix whose labels are already `;`-separated
lineages. `scripts/profiler_to_waypoint.py` handles the formats it cannot.

### MetaPhlAn

Merged tables from `merge_metaphlan_tables.py`: rows are clades with `|`-separated lineages, columns
are samples, values are **percentages**, and the table is cumulative — every rank appears as its own
row.

```bash
python scripts/profiler_to_waypoint.py \
    --input merged_abundance_table.txt --format metaphlan \
    --rank species --output dataset.parquet
```

The converter drops `#` comment lines and the `NCBI_tax_id` / `clade_taxid` column, keeps only rows
whose deepest rank equals `--rank` (default `species`, which avoids double-counting parents),
rewrites `|` to `; `, and renormalises each sample to sum to 1. Strain rows (`t__`) are always
excluded.

### Kraken2 / Bracken

Kraken2 reports are per-sample and encode the hierarchy as two-space indentation, with no lineage
string. Pass one report per sample:

```bash
python scripts/profiler_to_waypoint.py \
    --input reports/*.kreport --format kraken \
    --rank species --output dataset.parquet
```

The converter walks the indentation to rebuild each lineage, maps Kraken rank codes to prefixes
(`D`/`K` → `k__`, `P` → `p__`, `C` → `c__`, `O` → `o__`, `F` → `f__`, `G` → `g__`, `S` → `s__`),
skips sub-ranks (`D1`, `S1`, …) and unclassified rows, takes clade-level read counts at the target
rank, and normalises. Sample IDs come from the filenames. Both the 6-column and the 8-column
(`--report-minimizer-data`) layouts are handled.

Bracken's own `.bracken` output carries no lineage at all — use the Kraken-style report Bracken
writes with `-o`/`--report`, not the tabular abundance file.

### QIIME 2 / biom TSV

Exported feature tables with a `taxonomy` column (or `#OTU ID` rows already labelled by lineage):

```bash
python scripts/profiler_to_waypoint.py \
    --input feature-table.tsv --format qiime2 \
    --taxonomy-column taxonomy --output dataset.parquet
```

The converter strips the `# Constructed from biom file` banner, uses the taxonomy column as the
lineage, rewrites `d__` to `k__`, and normalises counts to relative abundances. Features whose
taxonomy is `Unassigned` are dropped.

### MGnify

MGnify amplicon abundance TSVs are taxa-as-rows with a `taxonomy` first column and `;`-separated
lineages — the native layout. `waypoint prepare-dataset --orientation auto` reads them directly; no
conversion needed. This is the format Atlas itself was built from.

### Anything else

If you already have a sample × taxa table with lineage labels, use `--format generic`, which applies
only the separator and prefix normalisation:

```bash
python scripts/profiler_to_waypoint.py \
    --input my_table.tsv --format generic --orientation taxa_as_rows \
    --output dataset.parquet
```

## Attaching labels

Either merge them at conversion time —

```bash
waypoint prepare-dataset --input matrix.tsv --metadata labels.csv --output dataset.parquet
python scripts/profiler_to_waypoint.py --input ... --metadata labels.csv --output dataset.parquet
```

— where `labels.csv` is indexed by sample ID, or join afterwards in pandas. Sample IDs must match
exactly; the converters do an inner-style alignment and will silently produce `NaN` targets for
unmatched rows, which then fail at fine-tuning time.

## Splits

`waypoint finetune` defaults to a random 80/10/10 split. Add a `Split` column and set
`split_column: Split` in the config whenever samples are not independent:

- longitudinal cohorts (the Roswall infant data is exactly this shape),
- technical or biological replicates,
- multiple communities derived from one donor,
- multiple drugs applied to the same starting community.

Grouping by subject or study when you build `Split` is the difference between a generalisation
estimate and a memorisation estimate.
