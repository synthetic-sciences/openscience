import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const panelNames = ["Network", "Permissions", "Storage", "Sandbox", "General"] as const
const source = (name: (typeof panelNames)[number]) =>
  readFileSync(fileURLToPath(new URL(`./${name}.tsx`, import.meta.url)), "utf8")
const compute = readFileSync(fileURLToPath(new URL("./Compute.tsx", import.meta.url)), "utf8")
const styles = readFileSync(fileURLToPath(new URL("./preference-panels.css", import.meta.url)), "utf8")

describe("minimal grouped settings panels", () => {
  test.each([...panelNames])("opts %s into the shared preference surface", (name) => {
    const component = source(name)

    expect(component).toContain('import "./preference-panels.css"')
    expect(component).toContain("settings-preferences-panel")
    expect(component).toContain("settings-preferences-card")
  })

  test("uses comfortable targets, fast pointer feedback, and instant keyboard focus", () => {
    expect(styles).toContain("min-width: 32px")
    expect(styles).toContain("min-height: 32px")
    expect(styles).toContain("150ms ease")
    expect(styles).toContain(":focus-visible")
    expect(styles).toContain("transition: none")
  })

  test("uses progressive disclosure and aligned numeric metrics", () => {
    expect(source("Permissions")).toContain("Show all tool defaults")
    expect(source("Permissions")).toContain("aria-expanded={showAllDefaults()}")
    expect(source("General")).toContain("Show sound and update settings")
    expect(source("General")).toContain("aria-expanded={showAdvanced()}")
    expect(styles).toContain('data-expanded="false"')
    expect(styles).toContain("font-variant-numeric: tabular-nums")
  })

  test("keeps the operational settings paths and actions intact", () => {
    expect(source("Network")).toContain("commitNetworkState")
    expect(source("Permissions")).toContain("permission.standing.revoke")
    expect(source("Permissions")).toContain("project.trust.update")
    expect(source("Storage")).toContain('method: "POST"')
    expect(source("Storage")).toContain('method: "DELETE"')
    expect(source("Storage")).toContain('role="progressbar"')
    expect(source("Sandbox")).toContain('call<SelfTest>("/test", { method: "POST" })')
    expect(source("Sandbox")).toContain('aria-live="polite"')
    expect(source("General")).toContain("sdk.client.account.logout()")
    expect(source("General")).not.toContain('settingsApi<Preferences>(base(), fetchFn(), "/settings/preferences"')
    expect(source("General")).not.toContain('title="Gateway"')
    expect(source("General")).not.toContain('title="Trace"')
  })

  test("avoids the previous nested form divider in storage", () => {
    expect(source("Storage")).not.toContain("border-t border-border-weak-base")
    expect(styles).toContain("spacing instead of nested separators")
    expect(styles).not.toContain("settings-row:not(:last-child)::after")
  })

  test("keeps Network and Compute on the same flat responsive surface language", () => {
    expect(source("Network")).toContain("settings-network-disclosure")
    expect(compute).toContain("settings-preferences-panel--compute")
    expect(styles).toMatch(/\.settings-preferences-panel \.settings-card\s*\{[^}]*border: 0;/s)
    expect(styles).toContain(".settings-compute-host-actions")
    expect(styles).toContain("@container settings-main (max-width: 680px)")
    expect(styles).not.toContain("border: 1px solid var(--settings-border);")
  })
})
