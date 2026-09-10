import z from "zod"
import path from "node:path"
import { Global } from "@/global"
import { Storage } from "@/storage/storage"
import { FileLease } from "@/util/file-lease"
import { Log } from "@/util/log"

/**
 * Minimal durable authority-change signal shared by every OpenScience process
 * using one data directory. It deliberately stores only routing identifiers —
 * never permission payloads, paths, prompts, or credentials.
 */
export namespace AuthoritySignal {
  const log = Log.create({ service: "authority.signal" })

  export const Event = z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("trust"),
      projectID: z.string(),
      denied: z.boolean(),
    }),
    z.object({
      kind: z.literal("access"),
      projectID: z.string(),
      mode: z.enum(["ask", "approve", "full"]),
      // Older durable records omit this flag. Watchers treat that as a
      // conservative narrowing, while current writers distinguish widening
      // so a Full-access change never tears down healthy work.
      narrowing: z.boolean().optional(),
    }),
    z.object({
      kind: z.literal("filesystem"),
      projectID: z.string(),
      sessionID: z.string(),
      scope: z.enum(["once", "session", "project", "installation"]),
    }),
  ])
  export type Event = z.infer<typeof Event>

  const PendingEvent = z.object({
    revision: z.number().int().positive(),
    event: Event,
  })
  const HistoryEvent = PendingEvent.extend({ origin: z.number().int().positive() })

  const State = z.object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    pending: z.boolean().default(false),
    time: z.number().int().positive(),
    origin: z.number().int().positive(),
    event: Event,
    backlog: PendingEvent.array().default([]),
    // The most recent events with the process that published each, so a
    // watcher that polled past a burst can tell whether what it missed was
    // its own process's settled work (already applied through the in-process
    // bus) or another process's, which still earns the conservative resync.
    history: HistoryEvent.array().default([]),
  })
  type State = z.infer<typeof State>
  const HISTORY = 16

  const key = ["authority", "revision"]
  const lock = () => path.join(Global.Path.data, "authority", "spawn.lock")
  // Governed launches are deliberately serialized against authority changes.
  // A single kernel ready handshake may take up to 15s. FileLease resets this
  // bounded wait only when the exact owner token changes, so healthy parallel
  // launches can advance while one wedged owner still fails closed.
  const spawnOwnerWait = 30_000

  /**
   * Serialize an authority mutation with the final authority check, process
   * creation, and owner registration performed by every runtime. A mutation
   * that wins this lease is durable before a later spawn can proceed; a spawn
   * that wins first is registered before the mutation's revokers run.
   */
  export async function exclusive<T>(action: () => Promise<T>): Promise<T> {
    await using lease = await FileLease.acquire(lock(), spawnOwnerWait)
    // Await inside this lexical scope so `await using` cannot dispose the
    // interprocess lease before the spawn/mutation callback has settled.
    return await lease.during(action)
  }

  async function current() {
    return Storage.read<State>(key)
      .then((value) => State.parse(value))
      .catch((error) => {
        if (Storage.NotFoundError.isInstance(error)) return undefined
        throw error
      })
  }

  export async function publish(event: Event) {
    const parsed = Event.parse(event)
    return Storage.upsert<State>(key, (value) => {
      const previous = value ? State.parse(value) : undefined
      const backlog = [...(previous?.backlog ?? [])]
      if (previous?.pending && !backlog.some((item) => item.revision === previous.revision)) {
        backlog.push({ revision: previous.revision, event: previous.event })
      }
      const revision = (previous?.revision ?? 0) + 1
      return {
        version: 1,
        revision,
        pending: true,
        time: Date.now(),
        origin: process.pid,
        event: parsed,
        backlog,
        history: [...(previous?.history ?? []), { revision, event: parsed, origin: process.pid }].slice(-HISTORY),
      }
    })
  }

  /** Mark one mutation's reaper work complete without erasing a newer event.
   * A process that dies before this acknowledgement leaves `pending=true`, so
   * the next watcher applies the durable denial before accepting new work. */
  export async function settle(revision: number): Promise<void> {
    await Storage.update<State>(key, (draft) => {
      const current = State.parse(draft)
      draft.backlog = current.backlog.filter((item) => item.revision !== revision)
      if (current.revision === revision && current.pending) draft.pending = false
    })
  }

  export async function pending(event: Event): Promise<number | undefined> {
    const expected = Event.parse(event)
    const state = await current()
    if (!state) return
    const matches = [
      ...state.backlog,
      ...(state.pending ? [{ revision: state.revision, event: state.event }] : []),
    ].filter((item) => JSON.stringify(item.event) === JSON.stringify(expected))
    return matches.at(-1)?.revision
  }

  export type Change = { type: "event"; revision: number; event: Event } | { type: "resync"; revision: number }

  /** Whether every revision strictly between two others was published by this
   * process: those events reached every live instance here through the bus
   * and the filesystem broadcast when they happened, so a watcher that only
   * polled past them has nothing left to apply. Unknown or foreign revisions
   * leave the caller to resync. */
  function ownSettledGap(state: State, from: number, to: number) {
    for (let revision = from + 1; revision < to; revision++) {
      const item = state.history.find((entry) => entry.revision === revision)
      if (!item || item.origin !== process.pid) return false
    }
    return true
  }

  /** Poll a tiny revision record. A skipped revision causes a conservative
   * resync signal because the last event alone cannot describe every affected
   * process, unless the record shows the gap to be this process's own settled
   * work. The timer is unref'd and disposed with its project instance. */
  export async function watch(handler: (change: Change) => Promise<boolean | void>, pollMs = 200) {
    const initial = await current()
    const firstPending = initial
      ? Math.min(...initial.backlog.map((item) => item.revision), ...(initial.pending ? [initial.revision] : []))
      : Number.POSITIVE_INFINITY
    let revision = Number.isFinite(firstPending) ? Math.max(0, firstPending - 1) : (initial?.revision ?? 0)
    let active = true
    let polling = false
    // Revisions settled before this watcher looked: our own process's work
    // was applied when it happened; anything else, or anything the history
    // no longer names, earns the resync.
    const catchUp = async (state: State, upTo: number) => {
      if (upTo <= revision + 1 || ownSettledGap(state, revision, upTo)) return
      await handler({ type: "resync", revision: upTo - 1 })
    }
    const poll = async () => {
      if (!active || polling) return
      polling = true
      try {
        const next = await current()
        if (!next || next.revision <= revision) return

        const pending = [...next.backlog, ...(next.pending ? [{ revision: next.revision, event: next.event }] : [])]
          .filter((item) => item.revision > revision)
          .toSorted((a, b) => a.revision - b.revision)
        for (const item of pending) {
          await catchUp(next, item.revision)
          const handled = await handler({ type: "event", revision: item.revision, event: item.event })
          if (handled !== false) await settle(item.revision)
          revision = item.revision
        }

        if (next.revision <= revision) return
        if (next.origin === process.pid && !next.pending) {
          revision = next.revision
          return
        }
        await catchUp(next, next.revision)
        const handled = await handler({ type: "event", revision: next.revision, event: next.event })
        if (next.pending && handled !== false) await settle(next.revision)
        revision = next.revision
      } catch (error) {
        log.error("failed to poll authority revision", { error })
      } finally {
        polling = false
      }
    }
    const timer = setInterval(() => void poll(), pollMs)
    ;(timer as { unref?: () => void }).unref?.()
    return {
      /** One immediate poll, for callers that cannot wait for the timer. */
      poll,
      async [Symbol.asyncDispose]() {
        active = false
        clearInterval(timer)
        while (polling) await new Promise<void>((resolve) => setTimeout(resolve, 5))
      },
    }
  }
}
