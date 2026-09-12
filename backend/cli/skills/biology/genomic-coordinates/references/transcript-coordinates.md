# Transcript, CDS, and protein coordinates

Four coordinate spaces describe the same locus, and a position number is
meaningless without saying which one it is in.

| Space | Prefix | Origin | Counts |
| --- | --- | --- | --- |
| Genomic | `g.` | contig base 1 | every base, introns included |
| Transcript | `n.` | transcript base 1 | spliced bases, UTRs included |
| Coding | `c.` | the `A` of the initiator `ATG` | spliced coding bases |
| Protein | `p.` | initiator methionine | residues |

"Position 250" in a paper, a spreadsheet column, or a variant list is ambiguous
between all four, and the four differ by hundreds of bases.

## Genomic to transcript

The transcript is the concatenation of its exons in **transcription order**.
Introns are not numbered. On the minus strand, transcription order is decreasing
genomic coordinate, and the transcript sequence is the reverse complement.

Worked example, a two-exon minus-strand transcript on GRCh38:

```
exon 2:  chr1:1,000-1,099   (100 bp)   transcribed second
exon 1:  chr1:2,000-2,199   (200 bp)   transcribed first
```

Transcript position 1 is genomic 2,199 — the *highest* coordinate. Positions
1–200 walk down exon 1 to genomic 2,000; position 201 jumps to genomic 1,099;
positions 201–300 walk down exon 2 to genomic 1,000.

Converting a genomic position to a transcript position:

1. Confirm the position falls inside an exon. If it does not, it is intronic and
   has no plain transcript coordinate — see the intronic notation below.
2. Sum the lengths of all exons before it in transcription order.
3. Add its offset within its own exon, counted in transcription order:
   `pos - exon_start + 1` on the plus strand, `exon_end - pos + 1` on the minus.

Getting step 3's strand handling wrong is the single most common error here, and
it fails silently: the number produced is a valid transcript coordinate, just the
wrong one, mirrored within the exon.

## Transcript to coding

`c.1` is the first base of the initiator codon, not the first base of the
transcript. If the 5' UTR is 150 bases long, transcript position 151 is `c.1`.

HGVS coding numbering has no zero and uses four distinct forms:

| Region | Notation | Example |
| --- | --- | --- |
| 5' UTR | negative, counting back from `c.1` | `c.-15` |
| CDS | positive | `c.742` |
| 3' UTR | `*`, counting from the base after the stop codon | `c.*23` |
| Intron | nearest exonic base, then offset | `c.742+3`, `c.743-12` |

Intronic offsets are relative to the nearest exon boundary: `+` counts forward
from the last base of the preceding exon, `-` counts back from the first base of
the following exon. Bases in the 5' half of an intron take the `+` form, those in
the 3' half take the `-` form. `c.742+1` and `c.742+2` are the donor
dinucleotide; `c.743-2` and `c.743-1` are the acceptor.

There is no `c.0`. A tool that emits one has an off-by-one at the UTR boundary.

## Coding to protein

```
codon      = (c_pos - 1) // 3 + 1
in_codon   = (c_pos - 1) %  3 + 1     # 1, 2 or 3
```

`p.1` is the initiator methionine. `c.1`, `c.2` and `c.3` all map to `p.1`, so
protein coordinates lose information — three different nucleotide variants share
one protein position, and two of them may be synonymous.

Note the asymmetry: `c.` → `p.` is a function; `p.` → `c.` is not. A protein
position corresponds to three nucleotide positions, and a protein *change*
usually corresponds to several possible nucleotide changes. Back-translating a
`p.` description into a genomic coordinate requires the transcript sequence and
still may be ambiguous. Never do it arithmetically.

## Phase, and why it is not frame

GFF3 column 8 (`phase`, called `frame` in GTF) is the number of bases to remove
from the **start of this CDS feature** to reach the first base of the next codon.
It takes the values 0, 1, and 2.

It is not `start % 3`, and it is not a property of the genomic position. It is
determined by how many coding bases precede this feature in the transcript:

```
phase = (3 - (coding_bases_before_this_CDS % 3)) % 3
```

The first CDS feature of a transcript has phase 0. On the minus strand, "start of
the feature" means the end with the **higher** genomic coordinate, because that is
where translation reaches first.

Concatenating CDS features in genomic order and translating produces protein for
plus-strand genes and nonsense for minus-strand genes. Sort in transcription
order, reverse-complement, then translate.

## Which transcript

A gene has many transcripts and the same variant gets a different `c.` and `p.`
in each. A `c.` description without a versioned transcript accession is not
actionable.

| Source | Default choice |
| --- | --- |
| MANE Select | one transcript per protein-coding gene, identical in RefSeq and Ensembl |
| Ensembl canonical | MANE Select where one exists, otherwise Ensembl's own rule |
| RefSeq Select | one per gene, not always the same as Ensembl canonical |
| UCSC canonical | historically the longest CDS; now largely MANE-aligned |
| VEP default output | **every** transcript, one consequence line each |

MANE Select is the right default for anything clinical or cross-database, because
it is the one choice where the RefSeq and Ensembl transcripts have identical
sequence and identical exon coordinates.

The version suffix matters. `ENST00000269305.9` and `ENST00000269305.8` can differ
in UTR length, which shifts every `c.-` and `c.*` coordinate even though the CDS is
unchanged. Record the version; a bare `ENST00000269305` is under-specified.

## Two traps at boundaries

**Exon edges.** A variant at the last base of an exon is exonic in one transcript
and intronic in another whose exon is two bases shorter. Its consequence changes
from missense to splice-region accordingly. This is a real disagreement between
annotation sources, not a bug in either.

**Indels near boundaries.** HGVS shifts indels 3'-most along the *transcript*;
VCF left-aligns along the *genome*. For a minus-strand gene these run in opposite
genomic directions, so a deletion can be intronic in its VCF representation and
exonic in its HGVS one. See `variant-representation.md`.

Both are reasons to convert with a tool that holds the transcript model — VEP,
`bcftools csq`, Mutalyzer, or the `hgvs` Python package — rather than by
arithmetic on exon coordinates.
