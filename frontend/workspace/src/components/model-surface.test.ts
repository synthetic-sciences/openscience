import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8")
const path = (name: string) => fileURLToPath(new URL(name, import.meta.url))

describe("model control surface", () => {
  test("keeps routing transport out while showing branded providers", () => {
    const files = [
      "./prompt-input.tsx",
      "./dialog-select-model.tsx",
      "./model-tooltip.tsx",
      "./model-settings-popover.tsx",
    ].map(source)

    for (const file of files) {
      expect(file).not.toContain("modelRoute")
      expect(file).not.toContain("via ")
      expect(file).not.toContain("OpenRouter")
    }
    expect(files[1]).toContain("displayProviderForModel")
  })

  test("groups model names under clear provider headings", () => {
    const picker = source("./dialog-select-model.tsx")
    const tooltip = source("./model-tooltip.tsx")

    expect(picker).toContain("{i.name}")
    expect(picker).toContain("displayProviderForModel(i.provider, i.id).name")
    expect(picker).toContain("groupBy={category}")
    expect(picker).toContain("modelGroupLabel")
    expect(tooltip).toContain("props.model.name")
  })

  test("exposes one compact model trigger with independently selectable thinking effort", () => {
    const composer = source("./prompt-input.tsx")
    expect(existsSync(path("./model-settings-popover.tsx"))).toBe(true)
    const settings = source("./model-settings-popover.tsx")
    const styles = source("./model-settings-popover.css")

    expect(composer).toContain("<ModelSettingsPopover />")
    expect(composer).not.toContain('data-action="model-variant-cycle"')
    expect(composer).not.toContain('data-action="model-tier-cycle"')
    expect(composer).not.toContain("Thinking ·")
    expect(settings).toContain("aria-label={`Model: ${control().trigger}`}")
    expect(settings).toContain("control().trigger")
    expect(settings).toContain("local.model.variant.list()")
    expect(settings).toContain('data-model-menu-row="effort"')
    expect(settings).toContain("data-model-effort-chip")
    expect(settings).toContain("data-model-control-group")
    expect(settings).toContain("aria-label={`Thinking effort: ${props.value}`}")
    expect(settings).not.toContain("<span>Model effort</span>")
    expect(settings).toContain("control().effort")
    expect(settings).not.toContain('effort.current.id === "standard"')
    expect(settings).toContain("groupModelRoutes")
    expect(settings).toContain('kind="route"')
    expect(settings).toContain("routeAccess")
    expect(settings).toContain("local.model.tier.list()")
    expect(settings).toContain('role="radiogroup"')
    expect(settings).toContain('role="radio"')
    expect(settings).toContain("aria-checked=")
    expect(settings).toContain("tabindex={quickTab() === choice.key ? 0 : -1}")
    expect(settings).toContain("tabindex={catalogTab() === choice.key ? 0 : -1}")
    expect(settings.match(/onKeyDown=\{focusModelRadio\}/g)).toHaveLength(2)
    expect(settings).toContain("onKeyDown={onMenuKeyDown}")
    expect(settings).toContain('window.addEventListener("keydown", dismiss, true)')
    expect(settings).toContain('window.removeEventListener("keydown", dismiss, true)')
    expect(settings).not.toContain("<span data-model-menu-label>Advanced</span>")
    expect(settings).not.toContain("Auto-accept permissions")
    expect(settings).toContain('<DialogSettings initial="models" />')
    expect(settings).not.toContain("<DialogManageModels />")
    expect(settings).toContain("model-settings-trigger--label")
    expect(settings).toContain('<Icon name="chevron-down"')
    expect(settings).not.toContain("⌄")
    expect(settings).toContain("data-model-quick")
    expect(settings).toContain("modelSummary")
    expect(settings).not.toContain("Balanced research, coding, and tool use")
    expect(settings).not.toContain("Deep analysis and scientific review")
    expect(settings).not.toContain("Long-context research and synthesis")
    expect(settings).toContain("More models")
    expect(settings).toContain("Suggested models")
    expect(settings).toContain("curateQuickModels")
    expect(settings).toContain("<ProviderIcon")
    expect(settings).not.toContain("RECOMMENDED_MODELS")
    expect(settings).toContain("Find a model or provider")
    expect(settings).toContain("Manage models")
    expect(settings).not.toContain("data-model-source-label")
    expect(settings).toContain("data-model-menu-value")
    expect(styles).toContain("width: min(320px, calc(100vw - 24px))")
    expect(styles).toContain("overflow-y: auto")
    expect(styles).toContain("min-height: 58px")
    expect(styles).toContain("font-size: 14px")
    expect(styles).toContain("color: var(--text-interactive-base)")
    expect(styles).not.toContain("--model-control-surface: #30302d")
    expect(styles).toContain("font-family: var(")
    expect(styles).toContain("font-optical-sizing: auto")
    expect(styles).toContain("font-synthesis: none")
    expect(styles).toContain("-webkit-font-smoothing: antialiased")
    expect(styles).toContain("font-weight: var(--font-weight-regular)")
    expect(styles).not.toMatch(/font-weight:\s*(?:400|450|500|550|600|700)/)
    expect(styles).not.toContain("text-transform:")

    const triggerRule = styles.match(/\[data-model-settings-trigger-style="label"\]\s*\{([^}]*)\}/s)?.[1] ?? ""
    const effortRule = styles.match(/\[data-model-effort-chip\]\s*\{([^}]*)\}/s)?.[1] ?? ""
    expect(triggerRule).toContain("border: 0")
    expect(triggerRule).toContain("gap: 3px")
    expect(triggerRule).toContain("padding: 0 7px")
    expect(triggerRule).toContain("font-size: 12px")
    expect(triggerRule).toContain("line-height: 1")
    expect(effortRule).toContain("border: 0")
    expect(effortRule).toContain("padding: 0 6px 0 8px")
    expect(effortRule).toContain("font-family: var(--font-family-sans)")
    expect(effortRule).toContain("font-size: 12px")
    expect(effortRule).toContain("line-height: 1")

    const rowRule = styles.match(/\[data-model-settings-popover\] \.model-settings-row\s*\{([^}]*)\}/s)?.[1] ?? ""
    expect(rowRule).toContain("gap: 8px")
    expect(rowRule).toContain("padding: 0 7px")
    expect(rowRule).toContain("font-size: 12px")
    expect(rowRule).toContain("line-height: 16px")
    expect(styles).toContain("min-height: 40px")
    expect(styles).toContain("font-size: 11px")
    expect(styles).toContain("line-height: 15px")

    const model = settings.indexOf('data-model-menu-row="model"')
    const quick = settings.indexOf("data-model-quick")
    const effort = settings.indexOf('data-model-menu-row="effort"')
    const speed = settings.indexOf('data-model-menu-row="speed"')

    expect(model).toBeGreaterThan(-1)
    expect(quick).toBeGreaterThan(-1)
    expect(effort).toBeGreaterThan(model)
    expect(speed).toBeGreaterThan(effort)
  })
})
