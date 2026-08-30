import { Slug } from "@synsci/util/slug"
import path from "path"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Decimal } from "decimal.js"
import z from "zod"
import { type LanguageModelUsage, type ProviderMetadata } from "ai"
import { Identifier } from "../id/id"
import { Installation } from "../installation"

import { Storage } from "../storage/storage"
import { createCoalescer } from "../storage/coalescer"
import { Log } from "../util/log"
import { MessageV2 } from "./message-v2"
import { Instance } from "../project/instance"
import { SessionPrompt } from "./prompt"
import { fn } from "@/util/fn"
import { Command } from "../command"
import { Snapshot } from "@/snapshot"

import type { Provider } from "@/provider/provider"
import { PermissionNext } from "@/permission/next"
import { Global } from "@/global"
import { KernelRuntime } from "@/science/kernel/registry"
import { Project } from "@/project/project"
import { NamedError } from "@synsci/util/error"
import { SessionFilesystem } from "./filesystem"
import { SessionTraceStore } from "./trace-store"
import { SessionResearch } from "./research"
import { AuthoritySignal } from "@/project/authority-signal"
import { FileLease } from "@/util/file-lease"
import { OutboundTelemetry } from "@/telemetry/outbound"

export namespace Session {
  const log = Log.create({ service: "session" })

  const parentTitlePrefix = "New session - "
  const childTitlePrefix = "Child session - "

  function createDefaultTitle(isChild = false) {
    if (!isChild) return "New session"
    return childTitlePrefix + new Date().toISOString()
  }

  export function isDefaultTitle(title: string) {
    if (title === "New session") return true
    return new RegExp(
      `^(${parentTitlePrefix}|${childTitlePrefix})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`,
    ).test(title)
  }

  function getForkedTitle(title: string): string {
    const match = title.match(/^(.+) \(fork #(\d+)\)$/)
    if (match) {
      const base = match[1]
      const num = parseInt(match[2], 10)
      return `${base} (fork #${num + 1})`
    }
    return `${title} (fork #1)`
  }

  export const Info = z
    .object({
      id: Identifier.schema("session"),
      slug: z.string(),
      projectID: z.string(),
      directory: z.string(),
      parentID: Identifier.schema("session").optional(),
      summary: z
        .object({
          additions: z.number(),
          deletions: z.number(),
          files: z.number(),
          diffs: Snapshot.FileDiff.array().optional(),
        })
        .optional(),
      share: z
        .object({
          url: z.string(),
        })
        .optional(),
      title: z.string(),
      version: z.string(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        compacting: z.number().optional(),
        archived: z.number().optional(),
        pinned: z.number().optional(),
      }),
      permission: PermissionNext.Ruleset.optional(),
      revert: z
        .object({
          messageID: z.string(),
          partID: z.string().optional(),
          snapshot: z.string().optional(),
          diff: z.string().optional(),
          turns: z.number().int().nonnegative().optional(),
          files: z.string().array().optional(),
        })
        .optional(),
    })
    .meta({
      ref: "Session",
    })
  export type Info = z.output<typeof Info>

  const Deletion = z.object({
    version: z.literal(1),
    info: Info,
    time: z.object({ created: z.number().int().positive() }),
  })
  type Deletion = z.output<typeof Deletion>

  const deletionKey = (projectID: string, sessionID: string) => ["session_delete", projectID, sessionID]
  const deletionLock = (projectID: string, sessionID: string) =>
    path.join(Global.Path.data, "session-delete", `${projectID}.${sessionID}.lock`)
  const creationLock = (projectID: string, sessionID: string) =>
    path.join(Global.Path.data, "session-create", `${projectID}.${sessionID}.lock`)

  async function deleting(projectID: string, sessionID: string) {
    return Storage.read<Deletion>(deletionKey(projectID, sessionID))
      .then((value) => Deletion.parse(value))
      .catch((error) => {
        if (Storage.NotFoundError.isInstance(error)) return undefined
        throw error
      })
  }

  export const DirectoryMismatchError = NamedError.create(
    "SessionDirectoryMismatchError",
    z.object({
      sessionID: Identifier.schema("session"),
      sessionDirectory: z.string(),
      instanceDirectory: z.string(),
    }),
  )

  export const DirectoryImmutableError = NamedError.create(
    "SessionDirectoryImmutableError",
    z.object({
      sessionID: Identifier.schema("session"),
      directory: z.string(),
    }),
  )

  export const DeletingError = NamedError.create(
    "SessionDeletingError",
    z.object({ sessionID: Identifier.schema("session") }),
  )

  const validated = Instance.state(() => new Set<string>())

  function current(session: Info) {
    return Project.canonicalize(session.directory) === Project.canonicalize(Instance.directory)
  }

  function bind(session: Info) {
    if (!current(session)) {
      throw new DirectoryMismatchError({
        sessionID: session.id,
        sessionDirectory: Project.canonicalize(session.directory),
        instanceDirectory: Project.canonicalize(Instance.directory),
      })
    }
    validated().add(session.id)
    return session
  }

  async function load(id: string) {
    return (await Storage.read<Info>(["session", Instance.project.id, id])) as Info
  }

  async function loadOptional(key: string[]) {
    return Storage.read<Info>(key).catch((error) => {
      if (Storage.NotFoundError.isInstance(error)) return
      throw error
    })
  }

  export async function assertDirectory(id: string) {
    if (validated().has(id)) return
    bind(await load(id))
  }

  export const ShareInfo = z
    .object({
      secret: z.string(),
      url: z.string(),
    })
    .meta({
      ref: "SessionShare",
    })
  export type ShareInfo = z.output<typeof ShareInfo>

  export const Event = {
    Created: BusEvent.define(
      "session.created",
      z.object({
        info: Info,
      }),
    ),
    Updated: BusEvent.define(
      "session.updated",
      z.object({
        info: Info,
      }),
    ),
    Deleted: BusEvent.define(
      "session.deleted",
      z.object({
        info: Info,
      }),
    ),
    Diff: BusEvent.define(
      "session.diff",
      z.object({
        sessionID: z.string(),
        diff: Snapshot.FileDiff.array(),
      }),
    ),
    Error: BusEvent.define(
      "session.error",
      z.object({
        sessionID: z.string().optional(),
        error: MessageV2.Assistant.shape.error,
      }),
    ),
  }

  export const create = fn(
    z
      .object({
        id: Identifier.schema("session").optional(),
        parentID: Identifier.schema("session").optional(),
        title: z.string().optional(),
        permission: Info.shape.permission,
      })
      .optional(),
    async (input) => {
      return createNext({
        id: input?.id,
        parentID: input?.parentID,
        directory: Instance.directory,
        title: input?.title,
        permission: input?.permission,
      })
    },
  )

  export const fork = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message").optional(),
    }),
    async (input) => {
      const original = await get(input.sessionID)
      if (!original) throw new Error("session not found")
      const title = getForkedTitle(original.title)
      const session = await createNext({
        directory: Instance.directory,
        title,
      })
      const msgs = await messages({ sessionID: input.sessionID })
      const idMap = new Map<string, string>()

      for (const msg of msgs) {
        if (input.messageID && msg.info.id >= input.messageID) break
        const newID = Identifier.ascending("message")
        idMap.set(msg.info.id, newID)

        const parentID = msg.info.role === "assistant" && msg.info.parentID ? idMap.get(msg.info.parentID) : undefined
        const cloned = await updateMessage({
          ...msg.info,
          sessionID: session.id,
          id: newID,
          ...(parentID && { parentID }),
        })

        for (const part of msg.parts) {
          await updatePart({
            ...part,
            id: Identifier.ascending("part"),
            messageID: cloned.id,
            sessionID: session.id,
          })
        }
      }
      return session
    },
  )

  export const touch = fn(Identifier.schema("session"), async (sessionID) => {
    await update(sessionID, (draft) => {
      draft.time.updated = Date.now()
    })
  })

  export async function createNext(input: {
    id?: string
    title?: string
    parentID?: string
    directory: string
    permission?: PermissionNext.Ruleset
  }) {
    const id = Identifier.descending("session", input.id)
    const directory = Project.canonicalize(input.directory)
    // Caller-supplied IDs are an idempotency key. Serialize the full
    // storage-and-filesystem transaction across server processes so a retry
    // cannot observe the session between its record and workspace setup.
    await using lease = input.id ? await FileLease.acquire(creationLock(Instance.project.id, id), 60_000) : undefined
    if (await deleting(Instance.project.id, id)) throw new DeletingError({ sessionID: id })
    const existing = input.id
      ? await load(id).catch((error) => {
          if (Storage.NotFoundError.isInstance(error)) return
          throw error
        })
      : undefined
    if (existing) return bind(existing)
    if (input.parentID) await assertDirectory(input.parentID)
    if (directory !== Project.canonicalize(Instance.directory)) {
      throw new DirectoryMismatchError({
        sessionID: id,
        sessionDirectory: directory,
        instanceDirectory: Project.canonicalize(Instance.directory),
      })
    }
    const result: Info = {
      id,
      slug: Slug.create(),
      version: Installation.VERSION,
      projectID: Instance.project.id,
      directory,
      parentID: input.parentID,
      title: input.title ?? createDefaultTitle(!!input.parentID),
      permission: input.permission,
      time: {
        created: Date.now(),
        updated: Date.now(),
      },
    }
    await SessionFilesystem.validateProject(directory)
    log.info("created", result)
    await Storage.write(["session", Instance.project.id, result.id], result)
    // No process can hold authority for a session that has not been returned
    // or announced yet. Publishing its initial workspace as a "change" would
    // schedule a redundant revocation that can race the session's first job.
    // Lazy initialization of legacy sessions keeps the default revocation.
    await SessionFilesystem.initialize(result.id, directory, { revokeExisting: false }).catch(async (error) => {
      await SessionFilesystem.remove(result.id).catch(() => undefined)
      await Storage.remove(["session", Instance.project.id, result.id])
      throw error
    })
    validated().add(result.id)
    Bus.publish(Event.Created, {
      info: result,
    })
    Bus.publish(Event.Updated, {
      info: result,
    })
    void OutboundTelemetry.sessionStarted({ sessionID: result.id, session: result }).catch(() => undefined)
    return result
  }

  export function plan(input: { slug: string; time: { created: number } }) {
    const base = Instance.project.vcs
      ? path.join(Instance.worktree, ".openscience", "plans")
      : path.join(Global.Path.data, "plans")
    return path.join(base, [input.time.created, input.slug].join("-") + ".md")
  }

  export const get = fn(Identifier.schema("session"), async (id) => {
    return bind(await load(id))
  })

  export const getShare = fn(Identifier.schema("session"), async (id) => {
    return Storage.read<ShareInfo>(["share", id])
  })

  export const share = fn(Identifier.schema("session"), async (_id) => {
    return { id: "", url: "", secret: "" }
  })

  export const unshare = fn(Identifier.schema("session"), async (_id) => {})

  export async function update(id: string, editor: (session: Info) => void, options?: { touch?: boolean }) {
    const project = Instance.project
    const session = await get(id)
    const result = await Storage.update<Info>(["session", project.id, id], (draft) => {
      editor(draft)
      if (draft.directory !== session.directory) {
        throw new DirectoryImmutableError({
          sessionID: id,
          directory: session.directory,
        })
      }
      if (options?.touch !== false) {
        draft.time.updated = Date.now()
      }
    })
    Bus.publish(Event.Updated, {
      info: result,
    })
    return result
  }

  export const diff = fn(Identifier.schema("session"), async (sessionID) => {
    await assertDirectory(sessionID)
    const diffs = await Storage.read<Snapshot.FileDiff[]>(["session_diff", sessionID])
    return diffs ?? []
  })

  export const messages = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      limit: z.number().optional(),
    }),
    async (input) => {
      await assertDirectory(input.sessionID)
      // A reconnecting UI uses this endpoint as the authoritative backfill for
      // SSE events it could not receive. Flush coalesced streaming text and
      // reasoning first so the snapshot cannot lag behind the visible turn.
      await flushPendingParts(input.sessionID)
      const result = [] as MessageV2.WithParts[]
      for await (const msg of MessageV2.stream(input.sessionID)) {
        if (input.limit && result.length >= input.limit) break
        result.push(msg)
      }
      result.reverse()
      return result
    },
  )

  export async function* list() {
    const project = Instance.project
    for (const item of await Storage.list(["session", project.id])) {
      const session = await loadOptional(item)
      if (!session) continue
      if (!current(session)) continue
      yield session
    }
  }

  export const children = fn(Identifier.schema("session"), async (parentID) => {
    await assertDirectory(parentID)
    const project = Instance.project
    const result = [] as Session.Info[]
    for (const item of await Storage.list(["session", project.id])) {
      const session = await loadOptional(item)
      if (!session) continue
      if (!current(session)) continue
      if (session.parentID !== parentID) continue
      result.push(session)
    }
    return result
  })

  export const remove = fn(Identifier.schema("session"), async (sessionID) => {
    const project = Instance.project
    await using lease = await FileLease.acquire(deletionLock(project.id, sessionID), 60_000)
    return await lease.during(async () => {
      let pending = await deleting(project.id, sessionID)
      const session = pending?.info ?? (await get(sessionID))
      if (!current(session)) bind(session)
      try {
        if (!pending) {
          // Children must finish their own tombstone/reaper lifecycle before the
          // parent becomes unroutable.
          for (const child of await children(sessionID)) {
            await remove(child.id)
          }
          pending = {
            version: 1,
            info: session,
            time: { created: Date.now() },
          }
          // Publish the recovery record before any destructive mutation. A
          // failed reaper or killed deleter can therefore retry by session id.
          await Storage.write(deletionKey(project.id, sessionID), pending)
          await OutboundTelemetry.sessionCompleted({ sessionID, reason: "deleted", session }).catch(() => undefined)
        }
        // Cancellation must be visible before deletion waits for the authority
        // lease held by a booting kernel. Otherwise that boot can become ready,
        // run its first cell, and only then be reaped by filesystem teardown.
        KernelRuntime.cancelSession(sessionID)
        await unshare(sessionID).catch(() => {})
        // Remove the routable session record before filesystem authority. A
        // process start that wins the authority lease first is subsequently
        // revoked; one that runs after filesystem removal cannot lazily recreate
        // grants from a still-visible session record. The durable tombstone,
        // unlike the old ordering, still makes cleanup retryable.
        await Storage.remove(["session", project.id, sessionID])
        validated().delete(sessionID)
        const signal = await SessionFilesystem.remove(sessionID)
        await KernelRuntime.removeSession(project.id, sessionID)
        await Bus.publish(Event.Deleted, {
          info: session,
        })
        await AuthoritySignal.settle(signal.revision)

        // User data is erased only after every runtime reaper acknowledges the
        // deletion. A crash during this phase leaves the tombstone last, so the
        // remaining idempotent removals are retried on startup.
        for (const msg of await Storage.list(["message", sessionID])) {
          for (const part of await Storage.list(["part", msg.at(-1)!])) {
            await Storage.remove(part)
          }
          await Storage.remove(msg)
        }
        await SessionTraceStore.remove(sessionID)
        await SessionResearch.remove(sessionID)
        await Storage.remove(deletionKey(project.id, sessionID))
      } catch (e) {
        log.error(e)
        throw e
      }
    })
  })

  /** Resume deletions whose durable tombstone outlived a failed/killed
   * deleter. Call only after runtime cleanup subscribers are installed. */
  export async function resumeDeleting() {
    const projectID = Instance.project.id
    for (const key of await Storage.list(["session_delete", projectID])) {
      const sessionID = key.at(-1)
      if (sessionID) await remove(sessionID)
    }
  }

  export const updateMessage = fn(MessageV2.Info, async (msg) => {
    await assertDirectory(msg.sessionID)
    await Storage.write(["message", msg.sessionID, msg.id], msg)
    Bus.publish(MessageV2.Event.Updated, {
      info: msg,
    })
    return msg
  })

  export const removeMessage = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
    }),
    async (input) => {
      await assertDirectory(input.sessionID)
      await Storage.remove(["message", input.sessionID, input.messageID])
      MessageV2.invalidateLastID(input.sessionID)
      Bus.publish(MessageV2.Event.Removed, {
        sessionID: input.sessionID,
        messageID: input.messageID,
      })
      return input.messageID
    },
  )

  export const removePart = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
      partID: Identifier.schema("part"),
    }),
    async (input) => {
      await assertDirectory(input.sessionID)
      await Storage.remove(["part", input.messageID, input.partID])
      Bus.publish(MessageV2.Event.PartRemoved, {
        sessionID: input.sessionID,
        messageID: input.messageID,
        partID: input.partID,
      })
      return input.partID
    },
  )

  const UpdatePartInput = z.union([
    MessageV2.Part,
    z.object({
      part: MessageV2.TextPart,
      delta: z.string(),
    }),
    z.object({
      part: MessageV2.ReasoningPart,
      delta: z.string(),
    }),
  ])

  const partWriter = createCoalescer<MessageV2.Part>(
    (_key, part) => Storage.write(["part", part.messageID, part.id], part),
    250,
  )

  export const updatePart = fn(UpdatePartInput, async (input) => {
    const part = "delta" in input ? input.part : input
    const delta = "delta" in input ? input.delta : undefined
    await assertDirectory(part.sessionID)
    // Publish immediately so the SSE stream is not gated on the disk write.
    Bus.publish(MessageV2.Event.PartUpdated, { part, delta })
    const key = part.sessionID + "/" + part.messageID + "/" + part.id
    partWriter.push(key, part)
    // Only a streaming delta rides the 250ms timer plus the idle flush; whole/synthetic
    // parts (no delta) and the final text/reasoning-end part flush immediately.
    const streaming = delta !== undefined && (part.type === "text" || part.type === "reasoning")
    if (!streaming) await partWriter.flushNow(key)
    return part
  })

  export const flushPendingParts = (sessionID: string) => partWriter.flushWhere((k) => k.startsWith(sessionID + "/"))

  export const getUsage = fn(
    z.object({
      model: z.custom<Provider.Model>(),
      tier: z.string().optional(),
      usage: z.custom<LanguageModelUsage>(),
      metadata: z.custom<ProviderMetadata>().optional(),
    }),
    (input) => {
      const cacheReadInputTokens = input.usage.cachedInputTokens ?? 0
      const cacheWriteInputTokens = (input.metadata?.["anthropic"]?.["cacheCreationInputTokens"] ??
        // @ts-expect-error
        input.metadata?.["bedrock"]?.["usage"]?.["cacheWriteInputTokens"] ??
        // @ts-expect-error
        input.metadata?.["venice"]?.["usage"]?.["cacheCreationInputTokens"] ??
        0) as number

      const excludesCachedTokens = !!(input.metadata?.["anthropic"] || input.metadata?.["bedrock"])
      const adjustedInputTokens = excludesCachedTokens
        ? (input.usage.inputTokens ?? 0)
        : (input.usage.inputTokens ?? 0) - cacheReadInputTokens - cacheWriteInputTokens
      const safe = (value: number) => {
        // Clamp non-finite AND negative values: for providers not in the
        // excludes-cached set, `inputTokens - cacheRead - cacheWrite` can go
        // negative when the provider already excludes cached tokens, which would
        // otherwise flow a negative token count (and negative cost) downstream.
        if (!Number.isFinite(value) || value < 0) return 0
        return value
      }

      const tokens = {
        input: safe(adjustedInputTokens),
        output: safe(input.usage.outputTokens ?? 0),
        reasoning: safe(input.usage?.reasoningTokens ?? 0),
        cache: {
          write: safe(cacheWriteInputTokens),
          read: safe(cacheReadInputTokens),
        },
      }

      // The over-200k pricing tier keys off the full prompt size, which includes
      // cache-CREATION tokens too. Omitting cache.write meant a mostly-cache-write
      // request that really exceeded 200k was billed at the base tier (cost
      // under-report).
      const modeCost = input.tier ? input.model.modes?.[input.tier]?.cost : undefined
      const promptTokens = tokens.input + tokens.cache.read + tokens.cache.write
      const tierCost = input.model.cost?.tiers
        ?.filter((tier) => promptTokens >= tier.threshold)
        .sort((a, b) => b.threshold - a.threshold)[0]
      const catalogCost = input.model.cost?.tiers?.length
        ? (tierCost ?? input.model.cost)
        : input.model.cost?.experimentalOver200K && promptTokens > 200_000
          ? input.model.cost.experimentalOver200K
          : input.model.cost
      const costInfo = modeCost ?? catalogCost
      return {
        cost: safe(
          new Decimal(0)
            .add(new Decimal(tokens.input).mul(costInfo?.input ?? 0).div(1_000_000))
            .add(new Decimal(tokens.output).mul(costInfo?.output ?? 0).div(1_000_000))
            .add(new Decimal(tokens.cache.read).mul(costInfo?.cache?.read ?? 0).div(1_000_000))
            .add(new Decimal(tokens.cache.write).mul(costInfo?.cache?.write ?? 0).div(1_000_000))
            .toNumber(),
        ),
        tokens,
      }
    },
  )

  export class BusyError extends Error {
    constructor(public readonly sessionID: string) {
      super(`Session ${sessionID} is busy`)
    }
  }

  export const initialize = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      modelID: z.string(),
      providerID: z.string(),
      messageID: Identifier.schema("message"),
    }),
    async (input) => {
      await SessionPrompt.command({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: input.providerID + "/" + input.modelID,
        command: Command.Default.INIT,
        arguments: "",
      })
    },
  )
}
