import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { installFromGit } from "./skills-settings"
import { skillIconFor } from "./skill-icon"

const source = () => readFileSync(fileURLToPath(new URL("./SkillsPage.tsx", import.meta.url)), "utf8")
const styles = () => readFileSync(fileURLToPath(new URL("./skills-page.css", import.meta.url)), "utf8")
const settingsStyles = () =>
  readFileSync(fileURLToPath(new URL("../components/settings/skills.css", import.meta.url)), "utf8")

test("skills use a compact searchable list instead of a card dashboard", () => {
  const page = source()

  expect(page).toContain('class="skills-workspace"')
  expect(page).toContain('class="skills-workspace__header"')
  expect(page).toContain('class="skills-workspace__list"')
  expect(page).toContain('class="skills-workspace__row"')
  expect(page).not.toContain("SkillCard")
  expect(page).not.toContain('"grid-template-columns": "repeat(auto-fill')
})

test("skills catalog keeps readable type, aligned controls, and semantic states", () => {
  const page = source()
  const css = styles()

  expect(page).toContain('placeholder="Search skills"')
  expect(page).toContain('label: "All categories"')
  expect(page).toContain('icon="alert-circle"')
  expect(page).toContain('action="Try again"')
  expect(page).toContain('class="skills-workspace__skill-icon"')
  expect(page).toContain("skillIconFor")
  expect(page).toContain("words === words.toUpperCase()")
  expect(css).toContain("font-size: 14px")
  expect(css).toContain("font-size: 13px")
  expect(css).toContain("font-size: 12px")
  expect(css).toContain("@media (pointer: coarse)")
  expect(css).toContain("min-height: 44px")
  expect(css).toContain("background: var(--color-surface-solid)")
  expect(css).not.toContain("text-transform")
  expect(css).not.toContain("!important")
})

test("skills catalog is intrinsically responsive inside narrow panes", () => {
  const css = styles()

  expect(css).toMatch(/\.skills-workspace\s*\{[^}]*container: skills-workspace \/ inline-size/s)
  expect(css).toMatch(/\.skills-workspace\s*\{[^}]*min-width: 0/s)
  expect(css).toMatch(/\.skills-workspace__body\s*\{[^}]*overflow-x: hidden/s)
  expect(css).toMatch(
    /\.skills-workspace__row\s*\{[^}]*grid-template-columns: minmax\(190px, 0\.9fr\) minmax\(260px, 1\.4fr\) 72px/s,
  )
  expect(css).toMatch(/\.skills-workspace__identity\s*\{[^}]*grid-template-columns: 32px minmax\(0, 1fr\)/s)
  expect(css).toMatch(/\.skills-workspace__skill-icon\s*\{[^}]*width: 32px;[^}]*height: 32px/s)
  expect(css).toContain("@container skills-workspace (max-width: 800px)")
  expect(css).toContain("@container skills-workspace (max-width: 460px)")
  expect(css).not.toContain("minmax(210px")
  expect(css).not.toContain("minmax(250px")
})

test("skills surfaces share settings radii and flat grouped states", () => {
  const css = styles()
  const settings = settingsStyles()

  expect(css).toContain("border-radius: var(--settings-radius-card, var(--atlas-radius-md))")
  expect(css).toContain("border-radius: var(--settings-radius-control, var(--atlas-radius-sm))")
  expect(css).toContain("border-radius: var(--atlas-radius-sm)")
  expect(settings).toContain("border-radius: var(--settings-radius-control)")
  expect(css).toMatch(/\.skills-workspace__row:hover\s*\{[^}]*background: var\(--color-surface-solid\)/s)
  expect(css).toMatch(/\.skills-workspace__rows\s*\{[^}]*gap: var\(--settings-space-1, 4px\)[^}]*border: 0/s)
  expect(css).not.toContain(".skills-workspace__row + .skills-workspace__row::before")

  for (const surface of [css, settings]) {
    expect(surface).not.toMatch(/border-radius:\s*\d+(?:\.\d+)?px/)
    expect(surface).not.toMatch(/border(?:-(?:top|right|bottom|left))?:\s*[^;\n]*color-mix/)
  }

  expect(css).not.toContain("color-mix")
})

test("embedded skills use the restrained settings surface stack", () => {
  const page = source()
  const settings = settingsStyles()

  expect(page).not.toContain('class="skills-workspace__source-icon"')
  expect(page).toContain('class="skills-workspace__details"')
  expect(settings).toContain("background: var(--settings-surface-muted)")
  expect(settings).toContain("background: var(--settings-surface-hover)")
  expect(settings).toContain("border-color: transparent")
  expect(settings).toContain("outline: 1px solid var(--settings-border-strong)")
  expect(settings).not.toContain("var(--settings-accent)")
  expect(settings).not.toMatch(/(?:background|border-color):\s*(?:#000(?:000)?|black)/)
})

test("settings skills bound hidden DOM and make toggle feedback immediate", () => {
  const page = source()

  expect(page).toContain("INITIAL_SKILL_ROWS = 56")
  expect(page).toContain("SKILL_ROW_BATCH = 56")
  expect(page).toContain("visibleShelves")
  expect(page).toContain("if (panel.hidden) setVisibleRows(INITIAL_SKILL_ROWS)")
  expect(page).toContain("sessionStorage.setItem(SKILL_CACHE_KEY")
  expect(page).toContain('sync.set("config", "permission", change.optimistic')
  expect(page).toContain("permissionWrites = permissionWrites.then")
  expect(page).not.toContain("disabled={permissionBusy()}")
  expect(page).toContain("visibleShelves()")
  expect(page).toContain("items.slice(0, remaining)")
})

test("skill tags remain whole and switches keep compact geometry", () => {
  const css = styles()
  const switchCss = readFileSync(
    fileURLToPath(new URL("../../../ui/src/components/switch.css", import.meta.url)),
    "utf8",
  )

  expect(css).toMatch(
    /\.skills-workspace__details\s*\{[^}]*display: grid;[^}]*grid-template-columns: minmax\(0, 1fr\) max-content/s,
  )
  expect(css).toMatch(/\.skills-workspace__tags span\s*\{[^}]*min-width: max-content;[^}]*flex: 0 0 auto/s)
  expect(css).toMatch(
    /@container skills-workspace \(max-width: 640px\)[\s\S]*?\.skills-workspace__tags\s*\{[^}]*display: flex;[^}]*flex-wrap: wrap/s,
  )
  expect(switchCss).toMatch(/\[data-slot="switch-control"\]\s*\{[^}]*width: 34px;[^}]*height: 20px/s)
  expect(switchCss).toMatch(/\[data-component="switch"\]\s*\{[^}]*min-width: 32px;[^}]*min-height: 32px/s)
  expect(css).not.toMatch(/\.skills-workspace \[data-component="switch"\] \[data-slot="switch-(?:control|thumb)"\]/)
})

test("skill icons use subject metadata with a stable fallback", () => {
  expect(skillIconFor({ name: "cell-culture", category: "biology" })).toBe("activity")
  expect(skillIconFor({ name: "postgres", category: "databases" })).toBe("server")
  expect(skillIconFor({ name: "gpu-jobs", category: "cloud-compute" })).toBe("cloud")
  expect(skillIconFor({ name: "custom-thing" })).toBe(skillIconFor({ name: "custom-thing" }))
})

test("global skill installation does not select a filesystem project", async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init })
    return Response.json({ installed: [], rejected: [], warnings: [] })
  }) as typeof fetch

  await installFromGit(fetchFn, "http://127.0.0.1:4096/", "https://github.com/example/science-skills")

  expect(calls).toHaveLength(1)
  expect(calls[0]!.url.pathname).toBe("/settings/skills/install")
  expect([...calls[0]!.url.searchParams]).toEqual([])
  expect(calls[0]!.init?.method).toBe("POST")
  expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
    url: "https://github.com/example/science-skills",
  })
})
