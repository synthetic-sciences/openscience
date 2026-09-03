import { describe, expect, test } from "bun:test"

const read = (name: string) => Bun.file(new URL(name, import.meta.url)).text()

describe("mobile compose and model sheets", () => {
  test("keeps the compact research actions visible without restoring legacy capability toggles", async () => {
    const [prompt, css] = await Promise.all([read("./prompt-input.tsx"), read("./prompt-input.css")])

    expect(prompt).not.toContain("data-mobile-compose-sheet")
    expect(prompt).not.toContain("data-mobile-compose-row")
    expect(prompt).toContain("onClick={attach}")
    expect(prompt).not.toContain("selectResearchEffort")
    expect(prompt).not.toContain("Ultra")
    expect(prompt).toContain("<ModelSettingsPopover />")
    expect(prompt).not.toContain('aria-label="Composer mode"')
    expect(prompt).toContain('class="workspace-composer__send')
    expect(prompt).not.toContain('class="workspace-composer__effort"')
    expect(prompt).toContain('class="workspace-composer__research-tools"')
    expect(prompt).not.toContain("Compute activity")
    expect(prompt).not.toContain('class="workspace-composer__overflow"')
    expect(prompt).not.toContain('aria-label="Research capabilities"')
    expect(prompt).toContain("delegatedSpecialist")
    expect(prompt).not.toContain("Reviewer model")
    expect(prompt).not.toContain("Auto-review")
    expect(prompt).not.toContain("/settings/review")
    expect(prompt).not.toContain("<span>Memory</span>")
    expect(prompt).toContain('label="Delegation"')
    expect(prompt).toContain('label="Independence"')
    expect(prompt).not.toContain('class="workspace-composer__compute-menu"')
    expect(prompt).not.toContain('"/settings/compute/provider/modal/enabled"')
    expect(prompt).not.toContain('"/settings/memory?scope=global"')
    expect(prompt).not.toContain("Review now")
    expect(prompt).not.toContain("Research agent")
    expect(prompt).not.toContain("General-purpose by default")
    expect(prompt).not.toContain('<Icon name="dot-grid" />')
    expect(prompt).not.toContain("Clear attachments")
    expect(prompt).not.toContain("Open Terminal")
    expect(prompt).not.toContain("Composer preferences")
    expect(prompt).not.toContain("Prompt history")
    expect(prompt.indexOf('class="workspace-composer__research-tools"')).toBeLessThan(
      prompt.indexOf('class="workspace-composer__actions'),
    )
    expect(prompt.indexOf("<ModelSettingsPopover />")).toBeGreaterThan(
      prompt.indexOf('class="workspace-composer__actions'),
    )
    expect(css).toContain("@media (max-width: 719px)")
    expect(css).toContain("grid-template-columns: minmax(0, 1fr) auto")
    expect(css).toContain("@container conversation (max-width: 540px)")
    expect(css).toMatch(/@container conversation \(max-width: 540px\)[\s\S]*grid-template-columns: minmax\(0, 1fr\);/)
    expect(css).toContain("width: min(336px, calc(100cqw - 20px))")
    expect(css).toContain("overflow: visible")
    expect(css).not.toContain("overflow-x: auto")
    expect(css).toContain(".workspace-composer__research-control")
    expect(css).toContain(".workspace-composer__research-choice")
    expect(css).toContain(".workspace-composer__research-choice-menu")
    expect(css).not.toContain(".workspace-composer__effort")
    expect(css).toContain(".workspace-composer__research-tools")
    expect(css).toContain(".workspace-composer__research-tools-menu")
    expect(css).not.toContain(".workspace-composer__overflow")
    expect(css).not.toContain(".workspace-composer__compute-menu")
    expect(css).not.toContain("mobile-compose-sheet")
  })

  test("uses a modal mobile settings surface without changing the desktop popover", async () => {
    const [settings, css, prompt] = await Promise.all([
      read("./model-settings-popover.tsx"),
      read("./model-settings-popover.css"),
      read("./prompt-input.tsx"),
    ])

    expect(settings).toContain("import { Popover as Kobalte }")
    expect(settings).toContain("modal={mobile()}")
    expect(settings).toContain('placement="top-end"')
    expect(settings).toContain("data-mobile-model-settings-overlay")
    expect(settings).toContain('class="model-settings-popover__close"')
    expect(settings).toContain('props.kind === "model" ? "model selector" : "model options"')
    expect(settings).toContain('target?.scrollIntoView({ block: "nearest" })')
    expect(settings).not.toContain("target?.focus({ preventScroll: true })")
    expect(settings).toContain("local.model.variant.set")
    expect(prompt).not.toContain("local.model.variant.set(option.id)")
    expect(prompt).not.toContain("local.model.tier.set(option.id)")
    expect(settings).toContain("data-model-effort-chip")
    expect(settings).not.toContain("<span>Model effort</span>")
    expect(settings).toContain("groupModelRoutes")
    expect(css).toContain("[data-popper-positioner]:has(> [data-model-settings-popover])")
    expect(css).toContain("width: 100% !important")
    expect(css).toContain("transform: none !important")
    expect(css).toContain("inset: auto 0 0 !important")
    expect(css).toContain("border-radius: var(--radius-lg) var(--radius-lg) 0 0 !important")
    expect(css).toMatch(
      /@media \(pointer: coarse\)[\s\S]*\[data-model-control-group="label"\][\s\S]*height: 44px;[\s\S]*data-model-settings-trigger-style="label"[\s\S]*min-height: 44px;/,
    )
  })
})
