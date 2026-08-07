import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@/global"
import { JsonStore } from "@/util/jsonstore"
import { Log } from "@/util/log"
import z from "zod"

export namespace SessionTraceStore {
  const log = Log.create({ service: "session.trace.store" })

  export const Approval = z.object({
    id: z.string(),
    permission: z.string(),
    patterns: z.array(z.string()),
    requestedAt: z.number(),
    tool: z
      .object({
        messageID: z.string(),
        callID: z.string(),
      })
      .optional(),
    reply: z.enum(["once", "session", "project", "always", "reject"]).optional(),
    repliedAt: z.number().optional(),
  })
  export type Approval = z.infer<typeof Approval>

  export const Retry = z.object({
    id: z.string(),
    messageID: z.string(),
    attempt: z.number(),
    message: z.string(),
    delayMs: z.number(),
    createdAt: z.number(),
  })
  export type Retry = z.infer<typeof Retry>

  const State = z.object({
    approvals: z.record(z.string(), Approval).default({}),
    retries: z.array(Retry).default([]),
  })
  export type State = z.infer<typeof State>

  const empty = (): State => ({ approvals: {}, retries: [] })
  const file = (sessionID: string) => path.join(Global.Path.data, "trace", `${encodeURIComponent(sessionID)}.json`)

  async function update(sessionID: string, fn: (state: State) => State) {
    await JsonStore.update(file(sessionID), (data) => fn(State.parse({ ...empty(), ...data }))).catch((error) => {
      log.error("failed to persist local session trace", { sessionID, error })
    })
  }

  export async function read(sessionID: string): Promise<State> {
    const data = await JsonStore.read(file(sessionID))
    const parsed = State.safeParse({ ...empty(), ...data })
    return parsed.success ? parsed.data : empty()
  }

  export function approvalAsked(input: {
    id: string
    sessionID: string
    permission: string
    patterns: string[]
    tool?: { messageID: string; callID: string }
  }) {
    return update(input.sessionID, (state) => ({
      ...state,
      approvals: {
        ...state.approvals,
        [input.id]: {
          id: input.id,
          permission: input.permission,
          patterns: input.patterns,
          requestedAt: Date.now(),
          tool: input.tool,
        },
      },
    }))
  }

  export function approvalReplied(input: {
    sessionID: string
    requestID: string
    reply: "once" | "session" | "project" | "always" | "reject"
  }) {
    return update(input.sessionID, (state) => {
      const approval = state.approvals[input.requestID]
      if (!approval) return state
      return {
        ...state,
        approvals: {
          ...state.approvals,
          [input.requestID]: {
            ...approval,
            reply: input.reply,
            repliedAt: Date.now(),
          },
        },
      }
    })
  }

  export function recordRetry(input: Omit<Retry, "id" | "createdAt"> & { sessionID: string }) {
    const item: Retry = {
      id: `${input.messageID}:${input.attempt}:${Date.now()}`,
      messageID: input.messageID,
      attempt: input.attempt,
      message: input.message,
      delayMs: input.delayMs,
      createdAt: Date.now(),
    }
    return update(input.sessionID, (state) => ({ ...state, retries: [...state.retries, item] }))
  }

  export async function remove(sessionID: string) {
    await fs.unlink(file(sessionID)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return
      throw error
    })
  }
}
