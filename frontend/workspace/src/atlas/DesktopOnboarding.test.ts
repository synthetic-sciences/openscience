import { describe, expect, test } from "bun:test"
import { canUseManaged } from "./desktop-onboarding-access"

describe("desktop onboarding", () => {
  test("progressively discloses model access and ends at useful work", async () => {
    const source = await Bun.file(new URL("./DesktopOnboarding.tsx", import.meta.url)).text()

    expect(source).toContain("How should OpenScience run models?")
    expect(source).toContain("OpenScience Ace")
    expect(source).toContain("Use my own access")
    expect(source).toContain('accessGroup() === "own"')
    expect(source).toContain("ChatGPT / Codex")
    expect(source).toContain("Provider key")
    expect(source).toContain("Local models")
    expect(source).toContain("Your account is connected")
    expect(source).toContain("Set up models later")
    expect(source).toContain("body: JSON.stringify({ desktop_onboarding_version: 1 })")
    expect(source).toContain("Start with a real research question")
    expect(source).toContain("Open a project")
    expect(source).toContain("Describe the result")
    expect(source).not.toContain("Where should experiments run?")
    expect(source).not.toContain("Modal token")
  })

  test("shows the connected account and routes Ace setup to the dashboard", async () => {
    const source = await Bun.file(new URL("./DesktopOnboarding.tsx", import.meta.url)).text()

    expect(source).toContain('settingsApi<Account>(server.url, fetcher(), "/account")')
    expect(source).toContain('settingsApi<Wallet>(server.url, fetcher(), "/settings/wallet")')
    expect(source).toContain("must never delay the first useful screen")
    expect(source).toContain("Ace ready")
    expect(source).toContain("URLS.dashboardBilling")
    expect(source).toContain("app.syntheticsciences.ai")
    expect(source).toContain("const known = await loadAccount()")
    expect(source).toContain("canUseManaged(wallet())")
    expect(source).toContain("Account check failed")
    expect(source).toContain('accountState() === "error"')
    expect(source).toContain('"Retry"')
    expect(source).toContain('if (value === "ace") setKey("")')
    expect(source).toContain('aria-pressed={accessGroup() === "ace"}')
    expect(source).toContain("aria-pressed={route() === item.id}")
  })

  test("uses the server's Wallet-or-reload managed-access decision", () => {
    expect(canUseManaged(undefined)).toBe(false)
    expect(canUseManaged({ signedIn: true, managedSupported: false, aceEnabled: true, balanceUsd: 20 })).toBe(false)
    expect(canUseManaged({ signedIn: true, managedSupported: true, aceEnabled: false, balanceUsd: 20 })).toBe(true)
    expect(canUseManaged({ signedIn: true, managedSupported: true, aceEnabled: false, balanceUsd: null })).toBe(true)
    expect(canUseManaged({ signedIn: false, managedSupported: true, aceEnabled: true, balanceUsd: 20 })).toBe(false)
    expect(canUseManaged({ signedIn: true, managedSupported: true, aceEnabled: true, balanceUsd: 20 })).toBe(true)
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
