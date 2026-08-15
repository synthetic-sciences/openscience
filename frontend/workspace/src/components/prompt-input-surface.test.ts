import { describe, expect, test } from "bun:test"

const source = await Bun.file(new URL("./prompt-input.tsx", import.meta.url)).text()
const css = await Bun.file(new URL("../styles/atlas.css", import.meta.url)).text()
const componentCss = await Bun.file(new URL("./prompt-input.css", import.meta.url)).text()
const chatCss = await Bun.file(new URL("./chat-surface.css", import.meta.url)).text()
const popover = await Bun.file(new URL("./model-settings-popover.tsx", import.meta.url)).text()
const modelCatalog = await Bun.file(new URL("../context/model-catalog.ts", import.meta.url)).text()

describe("floating prompt surface", () => {
  test("uses one floating surface without the retired compact outline utilities", () => {
    expect(source).toContain('"workspace-composer": true')
    expect(source).not.toContain("bg-surface-raised-stronger-non-alpha shadow-xs-border relative")
    expect(source).not.toContain('"rounded-[14px] overflow-clip focus-within:shadow-xs-border"')
    expect(css).not.toContain("\n.workspace-composer {")
    expect(css).not.toContain("\n.workspace-composer__footer {")
    expect(chatCss).toContain("width: min(100%, 740px)")
    expect(componentCss).toMatch(/form\.workspace-composer\s*\{[^}]*min-height: 88px/s)
    expect(componentCss).toContain("border-radius: var(--radius-lg)")
    expect(componentCss).toContain("background: var(--color-surface-solid")
    expect(componentCss).toContain("box-shadow: none")
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
    expect(source).toContain(
      "aria-label={`Research tools, ${researchEffortLabel(effort())} effort, ${researchAccessLabel()}`}",
    )
    expect(popover).toContain("aria-label={`Model: ${control().trigger}`}")
    expect(source).not.toContain('aria-label="Research capabilities"')
    expect(source).not.toContain("workspace-composer__overflow")
    expect(source).toContain('class="workspace-composer__research-tools"')
    expect(source).toContain('aria-label="Research tools"')
    expect(source).toContain('role="radiogroup"')
    expect(source).not.toContain("Available automatically")
    expect(source).not.toContain("Research chooses from available search")
    expect(source).not.toContain("workspace-composer__research-capabilities")
    expect(componentCss).toContain("font-family: var(--font-family-sans)")
    expect(componentCss).toContain("font: inherit")
    expect(source).not.toContain('<Icon name="cpu" size="small" />')
    expect(source).not.toContain('<Icon name="settings-gear" size="small" />')
    expect(source).not.toContain('<Icon name="flask"')
  })

  test("keeps compact desktop controls and explicit coarse-pointer targets", () => {
    expect(componentCss).toContain("min-height: 32px")
    expect(componentCss).toContain("width: 32px")
    expect(componentCss).toContain("height: 32px")
    expect(componentCss).toContain("--icon-size: 12px")
    expect(componentCss).toContain("@media (pointer: coarse)")
    expect(componentCss).toContain("min-width: 44px")
    expect(componentCss).toContain("min-height: 44px")
    expect(componentCss).toContain(".workspace-composer__context-remove::after")
    expect(componentCss).toContain("inset: -6px")
  })

  test("keeps high-frequency keyboard navigation immediate", () => {
    expect(source).toContain('scrollIntoView({ block: "nearest", behavior: "auto" })')
    expect(source).not.toContain('scrollIntoView({ block: "nearest", behavior: "smooth" })')
  })

  test("always treats the streaming action as Stop without consuming a queued draft", () => {
    const submit = source.indexOf("const handleSubmit = async")
    const readPrompt = source.indexOf("const currentPrompt = prompt.current()", submit)
    const stop = source.indexOf("if (working())", submit)
    expect(submit).toBeGreaterThan(-1)
    expect(stop).toBeGreaterThan(submit)
    expect(stop).toBeLessThan(readPrompt)
    expect(source.slice(stop, readPrompt)).toContain("abort()")
    expect(source.slice(stop, readPrompt)).toContain("return")
  })

  test("acknowledges Enter before first-session bootstrap and keeps history off the critical path", () => {
    const submit = source.indexOf("const handleSubmit = async")
    const acknowledge = source.indexOf("setSubmitting(true)", submit)
    const clear = source.indexOf("clearInput()", acknowledge)
    const deferredHistory = source.indexOf("window.setTimeout(() => addToHistory(currentPrompt, mode), 0)", clear)
    const createSession = source.indexOf("await client.session", deferredHistory)
    const optimistic = source.indexOf("addOptimisticMessage()", createSession)

    expect(submit).toBeGreaterThan(-1)
    expect(acknowledge).toBeGreaterThan(submit)
    expect(clear).toBeGreaterThan(acknowledge)
    expect(deferredHistory).toBeGreaterThan(clear)
    expect(createSession).toBeGreaterThan(deferredHistory)
    expect(optimistic).toBeGreaterThan(createSession)
    expect(source).toContain("if (submitting()) return")
    expect(source).toContain('contenteditable={submitting() ? "false" : "true"}')
    expect(source).toContain("aria-busy={submitting()}")
  })

  test("restores the acknowledged draft when session bootstrap fails", () => {
    const submit = source.indexOf("const handleSubmit = async")
    const restore = source.indexOf("const restoreBootstrap", submit)
    const missingWorktree = source.indexOf("if (!createdWorktree?.directory)", restore)
    const missingSession = source.indexOf("if (!session)", missingWorktree)

    expect(restore).toBeGreaterThan(submit)
    expect(source.slice(restore, missingWorktree)).toContain("restoreInput()")
    expect(source.slice(missingWorktree, missingSession)).toContain("restoreBootstrap()")
    expect(source.slice(missingSession, source.indexOf("setEffort", missingSession))).toContain("restoreBootstrap()")
  })

  test("uses draft-safe rollback for every post-dispatch failure path", () => {
    const calls = source.match(/restoreInputAfterFailure\(\)/g) ?? []

    // Shell, custom command, pending-worktree cleanup, and normal prompt
    // failures all share the same draft-safe rollback.
    expect(calls).toHaveLength(4)
    expect(source).toContain("canRestoreFailedSubmission(prompt.current(), store.mode)")
  })

  test("uses measured composer geometry for message and jump-to-latest clearance", () => {
    const session = Bun.file(new URL("../pages/session.tsx", import.meta.url)).text()

    return session.then((value) => {
      expect(value).not.toContain("calc(10rem+64px)")
      expect(value).not.toContain("calc(10rem + 64px + 16px)")
      expect(chatCss).toContain("padding-bottom: var(--workspace-composer-height)")
      expect(value).not.toContain('"padding-bottom": "var(--workspace-composer-reserve)"')
      expect(value).toContain('class="session-jump-latest-rail"')
    })
  })
})

describe("composer control consolidation", () => {
  test("creates a session before submitting from the explicit new-session route", () => {
    expect(source).toContain('const isNewSession = !params.id || params.id === "new"')
  })

  test("shows one persistent Normal or Ultra research-effort control inside Research tools", () => {
    expect(source).toContain('Persist.workspace(sdk.scope, "research-effort", ["research-effort.v1"])')
    expect(source).toContain('data-research-effort="normal"')
    expect(source).toContain('data-research-effort="ultra"')
    expect(source).toContain('aria-checked={effort() === "normal"}')
    expect(source).toContain('aria-checked={effort() === "ultra"}')
    expect(source).toContain("onKeyDown={navigateResearchEffort}")
    expect(source).toContain('class="workspace-composer__research-tools-separator"')
    expect(source).toContain("<strong>{researchEffortLabel(effort())}</strong>")
    expect(source).not.toContain('class="workspace-composer__effort"')
    expect(source).not.toContain("onClick={toggleEffort}")
    expect(componentCss).toContain('.workspace-composer__research-effort-options > button[aria-checked="true"]')
    expect(componentCss).not.toContain(".workspace-composer__effort")
  })

  test("offers three real action-approval modes inside Research tools", () => {
    expect(source).toContain("data-research-access={option.value}")
    expect(source).toContain('aria-label="How should OpenScience actions be approved?"')
    expect(source).toContain("sdk.client.project.trust.get({ projectID, directory: sdk.directory })")
    expect(source).toContain("sdk.client.project.trust.update({")
    expect(source).toContain('sdk.request("/settings/sandbox", init)')
    expect(source).toContain('sdk.event.on("project.trust.changed"')
    expect(source).toContain('sdk.event.on("server.instance.disposed"')
    expect(source).toContain("onKeyDown={navigateResearchAccess}")
    expect(componentCss).toContain(".workspace-composer__research-access-options > button")
    expect(componentCss).toContain('button[data-tone="warning"][aria-checked="true"]')
  })

  test("sends the selected research effort through the SDK prompt", () => {
    expect(source).toContain("const researchEffort = effort()")
    expect(source).toContain("effort: researchEffort")
    expect(source).toContain("await client.session.prompt(request)")
  })

  test("restores compact Compute access without restoring specialist or reviewer machinery", () => {
    expect(source).not.toContain("loadCapabilities")
    expect(source).not.toContain("toggleDelegation")
    expect(source).not.toContain("toggleReview")
    expect(source).not.toContain("Reviewer model")
    expect(source).not.toContain("delegation:")
    expect(source).not.toContain("capabilitySpecialist")
    expect(source).not.toContain("Compute providers")
    expect(source).toContain('uiStore.openContext("kernels")')
    expect(source).toContain('<DialogSettings initial="skills" />')
    expect(source).toContain('<DialogSettings initial="connectors" />')
    expect(source).toContain("Python, R, local and remote jobs")
    expect(source).toContain("Compute activity")
    expect(source).toContain("Manage skills")
    expect(source).toContain("Manage connectors")
    expect(source).not.toContain("workspace-composer__research-tools-divider")
    expect(source).not.toContain('"/settings/compute/provider/modal/enabled"')
    expect(source).toContain("<ModelSettingsPopover />")
  })

  test("keeps billing source details out of the model trigger", () => {
    expect(popover).not.toContain("data-model-source-label")
    expect(popover).toContain("inferenceSource({")
    expect(modelCatalog).toContain('if (input.providerID.startsWith("synsci")) return "managed"')
    expect(modelCatalog).toContain('if (input.providerID === "openai-codex") return "chatgpt"')
    expect(modelCatalog).toContain('if (input.credential === "api") return "byok"')
    expect(modelCatalog).toContain('input.billing === "byok" ? "byok" : undefined')
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
