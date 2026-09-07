import { afterAll, afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

declare global {
  // Mounted test seam for the Vite-mocked sync context below.
  var __skillLibrarySync: unknown
}

const vite = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [
    {
      name: "skill-library-sync",
      enforce: "pre",
      resolveId(id) {
        if (id === "@/context/sync" || id.endsWith("/src/context/sync") || id.endsWith("/src/context/sync.tsx")) {
          return "\0skill-library-sync"
        }
      },
      load(id) {
        if (id === "\0skill-library-sync") {
          return "export const useSync = () => globalThis.__skillLibrarySync"
        }
      },
    },
    solid({ ssr: false, dev: false }),
  ],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})

const [subject, dialogs, web] = await Promise.all([
  vite.ssrLoadModule("/src/atlas/SkillsBrowser.tsx") as Promise<typeof import("./SkillsBrowser")>,
  vite.ssrLoadModule("@synsci/ui/context/dialog") as Promise<typeof import("@synsci/ui/context/dialog")>,
  vite.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])
const cleanups: Array<() => void> = []
const styles = [
  readFileSync(fileURLToPath(new URL("../styles/atlas.css", import.meta.url)), "utf8"),
  readFileSync(fileURLToPath(new URL("./skills-browser.css", import.meta.url)), "utf8"),
].join("\n")

afterAll(() => vite.close())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
  globalThis.__skillLibrarySync = undefined
})

const mount = (view: () => JSX.Element) => {
  const style = document.createElement("style")
  style.textContent = styles
  document.head.append(style)
  cleanups.push(() => style.remove())
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(view, host))
  return host
}

function Harness(props: { onPick: (name: string) => void; initialQuery?: string }): JSX.Element {
  const dialog = dialogs.useDialog()
  const button = document.createElement("button")
  button.textContent = "Browse"
  button.addEventListener("click", () => {
    dialog.show(() => subject.SkillLibraryDialog({ initialQuery: props.initialQuery, onPick: props.onPick }))
  })
  return button
}

test("skill library opens on the slash query and returns an accessible selection", async () => {
  globalThis.__skillLibrarySync = {
    data: {
      config: { permission: [] },
      skill: [
        {
          name: "protein-folding",
          description: "Analyze protein sequences and structures",
          location: "/skills/protein-folding/SKILL.md",
          category: "biology",
        },
        {
          name: "literature-review",
          description: "Review papers",
          location: "/skills/literature-review/SKILL.md",
          category: "research",
        },
      ],
    },
  }
  const picked: string[] = []
  const host = mount(() =>
    dialogs.DialogProvider({
      get children() {
        return Harness({ initialQuery: "protein", onPick: (name) => picked.push(name) })
      },
    }),
  )

  host.querySelector<HTMLButtonElement>("button")?.click()
  await Promise.resolve()

  const search = document.body.querySelector<HTMLInputElement>('[aria-label="Search the skill library"]')
  expect(search?.value).toBe("protein")
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(document.activeElement).toBe(search)
  const frame = search!.closest<HTMLElement>(".atlas-skill-library__search")!
  frame.style.setProperty("--focus-lit-ring", "rgb(80, 120, 180)")
  frame.style.setProperty("--focus-lit-halo", "0 0 4px rgb(80, 120, 180)")
  expect(getComputedStyle(search!).outlineStyle).toBe("none")
  expect(getComputedStyle(search!).boxShadow).toBe("none")
  frame.removeAttribute("data-focus-frame")
  expect(getComputedStyle(search!).boxShadow).toContain("4px")
  frame.setAttribute("data-focus-frame", "")
  expect(getComputedStyle(search!).boxShadow).toBe("none")
  expect(document.body.textContent).toContain("/protein-folding")
  expect(document.body.textContent).not.toContain("/literature-review")

  const result = document.body.querySelector<HTMLButtonElement>('[aria-label="Use the protein-folding skill"]')
  expect(result?.getAttribute("type")).toBe("button")
  result?.focus()
  expect(document.activeElement).toBe(result)
  expect(getComputedStyle(result!).minHeight).toBe("44px")
  result?.click()
  expect(picked).toEqual(["protein-folding"])
})

test("skill library bounds initial rows and progressively reveals the remaining catalog", async () => {
  globalThis.__skillLibrarySync = {
    data: {
      config: { permission: [] },
      skill: Array.from({ length: 75 }, (_, index) => ({
        name: `skill-${String(index).padStart(2, "0")}`,
        description: `Research workflow ${index}`,
        location: `/skills/skill-${index}/SKILL.md`,
        category: "research",
      })),
    },
  }
  const host = mount(() =>
    dialogs.DialogProvider({
      get children() {
        return Harness({ onPick: () => {} })
      },
    }),
  )

  host.querySelector<HTMLButtonElement>("button")?.click()
  await Promise.resolve()

  expect(document.body.querySelectorAll<HTMLButtonElement>('[aria-label^="Use the skill-"]')).toHaveLength(60)
  expect(document.body.querySelector('[role="status"]')?.textContent).toBe("60 of 75 skills")
  expect(document.body.querySelector(".atlas-skill-library__heading")?.textContent).toBe("Research60 of 75")
  const results = document.body.querySelector<HTMLDivElement>(".atlas-skill-library__results")!
  results.scrollTop = 1700
  const more = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent === "Show more skills",
  )
  more?.click()
  await Promise.resolve()

  expect(document.body.querySelectorAll<HTMLButtonElement>('[aria-label^="Use the skill-"]')).toHaveLength(75)
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Use the skill-60 skill")
  expect(document.body.textContent).not.toContain("Show more skills")
  expect(document.body.querySelector('[role="status"]')?.textContent).toBe("75 skills")
  expect(document.body.querySelector(".atlas-skill-library__heading")?.textContent).toBe("Research75")
  expect(results.scrollTop).toBe(1700)

  const search = document.body.querySelector<HTMLInputElement>('[aria-label="Search the skill library"]')!
  search.value = "skill"
  search.dispatchEvent(new Event("input", { bubbles: true }))
  expect(results.scrollTop).toBe(0)
  expect(document.body.querySelectorAll<HTMLButtonElement>('[aria-label^="Use the skill-"]')).toHaveLength(60)

  results.scrollTop = 1700
  search.value = "not-present"
  search.dispatchEvent(new Event("input", { bubbles: true }))
  expect(results.scrollTop).toBe(0)
  expect(document.body.querySelector('[role="status"]')?.textContent).toBe("0 skills")
  expect(document.body.textContent).toContain("No matching skills")
  document.body.querySelector<HTMLButtonElement>('[aria-label="Clear skill search"]')?.click()
  expect(search.value).toBe("")
  expect(document.activeElement).toBe(search)
  expect(document.body.querySelectorAll<HTMLButtonElement>('[aria-label^="Use the skill-"]')).toHaveLength(60)
})

test("the library keeps its controls outside one bounded scroller and renders complete permitted rows", async () => {
  const name = `extended-${"scientific-workflow-".repeat(8)}`
  const description = "A complete description with details that must remain readable. ".repeat(8)
  globalThis.__skillLibrarySync = {
    data: {
      config: { permission: { skill: { "private-skill": "deny" } } },
      skill: [
        { name, description, location: "/skills/long/SKILL.md", category: "biology", tags: ["long-tag-".repeat(20)] },
        { name: "private-skill", description: "Private", location: "/skills/private/SKILL.md" },
        { name: "disabled-skill", description: "Disabled", location: "/skills/disabled/SKILL.md", enabled: false },
      ],
    },
  }
  const host = mount(() =>
    dialogs.DialogProvider({
      get children() {
        return Harness({ onPick: () => {} })
      },
    }),
  )
  host.querySelector<HTMLButtonElement>("button")?.click()
  await Promise.resolve()
  const dialog = document.body.querySelector<HTMLElement>(".atlas-skill-library")!
  const body = dialog.querySelector<HTMLElement>('[data-slot="dialog-body"]')!
  const search = dialog.querySelector<HTMLElement>(".atlas-skill-library__search")!
  const results = dialog.querySelector<HTMLElement>(".atlas-skill-library__results")!
  const footer = dialog.querySelector<HTMLElement>(".atlas-skill-library__footer")!
  expect(getComputedStyle(dialog).overflow).toBe("hidden")
  expect(Number.parseFloat(getComputedStyle(dialog).minHeight)).toBe(0)
  expect(Number.parseFloat(getComputedStyle(body).minHeight)).toBe(0)
  expect(getComputedStyle(results).overflowY).toBe("auto")
  expect(Number.parseFloat(getComputedStyle(results).minHeight)).toBe(0)
  expect(getComputedStyle(search).flexShrink).toBe("0")
  expect(getComputedStyle(footer).flexShrink).toBe("0")
  expect(results.contains(search)).toBe(false)
  expect(results.contains(footer)).toBe(false)
  expect(getComputedStyle(dialog.querySelector(".atlas-skill-library__body")!).paddingLeft).toBe("20px")
  const row = results.querySelector<HTMLButtonElement>(".atlas-skill-row")!
  expect(row.querySelector(".atlas-skill-library__name")?.textContent).toBe(`/${name}`)
  expect(row.querySelector(".atlas-skill-library__description")?.textContent).toBe(description)
  expect(getComputedStyle(row.querySelector(".atlas-skill-library__details")!).overflowWrap).toBe("anywhere")
  expect(getComputedStyle(row.querySelector(".atlas-skill-library__description")!).overflow).not.toBe("hidden")
  expect(results.querySelectorAll(".atlas-skill-row")).toHaveLength(1)
  expect(footer.textContent).toBe("1 skill")
})
