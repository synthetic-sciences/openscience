import { describe, expect, test } from "bun:test"

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text()

const rule = (css: string, selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "s"))?.[1] ?? ""
}

describe("seamless workspace surfaces", () => {
  test("uses common regions instead of decorative boxes inside the workbench", async () => {
    const [chat, terminal, compute, host] = await Promise.all([
      read("../components/chat-surface.css"),
      read("../atlas/TerminalSurface.css"),
      read("../atlas/ComputeSurface.css"),
      read("../atlas/HostStrip.css"),
    ])

    expect(rule(chat, '.session-scroller [data-component="user-message"] [data-slot="user-message-text"]')).toContain(
      "box-shadow: none",
    )
    expect(rule(terminal, '.terminal-surface__tab-shell[data-active="true"]')).not.toContain("border")
    expect(rule(terminal, ".terminal-surface__empty-mark")).not.toContain("border")
    expect(rule(compute, ".compute-surface__atlas")).not.toContain("border:")
    expect(rule(compute, ".compute-surface__atlas-icon")).not.toContain("border:")
    expect(rule(host, ".host-strip")).not.toContain("border:")
    expect(rule(host, ".host-strip")).toContain("border-radius: var(--atlas-radius-sm)")
    expect(rule(host, ".host-strip")).toContain(
      "background: color-mix(in srgb, var(--color-bg-subtle) 72%, transparent)",
    )
  })

  test("keeps controls deliberate, quick, and touch-safe", async () => {
    const [chat, terminal, compute, host] = await Promise.all([
      read("../components/chat-surface.css"),
      read("../atlas/TerminalSurface.css"),
      read("../atlas/ComputeSurface.css"),
      read("../atlas/HostStrip.css"),
    ])
    const css = [chat, terminal, compute, host].join("\n")

    expect(css).not.toContain("transition: all")
    expect(chat).toContain("min-width: 32px")
    expect(css).toContain("@media (pointer: coarse)")
    expect(css).toContain("44px")
    expect(terminal).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.terminal-surface__search\s*\{[^}]*animation:\s*none/,
    )
  })
})
