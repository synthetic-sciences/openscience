import { expect, test } from "bun:test"

const source = Bun.file(new URL("./Sandbox.tsx", import.meta.url)).text()
const styles = Bun.file(new URL("./sandbox.css", import.meta.url)).text()

test("sandbox keeps active native backends available and their fixed policies truthful", async () => {
  const component = await source

  expect(component).toContain('s().available ? "Available" : "Unavailable"')
  expect(component).toContain('current.backend === "seatbelt" || current.backend === "bubblewrap"')
  expect(component).toContain("const grantOnlyEnforced")
  expect(component).toContain("const networkDenyEnforced")
  expect(component).toContain('capability === "grant_only" || (capability === undefined && nativeBackendActive())')
  expect(component).toContain('capability === "deny_all" || (capability === undefined && nativeBackendActive())')
  expect(component).not.toContain('status()?.readIsolation === "grant_only" || nativeBackendActive()')
  expect(component).not.toContain('status()?.networkIsolation === "deny_all" || nativeBackendActive()')
  expect(component).toContain("Reads and writes are limited to the workspace and approved paths.")
  expect(component).toContain("including loopback, LAN, link-local, and metadata endpoints")
  expect(component).toContain('disabled={busy("network") || unavailable() || networkDenyEnforced()}')
  expect(component).not.toContain('s().available && s().readIsolation === "grant_only" ? "Available"')
})

test("sandbox mutations respond optimistically while server writes stay ordered", async () => {
  const component = await source

  expect(component).toContain("mutate({ ...current, config: { ...current.config, ...body } })")
  expect(component).toContain("writeQueue.push({ body, key, failure })")
  expect(component).toContain("while (writeQueue.length > 0)")
  expect(component).toContain("config: pendingConfig(confirmed.config)")
  expect(component).toContain('busy("enabled")')
  expect(component).toContain('busy("network")')
  expect(component).toContain('busy("fallback")')
  expect(component).toContain('busy("paths")')
  expect(component).not.toContain("disabled={busy()")
})

test("sandbox progressively discloses technical facts and self-test checks", async () => {
  const component = await source

  expect(component).toContain("aria-controls={backendDetailsId}")
  expect(component).toContain("aria-expanded={showBackendDetails()}")
  expect(component).toContain("aria-controls={testDetailsId}")
  expect(component).toContain("aria-expanded={showTestDetails()}")
  expect(component).toContain('aria-live="polite"')
  expect(component).toContain('call<SelfTest>("/test", { method: "POST" })')
})

test("sandbox removes redundant icon columns and owns explicit narrow layouts", async () => {
  const component = await source
  const css = await styles

  expect(component).not.toContain('name="shield"')
  expect(component).not.toContain('name="shield-alert"')
  expect(component).not.toContain('name="folder"')
  expect(component).not.toContain('name="plus"')
  expect(component).not.toContain('name="checklist"')
  expect(css).toContain("grid-template-columns: minmax(0, 1fr) max-content")
  expect(css).toContain("@container settings-main (max-width: 520px)")
  expect(css).toContain("min-height: 32px")
  expect(css).toContain("150ms ease")
  expect(css).toContain(":focus-visible")
  expect(css).toContain("transition: none")
})
