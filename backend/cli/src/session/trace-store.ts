import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@/global"
import { UsageEvidence } from "./usage-evidence"
import { Storage } from "@/storage/storage"
import { Log } from "@/util/log"
import { SessionHarness } from "./harness"
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

  export const Harness = SessionHarness.Entry
  export type Harness = z.infer<typeof Harness>

  export const ModelCall = z.object({
    id: z.string(),
    sessionID: z.string(),
    messageID: z.string(),
    route: z.enum(["managed", "byok", "chatgpt", "subscription", "local", "custom"]),
    provider: z.string(),
    model: z.string(),
    occurredAt: z.number(),
    providerRequest: z.string().optional(),
    hold: z.string().optional(),
    reportedCostUSD: z.number().finite().nonnegative().nullable().optional(),
    reported: UsageEvidence.Reported.optional(),
    outcome: z.enum(["pending", "transport_completed", "completed", "failed", "cancelled", "timed_out"]).optional(),
    attempt: z.number().int().nonnegative().optional(),
    completedAt: z.number().optional(),
    httpStatus: z.number().int().min(0).max(599).optional(),
  })
  export type ModelCall = z.infer<typeof ModelCall>

  const State = z.object({
    approvals: z.record(z.string(), Approval).default({}),
    retries: z.array(Retry).default([]),
    harness: z.array(Harness).default([]),
    modelCalls: z.array(ModelCall).default([]),
  })
  export type State = z.infer<typeof State>

  const empty = (): State => ({ approvals: {}, retries: [], harness: [], modelCalls: [] })
  const file = (sessionID: string) => path.join(Global.Path.data, "trace", `${encodeURIComponent(sessionID)}.json`)

  async function migrate(sessionID: string) {
    const database = await Storage.research()
    const name = `legacy-trace:${sessionID}`
    if (await database.migrated(name)) return database
    const source = Bun.file(file(sessionID))
    const state = State.parse((await source.exists()) ? await source.json() : {})
    await database.importRecords(name, [
      { key: ["trace", sessionID], value: { ...state, modelCalls: [] } },
      ...state.modelCalls.map((call) => ({ key: ["model_call", sessionID, call.id], value: call })),
    ])
    return database
  }

  async function update(sessionID: string, fn: (state: State) => State) {
    const database = await migrate(sessionID)
    await database
      .upsert<State>(["trace", sessionID], (data) => fn(State.parse(data ?? empty())))
      .catch((error) => {
        log.error("failed to persist local session trace", { sessionID, error })
      })
  }

  export async function read(sessionID: string): Promise<State> {
    const database = await migrate(sessionID)
    return database.query((db) => {
      const row = db.query<{ data: string }, [string]>("SELECT data FROM trace WHERE id=?").get(sessionID)
      const state = State.parse(row ? JSON.parse(row.data) : empty())
      const calls = db
        .query<{ data: string }, [string]>(
          "SELECT data FROM model_call WHERE session_id=? ORDER BY json_extract(data,'$.occurredAt'),id",
        )
        .all(sessionID)
      return { ...state, modelCalls: calls.map((row) => ModelCall.parse(JSON.parse(row.data))) }
    })
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

  export function recordHarness(input: {
    sessionID: string
    messageID: string
    parentMessageID: string
    attempt: number
    snapshot: SessionHarness.Snapshot
  }) {
    const item = Harness.parse({
      ...input.snapshot,
      messageID: input.messageID,
      parentMessageID: input.parentMessageID,
      attempt: input.attempt,
      createdAt: Date.now(),
    })
    return update(input.sessionID, (state) => ({ ...state, harness: [...state.harness, item] }))
  }

  /** Durable, content-free identity for every completed provider call,
   * including internal title/summary calls that do not create message parts. */
  export async function recordModelCall(input: ModelCall) {
    const item = ModelCall.parse(input)
    const database = await migrate(input.sessionID)
    await database.upsert<ModelCall>(["model_call", input.sessionID, item.id], (previous) => ({ ...previous, ...item }))
  }

  export async function remove(sessionID: string) {
    const database = await migrate(sessionID)
    await database.transaction((db) => {
      db.query("DELETE FROM model_call WHERE session_id=?").run(sessionID)
      db.query("DELETE FROM trace WHERE id=?").run(sessionID)
      db.query("DELETE FROM trace_binding WHERE session_id=?").run(sessionID)
    })
    await fs.unlink(file(sessionID)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  }
}
