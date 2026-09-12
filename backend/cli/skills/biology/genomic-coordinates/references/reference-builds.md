# Reference builds, contig naming, and liftover

A coordinate is meaningless without the assembly it was measured against. Two
files can share contig names, share a coordinate range, join cleanly, and refer
to different parts of the genome.

All lengths below were read from the UCSC `bigZips` `chrom.sizes` for each
assembly and cross-checked against the NCBI assembly report for GRCh37.p13,
verified 2026-07-26. `scripts/check_contigs.py` carries the same table and
matches files against it.

## Discriminating lengths

| Contig | GRCh37 / hg19 | GRCh38 / hg38 | T2T-CHM13v2.0 / hs1 |
| --- | --- | --- | --- |
| chr1 | 249,250,621 | 248,956,422 | 248,387,328 |
| chr2 | 243,199,373 | 242,193,529 | 242,696,752 |
| chrX | 155,270,560 | 156,040,895 | 154,259,566 |
| chrY | 59,373,566 | 57,227,415 | 62,460,029 |
| chrM / MT | 16,571 *(hg19)* / 16,569 *(GRCh37)* | 16,569 | 16,569 |

```bash
python3 check_contigs.py --identify unknown.fa.fai
```

## GRCh37 is not hg19

They are the same assembly for every primary chromosome except the
mitochondrion. UCSC's hg19 kept the older `NC_001807` sequence at **16,571 bp**;
GRCh37 adopted the revised Cambridge Reference Sequence (rCRS, `NC_012920`) at
**16,569 bp**. GRCh38 also uses rCRS, so chrM length distinguishes hg19 from
everything else but does not distinguish GRCh37 from GRCh38.

Consequences:

- Every mitochondrial coordinate differs between an hg19 BAM and a GRCh37 VCF.
  Nuclear coordinates are identical, so the pipeline runs and only mtDNA results
  are wrong — which is the hardest kind of error to notice.
- Mitochondrial heteroplasmy and haplogroup calls made against hg19 cannot be
  compared to anything rCRS-based without re-calling.

The two also differ in naming and in alternate-haplotype handling:

| | GRCh37 (Ensembl/NCBI) | hg19 (UCSC) |
| --- | --- | --- |
| Autosomes | `1`, `2`, … | `chr1`, `chr2`, … |
| Mitochondrion | `MT` (16,569) | `chrM` (16,571) |
| Alt haplotypes | `GL000250.1`-style | 9 `chr6_cox_hap2`-style contigs |
| Unplaced | `GL000191.1`-style | `chrUn_gl000191` |

### The b37 family

`b37` (Broad) is GRCh37 with plain naming and rCRS `MT`. `hs37d5` (1000 Genomes
phase 2) is b37 plus a decoy contig (`hs37d5`) and the EBV genome. Primary
coordinates are identical across all three, so they interconvert by renaming
contigs — no liftover. Reads that map to the decoy in `hs37d5` will map somewhere
in the primary assembly in b37, which changes coverage and variant calls in the
affected regions even though the coordinate system did not move.

## GRCh38 and its ALT contigs

hg38 as UCSC ships it has 25 primary contigs, **261 `_alt`** contigs, 42
`_random`, and 127 `chrUn_`. The ALT contigs are alternate representations of
regions that are genuinely polymorphic — mostly MHC, and the HLA haplotypes.

They break naive analysis in a specific way: a read from an ALT region can map
equally well to the primary contig and to its ALT, so both alignments get
`MAPQ 0` and every variant caller with a MAPQ filter drops the region entirely.
Coverage plots show a hole where the MHC should be.

The usual fixes:

- **No-ALT analysis set** — the primary assembly with ALT contigs removed. The
  simplest option and the right default unless you specifically want HLA typing.
- **ALT-aware alignment** — `bwa-mem` with the `.alt` file and `bwa-postalt.js`,
  which lifts ALT alignments back to the primary contigs.

Analysis sets also hard-mask the pseudoautosomal regions on chrY, so that PAR
reads map to chrX rather than splitting between the two. Contig *lengths* are
unchanged by masking, so `check_contigs.py` still identifies a masked analysis
set as GRCh38 — masking is invisible in the contig table and has to be checked
by looking at the sequence.

Patch releases (`GRCh38.p13`, `p14`) add `_fix` and new `_alt` contigs but never
move a coordinate on a primary chromosome. A p13 coordinate is a p14 coordinate.

## T2T-CHM13

CHM13v2.0 is a genuinely different assembly, not a patch: every coordinate
differs, and it adds sequence that has no GRCh38 coordinate at all (centromeric
satellite arrays, acrocentric short arms). There is no clean liftover for the
newly resolved regions, because there is nothing to lift them to. Most public
annotation, most clinical variant databases, and most published coordinates are
still GRCh38.

## Contig naming

Four naming schemes are in circulation for the same chromosome:

```
chr1            UCSC
1               Ensembl, NCBI, GATK b37
NC_000001.11    RefSeq accession (GRCh38); NC_000001.10 is GRCh37
CM000663.2      GenBank accession (GRCh38); CM000663.1 is GRCh37
```

Note that the accession's version suffix, not the base accession, carries the
build. `NC_000001.10` and `NC_000001.11` differ only in the last character and
are different assemblies.

Renaming is the fix, and `bcftools annotate --rename-chrs`, `samtools reheader`,
and a two-column mapping file all do it. Two rules:

- Rename the **smaller, cheaper** file, and rename it to match the reference —
  never rename the reference.
- `chrM` ↔ `MT` is a rename **only** between GRCh37 and GRCh38-family files. Between
  hg19 and anything rCRS-based it is a lie, because the sequences differ.

A join across naming schemes does not error. It returns the rows that happen to
match — often zero, sometimes a misleading subset when one file is partly
renamed. `check_contigs.py` reports the naming style of each file and refuses to
call two files compatible when they disagree.

## Liftover

`liftOver` (UCSC, with a `.chain` file) and `CrossMap` (which also handles BAM,
VCF, and BigWig) are the working tools. Both are approximate by nature:

- **Coordinates can vanish.** A region deleted from the newer assembly has no
  target. liftOver writes these to its unmapped file, which is easy to ignore and
  should be counted every time.
- **Mappings can be one-to-many.** A region duplicated in the target maps to
  several places; taking the first is a silent choice.
- **Strand can flip.** Inverted segments between builds mean a plus-strand
  feature lifts to the minus strand. Interval files carry this fine; anything
  where sequence orientation matters (primer sites, guide RNAs, motif hits) does
  not.
- **Interval endpoints can lift independently.** A long feature can lift to a
  different length, or split.
- **Variants need more than coordinates.** After lifting a VCF, `REF` may no
  longer match the new reference, and if the segment inverted, `REF` and `ALT`
  need reverse-complementing. `CrossMap vcf` handles this; a coordinate-only lift
  does not. Always re-run `normalize_variant.py` against the *target* reference
  afterwards and count the `MISMATCH` rows.

Lifting twice — 37 → 38 → 37 — does not reliably return the original
coordinates. When the original data can be re-processed against the target build,
that is more accurate than any liftover.

## A note on what to record

Coordinates in a results table, a figure, or a supplementary file should say
which build they are in, next to the numbers. "chr7:5,530,601-5,530,625" is not a
location. "chr7:5,530,601-5,530,625 (GRCh38)" is.
