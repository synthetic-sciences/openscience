import { batch, createMemo } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Binary } from "@synsci/util/binary"
import { retry } from "@synsci/util/retry"
import { createSimpleContext } from "@synsci/ui/context"
import { useGlobalSync } from "./global-sync"
import { useSDK } from "./sdk"
import { SESSION_MESSAGE_CHUNK, mergeHydratedMessages, sessionHydrationPlan } from "./session-hydration"
import type { Message, Part } from "@synsci/sdk/v2/client"

const keyFor = (directory: string, id: string) => `${directory}\n${id}`

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const globalSync = useGlobalSync()
    const sdk = useSDK()

    type Child = ReturnType<(typeof globalSync)["child"]>
    type Setter = Child[1]

    const child = () => globalSync.child(sdk.directory, { projectID: sdk.projectID })
    const current = createMemo(child)
    const absolute = (path: string) => (current()[0].path.directory + "/" + path).replace("//", "/")
    const chunk = SESSION_MESSAGE_CHUNK
    const inflight = new Map<string, Promise<void>>()
    const inflightDiff = new Map<string, Promise<void>>()
    const inflightTodo = new Map<string, Promise<void>>()
    const [meta, setMeta] = createStore({
      limit: {} as Record<string, number>,
      complete: {} as Record<string, boolean>,
      loading: {} as Record<string, boolean>,
    })

    const getSession = (sessionID: string) => {
      const store = current()[0]
      const match = Binary.search(store.session, sessionID, (s) => s.id)
      if (match.found) return store.session[match.index]
      return undefined
    }

    const loadMessages = async (input: {
      directory: string
      client: typeof sdk.client
      setStore: Setter
      sessionID: string
      limit: number
      preserveMessages?: Message[]
    }) => {
      const key = keyFor(input.directory, input.sessionID)
      if (meta.loading[key]) return

      setMeta("loading", key, true)
      await retry(() => input.client.session.messages({ sessionID: input.sessionID, limit: input.limit }))
        .then((messages) => {
          const items = (messages.data ?? []).filter((x) => !!x?.info?.id)
          const incoming = items
            .map((x) => x.info)
            .filter((m) => !!m?.id)
            .sort((a, b) => a.id.localeCompare(b.id))
          const next = input.preserveMessages?.length
            ? mergeHydratedMessages(input.preserveMessages, incoming)
            : incoming

          batch(() => {
            input.setStore("message", input.sessionID, reconcile(next, { key: "id" }))

            for (const message of items) {
              input.setStore(
                "part",
                message.info.id,
                reconcile(
                  message.parts.filter((p) => !!p?.id).sort((a, b) => a.id.localeCompare(b.id)),
                  { key: "id" },
                ),
              )
            }

            setMeta("limit", key, input.limit)
            setMeta("complete", key, next.length < input.limit)
          })
        })
        .finally(() => {
          setMeta("loading", key, false)
        })
    }

    return {
      get data() {
        return current()[0]
      },
      get set(): Setter {
        return current()[1]
      },
      get status() {
        return current()[0].status
      },
      get ready() {
        return current()[0].status !== "loading"
      },
      get project() {
        const store = current()[0]
        const match = Binary.search(globalSync.data.project, store.project, (p) => p.id)
        if (match.found) return globalSync.data.project[match.index]
        return undefined
      },
      session: {
        get: getSession,
        addOptimisticMessage(input: {
          sessionID: string
          messageID: string
          parts: Part[]
          agent: string
          model: { providerID: string; modelID: string }
        }) {
          const message: Message = {
            id: input.messageID,
            sessionID: input.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: input.agent,
            model: input.model,
          }
          current()[1](
            produce((draft) => {
              const messages = draft.message[input.sessionID]
              if (!messages) {
                draft.message[input.sessionID] = [message]
              } else {
                const result = Binary.search(messages, input.messageID, (m) => m.id)
                messages.splice(result.index, 0, message)
              }
              draft.part[input.messageID] = input.parts.filter((p) => !!p?.id).sort((a, b) => a.id.localeCompare(b.id))
            }),
          )
        },
        async sync(sessionID: string, options?: { refresh?: boolean }) {
          const directory = sdk.scope
          const client = sdk.client
          const [store, setStore] = child()
          const key = keyFor(directory, sessionID)
          const hasSession = (() => {
            const match = Binary.search(store.session, sessionID, (s) => s.id)
            return match.found
          })()

          const hasMessages = store.message[sessionID] !== undefined
          const count = store.message[sessionID]?.length ?? 0
          const plan = sessionHydrationPlan({
            hasSession,
            hasMessages,
            hydratedLimit: meta.limit[key],
            messageCount: count,
            refresh: options?.refresh,
          })
          if (plan.skip) return
          const pending = inflight.get(key)
          if (pending) return pending

          const sessionReq = hasSession
            ? Promise.resolve()
            : retry(() => client.session.get({ sessionID })).then((session) => {
                const data = session.data
                if (!data) return
                setStore(
                  "session",
                  produce((draft) => {
                    const match = Binary.search(draft, sessionID, (s) => s.id)
                    if (match.found) {
                      draft[match.index] = data
                      return
                    }
                    draft.splice(match.index, 0, data)
                  }),
                )
              })

          const messagesReq = plan.loadMessages
            ? loadMessages({
                directory,
                client,
                setStore,
                sessionID,
                limit: plan.limit,
                preserveMessages: options?.refresh ? store.message[sessionID] : undefined,
              })
            : Promise.resolve()

          const promise = Promise.all([sessionReq, messagesReq])
            .then(() => {})
            .finally(() => {
              inflight.delete(key)
            })

          inflight.set(key, promise)
          return promise
        },
        async diff(sessionID: string) {
          const directory = sdk.scope
          const client = sdk.client
          const [store, setStore] = child()
          if (store.session_diff[sessionID] !== undefined) return

          const key = keyFor(directory, sessionID)
          const pending = inflightDiff.get(key)
          if (pending) return pending

          const promise = retry(() => client.session.diff({ sessionID }))
            .then((diff) => {
              setStore("session_diff", sessionID, reconcile(diff.data ?? [], { key: "file" }))
            })
            .finally(() => {
              inflightDiff.delete(key)
            })

          inflightDiff.set(key, promise)
          return promise
        },
        async revert(sessionID: string, messageID: string) {
          const client = sdk.client
          const [, setStore] = child()
          const res = await client.session.revert({ sessionID, messageID })
          const payload: unknown = res.data
          const data = (() => {
            if (!payload || typeof payload !== "object") return
            if (!("session" in payload)) return payload as ReturnType<typeof getSession>
            return (payload as { session?: ReturnType<typeof getSession> }).session
          })()
          if (data)
            setStore(
              produce((draft) => {
                const m = Binary.search(draft.session, sessionID, (s) => s.id)
                if (m.found) draft.session[m.index] = data
              }),
            )
          const next = await client.session
            .diff({ sessionID })
            .then((d) => d.data ?? [])
            .catch(() => [])
          setStore("session_diff", sessionID, reconcile(next, { key: "file" }))
          if (!payload || typeof payload !== "object" || !("status" in payload)) return
          const result = payload as { status?: unknown; turns?: unknown; files?: unknown }
          return {
            status: typeof result.status === "string" ? result.status : undefined,
            turns: typeof result.turns === "number" ? result.turns : undefined,
            files: Array.isArray(result.files)
              ? result.files.filter((file): file is string => typeof file === "string")
              : undefined,
          }
        },
        async unrevert(sessionID: string) {
          const client = sdk.client
          const [, setStore] = child()
          const res = await client.session.unrevert({ sessionID })
          if (res.data)
            setStore(
              produce((draft) => {
                const m = Binary.search(draft.session, sessionID, (s) => s.id)
                if (m.found) draft.session[m.index] = res.data!
              }),
            )
          const next = await client.session
            .diff({ sessionID })
            .then((d) => d.data ?? [])
            .catch(() => [])
          setStore("session_diff", sessionID, reconcile(next, { key: "file" }))
        },
        async todo(sessionID: string) {
          const directory = sdk.scope
          const client = sdk.client
          const [store, setStore] = child()
          if (store.todo[sessionID] !== undefined) return

          const key = keyFor(directory, sessionID)
          const pending = inflightTodo.get(key)
          if (pending) return pending

          const promise = retry(() => client.session.todo({ sessionID }))
            .then((todo) => {
              setStore("todo", sessionID, reconcile(todo.data ?? [], { key: "id" }))
            })
            .finally(() => {
              inflightTodo.delete(key)
            })

          inflightTodo.set(key, promise)
          return promise
        },
        history: {
          more(sessionID: string) {
            const store = current()[0]
            const key = keyFor(sdk.scope, sessionID)
            if (store.message[sessionID] === undefined) return false
            if (meta.limit[key] === undefined) return false
            if (meta.complete[key]) return false
            return true
          },
          loading(sessionID: string) {
            const key = keyFor(sdk.scope, sessionID)
            return meta.loading[key] ?? false
          },
          async loadMore(sessionID: string, count = chunk) {
            const directory = sdk.scope
            const client = sdk.client
            const [, setStore] = child()
            const key = keyFor(directory, sessionID)
            if (meta.loading[key]) return
            if (meta.complete[key]) return

            const currentLimit = meta.limit[key] ?? chunk
            await loadMessages({
              directory,
              client,
              setStore,
              sessionID,
              limit: currentLimit + count,
            })
          },
        },
        fetch: async (count = 10) => {
          const client = sdk.client
          const [store, setStore] = child()
          setStore("limit", (x) => x + count)
          await client.session.list().then((x) => {
            const sessions = (x.data ?? [])
              .filter((s) => !!s?.id)
              .sort((a, b) => a.id.localeCompare(b.id))
              .slice(0, store.limit)
            setStore("session", reconcile(sessions, { key: "id" }))
          })
        },
        more: createMemo(() => current()[0].session.length >= current()[0].limit),
        archive: async (sessionID: string) => {
          const client = sdk.client
          const [, setStore] = child()
          await client.session.update({ sessionID, time: { archived: Date.now() } })
          setStore(
            produce((draft) => {
              const match = Binary.search(draft.session, sessionID, (s) => s.id)
              if (match.found) draft.session.splice(match.index, 1)
            }),
          )
        },
        pin: async (sessionID: string, pinned: boolean) => {
          const client = sdk.client
          const [, setStore] = child()
          const value = pinned ? Date.now() : 0
          const previous: { value?: number } = {}
          setStore(
            produce((draft) => {
              const match = Binary.search(draft.session, sessionID, (session) => session.id)
              if (!match.found) return
              previous.value = draft.session[match.index].time.pinned
              draft.session[match.index].time.pinned = value || undefined
            }),
          )
          await client.session.update({ sessionID, time: { pinned: value } }).catch((error) => {
            setStore(
              produce((draft) => {
                const match = Binary.search(draft.session, sessionID, (session) => session.id)
                if (match.found) draft.session[match.index].time.pinned = previous.value
              }),
            )
            throw error
          })
        },
        rename: async (sessionID: string, title: string) => {
          const client = sdk.client
          const [, setStore] = child()
          // Optimistically retitle in place so the row renames instantly; if the
          // backend rejects it we roll the title back so the UI stays honest.
          let prev: string | undefined
          setStore(
            produce((draft) => {
              const match = Binary.search(draft.session, sessionID, (s) => s.id)
              if (match.found) {
                prev = draft.session[match.index].title
                draft.session[match.index].title = title
              }
            }),
          )
          try {
            await client.session.update({ sessionID, title })
          } catch (e) {
            setStore(
              produce((draft) => {
                const match = Binary.search(draft.session, sessionID, (s) => s.id)
                if (match.found && prev !== undefined) draft.session[match.index].title = prev
              }),
            )
            throw e
          }
        },
        delete: async (sessionID: string) => {
          const client = sdk.client
          const [, setStore] = child()
          // Optimistically remove from the per-directory store. If the
          // backend call rejects we re-add it so the UI stays honest.
          let snapshot: any
          setStore(
            produce((draft) => {
              const match = Binary.search(draft.session, sessionID, (s) => s.id)
              if (match.found) {
                snapshot = { index: match.index, value: draft.session[match.index] }
                draft.session.splice(match.index, 1)
              }
            }),
          )
          try {
            await client.session.delete({ sessionID })
          } catch (e) {
            if (snapshot)
              setStore(
                produce((draft) => {
                  draft.session.splice(snapshot.index, 0, snapshot.value)
                }),
              )
            throw e
          }
        },
      },
      absolute,
      get directory() {
        return current()[0].path.directory
      },
    }
  },
})
