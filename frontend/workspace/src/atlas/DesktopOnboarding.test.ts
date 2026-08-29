import { describe, expect, test } from "bun:test"
import { canUseManaged } from "./desktop-onboarding-access"

describe("desktop onboarding", () => {
  test("opens the workspace directly and keeps model setup optional", async () => {
    const source = await Bun.file(new URL("./DesktopOnboarding.tsx", import.meta.url)).text()

    expect(source).toContain("Open your workspace")
    expect(source).toContain("Open workspace")
    expect(source).toContain("Model access")
    expect(source).toContain("Optional · set up now or later")
    expect(source).toContain("Model setup is not required to open the workspace")
    expect(source).toContain("OpenScience Ace")
    expect(source).toContain("Provider key")
    expect(source).toContain("ChatGPT / Codex")
    expect(source).toContain("Customize → Local models")
    expect(source).toContain("Your account is connected")
    expect(source).toContain("body: JSON.stringify({ desktop_onboarding_version: 1 })")
    expect(source).not.toContain("Setup step")
    expect(source).not.toContain("Start with a real research question")
    expect(source).not.toContain("Selected model access")
    expect(source).not.toContain('route() === "chatgpt"')
    expect(source).not.toContain('route() === "local"')
    expect(source).not.toContain("Where should experiments run?")
    expect(source).not.toContain("Modal token")
  })

  test("shows the connected account and routes Ace setup to the dashboard", async () => {
    const source = await Bun.file(new URL("./DesktopOnboarding.tsx", import.meta.url)).text()

    expect(source).toContain('settingsApi<Account>(server.url, fetcher(), "/account")')
    expect(source).toContain('settingsApi<ManagedWallet>(server.url, fetcher(), "/settings/wallet")')
    expect(source).toContain("never delay the")
    expect(source).toContain("Ace available")
    expect(source).toContain("URLS.dashboardBilling")
    expect(source).toContain("app.syntheticsciences.ai")
    expect(source).toContain('const known = accountState() === "ready" ? true : await loadAccount()')
    expect(source).toContain("canUseManaged(wallet())")
    expect(source).toContain("Account check failed")
    expect(source).toContain('accountState() === "error"')
    expect(source).toContain('"Retry"')
    expect(source).toContain('body: JSON.stringify({ mode: "managed" })')
    expect(source).toContain('body: JSON.stringify({ mode: "byok" })')
    expect(source).toContain('configured() === "ace"')
  })

  test("uses the server's Wallet-or-reload managed-access decision", () => {
    expect(canUseManaged(undefined)).toBe(false)
    expect(
      canUseManaged({
        signedIn: true,
        managedSupported: false,
        managedUnlocked: true,
        aceEnabled: true,
        balanceUsd: 20,
      }),
    ).toBe(false)
    expect(
      canUseManaged({
        signedIn: true,
        managedSupported: true,
        managedUnlocked: true,
        aceEnabled: false,
        balanceUsd: 20,
      }),
    ).toBe(true)
    expect(
      canUseManaged({
        signedIn: true,
        managedSupported: true,
        managedUnlocked: true,
        aceEnabled: false,
        balanceUsd: null,
      }),
    ).toBe(true)
    expect(
      canUseManaged({
        signedIn: false,
        managedSupported: true,
        managedUnlocked: true,
        aceEnabled: true,
        balanceUsd: 20,
      }),
    ).toBe(false)
    expect(
      canUseManaged({
        signedIn: true,
        managedSupported: true,
        managedUnlocked: true,
        aceEnabled: true,
        balanceUsd: 0,
      }),
    ).toBe(true)
    expect(
      canUseManaged({
        signedIn: true,
        managedSupported: true,
        managedUnlocked: false,
        aceEnabled: false,
        balanceUsd: 0,
      }),
    ).toBe(false)
  })

  test("keeps interactions compact, responsive, and motion restrained", async () => {
    const css = await Bun.file(new URL("./DesktopOnboarding.css", import.meta.url)).text()

    expect(css).toContain("min-height: 32px")
    expect(css).toContain("150ms ease")
    expect(css).toContain("@media (prefers-reduced-motion: reduce)")
    expect(css).toContain("@media (max-width: 640px)")
    expect(css).toContain(":focus-visible")
    expect(css).not.toContain("@keyframes")
    expect(css).not.toContain("animation:")
  })
})
