import crypto from "node:crypto"
import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Config } from "@/config/config"
import { Sandbox } from "@/sandbox/sandbox"
import { Storage } from "@/storage/storage"
import { AuthoritySignal } from "./authority-signal"
import { Project } from "./project"
import { ProjectTrust } from "./trust"

/**
 * Project-scoped action access.
 *
 * The previous GUI derived its three choices from project trust plus the
 * machine-wide sandbox switch. Changing one project's selector therefore
 * changed every other project. This record makes the user's choice atomic and
 * project-owned while retaining the global/managed sandbox fields as policy.
 */
export namespace ProjectAccess {
  export const Mode = z.enum(["ask", "approve", "full"])
  export type Mode = z.infer<typeof Mode>

  const Record = z.object({
    projectID: z.string(),
    root: z.string(),
    revision: z.number().int().positive(),
    mode: Mode,
    time: z.object({ updated: z.number().int().positive() }),
  })

  export const Status = z.object({
    projectID: z.string(),
    root: z.string(),
    revision: z.number().int().positive(),
    trustRevision: z.number().int().positive(),
    mode: Mode,
    requestedMode: Mode,
    source: z.enum(["default", "legacy", "persisted"]),
    trusted: z.boolean(),
    managed: z.boolean(),
    sandbox: Config.Sandbox.extend({
      enabled: z.boolean(),
      network: z.enum(["allow", "deny"]),
      allowWrite: z.array(z.string()),
      onUnavailable: z.enum(["warn", "error", "allow"]),
      requireProjectTrust: z.boolean(),
    }),
    sandboxStatus: z.object({
      available: z.boolean(),
      backend: z.enum(["seatbelt", "bubblewrap", "none"]),
      reason: z.string().optional(),
    }),
  })
  export type Status = z.infer<typeof Status>

  export const Update = z.object({
    mode: Mode,
    root: z.string().optional(),
  })
  export type Update = z.infer<typeof Update>

  export const Event = {
    Changed: BusEvent.define(
      "project.access.changed",
      z.object({
        status: Status,
      }),
    ),
  }

  function root(project: Project.Info) {
    return Project.canonicalize(project.worktree)
  }

  function key(project: Project.Info) {
    const canonical = root(project)
    const digest = crypto.createHash("sha256").update(canonical).digest("hex")
    return ["project_access", project.id, digest]
  }

  async function record(project: Project.Info) {
    return Storage.read<z.infer<typeof Record>>(key(project))
      .then((value) => Record.parse(value))
      .catch((error) => {
        if (Storage.NotFoundError.isInstance(error)) return undefined
        throw error
      })
  }

  export async function status(project: Project.Info): Promise<Status> {
    const [saved, trust, sandboxPolicy] = await Promise.all([
      record(project),
      ProjectTrust.status(project),
      Config.trustedSandboxPolicy(),
    ])
    const canonical = root(project)
    const legacy = !trust.canExecuteProjectCode ? "ask" : sandboxPolicy.config.enabled === false ? "full" : "approve"
    const requestedMode = saved?.root === canonical ? saved.mode : legacy
    const managed = requestedMode === "full" && sandboxPolicy.managed.enabled === true
    const mode = !trust.canExecuteProjectCode ? "ask" : managed ? "approve" : requestedMode
    const sandbox = {
      ...sandboxPolicy.config,
      enabled: mode !== "full",
      network: sandboxPolicy.config.network ?? "deny",
      allowWrite: sandboxPolicy.config.allowWrite ?? [],
      onUnavailable: sandboxPolicy.config.onUnavailable ?? "error",
      requireProjectTrust: sandboxPolicy.config.requireProjectTrust ?? false,
    }
    const backend = Sandbox.describe()
    return {
      projectID: project.id,
      root: canonical,
      revision: saved?.revision ?? 1,
      trustRevision: trust.revision,
      mode,
      requestedMode,
      source: saved ? "persisted" : sandboxPolicy.config.enabled === false ? "legacy" : "default",
      trusted: trust.canExecuteProjectCode,
      managed,
      sandbox,
      sandboxStatus: {
        available: backend.available,
        backend: backend.backend,
        reason: backend.reason,
      },
    }
  }

  export async function update(project: Project.Info, input: Update): Promise<Status> {
    const parsed = Update.parse(input)
    const canonical = root(project)

    // Establish trust before widening access. ProjectTrust validates the
    // canonical root, so a stale tab cannot grant a different checkout.
    if (parsed.mode !== "ask") {
      await ProjectTrust.update(project, {
        trusted: true,
        root: parsed.root ?? "",
      })
    }

    const result = await AuthoritySignal.exclusive(async () => {
      let changed = false
      await Storage.upsert<z.infer<typeof Record>>(key(project), (raw) => {
        const previous = raw ? Record.parse(raw) : undefined
        if (previous?.root === canonical && previous.mode === parsed.mode) return previous
        changed = true
        return {
          projectID: project.id,
          root: canonical,
          revision: (previous?.revision ?? 1) + 1,
          mode: parsed.mode,
          time: { updated: Date.now() },
        }
      })
      const next = await status(project)
      if (!changed) {
        const pending = await AuthoritySignal.pending({ kind: "access", projectID: project.id, mode: parsed.mode })
        if (!pending) return next
        await Bus.publish(Event.Changed, { status: next })
        await AuthoritySignal.settle(pending)
        return next
      }
      const signal = await AuthoritySignal.publish({ kind: "access", projectID: project.id, mode: parsed.mode })
      await Bus.publish(Event.Changed, { status: next })
      await AuthoritySignal.settle(signal.revision)
      return next
    })

    // Revocation happens after the restrictive access record is durable and
    // all processes using the previous authority have been reaped.
    if (parsed.mode === "ask") await ProjectTrust.update(project, { trusted: false })
    return status(project).then((value) => ({ ...value, revision: Math.max(value.revision, result.revision) }))
  }
}
