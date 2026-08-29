import path from "node:path"
import z from "zod"
import { ModalPlan } from "../modal/plan"
import type { ModalAdapter } from "../modal/adapter"

export namespace SshPlan {
  export const Upload = z.object({
    path: z.string(),
    size: z.number().int().nonnegative(),
    sha256: z.string().length(64),
  })

  export const Schema = z.object({
    digest: z.string().length(64),
    provider: z.literal("ssh"),
    purpose: z.string(),
    host_id: z.string(),
    host: z.string(),
    user: z.string().optional(),
    port: z.number().int().positive().max(65_535).optional(),
    identity_file: z.string().optional(),
    proxy_jump: z.string().optional(),
    proxy_jump_host_key_digests: z.string().length(64).array().max(8).optional(),
    label: z.string(),
    scheduler: z.enum(["none", "slurm", "pbs"]),
    host_notes: z.string().optional(),
    fingerprint: z.string().startsWith("SHA256:"),
    command: z.string(),
    resources: z
      .object({
        cpus: z.number().int().positive().optional(),
        gpus: z.number().int().nonnegative().optional(),
        memory_gb: z.number().int().positive().optional(),
        time_minutes: z.number().int().positive().optional(),
        partition: z.string().optional(),
      })
      .optional(),
    modules: z.string().array().optional(),
    container: z.string().optional(),
    local_cwd: z.string(),
    remote_base: z.string(),
    remote_root: z.string(),
    remote_cwd: z.string(),
    uploads: Upload.array(),
    upload_bytes: z.number().int().nonnegative(),
    outputs: z.string().array(),
    warning: z.string(),
  })
  export type Schema = z.infer<typeof Schema>

  export type Host = {
    id: string
    label: string
    host: string
    user?: string
    port?: number
    identity_file?: string
    proxy_jump?: string
    proxy_jump_host_keys?: string[]
    scheduler: "none" | "slurm" | "pbs"
    workdir?: string
    notes?: string
    fingerprint?: string
    host_key?: string
  }

  export type Input = {
    id: string
    purpose?: string
    command: string
    resources?: {
      cpus?: number
      gpus?: number
      memory_gb?: number
      time_minutes?: number
      partition?: string
    }
    modules?: string[]
    container?: string
    cwd: string
    remoteCwd?: string
    uploads: string[]
    outputs: string[]
    host: Host
  }

  export type Prepared = { plan: Schema; files: ModalAdapter.File[] }

  function clean(value: string | undefined) {
    const current = value?.trim().replaceAll("\\", "/").replace(/^\.\//, "") || "."
    if (path.posix.isAbsolute(current) || current.split("/").includes("..")) {
      throw new Error(`SSH working directory must stay inside the staged job workspace: ${value}`)
    }
    return current === "" ? "." : current
  }

  export function remoteRoot(host: Host, id: string) {
    return `${remoteBase(host)}/.openscience/jobs/${id}`
  }

  export function remoteBase(host: Host) {
    return host.workdir?.trim().replace(/\/+$/, "") || "~"
  }

  export async function prepare(input: Input): Promise<Prepared> {
    if (!input.host.host_key || !input.host.fingerprint) {
      throw new Error(`Test ${input.host.label} once to pin its SSH host key before dispatch`)
    }
    const proxyJumpHostKeyDigests = input.host.proxy_jump_host_keys?.map((line) => {
      const material = line.trim().split(/\s+/).slice(1, 3).join(" ")
      if (!/^(?:ssh-(?:ed25519|rsa)|ecdsa-)\S*\s+\S+$/.test(material)) {
        throw new Error(`Saved SSH ProxyJump host-key material is invalid for ${input.host.label}`)
      }
      return new Bun.CryptoHasher("sha256").update(material).digest("hex")
    })
    const upload = await ModalPlan.files(input.cwd, input.uploads, "SSH")
    const value = {
      provider: "ssh" as const,
      purpose: input.purpose?.trim() || "Research computation",
      host_id: input.host.id,
      host: input.host.host,
      user: input.host.user,
      port: input.host.port,
      identity_file: input.host.identity_file,
      proxy_jump: input.host.proxy_jump,
      proxy_jump_host_key_digests: proxyJumpHostKeyDigests?.length ? proxyJumpHostKeyDigests : undefined,
      label: input.host.label,
      scheduler: input.host.scheduler,
      host_notes: input.host.notes?.trim() || undefined,
      fingerprint: input.host.fingerprint,
      command: input.command,
      resources: input.resources,
      modules: input.modules,
      container: input.container,
      local_cwd: input.cwd,
      remote_base: remoteBase(input.host),
      remote_root: remoteRoot(input.host, input.id),
      remote_cwd: clean(input.remoteCwd),
      uploads: upload.files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })),
      upload_bytes: upload.bytes,
      outputs: input.outputs.toSorted(),
      warning: `This command will run on ${input.host.label} through ${input.host.identity_file ? "the selected identity file" : "your SSH agent"}${input.host.proxy_jump ? ` via the saved ProxyJump chain ${input.host.proxy_jump}` : ""}. OpenScience pins ${input.host.fingerprint}${proxyJumpHostKeyDigests?.length ? ` and ${proxyJumpHostKeyDigests.length} jump-host key${proxyJumpHostKeyDigests.length === 1 ? "" : "s"}` : ""}, stages only the reviewed inputs, and downloads only declared outputs. Saved host notes are advisory and are never executed automatically.`,
    }
    // The durable job id/remote folder and absolute local scratch root are
    // minted per conversation. The reviewed security/workload contract binds
    // the stable remote cwd plus input paths/hashes, not those volatile paths.
    const digest = new Bun.CryptoHasher("sha256")
      .update(JSON.stringify({ ...value, local_cwd: undefined, remote_root: undefined }))
      .digest("hex")
    return { plan: Schema.parse({ digest, ...value }), files: upload.files }
  }
}
