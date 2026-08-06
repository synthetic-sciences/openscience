import { afterAll, afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
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
  ssr: {
    noExternal: true,
    resolve: { conditions: ["browser", "production"] },
  },
})
const [subject, web] = await Promise.all([
  server.ssrLoadModule("/src/components/settings/Skills.tsx") as Promise<typeof import("./Skills")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])
const cleanups: Array<() => void> = []

afterAll(() => server.close())

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(view, host))
  return host
}

test("skills settings frame renders compact catalog chrome", () => {
  const host = mount(() => subject.SkillsFrame({ children: "Catalog content" }))
  const frame = host.querySelector<HTMLElement>(".settings-skills")

  expect(frame?.getAttribute("aria-label")).toBe("Skills settings")
  expect(frame?.textContent).toContain("Catalog content")
  expect(frame?.querySelector("style")?.textContent).toContain(".settings-skills .skills-workspace__row")
})

test("embedded skills catalog omits nested workspace title chrome", () => {
  const wrapper = readFileSync(fileURLToPath(new URL("./Skills.tsx", import.meta.url)), "utf8")
  const catalog = readFileSync(fileURLToPath(new URL("../../atlas/SkillsPage.tsx", import.meta.url)), "utf8")

  expect(wrapper).toContain("<SkillsPage embedded />")
  expect(catalog).toContain('data-layout={props.embedded ? "settings" : "workspace"}')
  expect(catalog).toContain("<Show when={!props.embedded}>")
  expect(catalog).toContain("sdk.client.app.skills()")
  expect(catalog).toContain("sdk.client.app.skill.write")
  expect(catalog).toContain("sync.updateConfig")
  expect(catalog).toContain('label="Add skill"')
  expect(catalog).toContain('label: "Write from scratch"')
  expect(catalog).toContain('label: "Upload a skill"')
  expect(catalog).toContain('label: "Import from GitHub"')
  expect(catalog).toContain('label="Cancel"')
  expect(catalog).not.toContain('label="cancel"')
})
