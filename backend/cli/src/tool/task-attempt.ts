import { createHash } from "node:crypto"
import path from "node:path"
import z from "zod"
import { Global } from "@/global"
import { Identifier } from "@/id/id"
import type { MessageV2 } from "@/session/message-v2"
import { Storage } from "@/storage/storage"
import { FileLease } from "@/util/file-lease"

export namespace TaskAttempt {
  const marker = "openscience.task.wrapper"

  export const Result = z.object({
    title: z.string(),
    metadata: z.record(z.string(), z.unknown()),
    output: z.string(),
  })
  export type Result = z.infer<typeof Result>

  export const Info = z.object({
    version: z.literal(1),
    projectID: z.string(),
    parentSessionID: Identifier.schema("session"),
    parentMessageID: Identifier.schema("message"),
    parentUserMessageID: Identifier.schema("message"),
    callID: z.string().min(1),
    fingerprint: z.string(),
    childSessionID: Identifier.schema("session"),
    childMessageID: Identifier.schema("message"),
    previousMessageIDs: z.array(Identifier.schema("message")),
    status: z.enum(["reserved", "bound", "completed"]),
    result: Result.optional(),
    activeMs: z.number().nonnegative().optional(),
    active: z
      .object({
        pid: z.number().int().positive(),
        token: z.string().min(1),
        startedAt: z.number(),
        heartbeatAt: z.number(),
      })
      .optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  export type Info = z.infer<typeof Info>

  type Identity = Pick<Info, "projectID" | "parentSessionID" | "parentMessageID" | "parentUserMessageID" | "callID">

  function digest(input: Pick<Identity, "parentSessionID" | "parentMessageID" | "callID">) {
    return createHash("sha256")
      .update(`${input.parentSessionID}\0${input.parentMessageID}\0${input.callID}`)
      .digest("hex")
  }

  function key(input: Identity) {
    return ["task_attempt", input.projectID, digest(input)]
  }

  function same(current: Info, input: Identity) {
    if (
      current.projectID !== input.projectID ||
      current.parentSessionID !== input.parentSessionID ||
      current.parentMessageID !== input.parentMessageID ||
      current.parentUserMessageID !== input.parentUserMessageID ||
      current.callID !== input.callID
    ) {
      throw new Error(`Task attempt identity collision for ${input.callID}`)
    }
  }

  function canonical(value: unknown): string {
    if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
    if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null"
    if (Array.isArray(value)) {
      return `[${value.map((item) => (item === undefined ? "null" : canonical(item))).join(",")}]`
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value)
        .filter(([, item]) => item !== undefined && typeof item !== "function" && typeof item !== "symbol")
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      return `{${entries.map(([name, item]) => `${JSON.stringify(name)}:${canonical(item)}`).join(",")}}`
    }
    return "null"
  }

  export function fingerprint(value: unknown) {
    return createHash("sha256").update(canonical(value)).digest("hex")
  }

  export function legacyFingerprint(value: unknown) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex")
  }

  export async function reserve(
    input: Identity & {
      fingerprint: string
      legacyFingerprint?: string
      childSessionID?: string
    },
  ) {
    const now = Date.now()
    const result = await Storage.upsert<unknown>(key(input), (stored) => {
      if (stored !== undefined) {
        const current = Info.parse(stored)
        same(current, input)
        if (current.fingerprint !== input.fingerprint && current.fingerprint !== input.legacyFingerprint) {
          throw new Error(`Task call ${input.callID} changed arguments after its durable attempt was reserved`)
        }
        if (input.childSessionID && current.childSessionID !== input.childSessionID) {
          throw new Error(`Task call ${input.callID} changed its continuation session after reservation`)
        }
        if (current.fingerprint !== input.fingerprint) {
          return Info.parse({ ...current, fingerprint: input.fingerprint, updatedAt: now })
        }
        return current
      }
      return Info.parse({
        version: 1,
        ...input,
        childSessionID: input.childSessionID ?? Identifier.descending("session"),
        childMessageID: Identifier.ascending("message"),
        previousMessageIDs: [],
        status: "reserved",
        activeMs: 0,
        createdAt: now,
        updatedAt: now,
      })
    })
    return Info.parse(result)
  }

  export async function read(input: Identity) {
    const result = await Storage.read<unknown>(key(input)).catch((error) => {
      if (Storage.NotFoundError.isInstance(error)) return
      throw error
    })
    if (result === undefined) return
    const current = Info.parse(result)
    same(current, input)
    return current
  }

  export async function bind(input: Identity & { previousMessageIDs: string[] }) {
    const result = await Storage.upsert<unknown>(key(input), (stored) => {
      const current = Info.parse(stored)
      same(current, input)
      if (current.status === "completed") return current
      return Info.parse({
        ...current,
        previousMessageIDs: current.previousMessageIDs.length ? current.previousMessageIDs : input.previousMessageIDs,
        status: "bound",
        updatedAt: Date.now(),
      })
    })
    return Info.parse(result)
  }

  export async function complete(input: Identity & { result: Result }) {
    const result = await Storage.upsert<unknown>(key(input), (stored) => {
      const current = Info.parse(stored)
      same(current, input)
      if (current.status === "completed") return current
      return Info.parse({
        ...current,
        status: "completed",
        result: input.result,
        updatedAt: Date.now(),
      })
    })
    return Info.parse(result)
  }

  function charge(current: Info, endedAt: number) {
    if (!current.active) return current.activeMs ?? 0
    const end = Math.max(current.active.startedAt, Math.min(Date.now(), endedAt))
    return (current.activeMs ?? 0) + Math.max(0, end - current.active.startedAt)
  }

  /** Close a prior process's active interval at its last durable heartbeat.
   * Time after that heartbeat is process downtime and is not child budget. */
  export async function settle(input: Identity, endedAt?: number) {
    const result = await Storage.upsert<unknown>(key(input), (stored) => {
      const current = Info.parse(stored)
      same(current, input)
      if (!current.active) return current
      return Info.parse({
        ...current,
        activeMs: charge(current, endedAt ?? current.active.heartbeatAt),
        active: undefined,
        updatedAt: Date.now(),
      })
    })
    return Info.parse(result)
  }

  export async function activate(input: Identity & { token: string }) {
    const now = Date.now()
    const result = await Storage.upsert<unknown>(key(input), (stored) => {
      const current = Info.parse(stored)
      same(current, input)
      if (current.active) throw new Error(`Task call ${input.callID} already has an active execution interval`)
      return Info.parse({
        ...current,
        active: { pid: process.pid, token: input.token, startedAt: now, heartbeatAt: now },
        updatedAt: now,
      })
    })
    return Info.parse(result)
  }

  export async function pulse(input: Identity & { token: string }) {
    const now = Date.now()
    const result = await Storage.upsert<unknown>(key(input), (stored) => {
      const current = Info.parse(stored)
      same(current, input)
      if (!current.active || current.active.token !== input.token) return current
      return Info.parse({
        ...current,
        active: { ...current.active, heartbeatAt: Math.max(current.active.heartbeatAt, now) },
        updatedAt: Math.max(current.updatedAt, now),
      })
    })
    return Info.parse(result)
  }

  export async function deactivate(input: Identity & { token: string; endedAt?: number }) {
    const result = await Storage.upsert<unknown>(key(input), (stored) => {
      const current = Info.parse(stored)
      same(current, input)
      if (!current.active || current.active.token !== input.token) return current
      return Info.parse({
        ...current,
        activeMs: charge(current, input.endedAt ?? Date.now()),
        active: undefined,
        updatedAt: Date.now(),
      })
    })
    return Info.parse(result)
  }

  export function remaining(info: Info, budgetMs: number) {
    return Math.max(0, budgetMs - (info.activeMs ?? 0))
  }

  export function leasePath(input: Identity) {
    return path.join(Global.Path.data, "task-attempt", `${digest(input)}.lock`)
  }

  export function acquire(input: Identity, timeout: number, signal?: AbortSignal) {
    return FileLease.acquire(leasePath(input), timeout, signal)
  }

  export function wrapper(source: { messageID: string; partID: string }) {
    return {
      [marker]: {
        version: 1,
        messageID: source.messageID,
        partID: source.partID,
      },
    }
  }

  export function wrapperIDs(source: { messageID: string; partID: string }) {
    const hash = createHash("sha256").update(`${source.messageID}\0${source.partID}`).digest("hex")
    const suffix = source.partID.startsWith("prt_") ? source.partID.slice(4) : hash.slice(0, 26)
    return {
      messageID: `msg_${suffix}`,
      partID: `prt_${hash.slice(0, 26)}`,
      callID: `task_${hash}`,
    }
  }

  export function wrapperSource(part: MessageV2.Part) {
    if (part.type !== "tool" || part.tool !== "task") return
    const value = part.metadata?.[marker]
    if (!value || typeof value !== "object") return
    if (!("version" in value) || value.version !== 1) return
    if (!("messageID" in value) || typeof value.messageID !== "string") return
    if (!("partID" in value) || typeof value.partID !== "string") return
    return { messageID: value.messageID, partID: value.partID }
  }

  export function syntheticWrapper(message: MessageV2.WithParts) {
    if (message.info.role !== "assistant") return false
    return message.parts.some((part) => wrapperSource(part) !== undefined)
  }
}

export namespace TaskCapacity {
  export type Kind = "child" | "compute"

  export function slotPath(kind: Kind, slot: number) {
    return path.join(Global.Path.data, "task-capacity", kind, `${slot}.lock`)
  }

  export async function acquire(kind: Kind, limit: number, signal?: AbortSignal) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`Invalid ${kind} Task capacity: ${limit}`)
    while (true) {
      signal?.throwIfAborted()
      for (let slot = 0; slot < limit; slot++) {
        try {
          return await FileLease.acquire(slotPath(kind, slot), 25, signal)
        } catch (error) {
          signal?.throwIfAborted()
          if (
            !(error instanceof Error) ||
            !error.message.startsWith("Timed out waiting for another OpenScience process")
          ) {
            throw error
          }
        }
      }
      await Bun.sleep(15)
    }
  }
}
