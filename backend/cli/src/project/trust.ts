import crypto from "crypto"
import z from "zod"
import { NamedError } from "@synsci/util/error"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import { Storage } from "../storage/storage"
import { Project } from "./project"
import { AuthoritySignal } from "./authority-signal"

export namespace ProjectTrust {
  export const Capability = z.enum([
    "config_dependency_install",
    "project_plugin",
    "project_skill",
    "project_mcp",
    "project_formatter",
    "project_lsp",
    "publication_export",
    "provider_token_command",
    "provider_module",
    "startup_script",
    "terminal",
    "kernel",
    "shell",
    "local_job",
    "remote_job",
    "package_install",
    "repository",
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
        "Review this project's local configuration and code before allowing plugins, skills, MCP servers, formatters, LSP commands, publication exporters, provider token commands or modules, dependency installation, repository commands, or startup scripts.",
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
    if (!saved || saved.root !== canonical) {
      return {
        projectID: project.id,
        root: canonical,
        revision: saved?.revision ?? 1,
        state: "untrusted",
        source: saved ? "persisted" : "default",
        canExecuteProjectCode: false,
        time: saved?.time,
        remediation: remediation(project),
      }
    }
    if (saved.state === "trusted") {
      return {
        projectID: project.id,
        root: canonical,
        revision: saved.revision,
        state: "trusted",
        source: "persisted",
        canExecuteProjectCode: true,
        time: saved.time,
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
    return AuthoritySignal.exclusive(async () => {
      const canonical = root(project)
      const now = Date.now()
      if (input.trusted) {
        const received = Project.canonicalize(input.root)
        if (received !== canonical) {
          throw new RootMismatchError({
            projectID: project.id,
            expected: canonical,
            received,
          })
        }
        let changed = false
        await Storage.upsert<z.infer<typeof Record>>(key(project), (raw) => {
          const previous = raw ? Record.parse(raw) : undefined
          if (previous?.root === canonical && previous.state === "trusted") return previous
          changed = true
          return {
            projectID: project.id,
            root: canonical,
            revision: (previous?.revision ?? 1) + 1,
            state: "trusted",
            time: {
              updated: now,
              trusted: now,
              revoked: previous?.time.revoked,
            },
          }
        })
        const result = await status(project)
        if (!changed) {
          const revision = await AuthoritySignal.pending({ kind: "trust", projectID: project.id, denied: false })
          if (!revision) return result
          await Bus.publish(Event.Changed, { status: result })
          await AuthoritySignal.settle(revision)
          return result
        }
        const signal = await AuthoritySignal.publish({ kind: "trust", projectID: project.id, denied: false })
        await Bus.publish(Event.Changed, { status: result })
        await AuthoritySignal.settle(signal.revision)
        return result
      }

      let changed = false
      await Storage.upsert<z.infer<typeof Record>>(key(project), (raw) => {
        const previous = raw ? Record.parse(raw) : undefined
        if (previous?.root === canonical && previous.state === "revoked") return previous
        changed = true
        return {
          projectID: project.id,
          root: canonical,
          revision: (previous?.revision ?? 1) + 1,
          state: "revoked",
          time: {
            updated: now,
            trusted: previous?.time.trusted,
            revoked: now,
          },
        }
      })
      const result = await status(project)
      if (!changed) {
        const revision = await AuthoritySignal.pending({ kind: "trust", projectID: project.id, denied: true })
        if (!revision) return result
        await Bus.publish(Event.Changed, { status: result })
        await AuthoritySignal.settle(revision)
        return result
      }
      const signal = await AuthoritySignal.publish({ kind: "trust", projectID: project.id, denied: true })
      await Bus.publish(Event.Changed, { status: result })
      await AuthoritySignal.settle(signal.revision)
      return result
    })
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
