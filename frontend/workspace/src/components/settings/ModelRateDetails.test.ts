import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import solid from "vite-plugin-solid"
import { createTestServer } from "../../../test/vite"

const server = await createTestServer({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const [subject, web] = await Promise.all([
  server.ssrLoadModule("/src/components/settings/ModelRateDetails.tsx") as Promise<typeof import("./ModelRateDetails")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])
const cleanups: Array<() => void> = []
afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

const cost = { input: 5.275, output: 31.65, cache: { read: 0.5275, write: 6.59375 } }
const mount = (props: Parameters<typeof subject.ModelRateDetails>[0]) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(() => web.createComponent(subject.ModelRateDetails, props), host))
  return host
}

test("Ace rates keep exact Wallet amounts while hiding routing hosts and fee percentages", () => {
  for (const hosting_provider of ["azure", "anthropic", "gemini", "openrouter"] as const) {
    const host = mount({
      access: "managed",
      label: "Ace",
      provider: "OpenRouter",
      pricing: { upstream_provider: "openrouter", hosting_provider, funding_fee_bps: 550 },
      cost,
      limit: { context: 1_050_000, output: 128_000 },
      fast: {
        input: 10.55,
        output: 63.3,
        cache: { read: 1.055, write: 13.1875 },
        tiers: [{ threshold: 272_000, input: 21.1, output: 94.95, cache: { read: 2.11, write: 26.375 } }],
      },
    })
    expect(host.querySelector("strong")?.textContent).toBe("Ace")
    expect(host.textContent).not.toMatch(/Azure|Anthropic|Gemini|OpenRouter|provider|fee|%/i)
    const rows = [...host.querySelectorAll("dl > div")].map((row) => [
      row.querySelector("dt")?.textContent,
      row.querySelector("dd")?.textContent,
    ])
    expect(rows).toContainEqual(["Input", "$5.275"])
    expect(rows).toContainEqual(["Output", "$31.65"])
    expect(rows).toContainEqual(["Cached input", "$0.5275"])
    expect(rows).toContainEqual(["Fast · Input", "$10.55"])
    expect(rows).toContainEqual(["Fast · Output", "$63.30"])
    expect(rows).toContainEqual(["Fast · Over 272,000 input · Input", "$21.10"])
    expect(rows).toContainEqual(["Fast · Over 272,000 input · Output", "$94.95"])
    expect(host.querySelector("p")?.textContent).toBe("USD per 1M tokens · Wallet rates.")
  }
})

test("provider-key rates remain distinct and subscriptions claim no token price", () => {
  const byok = mount({
    access: "byok",
    label: "BYOK",
    provider: "Anthropic",
    cost,
    limit: { context: 1_000_000, output: 128_000 },
  })
  expect(byok.querySelector("strong")?.textContent).toBe("BYOK · Anthropic")
  expect(byok.querySelector("p")?.textContent).toBe("USD per 1M tokens · catalog estimate; billed by your provider.")
  const subscription = mount({
    access: "chatgpt",
    label: "ChatGPT",
    provider: "OpenAI",
    cost,
    limit: { context: 272_000, output: 128_000 },
  })
  expect(subscription.textContent).toContain("Included with an eligible ChatGPT subscription.")
  expect(subscription.textContent).not.toContain("$")
})
