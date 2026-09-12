# Variant representation and normalisation

The same change to a genome can be written many ways. Two records that share no
field values can describe one variant, and two records with identical `POS` can
describe different ones. Any comparison, join, deduplication, or annotation
lookup performed before normalisation loses real matches silently — nothing
errors, the intersection is just smaller than it should be.

## Why one variant has many spellings

Take this reference:

```
position    1  2  3  4  5  6  7  8  9 10
base        G  G  C  A  C  A  C  A  C  T
```

Deleting `AC` from the `CACACAC` run yields `GGCACACT` no matter which adjacent
`AC` you remove. All of these are the same variant:

```
POS=7  REF=CAC  ALT=C
POS=5  REF=CAC  ALT=C
POS=3  REF=CAC  ALT=C
POS=2  REF=GCA  ALT=G
```

Any caller may emit any of them. Repeat regions, which is where indels
concentrate, are exactly where the ambiguity is worst.

Redundant flanking bases add a second axis. `POS=3 REF=CA ALT=CT` and
`POS=4 REF=A ALT=T` are the same SNV; the first just carries a base that does not
change.

## The normalisation rule

A variant is normalised when it is **parsimonious** (as few bases as possible,
while keeping at least one) and **left-aligned** (shifted as far towards the
start of the contig as it can go without changing the sequence it describes).
This is the definition from Tan, Abecasis & Kang, *Unified representation of
genetic variants*, Bioinformatics 31(13):2202–2204, 2015, and it is what
`bcftools norm` and `vt normalize` implement.

The procedure:

1. While the alleles all end with the same base: if any allele is down to one
   base, extend every allele one base to the left using the reference and
   decrement `POS`; then drop the last base of every allele.
2. While every allele has at least two bases and they all start with the same
   base: drop the first base of every allele and increment `POS`.

Step 1 walks the variant left through a repeat. Step 2 strips redundant padding.
Both terminate. `scripts/normalize_variant.py` implements exactly this:

```bash
python3 normalize_variant.py --fasta ref.fa chr1 7 CAC C
# chr1:7:CAC:C  ->  chr1:2:GCA:G   pos_shift 5
```

`pos_shift` is positive when left-alignment moved the anchor left through a
repeat, negative when trimming moved it right onto a shorter, equivalent record.

## Checking equivalence

Normalise both and compare the four fields:

```bash
python3 normalize_variant.py --fasta ref.fa \
    --compare chr1:7:CAC:C chr1:3:CAC:C chr1:2:GCA:G
# verdict: identical -- all 3 records normalise to chr1:2:GCA:G
```

The verdict goes to stderr so the per-record table on stdout stays parseable.

## Normalisation needs the right reference

Left-alignment reads reference bases. Handed the wrong assembly it will produce a
confident, wrong answer, so the `REF` field is checked against the FASTA first and
a mismatch stops that record:

```
ref_check  MISMATCH   REF says A but the reference has C at chr1:3
```

A `REF` mismatch is the cheapest assembly-mismatch detector there is. If more
than a handful of records fail, the variants and the FASTA are different builds —
run `scripts/check_contigs.py` rather than adjusting anything.

## Multi-allelic records

`ALT=G,GG` is two variants sharing a line. They must be split **before**
normalising, because the shared `REF` that made them representable together is
not the parsimonious `REF` for either one:

```bash
python3 normalize_variant.py --fasta ref.fa --split --input cohort.vcf
```

Splitting after normalising, or normalising a multi-allelic record as a unit,
gives records that are individually wrong. `bcftools norm -m -any -f ref.fa` does
both in the right order. Note that splitting rewrites the genotype and `INFO`
fields; per-allele `INFO` entries with `Number=A` are split alongside, and
anything else is duplicated to both records.

## The other direction: HGVS shifts right

VCF left-aligns. HGVS does the opposite: *"in the case of ambiguity, the most 3'
position possible of the reference sequence is arbitrarily assigned to have been
changed."* The two standards are deliberately opposite, and the difference is
real — the same deletion has different coordinates in a VCF and in a clinical
report.

Worse, HGVS's "3'" is relative to **the reference sequence being described**:

| Description | Shifted towards | On a plus-strand gene | On a minus-strand gene |
| --- | --- | --- | --- |
| VCF `POS` | contig start | leftmost genomic | leftmost genomic |
| HGVS `g.` | contig end | rightmost genomic | rightmost genomic |
| HGVS `c.` / `n.` / `p.` | transcript 3' end | rightmost genomic | **leftmost** genomic |

So for a minus-strand gene, an HGVS `c.` description and a left-aligned VCF
record can coincide, and for a plus-strand gene they systematically will not.
Never convert between the two by adjusting coordinates; round-trip through a
tool that knows the transcript model (`bcftools csq`, VEP, Mutalyzer,
`hgvs` in Python).

## Symbolic and structural alleles

`<DEL>`, `<DUP>`, `<INV>`, `<CNV>`, `<INS>` and breakend (`BND`) records carry no
literal sequence. `REF` is the single anchor base at `POS`; the extent lives in
`INFO/END` and `INFO/SVLEN`. They cannot be normalised, and
`normalize_variant.py` passes them through with `ref_check = skipped` rather than
pretending otherwise.

`*` as an ALT allele means "this sample's allele is deleted by a different record
overlapping this position". It is not a variant; counting `*` alleles as alternate
observations inflates allele frequencies.

## What to run before comparing two variant sets

```bash
# 1. same assembly, same contig naming?
python3 check_contigs.py setA.vcf setB.vcf --genome ref.fa.fai

# 2. structural conventions intact?
python3 audit_intervals.py setA.vcf --genome ref.fa.fai

# 3. split, check REF, trim, left-align -- both sets, same reference
python3 normalize_variant.py --fasta ref.fa --split --input setA.vcf -o A.norm.tsv
python3 normalize_variant.py --fasta ref.fa --split --input setB.vcf -o B.norm.tsv
```

Only then join on `CHROM:POS:REF:ALT`. An intersection computed before step 3 is
an underestimate of unknown size, and it is biased: it under-counts indels in
repeats, which is where most of the interesting ones are.
