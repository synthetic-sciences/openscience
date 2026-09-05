import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { installFromGit } from "./skills-settings"
import { skillIconFor } from "./skill-icon"

const source = () => readFileSync(fileURLToPath(new URL("./SkillsPage.tsx", import.meta.url)), "utf8")
const styles = () => readFileSync(fileURLToPath(new URL("./skills-page.css", import.meta.url)), "utf8")
const settingsStyles = () =>
  readFileSync(fileURLToPath(new URL("../components/settings/skills.css", import.meta.url)), "utf8")
const shellStyles = () =>
  readFileSync(fileURLToPath(new URL("../components/dialog-settings.tsx", import.meta.url)), "utf8")

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
