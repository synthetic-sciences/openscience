import { describe, expect, test } from "bun:test"

const landing = await Bun.file(new URL("./Landing.tsx", import.meta.url)).text()
const main = await Bun.file(new URL("../main.tsx", import.meta.url)).text()
const readme = await Bun.file(new URL("../../../../README.md", import.meta.url)).text()
const gateway = await Bun.file(new URL("../../../docs/src/content/openscience/gateway.mdx", import.meta.url)).text()

describe("OpenScience landing contract", () => {
  test("keeps the free product independent from Ace", () => {
    expect(landing).toContain("The desktop and local runtime remain free")
    expect(landing).toContain("BYOK")
    expect(landing).toContain("eligible ChatGPT")
    expect(landing).toContain("Do I need Ace to use OpenScience?")
  })

  test("publishes Ace as a single pay as you go offer", () => {
    expect(landing).toContain("$20")
    expect(landing).toContain("20 credits")
    expect(landing).toContain("to start")
    expect(landing).toContain("OpenScience is free. Ace is pay as you go.")
    expect(landing).toContain("Managed models through OpenRouter")
    expect(landing).toContain("One balance for models and enhanced search")
    expect(landing).not.toContain("Ace+")
    expect(landing).not.toContain("per month")
    expect(landing).not.toContain("included every month")
    expect(landing).not.toContain("promotional credits")
    expect(landing).not.toContain("research quota")
  })

  test("explains Zen-style reload and separates the processing fee from credits", () => {
    expect(landing).toContain("Reloads 20 credits below 5")
    expect(landing).toContain("Change or disable it anytime")
    expect(landing).toContain("Processing fee shown before payment")
    expect(landing).toContain("never added to your credit balance")
    expect(landing).not.toContain("Synthetic Scientists")
  })

  test("keeps public Ace copy aligned across the landing page, README, and docs", () => {
    for (const source of [landing, readme, gateway]) {
      expect(source).toContain("20 credits")
      expect(source).toMatch(/pay[- ]as[- ]you[- ]go/i)
      expect(source).toMatch(/OpenRouter/i)
      expect(source).toMatch(/below 5/i)
      expect(source).not.toMatch(/Ace\+/i)
      expect(source).not.toMatch(/Synthetic Scientists/i)
      expect(source).not.toMatch(/research quota/i)
    }
  })

  test("states the account and full-session data contract plainly", () => {
    expect(landing).toContain("A free Synthetic Sciences account is required")
    expect(landing).toContain("The Use my data setting is on")
    expect(landing).toContain("prompts, responses, tool activity, and errors")
    expect(landing).toMatch(/Turn\s+it\s+off anytime in Settings/)
  })

  test("does not advertise retired product surfaces", () => {
    expect(landing).not.toContain("Compute")
    expect(landing).not.toContain("Explore public")
  })

  test("gives visitors an explicit website analytics control", () => {
    expect(main).toContain('window.localStorage.getItem(ANALYTICS_PREFERENCE) !== "off"')
    expect(landing).toContain('Website analytics: {analyticsEnabled ? "on" : "off"}')
  })
})
