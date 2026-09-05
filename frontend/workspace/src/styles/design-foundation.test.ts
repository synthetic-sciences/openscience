import { describe, expect, test } from "bun:test"

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text()

describe("workspace design foundation", () => {
  test("keeps workspace geometry and elevation tokens out of the shared namespace", async () => {
    const [css, filePreview, fdaBanner] = await Promise.all([
      read("./atlas.css"),
      read("../atlas/FilePreview.css"),
      read("../atlas/FdaBanner.css"),
    ])
    const sharedDefinitions = css.match(/^\s*--(?:radius(?:-(?:xs|sm|md|lg|xl))?|shadow-(?:xs|sm|md|lg|float))\s*:/gm)

    expect(sharedDefinitions).toBeNull()
    expect(css).toContain("--atlas-radius-md: 12px")
    expect(css).toContain("--atlas-shadow-xs:")
    expect(css).toContain("--atlas-shadow-float:")
    expect(css).toContain("light-dark(hsl(220 8% 14%")
    expect(css).not.toContain("var(--radius)")
    expect(css).not.toContain("var(--shadow-float)")
    expect(filePreview).not.toContain("var(--radius)")
    expect(filePreview).toContain("var(--atlas-radius-md)")
    expect(filePreview).toContain("var(--atlas-shadow-xs)")
    expect(fdaBanner).toContain("var(--atlas-radius-lg)")
  })

  test("applies font integrity globally and pretty wrapping only to editorial prose", async () => {
    const css = await read("../index.css")

    expect(css).toContain("font-synthesis: none")
    expect(css).toContain("font-variant-ligatures: common-ligatures contextual")
    expect(css).toContain("text-underline-offset: 0.18em")
    expect(css).toMatch(/\.prose-editorial\s*\{[^}]*text-wrap:\s*pretty/s)
    expect(css.match(/text-wrap:\s*pretty/g)).toHaveLength(1)
  })

  test("keeps core desktop and coarse-pointer controls readable", async () => {
    const [atlas, terminal, compute, settings, button, iconButton, select, textField, switchCss, checkbox] =
      await Promise.all([
        read("./atlas.css"),
        read("../atlas/TerminalSurface.css"),
        read("../atlas/ComputeSurface.css"),
        read("../components/dialog-settings.tsx"),
        read("../../../ui/src/components/button.css"),
        read("../../../ui/src/components/icon-button.css"),
        read("../../../ui/src/components/select.css"),
        read("../../../ui/src/components/text-field.css"),
        read("../../../ui/src/components/switch.css"),
        read("../../../ui/src/components/checkbox.css"),
      ])

    expect(compute).not.toContain(".kernel-card__stop")
    expect(compute).toMatch(/\.compute-row\s*\{[^}]*min-height:\s*48px[^}]*display:\s*grid/s)
    expect(compute).toMatch(/\.compute-row__telemetry\s*\{[^}]*display:\s*flex[^}]*color:\s*var\(--color-text-muted\)/s)
    expect(terminal).toMatch(
      /\.terminal-surface__search button\s*\{[^}]*height:\s*32px[^}]*font-size:\s*(?:12px|var\(--font-size-small\))/s,
    )
    expect(terminal).toMatch(/\.terminal-surface__tab,\s*\.terminal-surface__close\s*\{[^}]*height:\s*32px/s)
    expect(atlas).not.toContain(".terminal-surface")
    expect(settings).toMatch(/--settings-type-helper:\s*12px/)
    expect(settings).toMatch(
      /\.settings-dialog :where\(\.text-11-medium, \.text-10-medium\)\s*\{[^}]*font-size:\s*var\(--settings-type-helper\)/s,
    )
    expect(button).toMatch(/\[data-size="small"\]\s*\{[^}]*height:\s*32px/s)
    expect(iconButton).toMatch(/\[data-size="normal"\]\s*\{[^}]*width:\s*32px[^}]*height:\s*32px/s)
    expect(select).toMatch(/\[data-slot="select-select-item"\]\s*\{[^}]*min-height:\s*32px/s)
    expect(textField).toMatch(/@media \(pointer: coarse\)[\s\S]*min-height:\s*44px/)
    expect(switchCss).toMatch(/\[data-component="switch"\]\s*\{[^}]*min-height:\s*32px/s)
    expect(checkbox).toMatch(/\[data-component="checkbox"\]\s*\{[^}]*min-height:\s*32px/s)

    for (const css of [atlas, terminal, settings, button, iconButton, select, textField, switchCss, checkbox]) {
      expect(css).toContain("@media (pointer: coarse)")
      expect(css).toContain("44px")
    }
  })

  test("keeps common research concepts visually distinct", async () => {
    const [adapter, iconRegistry, css] = await Promise.all([
      read("../atlas/shared/Icon.tsx"),
      read("../../../ui/src/components/iconoir-registry.ts"),
      read("../../../ui/src/components/icon.css"),
    ])

    for (const name of ["activity", "atom", "book-open", "clock", "flask", "sparkles", "star", "star-filled"]) {
      expect(iconRegistry).toContain(`${name.includes("-") ? `\"${name}\"` : name}:`)
    }
    expect(adapter).toContain('IconFlask = icon("flask")')
    expect(adapter).toContain('IconSparkles = icon("sparkles")')
    expect(adapter).toContain('IconAtom = icon("atom")')
    expect(adapter).toContain('IconStar = icon("star")')
    expect(adapter).toContain('IconStarFilled = icon("star-filled")')
    expect(adapter).toContain('IconClock = icon("clock")')
    expect(adapter).toContain('IconActivity = icon("activity")')
    expect(adapter).toContain('IconBookOpen = icon("book-open")')
    expect(css).toContain("color: currentColor")
    expect(css).not.toContain("color: var(--icon-base)")
  })

  test("keeps shared icons precise, polished, and decorative", async () => {
    const [adapter, icon, iconRegistry, iconButton, css, registry, agentIcon, statusDot] = await Promise.all([
      read("../atlas/shared/Icon.tsx"),
      read("../../../ui/src/components/icon.tsx"),
      read("../../../ui/src/components/iconoir-registry.ts"),
      read("../../../ui/src/components/icon-button.tsx"),
      read("../../../ui/src/components/icon.css"),
      read("../components/settings/registry.ts"),
      read("../atlas/shared/AgentIcon.tsx"),
      read("../atlas/shared/StatusDot.tsx"),
    ])

    for (const name of [
      "alert-circle",
      "braces",
      "chevron-left",
      "cpu",
      "file",
      "folder-tree",
      "home",
      "layout-grid",
      "microphone",
      "more-horizontal",
      "paperclip",
      "refresh",
      "shield-alert",
    ]) {
      expect(iconRegistry).toContain(`${name.includes("-") ? `"${name}"` : name}:`)
    }

    for (const [component, name] of [
      ["IconAlertCircle", "alert-circle"],
      ["IconBraces", "braces"],
      ["IconChevronLeft", "chevron-left"],
      ["IconCpu", "cpu"],
      ["IconFile", "file"],
      ["IconFolderTree", "folder-tree"],
      ["IconHome", "home"],
      ["IconLayoutGrid", "layout-grid"],
      ["IconMoreH", "more-horizontal"],
      ["IconPaperclip", "paperclip"],
      ["IconRefresh", "refresh"],
    ]) {
      expect(adapter).toContain(`${component} = icon("${name}")`)
    }

    expect(icon).toMatch(/\{\.\.\.others\}\s*aria-hidden="true"/)
    expect(iconButton).toContain('["icon", "variant", "size", "iconSize", "class", "classList"]')
    expect(iconButton).toContain('"aria-label": string')
    expect(css).toContain("stroke-linecap: round")
    expect(css).toContain("stroke-linejoin: round")
    expect(css).toContain("--icon-stroke-width: 1.5")
    expect(css).toContain("stroke-width: var(--icon-stroke-width)")
    expect(css).toMatch(/\[data-size="large"\]\s*\{[^}]*--icon-size:\s*24px/s)

    expect(registry).not.toMatch(/id: "specialists"/)
    expect(registry).toMatch(/id: "skills",[\s\S]*?icon: "flask"/)
    expect(registry).toMatch(/id: "network",[\s\S]*?icon: "server"/)
    expect(registry).toMatch(/id: "permissions",[\s\S]*?icon: "shield"/)
    expect(agentIcon).toContain("<IconResearch")
    expect(agentIcon).not.toContain("<svg")
    expect(statusDot).toContain("data-status={props.status}")
    expect(statusDot).not.toMatch(/[●◐×○]/)
  })
})
