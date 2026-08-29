import { CapabilityManifest } from "../schema"

const TERMS = "https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA_API_Trial_Service_Terms.pdf"

function hosted(input: {
  id:
    | "boltz2"
    | "diffdock"
    | "evo2"
    | "genmol"
    | "molmim"
    | "msa-search"
    | "openfold2"
    | "openfold3"
    | "proteinmpnn"
    | "rfdiffusion"
  name: string
  category: "structure" | "docking" | "protein_design" | "genomics" | "cheminformatics" | "bioinformatics"
  summary: string
  version: string
  docs: string
  basis?: string
  requirements?: string[]
}) {
  return CapabilityManifest.parse({
    schema_version: 2,
    id: input.id,
    version: "2.0.0",
    name: input.name,
    category: input.category,
    summary: input.summary,
    maturity: "experimental",
    availability: { local: "unavailable", hosted: "setup_needed" },
    basis:
      input.basis ??
      "OpenScience owns a strict request schema, a direct BYOK NVIDIA NIM adapter, bounded response capture, artifact hashing, and an offline credential doctor. No paid release canary has been recorded, so this remains experimental and is never described as release-verified.",
    source: {
      kind: "nvidia_nim",
      name: input.name,
      version: input.version,
      reference: input.docs,
      license: "NVIDIA API Trial Service Terms or the user's separate NVIDIA agreement",
    },
    hosted: {
      kind: "nvidia_nim",
      adapter_id: input.id,
      credential: "nvidia_nim",
      docs_url: input.docs,
      terms_url: TERMS,
    },
    setup: {
      instructions:
        "Add an NVIDIA API key in Credentials, review NVIDIA's applicable service and data terms, then run doctor and plan before start. OpenScience never substitutes a shared managed key.",
      requirements: input.requirements ?? [
        "A user-owned NVIDIA API key with access to the selected NIM",
        "Permission to submit the intended data under the applicable NVIDIA agreement",
        "Outbound HTTPS access to health.api.nvidia.com and api.nvcf.nvidia.com",
      ],
    },
  })
}

export const bioNemoManifests = {
  boltz2: hosted({
    id: "boltz2",
    name: "Boltz-2",
    category: "structure",
    summary: "Hosted biomolecular structure and affinity prediction through NVIDIA's Boltz-2 NIM.",
    version: "api-schema-1.5.0",
    docs: "https://docs.api.nvidia.com/nim/reference/mit-boltz2-infer",
  }),
  diffdock: hosted({
    id: "diffdock",
    name: "DiffDock",
    category: "docking",
    summary: "Hosted protein-ligand pose generation through NVIDIA's DiffDock NIM.",
    version: "api-schema-2.3.0",
    docs: "https://docs.api.nvidia.com/nim/reference/mit-diffdock-infer",
  }),
  evo2: hosted({
    id: "evo2",
    name: "Evo 2",
    category: "genomics",
    summary: "Hosted DNA sequence generation through NVIDIA's Evo 2 NIM.",
    version: "api-schema-1.0.0",
    docs: "https://docs.api.nvidia.com/nim/reference/arc-evo2-40b-infer",
  }),
  genmol: hosted({
    id: "genmol",
    name: "GenMol",
    category: "cheminformatics",
    summary: "Hosted molecular generation through NVIDIA's GenMol NIM.",
    version: "api-schema-1.0.0",
    docs: "https://docs.api.nvidia.com/nim/reference/nvidia-genmol-infer",
  }),
  molmim: hosted({
    id: "molmim",
    name: "MolMIM",
    category: "cheminformatics",
    summary: "Hosted molecule generation and optimization through NVIDIA's MolMIM NIM.",
    version: "api-schema-0.0.1",
    docs: "https://docs.api.nvidia.com/nim/reference/nvidia-molmim-infer",
  }),
  "msa-search": hosted({
    id: "msa-search",
    name: "MSA Search",
    category: "bioinformatics",
    summary: "Hosted multiple-sequence-alignment search through NVIDIA's ColabFold MSA Search NIM.",
    version: "api-schema-1.2.0",
    docs: "https://docs.api.nvidia.com/nim/reference/colabfold-msa-search-infer",
  }),
  openfold2: hosted({
    id: "openfold2",
    name: "OpenFold2",
    category: "structure",
    summary: "Hosted monomer structure prediction from MSA and templates through NVIDIA's OpenFold2 NIM.",
    version: "api-schema-2.1.0",
    docs: "https://docs.api.nvidia.com/nim/reference/openfold-openfold2-infer",
  }),
  openfold3: hosted({
    id: "openfold3",
    name: "OpenFold3",
    category: "structure",
    summary: "Hosted multimolecule structure prediction through NVIDIA's OpenFold3 NIM.",
    version: "api-schema-1.0.0",
    docs: "https://docs.api.nvidia.com/nim/reference/openfold-openfold3-infer",
    basis:
      "OpenScience owns a strict request schema, a direct BYOK NVIDIA NIM adapter, bounded response capture, artifact hashing, and an offline credential doctor. NVIDIA documents OpenFold3, but the pinned BioNeMo toolkit still marks OpenFold3 workflows as pending validation and OpenScience has no independent paid canary, so this remains experimental and configured-not-live-tested.",
    requirements: [
      "A user-owned NVIDIA API key with access to the selected NIM",
      "Permission to submit the intended data under the applicable NVIDIA agreement",
      "Outbound HTTPS access to health.api.nvidia.com and api.nvcf.nvidia.com",
      "Treat results as experimental until a bounded live OpenScience canary is recorded",
    ],
  }),
  proteinmpnn: hosted({
    id: "proteinmpnn",
    name: "ProteinMPNN",
    category: "protein_design",
    summary: "Hosted structure-conditioned protein sequence design through NVIDIA's ProteinMPNN NIM.",
    version: "api-schema-1.1.0",
    docs: "https://docs.api.nvidia.com/nim/reference/ipd-proteinmpnn-infer",
  }),
  rfdiffusion: hosted({
    id: "rfdiffusion",
    name: "RFdiffusion",
    category: "protein_design",
    summary: "Hosted protein backbone generation through NVIDIA's RFdiffusion NIM.",
    version: "api-schema-2.3.0",
    docs: "https://docs.api.nvidia.com/nim/reference/ipd-rfdiffusion-infer",
  }),
} as const
