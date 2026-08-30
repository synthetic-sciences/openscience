import { describe, expect, test } from "bun:test"

const source = await Bun.file(new URL("./prompt-input.tsx", import.meta.url)).text()
const css = await Bun.file(new URL("../styles/atlas.css", import.meta.url)).text()
const componentCss = await Bun.file(new URL("./prompt-input.css", import.meta.url)).text()
const chatCss = await Bun.file(new URL("./chat-surface.css", import.meta.url)).text()
const popover = await Bun.file(new URL("./model-settings-popover.tsx", import.meta.url)).text()
const modelCatalog = await Bun.file(new URL("../context/model-catalog.ts", import.meta.url)).text()
const modelFast = await Bun.file(new URL("./model-fast.ts", import.meta.url)).text()

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
    expect(source).toContain('aria-label="Model, effort, and send"')
    expect(source).toContain('aria-label="Tools"')
    expect(popover).toContain("aria-label={`Model: ${control().trigger}`}")
    expect(popover).toContain("data-model-effort-chip")
    expect(source).not.toContain('aria-label="Research capabilities"')
    expect(source).not.toContain("workspace-composer__overflow")
    expect(source).toContain('class="workspace-composer__research-tools"')
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

  test("lets adjacent Research choices float across clipped workspace panes", () => {
    expect(componentCss).toContain(
      ".project-workspace-frame:has(form.workspace-composer .workspace-composer__research-tools[open])",
    )
    expect(componentCss).toContain(
      ":is(.project-workspace-frame__route, .atlas-root, .session-workspace, .session-main)",
    )
    expect(componentCss).toContain("z-index: 50")
    expect(componentCss).toContain("overflow: visible")
  })

  test("keeps slash keyboard navigation inside the picker scrollport", () => {
    expect(source).not.toContain('scrollIntoView({ block: "nearest", behavior: "auto" })')
    expect(source).toContain("const viewport = slashPopoverRef.getBoundingClientRect()")
    expect(source).toContain("slashPopoverRef.scrollTop -= top - row.top")
    expect(source).toContain("slashPopoverRef.scrollTop += row.bottom - bottom")
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
    expect(source.slice(missingSession, source.indexOf("props.onSubmit?.()", missingSession))).toContain(
      "restoreBootstrap()",
    )
  })

  test("makes first-session bootstrap recoverable after an ambiguous create response", () => {
    const submit = source.indexOf("const handleSubmit = async")
    const candidate = source.indexOf('Identifier.descending("session")', submit)
    const create = source.indexOf(".create({ id: candidate })", candidate)
    const recover = source.indexOf(".get({ sessionID: candidate })", create)

    expect(candidate).toBeGreaterThan(submit)
    expect(create).toBeGreaterThan(candidate)
    expect(recover).toBeGreaterThan(create)
    expect(source.slice(submit, candidate)).toContain("store.bootstrapID")
    expect(source.slice(recover, source.indexOf("if (!session)", recover))).toContain("if (recovered) return recovered")
  })

  test("uses draft-safe rollback for every post-dispatch failure path", () => {
    const calls = source.match(/restoreInputAfterFailure\(\)/g) ?? []

    // Native actions, shell, Plan/Goal intent, custom commands,
    // pending-worktree cleanup, and normal prompts all share the same
    // draft-safe rollback.
    expect(calls).toHaveLength(6)
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

  test("keeps effort beside the model and removes duplicate effort and speed rows from Research", () => {
    expect(source).not.toContain('Persist.workspace(sdk.scope, "research-effort"')
    expect(source).not.toContain("data-research-effort={option.id}")
    expect(source).not.toContain("data-research-speed={option.id}")
    expect(popover).toContain("local.model.variant.list()")
    expect(popover).toContain("data-model-effort-chip")
    expect(source).toContain("const resetResearchTools = () =>")
    expect(source).toContain('".workspace-composer__research-choice[open]"')
    expect(source).toContain("if (event.currentTarget.open) return")
    expect(source).not.toContain("researchStatusRequested")
    expect(source).not.toContain('settings<ResearchToolsStatus>("/settings/research-tools")')
    expect(source).not.toContain("Loading plan and search")
    expect(source).not.toContain('class="workspace-composer__research-status"')
    expect(componentCss).not.toContain("workspace-composer__research-status")
    expect(source).not.toContain("Ultra")
    expect(source).not.toContain('class="workspace-composer__research-tools-separator"')
    expect(source).not.toContain("<strong>{researchAccessLabel()}</strong>")
    expect(source).not.toContain('class="workspace-composer__effort"')
    expect(componentCss).not.toContain("workspace-composer__research-effort")
    expect(componentCss).not.toContain("left: calc(100% + 12px)")
    expect(componentCss).toContain(".workspace-composer__research-choice-menu {\n  position: static")
    expect(componentCss).toContain("width: min(336px, calc(100cqw - 20px))")
    expect(componentCss).toContain("grid-template-columns: minmax(0, 1fr)")
  })

  test("keeps exact-route Fast inside model options and out of the composer chrome", () => {
    expect(popover).toContain("exactRouteFastMode(current(), local.model.tier.current())")
    expect(modelFast).toContain('hasOwnProperty.call(route.modes ?? {}, "fast")')
    expect(popover).toContain("<Switch")
    expect(popover).toContain("data-model-fast-toggle")
    expect(popover).toContain("checked={fast().active}")
    expect(popover).not.toContain('name="bolt"')
    expect(popover).toContain('props.onTierSelect(checked ? "fast" : "standard")')
    expect(popover).toContain("control().effort || fast()")
    expect(popover).toContain("props.options.length > 0")
    expect(popover).toContain('[data-model-fast-toggle] [data-slot="switch-input"]')
    expect(popover).not.toContain('kind="speed"')
    expect(popover).not.toContain("Available through")
    expect(popover).toContain("onTierSelect={(id) => local.model.tier.set(id)}")
    expect(source).not.toContain("const fastMode = createMemo")
    expect(source).not.toContain("toggleFastMode")
    expect(source).not.toContain("workspace-composer__fast-mode")
    expect(source).not.toContain("workspace-composer__model-actions")
    expect(componentCss).not.toContain("workspace-composer__fast-mode")
    expect(componentCss).not.toContain("workspace-composer__model-actions")
    const effortStart = popover.lastIndexOf("<ModelEffortPopover")
    const effortSurface = popover.slice(effortStart, popover.indexOf("</Show>", effortStart))
    expect(effortSurface).toContain("local.model.variant.set")
    expect(effortSurface).toContain("local.model.tier.set")
    expect(effortSurface).not.toContain("local.model.set")
  })

  test("offers three real action-approval modes inside Research tools", () => {
    expect(source).toContain("data-research-access={option.value}")
    expect(source).toContain('aria-label="How should OpenScience actions be approved?"')
    expect(source).toContain("const projectAccess = async (projectID: string, init?: RequestInit)")
    expect(source).toContain("/project/${encodeURIComponent(projectID)}/access")
    expect(source).toContain("return projectAccess(projectID)")
    expect(source).toContain('sdk.event.on("project.trust.changed"')
    expect(source).toContain('sdk.event.on("project.access.changed"')
    expect(source).toContain('sdk.event.on("server.instance.disposed"')
    expect(source).toContain('title: "Enable Full access?"')
    expect(source).toContain("Full access disables the execution sandbox")
    expect(source).toContain("if (!confirmed) return")
    expect(source).toContain("title: `${accessLabel(effective)} enabled`")
    expect(source).toContain("onKeyDown={navigateResearchChoices}")
    expect(componentCss).toContain(".workspace-composer__research-choice-menu > button")
    expect(componentCss).toContain('button[data-tone="warning"][aria-checked="true"]')
  })

  test("sends the standard research effort through the SDK prompt", () => {
    expect(source).toContain('const researchEffort = "normal" as const')
    expect(source).toContain("const variant = local.model.variant.prompt()")
    expect(source).toContain("const tier = local.model.tier.prompt()")
    expect(source).toMatch(/variant,\s+tier,/)
    expect(source).toContain("effort: researchEffort")
    expect(source).toContain("delegationSettings: delegationConfig")
    expect(source).toContain("await client.session.prompt(request)")
  })

  test("carries research controls through every slash-command dispatch", () => {
    expect(source).toContain('const delegationEnabled = delegationConfig.level !== "off"')
    expect(source.match(/effort: researchEffort/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
    expect(source.match(/delegationSettings: delegationConfig/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
    expect(source.match(/\.command\(request\)/g)?.length ?? 0).toBe(3)
  })

  test("offers clear delegation controls without duplicating Compute or reviewer settings", () => {
    expect(source).toContain('<summary aria-label="Tools">')
    expect(source).toContain('class="workspace-composer__research-tools-label">Tools</span>')
    expect(source).toContain('settings<CapabilityPreferences>("/settings/preferences")')
    expect(source).toContain("delegatedSpecialist(")
    expect(source).toContain('aria-label="Research roles"')
    expect(source).toContain('class="workspace-composer__research-setting workspace-composer__research-slider"')
    expect(source).toContain('label="Delegation"')
    expect(source).toContain('label="Independence"')
    expect(source).toContain('class="workspace-composer__research-setting workspace-composer__research-choice"')
    expect(source).toContain('class="workspace-composer__research-choice-menu"')
    expect(source).toContain('role="radiogroup"')
    expect(source).not.toContain("summary aria-label={`Worker model")
    expect(source).not.toContain("Route to the best match")
    expect(source).not.toContain("ReviewPreferences")
    expect(source).not.toContain('settings<ReviewPreferences>("/settings/review")')
    expect(source).not.toContain("Reviewer model")
    expect(source).not.toContain("Auto-review")
    expect(source).not.toContain("reviewerChoices()")
    expect(source).not.toContain("reviewerSources()")
    expect(componentCss).not.toContain("workspace-composer__reviewer")
    expect(source).not.toContain("Research workflow")
    expect(source).not.toContain("Saved locally")
    expect(source).not.toContain("Compute activity")
    expect(source).not.toContain("Compute providers")
    expect(source).not.toContain("Manage skills")
    expect(source).toContain("MCP servers")
    expect(source).toContain('dialog.show(() => <DialogSettings initial="connectors" />)')
    expect(source).toContain(
      'class="workspace-composer__research-setting workspace-composer__research-control workspace-composer__research-connectors"',
    )
    expect(source).toContain('class="workspace-composer__research-setting-label">MCP servers</span>')
    expect(source).toContain("configuredConnectorCount()")
    expect(componentCss).toContain("grid-template-columns: minmax(0, 1fr) auto 16px")
    expect(componentCss).toContain("button.workspace-composer__research-control:focus-visible")
    expect(source).not.toContain("workspace-composer__research-tools-divider")
    expect(source).not.toContain('"/settings/compute/provider/modal/enabled"')
    expect(source).toContain("<ModelSettingsPopover />")
  })

  test("keeps billing source details out of the model trigger", () => {
    expect(popover).not.toContain("data-model-source-label")
    expect(popover).not.toContain("inferenceSource({")
    expect(popover).not.toContain("inferenceSourceLabel(")
    expect(modelCatalog).not.toContain('input.providerID.startsWith("synsci")')
    expect(modelCatalog).toContain('input.providerID === "openrouter" && input.credential === "managed"')
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
    expect(source).toContain("Connect a provider in Settings to choose a model.")
  })
})
