import { describe, expect, test } from "bun:test"
import { CONNECTORS } from "../data/connectors"

const landing = await Bun.file(new URL("./Landing.tsx", import.meta.url)).text()
const download = await Bun.file(new URL("./Download.tsx", import.meta.url)).text()
const nav = await Bun.file(new URL("../Nav.tsx", import.meta.url)).text()
const main = await Bun.file(new URL("../main.tsx", import.meta.url)).text()
const html = await Bun.file(new URL("../../index.html", import.meta.url)).text()
const readme = await Bun.file(new URL("../../../../README.md", import.meta.url)).text()
const gateway = await Bun.file(new URL("../../../docs/src/content/openscience/gateway.mdx", import.meta.url)).text()
const security = await Bun.file(new URL("../../../docs/src/content/openscience/security.mdx", import.meta.url)).text()
const catalog = Bun.spawn(
  [
    "bun",
    "-e",
    'import { registry } from "./backend/cli/src/science/connectors"; console.log(JSON.stringify(registry.catalog().map((connector) => [connector.id, connector.name, connector.homepage])))',
  ],
  {
    cwd: new URL("../../../../", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  },
)
const status = await catalog.exited
if (status !== 0) throw new Error(await new Response(catalog.stderr).text())
const shipped = (await new Response(catalog.stdout).json()) as Array<[string, string, string | undefined]>
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
    expect(landing).toMatch(/OpenScience\s+remains free/)
    expect(landing).toContain("BYOK")
    expect(landing).toContain("eligible ChatGPT")
    expect(landing).toContain("Do I need Ace to use OpenScience?")
  })

  test("publishes Ace as a single usage-based offer", () => {
    expect(landing).toContain("$20")
    expect(landing).toContain("OpenScience Ace")
    expect(landing).toContain("pay only for the models and research search you use")
    expect(landing).toContain("No monthly charge")
    expect(landing).not.toMatch(/\bcredits?\b/i)
    expect(landing).not.toContain("PAY AS YOU GO")
    expect(landing).not.toContain("Ace+")
    expect(landing).not.toContain("per month")
    expect(landing).not.toContain("included every month")
    expect(landing).not.toContain("research quota")
  })

  test("keeps installation on a dedicated platform-aware download page", () => {
    expect(landing).toContain('href="/download"')
    expect(landing).toContain("Download OpenScience")
    expect(landing).not.toContain("<DownloadSection />")
    expect(landing).not.toContain("function DownloadSection")
    expect(landing).not.toContain("<ProductShot />")
    expect(landing).not.toContain("workspaceShot")
    expect(landing).not.toContain('href="#install"')
    expect(landing).not.toContain("Install OpenScience")

    expect(main).toContain('path === "/download"')
    expect(main).toContain("<Download")
    expect(download).toContain("openscience-darwin-arm64.zip")
    expect(download).toContain("openscience-darwin-x64.zip")
    expect(download).toContain("openscience-windows-x64.zip")
    expect(download).toContain("openscience-linux-x64.tar.gz")
    expect(download).toContain("openscience-linux-arm64.tar.gz")
    expect(download).toContain("npm i -g @synsci/openscience")
    expect(download).toContain("curl -fsSL https://openscience.sh/install | bash")
    expect(download).toContain('role="group"')
    expect(download).toContain("aria-pressed")
    expect(download.match(/id="terminal"/g)).toHaveLength(1)
  })

  test("keeps one three-item navigation across the landing and download pages", () => {
    expect(landing).toContain("<Nav />")
    expect(download).toContain('<Nav current="download" />')
    expect(landing).toContain("items-center justify-center")
    expect(download).toContain("items-center justify-center")
    expect(nav).toContain('label: "Download"')
    expect(nav).toContain('label: "Docs"')
    expect(nav).toContain('label: "GitHub"')
    expect(nav).toContain('aria-label="Primary navigation"')
    expect(nav).toContain("text-foreground")
    expect(nav).not.toContain("underline")
    expect(nav).not.toContain("text-black")
    expect(nav).not.toContain("drop-shadow")
    expect(nav).not.toContain("rounded-full")
    expect(nav).not.toContain("backdrop-blur")
  })

  test("does not use long dashes in public landing copy", () => {
    expect(`${landing}\n${download}\n${nav}\n${html}`).not.toMatch(/[—–]/)
  })

  test("shows the real model picker and all shipped scientific sources", async () => {
    expect(landing).toContain("More models")
    expect(landing).toContain("Manage models")
    expect(landing).toContain("DeepSeek V4 Flash")
    expect(landing).toContain("setInterval")

    expect(CONNECTORS).toHaveLength(42)
    expect(new Set(CONNECTORS.map((connector) => connector.id)).size).toBe(42)
    expect(JSON.stringify(CONNECTORS.map((connector) => [connector.id, connector.name, connector.home]))).toBe(
      JSON.stringify(shipped),
    )
    expect(landing).toContain("42 scientific sources, searched directly.")
    expect(landing).toContain("function ConnectorLogo")
    expect(landing).toContain("<ConnectorWall />")
    expect(landing).not.toContain("const TOOLS")
    expect(landing).not.toContain("function ToolLogo")
    expect(landing).not.toContain('data-logo="protein"')

    for (const connector of CONNECTORS) {
      expect(connector.home).toMatch(/^https:\/\//)
      expect(connector.source).toMatch(/^https:\/\//)
      expect(connector.logo).toMatch(/^\/connector-logos\//)
      expect(await Bun.file(new URL(`../../public${connector.logo}`, import.meta.url)).exists()).toBe(true)
    }
  })

  test("uses alternating editorial panels for project context and model access", () => {
    const sources = landing.slice(landing.indexOf('id="sources"'), landing.indexOf("MODEL FREEDOM"))
    const models = landing.slice(landing.indexOf('id="models"'), landing.indexOf("OPEN SOURCE"))

    expect(sources).toContain("Everything the work depends on.")
    expect(sources).toContain("dither-red flex min-h-[470px]")
    expect(sources).toContain("sm:py-40")
    expect(sources.indexOf("dither-red")).toBeLessThan(sources.indexOf("<ProjectContextVisual"))

    expect(models).toContain("Use the model the work needs.")
    expect(models).toContain("dither-purple order-1 flex min-h-[470px]")
    expect(models).toContain("lg:order-2")
    expect(models).toContain("order-2 min-w-0 lg:order-1")
    expect(models).toContain("sm:py-40")
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
    expect(landing.slice(ace, faq)).toContain("Add funds")
  })

  test("keeps Ace pricing concise and separates other access routes", () => {
    expect(landing).not.toContain("auto-reload")
    expect(landing).not.toContain("Set a monthly cap")
    expect(landing).toContain("Unused balance stays in your account.")
    expect(landing).toContain("Any processing fee is shown before payment")
    expect(landing).toMatch(/Local models, your own keys, and eligible ChatGPT access remain\s+separate/)
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
    expect(landing).toContain("pay only for the models and research search you use")
    expect(landing).not.toMatch(/\bcredits?\b/i)
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
