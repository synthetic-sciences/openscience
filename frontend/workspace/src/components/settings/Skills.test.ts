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

test("skills settings frame renders the catalog without injected style tags", () => {
  const host = mount(() => subject.SkillsFrame({ children: "Catalog content" }))
  const frame = host.querySelector<HTMLElement>(".settings-skills")

  expect(frame?.getAttribute("aria-label")).toBe("Skills settings")
  expect(frame?.textContent).toContain("Catalog content")
  expect(frame?.querySelector("style")).toBeNull()
})

test("embedded skills catalog uses a useful sentence-case heading and live actions", () => {
  const wrapper = readFileSync(fileURLToPath(new URL("./Skills.tsx", import.meta.url)), "utf8")
  const catalog = readFileSync(fileURLToPath(new URL("../../atlas/SkillsPage.tsx", import.meta.url)), "utf8")
  const styles = readFileSync(fileURLToPath(new URL("./skills.css", import.meta.url)), "utf8")

  expect(wrapper).toContain("<SkillsPage embedded />")
  expect(wrapper).toContain('import "./skills.css"')
  expect(catalog).toContain('data-layout={props.embedded ? "settings" : "workspace"}')
  expect(catalog).toContain("when={!props.embedded}")
  expect(catalog).toContain("<h2>Skills</h2>")
  expect(catalog).toContain("sdk.client.app.skills()")
  expect(catalog).toContain("sdk.client.app.skill.write")
  expect(catalog).toContain("sync.updateConfig")
  expect(catalog).toContain('label="Add skill"')
  expect(catalog).toContain('label: "Write from scratch"')
  expect(catalog).toContain('label: "Upload a skill"')
  expect(catalog).toContain('label: "Import from GitHub"')
  expect(catalog).toContain('label="Cancel"')
  expect(catalog).not.toContain('label="cancel"')
  expect(catalog).toContain('class="skills-workspace__rows"')
  expect(catalog).not.toContain('class="skills-workspace__source-icon"')
  expect(catalog).toContain('class="skills-workspace__details"')
  expect(catalog).toContain('class="settings-chip"')
  expect(catalog).toContain('action="Clear filters"')
  expect(catalog).toContain("data-source={source()}")
  expect(catalog).toContain('<ul class="skills-workspace__rows">')
  expect(styles).toMatch(/\.settings-skills\s*\{[^}]*width: 100%[^}]*min-width: 0/s)
  expect(styles).toMatch(
    /\.settings-skills \.skills-workspace__rows\s*\{[^}]*padding: 4px;[^}]*border: 0;[^}]*background: var\(--settings-surface\)/s,
  )
  expect(styles).toContain("box-shadow: var(--settings-shadow-card)")
  expect(styles).toMatch(
    /\.settings-skills \.skills-workspace__row\s*\{[^}]*border: 0;[^}]*border-radius: var\(--settings-radius-control\);[^}]*background: transparent/s,
  )
  expect(styles).toMatch(
    /\.settings-skills \.skills-workspace__form-fields \.settings-field,[^}]*\.skills-workspace__security-note\s*\{[^}]*border-color: transparent;[^}]*background: var\(--settings-surface\)/s,
  )
  expect(styles).toMatch(
    /\.settings-skills \.skills-workspace__heading,[^}]*\.settings-skills \.skills-workspace__content\s*\{[^}]*max-width: 900px/s,
  )
  expect(styles).toMatch(/\.settings-skills \.skills-workspace__header\s*\{[^}]*border-bottom: 0/s)
  expect(styles).toContain("@container skills-workspace (max-width: 960px)")
  expect(styles).toMatch(
    /\.settings-skills \.skills-workspace__toolbar-controls\s*\{[^}]*display: grid;[^}]*minmax\(180px, 1fr\) max-content max-content/s,
  )
  expect(styles).toMatch(/\.settings-skills \.skills-workspace \.settings-control\s*\{[^}]*height: 32px/s)
  expect(styles).not.toContain('[data-slot="switch-control"]')
  expect(catalog).toContain("INITIAL_SKILL_ROWS = 56")
  expect(catalog).toContain("visibleShelves")
  expect(catalog).toContain("permissionWrites = permissionWrites.then")
  expect(catalog).not.toContain("permissionBusy")
  expect(styles).not.toContain("outline-color: var(--settings-accent)")
})

test("skill icon helper remains available to picker surfaces", () => {
  expect(subject.skillIconFor({ name: "protein-folding", category: "biology" })).toBe("braces")
  expect(subject.skillIconFor({ name: "postgres", category: "databases" })).toBe("server")
  expect(subject.skillIconFor({ name: "paper-review", category: "research" })).toBe("book-open")
  expect(subject.skillIconFor({ name: "custom-thing" })).toBe(subject.skillIconFor({ name: "custom-thing" }))
})

test("embedded skills use the shared settings type rhythm without shrinking standalone Skills", () => {
  const embedded = readFileSync(fileURLToPath(new URL("./skills.css", import.meta.url)), "utf8")
  const standalone = readFileSync(fileURLToPath(new URL("../../atlas/skills-page.css", import.meta.url)), "utf8")

  expect(embedded).toMatch(
    /\.settings-skills \.skills-workspace__heading h2\s*\{[^}]*font-size: var\(--settings-type-title\);[^}]*line-height: var\(--settings-leading-title\)/s,
  )
  expect(embedded).toMatch(
    /\.settings-skills \.skills-workspace__group-heading h3,[\s\S]*?\.settings-skills \.skills-workspace__state > strong\s*\{[^}]*font-size: var\(--settings-type-body\);[^}]*font-weight: var\(--font-weight-medium\);[^}]*line-height: var\(--settings-leading-body\)/s,
  )
  expect(embedded).toMatch(
    /\.settings-skills \.skills-workspace__group-heading > span,[\s\S]*?\.settings-skills \.skills-workspace__form-actions button\s*\{[^}]*font-size: var\(--settings-type-helper\);[^}]*line-height: var\(--settings-leading-helper\)/s,
  )
  expect(embedded).toMatch(
    /\.settings-skills \.skills-workspace__tags \.settings-chip\s*\{[^}]*min-height: 20px;[^}]*font-size: var\(--settings-type-helper\);[^}]*line-height: var\(--settings-leading-helper\)/s,
  )
  expect(embedded).toMatch(
    /@container skills-workspace \(max-width: 640px\)[\s\S]*?\.settings-skills \.skills-workspace__tags\s*\{[^}]*display: flex/s,
  )

  expect(standalone).toMatch(/\.skills-workspace__heading h1\s*\{[^}]*font-size: 24px/s)
  expect(standalone).toMatch(/\.skills-workspace__group-heading h3\s*\{[^}]*font-size: 14px/s)
  expect(standalone).toMatch(/\.skills-workspace__identity strong\s*\{[^}]*font-size: 14px/s)
})
