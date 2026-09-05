export const RESEARCH = [
  {
    title: "Molecular biology",
    detail: "Sequences, single-cell data, and protein structure.",
    tasks: [
      ["Sequence analysis", "Read FASTA files, align sequences, and look up annotations in UniProt or Ensembl."],
      ["Single-cell studies", "Filter cells, annotate clusters, and compare gene expression across conditions."],
      ["Protein research", "Inspect PDB structures and prepare inputs for structure and binding studies."],
    ],
    skills: [
      ["Biopython", "biology/biopython"],
      ["Scanpy", "biology/scanpy"],
      ["scvi-tools", "biology/scvi-tools"],
      ["AnnData", "biology/anndata"],
    ],
    example: "Compare these two single-cell datasets. Check the batch effects before calling differential expression.",
  },
  {
    title: "Chemistry & materials",
    detail: "Molecular properties, compound screening, and crystal structures.",
    tasks: [
      ["Cheminformatics", "Validate SMILES, calculate descriptors, and compare molecular fingerprints."],
      ["Compound research", "Query ChEMBL and PubChem, inspect assay data, and prepare a candidate shortlist."],
      ["Materials analysis", "Read crystal structures, build phase diagrams, and examine electronic properties."],
    ],
    skills: [
      ["RDKit", "chemistry/rdkit"],
      ["DeepChem", "chemistry/deepchem"],
      ["pymatgen", "physics/pymatgen"],
      ["TorchDrug", "chemistry/torchdrug"],
    ],
    example:
      "Check this compound library for duplicates, calculate its molecular descriptors, and flag unusual structures.",
  },
  {
    title: "Machine learning",
    detail: "Training, evaluation, and the experiments around them.",
    tasks: [
      [
        "Training & fine-tuning",
        "Prepare datasets, configure distributed training, or fine-tune with low-rank adapters.",
      ],
      ["Evaluation", "Build a held-out evaluation, compare baselines, and inspect the cases a model gets wrong."],
      ["Inference & compute", "Prepare inference runs, submit jobs to connected compute, and retrieve the outputs."],
    ],
    skills: [
      ["DeepSpeed", "ml-training/deepspeed"],
      ["PEFT", "ml-training/peft"],
      ["TRL", "ml-training/trl-fine-tuning"],
      ["vLLM", "ml-inference/vllm"],
    ],
    example:
      "Reproduce the baseline in this paper. Record the training settings and compare against the reported results.",
  },
  {
    title: "Data & statistics",
    detail: "Data preparation, statistical models, and figures.",
    tasks: [
      ["Data preparation", "Inspect missing values, join tables, and write a repeatable cleaning procedure."],
      ["Statistical analysis", "Fit regression or Bayesian models, check assumptions, and report uncertainty."],
      ["Exploratory work", "Plot distributions and compare groups before deciding which analysis to run."],
    ],
    skills: [
      ["Polars", "data-engineering/polars"],
      ["statsmodels", "coding/statsmodels"],
      ["PyMC", "coding/pymc"],
      ["scikit-learn", "coding/scikit-learn"],
    ],
    example:
      "Fit a hierarchical model to these measurements. Show the uncertainty and explain which assumptions matter.",
  },
  {
    title: "Physics & simulation",
    detail: "Numerical methods, astronomy, and quantum systems.",
    tasks: [
      ["Numerical experiments", "Set up differential equations, compare solvers, and check numerical stability."],
      ["Astronomy", "Work with astronomical tables, coordinate systems, units, and observational data."],
      ["Quantum systems", "Build circuits, simulate system dynamics, and study parameterized quantum models."],
    ],
    skills: [
      ["Astropy", "physics/astropy"],
      ["Qiskit", "quantum/qiskit"],
      ["PennyLane", "quantum/pennylane"],
      ["QuTiP", "quantum/qutip"],
    ],
    example:
      "Simulate this system over a range of initial conditions and check whether the result depends on the time step.",
  },
  {
    title: "Papers & publication",
    detail: "Literature reviews, citations, figures, and manuscripts.",
    tasks: [
      [
        "Literature review",
        "Search primary sources, compare the methods, and organize a bibliography you can revisit.",
      ],
      [
        "Manuscript preparation",
        "Draft in LaTeX, apply a journal template, and check references against the source material.",
      ],
      [
        "Figures & review",
        "Prepare publication figures and review whether the results support the claims in the text.",
      ],
    ],
    skills: [
      ["Scientific writing", "writing/scientific-writing"],
      ["Citations", "writing/citation-management"],
      ["Zotero", "writing/zotero-local"],
      ["Matplotlib", "visualization/matplotlib"],
    ],
    example: "Review this draft against the analysis. Flag claims that need evidence and check every figure caption.",
  },
] as const
