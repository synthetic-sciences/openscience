export const artifactKinds = [
  "dataset",
  "figure",
  "report",
  "structure",
  "sequence",
  "genomics",
  "spectrum",
  "model",
  "archive",
] as const

export type ArtifactKind = (typeof artifactKinds)[number]
export type ArtifactSort = "recent" | "size" | "name"

export interface ArtifactInfo {
  name: string
  path: string
  kind: ArtifactKind
  format: string
  size: number
  modified: number
}

export interface ArtifactAction {
  id: string
  label: string
  description: string
  prompt: string
}

const kinds = new Set<string>(artifactKinds)

export function normalizeArtifacts(value: unknown): ArtifactInfo[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): ArtifactInfo[] => {
    if (!item || typeof item !== "object") return []
    const row = item as Record<string, unknown>
    if (
      typeof row.name !== "string" ||
      typeof row.path !== "string" ||
      typeof row.kind !== "string" ||
      !kinds.has(row.kind) ||
      typeof row.format !== "string" ||
      typeof row.size !== "number" ||
      typeof row.modified !== "number"
    )
      return []
    return [
      {
        name: row.name,
        path: row.path,
        kind: row.kind as ArtifactKind,
        format: row.format,
        size: row.size,
        modified: row.modified,
      },
    ]
  })
}

export function filterArtifacts(rows: ArtifactInfo[], kind: ArtifactKind | "all", query: string): ArtifactInfo[] {
  const term = query.trim().toLowerCase()
  return rows.filter((row) => {
    if (kind !== "all" && row.kind !== kind) return false
    if (!term) return true
    return `${row.name}\n${row.path}\n${row.format}\n${row.kind}`.toLowerCase().includes(term)
  })
}

export function sortArtifacts(rows: ArtifactInfo[], sort: ArtifactSort): ArtifactInfo[] {
  return rows.toSorted((a, b) => {
    if (sort === "recent") return b.modified - a.modified || a.name.localeCompare(b.name)
    if (sort === "size") return b.size - a.size || a.name.localeCompare(b.name)
    return a.name.localeCompare(b.name)
  })
}

export function groupArtifacts(rows: ArtifactInfo[]): { kind: ArtifactKind; count: number }[] {
  const counts = rows.reduce<Partial<Record<ArtifactKind, number>>>(
    (all, row) => ({ ...all, [row.kind]: (all[row.kind] ?? 0) + 1 }),
    {},
  )
  return Object.entries(counts)
    .map(([kind, count]) => ({ kind: kind as ArtifactKind, count }))
    .toSorted((a, b) => a.kind.localeCompare(b.kind))
}

export function formatArtifactKind(kind: ArtifactKind): string {
  if (kind === "genomics") return "genomics"
  if (kind === "spectrum") return "mass spec"
  return kind
}

export function artifactActions(artifact: ArtifactInfo): ArtifactAction[] {
  const path = artifact.path
  const actions: Record<ArtifactKind, Array<Omit<ArtifactAction, "prompt"> & { instruction: string }>> = {
    dataset: [
      {
        id: "inspect-quality",
        label: "Inspect quality",
        description: "Profile schema, missingness, outliers, and leakage risks.",
        instruction:
          "Inspect this dataset's schema and quality. Find missingness, suspicious values, outliers, and leakage risks.",
      },
      {
        id: "visualize",
        label: "Visualize",
        description: "Build useful, statistically honest exploratory plots.",
        instruction:
          "Create a focused set of statistically honest visualizations for this dataset and explain the patterns.",
      },
      {
        id: "analyze",
        label: "Analyze",
        description: "Answer the most decision-relevant question with a reproducible analysis.",
        instruction: "Analyze this dataset reproducibly. State assumptions and save reusable code and outputs.",
      },
    ],
    figure: [
      {
        id: "review-figure",
        label: "Critique figure",
        description: "Check clarity, accessibility, scales, and claim support.",
        instruction:
          "Critique this figure for scientific clarity, accessibility, scales, uncertainty, and claim support.",
      },
      {
        id: "trace-figure",
        label: "Trace source",
        description: "Find the data and code that produced the figure.",
        instruction:
          "Trace this figure back to its source data, code, and scientific claim. Record missing provenance.",
      },
      {
        id: "rebuild-figure",
        label: "Rebuild",
        description: "Create editable publication-ready SVG, PNG, and PDF.",
        instruction: "Rebuild this as an editable, publication-ready figure while preserving the underlying evidence.",
      },
    ],
    report: [
      {
        id: "verify-report",
        label: "Verify claims",
        description: "Check citations, numbers, and claim support.",
        instruction: "Audit this report's citations, numbers, and scientific claims against concrete project evidence.",
      },
      {
        id: "summarize-report",
        label: "Executive brief",
        description: "Extract findings, limitations, and decisions.",
        instruction:
          "Create a concise executive brief from this report with findings, limitations, and open decisions.",
      },
      {
        id: "revise-report",
        label: "Publication pass",
        description: "Improve structure and evidence without overstating results.",
        instruction: "Revise this report for publication quality without overstating the evidence.",
      },
    ],
    structure: [
      {
        id: "inspect-structure",
        label: "Inspect structure",
        description: "Check chains, ligands, chemistry, and geometry.",
        instruction:
          "Inspect this molecular structure. Check chains, ligands, chemistry, geometry, and quality issues.",
      },
      {
        id: "prepare-docking",
        label: "Prepare docking",
        description: "Validate protonation, receptor, ligands, and binding site.",
        instruction:
          "Prepare a careful docking workflow from this structure, validating protonation and the binding site first.",
      },
      {
        id: "design",
        label: "Design candidates",
        description: "Define constraints and propose auditable designs.",
        instruction:
          "Use this structure to propose a small, auditable protein or molecule design workflow with explicit constraints.",
      },
    ],
    sequence: [
      {
        id: "sequence-qc",
        label: "Sequence QC",
        description: "Measure composition, quality, duplication, and anomalies.",
        instruction: "Quality-check these sequences and report composition, read quality, duplication, and anomalies.",
      },
      {
        id: "annotate-sequence",
        label: "Annotate",
        description: "Identify features, motifs, and likely function.",
        instruction: "Annotate these sequences with defensible features, motifs, and likely functions.",
      },
      {
        id: "compare-sequence",
        label: "Compare",
        description: "Align sequences and explain meaningful differences.",
        instruction: "Compare and align these sequences, then explain the biologically meaningful differences.",
      },
    ],
    genomics: [
      {
        id: "genomics-qc",
        label: "Genomics QC",
        description: "Inspect variants, coverage, alignment, and references.",
        instruction:
          "Quality-check this genomics artifact, including references, samples, variants, coverage, and alignment.",
      },
      {
        id: "annotate-variants",
        label: "Annotate variants",
        description: "Normalize, annotate, and prioritize interpretable candidates.",
        instruction: "Normalize and annotate the variants in this artifact, then prioritize candidates with evidence.",
      },
      {
        id: "build-track",
        label: "Build summary",
        description: "Create a compact genomic summary and export table.",
        instruction: "Build an interpretable genomic summary from this artifact and save a clean export table.",
      },
    ],
    spectrum: [
      {
        id: "spectrum-qc",
        label: "Spectrum QC",
        description: "Inspect acquisition, peaks, contaminants, and signal quality.",
        instruction:
          "Inspect this spectrum or mass-spec file for acquisition quality, peaks, contaminants, and anomalies.",
      },
      {
        id: "identify-spectrum",
        label: "Identify",
        description: "Plan a transparent peptide or metabolite identification.",
        instruction:
          "Plan a transparent identification workflow for this spectrum with databases, tolerances, and FDR controls.",
      },
      {
        id: "compare-spectrum",
        label: "Compare runs",
        description: "Compare signal and quality across available runs.",
        instruction: "Compare this spectrum against related runs and explain decision-relevant quality differences.",
      },
    ],
    model: [
      {
        id: "inspect-model",
        label: "Inspect model",
        description: "Recover architecture, inputs, outputs, and provenance.",
        instruction:
          "Inspect this model artifact and recover architecture, expected inputs, outputs, version, and provenance.",
      },
      {
        id: "evaluate-model",
        label: "Evaluate",
        description: "Design a held-out evaluation with failure analysis.",
        instruction: "Evaluate this model on an appropriate held-out set with failure analysis and no data leakage.",
      },
      {
        id: "package-model",
        label: "Package",
        description: "Create a reproducible inference bundle and model card.",
        instruction: "Package this model into a reproducible inference bundle with an environment lock and model card.",
      },
    ],
    archive: [
      {
        id: "inventory-archive",
        label: "Inventory",
        description: "List contents and identify scientific assets safely.",
        instruction:
          "Inspect this archive safely, inventory its contents, and identify the scientific assets and risks.",
      },
      {
        id: "verify-archive",
        label: "Verify integrity",
        description: "Check hashes, structure, and reproducibility files.",
        instruction: "Verify this archive's integrity and whether it contains enough metadata to reproduce the work.",
      },
      {
        id: "import-archive",
        label: "Plan import",
        description: "Create a safe, non-destructive import plan.",
        instruction: "Create a safe, non-destructive plan to import the useful artifacts from this archive.",
      },
    ],
  }
  return actions[artifact.kind].map((action) => ({
    id: action.id,
    label: action.label,
    description: action.description,
    prompt: `${action.instruction}\n\nTarget file: ${path}`,
  }))
}
