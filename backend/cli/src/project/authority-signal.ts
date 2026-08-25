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

  const State = z.object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    pending: z.boolean().default(false),
    time: z.number().int().positive(),
    origin: z.number().int().positive(),
    event: Event,
    backlog: PendingEvent.array().default([]),
  })
  type State = z.infer<typeof State>

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
      return {
        version: 1,
        revision: (previous?.revision ?? 0) + 1,
        pending: true,
        time: Date.now(),
        origin: process.pid,
        event: parsed,
        backlog,
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

  /** Poll a tiny revision record. A skipped revision causes a conservative
   * resync signal because the last event alone cannot describe every affected
   * process. The timer is unref'd and disposed with its project instance. */
  export async function watch(handler: (change: Change) => Promise<boolean | void>, pollMs = 200) {
    const initial = await current()
    const firstPending = initial
      ? Math.min(...initial.backlog.map((item) => item.revision), ...(initial.pending ? [initial.revision] : []))
      : Number.POSITIVE_INFINITY
    let revision = Number.isFinite(firstPending) ? Math.max(0, firstPending - 1) : (initial?.revision ?? 0)
    let active = true
    let polling = false
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
          if (item.revision > revision + 1) {
            await handler({ type: "resync", revision: item.revision - 1 })
          }
          const handled = await handler({ type: "event", revision: item.revision, event: item.event })
          if (handled !== false) await settle(item.revision)
          revision = item.revision
        }

        if (next.revision <= revision) return
        const previous = revision
        const change: Change =
          next.revision !== previous + 1
            ? { type: "resync", revision: next.revision }
            : { type: "event", revision: next.revision, event: next.event }
        if (next.origin === process.pid && !next.pending) {
          revision = next.revision
          return
        }
        const handled = await handler(change)
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
      async [Symbol.asyncDispose]() {
        active = false
        clearInterval(timer)
        while (polling) await new Promise<void>((resolve) => setTimeout(resolve, 5))
      },
    }
  }
}
