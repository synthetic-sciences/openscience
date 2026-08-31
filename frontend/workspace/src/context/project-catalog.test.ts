import { describe, expect, test } from "bun:test"
import type { Project } from "@synsci/sdk/v2/client"
import { createProjectCatalogSync, mergeProjectUpdate, projectCatalogCacheKey } from "./project-catalog"

const project = (id: string, activity = 20): Project => ({
  id,
  worktree: `/projects/${id}`,
  origin: "openscience",
  sandboxes: [],
  time: { created: 10, updated: 20, activity },
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe("authoritative project catalog", () => {
  test("persisted catalogs use the exact full server URL, never the former global cache or local-history bucket", () => {
    const urls = [
      "http://localhost:4096",
      "http://localhost:5555",
      "http://127.0.0.1:4096",
      "https://localhost:4096",
      "https://example.com/server-a",
      "https://example.com/server-b",
    ]
    const keys = urls.map(projectCatalogCacheKey)
    expect(new Set(keys).size).toBe(urls.length)
    expect(keys).not.toContain("globalSync.project")
    expect(keys).not.toContain("globalSync.project.v1")
    expect(keys).not.toContain("local")
    expect(projectCatalogCacheKey(urls[0])).toBe(projectCatalogCacheKey(urls[0]))
  })

  test("unknown and formerly promoted phantom events cannot insert Home rows, and bursts coalesce", async () => {
    const owned = project("prj_owned")
    const phantom = project("prj_phantom")
    let rows = [owned]
    let calls = 0
    const response = deferred<Project[]>()
    const catalog = createProjectCatalogSync({
      load: () => {
        calls++
        return response.promise
      },
      read: () => rows,
      write: (next) => (rows = next),
      isCurrent: () => true,
    })
    const refreshes = Array.from({ length: 10 }, () => catalog.update(phantom))
    expect(rows).toEqual([owned])
    await Promise.resolve()
    expect(calls).toBe(1)
    response.resolve([owned])
    await Promise.all(refreshes)
    expect(rows).toEqual([owned])
    expect(calls).toBe(1)
    catalog.update({ ...project("prj_runtime"), origin: undefined })
    expect(calls).toBe(1)
  })

  test("a newly created project appears only when the library confirms it", async () => {
    const created = project("prj_created")
    let rows: Project[] = []
    const response = deferred<Project[]>()
    const catalog = createProjectCatalogSync({
      load: () => response.promise,
      read: () => rows,
      write: (next) => (rows = next),
      isCurrent: () => true,
    })
    const pending = catalog.update(created)
    expect(rows).toEqual([])
    response.resolve([created])
    await pending
    expect(rows).toEqual([created])
  })

  test("events during an in-flight snapshot trigger one follow-up membership check", async () => {
    const first = deferred<Project[]>()
    const created = project("prj_created")
    let rows: Project[] = []
    let calls = 0
    const catalog = createProjectCatalogSync({
      load: () => (++calls === 1 ? first.promise : Promise.resolve([created])),
      read: () => rows,
      write: (next) => (rows = next),
      isCurrent: () => true,
    })
    const pending = catalog.refresh()
    await Promise.resolve()
    const events = Array.from({ length: 10 }, () => catalog.update(created))
    first.resolve([])
    await Promise.all([pending, ...events])
    expect(calls).toBe(2)
    expect(rows).toEqual([created])
  })

  test("an authoritative empty library removes old persisted phantom rows", async () => {
    let rows = [project("prj_phantom")]
    const catalog = createProjectCatalogSync({
      load: async () => [],
      read: () => rows,
      write: (next) => (rows = next),
      isCurrent: () => true,
    })
    await catalog.refresh()
    expect(rows).toEqual([])
  })

  test("stale events and list snapshots preserve newer activity and metadata independently", async () => {
    const initial = project("prj_owned", 100)
    let rows = [initial]
    const catalog = createProjectCatalogSync({
      load: async () => [initial],
      read: () => rows,
      write: (next) => (rows = next),
      isCurrent: () => true,
    })
    await catalog.refresh()
    catalog.update({ ...initial, name: "New title", time: { ...initial.time, updated: 300, activity: 400 } })
    catalog.update({ ...initial, name: "Stale title", time: { ...initial.time, updated: 200, activity: 500 } })
    expect(rows[0].name).toBe("New title")
    expect(rows[0].time.activity).toBe(500)
    await catalog.refresh()
    expect(rows[0].name).toBe("New title")
    expect(rows[0].time.activity).toBe(500)
    expect(mergeProjectUpdate(initial, { ...initial, time: { ...initial.time, activity: 200 } }).time.activity).toBe(
      200,
    )
  })

  test("responses from disposed or switched servers never write into the active library", async () => {
    for (const stop of ["dispose", "switch"] as const) {
      let current = true
      let rows: Project[] = []
      const response = deferred<Project[]>()
      const catalog = createProjectCatalogSync({
        load: () => response.promise,
        read: () => rows,
        write: (next) => (rows = next),
        isCurrent: () => current,
      })
      const pending = catalog.refresh()
      await Promise.resolve()
      if (stop === "dispose") catalog.dispose()
      else current = false
      response.resolve([project("prj_wrong_server")])
      await pending
      expect(rows).toEqual([])
    }
  })

  test("a failed membership refresh preserves current rows and allows another attempt", async () => {
    const owned = project("prj_owned")
    let rows = [owned]
    let calls = 0
    const catalog = createProjectCatalogSync({
      load: async () => {
        if (++calls === 1) throw new Error("offline")
        return [owned]
      },
      read: () => rows,
      write: (next) => (rows = next),
      isCurrent: () => true,
    })
    await expect(catalog.update(project("prj_unknown"))).rejects.toThrow("offline")
    expect(rows).toEqual([owned])
    await catalog.refresh()
    expect(calls).toBe(2)
    expect(rows).toEqual([owned])
  })
})
