import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Config } from "@/config/config"
import { Identifier } from "@/id/id"
import { Instance } from "@/project/instance"
import { Storage } from "@/storage/storage"
import { fn } from "@/util/fn"
import { Log } from "@/util/log"
import { Wildcard } from "@/util/wildcard"
import os from "os"
import z from "zod"
import { SessionFilesystem } from "@/session/filesystem"
import { KernelRuntime } from "@/science/kernel/registry"
import { Network } from "@/settings/network"
import { SessionTraceStore } from "@/session/trace-store"
import { ProjectTrust } from "@/project/trust"
import { ProjectAccess } from "@/project/access"
import { ShellRisk } from "./shell-risk"

export namespace PermissionNext {
  const log = Log.create({ service: "permission" })

  function expand(pattern: string): string {
    if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
    if (pattern === "~") return os.homedir()
    if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
    if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
    return pattern
  }

  export const Action = z.enum(["allow", "deny", "ask"]).meta({
    ref: "PermissionAction",
  })
  export type Action = z.infer<typeof Action>

  export const Risk = z.enum(["passive", "contained", "risky", "unknown"])
  export type Risk = z.infer<typeof Risk>

  const PASSIVE = new Set(["glob", "grep", "list", "question", "read", "skill", "todoread"])
  const CONTAINED = new Set([
    "artifact",
    "batch",
    "edit",
    "lsp",
    "plan_enter",
    "plan_exit",
    "planwrite",
    "provenance_record",
    "research_contract",
    "task",
    "todowrite",
  ])
  const RISKY = new Set([
    "atlas",
    "atlas_write",
    "codesearch",
    "compute_job",
    "doom_loop",
    "environment_mutation",
    "external_directory",
    "generate_image",
    "mcp",
    "modal",
    "network",
    "provider_compute",
    "remote_compute",
    "webfetch",
    "websearch",
  ])

  const ShellMetadata = z.object({
    shell: z.object({
      command: z.string().min(1),
    }),
  })

  export function risk(permission: string, metadata?: Record<string, unknown>): Risk {
    if (PASSIVE.has(permission)) return "passive"
    if (permission === "bash") {
      const parsed = ShellMetadata.safeParse(metadata)
      if (!parsed.success) return "unknown"
      return ShellRisk.classify(parsed.data.shell.command).level
    }
    if (CONTAINED.has(permission)) return "contained"
    if (RISKY.has(permission)) return "risky"
    return "unknown"
  }

  /**
   * Apply the project action mode after configured policy and durable grants.
   * A deny always wins. Ask always ignores every prior allow for actions that
   * can change state. Ask risky accepts an explicit user grant for a risky
   * boundary, but a config/session allow cannot silently weaken the mode.
   * Risky or ambiguous shell commands are an unbypassable Ask-risky floor;
   * standing approvals cannot turn a future destructive command into an
   * automatic action. Full access retains its explicit no-prompt shell
   * behavior, while unknown permission kinds remain fail-closed.
   */
  export function modeAction(input: {
    mode: ProjectAccess.Mode
    permission: string
    configured: Action
    granted: Action
    metadata?: Record<string, unknown>
  }): Action {
    if (input.configured === "deny") return "deny"
    const level = risk(input.permission, input.metadata)
    if (input.mode === "full" && input.permission === "bash") return input.configured
    if (level === "unknown") return "ask"
    if (input.mode === "ask" && level !== "passive") return "ask"
    if (input.mode === "approve" && input.permission === "bash" && level === "risky") return "ask"
    if (input.mode === "approve" && level === "risky") {
      return input.granted === "allow" ? "allow" : "ask"
    }
    if (input.configured === "ask" && input.granted === "allow") return "allow"
    return input.configured
  }

  export const Rule = z
    .object({
      permission: z.string(),
      pattern: z.string(),
      action: Action,
    })
    .meta({
      ref: "PermissionRule",
    })
  export type Rule = z.infer<typeof Rule>

  export const Ruleset = Rule.array().meta({
    ref: "PermissionRuleset",
  })
  export type Ruleset = z.infer<typeof Ruleset>

  export function fromConfig(permission: Config.Permission) {
    const ruleset: Ruleset = []
    for (const [key, value] of Object.entries(permission)) {
      if (typeof value === "string") {
        ruleset.push({
          permission: key,
          action: value,
          pattern: "*",
        })
        continue
      }
      ruleset.push(
        ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
      )
    }
    return ruleset
  }

  export function merge(...rulesets: Ruleset[]): Ruleset {
    return rulesets.flat()
  }

  export const Request = z
    .object({
      id: Identifier.schema("permission"),
      sessionID: Identifier.schema("session"),
      permission: z.string(),
      patterns: z.string().array(),
      metadata: z.record(z.string(), z.any()),
      always: z.string().array(),
      tool: z
        .object({
          messageID: z.string(),
          callID: z.string(),
        })
        .optional(),
    })
    .meta({
      ref: "PermissionRequest",
    })

  export type Request = z.infer<typeof Request>

  export const Reply = z.enum(["once", "session", "project", "always", "reject"])
  export type Reply = z.infer<typeof Reply>

  // A standing approval the user granted from a permission card. "project"
  // entries persist for every session of one project; "global" entries persist
  // machine-wide. Both survive restarts and are revocable from settings.
  export const StandingScope = z.enum(["project", "global"]).meta({ ref: "PermissionStandingScope" })
  export type StandingScope = z.infer<typeof StandingScope>

  export const Standing = z
    .object({
      id: z.string(),
      permission: z.string(),
      pattern: z.string(),
      scope: StandingScope,
      created: z.number(),
    })
    .meta({ ref: "PermissionStanding" })
  export type Standing = z.infer<typeof Standing>

  export const Event = {
    Asked: BusEvent.define("permission.asked", Request),
    Replied: BusEvent.define(
      "permission.replied",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
        reply: Reply,
      }),
    ),
  }

  const GLOBAL_KEY = ["permission-standing", "global"]
  const projectKey = () => ["permission-standing", Instance.project.id]

  const state = Instance.state(
    async () => {
      const project = await Storage.read<Standing[]>(projectKey()).catch(() => [] as Standing[])
      const global = await Storage.read<Standing[]>(GLOBAL_KEY).catch(() => [] as Standing[])

      const pending: Record<
        string,
        {
          info: Request
          mode?: ProjectAccess.Mode
          resolve: () => void
          reject: (e: any) => void
          trace: Promise<void>
        }
      > = {}

      return {
        pending,
        standing: { project, global },
        // "Allow for this conversation" grants, keyed by sessionID. In-memory on
        // purpose: the scope ends with the conversation.
        session: {} as Record<string, Ruleset>,
      }
    },
    async (current) => {
      const traces: Promise<void>[] = []
      for (const [id, pending] of Object.entries(current.pending)) {
        delete current.pending[id]
        traces.push(pending.trace)
        pending.reject(new InstanceDisposedError())
      }
      await Promise.allSettled(traces)
    },
  )

  type State = Awaited<ReturnType<typeof state>>

  function asRules(entries: Standing[]): Ruleset {
    return entries.map((entry) => ({ permission: entry.permission, pattern: entry.pattern, action: "allow" as const }))
  }

  /** Every approval rule that applies to one session: global, then project,
   *  then conversation grants. Later entries win in evaluate(). */
  function approvals(s: State, sessionID: string): Ruleset {
    return merge(asRules(s.standing.global), asRules(s.standing.project), s.session[sessionID] ?? [])
  }

  // Paid actions and permanent environment mutations never inherit an allow
  // through wildcard matching. Compute and package changes may reuse only an
  // explicit approval for the exact immutable plan digest; broad configured
  // allows remain unable to authorize either boundary.
  const REMOTE_PLAN = new Set(["modal", "remote_compute"])
  const EXACT_PLAN = new Set([...REMOTE_PLAN, "environment_mutation"])
  const SPEND = ["atlas", "websearch", ...EXACT_PLAN]
  const PLAN_DIGEST = /^[a-f0-9]{64}$/

  function spendFilter(permission: string, rules: Ruleset): Ruleset {
    if (!SPEND.includes(permission)) return rules
    if (EXACT_PLAN.has(permission)) {
      return rules.filter((rule) => rule.action !== "allow" || PLAN_DIGEST.test(rule.pattern))
    }
    return rules.filter((rule) => rule.action !== "allow" || rule.permission === permission)
  }

  async function persist(s: State) {
    await Storage.write(projectKey(), s.standing.project)
    await Storage.write(GLOBAL_KEY, s.standing.global)
  }

  const FilesystemMetadata = z.object({
    filesystem: z.object({
      path: z.string(),
      access: SessionFilesystem.Access,
    }),
  })

  const NetworkMetadata = z.object({
    network: z.object({
      host: z.string(),
    }),
  })

  async function materialize(request: Omit<Request, "id"> | Request, scope: SessionFilesystem.Scope) {
    if (request.permission !== "external_directory") return
    const parsed = FilesystemMetadata.safeParse(request.metadata)
    if (!parsed.success) return
    await SessionFilesystem.grant({
      sessionID: request.sessionID,
      path: parsed.data.filesystem.path,
      access: parsed.data.filesystem.access,
      scope,
      source: "permission",
    })
    await KernelRuntime.releaseSession(request.sessionID)
  }

  async function filesystem(request: Omit<Request, "id"> | Request) {
    if (request.permission !== "external_directory") return false
    const parsed = FilesystemMetadata.safeParse(request.metadata)
    if (!parsed.success) return false
    return SessionFilesystem.allows({
      sessionID: request.sessionID,
      path: parsed.data.filesystem.path,
      access: parsed.data.filesystem.access,
    }).catch((error) => {
      if (SessionFilesystem.DeniedError.isInstance(error)) return false
      if (SessionFilesystem.InvalidPathError.isInstance(error)) return false
      throw error
    })
  }

  export const ask = fn(
    Request.partial({ id: true }).extend({
      ruleset: Ruleset,
      mode: ProjectAccess.Mode.optional(),
    }),
    async (input) => {
      const s = await state()
      const { ruleset, mode, ...request } = input
      const filesystemRequest =
        request.permission === "external_directory" ? FilesystemMetadata.safeParse(request.metadata) : undefined
      if (
        filesystemRequest?.success &&
        filesystemRequest.data.filesystem.access === "write" &&
        (await SessionFilesystem.restrictsWrite({
          sessionID: request.sessionID,
          path: filesystemRequest.data.filesystem.path,
        }))
      ) {
        throw new SessionFilesystem.DeniedError({
          sessionID: request.sessionID,
          path: filesystemRequest.data.filesystem.path,
          access: "write",
        })
      }
      // Configured agent/tool policy is not a user approval. In an untrusted
      // clone it may never silently turn an external path request into a grant;
      // explicit standing approvals and already-materialized filesystem grants
      // remain separate, auditable user decisions.
      const configured =
        request.permission === "external_directory" && !(await ProjectTrust.allowed(Instance.project))
          ? ruleset.filter((rule) => !(rule.action === "allow" && Wildcard.match(request.permission, rule.permission)))
          : ruleset
      const granted = approvals(s, request.sessionID)
      const policy = REMOTE_PLAN.has(request.permission)
        ? configured.filter((rule) => rule.action !== "allow")
        : spendFilter(request.permission, configured)
      const rules = REMOTE_PLAN.has(request.permission)
        ? merge(
            configured.filter((rule) => rule.action !== "allow"),
            spendFilter(request.permission, granted),
          )
        : spendFilter(request.permission, merge(configured, granted))
      const approved = spendFilter(request.permission, granted)
      const evaluated = (request.patterns ?? []).map((pattern) => {
        const base = evaluate(request.permission, pattern, rules)
        const rule = {
          ...base,
          action: mode
            ? modeAction({
                mode,
                permission: request.permission,
                configured: evaluate(request.permission, pattern, policy).action,
                granted: evaluate(request.permission, pattern, approved).action,
                metadata: request.metadata,
              })
            : base.action,
        }
        log.info("evaluated", { permission: request.permission, pattern, action: rule })
        return rule
      })
      const denied = evaluated.find((rule) => rule.action === "deny")
      if (denied) throw new DeniedError(ruleset.filter((r) => Wildcard.match(request.permission, r.permission)))
      if (mode !== "ask" && request.permission === "external_directory" && (await filesystem(request))) return
      if (evaluated.some((rule) => rule.action === "ask")) {
        const id = input.id ?? Identifier.ascending("permission")
        const info: Request = {
          id,
          ...request,
        }
        const trace = SessionTraceStore.approvalAsked(info)
        return new Promise<void>((resolve, reject) => {
          s.pending[id] = {
            info,
            mode,
            resolve,
            reject,
            trace,
          }
          Bus.publish(Event.Asked, info)
        })
      }
      await materialize(request, "session")
    },
  )

  /** Resolve any other pending request the newly granted approvals now cover. */
  async function settle(s: State, reply: Reply) {
    for (const [id, pending] of Object.entries(s.pending)) {
      if (pending.mode === "ask") continue
      if (
        pending.mode === "approve" &&
        pending.info.permission === "bash" &&
        risk(pending.info.permission, pending.info.metadata) !== "contained"
      ) {
        continue
      }
      const ok =
        (await filesystem(pending.info)) ||
        (pending.info.patterns.length > 0 &&
          pending.info.patterns.every(
            (pattern) =>
              evaluate(
                pending.info.permission,
                pattern,
                spendFilter(pending.info.permission, approvals(s, pending.info.sessionID)),
              ).action === "allow",
          ))
      if (!ok) continue
      delete s.pending[id]
      await pending.trace
      await SessionTraceStore.approvalReplied({
        sessionID: pending.info.sessionID,
        requestID: pending.info.id,
        reply,
      })
      Bus.publish(Event.Replied, {
        sessionID: pending.info.sessionID,
        requestID: pending.info.id,
        reply,
      })
      pending.resolve()
    }
  }

  export const reply = fn(
    z.object({
      requestID: Identifier.schema("permission"),
      reply: Reply,
      message: z.string().optional(),
    }),
    async (input) => {
      const s = await state()
      const existing = s.pending[input.requestID]
      if (!existing) return
      delete s.pending[input.requestID]
      await existing.trace
      await SessionTraceStore.approvalReplied({
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })
      Bus.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })
      if (input.reply === "reject") {
        existing.reject(input.message ? new CorrectedError(input.message) : new RejectedError())
        // Reject all other pending permissions for this session
        const sessionID = existing.info.sessionID
        for (const [id, pending] of Object.entries(s.pending)) {
          if (pending.info.sessionID === sessionID) {
            delete s.pending[id]
            await pending.trace
            await SessionTraceStore.approvalReplied({
              sessionID: pending.info.sessionID,
              requestID: pending.info.id,
              reply: "reject",
            })
            Bus.publish(Event.Replied, {
              sessionID: pending.info.sessionID,
              requestID: pending.info.id,
              reply: "reject",
            })
            pending.reject(new RejectedError())
          }
        }
        return
      }
      if (input.reply === "once") {
        await materialize(existing.info, "once").catch((error) => {
          existing.reject(error)
          throw error
        })
        existing.resolve()
        return
      }
      if (input.reply === "session") {
        if (existing.info.permission !== "external_directory") {
          const rules = existing.info.always.map((pattern) => ({
            permission: existing.info.permission,
            pattern,
            action: "allow" as const,
          }))
          s.session[existing.info.sessionID] = merge(s.session[existing.info.sessionID] ?? [], rules)
        }
        await materialize(existing.info, "session").catch((error) => {
          existing.reject(error)
          throw error
        })
        existing.resolve()
        await settle(s, input.reply)
        return
      }
      // "project" persists for this project; "always" persists machine-wide.
      const scope: StandingScope = input.reply === "always" ? "global" : "project"
      // A machine-wide network approval lands in the Network allow-list so the
      // settings panel shows exactly what was granted — no shadow store.
      const network = input.reply === "always" ? NetworkMetadata.safeParse(existing.info.metadata) : undefined
      if (existing.info.permission === "network" && network?.success) {
        await Network.allow(network.data.network.host).catch((error) => {
          existing.reject(error)
          throw error
        })
      } else if (existing.info.permission !== "external_directory") {
        for (const pattern of existing.info.always) {
          const entry: Standing = {
            id: Identifier.ascending("permission"),
            permission: existing.info.permission,
            pattern,
            scope,
            created: Date.now(),
          }
          if (scope === "global") s.standing.global.push(entry)
          if (scope === "project") s.standing.project.push(entry)
        }
        await persist(s)
      }

      await materialize(existing.info, input.reply === "always" ? "installation" : "project").catch((error) => {
        existing.reject(error)
        throw error
      })
      existing.resolve()
      await settle(s, input.reply)
    },
  )

  /** Standing approvals for the current project plus the machine-wide ones. */
  export async function standing(): Promise<Standing[]> {
    const s = await state()
    return [...s.standing.global, ...s.standing.project]
  }

  export const revoke = fn(z.object({ id: z.string() }), async (input) => {
    const s = await state()
    const before = s.standing.global.length + s.standing.project.length
    s.standing.global = s.standing.global.filter((entry) => entry.id !== input.id)
    s.standing.project = s.standing.project.filter((entry) => entry.id !== input.id)
    if (s.standing.global.length + s.standing.project.length === before) return false
    await persist(s)
    return true
  })

  export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Rule {
    const merged = merge(...rulesets)
    log.info("evaluate", { permission, pattern, ruleset: merged })
    const match = merged.findLast(
      (rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern),
    )
    return match ?? { action: "ask", permission, pattern: "*" }
  }

  const EDIT_TOOLS = ["edit", "write", "patch", "apply_patch", "multiedit"]

  export function disabled(tools: string[], ruleset: Ruleset): Set<string> {
    const result = new Set<string>()
    for (const tool of tools) {
      const permission = EDIT_TOOLS.includes(tool) ? "edit" : tool

      const rule = ruleset.findLast((r) => Wildcard.match(permission, r.permission))
      if (!rule) continue
      if (rule.pattern === "*" && rule.action === "deny") result.add(tool)
    }
    return result
  }

  /** User rejected without message - halts execution */
  export class RejectedError extends Error {
    constructor() {
      super(`The user rejected permission to use this specific tool call.`)
    }
  }

  /** User rejected with message - continues with guidance */
  export class CorrectedError extends Error {
    constructor(message: string) {
      super(`The user rejected permission to use this specific tool call with the following feedback: ${message}`)
    }
  }

  /** A genuine server/project shutdown ended an unresolved approval. */
  export class InstanceDisposedError extends Error {
    constructor() {
      super("The permission request ended because the project runtime was closed.")
    }
  }

  /** Auto-rejected by config rule - halts execution */
  export class DeniedError extends Error {
    constructor(public readonly ruleset: Ruleset) {
      super(
        `The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ${JSON.stringify(ruleset)}`,
      )
    }
  }

  export async function list() {
    return state().then((x) => Object.values(x.pending).map((x) => x.info))
  }
}
