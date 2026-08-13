import crypto from "crypto"
import z from "zod"
import { NamedError } from "@synsci/util/error"
import { Config } from "@/config/config"
import { Sandbox } from "@/sandbox/sandbox"
import { SessionFilesystem } from "@/session/filesystem"
import { Instance } from "./instance"
import { Project } from "./project"
import { ProjectTrust } from "./trust"

/**
 * The single process-execution authority for a project session.
 *
 * Permission prompts answer whether one requested action is approved. This
 * decision answers whether the owning project/session may create a process at
 * all, and captures the exact trust, filesystem, and sandbox revisions applied
 * to that process.
 */
export namespace ExecutionAuthority {
  export const Capability = z.enum([
    "terminal",
    "kernel",
    "shell",
    "local_job",
    "remote_job",
    "package_install",
    "project_plugin",
    "project_mcp",
    "project_formatter",
    "project_lsp",
    "provider_token_command",
  ])
  export type Capability = z.infer<typeof Capability>

  export const Decision = z.object({
    allowed: z.boolean(),
    reason: z.enum(["allowed", "project_untrusted", "sandbox_unavailable"]),
    capability: Capability,
    mode: z.enum(["read_only", "sandboxed", "host"]),
    projectID: z.string(),
    sessionID: z.string(),
    trustRevision: z.number().int().positive(),
    grantRevision: z.number().int().positive(),
    generation: z.string(),
    /** Canonical project instance directory. Older persisted job decisions
     * omitted this and recover through their historical workspace value. */
    directory: z.string().optional(),
    workspace: z.string(),
    readable: z.array(z.string()),
    writable: z.array(z.string()),
    sandbox: z.object({
      enabled: z.boolean(),
      network: z.enum(["allow", "deny"]),
      allowWrite: z.array(z.string()),
      onUnavailable: z.enum(["warn", "error", "allow"]),
      backend: z.enum(["seatbelt", "bubblewrap", "none"]),
      available: z.boolean(),
      enforced: z.boolean(),
    }),
    remediation: ProjectTrust.Status.shape.remediation,
  })
  export type Decision = z.infer<typeof Decision>

  export const DeniedError = NamedError.create("ExecutionAuthorityDeniedError", Decision)

  export async function decide(input: {
    projectID?: string
    sessionID: string
    capability: Capability
  }): Promise<Decision> {
    if (input.projectID !== undefined && input.projectID !== Instance.project.id) {
      throw new Project.MismatchError({
        projectID: input.projectID,
        directory: Instance.directory,
      })
    }

    const [trust, filesystem, policy] = await Promise.all([
      ProjectTrust.status(Instance.project),
      SessionFilesystem.snapshot(input.sessionID),
      Config.trustedSandbox(),
    ])
    const backend = Sandbox.describe()
    const sandbox = {
      enabled: policy.enabled ?? true,
      network: policy.network ?? "deny",
      allowWrite: policy.allowWrite ?? [],
      onUnavailable: policy.onUnavailable ?? "error",
      backend: backend.backend,
      available: backend.available,
      enforced: (policy.enabled ?? true) && backend.available,
    }
    const untrusted = !trust.canExecuteProjectCode
    const unavailable = sandbox.enabled && !sandbox.available && sandbox.onUnavailable === "error"
    const reason = untrusted ? "project_untrusted" : unavailable ? "sandbox_unavailable" : "allowed"
    const mode = untrusted || unavailable ? "read_only" : sandbox.enabled ? "sandboxed" : "host"
    const [readable, writable, workspace] = await Promise.all([
      SessionFilesystem.processReadRoots(input.sessionID),
      SessionFilesystem.processWriteRoots(input.sessionID),
      SessionFilesystem.workspace(input.sessionID),
    ])
    const generation = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          projectID: Instance.project.id,
          sessionID: input.sessionID,
          trustRevision: trust.revision,
          grantRevision: filesystem.revision,
          sandbox,
        }),
      )
      .digest("hex")

    return {
      allowed: reason === "allowed",
      reason,
      capability: input.capability,
      mode,
      projectID: Instance.project.id,
      sessionID: input.sessionID,
      trustRevision: trust.revision,
      grantRevision: filesystem.revision,
      generation,
      directory: Instance.directory,
      workspace,
      readable,
      writable,
      sandbox,
      remediation: trust.remediation,
    }
  }

  export async function require(input: {
    projectID?: string
    sessionID: string
    capability: Capability
  }): Promise<Decision> {
    const result = await decide(input)
    if (result.allowed) return result
    throw new DeniedError(result)
  }
}
