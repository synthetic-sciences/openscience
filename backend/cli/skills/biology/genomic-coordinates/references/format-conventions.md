# Coordinate conventions, format by format

Two independent choices define a convention, and formats mix them freely:

- **Base**: is the first base of a contig called 0 or 1?
- **Closure**: is the end coordinate part of the interval (inclusive) or one past
  it (half-open)?

There is no correlation between a format's age, its authorship, or its purpose and
which pair it picked. UCSC alone ships both.

## The table

| Format | Convention | Length | Notes |
| --- | --- | --- | --- |
| BED (3/6/12) | 0-based half-open | `end - start` | `chromStart` may be 0 |
| bedGraph | 0-based half-open | `end - start` | despite sitting next to WIG |
| bigWig / bigBed | 0-based half-open | `end - start` | binary; matches BED |
| narrowPeak / broadPeak | 0-based half-open | `end - start` | BED6+4 and BED6+3 |
| WIG (fixedStep, variableStep) | 1-based inclusive | `end - start + 1` | the trap next to bedGraph |
| GFF3 | 1-based inclusive | `end - start + 1` | `start <= end` always |
| GTF / GFF2 | 1-based inclusive | `end - start + 1` | GENCODE, Ensembl |
| VCF / BCF | 1-based inclusive | `len(REF)` | `POS` is the anchor, not the event |
| SAM (text) | 1-based inclusive | from CIGAR | `POS` is the leftmost mapped base |
| BAM / CRAM (binary) | 0-based | from CIGAR | the same field, decremented |
| genePred / refFlat | 0-based half-open | `end - start` | `exonEnds` are exclusive |
| PSL (BLAT) | 0-based half-open | `end - start` | see the minus-strand note below |
| Picard interval_list | 1-based inclusive | `end - start + 1` | GATK targets, bait sets |
| MAF — Mutation Annotation | 1-based inclusive | `End - Start + 1` | TCGA somatic calls |
| MAF — Multiple Alignment | 0-based half-open | `size` field | UCSC whole-genome alignments |
| samtools / tabix region string | 1-based inclusive | `end - start + 1` | `chr3:1000-2000` is 1001 bp |
| UCSC browser position box | 1-based inclusive | `end - start + 1` | 1-based UI over 0-based files |
| Ensembl REST region string | 1-based inclusive | `end - start + 1` | `chr:start..end:strand` |
| IGV locus box | 1-based inclusive | `end - start + 1` | matches the UCSC box |
| Bioconductor GRanges / IRanges | 1-based inclusive | `width()` | R ecosystem default |
| PyRanges / pybedtools | 0-based half-open | `End - Start` | Python ecosystem default |

`scripts/convert_coords.py --list` prints this table; `--from`/`--to` converts
between any two rows of it.

## The conversions worth memorising

Only two, because everything else composes from them:

```
1-based inclusive  ->  0-based half-open :  start - 1,  end
0-based half-open  ->  1-based inclusive :  start + 1,  end
```

The end coordinate never changes. Only the start moves, and only by one. A
conversion that changed both numbers is wrong.

## Per-format detail

### BED

`chromStart` is 0-based, `chromEnd` is exclusive. The first base of a chromosome
is `0 1`. A single base at 1-based position 100 is `99 100`.

`chromStart == chromEnd` is a **legal zero-length feature** — an insertion point
between two bases, used by some variant tracks. It has no representation in any
1-based inclusive format, which is why `convert_coords.py` reports it as
`unrepresentable` rather than emitting `end = start - 1`.

BED12 block fields have exact rules that hand-written files routinely break:

- `blockStarts` are offsets **from `chromStart`**, not absolute coordinates.
- `blockStarts[0]` must be `0`.
- `chromStart + blockStarts[-1] + blockSizes[-1]` must equal `chromEnd`.
- `blockCount` must equal the length of both lists.

`thickStart`/`thickEnd` delimit the CDS and must lie within `chromStart`/`chromEnd`;
`thickStart == thickEnd` marks a non-coding transcript.

narrowPeak's tenth column, `peak`, is an offset **from `chromStart`**, or `-1` when
no summit was called. Adding it to `chromStart` gives the summit; treating it as an
absolute coordinate puts the summit on the wrong chromosome arm.

### GFF3 and GTF

Both are 1-based inclusive across nine tab-separated columns. `start <= end` is
required **regardless of strand** — a minus-strand exon is still written with the
smaller coordinate first, and orientation lives only in column 7. A GFF file with
`start > end` is corrupt, not reverse-stranded.

`start == 0` cannot occur in a valid file. When it does, the file holds BED-style
coordinates and every feature is one base to the left of where it claims to be.

Column 8 is **phase** in GFF3 and **frame** in GTF, and they mean the same thing:
the number of bases to remove from the start of this feature to reach the first
base of the next codon. Values are `0`, `1`, `2`, or `.`. It is not the reading
frame of the feature's start position, and it is not `start % 3`. Every CDS
feature must declare it.

Attribute syntax differs and parsers key on it:

```
GFF3   ID=exon1;Parent=transcript1;gene_name=TP53
GTF    gene_id "ENSG00000141510"; transcript_id "ENST00000269305";
```

A `.gtf` file containing GFF3 attributes parses to zero attributes in most tools,
silently.

`exon_number` in GTF counts in **transcription order**, so on the minus strand
exon 1 has the largest genomic coordinate. Sorting exons by coordinate and
numbering them reproduces the right answer only on the plus strand.

### VCF

`POS` is 1-based and refers to the first base of `REF`. The interval a record
occupies is `POS` to `POS + len(REF) - 1`.

For indels, `POS` is the **anchor base**, which is the base *before* the event and
is itself unchanged:

```
reference   ...  A  C  G  T  T  T  A  ...
positions        4  5  6  7  8  9 10

deletion of TT at 8-9    POS=7  REF=GTT   ALT=G
insertion of AA after 7  POS=7  REF=G     ALT=GAA
SNV at 7                 POS=7  REF=G     ALT=T
```

So an indel's `POS` is not where the change is. Plotting VCF indels against a
gene model without accounting for the anchor puts every one of them one base
early. `-` is never a valid allele — that is Ensembl/VEP notation, which drops
the anchor and uses a different coordinate for the same event.

`POS = 0` and `POS = N+1` are reserved for telomere records and carry no real
allele. `*` as an ALT marks a spanning deletion from an upstream record. `<DEL>`,
`<DUP>` and friends are symbolic alleles whose extent lives in `INFO/END` and
`INFO/SVLEN`, not in `REF`.

Allele representation has its own reference: `variant-representation.md`.

### SAM, BAM, CRAM

SAM text `POS` is 1-based; the BAM and CRAM encodings of the same field are
0-based. Any library that reads BAM presents one or the other, and they disagree:

- `pysam`'s `AlignmentSegment.reference_start` is **0-based**.
- `pysam`'s `.pos` is the same 0-based number.
- The `POS` you see in `samtools view` output is **1-based**.

`reference_end` in pysam is 0-based exclusive, and is `None` for unmapped reads.
`pysam.AlignmentFile.fetch(contig, start, end)` takes **0-based half-open**
coordinates, but `fetch(region="chr1:100-200")` takes a **1-based inclusive**
region string. The same method, two conventions, chosen by which argument you pass.

### Region strings

`RNAME[:STARTPOS[-ENDPOS]]`, 1-based, both endpoints included, so `chr3:1000-2000`
spans 1001 bases.

Omitting the end does **not** mean a single base. `chr2:1000000` means position
1,000,000 to the end of the chromosome. `scripts/convert_coords.py` refuses a
region string without an explicit end rather than guessing which reading was meant.

GRCh38 contig names can contain colons — `HLA-DRB1*12:17` is a real contig — so a
region string is ambiguous without escaping. htslib resolves this with braces:

```
{HLA-DRB1*12:17}          the whole contig
{HLA-DRB1*12:17}:100-200  a region on it
```

Commas as thousands separators are accepted by htslib with
`HTS_PARSE_THOUSANDS_SEP` and by the UCSC and IGV boxes, so `chr1:1,000,000-2,000,000`
is valid input in most places and invalid in most file formats.

### The UCSC split

The UCSC Genome Browser displays and accepts 1-based inclusive coordinates in its
position box, while the BED files it serves and consumes are 0-based half-open.
Both are correct; they are different interfaces to the same data. A coordinate
copied out of the browser window into a BED file is one base too far right.

The UCSC Table Browser applies the same split per output format: BED output is
0-based, "all fields from selected table" output of a genePred table is 0-based,
and the position column shown in the browser is 1-based.

### PSL

0-based half-open, but for a minus-strand alignment `qStart` and `qEnd` are
offsets into the **reverse-complemented** query, not the query as submitted. To
get coordinates in the original query, use `qSize - qEnd` and `qSize - qStart`.
`tStart`/`tEnd` are always on the forward target strand.

## Tool behaviour

`bedtools` reads each input in that input's own convention — BED as 0-based, GFF
and VCF as 1-based — and converts internally. Output is BED-conventioned
regardless of input. Mixing a GFF and a BED in one `intersect` is therefore
correct; converting the GFF to BED coordinates first and then passing it as a GFF
double-shifts it.

`bedtools slop` and `flank` clip at contig ends only when given a `-g` genome
file, and silently produce negative starts without one.

R and Python disagree by default: `GenomicRanges` is 1-based inclusive,
`PyRanges` is 0-based half-open. `rtracklayer::import()` converts BED to 1-based
GRanges on read and back on write, so a round trip through R is safe — but
building a GRanges by hand from numbers read out of a BED file is off by one.
