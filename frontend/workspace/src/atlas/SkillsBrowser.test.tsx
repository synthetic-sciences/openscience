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
const styles = readFileSync(fileURLToPath(new URL("./skills-browser.css", import.meta.url)), "utf8")

afterAll(() => vite.close())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
  globalThis.__skillLibrarySync = undefined
})

const mount = (view: () => JSX.Element) => {
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
  expect(document.body.textContent).toContain("/protein-folding")
  expect(document.body.textContent).not.toContain("/literature-review")

  const result = document.body.querySelector<HTMLButtonElement>('[aria-label="Use the protein-folding skill"]')
  expect(result?.getAttribute("type")).toBe("button")
  result?.focus()
  expect(document.activeElement).toBe(result)
  expect(styles).toMatch(/\.atlas-skill-row:focus-visible\s*\{[^}]*outline: 2px solid var\(--focus-lit-ring\)/s)
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
  const more = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent === "Show more skills",
  )
  more?.click()
  await Promise.resolve()

  expect(document.body.querySelectorAll<HTMLButtonElement>('[aria-label^="Use the skill-"]')).toHaveLength(75)
  expect(document.body.textContent).not.toContain("Show more skills")
})
