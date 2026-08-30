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
  test("labels provider routes by the access the user controls", () => {
    expect(subject.inferenceSource({ providerID: "synsci", credential: "custom" })).toBeUndefined()
    expect(subject.inferenceSource({ providerID: "openai-codex", credential: "custom" })).toBe("chatgpt")
    expect(subject.inferenceSource({ providerID: "anthropic", credential: "api" })).toBe("byok")
    expect(subject.inferenceSource({ providerID: "anthropic", credential: "env" })).toBe("byok")
    expect(subject.inferenceSource({ providerID: "xai", credential: "config" })).toBe("byok")
    // Own gateway key in the local auth store is decisive: own key wins server-side.
    expect(subject.inferenceSource({ providerID: "openrouter", credential: "api" })).toBe("byok")
    expect(subject.inferenceSource({ providerID: "openrouter", credential: "managed" })).toBe("managed")
    // An ambient gateway is ambiguous until the explicit access mode resolves it.
    expect(subject.inferenceSource({ providerID: "openrouter", credential: "env" })).toBeUndefined()
    expect(subject.inferenceSource({ providerID: "openrouter", credential: "env", billing: "byok" })).toBe("byok")
    // OAuth subscriptions outside ChatGPT and config-defined custom providers stay unlabeled.
    expect(subject.inferenceSource({ providerID: "github-copilot", credential: "custom" })).toBeUndefined()
  })

  test("labels model access without changing provider routing ids", () => {
    expect(subject.inferenceSourceLabel("chatgpt")).toBe("ChatGPT")
    expect(subject.inferenceSourceLabel("byok")).toBe("BYOK")
    expect(subject.inferenceSourceLabel("managed")).toBe("Ace")
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
    ["route", ["openai", "codex", "openrouter"]],
  ] as const)("automatically activates %s radio options without traversing Back", async (kind, ids) => {
    const current = { value: ids[0] as string }
    const host = mount(() =>
      web.createComponent(subject.ModelOptionList, {
        id: `model-${kind}-options-test`,
        kind,
        title: kind === "effort" ? "Effort" : "Route",
        options: ids.map((id) => ({ id, label: id })),
        current: current.value,
        onSelect: (value) => (current.value = value),
      }),
    )
    const back = host.querySelector<HTMLButtonElement>("[data-model-menu-back]")
    const radios = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="radio"]'))

    expect(back).toBeNull()
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
          { id: "openai/gpt-5.6-sol", label: "OpenAI · BYOK" },
          { id: "openai-codex/gpt-5.6-sol", label: "OpenAI · ChatGPT" },
        ],
        onSelect: (value) => (selected.value = value),
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

describe("reasoning effort and Fast mode", () => {
  test("renders one Fast toggle only when the exact route advertises it", () => {
    const unsupported = mount(() =>
      web.createComponent(subject.ModelEffortPanel, {
        current: "standard",
        options: [
          { id: "standard", label: "Standard" },
          { id: "high", label: "High" },
        ],
        onEffortSelect: () => undefined,
        onTierSelect: () => undefined,
      }),
    )

    expect(unsupported.querySelectorAll('[data-model-option="effort"]')).toHaveLength(2)
    expect(unsupported.querySelector("[data-model-fast-toggle]")).toBeNull()
    expect(unsupported.textContent).not.toContain("Fast mode")

    const supported = mount(() =>
      web.createComponent(subject.ModelEffortPanel, {
        current: "standard",
        options: [
          { id: "standard", label: "Standard" },
          { id: "high", label: "High" },
        ],
        fast: { active: false },
        onEffortSelect: () => undefined,
        onTierSelect: () => undefined,
      }),
    )

    expect(supported.querySelectorAll('[data-component="switch"]')).toHaveLength(1)
    expect(supported.querySelector("[data-model-fast-toggle]")).not.toBeNull()
    expect(supported.textContent).toContain("Fast mode")
    expect(supported.textContent).not.toContain("Response speed")
    expect(supported.textContent).not.toContain("Prefer faster responses")
    expect(supported.querySelector('[aria-label="Fast mode"]')).not.toBeNull()

    const fastOnly = mount(() =>
      web.createComponent(subject.ModelEffortPanel, {
        current: "standard",
        options: [],
        fast: { active: false },
        onEffortSelect: () => undefined,
        onTierSelect: () => undefined,
      }),
    )
    expect(fastOnly.querySelector('[role="radiogroup"]')).toBeNull()
    expect(fastOnly.querySelector('[data-component="switch"]')).not.toBeNull()
  })

  test("changes effort and tier independently without touching the selected route", () => {
    const state = {
      route: "openai-codex/gpt-5.6-sol",
      variant: "standard",
      tier: "standard",
    }
    const host = mount(() =>
      web.createComponent(subject.ModelEffortPanel, {
        current: state.variant,
        options: [
          { id: "standard", label: "Standard" },
          { id: "high", label: "High" },
        ],
        fast: { active: false },
        onEffortSelect: (variant) => (state.variant = variant),
        onTierSelect: (tier) => (state.tier = tier),
      }),
    )

    host.querySelector<HTMLButtonElement>('[data-model-option="effort"][data-model-option-id="high"]')?.click()
    expect(state).toEqual({
      route: "openai-codex/gpt-5.6-sol",
      variant: "high",
      tier: "standard",
    })

    host.querySelector<HTMLInputElement>('[data-slot="switch-input"]')?.click()
    expect(state).toEqual({
      route: "openai-codex/gpt-5.6-sol",
      variant: "high",
      tier: "fast",
    })
  })

  test("renders and selects an exact context cap independently", () => {
    const selected = { value: "1050000" }
    const host = mount(() =>
      web.createComponent(subject.ModelEffortPanel, {
        current: "standard",
        options: [],
        context: {
          current: selected.value,
          options: [
            { id: "272000", label: "272K cap" },
            { id: "1050000", label: "Full · 1.05M" },
          ],
        },
        onEffortSelect: () => undefined,
        onTierSelect: () => undefined,
        onContextSelect: (context) => (selected.value = context),
      }),
    )

    const choices = host.querySelectorAll('[data-model-option="context"]')
    expect(choices).toHaveLength(2)
    host.querySelector<HTMLButtonElement>('[data-model-option="context"][data-model-option-id="272000"]')?.click()
    expect(selected.value).toBe("272000")
  })

  test("uses a real dialog trigger and restores focus to its own effort chip", async () => {
    const host = mount(() =>
      web.createComponent(subject.ModelEffortPopover, {
        value: "Standard",
        current: "standard",
        options: [
          { id: "standard", label: "Standard" },
          { id: "high", label: "High" },
        ],
        fast: { active: false },
        onEffortSelect: () => undefined,
        onTierSelect: () => undefined,
      }),
    )
    const trigger = host.querySelector<HTMLButtonElement>("[data-model-effort-chip]")!

    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog")
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    trigger.focus()
    trigger.click()
    await Promise.resolve()
    await Promise.resolve()

    const content = document.body.querySelector<HTMLElement>('[data-model-popover-kind="effort"]')!
    expect(content).not.toBeNull()
    expect(content.getAttribute("role")).toBe("dialog")
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    expect(trigger.getAttribute("aria-controls")).toBe(content.id)
    expect(document.activeElement).toBe(content.querySelector('[data-model-option="effort"][aria-checked="true"]'))

    await press(content, "Escape")
    await Promise.resolve()
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    expect(document.activeElement).toBe(trigger)
  })

  test("keeps active Fast mode visible and announced after the dialog closes", () => {
    const host = mount(() =>
      web.createComponent(subject.ModelEffortPopover, {
        value: "High",
        current: "high",
        options: [{ id: "high", label: "High" }],
        fast: { active: true },
        onEffortSelect: () => undefined,
        onTierSelect: () => undefined,
      }),
    )
    const trigger = host.querySelector<HTMLButtonElement>("[data-model-effort-chip]")!

    expect(trigger.textContent).toContain("High")
    expect(trigger.textContent).toContain("Fast")
    expect(trigger.getAttribute("aria-label")).toBe("Reasoning effort: High. Fast mode on. Reasoning options")
    expect(trigger.querySelector("[data-model-fast-indicator]")).not.toBeNull()
    expect(trigger.querySelector('[data-icon="bolt"]')).toBeNull()
  })
})
