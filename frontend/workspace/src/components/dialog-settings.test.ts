import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { SETTINGS_PANELS } from "./settings/registry"

const source = () => readFileSync(fileURLToPath(new URL("./dialog-settings.tsx", import.meta.url)), "utf8")
const appSource = () => readFileSync(fileURLToPath(new URL("../app.tsx", import.meta.url)), "utf8")
const registeredPanelSources = () => {
  const registry = readFileSync(fileURLToPath(new URL("./settings/registry.ts", import.meta.url)), "utf8")
  const modules = [...registry.matchAll(/import\("\.\/([^"\)]+)"\)/g)].map((match) => match[1]!)
  expect(modules).toHaveLength(SETTINGS_PANELS.length)

  const files = [
    ...modules.map(
      (module) => [`settings/${module}.tsx`, new URL(`./settings/${module}.tsx`, import.meta.url)] as const,
    ),
    ["settings/_shared.tsx", new URL("./settings/_shared.tsx", import.meta.url)] as const,
    ["settings/ManagedInference.tsx", new URL("./settings/ManagedInference.tsx", import.meta.url)] as const,
    ["settings/CodexConnection.tsx", new URL("./settings/CodexConnection.tsx", import.meta.url)] as const,
    ["settings/ProviderKeys.tsx", new URL("./settings/ProviderKeys.tsx", import.meta.url)] as const,
    ["settings/ProviderLogo.tsx", new URL("./settings/ProviderLogo.tsx", import.meta.url)] as const,
    ["settings/CredentialServices.tsx", new URL("./settings/CredentialServices.tsx", import.meta.url)] as const,
    ["settings-general.tsx", new URL("./settings-general.tsx", import.meta.url)] as const,
    ["settings-permissions.tsx", new URL("./settings-permissions.tsx", import.meta.url)] as const,
    ["link.tsx", new URL("./link.tsx", import.meta.url)] as const,
    ["atlas/SkillsPage.tsx", new URL("../atlas/SkillsPage.tsx", import.meta.url)] as const,
    ["atlas/skills-page.css", new URL("../atlas/skills-page.css", import.meta.url)] as const,
    ["settings/skills.css", new URL("./settings/skills.css", import.meta.url)] as const,
  ]

  return files.map(([name, url]) => ({ name, source: readFileSync(fileURLToPath(url), "utf8") }))
}

test("settings use a compact responsive navigation frame", () => {
  const dialog = source()

  expect(dialog).toContain('class="settings-layout"')
  expect(dialog).toContain('class="settings-nav"')
  expect(dialog).toContain('class="settings-nav__sections')
  expect(dialog).toContain('class="settings-nav__item')
  expect(dialog).toContain('aria-label="Earlier settings sections"')
  expect(dialog).toContain('aria-label="Later settings sections"')
  expect(dialog).toContain("navSections.scrollBy")
  expect(dialog).toContain("disabled={!navCanScrollBack()}")
  expect(dialog).toContain("disabled={!navCanScrollForward()}")
  expect(dialog).toContain("scrollIntoView")
  expect(dialog).toContain('class="settings-main__viewport"')
  expect(dialog).toContain("@media (max-width: 980px)")
  expect(dialog).toMatch(/\.settings-nav__sections\s*\{[^}]*min-height: 0;[^}]*flex: 1;[^}]*overflow-y: auto/s)
  expect(dialog).toMatch(
    /@media \(max-width: 980px\)[\s\S]*\.settings-nav__sections::-webkit-scrollbar\s*\{[^}]*display: block;[^}]*height: 3px/s,
  )
  expect(dialog).toMatch(
    /@media \(max-width: 980px\)[\s\S]*\.settings-nav\s*\{[^}]*grid-template-columns: 32px minmax\(0, 1fr\) 32px/s,
  )
  expect(dialog).toMatch(/\.settings-main\s*\{[^}]*min-width: 0;[^}]*min-height: 0;[^}]*overflow: hidden/s)
  expect(dialog).toMatch(/\.settings-main__viewport\s*\{[^}]*min-width: 0;[^}]*min-height: 0;[^}]*overflow: hidden/s)
  expect(dialog).not.toContain("w-[224px]")
})

test("settings enforce one sentence-case typography system", () => {
  const dialog = source()

  expect(dialog).toContain(".settings-dialog {")
  expect(dialog).toContain("font-family: var(--font-family-sans)")
  expect(dialog).toContain(".settings-section-label")
  expect(dialog).toMatch(/\.settings-nav__item\s*\{[^}]*min-height: 32px/s)
  expect(dialog).toMatch(/\.settings-nav__item\s*\{[^}]*font-size: 13px/s)
  expect(dialog).toMatch(/\.settings-nav__item\s*\{[^}]*font-weight: var\(--font-weight-regular\)/s)
  expect(dialog).toMatch(
    /\.settings-nav__item\[data-active="true"\]\s*\{[^}]*font-weight: var\(--font-weight-medium\)/s,
  )
  expect(dialog).toContain('size="normal"')
  expect(dialog).toContain('title="Settings"')
  expect(dialog).toMatch(/\.settings-dialog > \[data-slot="dialog-header"\]\s*\{[^}]*clip-path: inset\(50%\)/s)
  expect(dialog).not.toContain('class="settings-main__title"')
  expect(dialog).not.toContain("text-14-medium text-text-strong truncate pl-1")
  expect(dialog).toMatch(
    /\.settings-page-header h2\s*\{[^}]*display: block;[^}]*font-size: var\(--settings-type-title\)/s,
  )
  expect(dialog).toMatch(
    /\.settings-dialog \.settings-page-header h2\s*\{[^}]*font-weight: var\(--font-weight-medium\)/s,
  )
  expect(dialog).toMatch(/\.settings-dialog \.text-16-medium\s*\{[^}]*font-size: var\(--settings-type-title\)/s)
  expect(dialog).toMatch(/\.settings-dialog \.text-14-medium\s*\{[^}]*font-size: var\(--settings-type-heading\)/s)
  expect(dialog).toMatch(/\.settings-dialog \.text-13-regular\s*\{[^}]*font-size: var\(--settings-type-body\)/s)
  expect(dialog).toContain(".text-12-regular, .text-11-regular, .text-10-regular")
  expect(dialog).not.toContain('.settings-dialog [style*="font-size"]')
  expect(dialog).not.toContain("font-size: 12px !important")
  expect(dialog).not.toContain("text-transform")
  expect(dialog).toContain("@media (prefers-reduced-transparency: reduce)")
  expect(dialog).toContain("@media (prefers-reduced-motion: reduce)")
  expect(dialog).toContain("-webkit-font-smoothing: antialiased")
  expect(dialog).toContain("font-synthesis: none")
  expect(dialog).toContain("text-wrap: balance")
  expect(dialog).toContain("text-wrap: pretty")
  expect(dialog).toMatch(/\.settings-nav__label\s*\{[^}]*color: var\(--text-weak\)/s)
})

test("settings follow the userinterface interaction and spacing rules", () => {
  const dialog = source()
  const switchCss = readFileSync(
    fileURLToPath(new URL("../../../ui/src/components/switch.css", import.meta.url)),
    "utf8",
  )

  expect(dialog).toContain("--settings-space-1: 4px")
  expect(dialog).toContain("--settings-space-7: 48px")
  expect(dialog).toContain("background 140ms ease")
  expect(dialog).toContain("transform 120ms ease")
  expect(switchCss).toContain("transform 150ms ease")
  expect(dialog).toMatch(
    /\.settings-dialog :where\(button, input, select, textarea\):focus-visible\s*\{[^}]*transition-duration: 0ms/s,
  )
  expect(dialog).toContain("@media (pointer: coarse)")
  expect(dialog).toContain("min-height: 44px")
  expect(dialog).not.toContain("transition: all")
})

test("settings navigation uses a quiet tonal selection without a bordered pill", () => {
  const dialog = source()

  expect(dialog).toContain("--settings-selection: color-mix(in srgb, var(--text-strong) 8%, transparent)")
  expect(dialog).toMatch(
    /\.settings-nav__item\s*\{[^}]*min-height: 32px;[^}]*border: 0;[^}]*background: transparent;[^}]*box-shadow: none/s,
  )
  expect(dialog).toMatch(
    /\.settings-nav__item\[data-active="true"\]\s*\{[^}]*background: var\(--settings-selection\);[^}]*color: var\(--text-strong\);[^}]*box-shadow: none/s,
  )
  expect(dialog).toMatch(
    /\.settings-nav__item:focus-visible\s*\{[^}]*outline: 2px solid var\(--color-focus\);[^}]*outline-offset: 1px/s,
  )
  expect(dialog).not.toContain("border-bottom-color: var(--text-base)")
})

test("settings acknowledge panel navigation before lazy work settles", () => {
  const dialog = source()

  expect(dialog).not.toContain("preloadSettingsPanels")
  expect(dialog).not.toContain("await preloadPanel(id)")
  expect(dialog).toContain("Navigation acknowledges synchronously")
  expect(dialog).toContain("setMounted((panels)")
  expect(dialog).toContain("void preloadPanel(id)")
  expect(dialog).toContain("requestIdle.call(window, preloadSkills, { timeout: 1_200 })")
  expect(dialog).toContain("onPointerEnter={() => void preloadPanel(panel.id)")
  expect(dialog).toContain("onFocus={() => void preloadPanel(panel.id)")
})

test("settings keep a restrained surface stack and aligned panel grid", () => {
  const dialog = source()

  expect(dialog).toContain("width: min(calc(100vw - 32px), 1180px)")
  expect(dialog).toContain("height: min(calc(100vh - 40px), 800px)")
  expect(dialog).toMatch(/\.settings-nav\s*\{[^}]*width: 208px;[^}]*flex: 0 0 208px/s)
  expect(dialog).toMatch(
    /\.settings-page-header\s*\{[^}]*width: 100%;[^}]*padding: var\(--settings-space-5\) var\(--settings-space-6\) var\(--settings-space-3\)/s,
  )
  expect(dialog).toMatch(/\.settings-page-header__inner\s*\{[^}]*width: min\(100%, 900px\)[^}]*margin-inline: auto/s)
  expect(dialog).toMatch(
    /\.settings-page-body\s*\{[^}]*width: 100%;[^}]*max-width: 900px[^}]*margin-inline: auto[^}]*padding: var\(--settings-space-3\) var\(--settings-space-6\) var\(--settings-space-7\)/s,
  )
  expect(dialog).not.toContain("linear-gradient")
  expect(dialog).toContain(".settings-card {")
  expect(dialog).toContain(".settings-row {")
  expect(dialog).not.toMatch(/bg-surface-base\/\d+/)
  expect(dialog).not.toMatch(/rounded-\[\d+(?:\.\d+)?px\]/)
})

test("settings keep disabled controls visibly distinct from active actions", () => {
  const dialog = source()

  expect(dialog).toMatch(
    /\[data-component="button"\]:is\(:disabled, \[data-disabled\], \[aria-disabled="true"\]\)\s*\{[^}]*cursor: not-allowed;[^}]*opacity: 0\.48;[^}]*pointer-events: none/s,
  )
  expect(dialog).toMatch(
    /\[data-component="switch"\]:is\(\[data-disabled\], \[aria-disabled="true"\]\)\s*\{[^}]*cursor: not-allowed;[^}]*opacity: 0\.48/s,
  )
  expect(dialog).toContain("--switch-active-color: var(--settings-toggle-active)")
  expect(dialog).not.toMatch(/\[data-slot="switch-control"\]\s*\{[^}]*width:/s)
})

test("settings search and filter controls expose contextual accessible names", () => {
  const shared = readFileSync(fileURLToPath(new URL("./settings/_shared.tsx", import.meta.url)), "utf8")
  const skills = readFileSync(fileURLToPath(new URL("../atlas/SkillsPage.tsx", import.meta.url)), "utf8")

  expect(shared).toContain('aria-label={props.ariaLabel ?? props.placeholder ?? "Search"}')
  expect(shared).toContain("aria-label={props.ariaLabel}")
  expect(skills).toContain('ariaLabel="Filter skills by source"')
  expect(skills).toContain('ariaLabel="Filter skills by category"')
})

test("settings reuse workspace surfaces and adaptive boundaries without a parallel palette", () => {
  const dialog = source()

  expect(dialog).toContain("--settings-canvas: var(--background-base)")
  expect(dialog).toContain("--settings-rail: var(--background-weak)")
  expect(dialog).toContain("--settings-surface: var(--surface-raised-stronger-non-alpha)")
  expect(dialog).toContain("--settings-border: var(--border-base)")
  expect(dialog).toContain("--settings-accent: var(--border-selected)")
  expect(dialog).toContain("--settings-shadow-card: none")
  expect(dialog).not.toMatch(/#(?:007aff|0a84ff|0066d6|409cff)/i)
  expect(dialog).toMatch(/\[data-slot="dialog-container"\]\s*\{[^}]*border: 1px solid var\(--settings-border\)/s)
  expect(dialog).toMatch(/\.settings-nav\s*\{[^}]*border-right: 1px solid var\(--settings-border\)/s)
  expect(dialog).toMatch(/\.settings-main__header\s*\{[^}]*border-bottom: 1px solid var\(--settings-border\)/s)
  expect(dialog).toMatch(/\.settings-card\s*\{[^}]*border: 0;[^}]*box-shadow: none/s)
  expect(dialog).toMatch(/\.settings-row\s*\{[^}]*border: 0;[^}]*border-radius: var\(--settings-radius-control\)/s)
  expect(dialog).not.toContain("backdrop-filter: saturate")
})

test("settings use one concentric radius ladder and one structural boundary owner", () => {
  const dialog = source()

  expect(dialog).toContain("--settings-radius-control: var(--radius-xs, 8px)")
  expect(dialog).toContain("--settings-radius-card: var(--radius-md, 12px)")
  expect(dialog).toContain("--settings-radius-modal: var(--radius-lg, 16px)")
  expect(dialog).toContain("--settings-radius-pill: 999px")
  expect(dialog).toContain("border-radius: calc(var(--settings-radius-control) - 2px)")
  expect(dialog).toMatch(/\.settings-card\s*\{[^}]*border-radius: var\(--settings-radius-card\)/s)
  expect(dialog).toMatch(/\.settings-row\s*\{[^}]*border-radius: var\(--settings-radius-control\)/s)
  expect(dialog).not.toMatch(/\.settings-list\s*\{[^}]*border:/s)
})

test("settings expose a panel container without owning bespoke panel layouts", () => {
  const dialog = source()

  expect(dialog).toMatch(/\.settings-main\s*\{[^}]*container-name: settings-main;[^}]*container-type: inline-size/s)
  expect(dialog).toContain("@container settings-main (max-width: 600px)")
  expect(dialog).not.toContain(".settings-skills")
  expect(dialog).not.toContain(".skills-workspace")
})

test("every registered settings panel uses the shared semantic surface contract", () => {
  const forbidden = [
    ["raw pixel radius utility", /rounded-\[\d+(?:\.\d+)?px\]/],
    ["dark alpha surface utility", /bg-surface-base\/\d+/],
    ["inline 4px radius", /(?:border-radius|["']border-radius["']|borderRadius)\s*:\s*["']?4px/],
  ] as const
  const violations = registeredPanelSources().flatMap(({ name, source }) =>
    forbidden.flatMap(([label, pattern]) => (pattern.test(source) ? [`${name}: ${label}`] : [])),
  )

  expect(violations).toEqual([])
})

test("settings dialog makes every registered capability navigable", () => {
  const dialog = source()
  const skills = SETTINGS_PANELS.find((panel) => panel.id === "skills")
  const models = SETTINGS_PANELS.find((panel) => panel.id === "models")
  const compute = SETTINGS_PANELS.find((panel) => panel.id === "compute")
  const permissions = SETTINGS_PANELS.find((panel) => panel.id === "permissions")

  expect(skills?.title).toBe("Skills")
  expect(models?.icon).toBe("models")
  expect(compute?.icon).toBe("cpu")
  expect(permissions?.icon).toBe("shield")
  expect(dialog).toContain("SETTINGS_PANELS.filter((p) => p.section === section.id)")
  expect(dialog).toContain("onClick={() => void navigate(panel.id)}")
  expect(dialog).toContain('aria-current={current().id === panel.id ? "page" : undefined}')
  expect(dialog).toContain("<SettingsPanelStack")
})

test("settings preload by intent while retaining visited panel state", () => {
  const dialog = source()
  const app = appSource()

  expect(app).toContain("onMount(() => void preloadPanel(DEFAULT_PANEL)")
  expect(dialog).not.toContain("void preloadPanel(DEFAULT_PANEL)")
  expect(dialog).not.toContain("void preloadSettingsPanels()")
  expect(dialog).not.toContain("await preloadPanel(id)")
  expect(dialog).toContain("requestIdle.call(window, preloadSkills")
  expect(dialog).toContain("void preloadPanel(id)")
  expect(dialog).toContain("setMounted((panels)")
  expect(dialog).toContain("SettingsPanelStack active={() => current().id} panels={mounted}")
  expect(dialog).not.toContain("<Dynamic component={current().component}")
  expect(dialog).not.toContain("Loading…")
  expect(dialog).not.toContain("transition\n")
})
