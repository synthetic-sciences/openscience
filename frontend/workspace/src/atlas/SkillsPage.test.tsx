import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import type { SkillsPageServices } from "./SkillsPage"
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
const names = ["biology", "chemistry", "restricted"]
function fixture(server: string, disabled: string[] = [], projectDisabled = false) {
  const [config, setConfig] = stores.createStore({ disabled })
  const calls: Array<{ names: string[]; enabled: boolean }> = []
  const service: SkillsPageServices = {
    server,
    load: async () =>
      names.map((name) => ({
        name,
        description: `${name} research workflow`,
        location: `/skills/${name}/SKILL.md`,
        category: "science",
        permission_action: name === "restricted" ? "deny" : name === "biology" ? "ask" : "allow",
        enabled: projectDisabled && name === "chemistry" ? false : !disabled.includes(name),
        disabled_by:
          projectDisabled && name === "chemistry" ? "project" : disabled.includes(name) ? "server" : undefined,
      })),
    disabled: () => config.disabled,
    permission: () => ({ skill: "allow" }),
    select: async (names, enabled) => {
      calls.push({ names, enabled })
      const next = skillSelection(config.disabled, names, enabled)
      setConfig("disabled", next)
      return next
    },
    create: async () => undefined,
    install: async () => ({ installed: [], rejected: [] }),
  }
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(() => subject.default({ embedded: true, services: service }), host))
  return { host, calls, service, config }
}
const button = (host: HTMLElement, prefix: string) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((element) =>
    element.textContent?.trim().startsWith(prefix),
  )!

test("active, pinned and off views use real selection while preserving ask and blocked policy", async () => {
  const { host, calls, config } = fixture("http://skills-test:4101", ["chemistry"])
  await settle()
  expect(host.textContent).toContain("1 active")
  expect(host.textContent).toContain("available on demand, not loaded into every chat")
  expect(host.textContent).toContain("Ask first")
  const blocked =
    host.querySelector<HTMLInputElement>('input[aria-label="Activate restricted"]') ??
    host.querySelector<HTMLInputElement>('input[role="switch"][disabled]')
  expect(blocked?.disabled).toBe(true)
  button(host, "Active")?.click()
  expect(host.querySelectorAll(".skills-workspace__row")).toHaveLength(1)
  expect(host.querySelector(".skills-workspace__row")?.textContent).toContain("Biology")
  button(host, "All skills").click()
  host.querySelector<HTMLButtonElement>('[aria-label="Pin chemistry"]')?.click()
  button(host, "Pinned").click()
  expect(host.querySelectorAll(".skills-workspace__row")).toHaveLength(1)
  expect(host.querySelector(".skills-workspace__row")?.textContent).toContain("Chemistry")
  button(host, "Filters & view").click()
  button(host, "Activate 1 shown").click()
  await settle()
  expect(calls).toEqual([{ names: ["chemistry"], enabled: true }])
  expect(config.disabled).toEqual([])
  button(host, "Off").click()
  expect(host.querySelectorAll(".skills-workspace__row")).toHaveLength(1)
  expect(host.querySelector(".skills-workspace__row")?.textContent).toContain("Blocked by policy")
})

test("bulk selection only changes filtered results and density is customizable", async () => {
  const { host, calls } = fixture("http://skills-test:4102")
  await settle()
  const search = host.querySelector<HTMLInputElement>('[aria-label="Search skills"]')!
  search.value = "biology"
  search.dispatchEvent(new Event("input", { bubbles: true }))
  button(host, "Filters & view").click()
  button(host, "Turn off 1 shown").click()
  await settle()
  expect(calls).toEqual([{ names: ["biology"], enabled: false }])
  const density = host.querySelector<HTMLSelectElement>('[aria-label="Skill row density"]')!
  density.value = "compact"
  density.dispatchEvent(new Event("change", { bubbles: true }))
  expect(host.querySelector(".skills-workspace")?.getAttribute("data-density")).toBe("compact")
  expect(localStorage.getItem("openscience.skills.density.v1")).toBe("compact")
  button(host, "Reset filters").click()
  expect(host.querySelectorAll(".skills-workspace__row")).toHaveLength(3)
})

test("failed selection rolls back the visible optimistic result", async () => {
  const { host, service } = fixture("http://skills-test:4103")
  await settle()
  service.select = async () => {
    throw new Error("Offline")
  }
  button(host, "Filters & view").click()
  button(host, "Turn off 2 shown").click()
  await settle()
  expect(host.textContent).toContain("2 active")
  expect(host.textContent).toContain("Selection could not be saved")
})

test("server catalog overrides stale global state and cannot activate project-local off skills", async () => {
  const { host, calls } = fixture("http://skills-test:4104", [], true)
  await settle()
  expect(host.textContent).toContain("1 active")
  expect(host.textContent).toContain("Off in this project")
  expect(host.textContent).toContain("Blocked by policy")
  button(host, "Filters & view").click()
  expect(button(host, "Activate 0 shown").disabled).toBe(true)
  expect(calls).toEqual([])
})
