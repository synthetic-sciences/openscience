import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../global"
import { FileLease } from "../util/file-lease"
import { Log } from "../util/log"
import { DataRootBarrier } from "../global/data-root-barrier"

/**
 * Cross-process credential revision barrier.
 *
 * OpenScience commonly has two live servers (the installed build and a dev
 * build) sharing one data directory. Environment variables and child-process
 * environments are process-local snapshots, so changing a credential in one
 * server must invalidate the other server before it can launch more work.
 *
 * Writers publish an `updating` marker before touching a credential store and
 * a `ready` marker after the durable write. Readers check this marker at every
 * credential-bearing spawn boundary. Seeing `updating` blocks the spawn; seeing
 * a new ready token refreshes process-local state and revokes children that may
 * have inherited the previous snapshot.
 */
export namespace CredentialLifecycle {
  const log = Log.create({ service: "credential-lifecycle" })
  const revisionFile = path.join(Global.Path.data, "credential-revision.json")
  const mutationLock = `${revisionFile}.lock`
  const waitTimeout = 10_000
  // Telemetry can hold this boundary across a bounded deletion proof (5s),
  // consent sync (5s), and batch upload (10s). Account replacement, opt-out,
  // and process admission must outwait that valid sequence rather than fail at
  // FileLease's 10s default.
  const mutationLeaseTimeout = 30_000

  type Phase = "updating" | "ready"
  interface Revision {
    version: 1
    token: string
    phase: Phase
    reason: string
    pid: number
    updated_at: string
  }

  export interface Event {
    token: string
    reason: string
    pid: number
  }

  type Handler = (event: Event) => void | Promise<void>
  const refreshers = new Set<Handler>()
  const revokers = new Set<Handler>()
  let seen: string | null | undefined
  let checking: Promise<boolean> | undefined
  let reconciliation: Promise<void> = Promise.resolve()
  let timer: ReturnType<typeof setInterval> | undefined
  const retry: {
    progress?: { token: string; refreshers: Set<Handler>; revokers: Set<Handler> }
    retryAt: number
    retryDelay: number
  } = { retryAt: 0, retryDelay: 250 }

  function parse(value: unknown): Revision {
    if (!value || typeof value !== "object") throw new Error("credential revision is not an object")
    const item = value as Partial<Revision>
    if (
      item.version !== 1 ||
      typeof item.token !== "string" ||
      !item.token ||
      (item.phase !== "updating" && item.phase !== "ready") ||
      typeof item.reason !== "string" ||
      typeof item.pid !== "number" ||
      typeof item.updated_at !== "string"
    ) {
      throw new Error("credential revision has an invalid shape")
    }
    return item as Revision
  }

  async function read(): Promise<Revision | null> {
    const text = await fs.readFile(revisionFile, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (text === undefined) return null
    return parse(JSON.parse(text))
  }

  async function publish(revision: Revision): Promise<void> {
    await using operation = await DataRootBarrier.enter(revisionFile)
    const temp = `${revisionFile}.${process.pid}.${crypto.randomUUID()}.tmp`
    await fs.mkdir(path.dirname(revisionFile), { recursive: true })
    const handle = await fs.open(temp, "wx", 0o600)
    await handle
      .chmod(0o600)
      .then(() => handle.writeFile(JSON.stringify(revision, null, 2), "utf8"))
      .then(() => handle.sync())
      .finally(() => handle.close())
      .catch(async (error) => {
        await fs.rm(temp, { force: true }).catch(() => undefined)
        throw error
      })
    await fs.rename(temp, revisionFile).catch(async (error) => {
      await fs.rm(temp, { force: true }).catch(() => undefined)
      throw error
    })
    const directory = await fs.open(path.dirname(revisionFile), "r").catch(() => undefined)
    await directory?.sync().catch(() => undefined)
    await directory?.close().catch(() => undefined)
  }

  async function waitUntilReady(initial: Revision): Promise<Revision> {
    let current = initial
    const started = Date.now()
    while (current.phase === "updating") {
      if (Date.now() - started >= waitTimeout) {
        throw new Error(
          `Credential mutation ${current.token} did not finish; refusing to launch a process with an unverified credential snapshot`,
        )
      }
      await Bun.sleep(15)
      const next = await read()
      if (!next) throw new Error("Credential revision disappeared while a mutation was in progress")
      current = next
    }
    return current
  }

  async function run(handlers: Set<Handler>, complete: Set<Handler>, event: Event): Promise<void> {
    const pending = [...handlers].filter((handler) => !complete.has(handler))
    const results = await Promise.allSettled(pending.map((handler) => handler(event)))
    const failures = results.flatMap((result, index) => {
      if (result.status === "rejected") return [result.reason]
      complete.add(pending[index]!)
      return []
    })
    if (failures.length) throw new AggregateError(failures, "Credential invalidation did not complete")
  }

  async function reconcile(revision: Revision, local = false): Promise<boolean> {
    const task = reconciliation.then(async () => {
      if (!local && seen === revision.token) return false
      const event = { token: revision.token, reason: revision.reason, pid: revision.pid }
      const current =
        retry.progress?.token === revision.token
          ? retry.progress
          : { token: revision.token, refreshers: new Set<Handler>(), revokers: new Set<Handler>() }
      retry.progress = current
      await run(refreshers, current.refreshers, event)
      await run(revokers, current.revokers, event)
      seen = revision.token
      retry.progress = undefined
      return true
    })
    reconciliation = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  /** Register process-local state that must be reloaded before any new child. */
  export function onRefresh(handler: Handler): () => void {
    refreshers.add(handler)
    return () => refreshers.delete(handler)
  }

  /** Register long-lived children/caches that inherited the old snapshot. */
  export function onRevoke(handler: Handler): () => void {
    revokers.add(handler)
    return () => revokers.delete(handler)
  }

  /** Serialize credential-adjacent metadata writes without publishing a revision. */
  export async function serialized<T>(action: () => T | Promise<T>): Promise<T> {
    await using lease = await FileLease.acquire(mutationLock, mutationLeaseTimeout)
    return await lease.during(async () => {
      return await action()
    })
  }

  /** Hold the cross-process mutation lease from freshness check through child
   * spawn and durable owner registration, closing the snapshot-to-spawn race. */
  export async function admit<T>(action: () => T | Promise<T>): Promise<T> {
    await using lease = await FileLease.acquire(mutationLock, mutationLeaseTimeout)
    return await lease.during(async () => {
      await ensureFresh()
      return await action()
    })
  }

  /**
   * Check the durable revision. A first call with an existing marker also
   * reconciles: another server may have committed between module preload and
   * server startup. Failures block the caller.
   */
  export async function ensureFresh(): Promise<boolean> {
    if (checking) return checking
    checking = (async () => {
      const current = await read()
      if (!current) {
        if (seen === undefined) seen = null
        return false
      }
      const ready = await waitUntilReady(current)
      if (seen === undefined) {
        return reconcile(ready, true)
      }
      if (seen === ready.token) return false
      return reconcile(ready)
    })().finally(() => {
      checking = undefined
    })
    return checking
  }

  async function runMutation<T>(
    reason: string,
    action: () => T | Promise<T>,
    options: { reconcileLocal?: boolean } = {},
    condition?: () => boolean | Promise<boolean>,
  ): Promise<{ applied: false } | { applied: true; value: T }> {
    let ready: Revision | undefined
    let value: T | undefined
    let failure: unknown
    let failed = false
    {
      await using lease = await FileLease.acquire(mutationLock, mutationLeaseTimeout)
      await lease.during(async () => {
        // Evaluate the condition under the same lease as the mutation. This
        // is the compare-and-mutate seam for account-key revocation: a late
        // response for key A cannot clear key B after B has been saved.
        if (condition && !(await condition())) return
        const token = crypto.randomUUID()
        const base = {
          version: 1 as const,
          token,
          reason,
          pid: process.pid,
        }
        await publish({ ...base, phase: "updating", updated_at: new Date().toISOString() })

        try {
          value = await action()
        } catch (error) {
          failed = true
          failure = error
        }

        ready = { ...base, phase: "ready", updated_at: new Date().toISOString() }
        await publish(ready)
      })
    }

    if (!ready) return { applied: false }
    if (options.reconcileLocal === false) seen = ready.token
    else await reconcile(ready, true)
    if (failed) throw failure
    return { applied: true, value: value as T }
  }

  /**
   * Serialize and publish a credential-bearing mutation. The updating marker
   * is visible before `action` runs, closing the store-write/revision race.
   */
  export async function mutate<T>(
    reason: string,
    action: () => T | Promise<T>,
    options: { reconcileLocal?: boolean } = {},
  ): Promise<T> {
    const result = await runMutation(reason, action, options)
    if (!result.applied) throw new Error("unconditional credential mutation was not applied")
    return result.value
  }

  /** Compare-and-mutate under the credential lease. A false condition does
   * not publish a revision or invoke refresh/revoke handlers. */
  export async function mutateIf<T>(
    reason: string,
    condition: () => boolean | Promise<boolean>,
    action: () => T | Promise<T>,
    options: { reconcileLocal?: boolean } = {},
  ): Promise<{ applied: false } | { applied: true; value: T }> {
    return runMutation(reason, action, options, condition)
  }

  /** Start a low-cost process-local watcher; spawn boundaries still check synchronously. */
  export function watch(interval = 100): () => void {
    if (!timer) {
      void ensureFresh().catch((error) => log.warn("credential revision baseline failed", { error }))
      timer = setInterval(
        () => {
          if (Date.now() < retry.retryAt) return
          void ensureFresh().then(
            () => {
              retry.retryAt = 0
              retry.retryDelay = 250
            },
            (error) => {
              retry.retryAt = Date.now() + retry.retryDelay
              retry.retryDelay = Math.min(5_000, retry.retryDelay * 2)
              log.error("credential revision reconciliation failed", { error })
            },
          )
        },
        Math.max(25, interval),
      )
      timer.unref()
    }
    return stopWatching
  }

  export function stopWatching(): void {
    if (timer) clearInterval(timer)
    timer = undefined
    retry.retryAt = 0
    retry.retryDelay = 250
  }

  /** Exposed for narrow integration tests and sandbox deny-list construction. */
  export function revisionPath(): string {
    return revisionFile
  }
}
