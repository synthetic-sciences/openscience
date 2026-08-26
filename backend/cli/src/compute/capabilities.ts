import z from "zod"
import type { ComputeJobs } from "./jobs"
import { ComputeSecrets } from "./secrets"

export namespace ComputeCapabilities {
  export const Target = z.object({
    kind: z.enum(["local", "ssh", "modal"]),
    id: z.string(),
    label: z.string(),
    available: z.boolean(),
    schedulers: z.array(z.enum(["none", "slurm", "pbs"])),
    secret_refs: ComputeSecrets.Ref.array(),
    private_registry: z.boolean(),
    persistent_volume: z.boolean(),
    recovery: z.boolean(),
  })
  export type Target = z.infer<typeof Target>

  export function describe(input: {
    modal: boolean
    hosts: ComputeJobs.Host[]
    secrets: ComputeSecrets.Ref[]
  }): Target[] {
    return [
      {
        kind: "local" as const,
        id: "local",
        label: "This computer",
        available: true,
        schedulers: ["none" as const],
        secret_refs: [],
        private_registry: false,
        persistent_volume: false,
        recovery: true,
      },
      ...input.hosts.map((host) => ({
        kind: "ssh" as const,
        id: host.id,
        label: host.label,
        available: !!host.fingerprint && !!host.host_key,
        schedulers: [host.scheduler],
        secret_refs: [],
        private_registry: false,
        persistent_volume: true,
        recovery: true,
      })),
      {
        kind: "modal" as const,
        id: "modal",
        label: "Modal",
        available: input.modal,
        schedulers: ["none" as const],
        secret_refs: input.secrets,
        // Inline runtime secrets are supported. Authenticated private-registry
        // image pulls require a separate reviewed adapter and remain false.
        private_registry: false,
        persistent_volume: true,
        recovery: true,
      },
    ].map((value) => Target.parse(value))
  }
}
