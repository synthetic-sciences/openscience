import { describe, expect, test } from "bun:test"

describe("workspace account gate", () => {
  test("requires account connection before the skippable model setup", async () => {
    const app = await Bun.file(new URL("../app.tsx", import.meta.url)).text()
    const gate = await Bun.file(new URL("./AccountGate.tsx", import.meta.url)).text()
    const onboarding = await Bun.file(new URL("./DesktopOnboarding.tsx", import.meta.url)).text()
    expect(app.indexOf("<AccountGate>")).toBeLessThan(app.indexOf("<GlobalSDKProvider>"))
    expect(gate).toContain("Connect OpenScience")
    expect(gate).toContain("Model access stays optional")
    expect(gate).toContain("Synthetic Sciences API key")
    expect(gate).toContain("Improve OpenScience is on by default")
    expect(gate).toContain("redacted research activity")
    expect(gate).toContain('"/account/login-key"')
    expect(gate).toContain('window.addEventListener("openscience:account-changed", refresh)')
    expect(gate).toContain("window.setInterval(refresh, 30_000)")
    expect(gate).toContain('window.addEventListener("focus", refresh)')
    expect(gate).not.toContain("Not now")
    expect(gate).not.toContain("BYOK")
    expect(gate).not.toContain("ChatGPT")
    expect(gate).toContain("<DesktopOnboarding>{props.children}</DesktopOnboarding>")
    expect(gate).not.toContain("Setup overview")
    expect(onboarding).toContain("Account connected")
    expect(onboarding).toContain("Open a folder")
    expect(onboarding).toContain("Model setup is optional")
  })

  test("returns to the full-page gate immediately after Settings disconnects", async () => {
    const general = await Bun.file(new URL("../components/settings/General.tsx", import.meta.url)).text()
    expect(general).toContain("sdk.client.account.logout()")
    expect(general).toContain('window.dispatchEvent(new Event("openscience:account-changed"))')
  })

  test("keeps signed-out updates reachable without claiming unsupported in-app capability", async () => {
    const gate = await Bun.file(new URL("./AccountGate.tsx", import.meta.url)).text()
    expect(gate).toContain("<SignedOutUpdate />")
    expect(gate).toContain("platform.stageUpdate")
    expect(gate).toContain("Automatic installation is unavailable in this browser or desktop build")
    expect(gate).toContain("Download installer")
  })
})
