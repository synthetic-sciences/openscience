import crypto from "crypto"
import z from "zod"
import { NamedError } from "@synsci/util/error"
import { Sandbox } from "@/sandbox/sandbox"
import { SessionFilesystem } from "@/session/filesystem"
import { Instance } from "./instance"
import { Project } from "./project"
import { ProjectTrust } from "./trust"
import { ProjectAccess } from "./access"
import { Vcs } from "./vcs"

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
    "publication_export",
  ])
  export type Capability = z.infer<typeof Capability>

  export const Decision = z.object({
    allowed: z.boolean(),
    reason: z.enum(["allowed", "project_untrusted", "sandbox_unavailable"]),
    message: z.string().optional(),
    capability: Capability,
    mode: z.enum(["read_only", "sandboxed", "host"]),
    projectID: z.string(),
    sessionID: z.string(),
    trustRevision: z.number().int().positive(),
    accessRevision: z.number().int().positive().default(1),
    accessMode: ProjectAccess.Mode.default("approve"),
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
      requireProjectTrust: z.boolean().default(false),
      backend: z.enum(["seatbelt", "bubblewrap", "none"]),
      available: z.boolean(),
      enforced: z.boolean(),
    }),
    remediation: ProjectTrust.Status.shape.remediation,
  })
  export type Decision = z.infer<typeof Decision>

  const BaseDeniedError = NamedError.create("ExecutionAuthorityDeniedError", Decision)

  export class DeniedError extends BaseDeniedError {
    constructor(data: z.input<typeof Decision>, options?: ErrorOptions) {
      super(data, options)
      if (data.message) this.message = data.message
    }
  }

  const routine = new Set<Capability>(["terminal", "kernel", "shell", "local_job"])

  function action(capability: Capability) {
    switch (capability) {
      case "terminal":
        return "start a terminal"
      case "kernel":
        return "start a kernel"
      case "shell":
        return "run a shell command"
      case "local_job":
        return "dispatch a local compute job"
      case "remote_job":
        return "dispatch a remote compute job"
      case "package_install":
        return "install packages"
      case "project_plugin":
        return "start a project plugin"
      case "project_mcp":
        return "start a project MCP server"
      case "project_formatter":
        return "start a project formatter"
      case "project_lsp":
        return "start a project language server"
      case "provider_token_command":
        return "run a provider token command"
      case "publication_export":
        return "export a publication with local conversion tools"
    }
  }

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

    const [trust, access, filesystem, metadata] = await Promise.all([
      ProjectTrust.status(Instance.project),
      ProjectAccess.status(Instance.project),
      SessionFilesystem.snapshot(input.sessionID),
      Vcs.metadataRoot(),
    ])
    const backend = Sandbox.describe()
    const sandbox = {
      enabled: access.sandbox.enabled,
      network: access.sandbox.network,
      allowWrite: access.sandbox.allowWrite,
      onUnavailable: access.sandbox.onUnavailable,
      requireProjectTrust: access.sandbox.requireProjectTrust,
      backend: backend.backend,
      available: backend.available,
      enforced: access.sandbox.enabled && backend.available,
    }
    const unavailable = sandbox.enabled && !sandbox.available && sandbox.onUnavailable === "error"
    const untrusted = !trust.canExecuteProjectCode
    const needsTrust = sandbox.requireProjectTrust || !routine.has(input.capability) || !sandbox.enforced
    const reason = unavailable ? "sandbox_unavailable" : untrusted && needsTrust ? "project_untrusted" : "allowed"
    const mode = reason !== "allowed" ? "read_only" : sandbox.enforced ? "sandboxed" : "host"
    const message =
      reason === "sandbox_unavailable"
        ? `A verified OS sandbox is required to ${action(input.capability)}, but OpenScience could not enforce one (${backend.reason}). Install the platform sandbox backend or update the global Sandbox settings.`
        : reason === "project_untrusted"
          ? sandbox.requireProjectTrust
            ? `Trust this project to ${action(input.capability)} because the global Sandbox policy requires explicit trust for all execution.`
            : !routine.has(input.capability)
              ? `Trust this project to ${action(input.capability)}. This operation is not eligible for trust-free sandboxed execution.`
              : `Trust this project to ${action(input.capability)} without an enforced OS sandbox, or enable a working sandbox backend first.`
          : undefined
    const [readable, writable, workspace] = await Promise.all([
      SessionFilesystem.processReadRoots(input.sessionID),
      SessionFilesystem.processWriteRoots(input.sessionID),
      SessionFilesystem.workspace(input.sessionID),
    ])
    // Project files are the durable, first-party workspace advertised to the
    // model and already treated as internal by brokered file tools. Managed
    // projects intentionally keep session scratch elsewhere, so their root is
    // not represented by a persisted external-directory grant. Include only
    // the exact project roots here; arbitrary host paths still require an
    // explicit directional filesystem grant.
    const projectRoots = [Instance.directory, Instance.worktree]
    const processReadable = [...new Set([...readable, ...projectRoots, ...(metadata ? [metadata] : [])])]
    const processWritable = [...new Set([...writable, ...projectRoots, ...(metadata ? [metadata] : [])])]
    const generation = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          projectID: Instance.project.id,
          sessionID: input.sessionID,
          trustRevision: trust.revision,
          accessRevision: access.revision,
          accessMode: access.mode,
          grantRevision: filesystem.revision,
          sandbox,
        }),
      )
      .digest("hex")

    return {
      allowed: reason === "allowed",
      reason,
      message,
      capability: input.capability,
      mode,
      projectID: Instance.project.id,
      sessionID: input.sessionID,
      trustRevision: trust.revision,
      accessRevision: access.revision,
      accessMode: access.mode,
      grantRevision: filesystem.revision,
      generation,
      directory: Instance.directory,
      workspace,
      readable: processReadable,
      writable: processWritable,
      sandbox,
      remediation: reason === "project_untrusted" ? trust.remediation : undefined,
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
