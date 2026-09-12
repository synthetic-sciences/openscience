# SPR Target Onboarding

**URL:** https://cloud.ginkgo.bio/protocols/spr-target-onboarding
**Status:** Beta
**Price:** $1,399/target
**Turnaround:** up to 4 weeks

> **Launch offer:** Your onboarding cost credits in full toward your first binding assay run against this target.

## Overview

Qualifies a target on the Cloud Lab SPR (surface plasmon resonance) catalog for kinetic profiling against your binder candidates. Ginkgo procures the target and reference binder, selects capture chemistry, validates immobilization and surface activity on the Nicoya Alto, scouts regeneration conditions, and releases a qualified method to the catalog. Once onboarded, the target can be used in downstream kinetics/binding assay runs.

## Input

(Use the provided `.xlsx` template; list each target on its own row for multi-target orders.)

- Target catalog number (vendor + SKU)
- Reference binder catalog number (vendor + SKU)
- Target metadata (MW, oligomeric state, sensitivities)
- Buffer preferences, if any

## Output

- Validated capture method and surface conditions
- Recommended assay parameters for downstream kinetics runs
- Qualification report with pass/fail call and remediation if needed

## Automated Workflow

### Phase 1 - Intake & Procurement

1. Catalog number intake (Nebula Core)
2. Vendor procurement (Nebula Core)

### Phase 2 - Surface Setup & Validation

1. Capture chemistry selection (project scientist)
2. Test immobilization (Nicoya Alto)
3. Surface activity check (Nicoya Alto)
4. Regeneration scouting (Nicoya Alto)

### Phase 3 - Qualification & Release

1. Qualification record (LIMS)
2. Release to catalog (project scientist)

## Ordering

- **Number of Targets:** configurable ($1,399/target)
- **File Upload:** `.xlsx` only (use the provided template)
- **Additional Details:** free-text field for special requirements

## Use Cases

- Preparing a target for SPR kinetic profiling of binder candidates
- Establishing capture/regeneration conditions before binding campaigns
- Onboarding a target ahead of antibody/minibinder affinity screening
