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
  server.ssrLoadModule("/src/atlas/files/ArtifactGrid.tsx") as Promise<typeof import("./ArtifactGrid")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])
const cleanups: Array<() => void> = []

afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn())
  document.body.replaceChildren()
  // Bun shares localStorage across every test file in one process, so this
  // guards the next FILE as much as the next test.
  globalThis.localStorage?.clear()
})

const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(view, host))
  return host
}

let versions = 0
const artifact = (over: { filename: string; session: string; createdAt: number }) =>
  ({
    schemaVersion: 1,
    id: `art_${over.filename}`,
    projectID: "prj_1",
    title: over.filename,
    kind: "file",
    currentVersionID: "ver_1",
    createdAt: over.createdAt,
    updatedAt: over.createdAt,
    state: "active",
    versionCount: 1,
    current: {
      id: `ver_${(versions += 1)}`,
      artifactID: `art_${over.filename}`,
      version: 1,
      filename: over.filename,
      mimeType: "application/octet-stream",
      size: 100,
      sha256: "abc",
      sessionID: over.session,
      sourcePath: `/tmp/${over.filename}`,
      captureQuality: "exact",
      createdAt: over.createdAt,
    },
  }) as never

const now = Date.now()

const props = (over: Record<string, unknown> = {}) => ({
  artifacts: [
    artifact({ filename: "b.py", session: "ses_one", createdAt: now - 60_000 }),
    artifact({ filename: "a.py", session: "ses_two", createdAt: now - 600_000 }),
  ],
  titles: new Map([["ses_one", "First session"]]),
  currentSession: undefined,
  url: () => "",
  read: async () => "x",
  highlight: async (code: string) => code,
  onOpen: () => {},
  onRename: () => {},
  onTrash: () => {},
  ...over,
})

describe("artifact grid", () => {
  test("counts what it shows", () => {
    const host = mount(() => subject.ArtifactGrid(props() as never))

    expect(host.querySelector("[data-artifact-count]")?.textContent).toBe("2 results")
  })

  test("groups under Created and flattens under Name", () => {
    const host = mount(() => subject.ArtifactGrid(props() as never))
    expect(host.querySelectorAll("[data-artifact-group]")).toHaveLength(2)

    host.querySelector<HTMLButtonElement>("[data-artifact-prefs]")!.click()
    host.querySelector<HTMLButtonElement>("[data-artifact-sort='name']")!.click()

    expect(host.querySelectorAll("[data-artifact-group]")).toHaveLength(0)
    expect([...host.querySelectorAll("[data-card-open]")].map((node) => node.getAttribute("aria-label"))).toEqual([
      "Open a.py, version 1",
      "Open b.py, version 1",
    ])
  })

  test("names the newest session first and labels an untitled one by id", () => {
    const host = mount(() => subject.ArtifactGrid(props() as never))

    expect([...host.querySelectorAll(".artifact-group__name")].map((node) => node.textContent)).toEqual([
      "First session",
      "ses_…es_two",
    ])
  })

  test("switches layout and says so", () => {
    const host = mount(() => subject.ArtifactGrid(props() as never))

    host.querySelector<HTMLButtonElement>("[data-artifact-prefs]")!.click()
    host.querySelector<HTMLButtonElement>("[data-artifact-layout='list']")!.click()

    expect(host.querySelector("[data-artifact-list]")).not.toBeNull()
    expect(host.querySelector("[data-artifact-grid]")).toBeNull()
    expect(host.querySelector("[data-artifact-layout='list']")?.getAttribute("aria-checked")).toBe("true")
  })

  test("remembers sort and layout across a remount", () => {
    const first = mount(() => subject.ArtifactGrid(props() as never))
    first.querySelector<HTMLButtonElement>("[data-artifact-prefs]")!.click()
    first.querySelector<HTMLButtonElement>("[data-artifact-sort='name']")!.click()
    first.querySelector<HTMLButtonElement>("[data-artifact-layout='list']")!.click()

    cleanups.splice(0).forEach((fn) => fn())
    document.body.replaceChildren()

    const second = mount(() => subject.ArtifactGrid(props() as never))

    second.querySelector<HTMLButtonElement>("[data-artifact-prefs]")!.click()
    expect(second.querySelector("[data-artifact-sort='name']")?.getAttribute("aria-checked")).toBe("true")
    expect(second.querySelector("[data-artifact-list]")).not.toBeNull()
  })

  test("adds sizes to every card when the preference is set", () => {
    const host = mount(() => subject.ArtifactGrid(props() as never))
    expect(host.querySelector("[data-card-meta]")?.textContent).not.toContain("100 B")

    host.querySelector<HTMLButtonElement>("[data-artifact-prefs]")!.click()
    host.querySelector<HTMLButtonElement>("[data-pref='sizes']")!.click()

    expect(host.querySelector("[data-card-meta]")?.textContent).toContain("100 B")
    expect(host.querySelector("[role='menu']")).not.toBeNull()
  })

  // "No artifacts saved yet." is a lie when a search simply matched nothing.
  test("says a search matched nothing rather than claiming none are saved", () => {
    const host = mount(() => subject.ArtifactGrid(props({ artifacts: [], filtered: true }) as never))

    expect(host.textContent).toContain("No matching results")
    expect(host.textContent).toContain("clear the search")
    expect(host.textContent).not.toContain("No saved results yet")
  })

  test("names the empty state for artifacts, not folders", () => {
    const host = mount(() => subject.ArtifactGrid(props({ artifacts: [] }) as never))

    expect(host.textContent).toContain("No saved results yet")
    expect(host.textContent).toContain("versions intact")
    expect(host.textContent).not.toContain("folder")
    expect(host.querySelector("[data-artifact-count]")?.textContent).toBe("0 results")
  })

  // One plain-language view control reduces toolbar icons and cannot be
  // confused with the ellipsis that acts on an individual artifact.
  test("keeps the view trigger distinct from a card's action menu", () => {
    const host = mount(() => subject.ArtifactGrid(props() as never))

    expect(host.querySelector("[data-artifact-prefs] svg")).not.toBeNull()
    expect(host.querySelector("[data-card-menu] svg")).not.toBeNull()
    expect(host.querySelector("[data-artifact-prefs]")?.textContent).toContain("View")
    expect(host.querySelector("[data-card-menu]")?.textContent?.trim()).toBe("")
  })

  test("groups sort, layout, and size choices behind one view control", () => {
    const host = mount(() => subject.ArtifactGrid(props() as never))

    expect(host.querySelector("[data-artifact-sort]")).toBeNull()
    expect(host.querySelector("[data-artifact-layout]")).toBeNull()
    host.querySelector<HTMLButtonElement>("[data-artifact-prefs]")!.click()

    expect(host.querySelectorAll("[data-artifact-sort]")).toHaveLength(2)
    expect(host.querySelectorAll("[data-artifact-layout]")).toHaveLength(2)
    expect(host.querySelector("[data-pref='sizes']")).not.toBeNull()
  })

  test("moves focus through view options and Escape restores the trigger", async () => {
    const host = mount(() => subject.ArtifactGrid(props() as never))
    const trigger = host.querySelector<HTMLButtonElement>("[data-artifact-prefs]")!

    trigger.click()
    await Promise.resolve()
    const options = [...host.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')]
    expect(document.activeElement).toBe(options[0])

    options[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    expect(document.activeElement).toBe(options[1])
    options[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }))
    expect(document.activeElement).toBe(options.at(-1)!)

    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await Promise.resolve()
    expect(host.querySelector("[role='menu']")).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  test("pins the current session ahead of a newer one", () => {
    const host = mount(() => subject.ArtifactGrid(props({ currentSession: "ses_two" }) as never))

    expect(host.querySelector(".artifact-group__name")?.textContent).toBe("This session")
  })
})
