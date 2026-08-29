import { CapabilityManifest, type CapabilityCategory, type CapabilitySource } from "../schema"

type Entry = {
  id: string
  name: string
  category: CapabilityCategory
  summary: string
  source: CapabilitySource
  tier: "reference_only" | "inventory_only" | "bionemo_upstream"
  requirements?: string[]
  blocked?: string
}

function entry(input: Entry) {
  const blocked = Boolean(input.blocked)
  const basis =
    input.tier === "reference_only"
      ? "OpenScience previously exposed instructional or reference material for this tool, but does not ship a first-class manifest-bound executor, doctor, typed I/O adapter, artifact validator, or release smoke. This inventory entry prevents documentation from overstating that coverage."
      : input.tier === "bionemo_upstream"
        ? "The pinned NVIDIA BioNeMo Agent Toolkit contains upstream skill material for this capability, but OpenScience does not yet ship a strict adapter or release-validated executor for it. Upstream availability is not counted as an OpenScience executable."
        : "The audited OpenScience product had no meaningful first-class executor for this capability. This inventory entry provides truthful setup or blocker information only and is not counted as a runnable or verified tool."
  return CapabilityManifest.parse({
    schema_version: 2,
    id: input.id,
    version: "1.0.0",
    name: input.name,
    category: input.category,
    summary: input.summary,
    maturity: blocked ? "blocked" : "experimental",
    availability: blocked
      ? { local: "unavailable", hosted: "unavailable" }
      : { local: "setup_needed", hosted: "unavailable" },
    basis,
    source: input.source,
    setup: blocked
      ? undefined
      : {
          instructions:
            "This release does not install or execute this tool. Review the pinned upstream source, license, datasets or weights, then add a manifest-bound runtime and bounded smoke before treating it as executable.",
          requirements: input.requirements ?? [
            "A reviewed immutable runtime",
            "Typed inputs and outputs",
            "A bounded release smoke",
          ],
        },
    blocker: input.blocked,
  })
}

const pypi = (name: string, version: string, license: string): CapabilitySource => ({
  kind: "pypi",
  name,
  version,
  reference: `https://pypi.org/project/${name}/${version}/`,
  license,
})
const github = (name: string, version: string, reference: string, license: string): CapabilitySource => ({
  kind: "github",
  name,
  version,
  reference,
  license,
})
const toolkit = (name: string): CapabilitySource =>
  github(
    name,
    "0e67a612e4045f007e38fa77adc8f3ebfc5616b6",
    "https://github.com/NVIDIA-BioNeMo/bionemo-agent-toolkit/tree/0e67a612e4045f007e38fa77adc8f3ebfc5616b6",
    "CC-BY-4.0 skills; Apache-2.0 code; model-specific terms",
  )

const values: Entry[] = [
  {
    id: "autodock-vina",
    name: "AutoDock Vina",
    category: "docking",
    summary: "Molecular docking and virtual-screening command-line workflows.",
    source: github(
      "AutoDock Vina",
      "v1.2.7",
      "https://github.com/ccsb-scripps/AutoDock-Vina/tree/v1.2.7",
      "Apache-2.0",
    ),
    tier: "reference_only",
  },
  {
    id: "cclib",
    name: "cclib",
    category: "quantum",
    summary: "Parsing and analysis of computational-chemistry log files.",
    source: pypi("cclib", "1.8.1", "BSD-3-Clause"),
    tier: "reference_only",
  },
  {
    id: "chempy",
    name: "ChemPy",
    category: "analysis",
    summary: "Chemical-reaction, equilibrium, kinetics, and formula calculations.",
    source: pypi("chempy", "0.10.1", "BSD-2-Clause"),
    tier: "reference_only",
  },
  {
    id: "crest",
    name: "CREST",
    category: "quantum",
    summary: "Conformer-rotamer ensemble sampling around the xtb electronic-structure engine.",
    source: github("CREST", "v3.0.2", "https://github.com/crest-lab/crest/tree/v3.0.2", "LGPL-3.0"),
    tier: "reference_only",
  },
  {
    id: "deepchem",
    name: "DeepChem",
    category: "cheminformatics",
    summary: "Machine-learning components for molecular and materials workflows.",
    source: pypi("deepchem", "2.8.0", "MIT"),
    tier: "reference_only",
  },
  {
    id: "esm-2",
    name: "ESM-2",
    category: "bioinformatics",
    summary: "Protein language-model embeddings and sequence representations.",
    source: pypi("fair-esm", "2.0.0", "MIT"),
    tier: "reference_only",
    requirements: ["Reviewed model weights", "GPU profile for larger checkpoints", "Model-specific artifact smoke"],
  },
  {
    id: "esmfold",
    name: "ESMFold",
    category: "structure",
    summary: "Protein structure prediction using ESMFold model weights.",
    source: pypi("fair-esm", "2.0.0", "MIT"),
    tier: "reference_only",
    requirements: ["Reviewed model weights", "GPU runtime and VRAM bounds", "PDB artifact validation"],
  },
  {
    id: "gemmi",
    name: "Gemmi",
    category: "structure",
    summary: "Crystallographic structure and reflection data handling.",
    source: pypi("gemmi", "0.7.5", "MPL-2.0"),
    tier: "reference_only",
  },
  {
    id: "matchms",
    name: "matchms",
    category: "mass_spectrometry",
    summary: "Mass-spectrum import, filtering, similarity, and matching.",
    source: pypi("matchms", "0.33.1", "Apache-2.0"),
    tier: "reference_only",
  },
  {
    id: "mordred",
    name: "Mordred",
    category: "cheminformatics",
    summary: "Molecular descriptor calculation.",
    source: pypi("mordred", "1.2.0", "BSD-3-Clause"),
    tier: "reference_only",
  },
  {
    id: "nmrglue",
    name: "nmrglue",
    category: "analysis",
    summary: "Reading, processing, and converting NMR spectroscopy data.",
    source: pypi("nmrglue", "0.12", "BSD-3-Clause"),
    tier: "reference_only",
  },
  {
    id: "nwchem",
    name: "NWChem",
    category: "quantum",
    summary: "Large-scale computational chemistry workflows.",
    source: github("NWChem", "v7.3.1-release", "https://github.com/nwchemgit/nwchem/tree/v7.3.1-release", "ECL-2.0"),
    tier: "reference_only",
    requirements: [
      "Reviewed native binaries or source build",
      "HPC scheduler profile",
      "Bounded quantum-chemistry fixture",
    ],
  },
  {
    id: "open-babel",
    name: "Open Babel",
    category: "cheminformatics",
    summary: "Chemical file conversion, filtering, and molecular operations.",
    source: github(
      "Open Babel",
      "openbabel-3-2-1",
      "https://github.com/openbabel/openbabel/tree/openbabel-3-2-1",
      "GPL-2.0",
    ),
    tier: "reference_only",
  },
  {
    id: "openmm",
    name: "OpenMM",
    category: "molecular_modeling",
    summary: "Molecular simulation with CPU and GPU backends.",
    source: pypi("OpenMM", "8.6.0", "MIT and LGPL components; review upstream notices"),
    tier: "reference_only",
  },
  {
    id: "openms",
    name: "OpenMS",
    category: "mass_spectrometry",
    summary: "Proteomics and metabolomics mass-spectrometry processing.",
    source: pypi("pyopenms", "3.5.0", "BSD-3-Clause"),
    tier: "reference_only",
  },
  {
    id: "pubchempy",
    name: "PubChemPy",
    category: "cheminformatics",
    summary: "Python client access to PubChem records and searches.",
    source: pypi("PubChemPy", "1.0.5", "MIT"),
    tier: "reference_only",
  },
  {
    id: "pymatgen",
    name: "pymatgen",
    category: "molecular_modeling",
    summary: "Materials structures, transformations, and analysis.",
    source: pypi("pymatgen", "2026.5.4", "MIT"),
    tier: "reference_only",
  },
  {
    id: "pyscf",
    name: "PySCF",
    category: "quantum",
    summary: "Python-based quantum-chemistry calculations.",
    source: pypi("pyscf", "2.14.0", "Apache-2.0"),
    tier: "reference_only",
  },
  {
    id: "pyteomics",
    name: "Pyteomics",
    category: "mass_spectrometry",
    summary: "Proteomics and mass-spectrometry data parsing and calculations.",
    source: pypi("pyteomics", "5.0.1", "Apache-2.0"),
    tier: "reference_only",
  },
  {
    id: "statsmodels",
    name: "statsmodels",
    category: "analysis",
    summary: "Statistical models, tests, and econometric analysis in Python.",
    source: pypi("statsmodels", "0.15.0", "BSD-3-Clause"),
    tier: "reference_only",
  },
  {
    id: "thermo",
    name: "thermo",
    category: "analysis",
    summary: "Chemical engineering thermodynamics and property calculations.",
    source: pypi("thermo", "0.6.1", "MIT"),
    tier: "reference_only",
  },
  {
    id: "xtb",
    name: "xtb",
    category: "quantum",
    summary: "Semiempirical extended tight-binding calculations.",
    source: github("xtb", "v6.7.1", "https://github.com/grimme-lab/xtb/tree/v6.7.1", "LGPL-3.0"),
    tier: "reference_only",
  },

  {
    id: "evo2",
    name: "Evo 2",
    category: "genomics",
    summary: "Biological sequence generation and scoring described by the pinned BioNeMo toolkit.",
    source: toolkit("Evo 2"),
    tier: "bionemo_upstream",
    requirements: [
      "A strict current NVIDIA endpoint schema",
      "User-owned credentials and applicable terms",
      "A bounded sequence canary",
    ],
  },
  {
    id: "genmol",
    name: "GenMol",
    category: "cheminformatics",
    summary: "Molecule generation described by the pinned BioNeMo toolkit.",
    source: toolkit("GenMol"),
    tier: "bionemo_upstream",
  },
  {
    id: "molmim",
    name: "MolMIM",
    category: "cheminformatics",
    summary: "Molecular generation and optimization described by the pinned BioNeMo toolkit.",
    source: toolkit("MolMIM"),
    tier: "bionemo_upstream",
  },
  {
    id: "msa-search",
    name: "MSA Search",
    category: "bioinformatics",
    summary: "Hosted multiple-sequence-alignment search described by the pinned BioNeMo toolkit.",
    source: toolkit("MSA Search"),
    tier: "bionemo_upstream",
  },
  {
    id: "openfold2",
    name: "OpenFold2",
    category: "structure",
    summary: "Protein structure prediction described by the pinned BioNeMo toolkit.",
    source: toolkit("OpenFold2"),
    tier: "bionemo_upstream",
    requirements: [
      "A strict endpoint or immutable GPU runtime",
      "Reviewed weights and databases",
      "A bounded structure canary",
    ],
  },
  {
    id: "openfold3",
    name: "OpenFold3",
    category: "structure",
    summary: "OpenFold3 preview workflow from the pinned BioNeMo toolkit.",
    source: toolkit("OpenFold3"),
    tier: "bionemo_upstream",
    blocked:
      "The pinned NVIDIA toolkit marks OpenFold3 workflows as pending validation, and OpenScience has no independent release canary.",
  },

  {
    id: "aizynthfinder",
    name: "AiZynthFinder",
    category: "synthesis",
    summary: "Retrosynthetic route planning.",
    source: pypi("aizynthfinder", "4.4.1", "MIT"),
    tier: "inventory_only",
    requirements: ["Reviewed model and template data", "Typed route artifact contract", "Bounded route-search smoke"],
  },
  {
    id: "alphafold2-multimer",
    name: "AlphaFold2-Multimer",
    category: "structure",
    summary: "Multimeric protein structure prediction with AlphaFold model weights and databases.",
    source: github(
      "AlphaFold",
      "v2.3.2",
      "https://github.com/google-deepmind/alphafold/tree/v2.3.2",
      "Apache-2.0 code; separate model/database terms",
    ),
    tier: "inventory_only",
    blocked:
      "No reviewed weights, databases, storage plan, immutable GPU image, license flow, or multimer release canary is shipped.",
  },
  {
    id: "cantera",
    name: "Cantera",
    category: "analysis",
    summary: "Chemical kinetics, thermodynamics, and transport simulations.",
    source: pypi("Cantera", "3.2.0", "BSD-3-Clause"),
    tier: "inventory_only",
  },
  {
    id: "cctbx-project",
    name: "cctbx_project",
    category: "structure",
    summary: "Computational crystallography libraries and command-line programs.",
    source: github(
      "cctbx_project",
      "v2026.7",
      "https://github.com/cctbx/cctbx_project/tree/v2026.7",
      "BSD-3-Clause and component-specific licenses",
    ),
    tier: "inventory_only",
  },
  {
    id: "chemdataextractor2",
    name: "chemdataextractor2",
    category: "document",
    summary: "Chemical information extraction from scientific text.",
    source: pypi("chemdataextractor2", "2.4.0", "MIT"),
    tier: "inventory_only",
  },
  {
    id: "chemprop",
    name: "Chemprop",
    category: "cheminformatics",
    summary: "Message-passing neural networks for molecular property prediction.",
    source: pypi("chemprop", "2.3.1", "MIT"),
    tier: "inventory_only",
  },
  {
    id: "goodvibes",
    name: "GoodVibes",
    category: "quantum",
    summary: "Thermochemical corrections and analysis for quantum-chemistry outputs.",
    source: pypi("goodvibes", "4.3.0", "MIT"),
    tier: "inventory_only",
  },
  {
    id: "hplc-py",
    name: "hplc-py",
    category: "chromatography",
    summary: "HPLC chromatogram baseline correction, peak fitting, and quantification.",
    source: pypi("hplc-py", "0.2.8", "GPL-3.0"),
    tier: "inventory_only",
  },
  {
    id: "lmfit",
    name: "lmfit-py",
    category: "analysis",
    summary: "Nonlinear least-squares minimization and curve fitting.",
    source: pypi("lmfit", "1.3.4", "BSD-3-Clause"),
    tier: "inventory_only",
  },
  {
    id: "marker",
    name: "Marker",
    category: "document",
    summary: "Document conversion to structured Markdown and related formats.",
    source: pypi("marker-pdf", "2.0.0", "Apache-2.0; model terms may also apply"),
    tier: "inventory_only",
  },
  {
    id: "molmass",
    name: "molmass",
    category: "cheminformatics",
    summary: "Molecular-mass and elemental-composition calculations.",
    source: pypi("molmass", "2026.8.15", "BSD-3-Clause"),
    tier: "inventory_only",
  },
  {
    id: "paper-qa",
    name: "paper-qa",
    category: "document",
    summary: "Question answering and evidence synthesis over scientific papers.",
    source: pypi("paper-qa", "2026.8.12", "Apache-2.0"),
    tier: "inventory_only",
    requirements: ["Reviewed model and search routes", "Citation/evidence integrity tests", "Bounded document fixture"],
  },
  {
    id: "psi4",
    name: "Psi4",
    category: "quantum",
    summary: "Open-source quantum chemistry calculations.",
    source: github("Psi4", "v1.11", "https://github.com/psi4/psi4/tree/v1.11", "LGPL-3.0"),
    tier: "inventory_only",
  },
  {
    id: "pyalex",
    name: "PyAlex",
    category: "analysis",
    summary: "Analysis tooling represented by the audited PyPI project.",
    source: pypi("pyalex", "0.21", "MIT"),
    tier: "inventory_only",
  },
  {
    id: "pybaselines",
    name: "pybaselines",
    category: "analysis",
    summary: "Baseline correction algorithms for experimental signals.",
    source: pypi("pybaselines", "1.2.1", "BSD-3-Clause"),
    tier: "inventory_only",
  },
  {
    id: "syntheseus",
    name: "Syntheseus",
    category: "synthesis",
    summary: "Retrosynthesis algorithm benchmarking and route search.",
    source: pypi("syntheseus", "0.8.0", "MIT"),
    tier: "inventory_only",
  },
]

export const catalogManifests = Object.fromEntries(values.map((value) => [value.id, entry(value)])) as Record<
  string,
  CapabilityManifest
>
