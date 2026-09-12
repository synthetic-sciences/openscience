# IVT mRNA/circRNA Synthesis, SPRI Purification & qPCR Quantification

**URL:** https://cloud.ginkgo.bio/protocols/ivt-rna-synthesis-qpcr
**Status:** Ginkgo Certified
**Price:** $99/sample
**Turnaround:** up to 12 business days (extended: up to 17 business days for longer or clonal DNA constructs)
**Throughput:** 384-well format throughout

## Overview

End-to-end automated RNA production and quantification pipeline ("data in / data out"). Submit DNA sequences via CSV; Ginkgo sources DNA synthesis from commercial providers (e.g., Twist), then runs PCR template prep, in vitro transcription (linear mRNA or circRNA), SPRI bead purification, and qPCR quantification.

**Note:** The circRNA pipeline is limited to Permuted Intron-Exon (PIE) with group I introns.

## Input

- **DNA Input:** Sequences submitted via the CSV template (select linear mRNA or circRNA mode)

## Output

- Purified RNA samples in 384-well format with qPCR quantification readout
- Absolute yield is available only when the customer supplies a calibration standard

## Automated Workflow

### Phase 1 - PCR Template Preparation

1. Transfer primers (Labcyte Echo)
2. Transfer templates (Labcyte Echo)
3. Stamp mastermix (Bravo 384)
4. PCR thermocycle (ATC384)

### Phase 2 - In Vitro Transcription

1. Stamp mastermix (Bravo 384)
2. IVT incubation (ATC384)
3. Stamp DNase mix (Bravo 384)
4. Circularization for circRNA (ATC384)

### Phase 3 - SPRI RNA Purification

1. Load decks with reagents (Bravo 384)
2. Magnetic bead purification (Bravo 384)
3. Unload decks (Bravo 384)

### Phase 4 - Quantify RNAs

1. Stamp RNAs (Bravo 384)
2. RNA yield / purity quantification (Lunatic)

### Phase 5 - Circularization Quantification

1. Echo qPCR setup (Labcyte Echo)
2. Stamp mastermix (Bravo 384)
3. Run RT-qPCR (CFX Opus)

## Ordering

- **Samples:** configurable
- **File Upload:** CSV, Excel, FASTA, TXT, PDF, ZIP (DNA sequences via CSV template)
- **Additional Details:** free-text field for special requirements

## Use Cases

- mRNA production for screening and assay development
- circRNA synthesis (PIE / group I intron designs)
- High-throughput RNA generation with purity/yield readouts
