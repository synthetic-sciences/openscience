import { describe, expect, test } from "bun:test"

describe("workspace account gate", () => {
  test("mounts before API-backed application providers and has no skip path", async () => {
    const app = await Bun.file(new URL("../app.tsx", import.meta.url)).text()
    const gate = await Bun.file(new URL("./AccountGate.tsx", import.meta.url)).text()
    expect(app.indexOf("<AccountGate>")).toBeLessThan(app.indexOf("<GlobalSDKProvider>"))
    expect(gate).toContain("Sign in to continue")
    expect(gate).toContain("Synthetic Sciences API key")
    expect(gate).toContain("Use my data is on by default")
    expect(gate).toContain("redacted complete research")
    expect(gate).toContain('"/account/login-key"')
    expect(gate).toContain('window.addEventListener("openscience:account-changed", refresh)')
    expect(gate).toContain("window.setInterval(refresh, 30_000)")
    expect(gate).toContain('window.addEventListener("focus", refresh)')
    expect(gate).not.toContain("Not now")
    expect(gate).not.toContain("BYOK")
    expect(gate).not.toContain("ChatGPT")
  })

  test("returns to the full-page gate immediately after Settings disconnects", async () => {
    const general = await Bun.file(new URL("../components/settings/General.tsx", import.meta.url)).text()
    expect(general).toContain("sdk.client.account.logout()")
    expect(general).toContain('window.dispatchEvent(new Event("openscience:account-changed"))')
  })
})
