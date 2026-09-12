# Lineage nomenclature

Naming systems are not interchangeable, are not stable, and several run side by side on the same
instance. Values below were read from the live instances on 2026-07-27 and will have moved by the
time you read this — the point is the *structure*, not the specific names.

## SARS-CoV-2

Four naming systems coexist on the open instance:

| Column | Example values | What it is |
| --- | --- | --- |
| `pangoLineage` | `XFG.1.1`, `PQ.17`, `RE.2` | Pango designation; the fine-grained system |
| `nextcladePangoLineage` | same vocabulary | Nextclade's own call, assigned by a versioned dataset |
| `nextstrainClade` | `25C`, `25B`, `25I`, `recombinant` | Coarse year-plus-letter clades |
| `whoClade` | `Omicron`, mostly null | WHO Greek labels |

Two consequences worth knowing before choosing a column:

- **`nextstrainClade` collapses every recombinant into one bucket.** 627 sequences collected in
  2026 are labelled simply `recombinant`. Since the currently dominant lineages *are*
  recombinants, `nextstrainClade` cannot distinguish XFG from XFJ. Use `pangoLineage` for anything
  lineage-specific.
- **`whoClade` is effectively retired.** It is null for the large majority of 2026 sequences; no
  Greek letter has been assigned beyond Omicron. Do not expect a Greek label for a current lineage,
  and do not invent one.

### How Pango names are built

Names root at `A` or `B` and extend by dots. Once a name would exceed three numeric levels it is
**aliased** to a new letter prefix, and the alias key is the only way back:

```
PQ.17  = XDV.1.5.1.1.8.1.17
RE.2   = BA.3.2.2.2 = B.1.1.529.3.2.2.2
```

`scripts/lapis_client.py:unalias_full()` walks this using the live `alias_key.json`. There is no
way to derive it — the mapping is a file that changes.

### Recombinants

Names beginning `X` are recombinants. Their alias entry is a **list of parents**, not a path:

```json
{"XFG": ["LF.7", "LP.8.1.2"], "XFJ": ["LS.2.1.1", "LF.7.2"]}
```

LAPIS's own lineage definition does **not** carry this — it roots every `X*` lineage, and no entry
in that document has more than one parent. Ask LAPIS for `XFG`'s parents and you get nothing. Both
sources are required: LAPIS for the descendant index that queries use, `alias_key.json` for
parentage.

A recombinant's descendants alias normally (`XFG.1.1` → `XFG.1` → `XFG`), so ancestry *below* the
recombination point behaves like any other lineage.

### Designation churn

`lineage_notes.txt` currently lists ~6,230 names, of which **294 are withdrawn or redesignated**.
Entries are prefixed `*`:

```
*PC.2      Redesignated as LF.7.9, S:L441R, S:H445P, Wales/Scotland
*XFG.20    Withdrawn: C10615T (didn't realize it was a dropout branch of XFG.3)
*MC.34     Withdrawn: Alias of B.1.1.529.2.86.1.1.11.1.3.1.1.34
```

This is what makes a remembered lineage fact actively wrong rather than merely stale. Two
follow-on effects:

- **A withdrawn name can still be attached to sequences.** `PC.2` was redesignated `LF.7.9`
  upstream, yet 25 sequences still carry `PC.2` because the instance's assignment pipeline lags
  designation. Both facts are true; report the redesignation alongside the count.
- **Nextclade calls depend on the dataset version.** The SARS-CoV-2 instance records
  `nextcladeDatasetVersion` per sequence. Two sequences called on different dataset versions can
  carry different lineage labels for identical genomes. Re-fetch the dataset
  (`data.clades.nextstrain.org/v3`) before calling your own sequences, and record the version.

## Influenza

| Instance | Column | Live values |
| --- | --- | --- |
| `h3n2`, `h1n1pdm` | `cladeHA` (also `cladeNA`) | `K` (88.9% of 2025/26 H3N2), `J.2.4`, `J.2.3`, `J.2.2`, `unassigned` |
| `h5n1` | `clade` | `2.3.4.4b` (essentially all of the current US data), `Am-nonGsGD` |
| `influenza-a` | `subtypeHA` / `subtypeNA` | `H3`, `H5`, `H1`, `H9`, `H10` |

Three cautions:

- **HA and NA are called separately** and can disagree; a reassortant is normal, not an error.
  `cladeHA` is the one antigenic and vaccine-strain discussion refers to, which is why the field
  picker prefers it.
- **`unassigned` is a real category**, not a null. Excluding it silently inflates every other
  clade's proportion.
- **H5N1 genotypes are not in this data.** The US genotype calls that dominate reporting — `B3.13`
  (the dairy-cattle genotype) and `D1.1` (the poultry and wild-bird genotype) — describe the
  reassortment pattern across all eight segments. The instance carries `clade` only, so both
  genotypes appear identically as `2.3.4.4b`. Genotype must come from a whole-genome tool such as
  GenoFLU, or from USDA/CDC reporting. Do not infer a genotype from a clade query, and do not
  present `2.3.4.4b` counts as genotype counts. Host is often the more informative axis available
  here: filtering US 2.3.4.4b by `hostNameScientific` separates `Bos taurus` from
  `Gallus gallus` and wild birds directly.

## Other pathogens

| Instance | Columns | Notes |
| --- | --- | --- |
| `mpox` | `clade`, `outbreakLineage`, `lineage` | Two orthogonal systems: `clade` is `Ia`/`Ib`/`IIa`/`IIb`; `outbreakLineage` is `sh2023/A.1`-style. Only `outbreakLineage` is indexed. |
| `rsv-a`, `rsv-b` | `lineage` (indexed), `subtype` | Post-2021 consensus lineage nomenclature (`A.D.5.2`-style) |
| `dengue` | `lineage` (indexed), `serotype` | Serotype and lineage are different questions; pick deliberately |
| `measles` | `genotype` | WHO genotypes (`B3`, `D8`, …), not indexed |
| `west-nile` | `lineage` | Not indexed |
| `cchf` | `lineage_S` | Named after the segment it is called on |
| `hmpv` | `lineage` (indexed) | |
| `ebola-zaire`, `ebola-sudan` | none | No lineage column exists; counts and lag still work |

`resolve_lineage.py` prints the alternatives it did not pick, so run it once against an unfamiliar
instance before committing to a column.

## Choosing a column

1. Prefer an **indexed** column when the question involves descendants — only those support `NAME*`.
2. Prefer the **finest** system that answers the question. Coarse clades hide the distinction you
   are usually asking about (`nextstrainClade` and recombinants being the clearest case).
3. Say which column you used. "XFG.1.1 is 35% of US sequences" is ambiguous until you add
   *`pangoLineage`, exact name, not including descendants* — three separate choices, each of which
   changes the number.
