import { describe, expect, test } from "bun:test"
import { createDebouncedSearch } from "./file-search"

describe("createDebouncedSearch", () => {
  test("collapses a burst of queries into the latest request", async () => {
    const calls: string[] = []
    const search = createDebouncedSearch(
      async (query) => {
        calls.push(query)
        return [query]
      },
      { delayMs: 10, fallback: () => [] as string[] },
    )

    const first = search.search("a")
    const second = search.search("at")
    const last = search.search("atlas")

    expect(await first).toEqual([])
    expect(await second).toEqual([])
    expect(await last).toEqual(["atlas"])
    expect(calls).toEqual(["atlas"])
  })

  test("aborts an in-flight request when the query changes", async () => {
    const aborted: string[] = []
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const search = createDebouncedSearch(
      (query, signal) =>
        new Promise<string[]>((resolve, reject) => {
          markStarted()
          const timer = setTimeout(() => resolve([query]), 30)
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer)
              aborted.push(query)
              reject(new DOMException("Aborted", "AbortError"))
            },
            { once: true },
          )
        }),
      { delayMs: 0, fallback: () => [] },
    )

    const first = search.search("old")
    await started
    const latest = search.search("new")

    expect(await first).toEqual([])
    expect(await latest).toEqual(["new"])
    expect(aborted).toEqual(["old"])
  })

  test("coalesces duplicate pending queries", () => {
    const search = createDebouncedSearch(async (query) => [query], {
      delayMs: 10,
      fallback: () => [],
    })

    expect(search.search("same")).toBe(search.search("same"))
    search.cancel()
  })
})
