import { describe, expect, test } from "bun:test"

const source = await Bun.file(new URL("./prompt-input.tsx", import.meta.url)).text()
const css = await Bun.file(new URL("../styles/atlas.css", import.meta.url)).text()
const componentCss = await Bun.file(new URL("./prompt-input.css", import.meta.url)).text()
const chatCss = await Bun.file(new URL("./chat-surface.css", import.meta.url)).text()
const popover = await Bun.file(new URL("./model-settings-popover.tsx", import.meta.url)).text()

describe("floating prompt surface", () => {
  test("uses one floating surface without the retired compact outline utilities", () => {
    expect(source).toContain('"workspace-composer": true')
    expect(source).not.toContain("bg-surface-raised-stronger-non-alpha shadow-xs-border relative")
    expect(source).not.toContain('"rounded-[14px] overflow-clip focus-within:shadow-xs-border"')
    expect(css).not.toContain("\n.workspace-composer {")
    expect(css).not.toContain("\n.workspace-composer__footer {")
    expect(chatCss).toContain("width: min(100%, 740px)")
    expect(componentCss).toMatch(/form\.workspace-composer\s*\{[^}]*min-height: 92px/s)
    expect(componentCss).toContain("border-radius: var(--radius-xl)")
    expect(componentCss).toContain("background: var(--color-surface-solid")
    expect(componentCss).toContain("box-shadow: var(--atlas-shadow-xs)")
  })

  test("keeps primary composer controls visible at the compact research scale", () => {
    expect(source).toContain('class="workspace-composer__attach')
    expect(source).toContain('class="workspace-composer__send')
    expect(source).toContain('name="paperclip" class="size-4"')
    expect(source).toContain('icon={working() ? "stop" : "arrow-up"}')
    expect(source).toContain('data-composer-action={working() ? "stop" : prompt.dirty() ? "send" : "idle"}')
    expect(componentCss).toContain('.workspace-composer__send[data-composer-action="stop"]')
  })

  test("keeps placeholder, caret, and entered text on one responsive type geometry", () => {
    expect(source).toContain("data-composer-mode={store.mode}")
    expect(source).not.toContain('"font-mono!": store.mode === "shell"')
    expect(source).not.toContain("text-[15px] leading-[1.45]")
    expect(componentCss).toContain(
      'form.workspace-composer :is([data-component="prompt-input"], .workspace-composer__placeholder)',
    )
    expect(componentCss).toContain("--composer-editor-font-size: var(--font-size-base)")
    expect(componentCss).toContain("--composer-editor-line-height: 20px")
    expect(componentCss).toContain("--composer-editor-font-weight: var(--font-weight-regular)")
    expect(componentCss).toContain("padding: var(--composer-editor-padding-block-start)")
    expect(componentCss).toContain("font-optical-sizing: auto")
    expect(componentCss).toContain("font-synthesis: none")
    expect(componentCss).toContain('.workspace-composer__editor[data-composer-mode="shell"]')
    expect(componentCss).toContain("--composer-editor-font-family: var(--font-family-mono)")
    expect(componentCss).toContain("position: absolute")
    expect(componentCss).toContain("inset: 0 0 auto")
    expect(source).toContain("aria-label={placeholder()}")
    expect(source).toContain('aria-hidden="true" dir="auto"')
    expect(componentCss).toContain("--composer-editor-font-size: 16px")
    expect(componentCss).toContain("--composer-editor-line-height: 24px")
    expect(componentCss).not.toMatch(/font-weight:\s*(?:400|450|500|550|600|700)/)
  })

  test("uses the shared icon system and accessible control groups instead of text glyphs", () => {
    expect(source).toContain('role="group"')
    expect(source).toContain('aria-label="Composer tools"')
    expect(source).toContain('aria-label="Model and send"')
    expect(source).toContain("aria-label={`Research effort: ${researchEffortLabel(effort())}")
    expect(popover).toContain("aria-label={`Model: ${control().trigger}`}")
    expect(source).not.toContain('aria-label="Research capabilities"')
    expect(source).not.toContain("workspace-composer__overflow")
    expect(source).not.toContain("Research tools")
    expect(source).not.toContain('<Icon name="flask"')
  })

  test("keeps compact desktop controls and explicit coarse-pointer targets", () => {
    expect(componentCss).toContain("min-height: 32px")
    expect(componentCss).toContain("width: 34px")
    expect(componentCss).toContain("height: 34px")
    expect(componentCss).toContain("@media (pointer: coarse)")
    expect(componentCss).toContain("min-width: 44px")
    expect(componentCss).toContain("min-height: 44px")
  })

  test("uses one geometry token for message and jump-to-latest clearance", () => {
    const session = Bun.file(new URL("../pages/session.tsx", import.meta.url)).text()

    return session.then((value) => {
      expect(value).not.toContain("calc(10rem+64px)")
      expect(value).not.toContain("calc(10rem + 64px + 16px)")
      expect(value).toContain("var(--workspace-composer-reserve)")
    })
  })
})

describe("composer control consolidation", () => {
  test("creates a session before submitting from the explicit new-session route", () => {
    expect(source).toContain('const isNewSession = !params.id || params.id === "new"')
  })

  test("shows one persistent Normal or Ultra research-effort control", () => {
    expect(source).toContain('Persist.workspace(sdk.scope, "research-effort", ["research-effort.v1"])')
    expect(source).toContain("data-research-effort={effort()}")
    expect(source).toContain('aria-pressed={effort() === "ultra"}')
    expect(source).toContain("<span>Research effort:</span>")
    expect(source).toContain("<strong>{researchEffortLabel(effort())}</strong>")
    expect(source).not.toMatch(/workspace-composer__effort[\s\S]{0,500}<Icon/)
    expect(componentCss).toContain('data-research-effort="ultra"')
    expect(componentCss).toContain("var(--surface-interactive-weak)")
  })

  test("sends the selected research effort through the SDK prompt", () => {
    expect(source).toContain("const researchEffort = effort()")
    expect(source).toContain("effort: researchEffort")
    expect(source).toContain("await client.session.prompt(request)")
  })

  test("keeps specialist, reviewer, delegation, domain, and compute controls out of the composer", () => {
    expect(source).not.toContain("loadCapabilities")
    expect(source).not.toContain("toggleDelegation")
    expect(source).not.toContain("toggleReview")
    expect(source).not.toContain("Reviewer model")
    expect(source).not.toContain("delegation:")
    expect(source).not.toContain("capabilitySpecialist")
    expect(source).not.toContain("Compute providers")
    expect(source).toContain("<ModelSettingsPopover />")
  })

  test("keeps billing source details out of the model trigger", () => {
    expect(popover).not.toContain("data-model-source-label")
    expect(popover).toContain('if (input.providerID.startsWith("synsci")) return "managed"')
    expect(popover).toContain('if (input.providerID === "openai-codex") return "chatgpt"')
    expect(popover).toContain('if (input.credential === "api") return "byok"')
    expect(popover).toContain('input.billing === "byok" ? "byok" : undefined')
  })

  test("keeps permission policy out of model selection", () => {
    expect(popover).not.toContain('data-model-menu-row="autoaccept"')
    expect(popover).not.toContain("permission.toggleAutoAccept")
    expect(source).not.toContain('command.keybind("permissions.autoaccept")')
    expect(source).not.toContain("permission.toggleAutoAccept")
  })

  test("does not expose manual plan or act modes in the composer", () => {
    expect(source).not.toContain('workspace-composer__mode"')
    expect(source).not.toContain('aria-label="Composer mode"')
    expect(source).not.toContain("local.plan")
  })

  test("shows missing model setup inline immediately above the composer", () => {
    expect(source).toContain('class="workspace-composer__setup" role="status"')
    expect(source).toContain("Choose a model to start")
    expect(source).toContain("Connect ChatGPT, add a provider key, or use managed inference.")
  })
})
