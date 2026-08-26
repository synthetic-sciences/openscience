---
name: protein-binder-design
description: Design and validate de novo protein binders with the current NVIDIA BioNeMo Agent Toolkit workflow, while adapting honestly when NVIDIA-hosted credentials are unavailable.
category: biology
tags:
  - protein-design
  - bionemo
  - modal
role: workflow
capability: protein-binder-design
---

# Protein binder design

Use this workflow for an end-to-end binder campaign: target preparation, backbone generation, sequence design, independent complex prediction, interface scoring, diversity analysis, ranking, structures, and a reproducible report.

The reviewed upstream source is NVIDIA BioNeMo Agent Toolkit commit `0e67a612e4045f007e38fa77adc8f3ebfc5616b6`. Its canonical workflows are `skills/bionemo-agent-toolkit/skills/protein-binder-design` and `skills/bionemo-agent-toolkit/skills/complexa-binder-design`. Record that commit and every model/version actually used.

This adapted skill is self-contained; it has no local helper files or references to inspect. Resolve upstream details through the pinned public repository only when the active route needs them.

## Start with capabilities

1. Call `compute_job` with `action: "targets"` once. Respect the returned Modal network and credential capabilities.
2. Use the configured Modal target for detached GPU work. Never call the Modal CLI/SDK directly and never place credentials in commands.
3. If `nvidia_nim` is reported available by `targets`, the supported BioNeMo NIM funnel is RFdiffusion backbones -> ProteinMPNN sequences -> Boltz2 or validated OpenFold3 complexes -> self-consistency and interface ranking. Never submit an unavailable secret reference merely to probe it.
4. If a reviewed NGC/private-image route is actually available, Proteina-Complexa may co-design sequence and structure before an independent Boltz2/OpenFold3 refold. Do not claim this route when the target reports no private-registry support.
5. If NVIDIA credentials are absent, do not stop merely because the branded endpoints are unavailable. Inspect the pinned toolkit workflow, then test whether the corresponding public open-source RFdiffusion, ProteinMPNN, and Boltz releases can be installed and run on Modal. Proceed only when exact public sources and weights are accessible under their licenses. Label this clearly as an open-source adaptation of the BioNeMo workflow, not a hosted NIM run.
6. If neither route can execute, return a precise preflight blocker and the smallest missing setup. Never fabricate structures or scores.

## Campaign contract

- Before the batch, run a bounded smoke with the exact image, pinned source revisions, imports, checkpoint, and one minimal inference. A CUDA-only probe does not validate the workflow environment.
- Resolve one GFP structure and document chain, residue numbering, and any hotspot choice.
- Generate more candidates than the requested ten, but use a staged funnel so expensive co-folding is applied only to a reproducible shortlist.
- Preserve seeds, parameters, model identifiers, failures, intermediate PDB/mmCIF files, and a candidate manifest linking backbone -> sequence -> complex -> scores.
- Rank with interface confidence, binder confidence, self-consistency, hotspot contact, sequence diversity, and ranking stability. Do not use ligand-only affinity outputs for protein binders.
- Include negative or scrambled controls and report the full success rate, not only winners.
- Deliver ten sequences and predicted complexes when the executed evidence supports them; otherwise state the achieved count and why.
- Treat all binding claims as computational predictions requiring experimental validation.

Use `scientific-writing` only when manuscript work begins and `scientific-visualization` only when figures are being made. Read upstream references on demand instead of loading unrelated skills preemptively.
