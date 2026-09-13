import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createTestServer as createServer } from "../../test/vite"
import solid from "vite-plugin-solid"
import type { SkillsPageServices, SkillRoot } from "./SkillsPage"
import { skillSelection } from "./skill-selection"

const vite = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const [subject, web, stores] = await Promise.all([
  vite.ssrLoadModule("/src/atlas/SkillsPage.tsx") as Promise<typeof import("./SkillsPage")>,
  vite.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
  vite.ssrLoadModule("solid-js/store") as Promise<typeof import("solid-js/store")>,
])
const cleanups: Array<() => void> = []
afterAll(() => vite.close())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
  localStorage.clear()
})
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

// A core skill, two library skills on one shelf, a personal skill, and a
// policy-blocked library skill on another shelf.
const fixtures = [
  { name: "figures", category: "core", location: "/skills/core/figures/SKILL.md", action: "allow" as const },
  { name: "biology", category: "biology", location: "/skills/biology/biology/SKILL.md", action: "ask" as const },
  { name: "chemistry", category: "biology", location: "/skills/biology/chemistry/SKILL.md", action: "allow" as const },
  { name: "restricted", category: "physics", location: "/skills/physics/restricted/SKILL.md", action: "deny" as const },
  {
    name: "my-notes",
    category: "writing",
    location: "/home/me/.openscience/user-skills/my-notes/SKILL.md",
    action: "allow" as const,
    origin: "user" as const,
  },
]
function fixture(server: string, disabled: string[] = [], projectDisabled = false) {
  const [config, setConfig] = stores.createStore({ disabled })
  const calls: Array<{ names: string[]; enabled: boolean }> = []
  const writes: Array<{ name: string; content: string }> = []
  const removed: string[] = []
  const roots: SkillRoot[] = [
    { path: "/app/skills", kind: "bundled", skills: 4, shadowed: 0 },
    { path: "/home/me/.openscience/user-skills", kind: "user", skills: 1, shadowed: 0 },
    { path: "/data/team-skills", kind: "runtime", skills: 3, shadowed: 1 },
  ]
  const added: Array<{ path: string; persist?: string }> = []
  const service: SkillsPageServices = {
    server,
    load: async () =>
      fixtures.map((skill) => ({
        name: skill.name,
        description: `${skill.name} research workflow. More detail follows.`,
        location: skill.location,
        category: skill.category,
        origin: skill.origin,
        permission_action: skill.action,
        enabled: projectDisabled && skill.name === "chemistry" ? false : !disabled.includes(skill.name),
        disabled_by:
          projectDisabled && skill.name === "chemistry"
            ? "project"
            : disabled.includes(skill.name)
              ? "server"
              : undefined,
      })),
    disabled: () => config.disabled,
    permission: () => ({ skill: "allow" }),
    select: async (names, enabled) => {
      calls.push({ names, enabled })
      const next = skillSelection(config.disabled, names, enabled)
      setConfig("disabled", next)
      return next
    },
    create: async (name, content) => void writes.push({ name, content }),
    read: async (name) => `---\nname: ${name}\ndescription: existing\n---\n\nBody of ${name}.\n`,
    remove: async (name) => void removed.push(name),
    install: async () => ({ installed: [], rejected: [] }),
    roots: async () => ({
      roots,
      shadowed: [
        { name: "biology", location: "/data/team-skills/biology/SKILL.md", by: "/skills/biology/biology/SKILL.md" },
      ],
    }),
    addRoot: async (path, persist) => {
      added.push({ path, persist })
      return { path, kind: "runtime", skills: 2, shadowed: 0 }
    },
    removeRoot: async () => undefined,
  }
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(() => subject.default({ embedded: true, services: service }), host))
  return { host, calls, writes, removed, added, service, config }
}
const button = (host: HTMLElement, prefix: string) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((element) =>
    element.textContent?.trim().startsWith(prefix),
  )!
const rows = (host: HTMLElement) => Array.from(host.querySelectorAll(".skills-workspace__row"))
const names = (host: HTMLElement) => rows(host).map((row) => row.querySelector("code")?.textContent)
const toggleOf = (host: HTMLElement, name: string) =>
  rows(host)
    .find((row) => row.querySelector("code")?.textContent === `/${name}`)
    ?.querySelector<HTMLInputElement>('input[role="switch"]')

test("core leads, the library folds into shelves, and views narrow the catalog without touching policy", async () => {
  const { host, calls, config } = fixture("http://skills-test:4101", ["chemistry"])
  await settle()
  // restricted is denied by policy, so it never counts as active.
  expect(host.textContent).toContain("3 active")
  expect(host.textContent).toContain("5 in library")
  // Sections: Core and Personal rows are open; library shelves are folded.
  expect(names(host)).toEqual(["/figures", "/my-notes"])
  expect(host.textContent).toContain("Biology")
  expect(host.textContent).toContain("2 skills · 1 off")
  expect(toggleOf(host, "figures")?.checked).toBe(true)

  const shelf = host.querySelector<HTMLButtonElement>('.skills-workspace__shelf-toggle[aria-expanded="false"]')!
  shelf.click()
  expect(names(host)).toEqual(["/figures", "/my-notes", "/biology", "/chemistry"])
  expect(host.textContent).toContain("Ask first")
  expect(toggleOf(host, "restricted")).toBeUndefined()

  button(host, "Off").click()
  expect(names(host)).toEqual(["/chemistry", "/restricted"])
  expect(host.textContent).toContain("Blocked by policy")
  expect(toggleOf(host, "restricted")?.disabled).toBe(true)

  button(host, "Core").click()
  expect(names(host)).toEqual(["/figures"])
  button(host, "Personal").click()
  expect(names(host)).toEqual(["/my-notes"])
  button(host, "Library").click()
  expect(names(host)).not.toContain("/figures")
  expect(names(host)).not.toContain("/my-notes")
  expect(host.querySelectorAll(".skills-workspace__shelf")).toHaveLength(2)

  button(host, "All").click()
  // Bulk selection stays inside one shelf and never re-enables a denied skill.
  const activate = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
    (element) => element.textContent?.trim() === "Activate all",
  )!
  activate.click()
  await settle()
  expect(calls).toEqual([{ names: ["chemistry"], enabled: true }])
  expect(config.disabled).toEqual([])
})

test("search is one flat list with the subject beside each library skill", async () => {
  const { host, calls } = fixture("http://skills-test:4102")
  await settle()
  const search = host.querySelector<HTMLInputElement>('[aria-label="Search skills"]')!
  search.value = "bio"
  search.dispatchEvent(new Event("input", { bubbles: true }))
  // The subject matches too, so the whole Biology shelf answers "bio".
  expect(names(host)).toEqual(["/biology", "/chemistry"])
  expect(host.querySelector(".skills-workspace__row")?.textContent).toContain("Biology")
  expect(host.querySelector(".skills-workspace__shelf")).toBeNull()
  toggleOf(host, "biology")!.click()
  await settle()
  expect(calls).toEqual([{ names: ["biology"], enabled: false }])
  search.value = ""
  search.dispatchEvent(new Event("input", { bubbles: true }))
  expect(names(host)).toEqual(["/figures", "/my-notes"])
})

test("failed selection rolls back the visible optimistic result", async () => {
  const { host, service } = fixture("http://skills-test:4103")
  await settle()
  service.select = async () => {
    throw new Error("Offline")
  }
  toggleOf(host, "figures")!.click()
  await settle()
  expect(host.textContent).toContain("4 active")
  expect(host.textContent).toContain("Selection could not be saved")
})

test("server catalog overrides stale global state and cannot activate project-local off skills", async () => {
  const { host, calls } = fixture("http://skills-test:4104", [], true)
  await settle()
  expect(host.textContent).toContain("3 active")
  button(host, "Off").click()
  expect(host.textContent).toContain("Off in this project")
  expect(host.textContent).toContain("Blocked by policy")
  expect(toggleOf(host, "chemistry")?.disabled).toBe(true)
  expect(calls).toEqual([])
})

test("personal skills can be edited and deleted; sources list every root and the shadowed names", async () => {
  const { host, writes, removed, added } = fixture("http://skills-test:4105")
  await settle()
  expect(host.querySelector('[aria-label="Edit figures"]')).toBeNull()
  host.querySelector<HTMLButtonElement>('[aria-label="Edit my-notes"]')!.click()
  await settle()
  const editor = host.querySelector<HTMLTextAreaElement>("textarea")!
  expect(editor.value).toContain("Body of my-notes.")
  editor.value = editor.value.replace("Body of my-notes.", "Revised body.")
  editor.dispatchEvent(new Event("input", { bubbles: true }))
  button(host, "Save skill").click()
  await settle()
  expect(writes).toEqual([{ name: "my-notes", content: expect.stringContaining("Revised body.") }])

  const confirmed = globalThis.confirm
  globalThis.confirm = () => true
  try {
    host.querySelector<HTMLButtonElement>('[aria-label="Delete my-notes"]')!.click()
    await settle()
  } finally {
    globalThis.confirm = confirmed
  }
  expect(removed).toEqual(["my-notes"])

  expect(host.textContent).toContain("Sources")
  expect(host.textContent).toContain("Registered")
  expect(host.textContent).toContain("3 skills · 1 shadowed")
  expect(host.querySelector('[aria-label="Remove /data/team-skills"]')).not.toBeNull()
  expect(host.querySelector('[aria-label="Remove /app/skills"]')).toBeNull()
  expect(host.textContent).toContain("loses to")

  // The Add menu is a portal exercised by the browser suite; the folder form
  // itself is reached there too.
  expect(added).toEqual([])
})
