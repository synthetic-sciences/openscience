export type ResearchWorkflow = {
  id: string
  group: "analyze" | "compute" | "discover" | "communicate"
  title: string
  description: string
  prompt: string
  shortcut: string
  icon:
    | "table"
    | "notebook"
    | "atom"
    | "sequence"
    | "search"
    | "reproduce"
    | "compare"
    | "report"
    | "activity"
    | "network"
}

export const researchWorkflows: ResearchWorkflow[] = [
  {
    id: "analyze-data",
    group: "analyze",
    title: "Analyze a dataset",
    description: "Profile columns, find quality issues, visualize patterns, and produce a defensible result.",
    prompt:
      "Analyze the relevant dataset in this project. Inspect its schema and quality first, then compute useful summaries and visualizations. Explain every assumption and save any reusable analysis as a notebook.",
    shortcut: "CSV · TSV · JSONL · HDF5",
    icon: "table",
  },
  {
    id: "single-cell",
    group: "analyze",
    title: "Single-cell analysis",
    description: "QC, normalize, cluster, annotate, and compare cells with traceable decisions.",
    prompt:
      "Run a defensible single-cell analysis on the relevant AnnData, Loom, 10x, or count-matrix data. Inspect QC before filtering, preserve raw counts, document thresholds, normalize and reduce dimensions, cluster, annotate with evidence, test differential expression, and save the executable notebook plus figures.",
    shortcut: "Scanpy · scVI · CellTypist",
    icon: "table",
  },
  {
    id: "differential-expression",
    group: "analyze",
    title: "Differential expression",
    description: "Design a statistically valid comparison with diagnostics and pathway interpretation.",
    prompt:
      "Analyze differential expression for the relevant count or expression data. Recover the experimental design and covariates first, check sample QC and confounding, choose an appropriate DESeq2, edgeR, limma, or nonparametric workflow, correct multiple tests, produce diagnostic plots, and separate robust signals from exploratory ones.",
    shortcut: "DESeq2 · edgeR · limma · GSEA",
    icon: "compare",
  },
  {
    id: "inspect-structure",
    group: "analyze",
    title: "Inspect a structure",
    description: "Render proteins or molecules, check chemistry, and investigate structural features.",
    prompt:
      "Inspect the relevant molecular or protein structure in this project. Render it, identify important chains, ligands, residues, or conformers, and explain any structural quality issues before drawing conclusions.",
    shortcut: "PDB · CIF · SDF · MOL",
    icon: "atom",
  },
  {
    id: "sequence-qc",
    group: "analyze",
    title: "Quality-check sequences",
    description: "Review reads, variants, intervals, alignments, and per-cycle quality.",
    prompt:
      "Quality-check the relevant sequencing or genomics files in this project. Report read and base counts, quality and GC patterns, sample or contig coverage, and any concrete anomalies worth investigating.",
    shortcut: "FASTQ · VCF · BAM · GFF",
    icon: "sequence",
  },
  {
    id: "variant-analysis",
    group: "analyze",
    title: "Analyze variants",
    description: "Inspect VCF/BAM evidence, annotate variants, and prioritize interpretable candidates.",
    prompt:
      "Analyze the relevant variant and alignment files. Validate references and sample metadata, inspect VCF and BAM quality, normalize and annotate variants with appropriate population and clinical databases, flag filtering assumptions, prioritize candidates, and produce a table whose evidence and provenance can be audited.",
    shortcut: "VCF · BAM · ClinVar · gnomAD",
    icon: "sequence",
  },
  {
    id: "assay-analysis",
    group: "analyze",
    title: "Analyze an assay",
    description: "Normalize plates, fit dose response, quantify uncertainty, and surface QC failures.",
    prompt:
      "Analyze the relevant assay or plate data. Identify controls and layout, check edge and batch effects, normalize with a justified method, fit dose-response or IC50 curves when appropriate, quantify uncertainty and fit quality, flag failed wells or plates, and export a clean result table and publication-ready plots.",
    shortcut: "plates · dose response · IC50",
    icon: "table",
  },
  {
    id: "image-analysis",
    group: "analyze",
    title: "Analyze microscopy",
    description: "Inspect image metadata, segment objects, extract features, and verify overlays.",
    prompt:
      "Build a reproducible microscopy analysis for the relevant images. Inspect channels, bit depth, scale, and acquisition metadata first; choose an appropriate Cellpose, StarDist, MONAI, or classical segmentation path; generate QC overlays; extract object-level features; and save masks, tables, figures, and parameters.",
    shortcut: "Cellpose · StarDist · MONAI",
    icon: "reproduce",
  },
  {
    id: "proteomics",
    group: "analyze",
    title: "Analyze proteomics",
    description: "QC spectra and quantification, handle missingness, and test protein-level changes.",
    prompt:
      "Analyze the relevant mass-spectrometry or proteomics data. Inspect mzML or result-table quality, identify the acquisition and quantification method, check contaminants and missingness, normalize without leaking groups, perform protein-level statistics with multiple-testing correction, and save diagnostic figures and traceable result tables.",
    shortcut: "mzML · OpenMS · DIA-NN",
    icon: "activity",
  },
  {
    id: "run-notebook",
    group: "compute",
    title: "Run a notebook",
    description: "Open an existing notebook or build one with live Python or R outputs.",
    prompt:
      "Find the most relevant notebook in this project, inspect it before running anything, then execute or repair it cell by cell. Preserve outputs and summarize the result and environment.",
    shortcut: "Jupyter · Python · R",
    icon: "notebook",
  },
  {
    id: "protein-design",
    group: "compute",
    title: "Design a protein",
    description: "Define constraints, generate candidates, score structure, and preserve model provenance.",
    prompt:
      "Design protein candidates for the stated objective. Recover the target, interface, motif, sequence, and developability constraints before choosing tools. Use available structure prediction, RFdiffusion, ProteinMPNN, LigandMPNN, ESM, Boltz, Chai, or related workflows only where installed or accessible. Generate a small auditable candidate set, score failure modes, render structures, and preserve every model/version/seed/config.",
    shortcut: "ESM · Boltz · RFdiffusion · MPNN",
    icon: "atom",
  },
  {
    id: "molecular-docking",
    group: "compute",
    title: "Dock molecules",
    description: "Prepare receptor and ligands, validate the box, compare poses, and inspect interactions.",
    prompt:
      "Run a careful molecular docking workflow on the relevant receptor and ligands. Validate chemistry, protonation, cofactors, missing residues, and the binding-site box first. Use an available DiffDock, GNINA, or AutoDock Vina path, include a control or redocking check, compare poses and scores without overstating affinity, render key interactions, and save prepared inputs and configs.",
    shortcut: "DiffDock · GNINA · Vina",
    icon: "atom",
  },
  {
    id: "molecular-dynamics",
    group: "compute",
    title: "Run molecular dynamics",
    description: "Prepare, minimize, equilibrate, simulate, and validate a molecular system.",
    prompt:
      "Plan and run the relevant molecular-dynamics workflow with OpenMM, GROMACS, or AMBER if available. Validate force fields, protonation, solvent, ions, restraints, timestep, and ensemble; separate minimization, equilibration, and production; checkpoint long runs; monitor stability; and report RMSD/RMSF and decision-relevant observables with exact configs.",
    shortcut: "OpenMM · GROMACS · AMBER",
    icon: "activity",
  },
  {
    id: "train-model",
    group: "compute",
    title: "Train a model",
    description: "Profile data, choose compute, track experiments, checkpoint, and compare honestly.",
    prompt:
      "Build a reproducible model-training run for this project. Inspect data splits and leakage risks first, establish a baseline and metric, estimate compute and memory, choose local or managed compute, capture the environment and random seeds, stream logs, save checkpoints and artifacts, evaluate on a held-out set, and run the reviewer gate before reporting results.",
    shortcut: "PyTorch · TRL · scikit-learn",
    icon: "activity",
  },
  {
    id: "run-pipeline",
    group: "compute",
    title: "Run a bioinformatics pipeline",
    description: "Detect workflow definitions, validate inputs, execute safely, and collect reports.",
    prompt:
      "Find and run the most appropriate workflow in this project using Nextflow, nf-core, Snakemake, WDL/Cromwell, or the repository's own runner. Validate samplesheets, references, profiles, containers, and expected outputs first. Start with a dry run or small test when possible, use managed compute for long work, stream logs, collect reports and artifacts, and record failed steps clearly.",
    shortcut: "Nextflow · nf-core · Snakemake",
    icon: "reproduce",
  },
  {
    id: "survey-literature",
    group: "discover",
    title: "Survey the literature",
    description: "Turn a research question into a sourced map of claims, methods, and open gaps.",
    prompt:
      "Build a focused literature survey for my research question. Separate established evidence from inference, compare methods and datasets, capture citations, and finish with the highest-value unanswered questions.",
    shortcut: "papers · citations · claims",
    icon: "search",
  },
  {
    id: "clinical-trials",
    group: "discover",
    title: "Compare clinical trials",
    description: "Map designs, eligibility, endpoints, status, and evidence gaps across trials.",
    prompt:
      "Compare clinical trials relevant to the question using real registry records. Normalize phase, population, eligibility, interventions, comparators, endpoints, enrollment, status, dates, and reported results. Distinguish planned from completed evidence, identify endpoint or population mismatches, cite registry identifiers, and produce a comparison table with explicit caveats.",
    shortcut: "ClinicalTrials.gov · endpoints",
    icon: "search",
  },
  {
    id: "target-prioritization",
    group: "discover",
    title: "Prioritize a target",
    description: "Combine genetics, expression, pathways, tractability, and safety evidence.",
    prompt:
      "Build a target-prioritization report for the disease or phenotype. Combine Open Targets, genetics, expression, pathways, protein structure, known drugs, tractability, and safety evidence; preserve evidence provenance; score dimensions separately before any aggregate ranking; surface contradictory evidence; and finish with the experiments that would most change the decision.",
    shortcut: "Open Targets · genetics · pathways",
    icon: "network",
  },
  {
    id: "reproduce-result",
    group: "discover",
    title: "Reproduce a result",
    description: "Trace a claim to code and data, define a criterion, run checks, and record evidence.",
    prompt:
      "Reproduce the target result in this project. Identify the exact claim, code, data, configuration, and success criterion before running it. Record failures as evidence and finish with a supported, weakened, rejected, or not-tested verdict.",
    shortcut: "claim · code · evidence",
    icon: "reproduce",
  },
  {
    id: "compare-runs",
    group: "compute",
    title: "Compare experiments",
    description: "Normalize metrics, surface confounders, and choose a winner without hiding failures.",
    prompt:
      "Compare the experiment runs in this project. Normalize their configurations and metrics, flag confounders and failed runs, visualize the decision-relevant differences, and recommend the next experiment.",
    shortcut: "metrics · configs · failures",
    icon: "compare",
  },
  {
    id: "verify-citations",
    group: "communicate",
    title: "Verify citations & claims",
    description: "Check that sources exist, support the text, and match every quoted number.",
    prompt:
      "Audit the citations and scientific claims in the relevant report or manuscript. Resolve every DOI, PMID, arXiv id, URL, or bibliography key; verify that each source actually supports the attributed claim; compare quoted numbers against the source; flag missing, weak, mismatched, or contradictory citations; and record findings in the provenance graph.",
    shortcut: "DOI · PMID · claim support",
    icon: "reproduce",
  },
  {
    id: "build-figure",
    group: "communicate",
    title: "Build a publication figure",
    description: "Turn project evidence into a clear, accessible, export-ready multi-panel figure.",
    prompt:
      "Create a publication-quality figure from the relevant project data and results. Identify the exact claim each panel supports, choose statistically honest encodings, preserve units and uncertainty, use accessible colors and readable typography, link every panel to its source data and code, and export editable source plus SVG, PNG, and PDF versions where supported.",
    shortcut: "SVG · PNG · PDF · provenance",
    icon: "report",
  },
  {
    id: "write-report",
    group: "communicate",
    title: "Write a research report",
    description: "Synthesize project evidence into a clear report with figures, caveats, and citations.",
    prompt:
      "Draft a research report from the evidence in this project. Use a concise abstract, methods, results, limitations, and next steps. Cite source files and claims precisely, and reuse existing figures where they support the text.",
    shortcut: "Markdown · LaTeX · PDF",
    icon: "report",
  },
]

export const researchSuggestions = researchWorkflows.filter((workflow) =>
  ["analyze-data", "run-notebook", "survey-literature"].includes(workflow.id),
)

const groups: Array<{ id: ResearchWorkflow["group"]; title: string }> = [
  { id: "analyze", title: "Analyze" },
  { id: "compute", title: "Compute" },
  { id: "discover", title: "Discover" },
  { id: "communicate", title: "Communicate" },
]

export function workflowGroups() {
  return groups.map((group) => ({
    ...group,
    workflows: researchWorkflows.filter((workflow) => workflow.group === group.id),
  }))
}

export function workflowPrompt(workflow: ResearchWorkflow, artifacts: number) {
  if (artifacts <= 0) return workflow.prompt
  return `Your workspace contains ${artifacts.toLocaleString("en-US")} research artifacts. ${workflow.prompt}`
}
