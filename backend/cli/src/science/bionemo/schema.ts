import z from "zod"

export const BioNemoCapabilityID = z.enum([
  "boltz2",
  "diffdock",
  "evo2",
  "genmol",
  "molmim",
  "msa-search",
  "openfold2",
  "openfold3",
  "proteinmpnn",
  "rfdiffusion",
])
export type BioNemoCapabilityID = z.infer<typeof BioNemoCapabilityID>

const presentText = (label: string, max = 2_000_000) =>
  z
    .string()
    .min(1, `${label} is required`)
    .max(max, `${label} is too large`)
    .refine((value) => value.trim().length > 0, `${label} is required`)
const chain = z.string().regex(/^[A-Za-z0-9]{1,4}$/)
const amino = z
  .string()
  .regex(/^[ARNDCQEGHILKMFPSTWYVX]+$/)
  .min(1)
  .max(10_240)
const requestTag = z.string().min(1).max(128)
const safeInteger = z.number().int().safe()
const nullable = <T extends z.ZodType>(schema: T) => schema.nullable().optional()

const alignmentRecord = z
  .object({
    alignment: z.string().min(1).max(5_000_000),
    format: z.enum(["csv", "a3m", "fasta", "sto"]),
    rank: nullable(safeInteger),
  })
  .strict()

function alignmentQuery(alignment: string, format: "csv" | "a3m" | "fasta" | "sto") {
  const lines = alignment
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
  if (format === "a3m" || format === "fasta") {
    if (!lines[0]?.startsWith(">")) return undefined
    const sequence: string[] = []
    for (const line of lines.slice(1)) {
      if (line.startsWith(">")) break
      sequence.push(line)
    }
    return sequence.join("") || undefined
  }
  if (format === "csv") {
    if (lines[0]?.toLowerCase() !== "key,sequence") return undefined
    const first = lines[1]
    const separator = first?.indexOf(",") ?? -1
    return separator >= 0 ? first!.slice(separator + 1).replace(/^"|"$/gu, "") : undefined
  }
  return undefined
}

const alignmentMap = z
  .record(z.string().min(1).max(64), z.record(z.string().min(1).max(32), alignmentRecord))
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > 3)
      ctx.addIssue({ code: "custom", message: "At most three alignment databases are allowed" })
    for (const [database, formats] of Object.entries(value)) {
      if (Object.keys(formats).length > 4)
        ctx.addIssue({
          code: "custom",
          path: [database],
          message: "At most four formats are allowed per database",
        })
      for (const [format, record] of Object.entries(formats))
        if (format !== record.format)
          ctx.addIssue({
            code: "custom",
            path: [database, format, "format"],
            message: "Alignment format must match its lowercase map key",
          })
    }
  })

const modification = z
  .object({
    ccd: z.string().regex(/^[A-Z0-9]{1,5}$/),
    position: safeInteger.positive(),
  })
  .strict()

const ligand = z
  .object({
    id: nullable(z.string().min(1).max(128)),
    ccd: nullable(z.string().regex(/^[A-Z0-9]{1,5}$/)),
    smiles: nullable(presentText("ligand SMILES", 20_000)),
    predict_affinity: nullable(z.boolean()),
    output_affinity_embedding: nullable(z.boolean()),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Boolean(value.ccd) === Boolean(value.smiles))
      ctx.addIssue({ code: "custom", message: "A ligand requires exactly one of ccd or smiles" })
    if (value.output_affinity_embedding && !value.predict_affinity)
      ctx.addIssue({
        code: "custom",
        path: ["output_affinity_embedding"],
        message: "Affinity embeddings require predict_affinity on the same ligand",
      })
  })

const contact = z
  .object({
    id: nullable(chain),
    residue_index: safeInteger.positive(),
  })
  .strict()

const atom = z
  .object({
    id: nullable(chain),
    residue_index: safeInteger.positive(),
    atom_name: z.string().min(1).max(128),
  })
  .strict()

const constraint = z.union([
  z
    .object({
      constraint_type: z.literal("pocket").optional(),
      binder: z.string().min(1).max(128),
      contacts: z.array(contact).min(1).max(1_000),
    })
    .strict(),
  z
    .object({
      constraint_type: z.literal("bond").optional(),
      atoms: z.array(atom).length(2),
    })
    .strict(),
])

const boltzStructuralTemplate = z
  .object({
    structure: presentText("structural template", 5_000_000),
    format: z.enum(["cif", "pdb"]),
    name: nullable(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)),
    chain_id: nullable(chain),
  })
  .strict()

const boltzPolymer = z
  .object({
    id: nullable(chain),
    molecule_type: z.enum(["protein", "dna", "rna"]),
    sequence: z
      .string()
      .regex(/^[A-Za-z]+$/)
      .min(1)
      .max(4096),
    cyclic: nullable(z.boolean()),
    msa: nullable(alignmentMap),
    modifications: nullable(z.array(modification).max(4_096)),
    structural_templates: nullable(z.array(boltzStructuralTemplate).max(4)),
  })
  .strict()
  .superRefine((value, ctx) => {
    const alphabets = {
      protein: /^[ARNDCQEGHILKMFPSTWYVX]+$/u,
      dna: /^[ATCG]+$/u,
      rna: /^[AUCG]+$/u,
    }
    if (!alphabets[value.molecule_type].test(value.sequence))
      ctx.addIssue({
        code: "custom",
        path: ["sequence"],
        message: `${value.molecule_type.toUpperCase()} sequence contains invalid residues`,
      })
    if (value.molecule_type !== "protein" && value.msa)
      ctx.addIssue({ code: "custom", path: ["msa"], message: "Only protein polymers accept MSA input" })
    if (value.molecule_type !== "protein" && value.structural_templates)
      ctx.addIssue({
        code: "custom",
        path: ["structural_templates"],
        message: "Only protein polymers accept structural templates",
      })
    if (value.molecule_type === "protein") {
      for (const [database, formats] of Object.entries(value.msa ?? {})) {
        for (const [format, record] of Object.entries(formats)) {
          if (
            (format === "a3m" || format === "csv") &&
            alignmentQuery(record.alignment, record.format) !== value.sequence
          )
            ctx.addIssue({
              code: "custom",
              path: ["msa", database, format, "alignment"],
              message: "The first MSA sequence must exactly match the polymer sequence",
            })
        }
      }
    }
    for (const [index, item] of (value.modifications ?? []).entries()) {
      if (item.position > value.sequence.length)
        ctx.addIssue({
          code: "custom",
          path: ["modifications", index, "position"],
          message: "Modification position exceeds the polymer sequence length",
        })
    }
  })

// https://docs.nvidia.com/nim/bionemo/boltz2/latest/inference.html
export const Boltz2Input = z
  .object({
    polymers: z.array(boltzPolymer).min(1).max(12),
    ligands: nullable(z.array(ligand).max(20)),
    constraints: nullable(z.array(constraint).max(1_000)),
    recycling_steps: nullable(safeInteger.min(1).max(10)),
    sampling_steps: nullable(safeInteger.min(10).max(1_000)),
    diffusion_samples: nullable(safeInteger.min(1).max(25)),
    step_scale: nullable(z.number().min(0.5).max(5)),
    without_potentials: nullable(z.boolean()),
    output_format: nullable(z.literal("mmcif")),
    concatenate_msas: nullable(z.boolean()),
    sampling_steps_affinity: nullable(safeInteger.min(10).max(1_000)),
    diffusion_samples_affinity: nullable(safeInteger.min(1).max(10)),
    affinity_mw_correction: nullable(z.boolean()),
    write_full_pae: nullable(z.boolean()),
    write_full_pde: nullable(z.boolean()),
  })
  .strict()
  .superRefine((value, ctx) => {
    const affinityLigands = (value.ligands ?? []).filter((item) => item.predict_affinity === true)
    if (affinityLigands.length > 1)
      ctx.addIssue({ code: "custom", path: ["ligands"], message: "At most one ligand may predict affinity" })
    const affinityIdentities = affinityLigands.map((item) => item.ccd ?? item.smiles)
    if (new Set(affinityIdentities).size !== affinityIdentities.length)
      ctx.addIssue({
        code: "custom",
        path: ["ligands"],
        message: "Affinity ligands may not repeat a CCD or SMILES identity",
      })
    const pocketConstraints = (value.constraints ?? []).filter((item) => item.constraint_type !== "bond")
    if (pocketConstraints.length > 1)
      ctx.addIssue({
        code: "custom",
        path: ["constraints"],
        message: "At most one pocket constraint is allowed per request",
      })
  })

export const DiffDockInput = z
  .object({
    protein: presentText("protein structure"),
    ligand: presentText("ligand"),
    ligand_file_type: z.enum(["mol2", "sdf", "txt"]),
    num_poses: nullable(safeInteger.min(1).max(100)),
    time_divisions: nullable(safeInteger.min(3).max(20)),
    steps: nullable(safeInteger.min(1).max(18)),
    save_trajectory: nullable(z.boolean()),
    skip_gen_conformer: nullable(z.boolean()),
    is_staged: nullable(z.literal(false)),
  })
  .strict()

export const Evo2Input = z
  .object({
    sequence: presentText("DNA sequence", 1_000_000),
    num_tokens: nullable(safeInteger.min(1).max(1_000_000)),
    temperature: nullable(z.number().positive().max(1.3)),
    top_k: nullable(safeInteger.min(0).max(6)),
    top_p: nullable(z.number().min(0).max(1)),
    random_seed: nullable(safeInteger),
    enable_logits: z.boolean().optional(),
    enable_sampled_probs: z.boolean().optional(),
    enable_elapsed_ms_per_token: z.boolean().optional(),
  })
  .strict()

const numericString = (minimum: number, maximum: number) =>
  z
    .string()
    .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
    .refine((value) => Number(value) >= minimum && Number(value) <= maximum)

export const GenMolInput = z
  .object({
    smiles: presentText("SAFE or SMILES input", 20_000),
    num_molecules: safeInteger.min(1).max(1_000).optional(),
    temperature: numericString(0.01, 10).optional(),
    noise: numericString(0, 2).optional(),
    step_size: safeInteger.min(1).max(10).optional(),
    scoring: z.enum(["QED", "LogP"]).optional(),
    unique: z.boolean().optional(),
  })
  .strict()

export const MolMIMInput = z
  .object({
    algorithm: z.enum(["CMA-ES", "none"]).optional(),
    smi: presentText("seed molecule", 20_000),
    num_molecules: safeInteger.min(1).max(100).optional(),
    iterations: safeInteger.min(1).max(1_000).optional(),
    property_name: z.enum(["QED", "plogP"]).optional(),
    particles: safeInteger.min(2).max(1_000).optional(),
    minimize: z.boolean().optional(),
    min_similarity: z.number().min(0).max(1).optional(),
    scaled_radius: z.number().min(0).max(2).optional(),
  })
  .strict()

export const MSASearchInput = z
  .object({
    // Database names are runtime-configurable and case-insensitive in the current NIM.
    // https://docs.nvidia.com/nim/bionemo/msa-search/2.4.0/api-reference.html
    databases: nullable(
      z
        .array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/))
        .min(1)
        .max(5),
    ),
    e_value: nullable(z.number().min(0).max(1)),
    iterations: nullable(safeInteger.min(1).max(6)),
    max_msa_sequences: nullable(safeInteger.min(1).max(10_001)),
    output_alignment_formats: nullable(
      z
        .array(z.enum(["a3m", "fasta"]))
        .min(1)
        .max(2),
    ),
    search_type: nullable(z.enum(["colabfold", "alphafold2"])),
    sequence: amino.max(4_096),
  })
  .strict()

const templateRecord = z
  .object({
    templates: nullable(z.string().max(5_000_000)),
    parsed_templates: nullable(
      z
        .array(
          z
            .object({
              index: safeInteger,
              name: z.string().max(128),
              alignment_cols: safeInteger,
              sum_probs: nullable(z.number()),
              query: z.string().max(5_000_000),
              hit_sequence: z.string().max(5_000_000),
              indices_query: z.array(safeInteger).max(10_000),
              indices_hit: z.array(safeInteger).max(10_000),
            })
            .strict(),
        )
        .max(10_000),
    ),
    format: z.enum(["sto", "hhr", "parsed_templates"]),
  })
  .strict()

const templateMap = z.record(z.string().min(1).max(64), z.record(z.string().min(1).max(32), templateRecord))

const checksum = z
  .object({
    checksum: z.string().regex(/^[a-fA-F0-9]{1,128}$/),
    algorithm: z.enum(["sha256", "None"]).optional(),
  })
  .strict()

const openFold2AlignmentRecord = z
  .object({
    alignment: z.string().max(5_000_000),
    format: z.enum(["sto", "a3m", "fasta"]),
  })
  .strict()

const openFold2AlignmentMap = z.record(
  z.string().min(1).max(64),
  z.record(z.string().min(1).max(32), openFold2AlignmentRecord),
)

const structuralTemplate = z
  .object({
    structure: presentText("template mmCIF", 5_000_000),
    format: z.enum(["mmcif", "mmcif.gz"]),
    name: nullable(z.string().max(256)),
    source: nullable(z.string().max(2_048)),
    rank: nullable(safeInteger),
    checksum: nullable(checksum),
    compression_ratio: nullable(z.number().positive()),
  })
  .strict()

export const OpenFold2Input = z
  .object({
    sequence: amino.max(1_000),
    input_id: nullable(requestTag),
    alignments: nullable(openFold2AlignmentMap),
    templates: nullable(templateMap),
    selected_models: nullable(z.array(safeInteger.min(1).max(5)).min(1).max(5)),
    relax_prediction: nullable(z.boolean()),
    use_templates: nullable(z.boolean()),
    explicit_templates: nullable(z.array(structuralTemplate).max(64)),
  })
  .strict()

const openFold3AlignmentRecord = z
  .object({
    alignment: z.string().min(1).max(5_000_000),
    format: z.enum(["a3m", "csv"]),
    rank: nullable(safeInteger),
  })
  .strict()

const openFold3AlignmentMap = z
  .record(z.string().min(1).max(64), z.record(z.string().min(1).max(32), openFold3AlignmentRecord))
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > 3)
      ctx.addIssue({ code: "custom", message: "OpenFold3 accepts at most three MSA databases" })
    for (const [database, formats] of Object.entries(value)) {
      if (Object.keys(formats).length > 2)
        ctx.addIssue({ code: "custom", path: [database], message: "Only A3M and CSV alignments are supported" })
      for (const [format, record] of Object.entries(formats))
        if (format !== record.format)
          ctx.addIssue({
            code: "custom",
            path: [database, format, "format"],
            message: "Alignment format must match its lowercase map key",
          })
    }
  })

const openFold3Molecule = z
  .object({
    type: z.enum(["protein", "rna", "dna", "ligand"]),
    id: nullable(z.union([chain, z.array(chain).min(1).max(32)])),
    sequence: nullable(
      z
        .string()
        .regex(/^[A-Za-z]+$/)
        .min(2)
        .max(4096),
    ),
    ccd_codes: nullable(z.string().regex(/^[A-Z0-9]{1,5}$/)),
    smiles: nullable(presentText("ligand SMILES", 20_000)),
    msa: nullable(openFold3AlignmentMap),
    paired_msa: nullable(openFold3AlignmentMap),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.type === "ligand") {
      if (Boolean(value.ccd_codes) === Boolean(value.smiles))
        ctx.addIssue({ code: "custom", message: "A ligand requires exactly one of ccd_codes or smiles" })
      for (const name of ["sequence", "msa", "paired_msa"] as const)
        if (value[name] !== undefined && value[name] !== null)
          ctx.addIssue({ code: "custom", path: [name], message: `Ligands must not include ${name}` })
      return
    }
    if (!value.sequence)
      ctx.addIssue({ code: "custom", path: ["sequence"], message: `${value.type} molecules require sequence` })
    if (value.type === "protein" && value.sequence && !/^[ARNDCQEGHILKMFPSTWYVX]+$/u.test(value.sequence))
      ctx.addIssue({ code: "custom", path: ["sequence"], message: "Protein sequence contains invalid residues" })
    if (value.type === "dna" && value.sequence && !/^[ATCG]+$/u.test(value.sequence))
      ctx.addIssue({ code: "custom", path: ["sequence"], message: "DNA sequence must contain only A, T, C, or G" })
    if (value.type === "rna" && value.sequence && !/^[AUCG]+$/u.test(value.sequence))
      ctx.addIssue({ code: "custom", path: ["sequence"], message: "RNA sequence must contain only A, U, C, or G" })
    if (value.type === "dna" && (value.msa || value.paired_msa))
      ctx.addIssue({ code: "custom", path: ["msa"], message: "DNA molecules do not accept MSA fields" })
    if (value.type === "rna" && value.paired_msa)
      ctx.addIssue({ code: "custom", path: ["paired_msa"], message: "RNA molecules do not accept paired_msa" })
    if (value.type === "protein" && !value.msa && !value.paired_msa)
      ctx.addIssue({
        code: "custom",
        path: ["msa"],
        message: "Protein molecules require msa or paired_msa",
      })
    if (value.type === "rna" && !value.msa)
      ctx.addIssue({ code: "custom", path: ["msa"], message: "RNA molecules require msa" })
    if (value.ccd_codes || value.smiles)
      ctx.addIssue({
        code: "custom",
        path: ["ccd_codes"],
        message: `${value.type} molecules must not include ligand fields`,
      })
    if (value.sequence) {
      for (const field of ["msa", "paired_msa"] as const) {
        for (const [database, formats] of Object.entries(value[field] ?? {})) {
          for (const [format, record] of Object.entries(formats)) {
            if (alignmentQuery(record.alignment, record.format) !== value.sequence)
              ctx.addIssue({
                code: "custom",
                path: [field, database, format, "alignment"],
                message: "The first MSA sequence must exactly match the molecule sequence",
              })
          }
        }
      }
    }
  })

const openFold3InputItem = z
  .object({
    input_id: nullable(requestTag),
    molecules: z.array(openFold3Molecule).min(1).max(32),
    diffusion_samples: nullable(safeInteger.min(1).max(5)),
    output_format: nullable(z.enum(["cif", "pdb"])),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = value.molecules.flatMap((molecule) =>
      Array.isArray(molecule.id) ? molecule.id : molecule.id ? [molecule.id] : [],
    )
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", path: ["molecules"], message: "OpenFold3 chain IDs must be unique" })
    if (value.output_format === "pdb") {
      for (const [index, molecule] of value.molecules.entries()) {
        const moleculeIDs = Array.isArray(molecule.id) ? molecule.id : molecule.id ? [molecule.id] : []
        if (moleculeIDs.some((id) => id.length !== 1))
          ctx.addIssue({
            code: "custom",
            path: ["molecules", index, "id"],
            message: "PDB output requires single-character chain IDs",
          })
      }
    }
  })

// Managed hosted API contract. The newer self-hosted NIM documentation adds
// structural templates, but health.api.nvidia.com does not currently expose
// that field, so strict parsing rejects it rather than risking silent omission.
// https://docs.api.nvidia.com/nim/reference/openfold-openfold3-infer
export const OpenFold3Input = z
  .object({
    request_id: nullable(requestTag),
    inputs: z.array(openFold3InputItem).length(1),
  })
  .strict()

const optionalJsonl = nullable(z.string().max(5_000_000))

export const ProteinMPNNInput = z
  .object({
    input_pdb: nullable(presentText("input PDB")),
    input_pdb_asset: nullable(z.string().min(1).max(370)),
    input_pdb_chains: nullable(z.array(z.string().min(1).max(128)).min(1).max(64)),
    ca_only: nullable(z.boolean()),
    use_soluble_model: nullable(z.boolean()),
    random_seed: nullable(safeInteger),
    num_seq_per_target: nullable(safeInteger.min(1).max(100)),
    sampling_temp: nullable(z.array(z.number().positive().max(1)).min(1).max(100)),
    pssm_jsonl: optionalJsonl,
    pssm_multi: nullable(z.number().min(0).max(1)),
    pssm_threshold: nullable(z.number()),
    pssm_bias_flag: nullable(z.boolean()),
    pssm_log_odds_flag: nullable(z.boolean()),
    fixed_positions_jsonl: optionalJsonl,
    omit_AAs: nullable(z.array(z.string().regex(/^[ACDEFGHIKLMNPQRSTVWY]$/)).max(20)),
    omit_AA_jsonl: optionalJsonl,
    bias_AA_jsonl: optionalJsonl,
    bias_by_res_jsonl: optionalJsonl,
    tied_positions_jsonl: optionalJsonl,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.input_pdb && !value.input_pdb_asset)
      ctx.addIssue({ code: "custom", message: "ProteinMPNN requires input_pdb or input_pdb_asset" })
  })

// https://docs.nvidia.com/nim/bionemo/rfdiffusion/latest/endpoints.html
export const RFDiffusionInput = z
  .object({
    input_pdb: nullable(presentText("input PDB")),
    input_pdb_asset: nullable(z.string().min(1).max(370)),
    contigs: z.string().min(1).max(4_000),
    hotspot_res: nullable(z.array(z.string().regex(/^[A-Za-z0-9]{1,4}\d+$/)).max(100)),
    diffusion_steps: nullable(safeInteger.min(1).max(50)),
    random_seed: nullable(safeInteger),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.input_pdb && !value.input_pdb_asset)
      ctx.addIssue({ code: "custom", message: "RFdiffusion requires input_pdb or input_pdb_asset" })
  })

export const BioNemoInputs = {
  boltz2: Boltz2Input,
  diffdock: DiffDockInput,
  evo2: Evo2Input,
  genmol: GenMolInput,
  molmim: MolMIMInput,
  "msa-search": MSASearchInput,
  openfold2: OpenFold2Input,
  openfold3: OpenFold3Input,
  proteinmpnn: ProteinMPNNInput,
  rfdiffusion: RFDiffusionInput,
} as const

const structure = z
  .object({
    structure: presentText("structure", 10_000_000),
    format: z.string().min(1).max(32),
    name: nullable(z.string().max(256)),
    source: nullable(z.string().max(2_048)),
  })
  .strip()

const boundedMetrics = z
  .record(z.string().min(1).max(128), z.union([z.string().max(2_000), z.number(), z.boolean(), z.null()]))
  .refine((value) => Object.keys(value).length <= 256, "Too many metric fields")

const affinityValues = z.array(z.number()).min(1).max(10)
const probabilityValues = z.array(z.number().min(0).max(1)).min(1).max(10)
const affinityEmbedding = z.array(z.array(z.number()).length(384)).min(1).max(10)
const affinity = z
  .object({
    affinity_pic50: affinityValues,
    affinity_pred_value: affinityValues,
    affinity_probability_binary: probabilityValues,
    model_1_affinity_pred_value: affinityValues.optional(),
    model_1_affinity_probability_binary: probabilityValues.optional(),
    model_2_affinity_pred_value: affinityValues.optional(),
    model_2_affinity_probability_binary: probabilityValues.optional(),
    affinity_embedding: nullable(affinityEmbedding),
    model_1_affinity_embedding: nullable(affinityEmbedding),
    model_2_affinity_embedding: nullable(affinityEmbedding),
  })
  .strict()
  .superRefine((value, ctx) => {
    const consensus = [value.affinity_pic50, value.affinity_pred_value, value.affinity_probability_binary]
    const expected = value.affinity_pred_value.length
    if (new Set(consensus.map((item) => item.length)).size !== 1)
      ctx.addIssue({ code: "custom", message: "Consensus affinity arrays must have equal lengths" })
    const parallel = (prefix: "model_1_" | "model_2_") => {
      const arrays = [value[`${prefix}affinity_pred_value`], value[`${prefix}affinity_probability_binary`]]
      const present = arrays.filter((item): item is number[] => Boolean(item))
      if (present.length !== 0 && present.length !== 2)
        ctx.addIssue({ code: "custom", message: `${prefix}affinity arrays must be provided together` })
      if (present.length === 2 && present[0].length !== present[1].length)
        ctx.addIssue({ code: "custom", message: `${prefix}affinity arrays must have equal lengths` })
      if (present.length === 2 && present[0].length !== expected)
        ctx.addIssue({ code: "custom", message: `${prefix}affinity arrays must match the affinity sample count` })
    }
    parallel("model_1_")
    parallel("model_2_")
    for (const [name, embeddings] of [
      ["affinity_embedding", value.affinity_embedding],
      ["model_1_affinity_embedding", value.model_1_affinity_embedding],
      ["model_2_affinity_embedding", value.model_2_affinity_embedding],
    ] as const) {
      if (embeddings && embeddings.length !== expected)
        ctx.addIssue({ code: "custom", path: [name], message: `${name} must match the affinity sample count` })
    }
  })

const boltzSampleValues = z.array(z.number()).max(25).optional()
const boltzErrorMatrix = z
  .array(z.array(z.array(z.number()).max(4_096)).max(4_096))
  .max(25)
  .optional()
const pairChainScores = z
  .array(
    z.record(
      z.string().min(1).max(4),
      z.record(z.string().min(1).max(4), z.number()).refine((item) => Object.keys(item).length <= 12),
    ),
  )
  .max(25)
  .optional()
const boltzStructure = structure.extend({ format: z.literal("mmcif") })

const Boltz2Output = z
  .object({
    structures: z.array(boltzStructure).min(1).max(25),
    confidence_scores: z.array(z.number()).min(1).max(25),
    affinities: nullable(
      z
        .record(z.string().min(1).max(128), affinity)
        .refine((value) => Object.keys(value).length <= 1, "Only one affinity ligand is allowed"),
    ),
    ptm_scores: boltzSampleValues,
    iptm_scores: boltzSampleValues,
    ligand_iptm_scores: boltzSampleValues,
    protein_iptm_scores: boltzSampleValues,
    complex_plddt_scores: boltzSampleValues,
    complex_iplddt_scores: boltzSampleValues,
    complex_pde_scores: boltzSampleValues,
    complex_ipde_scores: boltzSampleValues,
    chains_ptm_scores: z.array(z.number()).max(300).optional(),
    pair_chains_iptm_scores: pairChainScores,
    pae: boltzErrorMatrix,
    pde: boltzErrorMatrix,
    metrics: nullable(boundedMetrics),
  })
  .strip()
  .superRefine((value, ctx) => {
    const expected = value.structures.length
    if (expected !== value.confidence_scores.length)
      ctx.addIssue({
        code: "custom",
        path: ["confidence_scores"],
        message: "Each Boltz-2 structure requires one confidence score",
      })
    for (const name of [
      "ptm_scores",
      "iptm_scores",
      "ligand_iptm_scores",
      "protein_iptm_scores",
      "complex_plddt_scores",
      "complex_iplddt_scores",
      "complex_pde_scores",
      "complex_ipde_scores",
      "pair_chains_iptm_scores",
      "pae",
      "pde",
    ] as const) {
      const list = value[name]
      if (list && list.length !== expected)
        ctx.addIssue({ code: "custom", path: [name], message: `${name} must match the structure count` })
    }
  })

const DiffDockOutput = z
  .object({
    status: z.enum(["success", "successful", "completed", "succeeded"]),
    ligand_positions: z.array(presentText("docking pose", 10_000_000)).min(1).max(100),
    position_confidence: z.array(z.number()).min(1).max(100),
    trajectory: z.array(z.string().max(10_000_000)).max(100).optional(),
  })
  .strip()
  .superRefine((value, ctx) => {
    if (value.ligand_positions.length !== value.position_confidence.length)
      ctx.addIssue({ code: "custom", message: "Docking poses and confidence scores must have the same length" })
  })

const Evo2Output = z
  .object({
    sequence: presentText("generated DNA", 2_000_000),
    elapsed_ms: safeInteger.nonnegative(),
    logits: nullable(z.array(z.array(z.number()).max(512)).max(1_000_000)),
    sampled_probs: nullable(z.array(z.number()).max(1_000_000)),
    elapsed_ms_per_token: nullable(z.array(safeInteger.nonnegative()).max(1_000_000)),
  })
  .strip()

const generatedMolecule = z
  .object({
    smiles: presentText("generated SMILES", 20_000),
    score: z.number(),
  })
  .strip()

const GenMolOutput = z
  .object({
    status: z.literal("success"),
    molecules: z.array(generatedMolecule).max(1_000),
  })
  .strip()

const molMIMMolecules = z
  .string()
  .max(10_000_000)
  .superRefine((value, ctx) => {
    try {
      const parsed = z
        .array(z.object({ sample: presentText("generated SMILES", 20_000), score: z.number() }).strip())
        .max(100)
        .safeParse(JSON.parse(value))
      if (!parsed.success) ctx.addIssue({ code: "custom", message: "molecules must encode a bounded molecule array" })
    } catch {
      ctx.addIssue({ code: "custom", message: "molecules must be valid JSON" })
    }
  })

const MolMIMOutput = z
  .object({
    molecules: molMIMMolecules,
    score_type: z.string().min(1).max(128),
  })
  .strip()

const MSASearchOutput = z
  .object({
    alignments: z
      .record(z.string().min(1).max(64), z.record(z.string().min(1).max(32), alignmentRecord))
      .refine((value) => Object.keys(value).length > 0),
    metrics: nullable(boundedMetrics),
  })
  .strip()

const OpenFold2Output = z
  .object({
    structures_in_ranked_order: z
      .array(
        z
          .object({
            structure: presentText("structure", 10_000_000),
            format: z.string().min(1).max(32),
            relaxed: z.boolean(),
            rank_by_confidence: safeInteger,
            confidence: z.number().nullable(),
          })
          .strip(),
      )
      .min(1)
      .max(5),
    of2_nim_handled_error_message: nullable(z.literal("no-handled-error")),
  })
  .strip()

const OpenFold3Output = z
  .object({
    request_id: nullable(requestTag),
    outputs: z
      .array(
        z
          .object({
            input_id: nullable(z.string().max(128)),
            structures_with_scores: z
              .array(
                structure.extend({
                  format: z.enum(["cif", "pdb"]),
                  confidence_score: z.number(),
                  complex_plddt_score: z.number(),
                  complex_pde_score: z.number(),
                  ptm_score: z.number(),
                  iptm_score: z.number(),
                }),
              )
              .min(1)
              .max(5),
            runtime_metrics: nullable(boundedMetrics),
          })
          .strip(),
      )
      .length(1),
  })
  .strip()

const ProteinMPNNOutput = z
  .object({
    mfasta: z
      .string()
      .max(10_000_000)
      .refine((value) => value.trimStart().startsWith(">")),
    scores: z.array(z.number()).min(1).max(10_000),
    probs: z.array(z.unknown()).max(10_000).optional(),
  })
  .strip()

const RFDiffusionOutput = z
  .object({
    output_pdb: presentText("output PDB", 10_000_000),
    elapsed_ms: safeInteger.nonnegative(),
  })
  .strict()

export const BioNemoOutputs = {
  boltz2: Boltz2Output,
  diffdock: DiffDockOutput,
  evo2: Evo2Output,
  genmol: GenMolOutput,
  molmim: MolMIMOutput,
  "msa-search": MSASearchOutput,
  openfold2: OpenFold2Output,
  openfold3: OpenFold3Output,
  proteinmpnn: ProteinMPNNOutput,
  rfdiffusion: RFDiffusionOutput,
} as const

export function parseBioNemoInput(id: BioNemoCapabilityID, value: unknown) {
  return BioNemoInputs[id].parse(value) as Record<string, unknown>
}

export function parseBioNemoOutput(id: BioNemoCapabilityID, value: unknown) {
  return BioNemoOutputs[id].parse(value) as Record<string, unknown>
}
