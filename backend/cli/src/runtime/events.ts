import z from "zod"
import { Instance } from "../project/instance"
import { Storage } from "../storage/storage"
import { Identifier } from "../id/id"
import { ProcessIdentity } from "../process/process-identity"

export namespace RuntimeEvents {
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
  })
  type Journal = z.infer<typeof Journal>

  export const RETAINED_EVENTS = 2_048

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

  type Subscriber = (event: Event) => void | Promise<void>

  const state = Instance.state(() => ({
    active: new Map<string, string>(),
    subscriptions: new Map<string, Set<Subscriber>>(),
  }))

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

  async function notify(event: Event) {
    for (const subscriber of state().subscriptions.get(event.sessionID) ?? []) {
      await subscriber(event)
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
  }): Promise<Event> {
    let event: Event | undefined
    await Storage.upsert<Journal>(key(input.sessionID), (current) => {
      const journal = current ? Journal.parse(current) : empty()
      event = nextEvent(journal, input)
      return {
        ...journal,
        nextSequence: journal.nextSequence + 1,
        events: [...journal.events, event].slice(-RETAINED_EVENTS),
      }
    })
    if (!event) throw new Error("Runtime event append did not produce an event")
    return notify(event)
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
          const recovered = Event.parse({
            sequence: nextSequence++,
            sessionID: input.sessionID,
            runID: journal.activeRunID,
            type: "runtime.failed",
            properties: { message: "The runtime server stopped before this run completed.", recovered: true },
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

  export async function fail(input: { sessionID: string; runID: string; error: unknown }) {
    const message = input.error instanceof Error ? input.error.message : String(input.error)
    try {
      return await terminal({
        sessionID: input.sessionID,
        runID: input.runID,
        type: "runtime.failed",
        properties: { message },
      })
    } finally {
      if (state().active.get(input.sessionID) === input.runID) state().active.delete(input.sessionID)
    }
  }

  async function terminal(input: {
    sessionID: string
    runID: string
    type: "runtime.completed" | "runtime.failed"
    properties: Record<string, unknown>
  }) {
    let event: Event | undefined
    await Storage.upsert<Journal>(key(input.sessionID), (current) => {
      const journal = current ? Journal.parse(current) : empty()
      if (journal.activeRunID !== input.runID) {
        throw new ActiveRunError(input.sessionID)
      }
      event = nextEvent(journal, input)
      return {
        nextSequence: journal.nextSequence + 1,
        events: [...journal.events, event].slice(-RETAINED_EVENTS),
      }
    })
    if (!event) throw new Error("Runtime completion did not produce an event")
    return notify(event)
  }

  /** Capture an internal event only while a public runtime run owns the session. */
  export async function capture(payload: { type: string; properties: unknown }) {
    const properties = payload.properties
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) return
    const sessionID = Reflect.get(properties, "sessionID")
    if (typeof sessionID !== "string") return
    const runID = state().active.get(sessionID)
    if (!runID) return
    await append({
      sessionID,
      runID,
      type: payload.type,
      properties: properties as Record<string, unknown>,
    })
  }

  export async function replay(sessionID: string, afterSequence?: number) {
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
