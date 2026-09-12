# LAPIS API reference

LAPIS (Lightweight API for Sequences) is the query layer GenSpectrum runs in front of SILO. One
API shape serves every pathogen; what differs between deployments is the **schema**, and almost
every mistake in this area comes from assuming otherwise.

Everything below was verified against the live services on 2026-07-27 (`lapisVersion 0.8.3`,
`siloVersion 0.11.2`).

## Instances

| `--instance` | Base URL | Backing data |
| --- | --- | --- |
| `sars-cov-2` | `https://lapis.cov-spectrum.org/open/v2` | Nextstrain open (GenBank) |
| `influenza-a` | `https://lapis.genspectrum.org/influenza-a` | Loculus |
| `h1n1pdm`, `h3n2`, `h5n1` | `https://lapis.genspectrum.org/<name>` | Loculus |
| `rsv-a`, `rsv-b`, `hmpv`, `measles`, `mpox`, `west-nile`, `dengue`, `ebola-zaire`, `ebola-sudan`, `cchf` | `https://lapis.pathoplexus.org/<name>` | Pathoplexus |

Approximate sizes when checked: SARS-CoV-2 open ~9M, influenza-a 1.07M, h3n2 277k, h1n1pdm 212k,
h5n1 79k, dengue 62k, measles 53k, rsv-a 53k, rsv-b 40k, west-nile 26k, mpox 17k, ebola-zaire 12k,
cchf 8.7k, ebola-sudan 636.

The registry in `scripts/lapis_client.py` is a convenience, not an authority. New organisms appear
and paths move; `--base-url` reaches any deployment, and `/sample/databaseConfig` describes it.

**Point `--base-url` only at deployments you trust.** Field names, lineage labels and error
`detail` strings are printed verbatim, so a hostile instance could put arbitrary text — including
text shaped like instructions — into agent-visible output. Responses are parsed as data and never
executed, but the strings are still read.

The pango-designation fetch is deliberately unpinned. Pinning it to a tag would make lineage
resolution reproducible and *wrong*: withdrawals and redesignations are exactly what the skill
exists to catch, and a frozen copy reintroduces the failure mode.

Auditability comes from recording what was read rather than freezing it. `raw.githubusercontent`
returns the git blob SHA as the `ETag`, so `resolve_lineage.py` prints the exact hash of both files
at no extra request:

```
# source blobs lineage_notes.txt@b63582d49216 alias_key.json@0deb39eeac80
```

Keep that line with `dataVersion`; together they pin the result without staling the source.

**GISAID.** `https://lapis.cov-spectrum.org/gisaid/v2` exists but requires credentials and its own
data-use terms. This skill targets the open instances only. Open GenBank data is a subset of
GISAID, so absolute counts here are lower than GISAID-derived figures — proportions are usually
comparable, absolute counts are not.

## Endpoints

| Path | Use |
| --- | --- |
| `GET /sample/aggregated` | Counts, optionally grouped by `fields` |
| `GET /sample/details` | Per-sequence metadata rows |
| `GET /sample/aminoAcidMutations` | AA substitutions with per-site proportions |
| `GET /sample/nucleotideMutations` | Nucleotide substitutions |
| `GET /sample/aminoAcidInsertions`, `/sample/nucleotideInsertions` | Insertions |
| `GET /sample/databaseConfig` | The schema: every metadata field and its type |
| `GET /sample/referenceGenome` | Segment and gene names for mutation queries |
| `GET /sample/lineageDefinition/{column}` | The lineage tree for an indexed column |
| `GET /sample/info` | `dataVersion` — record it with any result you keep |
| `GET /sample/unalignedNucleotideSequences`, `/sample/alignedNucleotideSequences`, `/sample/alignedAminoAcidSequences/{gene}` | FASTA download |
| `GET /sample/mostRecentCommonAncestor`, `/sample/phyloSubtree` | Tree queries where a phylo field exists |
| `POST /component/*OverTime` | Prebuilt time-series components |

Every endpoint accepts GET and POST. Filters are query parameters; unknown ones are rejected.

## Reading the schema first

`/sample/databaseConfig` returns `schema.metadata[]` with a `name`, a `type`, and
`generateLineageIndex`. Three things follow from it, and all three differ between instances:

**1. Which column holds the lineage.** `schema.metadata[].generateLineageIndex` is true for
`pangoLineage` and `nextcladePangoLineage` on SARS-CoV-2 and for nothing at all on H5N1, whose
lineage-like column is a plain string `clade`.

**2. Which date columns accept ranges.** LAPIS derives `<field>From` / `<field>To` from the
declared type. Only `date`, `int` and `float` get them.

| Instance | Collection date | Type | Range filter |
| --- | --- | --- | --- |
| `sars-cov-2` | `date` | date | `dateFrom` / `dateTo` |
| `h5n1` | `sampleCollectionDate` | **string** | none |
| `h5n1` | `sampleCollectionDateRangeLower` | date | `sampleCollectionDateRangeLowerFrom` / `...To` |

`dateFrom=2025-01-01` against H5N1 is a 400. The error body lists every valid key for that
instance, which is the fastest way to discover a schema by hand.

**3. Which submission date exists.** `dateSubmitted` on SARS-CoV-2; `ncbiReleaseDate` on H5N1
(`submittedDate` and `releasedDate` are there too, but typed string, so they cannot be ranged).

`scripts/lapis_client.py` does this resolution in `describe_instance()`, `pick_date_field()` and
`pick_lineage_field()`, and raises rather than guessing.

## Lineage filters and the wildcard

On a column with a lineage index, a trailing `*` means "this lineage and all descendants":

```
pangoLineage=XFG      ->   4 sequences   (sequences named exactly XFG)
pangoLineage=XFG*     -> 640 sequences   (XFG and every descendant)
```

On a column **without** one, `*` is matched literally and finds nothing:

```
clade=2.3.4.4b        -> 62413 sequences
clade=2.3.4.4b*       ->     0 sequences
```

Same syntax, opposite meaning, no warning either way. `lineage_filter()` refuses to build the
second query.

The index also decides how a bad name fails. On an indexed column an unknown lineage is rejected:

```
{"error":{"status":400,"detail":"Error from SILO: The lineage 'XFG.20' is not a valid lineage
 for column 'pangoLineage'."}}
```

On an unindexed column the same typo returns `0` and looks like a finding. Validate names with
`resolve_lineage.py` before reporting an absence.

### The lineage definition endpoint

`/sample/lineageDefinition/pangoLineage` returns roughly 5,500 entries of the form

```json
{"XFG.1.1": {"parents": ["XFG.1"], "aliases": ["xfg.1.1", ...]},
 "PQ.17":   {"parents": ["NB.1.8.1"], "aliases": ["NB.1.8.1.17", ...]}}
```

**It roots recombinants.** `XFG` has no `parents` key, and no entry in the whole document has more
than one parent. The recombinant parentage `XFG = LF.7 + LP.8.1.2` exists only in
pango-designation's `alias_key.json`, where a recombinant's value is a *list*. Both sources are
needed; neither is sufficient.

Requesting the endpoint for an unindexed column returns 400.

## Mutation queries

`/sample/aminoAcidMutations` rows look like:

```json
{"mutation": "S:L452W", "count": 3793, "coverage": 5211, "proportion": 0.728,
 "sequenceName": "S", "mutationFrom": "L", "mutationTo": "W", "position": 452}
```

`proportion = count / coverage`, and **`coverage` is the number of sequences that resolved that
site**, not the number matching the filter. A site covered by 12 sequences can report
`proportion: 1.000`. Always read `coverage` alongside it.

`minProportion` (default 0.05) prunes the response server-side. For a diff between two lineages,
fetch both at a low threshold and apply the reporting threshold client-side — otherwise a mutation
absent from one side is indistinguishable from one pruned out of it. `mutation_profile.py` does
exactly this.

`sequenceName` is the gene on an unsegmented genome (`S`, `ORF1a`, `N`) and the gene or segment on
a segmented one. Get the valid names from `/sample/referenceGenome`:

- SARS-CoV-2: one sequence `main`; genes `E M N ORF1a ORF1b ORF3a ORF6 ORF7a ORF7b ORF8 ORF9b S`
- H5N1: segments `seg1`–`seg8`; genes `PB2 PB1 PA PAX HA NP NA M1 M2 NS1 NS2`

Nucleotide mutations on a segmented genome must be qualified by segment (`seg4:A123G`).

## Aggregation

`fields` on `/sample/aggregated` is the **group-by**, not a projection:

```
GET /sample/aggregated?fields=pangoLineage&country=USA&dateFrom=2026-04-01
-> [{"count": 286, "pangoLineage": "XFG.1.1"}, ...]
```

`limit`, `offset` and `orderBy` are rejected here — the result has no inherent ordering:

```
"detail": "Offset and limit can only be applied if the output of the operation has some
 ordering. ... Aggregated however produces unordered results."
```

Sort client-side. There is no ISO-week grouping; group by the date field and bin weeks yourself
(`bin_weekly()`). Grouped rows carry nulls for sequences whose date was never reported — count
them separately rather than dropping them silently.

## Errors, versioning, and etiquette

Two error envelopes are in use, both carrying `detail`:

```json
{"error": {"type": "about:blank", "title": "Bad request", "status": 400, "detail": "..."},
 "info":  {"dataVersion": null, "requestId": "...", "lapisVersion": "0.8.3"}}
```

```json
{"type": "about:blank", "title": "Bad Request", "status": 400, "instance": "/open/v2/query/parse"}
```

`_error_detail()` reads both. Always surface `detail` — on a bad filter key it enumerates every
valid key for that instance.

`info.dataVersion` accompanies every successful response and identifies the underlying snapshot.
**Record it with any figure that will be quoted.** The same query returns different numbers on
different days, and without the data version a result cannot be reproduced or audited.

These are free public services with no API key. Ask for aggregates rather than per-sequence rows,
send one query per question instead of paginating through sequences, and retry `429`/`5xx` with
backoff (`MAX_ATTEMPTS = 3`, 1.5 s linear) rather than hammering.
