import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

const server = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: {
    noExternal: true,
    external: ["fuzzysort"],
    resolve: { conditions: ["browser", "production"] },
  },
})
const [subject, web] = await Promise.all([
  server.ssrLoadModule("/src/components/model-settings-popover.tsx") as Promise<
    typeof import("./model-settings-popover")
  >,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])
const cleanups: Array<() => void> = []

afterAll(() => server.close())

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(view, host))
  return host
}

const press = async (target: HTMLElement, key: string) => {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))
  await Promise.resolve()
}

describe("inference source classification", () => {
  test("labels only what the client can prove and omits ambiguous routes", () => {
    expect(subject.inferenceSource({ providerID: "synsci", credential: "custom" })).toBe("managed")
    expect(subject.inferenceSource({ providerID: "synsci-demo", credential: "env" })).toBe("managed")
    expect(subject.inferenceSource({ providerID: "openai-codex", credential: "custom" })).toBe("chatgpt")
    expect(subject.inferenceSource({ providerID: "anthropic", credential: "api" })).toBe("byok")
    expect(subject.inferenceSource({ providerID: "anthropic", credential: "env" })).toBe("byok")
    expect(subject.inferenceSource({ providerID: "xai", credential: "config" })).toBe("byok")
    // Own gateway key in the local auth store is decisive: own key wins server-side.
    expect(subject.inferenceSource({ providerID: "openrouter", credential: "api" })).toBe("byok")
    // A gateway env credential can be an own key or the synced managed token — no claim.
    expect(subject.inferenceSource({ providerID: "openrouter", credential: "env" })).toBeUndefined()
    expect(subject.inferenceSource({ providerID: "openrouter", credential: "env", billing: "managed" })).toBeUndefined()
    // Explicit byok billing drops managed credentials server-side, so a surviving gateway is the user's own.
    expect(subject.inferenceSource({ providerID: "openrouter", credential: "env", billing: "byok" })).toBe("byok")
    // OAuth subscriptions outside ChatGPT and config-defined custom providers stay unlabeled.
    expect(subject.inferenceSource({ providerID: "github-copilot", credential: "custom" })).toBeUndefined()
    // provider.source itself now says "managed" once a route is genuinely wallet-billed
    // (the gateway's managed-proxy branch, or a synced token with no own key under
    // auto-detect) — trust it outright, regardless of the billing toggle's value.
    expect(subject.inferenceSource({ providerID: "openrouter", credential: "managed" })).toBe("managed")
    expect(subject.inferenceSource({ providerID: "openrouter", credential: "managed", billing: "managed" })).toBe(
      "managed",
    )
  })

  test("labels model access without changing provider routing ids", () => {
    expect(subject.inferenceSourceLabel("chatgpt")).toBe("ChatGPT")
    expect(subject.inferenceSourceLabel("byok")).toBe("API key")
    expect(subject.inferenceSourceLabel("managed")).toBe("Managed")
    expect(subject.inferenceSourceLabel(undefined, "Local runtime")).toBe("Local runtime")
  })
})

describe("compact model descriptions", () => {
  test("uses only factual capability, context, and provider metadata", () => {
    expect(subject.modelSummary({ reasoning: true, context: 1_000_000, provider: "Anthropic" })).toBe(
      "Reasoning · 1m context · Anthropic",
    )
    expect(subject.modelSummary({ reasoning: false, context: 128_000, provider: "OpenAI" })).toBe(
      "General · 128k context · OpenAI",
    )
  })
})

describe("progressive model catalog", () => {
  test("preserves group order while limiting the initial DOM work", () => {
    const groups: Array<[string, number[]]> = [
      ["Pinned", [1, 2]],
      ["Frontier", [3, 4, 5]],
      ["Other", [6, 7]],
    ]

    expect(subject.takeCatalogGroups(groups, 4)).toEqual([
      ["Pinned", [1, 2]],
      ["Frontier", [3, 4]],
    ])
    expect(subject.takeCatalogGroups(groups, 0)).toEqual([])
  })

  test("keeps one tab stop, preferring focused then selected then first", () => {
    expect(subject.modelRadioTabKey(["sol", "luna", "terra"], "luna", "terra")).toBe("terra")
    expect(subject.modelRadioTabKey(["sol", "luna", "terra"], "luna", "missing")).toBe("luna")
    expect(subject.modelRadioTabKey(["sol", "luna", "terra"], "missing", "missing")).toBe("sol")
    expect(subject.modelRadioTabKey([], "luna", "terra")).toBeUndefined()
  })
})

describe("model catalog keyboard navigation", () => {
  test("moves through sectioned radios with Arrow, Home, and End without entering nested groups", async () => {
    const scope = document.createElement("div")
    scope.setAttribute("role", "radiogroup")
    const firstSection = document.createElement("section")
    const secondSection = document.createElement("section")
    const nested = document.createElement("div")
    nested.setAttribute("role", "radiogroup")
    const ids = ["sol", "luna", "terra"]
    const radios = ids.map((id) => {
      const button = document.createElement("button")
      button.type = "button"
      button.setAttribute("role", "radio")
      button.dataset.modelChoice = id
      button.tabIndex = id === "sol" ? 0 : -1
      button.addEventListener("focus", () => {
        for (const radio of radios) radio.tabIndex = radio === button ? 0 : -1
      })
      return button
    })
    const nestedRadio = document.createElement("button")
    nestedRadio.setAttribute("role", "radio")
    nested.append(nestedRadio)
    firstSection.append(radios[0]!, radios[1]!)
    secondSection.append(radios[2]!, nested)
    scope.append(firstSection, secondSection)
    document.body.append(scope)
    scope.addEventListener("keydown", subject.focusModelRadio)

    radios[0]!.focus()
    await press(radios[0]!, "ArrowDown")
    expect(document.activeElement).toBe(radios[1])
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, 0, -1])

    await press(radios[1]!, "End")
    expect(document.activeElement).toBe(radios[2])
    expect(document.activeElement).not.toBe(nestedRadio)

    await press(radios[2]!, "Home")
    expect(document.activeElement).toBe(radios[0])

    await press(radios[0]!, "ArrowUp")
    expect(document.activeElement).toBe(radios[2])
  })
})

describe("model option keyboard navigation", () => {
  test.each([
    ["effort", ["standard", "high", "xhigh"]],
    ["speed", ["standard", "fast", "priority"]],
  ] as const)("automatically activates %s radio options without traversing Back", async (kind, ids) => {
    const current = { value: ids[0] as string }
    const host = mount(() =>
      web.createComponent(subject.ModelOptionList, {
        id: `model-${kind}-options-test`,
        kind,
        title: kind === "effort" ? "Effort" : "Speed",
        options: ids.map((id) => ({ id, label: id })),
        current: current.value,
        onSelect: (value) => (current.value = value),
        onBack: () => undefined,
      }),
    )
    const back = host.querySelector<HTMLButtonElement>("[data-model-menu-back]")
    const radios = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="radio"]'))

    expect(back).not.toBeNull()
    expect(radios).toHaveLength(3)
    radios[0]?.focus()

    await press(radios[0]!, "ArrowDown")
    expect(current.value).toBe(ids[1])
    expect(radios[0]?.getAttribute("aria-checked")).toBe("false")
    expect(radios[1]?.getAttribute("aria-checked")).toBe("true")
    expect(document.activeElement).toBe(radios[1])
    expect(document.activeElement).not.toBe(back)

    await press(radios[1]!, "End")
    expect(current.value).toBe(ids[2])
    expect(radios[2]?.getAttribute("aria-checked")).toBe("true")
    expect(document.activeElement).toBe(radios[2])
    expect(document.activeElement).not.toBe(back)

    await press(radios[2]!, "Home")
    expect(current.value).toBe(ids[0])
    expect(radios[0]?.getAttribute("aria-checked")).toBe("true")
    expect(document.activeElement).toBe(radios[0])
    expect(document.activeElement).not.toBe(back)

    await press(radios[0]!, "ArrowUp")
    expect(current.value).toBe(ids[2])
    expect(radios[2]?.getAttribute("aria-checked")).toBe("true")
    expect(document.activeElement).toBe(radios[2])
    expect(document.activeElement).not.toBe(back)
  })

  test("keeps the direct model-effort control visible at Standard", async () => {
    let opened = 0
    const host = mount(() =>
      web.createComponent(subject.ModelEffortTrigger, {
        value: "Standard",
        expanded: false,
        onOpen: () => opened++,
      }),
    )
    const trigger = host.querySelector<HTMLButtonElement>("[data-model-effort-chip]")

    expect(trigger?.textContent).toBe("Standard")
    expect(trigger?.getAttribute("aria-label")).toBe("Thinking effort: Standard")
    expect(trigger?.querySelector('[data-component="icon"]')).not.toBeNull()
    trigger?.click()
    expect(opened).toBe(1)
  })

  test("selects an exact access route from one logical model row", () => {
    const selected = { value: "openai/gpt-5.6-sol" }
    let done = 0
    const host = mount(() =>
      web.createComponent(subject.ModelOptionList, {
        id: "model-route-options-test",
        kind: "route",
        title: "GPT-5.6 Sol access",
        current: selected.value,
        options: [
          { id: "openai/gpt-5.6-sol", label: "OpenAI · API key" },
          { id: "openai-codex/gpt-5.6-sol", label: "OpenAI · ChatGPT" },
        ],
        onSelect: (value) => (selected.value = value),
        onBack: () => undefined,
        onDone: () => done++,
      }),
    )
    const routes = Array.from(host.querySelectorAll<HTMLButtonElement>('[data-model-option="route"]'))

    expect(routes).toHaveLength(2)
    routes[1]?.click()
    expect(selected.value).toBe("openai-codex/gpt-5.6-sol")
    expect(done).toBe(1)
  })
})
