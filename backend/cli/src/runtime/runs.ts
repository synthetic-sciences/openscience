import path from "node:path"
import z from "zod"
import { Global } from "../global"
import { Identifier } from "../id/id"
import { Instance } from "../project/instance"
import { ProcessIdentity } from "../process/process-identity"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { SessionPrompt } from "../session/prompt"
import { PromptInput } from "../session/prompt-input"
import { Storage } from "../storage/storage"
import { FileLease } from "../util/file-lease"
import { Log } from "../util/log"
import { RuntimeEvents } from "./events"

export namespace RuntimeRuns {
  const log = Log.create({ service: "runtime-runs" })
  const executions = Instance.state(() => new Map<string, { sessionID: string; controller: AbortSignal }>())

  export const Input = PromptInput.pick({
    sessionID: true,
    messageID: true,
    model: true,
    variant: true,
    tier: true,
    context: true,
    delegation: true,
    delegationSettings: true,
  })
    .extend({
      requestID: z.string().trim().min(1).max(200).optional(),
      messageID: z
        .string()
        .regex(/^msg_[0-9a-fA-F]{12}[A-Za-z0-9]{14}$/)
        .optional(),
      message: z.string().trim().min(1).max(1_000_000).optional(),
      parts: PromptInput.shape.parts.min(1).optional(),
      effort: z.enum(["normal", "ultra"]),
    })
    .strict()
    .refine((value) => (value.message !== undefined) !== (value.parts !== undefined), {
      message: "Supply exactly one of message or parts",
    })

  export type Input = z.infer<typeof Input>

  export const RunID = z.string().regex(/^run_[A-Za-z0-9_-]+$/)

  export const Run = z
    .object({
      runID: RunID,
      sessionID: Identifier.schema("session"),
      requestID: z.string().optional(),
      messageID: Identifier.schema("message"),
      state: z.enum(["accepted", "running", "completed", "failed", "cancelled", "interrupted"]),
      acceptedAt: z.number().int().nonnegative(),
      updatedAt: z.number().int().nonnegative(),
      completedAt: z.number().int().nonnegative().optional(),
      resultMessageID: Identifier.schema("message").optional(),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
    })
    .meta({ ref: "RuntimeRun" })
  export type Run = z.infer<typeof Run>

  const Record = z.object({
    run: Run,
    fingerprint: z.string(),
    input: Input,
    agent: z.string(),
    owner: z.object({ pid: z.number().int().positive(), identity: z.string() }),
  })
  type Record = z.infer<typeof Record>

  export class ConflictError extends Error {
    constructor() {
      super("This request ID is already bound to a different prompt or configuration")
      this.name = "RuntimeRequestConflictError"
    }
  }

  function digest(value: string) {
    return new Bun.CryptoHasher("sha256").update(value).digest("hex")
  }

  function ordered(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(ordered)
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter((entry) => entry[1] !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, ordered(entry)]),
      )
    return value
  }

  function prefix(sessionID: string) {
    return ["runtime_run", Instance.project.id, digest(sessionID)]
  }

  function key(sessionID: string, runID: string) {
    return [...prefix(sessionID), RunID.parse(runID)]
  }

  async function read(sessionID: string, runID: string) {
    return Record.parse(await Storage.read(key(sessionID, runID)))
  }

  function finished(run: Run) {
    return run.state !== "accepted" && run.state !== "running"
  }

  async function update(sessionID: string, runID: string, change: Partial<Run>) {
    const record = await Storage.update<Record>(key(sessionID, runID), (stored) => {
      const current = Record.parse(stored)
      if (finished(current.run)) return
      stored.run = Run.parse({ ...current.run, ...change, updatedAt: Date.now() })
    })
    return Record.parse(record).run
  }

  async function reconcile(record: Record): Promise<Run> {
    if (finished(record.run)) return record.run
    const replay = await RuntimeEvents.replay(record.run.sessionID)
    const terminal = replay.events.findLast(
      (event) =>
        event.runID === record.run.runID &&
        ["runtime.completed", "runtime.failed", "runtime.cancelled"].includes(event.type),
    )
    if (terminal) {
      const interrupted = terminal.type === "runtime.failed" && terminal.properties.recovered === true
      return update(record.run.sessionID, record.run.runID, {
        state:
          terminal.type === "runtime.completed"
            ? "completed"
            : terminal.type === "runtime.cancelled"
              ? "cancelled"
              : interrupted
                ? "interrupted"
                : "failed",
        completedAt: terminal.time,
        ...(typeof terminal.properties.messageID === "string"
          ? { resultMessageID: terminal.properties.messageID }
          : {}),
        ...(terminal.type === "runtime.failed"
          ? {
              error: {
                code: interrupted ? "runtime_stopped" : "run_failed",
                message: String(terminal.properties.message ?? "The research run failed"),
              },
            }
          : {}),
      })
    }
    if (await ProcessIdentity.owns(record.owner.pid, record.owner.identity)) return record.run
    return update(record.run.sessionID, record.run.runID, {
      state: "interrupted",
      completedAt: Date.now(),
      error: {
        code: "runtime_stopped",
        message: "The owning runtime stopped. Inspect outputs before explicitly submitting new work.",
      },
    })
  }

  export async function get(sessionID: string, runID: string) {
    await Session.get(sessionID)
    return reconcile(await read(sessionID, runID))
  }

  export async function list(sessionID: string) {
    await Session.get(sessionID)
    const records = await Storage.list(prefix(sessionID))
    const runs = await Promise.all(records.map(async (item) => reconcile(Record.parse(await Storage.read(item)))))
    return runs.sort((a, b) => a.acceptedAt - b.acceptedAt || a.runID.localeCompare(b.runID))
  }

  /** Admission and exact retry reconciliation are serialized across local
   * server processes. The receipt is durable before any model work starts.
   * A crash in the admission/execution gap is interrupted, never auto-retried. */
  export async function admit(value: Input, agent = "research") {
    const input = Input.parse(value)
    await Session.get(input.sessionID)
    const identity = input.requestID ?? input.messageID
    const fingerprint = digest(JSON.stringify(ordered({ ...input, requestID: undefined, agent })))
    const runID = identity ? "run_" + digest(input.sessionID + "\0" + identity) : Identifier.ascending("runtime")
    const lock = path.join(Global.Path.data, "runtime-admission", digest(Instance.project.id + "\0" + input.sessionID))
    await using lease = await FileLease.acquire(lock)
    const prior = await read(input.sessionID, runID).catch((error) => {
      if (Storage.NotFoundError.isInstance(error)) return
      throw error
    })
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new ConflictError()
      return { run: await reconcile(prior), replayed: true }
    }
    try {
      SessionPrompt.assertNotBusy(input.sessionID)
    } catch (error) {
      if (error instanceof Session.BusyError) throw new RuntimeEvents.ActiveRunError(input.sessionID)
      throw error
    }
    if (await RuntimeEvents.isActive(input.sessionID)) throw new RuntimeEvents.ActiveRunError(input.sessionID)
    if (input.messageID) {
      // A cancelled admission may never have persisted a user message. Its
      // receipt still reserves that message ID; a new request cannot rebind it.
      for (const item of await Storage.list(prefix(input.sessionID))) {
        const record = Record.parse(await Storage.read(item))
        if (record.run.messageID === input.messageID) throw new ConflictError()
      }
      const existing = await MessageV2.get({ sessionID: input.sessionID, messageID: input.messageID }).catch(
        (error) => {
          if (Storage.NotFoundError.isInstance(error)) return
          throw error
        },
      )
      if (existing) throw new ConflictError()
    }
    const owner = await ProcessIdentity.capture(process.pid)
    if (!owner) throw new Error("Could not capture runtime process identity")
    const now = Date.now()
    const run = Run.parse({
      runID,
      sessionID: input.sessionID,
      requestID: input.requestID,
      messageID: input.messageID ?? Identifier.ascending("message"),
      state: "accepted",
      acceptedAt: now,
      updatedAt: now,
    })
    await Storage.write(key(input.sessionID, runID), {
      run,
      input,
      fingerprint,
      agent,
      owner: { pid: process.pid, identity: owner },
    } satisfies Record)
    await RuntimeEvents.begin({
      sessionID: input.sessionID,
      runID,
      acceptedAt: now,
      effort: input.effort,
    }).catch(async (error) => {
      await update(input.sessionID, runID, {
        state: "failed",
        completedAt: Date.now(),
        error: { code: "admission_failed", message: error instanceof Error ? error.message : String(error) },
      })
      throw error
    })
    return { run, replayed: false }
  }

  async function execute(run: Run) {
    const local = executions()
    try {
      // Admission and cancellation use the same lease. Install the controlled
      // prompt before releasing it, closing the gap before async preflight.
      const started = await (async () => {
        const lock = path.join(
          Global.Path.data,
          "runtime-admission",
          digest(Instance.project.id + "\0" + run.sessionID),
        )
        await using lease = await FileLease.acquire(lock)
        const record = await read(run.sessionID, run.runID)
        if (finished(await reconcile(record))) return
        await update(run.sessionID, run.runID, { state: "running" })
        const { requestID: _, message, ...input } = record.input
        const promise = SessionPrompt.controlled({
          ...input,
          messageID: run.messageID,
          agent: record.agent,
          parts: input.parts ?? [{ type: "text", text: message! }],
        })
        const controller = SessionPrompt.activeController(run.sessionID)
        if (controller) local.set(run.runID, { sessionID: run.sessionID, controller })
        // Attach a rejection handler before releasing an async lease.
        void promise.catch(() => undefined)
        return { promise }
      })()
      if (!started) return
      const result = await started.promise
      const event =
        result.info.role === "assistant" && result.info.error
          ? await RuntimeEvents.fail({
              sessionID: run.sessionID,
              runID: run.runID,
              messageID: result.info.id,
              error: result.info.error,
            })
          : await RuntimeEvents.finish({
              sessionID: run.sessionID,
              runID: run.runID,
              messageID: result.info.id,
            })
      await update(run.sessionID, run.runID, {
        state:
          event.type === "runtime.completed"
            ? "completed"
            : event.type === "runtime.cancelled"
              ? "cancelled"
              : "failed",
        completedAt: event.time,
        resultMessageID: result.info.id,
        ...(event.type === "runtime.failed"
          ? { error: { code: "run_failed", message: String(event.properties.message ?? "The research run failed") } }
          : {}),
      })
    } catch (error) {
      if (error instanceof RuntimeEvents.ActiveRunError) {
        await reconcile(await read(run.sessionID, run.runID))
        return
      }
      const event = await RuntimeEvents.fail({ sessionID: run.sessionID, runID: run.runID, error })
      await update(run.sessionID, run.runID, {
        state: event.type === "runtime.cancelled" ? "cancelled" : "failed",
        completedAt: event.time,
        error: {
          code: event.type === "runtime.cancelled" ? "cancelled" : "run_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      })
    } finally {
      local.delete(run.runID)
    }
  }

  export async function prompt(input: Input, agent = "research") {
    const result = await admit(input, agent)
    if (!result.replayed)
      void execute(result.run).catch((error) =>
        log.error("failed to settle runtime run", { runID: result.run.runID, error }),
      )
    return { runID: result.run.runID, acceptedAt: result.run.acceptedAt }
  }

  export async function cancel(sessionID: string, runID: string) {
    const lock = path.join(Global.Path.data, "runtime-admission", digest(Instance.project.id + "\0" + sessionID))
    await using lease = await FileLease.acquire(lock)
    const local = executions().get(runID)
    const controller = local?.sessionID === sessionID ? local.controller : undefined
    try {
      const run = await get(sessionID, runID)
      if (finished(run)) return run
      const result = await RuntimeEvents.requestCancel({ sessionID, runID, source: "user" })
      if (result.status === "requested") {
        if (controller) SessionPrompt.cancel(sessionID, controller)
        else await RuntimeEvents.cancel({ sessionID, runID, source: "user" })
      }
      return await get(sessionID, runID)
    } finally {
      // Journal read/write failures must not let requested local work continue.
      // This signal belongs to this exact run, never to a replacement or a
      // legacy prompt that happens to share its session.
      if (controller) SessionPrompt.cancel(sessionID, controller)
    }
  }
}
