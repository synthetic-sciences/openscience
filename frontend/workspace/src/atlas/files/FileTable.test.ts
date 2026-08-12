import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

const server = await createServer({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const [subject, web] = await Promise.all([
  server.ssrLoadModule("/src/atlas/files/FileTable.tsx") as Promise<typeof import("./FileTable")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])
const cleanups: Array<() => void> = []

afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn())
  document.body.replaceChildren()
})

const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(view, host))
  return host
}

const ROWS = [
  { name: "train_lr.py", type: "file" as const, size: 2534 },
  { name: "hpc", type: "directory" as const },
  { name: "analysis.ipynb", type: "file" as const, size: 21504 },
  { name: "experiments", type: "directory" as const },
]

describe("file table", () => {
  test("puts folders first, then files, each alphabetically", () => {
    const host = mount(() => subject.FileTable({ rows: ROWS, depth: 0, onOpen: () => {}, onUp: () => {} }))

    expect([...host.querySelectorAll("[data-file-name]")].map((n) => n.textContent)).toEqual([
      "experiments",
      "hpc",
      "analysis.ipynb",
      "train_lr.py",
    ])
  })

  test("leaves folder size quiet and shows human sizes for files", () => {
    const host = mount(() => subject.FileTable({ rows: ROWS, depth: 0, onOpen: () => {}, onUp: () => {} }))
    const sizes = [...host.querySelectorAll("[data-file-size]")].map((n) => n.textContent)

    expect(sizes[0]).toBe("")
    expect(sizes).toContain("2.5 KB")
    expect(sizes).toContain("21 KB")
  })

  test("carries no age column", () => {
    const host = mount(() => subject.FileTable({ rows: ROWS, depth: 0, onOpen: () => {}, onUp: () => {} }))

    expect(host.querySelector("[data-file-age]")).toBeNull()
  })

  test("uses a familiar Name and Size header with semantic file icons", () => {
    const host = mount(() => subject.FileTable({ rows: ROWS, depth: 0, onOpen: () => {}, onUp: () => {} }))

    expect(host.querySelector(".files-table__header")?.textContent).toContain("Name")
    expect(host.querySelector(".files-table__header")?.textContent).toContain("Size")
    expect(host.querySelectorAll("[data-file-row] .files-row__glyph svg")).toHaveLength(ROWS.length)
  })

  test("offers a parent row only below the root, and reports both actions", () => {
    const opened: string[] = []
    let ups = 0
    const root = mount(() =>
      subject.FileTable({ rows: ROWS, depth: 0, onOpen: (r) => opened.push(r.name), onUp: () => ups++ }),
    )
    expect(root.querySelector("[data-file-up]")).toBeNull()

    const deep = mount(() =>
      subject.FileTable({ rows: ROWS, depth: 2, onOpen: (r) => opened.push(r.name), onUp: () => ups++ }),
    )
    deep.querySelector<HTMLButtonElement>("[data-file-up]")?.click()
    deep.querySelector<HTMLButtonElement>('[data-file-row="train_lr.py"]')?.click()

    expect(ups).toBe(1)
    expect(deep.querySelector("[data-file-up]")?.textContent).toContain("Parent folder")
    expect(opened).toEqual(["train_lr.py"])
  })

  test("says what an empty folder is rather than showing nothing", () => {
    const host = mount(() => subject.FileTable({ rows: [], depth: 1, onOpen: () => {}, onUp: () => {} }))

    expect(host.textContent).toContain("This folder is empty")
  })

  test("distinguishes a filtered result from a truly empty folder", () => {
    const host = mount(() =>
      subject.FileTable({ rows: [], depth: 0, filtered: true, onOpen: () => {}, onUp: () => {} }),
    )

    expect(host.textContent).toContain("No matching files")
    expect(host.textContent).toContain("clear the search")
    expect(host.textContent).not.toContain("This folder is empty")
  })

  test("does not claim the folder is empty while loading or unavailable", () => {
    const loading = mount(() =>
      subject.FileTable({ rows: [], depth: 0, loading: true, onOpen: () => {}, onUp: () => {} }),
    )
    const unavailable = mount(() =>
      subject.FileTable({ rows: [], depth: 0, unavailable: true, onOpen: () => {}, onUp: () => {} }),
    )

    expect(loading.textContent).not.toContain("This folder is empty.")
    expect(unavailable.textContent).not.toContain("This folder is empty.")
  })
})
