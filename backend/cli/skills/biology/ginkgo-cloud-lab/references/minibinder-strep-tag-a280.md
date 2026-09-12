# Minibinder Expression with Strep-tag Purification and Yield via A280

**URL:** https://cloud.ginkgo.bio/protocols/minibinder-strep-tag-a280
**Status:** Ginkgo Certified
**Price:** $149/sample
**Turnaround:** up to 11 days
**Throughput:** Up to 88 constructs per run (1 column reserved for controls), 96-well format

## Overview

End-to-end automated workflow for expressing and purifying StrepII-tagged designed minibinder candidates in a cell-free system, built to screen binder designs before scale-up. Linear DNA templates are expressed in 100 uL CFPS reactions for 20 hours, purified with StreptactinXT magnetic beads on the Agilent Bravo, and quantified from the eluate by A280 on the BMG PHERAstar. Purity and size assessment are performed on the Revvity LabChip.

## Input

- **DNA Input:** Linear DNA sequence
- **Tag Orientation:** N-terminal or C-terminal fusion (validated with C-terminal tags; success is protein-dependent)
- **Format:** Up to 88 constructs per run, 1 column of wells for controls

## Output

- **Yield Quantification:** A280 per well, converted to protein concentration (mg/mL) via the protein's molar extinction coefficient
- **Expression Confirmation:** Fluorescence signal relative to controls
- **Assay Quality Metrics:** Per-run quality summary with plate-level controls

## Automated Workflow

### Phase 1 - CFPS Reaction Setup & Incubation

1. Retrieve plates (HRB TundraStore)
2. Stamp DNA templates (Agilent Bravo)
3. Seal plate (Agilent PlateLoc)
4. Incubate shaking at 30 deg C (Thermo Cytomat)

### Phase 2 - Quantification Prep

1. Dispense PBS diluent (BioTek MultiFlo)
2. Seal plate (Agilent PlateLoc)
3. Store at 4 deg C (HRB TundraStore)

### Phase 3 - LabChip Quantification

1. Unseal plate (Azenta XPeel)
2. LabChip quantification (Revvity LabChip)
3. Seal plate (Agilent PlateLoc)
4. Store at 4 deg C (HRB TundraStore)

## Ordering

- **Number of Proteins:** configurable
- **Number of Replicates:** configurable
- **File Upload:** CSV, Excel, FASTA, TXT, PDF, ZIP
- **Additional Details:** free-text field for special requirements

## Use Cases

- Screening designed minibinder/binder candidates before scale-up
- Rapid yield and purity comparison across binder designs
- Cell-free triage of de novo designed proteins
