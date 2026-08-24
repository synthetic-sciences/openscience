import { describe, expect, test } from "bun:test"

const source = await Bun.file(new URL("./prompt-input.tsx", import.meta.url)).text()
const composerCss = await Bun.file(new URL("./prompt-input.css", import.meta.url)).text()
const chatCss = await Bun.file(new URL("./chat-surface.css", import.meta.url)).text()
const shellCss = await Bun.file(new URL("../styles/atlas.css", import.meta.url)).text()
const session = await Bun.file(new URL("../pages/session.tsx", import.meta.url)).text()
const themeCss = await Bun.file(new URL("../../../ui/src/styles/theme.css", import.meta.url)).text()

describe("conversation surface", () => {
  test("aligns the transcript content edge with the 740px composer", () => {
    expect(source).not.toContain('import "./chat-surface.css"')
    expect(session).toContain('import "../components/chat-surface.css"')
    expect(chatCss).toContain("width: min(100%, 740px)")
    expect(chatCss).toContain("width: min(100%, 772px)")
    expect(chatCss).toContain('[data-slot="session-turn-message-container"]')
    expect(chatCss).toContain("padding-inline: 16px")
    expect(chatCss).toContain("padding-inline: 12px")
  })

  test("keeps user messages quiet, readable, and separate from their copy action", () => {
    expect(chatCss).toContain("--user-message-surface:")
    expect(chatCss).toContain("max-width: min(72%, 620px)")
    expect(chatCss).toContain("--user-message-radius: var(--radius-sm)")
    expect(chatCss).not.toContain("--user-message-tail-radius")
    expect(chatCss).toContain("font-size: var(--font-size-base)")
    expect(chatCss).toContain("font-weight: var(--font-weight-regular)")
    expect(chatCss).toContain("line-height: var(--line-height-large)")
    expect(chatCss).toContain("font-synthesis: none")
    expect(chatCss).toContain("box-shadow: none")
    expect(chatCss).toContain("min-width: 32px")
    expect(chatCss).toContain('[data-slot="user-message-copy-wrapper"] [data-component="icon-button"]')
    expect(chatCss).toContain('[data-slot="session-turn-response-copy-wrapper"] [data-component="icon-button"]')
    expect(chatCss).toContain("min-width: 44px")
    expect(chatCss).not.toContain("position: absolute")
    expect(shellCss).not.toContain('.session-scroller [data-component="user-message"] [data-slot="user-message-text"]')
    expect(shellCss).not.toContain("\n.session-transcript {")
  })

  test("uses regular transcript type and sentence-case generated-state labels", () => {
    expect(chatCss).toContain('[data-slot="session-turn-markdown"]')
    expect(chatCss).toContain("line-height: var(--line-height-large)")
    expect(chatCss).toContain(":is(p, li, blockquote)")
    expect(chatCss).toContain('data-diffs="true"')
    expect(chatCss).toContain("text-wrap: pretty")
    expect(chatCss).toContain("text-wrap: balance")
    expect(chatCss).toContain('[data-slot="session-turn-generated"] > header')
    expect(chatCss).toContain("text-transform: none")
    expect(chatCss).toContain("letter-spacing: normal")
  })

  test("keeps a consistent prose, operation, and metadata type hierarchy", () => {
    expect(themeCss).toContain("--font-size-base: 14px")
    expect(chatCss).toContain("--chat-prose-font-size: var(--font-size-base)")
    expect(chatCss).toContain("--chat-prose-line-height: var(--line-height-large)")
    expect(chatCss).toContain("--chat-operation-font-size: 13px")
    expect(chatCss).toContain("--chat-operation-line-height: 20px")
    expect(chatCss).toContain("--chat-meta-font-size: var(--font-size-small)")
    expect(chatCss).toContain("--chat-meta-line-height: var(--line-height-large)")

    expect(chatCss).toMatch(
      /\[data-component="reasoning-part"\][\s\S]*?font-size: var\(--chat-prose-font-size\);[\s\S]*?line-height: var\(--chat-prose-line-height\);/,
    )
    expect(chatCss).toMatch(
      /\[data-slot="basic-tool-tool-title"\][\s\S]*?font-size: var\(--chat-operation-font-size\);[\s\S]*?line-height: var\(--chat-operation-line-height\);/,
    )
    expect(chatCss).toMatch(
      /\[data-slot="basic-tool-tool-subtitle"\][\s\S]*?font-size: var\(--chat-meta-font-size\);[\s\S]*?line-height: var\(--chat-meta-line-height\);/,
    )
    expect(chatCss).toMatch(
      /\[data-component="todos"\] \[data-slot="checkbox-checkbox-label"\][\s\S]*?font-size: var\(--chat-operation-font-size\);[\s\S]*?line-height: var\(--chat-operation-line-height\);/,
    )
    expect(chatCss).toMatch(
      /\[data-slot="message-part-tool-error-title"\][\s\S]*?font-size: var\(--chat-operation-font-size\);[\s\S]*?line-height: var\(--chat-operation-line-height\);/,
    )
    expect(chatCss).toMatch(
      /\[data-slot="message-part-tool-error-content"\][\s\S]*?\[data-slot="message-part-tool-error-message"\][\s\S]*?font-size: var\(--chat-meta-font-size\);[\s\S]*?line-height: var\(--chat-meta-line-height\);/,
    )
  })

  test("keeps model-authored data tables compact and scrollable inside resized panes", () => {
    expect(chatCss).toContain("container-name: conversation")
    expect(chatCss).toContain("container-type: inline-size")
    expect(chatCss).toContain("@container conversation (max-width: 640px)")
    expect(chatCss).toContain('[data-slot="session-turn-markdown"] table')
    expect(chatCss).toContain("overflow-x: auto")
    expect(chatCss).toContain("font-size: 12.5px")
    expect(chatCss).toContain("font-variant-numeric: tabular-nums")
    expect(chatCss).toContain('font-feature-settings: "tnum" 1')
    expect(chatCss).toContain("min-width: max-content")
    expect(chatCss).toContain("td:not(:last-child)")
    expect(chatCss).toContain("white-space: nowrap")
    expect(chatCss).toContain("min-width: min(240px, 58cqi)")
    expect(chatCss).toContain("max-width: 32ch")
  })

  test("measures the variable-height composer and reserves a separate reading gap", () => {
    expect(session).toContain("promptDockObserver = new ResizeObserver(measurePromptDock)")
    expect(session).toContain('style.setProperty("--workspace-composer-height"')
    expect(session).toContain("ref={(element) => (promptDockElement = element)}")
    expect(chatCss).toContain("--workspace-composer-clearance: var(--space-5)")
    expect(chatCss).toContain("--workspace-composer-reserve: calc(")
    expect(chatCss).toContain("env(safe-area-inset-bottom)")
  })

  test("keeps jump-to-latest in a reserved conversation rail instead of over transcript content", () => {
    expect(session).toContain('class="session-jump-latest-rail"')
    expect(session).toContain('class="session-jump-latest"')
    expect(session).not.toContain('position: "absolute"')
    expect(session).not.toContain('transform: "translateX(-50%)"')
    expect(session).toContain('class="session-conversation-scroll-frame"')
    expect(chatCss).toContain(".session-jump-latest-rail")
    expect(chatCss).toContain(".session-conversation-scroll-frame")
    expect(chatCss).toContain("padding-bottom: var(--workspace-composer-height)")
    expect(chatCss).not.toContain(".session-jump-latest-rail {\n  position: absolute")
    expect(chatCss).toContain("min-height: max(32px, var(--workspace-composer-clearance))")
    expect(chatCss).toContain(".session-jump-latest:focus-visible")
    expect(chatCss).toMatch(/@media \(pointer: coarse\)[\s\S]*?\.session-jump-latest-rail \{[\s\S]*?min-height: 44px/)
    expect(chatCss).toContain("pointer-events: none")
    expect(chatCss).toContain("pointer-events: auto")
  })

  test("uses fast hover feedback, accessible targets, and reduced-motion fallbacks", () => {
    expect(chatCss).toContain("150ms ease")
    expect(chatCss).toContain("animation-duration: 180ms")
    expect(chatCss).toContain("@media (pointer: coarse)")
    expect(chatCss).toContain(':where(button, [role="button"])')
    expect(chatCss).toContain('[data-component="icon-button"]')
    expect(chatCss).toContain("min-width: 44px")
    expect(chatCss).toContain("min-height: 44px")
    expect(chatCss).toContain("@media (prefers-reduced-motion: reduce)")
    expect(session).toContain('class="session-jump-latest"')
  })
})

describe("composer and state behavior", () => {
  test("uses one restrained composer surface and one text baseline", () => {
    expect(composerCss).toMatch(/form\.workspace-composer\s*\{[^}]*min-height: 88px/s)
    expect(composerCss).toContain("border-radius: var(--radius-lg)")
    expect(composerCss).toContain("--composer-editor-font-size: var(--font-size-base)")
    expect(composerCss).toContain("--composer-editor-font-weight: var(--font-weight-regular)")
    expect(composerCss).toContain("--composer-editor-line-height: 20px")
    expect(composerCss).toContain("max-height: 240px")
    expect(composerCss).toContain("box-shadow: none")
    expect(composerCss).toContain("@container conversation (max-width: 540px)")
    expect(composerCss).toContain(".workspace-composer__research-tools > summary")
  })

  test("preserves attachments, model selection, send, and stop controls", () => {
    expect(source).toContain('class="workspace-composer__attachments"')
    expect(source).toContain("<ModelSettingsPopover />")
    expect(source).toContain('icon={working() ? "stop" : "arrow-up"}')
    expect(source).toContain('data-composer-action={working() ? "stop" : prompt.dirty() ? "send" : "idle"}')
    expect(source).toContain('aria-label="Model, effort, and send"')
    expect(source).toContain('data-attachment-status="attached"')
    expect(source).toContain("attachmentFormat")
    expect(source).toContain("multiple")
  })

  test("sentence-cases the revert action at a consistent weight", () => {
    expect(session).toContain('"font-weight": "var(--font-weight-regular)"')
    expect(session).toContain("Restore\n")
    expect(session).not.toContain("\n                        restore\n")
  })
})
