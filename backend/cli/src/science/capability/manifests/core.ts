import { CORE_SCIENCE_RUNTIME } from "../pack"
import { CapabilityManifest, type CapabilitySource } from "../schema"
import { CORE_SMOKES, type CoreSmokeID } from "../smokes"

function packaged(input: {
  id: CoreSmokeID
  name: string
  category: "analysis" | "visualization" | "bioinformatics" | "cheminformatics"
  summary: string
  source: CapabilitySource
}) {
  return CapabilityManifest.parse({
    schema_version: 2,
    id: input.id,
    version: "2.0.0",
    name: input.name,
    category: input.category,
    summary: input.summary,
    maturity: "experimental",
    availability: { local: "setup_needed", hosted: "setup_needed" },
    basis:
      "OpenScience owns an immutable Python 3.12 runtime contract, exact dependency graph, bounded CPU smoke, artifact validation, and governed local/Modal lifecycle. It remains experimental until release-artifact canaries pass on each advertised backend.",
    source: input.source,
    runtime: CORE_SCIENCE_RUNTIME,
    smoke: CORE_SMOKES[input.id],
    setup: {
      instructions:
        "Run scientific_capability doctor first. Use setup for the exact reusable local pack, or configure Modal for hosted execution.",
      requirements: ["At least 2 GiB RAM", "Package-index access during initial environment construction"],
    },
  })
}
export const coreManifests = {
  scipy: packaged({
    id: "scipy",
    name: "SciPy",
    category: "analysis",
    summary: "Numerical optimization, integration, signal processing, and scientific statistics in Python.",
    source: {
      kind: "pypi",
      name: "scipy",
      version: "1.18.1",
      reference: "https://pypi.org/project/scipy/1.18.1/",
      license: "BSD-3-Clause",
    },
  }),
  matplotlib: packaged({
    id: "matplotlib",
    name: "Matplotlib",
    category: "visualization",
    summary: "Static scientific plotting and publication-oriented figure generation in Python.",
    source: {
      kind: "pypi",
      name: "matplotlib",
      version: "3.11.1",
      reference: "https://pypi.org/project/matplotlib/3.11.1/",
      license: "PSF-based Matplotlib license",
    },
  }),
  "scikit-learn": packaged({
    id: "scikit-learn",
    name: "scikit-learn",
    category: "analysis",
    summary: "Classical machine-learning models, preprocessing, model selection, and metrics in Python.",
    source: {
      kind: "pypi",
      name: "scikit-learn",
      version: "1.9.0",
      reference: "https://pypi.org/project/scikit-learn/1.9.0/",
      license: "BSD-3-Clause",
    },
  }),
  biopython: packaged({
    id: "biopython",
    name: "Biopython",
    category: "bioinformatics",
    summary: "Sequence, alignment, structure-file, and common bioinformatics data handling in Python.",
    source: {
      kind: "pypi",
      name: "biopython",
      version: "1.88",
      reference: "https://pypi.org/project/biopython/1.88/",
      license: "Biopython license",
    },
  }),
  rdkit: packaged({
    id: "rdkit",
    name: "RDKit",
    category: "cheminformatics",
    summary: "Molecular parsing, descriptors, fingerprints, conformers, and cheminformatics workflows.",
    source: {
      kind: "pypi",
      name: "rdkit",
      version: "2026.3.5",
      reference: "https://pypi.org/project/rdkit/2026.3.5/",
      license: "BSD-3-Clause",
    },
  }),
  alphafold2: CapabilityManifest.parse({
    schema_version: 2,
    id: "alphafold2",
    version: "2.0.0",
    name: "AlphaFold2",
    category: "structure",
    summary:
      "Protein structure prediction requiring reviewed weights, databases, storage, licensing, and a GPU runtime.",
    maturity: "blocked",
    availability: { local: "unavailable", hosted: "unavailable" },
    basis:
      "OpenScience does not ship a reviewed AlphaFold2 image, weight acquisition flow, pinned databases, or release smoke.",
    source: {
      kind: "github",
      name: "google-deepmind/alphafold",
      version: "v2.3.2",
      reference: "https://github.com/google-deepmind/alphafold/tree/v2.3.2",
      license: "Apache-2.0 code; separate model/database terms",
    },
    blocker:
      "Blocked until weights, databases, storage, licenses, an immutable image, and a bounded GPU canary are reviewed together.",
  }),
} as const
export const manifests = coreManifests
