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

  test("exposes a consolidated trigger and one ordered row-based model menu", () => {
    const composer = source("./prompt-input.tsx")
    expect(existsSync(path("./model-settings-popover.tsx"))).toBe(true)
    const settings = source("./model-settings-popover.tsx")
    const styles = source("./model-settings-popover.css")

    expect(composer).toContain("<ModelSettingsPopover")
    expect(composer).not.toContain('data-action="model-variant-cycle"')
    expect(composer).not.toContain('data-action="model-tier-cycle"')
    expect(composer).not.toContain("Thinking ·")
    expect(settings).toContain("aria-label={`Model: ${control().trigger}`}")
    expect(settings).toContain("control().trigger")
    expect(settings).toContain("local.model.variant.list()")
    expect(settings).toContain("local.model.tier.list()")
    expect(settings).toContain('role="radiogroup"')
    expect(settings).toContain('role="radio"')
    expect(settings).toContain("aria-checked=")
    expect(settings).toContain("onKeyDown={onMenuKeyDown}")
    expect(settings).not.toContain("<span data-model-menu-label>Advanced</span>")
    expect(settings).not.toContain("Auto-accept permissions")
    expect(settings).toContain('<DialogSettings initial="models" />')
    expect(settings).not.toContain("<DialogManageModels />")
    expect(settings).toContain("model-settings-trigger--label")
    expect(settings).toContain("data-model-quick")
    expect(settings).toContain("modelSummary")
    expect(settings).not.toContain("Balanced research, coding, and tool use")
    expect(settings).not.toContain("Deep analysis and scientific review")
    expect(settings).not.toContain("Long-context research and synthesis")
    expect(settings).toContain("More models")
    expect(settings).toContain("Quick models")
    expect(settings).toContain("Find a model or provider")
    expect(settings).toContain("Manage models")
    expect(settings).not.toContain("data-model-source-label")
    expect(settings).toContain("data-model-menu-value")
    expect(styles).toContain("width: min(320px, calc(100vw - 24px))")
    expect(styles).toContain("overflow-y: auto")
    expect(styles).toContain("min-height: 58px")
    expect(styles).toContain("font-size: 14px")
    expect(styles).toContain("color: #4f8cff")
    expect(styles).toContain("--model-control-surface: #30302d")
    expect(styles).toContain("font-family: var(")

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
