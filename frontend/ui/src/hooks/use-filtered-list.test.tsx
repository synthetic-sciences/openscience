import { afterAll, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createTestServer as createServer } from "../../../workspace/test/vite"
import solid from "vite-plugin-solid"

const vite = await createServer({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true, watch: null },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js"] },
  ssr: { noExternal: true, external: ["fuzzysort"], resolve: { conditions: ["browser", "production"] } },
})
const reactive = (await vite.ssrLoadModule("solid-js")) as typeof import("solid-js")
const hooks = (await vite.ssrLoadModule("/src/hooks/use-filtered-list.tsx")) as typeof import("./use-filtered-list")

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

afterAll(() => vite.close())

describe("useFilteredList async queries", () => {
  test("refetch invokes an items function again for the current query", async () => {
    let calls = 0
    const owner = reactive.createRoot((dispose) => {
      const list = hooks.useFilteredList<string>({
        items: (query) => [`${query}:${++calls}`],
        key: (item) => item,
      })
      return { list, dispose }
    })

    await settle()
    expect(owner.list.flat()).toEqual([":1"])
    await owner.list.refetch()
    expect(owner.list.flat()).toEqual([":2"])
    expect(calls).toBe(2)
    owner.dispose()
  })

  test("renders and selects only results from the current query", async () => {
    type Item = { id: string }
    const requests = new Map<string, ReturnType<typeof deferred<Item[]>>>()
    const selected: string[] = []
    const owner = reactive.createRoot((dispose) => {
      const list = hooks.useFilteredList<Item>({
        items: (query) => {
          const request = deferred<Item[]>()
          requests.set(query, request)
          return request.promise
        },
        key: (item) => item.id,
        filterKeys: ["id"],
        onSelect: (item) => {
          if (item) selected.push(item.id)
        },
      })
      return { list, dispose }
    })

    await settle()
    requests.get("")!.resolve([{ id: "initial" }])
    await settle()
    expect(owner.list.flat().map((item) => item.id)).toEqual(["initial"])

    owner.list.onInput("older")
    await settle()
    owner.list.onInput("current")
    await settle()
    expect(owner.list.flat()).toEqual([])

    owner.list.select({ id: "initial" })
    owner.list.onKeyDown({
      key: "Enter",
      isComposing: false,
      preventDefault() {},
    } as unknown as KeyboardEvent)
    expect(selected).toEqual([])

    requests.get("current")!.resolve([{ id: "current" }])
    await settle()
    expect(owner.list.flat().map((item) => item.id)).toEqual(["current"])

    requests.get("older")!.resolve([{ id: "older" }])
    await settle()
    expect(owner.list.flat().map((item) => item.id)).toEqual(["current"])

    owner.list.select({ id: "older" })
    owner.list.select({ id: "current" })
    expect(selected).toEqual(["current"])
    owner.list.setActive("current")
    owner.list.onKeyDown({
      key: "Enter",
      isComposing: false,
      preventDefault() {},
    } as unknown as KeyboardEvent)
    expect(selected).toEqual(["current", "current"])
    owner.dispose()
  })

  // An empty list while a newer query is in flight is not "nothing matches". Consumers whose
  // items arrive over the network say which of the two the reader is looking at.
  test("an empty list is distinguishable from a query still in flight", async () => {
    type Item = { id: string }
    const requests = new Map<string, ReturnType<typeof deferred<Item[]>>>()
    const owner = reactive.createRoot((dispose) => {
      const list = hooks.useFilteredList<Item>({
        items: (query) => {
          const request = deferred<Item[]>()
          requests.set(query, request)
          return request.promise
        },
        key: (item) => item.id,
        filterKeys: ["id"],
      })
      return { list, dispose }
    })

    await settle()
    requests.get("")!.resolve([{ id: "paper.tex" }])
    await settle()
    expect(owner.list.flat().map((item) => item.id)).toEqual(["paper.tex"])
    expect(owner.list.grouped.loading).toBe(false)

    owner.list.onInput("repor")
    await settle()
    expect(owner.list.flat()).toEqual([])
    expect(owner.list.grouped.loading).toBe(true)

    requests.get("repor")!.resolve([])
    await settle()
    expect(owner.list.flat()).toEqual([])
    expect(owner.list.grouped.loading).toBe(false)

    owner.dispose()
  })
})

describe("useFilteredList reactive items", () => {
  type Row = { id: string }

  const mount = (items: () => Row[]) =>
    reactive.createRoot((dispose) => {
      const list = hooks.useFilteredList<Row>({
        items: () => items(),
        key: (item) => item.id,
        filterKeys: ["id"],
      })
      return { list, dispose }
    })

  test("a memo items source still updates the list when it changes", async () => {
    const [rows, setRows] = reactive.createSignal<Row[]>([{ id: "alpha" }, { id: "beta" }])
    const owner = mount(reactive.createMemo(() => rows().map((row) => ({ ...row }))))

    await settle()
    expect(owner.list.flat().map((row) => row.id)).toEqual(["alpha", "beta"])

    setRows([{ id: "alpha" }, { id: "beta" }, { id: "gamma" }])
    await settle()
    expect(owner.list.flat().map((row) => row.id)).toEqual(["alpha", "beta", "gamma"])

    setRows([{ id: "alpha" }, { id: "gamma" }])
    await settle()
    expect(owner.list.flat().map((row) => row.id)).toEqual(["alpha", "gamma"])

    owner.dispose()
  })

  test("a reorder of the same items is reflected", async () => {
    const [rows, setRows] = reactive.createSignal<Row[]>([{ id: "alpha" }, { id: "beta" }, { id: "gamma" }])
    const owner = mount(reactive.createMemo(() => rows().map((row) => ({ ...row }))))

    await settle()
    expect(owner.list.flat().map((row) => row.id)).toEqual(["alpha", "beta", "gamma"])

    setRows([{ id: "gamma" }, { id: "alpha" }, { id: "beta" }])
    await settle()
    expect(owner.list.flat().map((row) => row.id)).toEqual(["gamma", "alpha", "beta"])
    expect(owner.list.active()).toBe("gamma")

    owner.dispose()
  })

  test("items that change under an unchanged query never blank the list", async () => {
    const [rows, setRows] = reactive.createSignal<Row[]>([{ id: "alpha" }])
    const seen: number[] = []
    const owner = reactive.createRoot((dispose) => {
      const list = hooks.useFilteredList<Row>({
        items: () => rows().map((row) => ({ ...row })),
        key: (item) => item.id,
        filterKeys: ["id"],
      })
      reactive.createEffect(() => seen.push(list.flat().length))
      return { list, dispose }
    })

    await settle()
    setRows([{ id: "alpha" }, { id: "beta" }])
    await settle()

    expect(owner.list.flat().map((row) => row.id)).toEqual(["alpha", "beta"])
    expect(seen.slice(1)).not.toContain(0)
    owner.dispose()
  })
})
