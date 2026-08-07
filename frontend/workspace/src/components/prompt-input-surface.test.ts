import { describe, expect, test } from "bun:test"

const source = await Bun.file(new URL("./prompt-input.tsx", import.meta.url)).text()
const css = await Bun.file(new URL("../styles/atlas.css", import.meta.url)).text()
const popover = await Bun.file(new URL("./model-settings-popover.tsx", import.meta.url)).text()

describe("floating prompt surface", () => {
  test("uses one floating surface without the retired compact outline utilities", () => {
    expect(source).toContain('"workspace-composer": true')
    expect(source).not.toContain("bg-surface-raised-stronger-non-alpha shadow-xs-border relative")
    expect(source).not.toContain('"rounded-[14px] overflow-clip focus-within:shadow-xs-border"')
    expect(css).toContain("border-radius: var(--workspace-composer-radius)")
    expect(css).toContain(".workspace-composer {\n  min-height: 90px;")
    expect(css).toContain("box-shadow: 0 12px 30px")
  })

  test("keeps primary composer controls visible at the compact research scale", () => {
    expect(source).toContain('class="workspace-composer__attach')
    expect(source).toContain('class="workspace-composer__send')
    expect(source).toContain('class="size-5"')
    expect(source).toContain("text-[15px]")
    expect(source).toContain('icon={working() ? "stop" : "arrow-up"}')
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

  test("shows the effort chip only when effort is non-default", () => {
    expect(popover).toContain('if (!effort || effort.current.id === "standard") return undefined')
    expect(popover).toContain("data-model-effort-chip")
    expect(popover).toContain('props.trigger !== "icon" && chip()')
    expect(source).not.toContain("data-model-effort-chip")
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
    expect(source).not.toContain("workspace-composer__mode")
    expect(source).not.toContain('aria-label="Composer mode"')
    expect(source).not.toContain("local.plan")
  })

  test("shows missing model setup inline immediately above the composer", () => {
    expect(source).toContain('class="workspace-composer__setup" role="status"')
    expect(source).toContain("Choose a model to start")
    expect(source).toContain("Connect ChatGPT, add a provider key, or use managed inference.")
  })
})
