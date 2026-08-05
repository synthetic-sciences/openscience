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

  const state = Instance.state(async () => {
    const project = await Storage.read<Standing[]>(projectKey()).catch(() => [] as Standing[])
    const global = await Storage.read<Standing[]>(GLOBAL_KEY).catch(() => [] as Standing[])

    const pending: Record<
      string,
      {
        info: Request
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
  })

  type State = Awaited<ReturnType<typeof state>>

  function asRules(entries: Standing[]): Ruleset {
    return entries.map((entry) => ({ permission: entry.permission, pattern: entry.pattern, action: "allow" as const }))
  }

  /** Every approval rule that applies to one session: global, then project,
   *  then conversation grants. Later entries win in evaluate(). */
  function approvals(s: State, sessionID: string): Ruleset {
    return merge(asRules(s.standing.global), asRules(s.standing.project), s.session[sessionID] ?? [])
  }

  // Paid actions never inherit an allow through wildcard matching. Modal is
  // stricter: every dispatch requires its own exact-plan card, so no stored or
  // configured allow rule can bypass the prompt. Deny rules remain applicable.
  const SPEND = ["atlas", "websearch", "modal"]

  function spendFilter(permission: string, rules: Ruleset): Ruleset {
    if (!SPEND.includes(permission)) return rules
    if (permission === "modal") return rules.filter((rule) => rule.action !== "allow")
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
    }),
    async (input) => {
      const s = await state()
      const { ruleset, ...request } = input
      const rules = spendFilter(request.permission, merge(ruleset, approvals(s, request.sessionID)))
      const evaluated = (request.patterns ?? []).map((pattern) => {
        const rule = evaluate(request.permission, pattern, rules)
        log.info("evaluated", { permission: request.permission, pattern, action: rule })
        return rule
      })
      const denied = evaluated.find((rule) => rule.action === "deny")
      if (denied) throw new DeniedError(ruleset.filter((r) => Wildcard.match(request.permission, r.permission)))
      if (request.permission === "external_directory" && (await filesystem(request))) return
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

  const EDIT_TOOLS = ["edit", "write", "patch", "multiedit"]

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
