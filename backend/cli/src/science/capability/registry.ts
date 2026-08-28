import { ComputeJobParameters } from "@/tool/compute-job"
import { CapabilityManifest, CapabilityPlanInput, CapabilityStatus } from "./schema"

const descriptors = [
  ["scipy", "SciPy", "analysis", "experimental"],
  ["matplotlib", "Matplotlib", "visualization", "experimental"],
  ["scikit-learn", "scikit-learn", "analysis", "experimental"],
  ["biopython", "Biopython", "bioinformatics", "experimental"],
  ["rdkit", "RDKit", "cheminformatics", "experimental"],
  ["alphafold2", "AlphaFold2", "structure", "blocked"],
] as const satisfies ReadonlyArray<readonly [string, string, string, CapabilityStatus]>

export type CapabilitySummary = {
  id: string
  name: string
  category: string
  status: CapabilityStatus
}

async function catalog() {
  return (await import("./manifests/core")).manifests
}

export namespace CapabilityRegistry {
  /** Compact discovery does not import or parse the detailed manifests. */
  export function list(): CapabilitySummary[] {
    return descriptors.map(([id, name, category, status]) => ({ id, name, category, status }))
  }

  /** Load one versioned manifest only when its details are requested. */
  export async function describe(id: string): Promise<CapabilityManifest | undefined> {
    const item = (await catalog())[id as keyof Awaited<ReturnType<typeof catalog>>]
    return item ? CapabilityManifest.parse(item) : undefined
  }

  /**
   * Compile a capability into the existing compute_job proposal contract.
   * This never dispatches work or grants compute/file/secret authority.
   */
  export async function plan(id: string, raw: CapabilityPlanInput) {
    const item = await describe(id)
    if (!item) throw new Error(`Unknown scientific capability: ${id}`)
    if (item.status === "blocked" || !item.execution) {
      throw new Error(item.blocker ?? `${item.name} is not runnable`)
    }
    const input = CapabilityPlanInput.parse(raw)
    if (!item.execution.targets.includes(input.target.kind as "modal")) {
      throw new Error(`${item.name} currently supports compute target(s): ${item.execution.targets.join(", ")}`)
    }
    const packages = Array.from(new Set([...item.execution.packages, ...(input.packages ?? [])]))
    return {
      tool: "compute_job" as const,
      capability: { id: item.id, version: item.version, status: item.status },
      input: ComputeJobParameters.parse({
        action: "plan",
        ...input,
        packages,
        image: item.execution.image,
        gpu: item.execution.gpu,
      }),
    }
  }
}
