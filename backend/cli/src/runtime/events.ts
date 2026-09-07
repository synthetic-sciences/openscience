import z from "zod"
import { Instance } from "../project/instance"
import { Storage } from "../storage/storage"
import { Identifier } from "../id/id"
import { ProcessIdentity } from "../process/process-identity"
import { Log } from "../util/log"

export namespace RuntimeEvents {
  const log = Log.create({ service: "runtime-events" })
  /**
   * Runtime events are deliberately a small, stable envelope around the
   * internal bus. Consumers can persist a cursor without depending on any
   * particular tool or message event schema.
   */
  export const Event = z
    .object({
      sequence: z.number().int().positive(),
      sessionID: z.string(),
      runID: z.string(),
      type: z.string(),
      properties: z.record(z.string(), z.unknown()),
      time: z.number().int().nonnegative(),
    })
    .meta({ ref: "RuntimeEvent" })
  export type Event = z.infer<typeof Event>

  const Journal = z.object({
    nextSequence: z.number().int().positive(),
    events: z.array(Event),
    activeRunID: Identifier.schema("runtime").optional(),
    activeOwner: z
      .object({
        pid: z.number().int().positive(),
        identity: z.string(),
      })
      .optional(),
    cancelRequest: z
      .object({
        runID: Identifier.schema("runtime"),
        source: z.enum(["user", "runner_timeout"]),
        requestedAt: z.number().int().nonnegative(),
      })
      .optional(),
  })
  type Journal = z.infer<typeof Journal>

  export const RETAINED_EVENTS = 2_048

  /** The event types that terminalize a run. `terminal` records exactly one of
   * these per run and treats a later matching call as idempotent. */
  const TERMINAL_TYPES = new Set(["runtime.completed", "runtime.failed", "runtime.cancelled"])

  export class ActiveRunError extends Error {
    constructor(readonly sessionID: string) {
      super(`Session ${sessionID} already has an active runtime run`)
    }
  }

  export class CursorExpiredError extends Error {
    constructor(
      readonly afterSequence: number,
      readonly oldestSequence: number,
    ) {
      super(`Runtime event cursor ${afterSequence} predates retained sequence ${oldestSequence}`)
    }
  }

  export class CursorAheadError extends Error {
    constructor(
      readonly afterSequence: number,
      readonly latestSequence: number,
    ) {
      super(`Runtime event cursor ${afterSequence} is ahead of latest sequence ${latestSequence}`)
    }
  }

  export type CancelResult =
    | { status: "inactive" }
    | { status: "requested"; runID: string }
    | { status: "cancelled"; runID: string; owner: "local" | "stale" }
    | { status: "foreign_owner"; runID: string }
    | { status: "forwarded"; runID: string }

  type Subscriber = (event: Event) => void | Promise<void>

  type ProgressInput = {
    sessionID: string
    runID: string
    type: "message.part.updated"
    properties: Record<string, unknown> & {
      part: Record<string, unknown>
      delta: string
    }
  }

  type ProgressEntry = {
    key: string
    input: ProgressInput
    waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>
  }

  type Progress = {
    runID: string
    first: boolean
    pending: ProgressEntry[]
    tail: Promise<void>
    timer?: ReturnType<typeof setTimeout>
  }

  /** Keep durable public progress responsive without rewriting the full replay
   * journal for every provider token. The regular UI bus still receives each
   * original delta after its durable batch commits. */
  export const PROGRESS_INTERVAL_MS = 50

  const state = Instance.state(() => ({
    active: new Map<string, string>(),
    subscriptions: new Map<string, Set<Subscriber>>(),
    progress: new Map<string, Progress>(),
    // A session's parent is immutable, so one lookup per session suffices.
    parents: new Map<string, string | undefined>(),
  }))

  // Every session that emits while some run is active lands in the parent
  // cache; a cache this size costs one extra record read per entry to rebuild.
  const PARENT_CACHE_LIMIT = 4_096

  /** The parent of a session, read once. A session record is written before
   * the session is announced or produces events, so a missing record means a
   * root or foreign session rather than a not-yet-created child. */
  async function parent(sessionID: string): Promise<string | undefined> {
    const parents = state().parents
    if (parents.has(sessionID)) return parents.get(sessionID)
    const session = await Storage.read<{ parentID?: unknown }>(["session", Instance.project.id, sessionID]).catch(
      () => undefined,
    )
    if (parents.size >= PARENT_CACHE_LIMIT) parents.clear()
    const value = typeof session?.parentID === "string" ? session.parentID : undefined
    parents.set(sessionID, value)
    return value
  }

  /** Ancestor chain of a session, nearest first. */
  async function ancestors(sessionID: string): Promise<string[]> {
    const chain: string[] = []
    let current: string | undefined = sessionID
    while (current && !chain.includes(current)) {
      chain.push(current)
      current = await parent(current)
    }
    return chain
  }

  /** True when `sessionID` is `rootID` or one of its delegated descendants. */
  export async function belongs(rootID: string, sessionID: string) {
    if (rootID === sessionID) return true
    return (await ancestors(sessionID)).includes(rootID)
  }

  /** The nearest active ancestor's run. Delegated children work under the
   * parent's run, so their tool prompts and progress belong to the same
   * public journal. */
  async function inherited(sessionID: string) {
    const active = state().active
    if (!active.size) return
    for (const ancestor of await ancestors(sessionID)) {
      const runID = active.get(ancestor)
      if (runID) return { sessionID: ancestor, runID }
    }
  }

  function key(sessionID: string) {
    return ["runtime_event", Instance.project.id, sessionID]
  }

  function empty(): Journal {
    return { nextSequence: 1, events: [] }
  }

  function nextEvent(
    journal: Journal,
    input: {
      sessionID: string
      runID: string
      type: string
      properties?: Record<string, unknown>
    },
  ) {
    return Event.parse({
      sequence: journal.nextSequence,
      sessionID: input.sessionID,
      runID: input.runID,
      type: input.type,
      properties: input.properties ?? {},
      time: Date.now(),
    })
  }

  function logSafeError(error: unknown) {
    if (error instanceof Error) return error
    try {
      return String(error)
    } catch {
      return "Non-Error subscriber rejection"
    }
  }

  async function notify(event: Event) {
    for (const subscriber of [...(state().subscriptions.get(event.sessionID) ?? [])]) {
      try {
        await subscriber(event)
      } catch (error) {
        // The journal is already durable at this point. A disconnected or
        // otherwise faulty stream consumer must not fail the runtime action
        // that produced the event or prevent delivery to healthy consumers.
        log.error("runtime event subscriber delivery failed", {
          sessionID: event.sessionID,
          runID: event.runID,
          sequence: event.sequence,
          type: event.type,
          error: logSafeError(error),
        })
      }
    }
    return event
  }

  async function read(sessionID: string): Promise<Journal> {
    return Storage.read<Journal>(key(sessionID))
      .then((value) => Journal.parse(value))
      .catch((error) => {
        if (Storage.NotFoundError.isInstance(error)) return empty()
        throw error
      })
  }

  async function append(input: {
    sessionID: string
    runID: string
    type: string
    properties?: Record<string, unknown>
    requireActive?: boolean
  }): Promise<Event | undefined> {
    let event: Event | undefined
    await Storage.upsert<Journal>(key(input.sessionID), (current) => {
      const journal = current ? Journal.parse(current) : empty()
      if (input.requireActive && journal.activeRunID !== input.runID) return journal
      event = nextEvent(journal, input)
      return {
        ...journal,
        nextSequence: journal.nextSequence + 1,
        events: [...journal.events, event].slice(-RETAINED_EVENTS),
      }
    })
    if (!event) return
    return notify(event)
  }

  async function appendProgress(input: { sessionID: string; runID: string; entries: ProgressEntry[] }) {
    const events: Event[] = []
    await Storage.upsert<Journal>(key(input.sessionID), (current) => {
      const journal = current ? Journal.parse(current) : empty()
      if (journal.activeRunID !== input.runID) return journal
      const next = input.entries.map((entry, index) =>
        Event.parse({
          sequence: journal.nextSequence + index,
          sessionID: input.sessionID,
          runID: input.runID,
          type: entry.input.type,
          properties: entry.input.properties,
          time: Date.now(),
        }),
      )
      events.push(...next)
      return {
        ...journal,
        nextSequence: journal.nextSequence + next.length,
        events: [...journal.events, ...next].slice(-RETAINED_EVENTS),
      }
    })
    for (const event of events) await notify(event)
    return events
  }

  function progress(sessionID: string, runID: string) {
    const current = state().progress.get(sessionID)
    if (current?.runID === runID) return current
    if (current?.timer) clearTimeout(current.timer)
    const created: Progress = {
      runID,
      first: true,
      pending: [],
      tail: Promise.resolve(),
    }
    state().progress.set(sessionID, created)
    return created
  }

  function queue(stream: Progress, task: () => Promise<unknown>) {
    const next = stream.tail.then(task).then(() => undefined)
    stream.tail = next.catch(() => undefined)
    return next
  }

  async function flushProgress(sessionID: string) {
    const stream = state().progress.get(sessionID)
    if (!stream) return
    if (stream.timer) clearTimeout(stream.timer)
    stream.timer = undefined
    const entries = stream.pending.splice(0)
    if (!entries.length) return stream.tail
    return queue(stream, async () => {
      try {
        await appendProgress({ sessionID, runID: stream.runID, entries })
        for (const entry of entries) {
          for (const waiter of entry.waiters) waiter.resolve()
        }
      } catch (error) {
        for (const entry of entries) {
          for (const waiter of entry.waiters) waiter.reject(error)
        }
        throw error
      }
    })
  }

  function scheduleProgress(input: ProgressInput) {
    const stream = progress(input.sessionID, input.runID)
    if (stream.first) {
      stream.first = false
      return queue(stream, async () => {
        await append({ ...input, requireActive: true })
      })
    }
    return new Promise<void>((resolve, reject) => {
      const part = input.properties.part
      const key = [part.messageID, part.id, part.type].join(":")
      const prior = stream.pending.at(-1)
      if (prior?.key === key) {
        prior.input = {
          ...input,
          properties: {
            ...input.properties,
            delta: prior.input.properties.delta + input.properties.delta,
          },
        }
        prior.waiters.push({ resolve, reject })
      } else {
        stream.pending.push({ key, input, waiters: [{ resolve, reject }] })
      }
      if (stream.timer) return
      stream.timer = setTimeout(() => {
        stream.timer = undefined
        void flushProgress(input.sessionID).catch((error) =>
          log.error("failed to flush runtime progress", { sessionID: input.sessionID, runID: input.runID, error }),
        )
      }, PROGRESS_INTERVAL_MS)
      ;(stream.timer as { unref?: () => void }).unref?.()
    })
  }

  function progressInput(input: {
    sessionID: string
    runID: string
    type: string
    properties: Record<string, unknown>
  }): ProgressInput | undefined {
    if (input.type !== "message.part.updated" || typeof input.properties.delta !== "string") return
    const part = input.properties.part
    if (!part || typeof part !== "object" || Array.isArray(part)) return
    const record = part as Record<string, unknown>
    if (record.type !== "text" && record.type !== "reasoning") return
    if (typeof record.id !== "string" || typeof record.messageID !== "string") return
    return {
      ...input,
      type: input.type,
      properties: {
        ...input.properties,
        part: { ...record },
        delta: input.properties.delta,
      },
    }
  }

  export async function isActive(sessionID: string) {
    if (state().active.has(sessionID)) return true
    const journal = await read(sessionID)
    return !!(
      journal.activeRunID &&
      journal.activeOwner &&
      (await ProcessIdentity.owns(journal.activeOwner.pid, journal.activeOwner.identity))
    )
  }

  export async function begin(input: {
    sessionID: string
    runID: string
    acceptedAt: number
    effort: "normal" | "ultra"
  }) {
    const active = state().active
    if (active.has(input.sessionID)) throw new ActiveRunError(input.sessionID)
    const identity = await ProcessIdentity.capture(process.pid)
    if (!identity) throw new Error("Could not capture the runtime server process identity")
    const prior = await read(input.sessionID)
    if (
      prior.activeRunID &&
      prior.activeOwner &&
      (await ProcessIdentity.owns(prior.activeOwner.pid, prior.activeOwner.identity))
    ) {
      throw new ActiveRunError(input.sessionID)
    }

    // Reserve synchronously before the durable write so two concurrent HTTP
    // requests cannot both be accepted in the same event-loop turn.
    active.set(input.sessionID, input.runID)
    try {
      const emitted: Event[] = []
      await Storage.upsert<Journal>(key(input.sessionID), (current) => {
        const journal = current ? Journal.parse(current) : empty()
        // Persist ownership as part of the same atomic mutation as acceptance.
        // This rejects overlapping prompts even when two server processes share
        // the same data root.
        if (journal.activeRunID) {
          const sameStaleOwner =
            journal.activeRunID === prior.activeRunID &&
            journal.activeOwner?.pid === prior.activeOwner?.pid &&
            journal.activeOwner?.identity === prior.activeOwner?.identity
          if (!sameStaleOwner) throw new ActiveRunError(input.sessionID)
        }
        let nextSequence = journal.nextSequence
        const events = [...journal.events]
        if (journal.activeRunID) {
          const requested = journal.cancelRequest?.runID === journal.activeRunID ? journal.cancelRequest : undefined
          const recovered = Event.parse({
            sequence: nextSequence++,
            sessionID: input.sessionID,
            runID: journal.activeRunID,
            type: requested ? "runtime.cancelled" : "runtime.failed",
            properties: requested
              ? { source: requested.source, recovered: true }
              : { message: "The runtime server stopped before this run completed.", recovered: true },
            time: Date.now(),
          })
          emitted.push(recovered)
          events.push(recovered)
        }
        const event = Event.parse({
          sequence: nextSequence++,
          sessionID: input.sessionID,
          runID: input.runID,
          type: "runtime.accepted",
          properties: {
            acceptedAt: input.acceptedAt,
            effort: input.effort,
          },
          time: Date.now(),
        })
        emitted.push(event)
        events.push(event)
        return {
          nextSequence,
          events: events.slice(-RETAINED_EVENTS),
          activeRunID: input.runID,
          activeOwner: { pid: process.pid, identity },
        }
      })
      if (!emitted.length) throw new Error("Runtime acceptance did not produce an event")
      for (const event of emitted) await notify(event)
      return emitted.at(-1)!
    } catch (error) {
      if (active.get(input.sessionID) === input.runID) active.delete(input.sessionID)
      throw error
    }
  }

  export async function finish(input: { sessionID: string; runID: string; messageID: string }) {
    try {
      return await terminal({
        ...input,
        type: "runtime.completed",
        properties: { messageID: input.messageID },
      })
    } finally {
      if (state().active.get(input.sessionID) === input.runID) state().active.delete(input.sessionID)
    }
  }

  export async function fail(input: { sessionID: string; runID: string; error: unknown; messageID?: string }) {
    const detail = input.error && typeof input.error === "object" ? (input.error as Record<string, unknown>) : undefined
    const data = detail?.data && typeof detail.data === "object" ? (detail.data as Record<string, unknown>) : undefined
    const message =
      input.error instanceof Error
        ? input.error.message
        : typeof input.error === "string"
          ? input.error
          : typeof data?.message === "string"
            ? data.message
            : JSON.stringify(input.error)
    try {
      return await terminal({
        sessionID: input.sessionID,
        runID: input.runID,
        type: "runtime.failed",
        properties: { message, ...(input.messageID ? { messageID: input.messageID } : {}) },
      })
    } finally {
      if (state().active.get(input.sessionID) === input.runID) state().active.delete(input.sessionID)
    }
  }

  /**
   * Terminalize a runtime only when this process owns it or its durable owner
   * is provably gone. A process sharing the same data root must never release
   * a live sibling's run merely because it can mutate the journal.
   */
  export async function cancel(input: {
    sessionID: string
    source: "user" | "runner_timeout"
    runID?: string
    onCancelled?: () => void
  }): Promise<CancelResult> {
    const active = state().active
    const localRunID = active.get(input.sessionID)
    const journal = await read(input.sessionID)
    const runID = input.runID ?? localRunID ?? journal.activeRunID
    if (!runID || journal.activeRunID !== runID) return { status: "inactive" }

    const identity = await ProcessIdentity.capture(process.pid)
    if (!identity) throw new Error("Could not capture the runtime server process identity")
    const owner = journal.activeOwner
    const localOwner = localRunID === runID && owner?.pid === process.pid && owner.identity === identity
    if (!localOwner && owner && (await ProcessIdentity.owns(owner.pid, owner.identity))) {
      return { status: "foreign_owner", runID }
    }

    try {
      await terminal({
        sessionID: input.sessionID,
        runID,
        type: "runtime.cancelled",
        properties: { source: input.source },
        verifyOwner: true,
        expectedOwner: owner,
        onTerminal: input.onCancelled,
      })
      return { status: "cancelled", runID, owner: localOwner ? "local" : "stale" }
    } finally {
      if (active.get(input.sessionID) === runID) active.delete(input.sessionID)
    }
  }

  /**
   * Request cancellation from the durable owner without releasing its run.
   * The owner polls this journal field; a later process can also honor it once
   * the recorded owner is provably stale.
   */
  export async function requestCancel(input: {
    sessionID: string
    source: "user" | "runner_timeout"
    runID?: string
  }): Promise<CancelResult> {
    const active = state().active.get(input.sessionID)
    const current = await read(input.sessionID)
    const runID = active ?? current.activeRunID
    if (!runID || current.activeRunID !== runID) return { status: "inactive" }
    if (input.runID && input.runID !== runID) return { status: "inactive" }

    const identity = await ProcessIdentity.capture(process.pid)
    if (!identity) throw new Error("Could not capture the runtime server process identity")
    const local =
      active === runID && current.activeOwner?.pid === process.pid && current.activeOwner.identity === identity
    if (
      !local &&
      (!current.activeOwner || !(await ProcessIdentity.owns(current.activeOwner.pid, current.activeOwner.identity)))
    ) {
      return cancel(input)
    }

    let requested = false
    await Storage.upsert<Journal>(key(input.sessionID), (current) => {
      const journal = current ? Journal.parse(current) : empty()
      if (journal.activeRunID !== runID) return journal
      requested = true
      return {
        ...journal,
        cancelRequest:
          journal.cancelRequest?.runID === runID
            ? journal.cancelRequest
            : { runID, source: input.source, requestedAt: Date.now() },
      }
    })
    if (!requested) return { status: "inactive" }
    return local ? { status: "requested", runID } : { status: "forwarded", runID }
  }

  /** Poll only runs owned by this instance for durable cancellation requests. */
  export function watchCancellationRequests(
    handler: (input: { sessionID: string; runID: string; source: "user" | "runner_timeout" }) => Promise<void>,
    pollMs = 100,
  ) {
    let polling = false
    let active = true
    const handled = new Set<string>()
    const poll = async () => {
      if (!active || polling) return
      polling = true
      try {
        for (const [sessionID, runID] of state().active) {
          const request = (await read(sessionID)).cancelRequest
          if (!request || request.runID !== runID) continue
          const key = `${sessionID}\0${runID}`
          if (handled.has(key)) continue
          await handler({ sessionID, runID, source: request.source })
          handled.add(key)
        }
      } finally {
        polling = false
      }
    }
    const timer = setInterval(
      () => void poll().catch((error) => log.error("failed to poll runtime cancellation requests", { error })),
      pollMs,
    )
    ;(timer as { unref?: () => void }).unref?.()
    return {
      async [Symbol.asyncDispose]() {
        active = false
        clearInterval(timer)
        while (polling) await new Promise<void>((resolve) => setTimeout(resolve, 5))
      },
    }
  }

  async function terminal(input: {
    sessionID: string
    runID: string
    type: "runtime.completed" | "runtime.failed" | "runtime.cancelled"
    properties: Record<string, unknown>
    verifyOwner?: boolean
    expectedOwner?: Journal["activeOwner"]
    onTerminal?: () => void
  }) {
    await flushProgress(input.sessionID)
    let event: Event | undefined
    let idempotent = false
    await Storage.upsert<Journal>(key(input.sessionID), (current) => {
      const journal = current ? Journal.parse(current) : empty()
      if (journal.activeRunID !== input.runID) {
        // The run is no longer active. If the other finalization path already
        // recorded a terminal event for this exact run, return that event
        // instead of failing: normal settlement and a cancellation request can
        // race the same run, and both must succeed. A different active run, or
        // no recorded terminal for this run at all, is still a real conflict.
        const recorded = journal.events.findLast((item) => item.runID === input.runID && TERMINAL_TYPES.has(item.type))
        if (!recorded) throw new ActiveRunError(input.sessionID)
        event = recorded
        idempotent = true
        return journal
      }
      if (
        input.verifyOwner &&
        (journal.activeOwner?.pid !== input.expectedOwner?.pid ||
          journal.activeOwner?.identity !== input.expectedOwner?.identity)
      ) {
        throw new ActiveRunError(input.sessionID)
      }
      const requested = journal.cancelRequest?.runID === input.runID ? journal.cancelRequest : undefined
      event = nextEvent(
        journal,
        requested
          ? {
              sessionID: input.sessionID,
              runID: input.runID,
              type: "runtime.cancelled",
              properties: {
                source: requested.source,
                ...(typeof input.properties.messageID === "string" ? { messageID: input.properties.messageID } : {}),
              },
            }
          : input,
      )
      return {
        nextSequence: journal.nextSequence + 1,
        events: [...journal.events, event].slice(-RETAINED_EVENTS),
      }
    })
    if (!event) throw new Error("Runtime completion did not produce an event")
    // An idempotent replay returns the already-recorded (and already-notified)
    // terminal event without re-running teardown or re-delivering it.
    if (idempotent) return event
    if (state().active.get(input.sessionID) === input.runID) state().active.delete(input.sessionID)
    state().progress.delete(input.sessionID)
    input.onTerminal?.()
    return notify(event)
  }

  /** The run this process currently owns for a session, if any. Cancellation
   * coordination uses it to ignore a request whose run is no longer active. */
  export function activeRunID(sessionID: string) {
    return state().active.get(sessionID)
  }

  /** Capture an internal event only while a public runtime run owns the
   * session or one of its ancestors. */
  function captureSessionID(type: string, properties: Record<string, unknown>) {
    const direct = properties.sessionID
    if (typeof direct === "string") return direct

    const nestedKey = type === "message.updated" ? "info" : type === "message.part.updated" ? "part" : undefined
    if (!nestedKey) return
    const nested = properties[nestedKey]
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return
    const sessionID = Reflect.get(nested, "sessionID")
    return typeof sessionID === "string" ? sessionID : undefined
  }

  export async function capture(payload: { type: string; properties: unknown }) {
    const properties = payload.properties
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) return
    const sessionID = captureSessionID(payload.type, properties as Record<string, unknown>)
    if (!sessionID) return
    // A root session's streamed progress must be scheduled in the same
    // event-loop turn as its bus delivery, or its deltas reorder around the
    // run's completion; only a delegated child pays for the ancestor walk.
    const direct = state().active.get(sessionID)
    const run = direct ? { sessionID, runID: direct } : await inherited(sessionID)
    if (!run) return
    // The journal belongs to the run's root session; the event properties keep
    // naming the child session that produced them.
    const input = {
      sessionID: run.sessionID,
      runID: run.runID,
      type: payload.type,
      properties: properties as Record<string, unknown>,
    }
    const streaming = progressInput(input)
    if (streaming) return scheduleProgress(streaming)
    const stream = progress(run.sessionID, run.runID)
    await flushProgress(run.sessionID)
    await queue(stream, async () => {
      await append({ ...input, requireActive: true })
    })
  }

  export async function replay(sessionID: string, afterSequence?: number) {
    await flushProgress(sessionID)
    const journal = await read(sessionID)
    const oldestSequence = journal.events[0]?.sequence ?? journal.nextSequence
    const latestSequence = journal.nextSequence - 1
    if (afterSequence !== undefined) {
      if (afterSequence < oldestSequence - 1) throw new CursorExpiredError(afterSequence, oldestSequence)
      if (afterSequence > latestSequence) throw new CursorAheadError(afterSequence, latestSequence)
    }
    return {
      events:
        afterSequence === undefined ? journal.events : journal.events.filter((event) => event.sequence > afterSequence),
      oldestSequence,
      latestSequence,
    }
  }

  export function subscribe(sessionID: string, subscriber: Subscriber) {
    const subscriptions = state().subscriptions
    const listeners = subscriptions.get(sessionID) ?? new Set<Subscriber>()
    listeners.add(subscriber)
    subscriptions.set(sessionID, listeners)
    return () => {
      listeners.delete(subscriber)
      if (!listeners.size) subscriptions.delete(sessionID)
    }
  }
}
