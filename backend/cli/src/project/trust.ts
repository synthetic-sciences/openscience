import crypto from "crypto"
import z from "zod"
import { NamedError } from "@synsci/util/error"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import { Storage } from "../storage/storage"
import { Project } from "./project"

export namespace ProjectTrust {
  export const Capability = z.enum([
    "config_dependency_install",
    "project_plugin",
    "project_skill",
    "project_mcp",
    "project_formatter",
    "project_lsp",
    "provider_token_command",
    "provider_module",
    "startup_script",
    "terminal",
    "kernel",
    "shell",
    "local_job",
    "remote_job",
    "package_install",
  ])
  export type Capability = z.infer<typeof Capability>

  const Record = z.object({
    projectID: z.string(),
    root: z.string(),
    revision: z.number().int().positive().default(1),
    state: z.enum(["trusted", "revoked"]),
    time: z.object({
      updated: z.number(),
      trusted: z.number().optional(),
      revoked: z.number().optional(),
    }),
  })

  const Remediation = z.object({
    code: z.literal("trust_project_required"),
    message: z.string(),
    method: z.literal("PUT"),
    path: z.string(),
    body: z.object({
      trusted: z.literal(true),
      root: z.string(),
    }),
  })

  export const Status = z.object({
    projectID: z.string(),
    root: z.string(),
    revision: z.number().int().positive(),
    state: z.enum(["trusted", "untrusted", "revoked"]),
    source: z.enum(["default", "persisted"]),
    canExecuteProjectCode: z.boolean(),
    time: z
      .object({
        updated: z.number(),
        trusted: z.number().optional(),
        revoked: z.number().optional(),
      })
      .optional(),
    remediation: Remediation.optional(),
  })
  export type Status = z.infer<typeof Status>

  export const Update = z.discriminatedUnion("trusted", [
    z.object({
      trusted: z.literal(true),
      root: z.string().describe("Canonical root returned by the trust status endpoint"),
    }),
    z.object({
      trusted: z.literal(false),
    }),
  ])
  export type Update = z.infer<typeof Update>

  export const Event = {
    Changed: BusEvent.define(
      "project.trust.changed",
      z.object({
        status: Status,
      }),
    ),
  }

  export const RootMismatchError = NamedError.create(
    "ProjectTrustRootMismatchError",
    z.object({
      projectID: z.string(),
      expected: z.string(),
      received: z.string(),
    }),
  )

  export const DeniedError = NamedError.create(
    "ProjectTrustDeniedError",
    z.object({
      projectID: z.string(),
      root: z.string(),
      capability: Capability,
      remediation: Remediation,
    }),
  )

  function root(project: Project.Info) {
    return Project.canonicalize(project.worktree)
  }

  function key(project: Project.Info) {
    const canonical = root(project)
    const digest = crypto.createHash("sha256").update(canonical).digest("hex")
    return ["project_trust", project.id, digest]
  }

  function remediation(project: Project.Info) {
    const canonical = root(project)
    return {
      code: "trust_project_required" as const,
      message:
        "Review this project's local configuration and code before allowing plugins, skills, MCP servers, formatters, LSP commands, provider token commands or modules, dependency installation, or startup scripts.",
      method: "PUT" as const,
      path: `/project/${project.id}/trust`,
      body: {
        trusted: true as const,
        root: canonical,
      },
    }
  }

  async function record(project: Project.Info) {
    return Storage.read<z.infer<typeof Record>>(key(project))
      .then((value) => Record.parse(value))
      .catch(() => undefined)
  }

  export async function status(project: Project.Info): Promise<Status> {
    const canonical = root(project)
    const saved = await record(project)
    if (saved?.root !== canonical || saved.state !== "revoked") {
      return {
        projectID: project.id,
        root: canonical,
        revision: saved?.revision ?? 1,
        state: "trusted",
        source: saved ? "persisted" : "default",
        canExecuteProjectCode: true,
        time: saved?.time,
      }
    }
    return {
      projectID: project.id,
      root: canonical,
      revision: saved?.revision ?? 1,
      state: "revoked",
      source: "persisted",
      canExecuteProjectCode: false,
      time: saved?.time,
      remediation: remediation(project),
    }
  }

  export async function allowed(project: Project.Info) {
    return status(project).then((value) => value.canExecuteProjectCode)
  }

  export async function update(project: Project.Info, input: Update): Promise<Status> {
    const canonical = root(project)
    const previous = await record(project)
    const now = Date.now()
    const revision = (previous?.revision ?? 1) + 1
    if (input.trusted) {
      const received = Project.canonicalize(input.root)
      if (received !== canonical) {
        throw new RootMismatchError({
          projectID: project.id,
          expected: canonical,
          received,
        })
      }
      await Storage.write<z.infer<typeof Record>>(key(project), {
        projectID: project.id,
        root: canonical,
        revision,
        state: "trusted",
        time: {
          updated: now,
          trusted: now,
          revoked: previous?.time.revoked,
        },
      })
      const result = await status(project)
      await Bus.publish(Event.Changed, { status: result })
      return result
    }

    await Storage.write<z.infer<typeof Record>>(key(project), {
      projectID: project.id,
      root: canonical,
      revision,
      state: "revoked",
      time: {
        updated: now,
        trusted: previous?.time.trusted,
        revoked: now,
      },
    })
    const result = await status(project)
    await Bus.publish(Event.Changed, { status: result })
    return result
  }

  export async function require(project: Project.Info, capability: Capability) {
    if (await allowed(project)) return
    throw new DeniedError({
      projectID: project.id,
      root: root(project),
      capability,
      remediation: remediation(project),
    })
  }
}
