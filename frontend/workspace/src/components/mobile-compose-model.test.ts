import { describe, expect, test } from "bun:test"

const read = (name: string) => Bun.file(new URL(name, import.meta.url)).text()

describe("mobile compose and model sheets", () => {
  test("keeps every required primary action visible and only secondary actions in overflow", async () => {
    const [prompt, css] = await Promise.all([read("./prompt-input.tsx"), read("./prompt-input.css")])

    expect(prompt).not.toContain("data-mobile-compose-sheet")
    expect(prompt).not.toContain("data-mobile-compose-row")
    expect(prompt).toContain("onClick={attach}")
    expect(prompt).toContain("<ModelSettingsPopover />")
    expect(prompt).not.toContain('aria-label="Composer mode"')
    expect(prompt).toContain('class="workspace-composer__send')
    expect(prompt).toContain('class="workspace-composer__overflow"')
    expect(prompt).toContain('aria-label="Research capabilities"')
    expect(prompt).toContain("<span>Capabilities</span>")
    expect(prompt).toContain('aria-haspopup="menu"')
    expect(prompt).toContain("aria-expanded={modeOpen()}")
    expect(prompt).toContain("local.agent.list()")
    expect(prompt).toContain("local.agent.set(agent.name)")
    expect(prompt).toContain('openCapability("review")')
    expect(prompt).toContain('openSettings("memory")')
    expect(prompt).toContain('openSettings("specialists")')
    expect(prompt).toContain('openSettings("skills")')
    expect(prompt).toContain('openCapability("compute")')
    expect(prompt).not.toContain('<Icon name="dot-grid" />')
    expect(prompt).not.toContain("Clear attachments")
    expect(prompt).not.toContain("Open Terminal")
    expect(prompt).not.toContain("Composer preferences")
    expect(prompt).not.toContain("Prompt history")
    expect(prompt.indexOf('class="workspace-composer__overflow"')).toBeLessThan(
      prompt.indexOf('class="workspace-composer__actions'),
    )
    expect(prompt.indexOf("<ModelSettingsPopover />")).toBeGreaterThan(
      prompt.indexOf('class="workspace-composer__actions'),
    )
    expect(css).toContain("@media (max-width: 719px)")
    expect(css).toContain("grid-template-columns: minmax(0, 1fr) auto")
    expect(css).toContain("overflow: visible")
    expect(css).not.toContain("overflow-x: auto")
    expect(css).toContain(".workspace-composer__overflow > div")
    expect(css).not.toContain("mobile-compose-sheet")
  })

  test("uses a modal mobile settings surface without changing the desktop popover", async () => {
    const [settings, css] = await Promise.all([
      read("./model-settings-popover.tsx"),
      read("./model-settings-popover.css"),
    ])

    expect(settings).toContain("import { Popover as Kobalte }")
    expect(settings).toContain("modal={mobile()}")
    expect(settings).toContain('placement="top-end"')
    expect(settings).toContain("data-mobile-model-settings-overlay")
    expect(settings).toContain('aria-label="Close model options"')
    expect(settings).toContain("local.model.variant.set")
    expect(settings).toContain("local.model.tier.set")
    expect(css).toContain("[data-popper-positioner]:has(> [data-model-settings-popover])")
    expect(css).toContain("width: 100% !important")
    expect(css).toContain("transform: none !important")
    expect(css).toContain("inset: auto 0 0 !important")
    expect(css).toContain("border-radius: 16px 16px 0 0 !important")
  })

  test("renders model discovery as a scrollable edge-to-edge mobile dialog", async () => {
    const [picker, css] = await Promise.all([read("./dialog-select-model.tsx"), read("./dialog-select-model.css")])

    expect(picker).toContain('class="model-picker-sheet"')
    expect(picker).toContain('class="model-picker-sheet__list"')
    expect(picker).toContain("onSelect={() => dialog.close()}")
    expect(css).toContain("width: 100%")
    expect(css).toContain("border-radius: 20px 20px 0 0")
    expect(css).toContain("min-height: 63px")
    expect(css).toContain("font-size: 16px")
    expect(css).toContain("font-size: 13px")
    expect(css).toContain("overflow-y")
  })

  test("keeps desktop model discovery compact without changing the mobile sheet", async () => {
    const [picker, css] = await Promise.all([read("./dialog-select-model.tsx"), read("./dialog-select-model.css")])

    expect(picker).toContain('icon="sliders" class="model-picker-sheet__manage"')
    expect(picker).toContain("Choose which providers and models appear")
    expect(picker).not.toContain('class="model-picker-sheet__manage-inline"')
    expect(picker).not.toContain("[&_[data-slot=list-item]]:!py-2")
    expect(picker).not.toContain("[&_[data-slot=list-search]]:!p-2")
    expect(css).toContain("@media (min-width: 720px)")
    expect(css).toContain("width: min(calc(100vw - 32px), 540px)")
    expect(css).toContain("height: min(calc(100dvh - 48px), 486px)")
    expect(css).toContain("min-height: 42px")
    expect(css).toContain("min-height: 34px")
    expect(css).toContain("font-size: 13px")
    expect(css).toContain("font-size: 11px")
    expect(css).toContain(".model-picker-sheet__manage-copy")
    expect(picker).toContain("OpenAI (Codex subscription)")
    expect(picker).toContain('class="model-picker-sheet__pin"')
    expect(picker).toContain('aria-label="Model providers"')
    expect(css).toContain("@media (max-width: 719px)")
    expect(css).toContain("height: min(760px, calc(100dvh - 12px))")
  })
})
