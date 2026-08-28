import { CapabilityManifest } from "../schema"

const manifest = (value: unknown) => CapabilityManifest.parse(value)

export const manifests = {
  scipy: manifest({
    schema_version: 1,
    id: "scipy",
    version: "1.0.0",
    name: "SciPy",
    category: "analysis",
    summary: "Numerical optimization, integration, signal processing, and scientific statistics in Python.",
    status: "experimental",
    basis:
      "Available through the existing compute_job Python-package layer; no release-wide scientific validation suite yet.",
    execution: { kind: "compute_job", targets: ["modal"], packages: ["scipy==1.18.1"] },
  }),
  matplotlib: manifest({
    schema_version: 1,
    id: "matplotlib",
    version: "1.0.0",
    name: "Matplotlib",
    category: "visualization",
    summary: "Static scientific plotting and publication-oriented figure generation in Python.",
    status: "experimental",
    basis:
      "Available through the existing compute_job Python-package layer; visual output quality remains task-reviewed.",
    execution: { kind: "compute_job", targets: ["modal"], packages: ["matplotlib==3.11.1"] },
  }),
  "scikit-learn": manifest({
    schema_version: 1,
    id: "scikit-learn",
    version: "1.0.0",
    name: "scikit-learn",
    category: "analysis",
    summary: "Classical machine-learning models, preprocessing, model selection, and metrics in Python.",
    status: "experimental",
    basis: "Installable through compute_job; not baked into the verified local starter environment.",
    execution: { kind: "compute_job", targets: ["modal"], packages: ["scikit-learn==1.9.0"] },
  }),
  biopython: manifest({
    schema_version: 1,
    id: "biopython",
    version: "1.0.0",
    name: "Biopython",
    category: "bioinformatics",
    summary: "Sequence, alignment, structure-file, and common bioinformatics data handling in Python.",
    status: "experimental",
    basis: "Installable through compute_job; workflow-specific databases and command-line tools are not implied.",
    execution: { kind: "compute_job", targets: ["modal"], packages: ["biopython==1.88"] },
  }),
  rdkit: manifest({
    schema_version: 1,
    id: "rdkit",
    version: "1.0.0",
    name: "RDKit",
    category: "cheminformatics",
    summary: "Molecular parsing, descriptors, fingerprints, conformers, and cheminformatics workflows.",
    status: "experimental",
    basis:
      "Installable through compute_job; platform wheels and workload-specific validation still require a smoke run.",
    execution: { kind: "compute_job", targets: ["modal"], packages: ["rdkit==2026.3.5"] },
  }),
  alphafold2: manifest({
    schema_version: 1,
    id: "alphafold2",
    version: "1.0.0",
    name: "AlphaFold2",
    category: "structure",
    summary: "Protein structure prediction using the AlphaFold2 workflow.",
    status: "blocked",
    basis: "No reviewed OpenScience image, model-weight acquisition path, or licensed database workflow is configured.",
    blocker:
      "Requires a reviewed runtime image plus explicit model-weight and sequence-database setup before it can be offered.",
  }),
} as const
