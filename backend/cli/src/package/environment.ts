import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Global } from "../global"

/**
 * Environment state. No process spawning lives here — the installer owns that.
 *
 * The manifest is the source of truth and the directory is derived, therefore a
 * cache. That is why they sit in different roots: `Global.Path.cache` may be
 * cleared by the user or a cleaner at any time, and an environment must be
 * rebuildable from its manifest afterwards. Putting the manifest inside the
 * directory would make a cache clean an unrecoverable data loss.
 */
export namespace Environment {
  export const Language = z.enum(["python", "r"])
  export type Language = z.infer<typeof Language>

  export const Record = z.object({
    name: z.string(),
    language: Language,
    /** Only what was explicitly asked for, never the resolved closure. */
    requested: z.array(z.string()).default([]),
    /** Resolved name → version, as the installer reported it after the fact. */
    installed: z.record(z.string(), z.string()).default({}),
    /** Size of the resolved closure, reported as a number rather than listed. */
    total: z.number().int().nonnegative().default(0),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  export type Record = z.infer<typeof Record>

  export function manifest(projectID: string, name: string) {
    return path.join(Global.Path.data, "envs", projectID, `${name}.json`)
  }

  export function directory(projectID: string, name: string) {
    return path.join(Global.Path.cache, "envs", projectID, name)
  }

  export async function read(projectID: string, name: string) {
    const file = Bun.file(manifest(projectID, name))
    if (!(await file.exists())) return undefined
    const parsed = Record.safeParse(await file.json().catch(() => undefined))
    return parsed.success ? parsed.data : undefined
  }

  /**
   * Write the manifest, validating first.
   *
   * The parse is not ceremony. `JSON.stringify` drops keys whose value is
   * `undefined`, so a caller that omits one — a tool invoked without zod
   * having applied its defaults, say — writes a manifest that `read` then
   * rejects. The result is an environment that exists on disk, holds installed
   * packages, and is invisible to the inventory: silent, and indistinguishable
   * from "never created" at every call site. Validating here turns that into a
   * loud failure at the moment of the mistake.
   */
  export async function write(projectID: string, value: Record) {
    const parsed = Record.safeParse(value)
    if (!parsed.success) {
      throw new Error(
        `Refusing to write an unreadable environment manifest for ${value.name}: ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
          .join("; ")}`,
      )
    }
    const file = manifest(projectID, parsed.data.name)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await Bun.write(file, JSON.stringify(parsed.data, null, 2))
  }

  /** Every environment for a project. A manifest that fails to parse is skipped
   *  rather than thrown on: one hand-edited or half-written file must not make
   *  every other environment in the project invisible. */
  export async function list(projectID: string) {
    const dir = path.join(Global.Path.data, "envs", projectID)
    const names = await fs.readdir(dir).catch(() => [] as string[])
    const values = await Promise.all(
      names.filter((n) => n.endsWith(".json")).map((n) => read(projectID, n.slice(0, -".json".length))),
    )
    return values.filter((v): v is Record => Boolean(v))
  }

  /**
   * Purely additive means every package present before is present after at the
   * same version.
   *
   * Additive changes leave a live kernel correct: a new module imports on first
   * use. Any removal, downgrade or version change does not — a module already
   * loaded into the interpreter stays at the old version in memory while the
   * files on disk say otherwise, which is worse than an obvious failure because
   * it is silent. That asymmetry is the whole reason this function exists
   * rather than restarting on every install.
   */
  export function additive(before: Record["installed"], after: Record["installed"]) {
    return Object.entries(before).every(([name, version]) => after[name] === version)
  }

  /**
   * A persisted record that an installer is working on this environment, with
   * enough identity to tell "still running" from "died mid-install" after a CLI
   * restart. pid alone is not enough — pids are reused — so the platform start
   * token rides along, the same guard `science/kernel/process.ts` already
   * applies to kernels. The token is optional because it does not exist on
   * every platform.
   *
   * Under `Global.Path.state`, not `data`: this is per-machine liveness, not
   * something to survive a restore onto another machine.
   */
  const Claim = z.object({
    pid: z.number().int(),
    token: z.string().optional(),
    startedAt: z.number(),
    /** Set when the install finished and FAILED. A claim carrying this is no
     *  longer about liveness — the process is gone and we know why. */
    error: z.string().optional(),
  })

  export function claimPath(projectID: string, name: string) {
    return path.join(Global.Path.state, "envs", projectID, `${name}.claim.json`)
  }

  export async function claim(projectID: string, name: string, pid: number, value?: string) {
    const file = claimPath(projectID, name)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await Bun.write(file, JSON.stringify({ pid, token: value, startedAt: Date.now() }))
  }

  export async function release(projectID: string, name: string) {
    await fs.rm(claimPath(projectID, name), { force: true })
  }

  /**
   * Record that a detached install failed.
   *
   * Without this a `wait: false` failure vanished: the error was caught and
   * discarded, no manifest was written, the claim was released cleanly, and the
   * agent had been told "started installing" with no way to ever learn
   * otherwise. Replacing the claim rather than deleting it keeps one file as
   * the single place an unfinished install is described, whatever became of it.
   */
  export async function fail(projectID: string, name: string, message: string) {
    const file = claimPath(projectID, name)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await Bun.write(file, JSON.stringify({ pid: process.pid, startedAt: Date.now(), error: message.slice(0, 2000) }))
  }

  /**
   * Resolve every outstanding claim for a project.
   *
   * An install that cannot be proven still running is `unknown`, never `fine`:
   * pip has no transactions, so an interrupted one may have left a partial
   * tree, and silently trusting it turns into a mystery ImportError several
   * turns later. "Cannot prove" means the process is gone, or a token that was
   * captured no longer matches — NOT merely that no token exists, which is the
   * ordinary case on Windows.
   *
   * Resolved claims are deleted so a second call does not re-report them; a
   * still-running one is left in place, because it is still true.
   */
  export async function reconcile(projectID: string) {
    const { KernelProcessIdentity } = await import("../science/kernel/process")
    const dir = path.join(Global.Path.state, "envs", projectID)
    const names = await fs.readdir(dir).catch(() => [] as string[])
    const out: { name: string; outcome: "running" | "unknown" | "failed"; message?: string }[] = []
    for (const file of names.filter((n) => n.endsWith(".claim.json"))) {
      const name = file.slice(0, -".claim.json".length)
      const parsed = Claim.safeParse(
        await Bun.file(path.join(dir, file))
          .json()
          .catch(() => undefined),
      )
      if (!parsed.success) {
        await fs.rm(path.join(dir, file), { force: true })
        out.push({ name, outcome: "unknown" })
        continue
      }
      // A recorded failure is not a liveness question — the process is gone and
      // the reason is known, so report it and clear it.
      if (parsed.data.error) {
        await fs.rm(path.join(dir, file), { force: true })
        out.push({ name, outcome: "failed", message: parsed.data.error })
        continue
      }
      const alive = KernelProcessIdentity.running(parsed.data.pid, parsed.data.token)
      if (!alive) await fs.rm(path.join(dir, file), { force: true })
      out.push({ name, outcome: alive ? "running" : "unknown" })
    }
    return out
  }

  const held = new Map<string, Promise<unknown>>()

  const slot = (projectID: string, name: string) => `${projectID} ${name}`

  /** True while something holds this environment's lock. */
  export function busy(projectID: string, name: string) {
    return held.has(slot(projectID, name))
  }

  /**
   * Serialise work per environment. Other environments stay fully usable — the
   * lock is per-env precisely so one long install does not stop every kernel in
   * the project.
   *
   * The chain is built from the previous entry rather than awaited in place, so
   * a caller arriving mid-install queues instead of racing. `previous.then(fn,
   * fn)` runs the next body whether the one before it resolved or rejected: a
   * failed install must not cancel the work queued behind it. The slot is
   * cleared only if it is still ours, so a later waiter that replaced it is not
   * evicted — and it is cleared in a `finally`, because a lock that survives a
   * throw would brick the environment for the process lifetime, which is the
   * latching bug the egress runtime shipped with.
   */
  export async function lock<T>(projectID: string, name: string, fn: () => Promise<T>): Promise<T> {
    const id = slot(projectID, name)
    const previous = held.get(id) ?? Promise.resolve()
    const run = previous.then(fn, fn)
    const tracked = run.catch(() => undefined)
    held.set(id, tracked)
    try {
      return await run
    } finally {
      if (held.get(id) === tracked) held.delete(id)
    }
  }
}
