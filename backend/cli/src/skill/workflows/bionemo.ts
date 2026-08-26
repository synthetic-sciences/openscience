import z from "zod"
import type { ComputeCapabilities } from "@/compute/capabilities"

export namespace BioNemoWorkflow {
  export const Route = z.object({
    route: z.enum(["hosted_nim", "modal_ngc_single_stage", "blocked"]),
    status: z.enum(["preflight", "blocked"]),
    target: z.string().optional(),
    secret_refs: z.array(z.enum(["nvidia_nim", "nvidia_ngc"])),
    missing: z.array(z.string()),
    notes: z.array(z.string()),
    stages: z.array(z.enum(["target", "backbone", "sequence", "complex", "self_consistency", "ranking"])),
  })
  export type Route = z.infer<typeof Route>

  export function plan(input: { targets: ComputeCapabilities.Target[]; gpu_memory_gb?: number }): Route {
    const modal = input.targets.find((target) => target.kind === "modal" && target.available)
    const hosted = modal?.secret_refs.includes("nvidia_nim")
    if (modal && hosted) {
      return Route.parse({
        route: "hosted_nim",
        status: "preflight",
        target: modal.id,
        secret_refs: ["nvidia_nim"],
        missing: [],
        notes: [
          "Verify every required NVIDIA hosted endpoint before the paid campaign.",
          "Use Boltz2 interface confidence and self-consistency; no supported protein-protein affinity NIM exists.",
          "OpenFold3 remains optional until its exact endpoint is validated for this workload.",
        ],
        stages: ["target", "backbone", "sequence", "complex", "self_consistency", "ranking"],
      })
    }
    const ngc = modal?.secret_refs.includes("nvidia_ngc")
    const enough = (input.gpu_memory_gb ?? 0) >= 48
    if (modal && ngc && modal.private_registry && enough) {
      return Route.parse({
        route: "modal_ngc_single_stage",
        status: "preflight",
        target: modal.id,
        secret_refs: ["nvidia_ngc"],
        missing: [],
        notes: [
          "Run one immutable NVIDIA container digest per resumable stage; the current adapter does not promise a multi-NIM sidecar composition.",
          "Use Boltz2 interface confidence and self-consistency; do not label ranking as experimental affinity.",
        ],
        stages: ["target", "backbone", "sequence", "complex", "self_consistency", "ranking"],
      })
    }
    const missing = [
      ...(!modal ? ["enabled Modal target"] : []),
      ...(!hosted && !ngc ? ["NVIDIA hosted API key or NGC registry key"] : []),
      ...(ngc && !modal?.private_registry ? ["reviewed private-registry image adapter"] : []),
      ...(ngc && !enough ? ["a selected GPU with at least 48 GB memory"] : []),
    ]
    return Route.parse({
      route: "blocked",
      status: "blocked",
      secret_refs: [],
      missing,
      notes: [
        "Do not claim the BioNeMo workflow executed. Configure NVIDIA hosted API access, or finish the reviewed NGC image path.",
        "An explicitly installed and validated open-source binder workflow is an alternative; OpenScience does not silently substitute one.",
      ],
      stages: ["target", "backbone", "sequence", "complex", "self_consistency", "ranking"],
    })
  }
}
