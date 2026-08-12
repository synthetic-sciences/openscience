import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "@synsci/ui/context"
import { batch, createEffect, createMemo, createRoot, createSignal, onCleanup, untrack } from "solid-js"
import { useParams } from "@solidjs/router"
import { useSDK } from "./sdk"
import { Persist, persisted } from "@/utils/persist"

export type LocalPTY = {
  id: string
  title: string
  titleNumber: number
  /** Session whose execution authority created this project terminal. */
  sessionID?: string
  rows?: number
  cols?: number
  buffer?: string
  scrollY?: number
}

const MAX_TERMINAL_PROJECTS = 20

type TerminalSession = ReturnType<typeof createProjectTerminalSession>

type TerminalCacheEntry = {
  value: TerminalSession
  dispose: VoidFunction
}

function createProjectTerminalSession(
  sdk: ReturnType<typeof useSDK>,
  dir: string,
  currentSession: () => string | undefined,
  legacySession?: string,
) {
  // Capture the client for this project cache entry. The SDK provider itself
  // is reactive, so reading `sdk.client` later from an old entry could send a
  // cleanup for project A through project B after navigation.
  const client = sdk.client
  const legacy = legacySession ? [`${dir}/terminal/${legacySession}.v1`, `${dir}/terminal.v1`] : [`${dir}/terminal.v1`]

  const numberFromTitle = (title: string) => {
    const match = title.match(/^Terminal (\d+)$/)
    if (!match) return
    const value = Number(match[1])
    if (!Number.isFinite(value) || value <= 0) return
    return value
  }

  const [store, setStore, _, persistenceReady] = persisted(
    Persist.workspace(dir, "terminal", legacy),
    createStore<{
      active?: string
      all: LocalPTY[]
    }>({
      all: [],
    }),
  )

  // The backend PTY list is the authority for process identity. Local
  // persistence carries presentation state (active tab, terminal dimensions,
  // buffered text) across reloads, then this reconciliation drops processes
  // that no longer exist and adopts live ones without manufacturing new IDs.
  const [hydrated, setHydrated] = createSignal(false)
  let hydration: Promise<void> | undefined

  const refresh = () => {
    if (!persistenceReady()) return Promise.resolve()
    if (hydration) return hydration
    setHydrated(false)
    hydration = client.pty
      .list()
      .then((response) => {
        const remote = (response.data ?? []).filter((pty) => pty.status !== "exited")
        const local = new Map(store.all.map((pty) => [pty.id, pty]))
        const next = remote.map((pty, index) => {
          const remembered = local.get(pty.id)
          return {
            ...remembered,
            id: pty.id,
            title: pty.title,
            titleNumber: remembered?.titleNumber ?? numberFromTitle(pty.title) ?? index + 1,
            sessionID: pty.sessionID,
          } satisfies LocalPTY
        })
        batch(() => {
          setStore("all", next)
          if (!next.some((pty) => pty.id === store.active)) setStore("active", next[0]?.id)
        })
      })
      .catch(() => {
        // Keep the persisted project terminals visible while the local server
        // is unavailable. Their sockets surface a precise reconnect state.
      })
      .finally(() => {
        hydration = undefined
        setHydrated(true)
      })
    return hydration
  }

  createEffect(() => {
    if (!persistenceReady()) return
    void refresh()
  })

  const removeExited = (id: string) => {
    if (!store.all.some((x) => x.id === id)) return
    batch(() => {
      setStore(
        "all",
        store.all.filter((x) => x.id !== id),
      )
      if (store.active === id) {
        const remaining = store.all.filter((x) => x.id !== id)
        setStore("active", remaining[0]?.id)
      }
    })
  }
  const unsubExited = sdk.event.on("pty.exited", (event) => removeExited(event.properties.id))
  const unsubDeleted = sdk.event.on("pty.deleted", (event) => removeExited(event.properties.id))
  onCleanup(() => {
    unsubExited()
    unsubDeleted()
  })

  const meta = { migrated: false }

  createEffect(() => {
    if (!persistenceReady()) return
    if (meta.migrated) return
    meta.migrated = true

    setStore("all", (all) => {
      const next = all.map((pty) => {
        const direct = Number.isFinite(pty.titleNumber) && pty.titleNumber > 0 ? pty.titleNumber : undefined
        if (direct !== undefined) return pty
        const parsed = numberFromTitle(pty.title)
        if (parsed === undefined) return pty
        return { ...pty, titleNumber: parsed }
      })
      if (next.every((pty, index) => pty === all[index])) return all
      return next
    })
  })

  return {
    has: (id: string) => store.all.some((pty) => pty.id === id),
    refresh,
    ready: () => persistenceReady() && hydrated(),
    all: createMemo(() => Object.values(store.all)),
    active: createMemo(() => store.active),
    new(opts?: { title?: string }) {
      const session = currentSession()
      if (!session || session === "new") {
        return Promise.reject(new Error("Create or open a session before starting a terminal."))
      }
      const existingTitleNumbers = new Set(
        store.all.flatMap((pty) => {
          const direct = Number.isFinite(pty.titleNumber) && pty.titleNumber > 0 ? pty.titleNumber : undefined
          if (direct !== undefined) return [direct]
          const parsed = numberFromTitle(pty.title)
          if (parsed === undefined) return []
          return [parsed]
        }),
      )

      const nextNumber =
        Array.from({ length: existingTitleNumbers.size + 1 }, (_, index) => index + 1).find(
          (number) => !existingTitleNumbers.has(number),
        ) ?? 1

      return client.pty
        .create({
          sessionID: session,
          title: opts?.title ?? `Terminal ${nextNumber}`,
        })
        .then((pty) => {
          const id = pty.data?.id
          if (!id) return
          const newTerminal = {
            id,
            title: pty.data?.title ?? "Terminal",
            titleNumber: nextNumber,
            sessionID: pty.data?.sessionID ?? session,
          }
          setStore("all", (all) => {
            const newAll = [...all, newTerminal]
            return newAll
          })
          setStore("active", id)
          return newTerminal
        })
        .catch((e) => {
          console.error("Failed to create terminal", e)
          throw e
        })
    },
    update(pty: Partial<LocalPTY> & { id: string }) {
      const index = store.all.findIndex((x) => x.id === pty.id)
      if (index !== -1) {
        setStore("all", index, (existing) => ({ ...existing, ...pty }))
      }
      client.pty
        .update({
          ptyID: pty.id,
          title: pty.title,
          size: pty.cols && pty.rows ? { rows: pty.rows, cols: pty.cols } : undefined,
        })
        .catch((e) => {
          console.error("Failed to update terminal", e)
        })
    },
    async clone(id: string) {
      const index = store.all.findIndex((x) => x.id === id)
      const pty = store.all[index]
      if (!pty) return
      const session = currentSession()
      if (!session || session === "new") {
        throw new Error("Create or open a session before reconnecting a terminal.")
      }
      const clone = await client.pty.create({
        sessionID: session,
        title: pty.title,
      })
      if (!clone.data) throw new Error("The server did not return a replacement terminal.")

      const active = store.active === pty.id
      const replacement = {
        id: clone.data.id,
        title: clone.data.title ?? pty.title,
        titleNumber: pty.titleNumber,
        sessionID: clone.data.sessionID ?? session,
      }

      batch(() => {
        setStore("all", index, replacement)
        if (active) {
          setStore("active", clone.data.id)
        }
      })
      await client.pty.remove({ ptyID: pty.id }).catch((error) => {
        console.error("Failed to close replaced terminal", error)
      })
      return replacement
    },
    open(id: string) {
      setStore("active", id)
    },
    next() {
      const index = store.all.findIndex((x) => x.id === store.active)
      if (index === -1) return
      const nextIndex = (index + 1) % store.all.length
      setStore("active", store.all[nextIndex]?.id)
    },
    previous() {
      const index = store.all.findIndex((x) => x.id === store.active)
      if (index === -1) return
      const prevIndex = index === 0 ? store.all.length - 1 : index - 1
      setStore("active", store.all[prevIndex]?.id)
    },
    async close(id: string) {
      batch(() => {
        const filtered = store.all.filter((x) => x.id !== id)
        if (store.active === id) {
          const index = store.all.findIndex((f) => f.id === id)
          const next = index > 0 ? index - 1 : 0
          setStore("active", filtered[next]?.id)
        }
        setStore("all", filtered)
      })

      await client.pty.remove({ ptyID: id }).catch((e) => {
        console.error("Failed to close terminal", e)
      })
    },
    move(id: string, to: number) {
      const index = store.all.findIndex((f) => f.id === id)
      if (index === -1) return
      setStore(
        "all",
        produce((all) => {
          all.splice(to, 0, all.splice(index, 1)[0])
        }),
      )
    },
  }
}

export const { use: useTerminal, provider: TerminalProvider } = createSimpleContext({
  name: "Terminal",
  gate: false,
  init: () => {
    const sdk = useSDK()
    const params = useParams()
    const cache = new Map<string, TerminalCacheEntry>()

    const disposeAll = () => {
      for (const entry of cache.values()) {
        entry.dispose()
      }
      cache.clear()
    }

    onCleanup(disposeAll)

    const prune = () => {
      while (cache.size > MAX_TERMINAL_PROJECTS) {
        const first = cache.keys().next().value
        if (!first) return
        const entry = cache.get(first)
        entry?.dispose()
        cache.delete(first)
      }
    }

    const load = (dir: string) => {
      const key = dir
      const existing = cache.get(key)
      if (existing) {
        cache.delete(key)
        cache.set(key, existing)
        void existing.value.refresh()
        return existing.value
      }

      const entry = createRoot((dispose) => ({
        value: createProjectTerminalSession(
          sdk,
          dir,
          () => params.id,
          untrack(() => params.id),
        ),
        dispose,
      }))

      cache.set(key, entry)
      prune()
      return entry.value
    }

    // Session navigation changes only the accessor used for future mutations.
    // The project registry, PTY objects, mounted terminal emulators, and their
    // WebSockets retain identity until the project itself changes.
    const workspace = createMemo(() => load(sdk.scope))
    const owner = (id: string) => Array.from(cache.values()).find((entry) => entry.value.has(id))?.value ?? workspace()

    return {
      ready: () => workspace().ready(),
      all: () => workspace().all(),
      active: () => workspace().active(),
      new: (opts?: { title?: string }) => workspace().new(opts),
      update: (pty: Partial<LocalPTY> & { id: string }) => owner(pty.id).update(pty),
      clone: (id: string) => owner(id).clone(id),
      open: (id: string) => owner(id).open(id),
      close: (id: string) => owner(id).close(id),
      move: (id: string, to: number) => owner(id).move(id, to),
      next: () => workspace().next(),
      previous: () => workspace().previous(),
    }
  },
})
