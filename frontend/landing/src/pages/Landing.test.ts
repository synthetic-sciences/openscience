import { describe, expect, test } from "bun:test"

const landing = await Bun.file(new URL("./Landing.tsx", import.meta.url)).text()
const main = await Bun.file(new URL("../main.tsx", import.meta.url)).text()
const readme = await Bun.file(new URL("../../../../README.md", import.meta.url)).text()
const gateway = await Bun.file(new URL("../../../docs/src/content/openscience/gateway.mdx", import.meta.url)).text()
const security = await Bun.file(new URL("../../../docs/src/content/openscience/security.mdx", import.meta.url)).text()
const docs = await Bun.file(new URL("../../public/docs/index.html", import.meta.url)).text()
const asset = docs.match(/assets\/(index-[^"']+\.js)/)?.[1]
if (!asset) throw new Error("Built docs index does not reference a JavaScript bundle")
const bundle = await Bun.file(new URL(`../../public/docs/assets/${asset}`, import.meta.url)).text()

test("keeps the public bundled-skill count current", () => {
  expect(readme).toContain("311 bundled skills")
  expect(bundle).toContain("311 bundled skills")
  expect(`${readme}\n${bundle}`).not.toContain("310 bundled")
  expect(`${readme}\n${bundle}`).not.toContain("295 bundled")
  expect(`${readme}\n${bundle}`).not.toContain("295-skill")
})

describe("OpenScience landing contract", () => {
  test("keeps the free product independent from Ace", () => {
    expect(landing).toContain("OpenScience and your account are free")
    expect(landing).toContain("BYOK")
    expect(landing).toContain("eligible ChatGPT")
    expect(landing).toContain("Do I need Ace to use OpenScience?")
  })

  test("publishes Ace as a single pay as you go offer", () => {
    expect(landing).toContain("$20")
    expect(landing).toContain("20 credits")
    expect(landing).toContain("OpenScience Ace")
    expect(landing).toContain("PAY AS YOU GO")
    expect(landing).toContain("Models and enhanced research search")
    expect(landing).toContain("no fixed monthly charge")
    expect(landing).not.toContain("Ace+")
    expect(landing).not.toContain("per month")
    expect(landing).not.toContain("included every month")
    expect(landing).not.toContain("promotional credits")
    expect(landing).not.toContain("research quota")
  })

  test("offers a direct, platform-aware download before the product story", () => {
    expect(landing).toContain("<DownloadSection />")
    expect(landing).toContain("openscience-darwin-arm64.zip")
    expect(landing).toContain("openscience-darwin-x64.zip")
    expect(landing).toContain("openscience-windows-x64.zip")
    expect(landing).toContain("openscience-linux-x64.tar.gz")
    expect(landing).toContain("openscience-linux-arm64.tar.gz")
    expect(landing).toContain("onClick={() => setTarget(item)}")
    expect(landing.match(/id="terminal"/g)).toHaveLength(1)
    expect(landing.indexOf("<DownloadSection />")).toBeLessThan(landing.indexOf("RESEARCH LOOP"))
  })

  test("shows the real model picker and the scientific tool wall", () => {
    expect(landing).toContain("More models")
    expect(landing).toContain("Manage models")
    expect(landing).toContain("DeepSeek V4 Flash")
    expect(landing).toContain("setInterval")

    const start = landing.indexOf("const TOOLS = [")
    const end = landing.indexOf("] as const", start)
    const tools = landing.slice(start, end).match(/^\s+"[^"]+",?$/gm) ?? []
    expect(tools).toHaveLength(54)
    expect(landing).toContain("54 tools. Ready when the task calls.")
    expect(landing).toContain("function ToolLogo")
    expect(landing).toContain("data-logo={brand}")
    expect(landing).toContain("data-logo={kind}")
  })

  test("keeps internal model routing out of the editable product story", () => {
    const start = landing.indexOf("<TrustStrip />")
    const end = landing.indexOf("FAQ -----------------------------", start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(landing.slice(start, end)).not.toMatch(/OpenRouter/i)
    expect(landing.slice(start, end)).toContain("OpenScience Ace")
  })

  test("places OpenScience Ace billing immediately before Questions", () => {
    const ace = landing.indexOf('id="ace"')
    const faq = landing.indexOf('id="faq"')
    expect(ace).toBeGreaterThan(-1)
    expect(faq).toBeGreaterThan(ace)
    expect(landing.slice(ace, faq)).toContain("${APP}/billing")
    expect(landing.slice(ace, faq)).toContain("Open billing")
  })

  test("keeps Ace pricing concise and separates other access routes", () => {
    expect(landing).not.toContain("auto-reload")
    expect(landing).not.toContain("Set a monthly cap")
    expect(landing).toContain("Your remaining balance stays available.")
    expect(landing).toContain("Any processing fee is shown before payment")
    expect(landing).toContain("Local models, your own keys, and eligible ChatGPT access stay separate")
    expect(landing).not.toContain("Synthetic Scientists")
  })

  test("keeps public Ace copy aligned across the landing page, README, and docs", () => {
    for (const source of [readme, gateway]) {
      expect(source).toContain("20 credits")
      expect(source).toMatch(/pay[- ]as[- ]you[- ]go/i)
      expect(source).toMatch(/OpenRouter/i)
      expect(source).toMatch(/below 2/i)
      expect(source).not.toMatch(/Ace\+/i)
      expect(source).not.toMatch(/Synthetic Scientists/i)
      expect(source).not.toMatch(/research quota/i)
    }
    expect(landing).toContain("20 credits")
    expect(landing).toMatch(/pay[- ]as[- ]you[- ]go/i)
    expect(landing).not.toMatch(/OpenRouter/i)
    expect(landing).not.toMatch(/Ace\+/i)
  })

  test("keeps the connected-account requirement without the removed data FAQ", () => {
    expect(landing).toContain("A free Synthetic Sciences account is required")
    expect(landing).not.toContain("What data does OpenScience collect?")
    expect(landing).not.toContain("The Use my data setting is on")
    expect(landing).not.toContain("prompts, responses, tool activity, and errors")
  })

  test("uses Synthetic Sciences branding for the control plane in docs source and bundle", () => {
    for (const source of [security, bundle]) {
      expect(source).toContain("Synthetic Sciences session")
      expect(source).toContain("Synthetic Sciences service")
      expect(source).not.toContain("Gateway session")
      expect(source).not.toContain("connected to Gateway")
      expect(source).not.toContain("Gateway research search")
      expect(source).not.toContain("Gateway wallet")
    }
    expect(security).toContain("[connected to Synthetic Sciences](/openscience/gateway)")
  })

  test("does not advertise retired product surfaces", () => {
    expect(landing).not.toContain("Compute")
    expect(landing).not.toContain("Explore public")
    expect(landing).not.toContain("Atlas")
  })

  test("gives visitors an explicit website analytics control", () => {
    expect(main).toContain('window.localStorage.getItem(ANALYTICS_PREFERENCE) !== "off"')
    expect(landing).toContain('Website analytics: {analyticsEnabled ? "on" : "off"}')
  })
})
