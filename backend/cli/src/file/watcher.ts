import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import z from "zod"
import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { FileIgnore } from "./ignore"
import { Config } from "../config/config"
import path from "path"
// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import { lazy } from "@/util/lazy"
import { withTimeout } from "@/util/timeout"
import type ParcelWatcher from "@parcel/watcher"
import { $ } from "bun"
import { Flag } from "@/flag/flag"
import { readdir } from "fs/promises"
import { Global } from "@/global"

const SUBSCRIBE_TIMEOUT_MS = 10_000
const EVENT_FLUSH_MS = 100
const MAX_PRECISE_EVENTS = 64

declare const OPENSCIENCE_LIBC: string | undefined

type Backend = "windows" | "fs-events" | "inotify"

type RootSubscription = {
  owners: Set<string>
  ready: Promise<ParcelWatcher.AsyncSubscription | undefined>
  subscription?: ParcelWatcher.AsyncSubscription
}

type WatcherState = {
  watcher?: typeof import("@parcel/watcher")
  backend?: Backend
  ignores: string[]
  roots: Map<string, RootSubscription>
  owners: Map<string, Set<string>>
  pending: Map<string, { file: string; event: "add" | "change" | "unlink" }>
  dirtyRoots: Set<string>
  overflow: boolean
  flush?: ReturnType<typeof setTimeout>
  lastErrorAt: number
}

/**
 * Watch only explicit directory roots and never turn the filesystem root into
 * a recursive subscription. The latter can happen through a malformed legacy
 * grant and would be both noisy and expensive.
 */
export function normalizeWatchRoots(roots: string[], options: { home?: string; data?: string } = {}) {
  const home = path.resolve(options.home ?? Global.Path.home)
  const data = path.resolve(options.data ?? Global.Path.data)
  const unsafe = new Set([home, data, path.join(home, "Library")])
  return [...new Set(roots.filter(Boolean).map((root) => path.resolve(root)))].filter((root) => {
    if (path.parse(root).root === root) return false
    // The server's unscoped landing request runs in $HOME. It is a launcher
    // instance, not a project, and recursively watching it consumes Library,
    // browser, cache, and package-manager churn. The data root is similarly an
    // implementation directory. Narrow descendants (a real managed project or
    // session workspace) remain valid explicit roots.
    return !unsafe.has(root)
  })
}

/** A normal project is a live file source whether or not it has Git metadata. */
export function projectWatchRoots(input: { directory: string; vcs?: "git" }) {
  return normalizeWatchRoots([input.directory])
}

export namespace FileWatcher {
  const log = Log.create({ service: "file.watcher" })

  export const Event = {
    Updated: BusEvent.define(
      "file.watcher.updated",
      z.object({
        file: z.string(),
        event: z.union([z.literal("add"), z.literal("change"), z.literal("unlink")]),
      }),
    ),
  }

  const watcher = lazy((): typeof import("@parcel/watcher") | undefined => {
    try {
      const binding = require(
        `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? `-${OPENSCIENCE_LIBC || "glibc"}` : ""}`,
      )
      return createWrapper(binding) as typeof import("@parcel/watcher")
    } catch (error) {
      log.error("failed to load watcher binding", { error })
      return
    }
  })

  function mergeEvent(current: "add" | "change" | "unlink" | undefined, next: "add" | "change" | "unlink") {
    if (!current || current === next) return next
    if (current === "add" && next === "change") return "add"
    // A create/delete or delete/create pair still means the containing source
    // changed, but neither transient edge should be replayed as final truth.
    if ((current === "add" && next === "unlink") || (current === "unlink" && next === "add")) return "change"
    return next
  }

  async function flush(state: WatcherState) {
    state.flush = undefined
    const updates = state.overflow
      ? [...state.dirtyRoots].map((file) => ({ file, event: "add" as const }))
      : [...state.pending.values()]
    state.pending.clear()
    state.dirtyRoots.clear()
    state.overflow = false
    for (const update of updates) await Bus.publish(Event.Updated, update)
  }

  function schedule(state: WatcherState) {
    if (state.flush) return
    state.flush = setTimeout(() => void flush(state), EVENT_FLUSH_MS)
  }

  function callback(state: WatcherState, root: string): ParcelWatcher.SubscribeCallback {
    return (error, events) => {
      if (error) {
        const now = Date.now()
        if (now - state.lastErrorAt >= 30_000) {
          state.lastErrorAt = now
          log.warn("watcher callback failed; scheduling a source refresh", { root, error })
        }
        state.overflow = true
        state.pending.clear()
        state.dirtyRoots.add(root)
        schedule(state)
        return
      }

      state.dirtyRoots.add(root)
      for (const item of events) {
        if (state.overflow) break
        const event = item.type === "create" ? "add" : item.type === "delete" ? "unlink" : "change"
        state.pending.set(item.path, {
          file: item.path,
          event: mergeEvent(state.pending.get(item.path)?.event, event),
        })
        if (state.pending.size > MAX_PRECISE_EVENTS) {
          state.pending.clear()
          state.overflow = true
        }
      }
      schedule(state)
    }
  }

  async function addRoot(state: WatcherState, root: string, owner: string, ignores = state.ignores) {
    const existing = state.roots.get(root)
    if (existing) {
      existing.owners.add(owner)
      await existing.ready
      return
    }
    if (!state.watcher || !state.backend) return

    const entry: RootSubscription = {
      owners: new Set([owner]),
      ready: Promise.resolve(undefined),
    }
    const pending = state.watcher.subscribe(root, callback(state, root), {
      ignore: [...FileIgnore.PATTERNS, ...ignores],
      backend: state.backend,
    })
    entry.ready = withTimeout(pending, SUBSCRIBE_TIMEOUT_MS).catch((error) => {
      log.error("failed to subscribe to file root", { root, owner, error })
      pending.then((subscription) => subscription.unsubscribe()).catch(() => {})
      return undefined
    })
    state.roots.set(root, entry)
    const subscription = await entry.ready
    entry.subscription = subscription
    if (!subscription || entry.owners.size === 0) {
      if (state.roots.get(root) === entry) state.roots.delete(root)
      await subscription?.unsubscribe().catch(() => {})
    }
  }

  async function removeRoot(state: WatcherState, root: string, owner: string) {
    const entry = state.roots.get(root)
    if (!entry) return
    entry.owners.delete(owner)
    if (entry.owners.size > 0) return
    if (state.roots.get(root) === entry) state.roots.delete(root)
    const subscription = entry.subscription ?? (await entry.ready)
    await subscription?.unsubscribe().catch(() => {})
  }

  async function reconcile(state: WatcherState, owner: string, roots: string[]) {
    const desired = new Set(normalizeWatchRoots(roots))
    const previous = state.owners.get(owner) ?? new Set<string>()
    state.owners.set(owner, desired)
    await Promise.all([...previous].filter((root) => !desired.has(root)).map((root) => removeRoot(state, root, owner)))
    // Call addRoot for every desired root, not only new ones: a native backend
    // that was temporarily unavailable can recover on the next snapshot.
    await Promise.all([...desired].map((root) => addRoot(state, root, owner)))
  }

  const state = Instance.state(
    async (): Promise<WatcherState> => {
      log.info("init")
      const cfg = await Config.get()
      const backend = (() => {
        if (process.platform === "win32") return "windows"
        if (process.platform === "darwin") return "fs-events"
        if (process.platform === "linux") return "inotify"
      })() as Backend | undefined
      const result: WatcherState = {
        watcher: backend ? watcher() : undefined,
        backend,
        ignores: cfg.watcher?.ignore ?? [],
        roots: new Map(),
        owners: new Map(),
        pending: new Map(),
        dirtyRoots: new Set(),
        overflow: false,
        lastErrorAt: 0,
      }
      if (!backend) {
        log.error("watcher backend not supported", { platform: process.platform })
        return result
      }
      log.info("watcher backend", { platform: process.platform, backend })
      if (!result.watcher) return result

      // Managed projects are intentionally non-Git. They still back the Files
      // pane and must be watched exactly like repository projects.
      await reconcile(
        result,
        "project",
        projectWatchRoots({ directory: Instance.directory, vcs: Instance.project.vcs }),
      )

      // Git metadata is a separate, narrow subscription used for branch/HEAD
      // updates. Ordinary file refresh no longer depends on this path existing.
      if (Instance.project.vcs === "git") {
        const vcsDir = await $`git rev-parse --git-dir`
          .quiet()
          .nothrow()
          .cwd(Instance.worktree)
          .text()
          .then((value) => path.resolve(Instance.worktree, value.trim()))
          .catch(() => undefined)
        if (vcsDir && !result.ignores.includes(".git") && !result.ignores.includes(vcsDir)) {
          const contents = await readdir(vcsDir).catch(() => [])
          await addRoot(
            result,
            vcsDir,
            "vcs",
            contents.filter((entry) => entry !== "HEAD"),
          )
        }
      }
      return result
    },
    async (current) => {
      if (current.flush) clearTimeout(current.flush)
      current.flush = undefined
      current.pending.clear()
      current.dirtyRoots.clear()
      const subscriptions = [...current.roots.values()]
      current.roots.clear()
      current.owners.clear()
      await Promise.all(
        subscriptions.map(async (entry) => {
          entry.owners.clear()
          const subscription = entry.subscription ?? (await entry.ready)
          await subscription?.unsubscribe().catch(() => {})
        }),
      )
    },
  )

  /** Reconcile the scratch and connected roots displayed for one session. */
  export async function watchSession(sessionID: string, roots: string[]) {
    if (Flag.OPENSCIENCE_EXPERIMENTAL_DISABLE_FILEWATCHER) return
    await reconcile(await state(), `session:${sessionID}`, roots)
  }

  export async function unwatchSession(sessionID: string) {
    if (Flag.OPENSCIENCE_EXPERIMENTAL_DISABLE_FILEWATCHER) return
    await reconcile(await state(), `session:${sessionID}`, [])
  }

  export function init() {
    if (Flag.OPENSCIENCE_EXPERIMENTAL_DISABLE_FILEWATCHER) return
    void state().catch((error) => log.error("failed to initialize file watcher", { error }))
  }
}
