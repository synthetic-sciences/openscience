import { describe, expect, test } from "bun:test"

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text()

const rule = (css: string, selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "s"))?.[1] ?? ""
}

describe("seamless workspace surfaces", () => {
  test("uses common regions instead of decorative boxes inside the workbench", async () => {
    const [chat, terminal, compute, host, trace] = await Promise.all([
      read("../components/chat-surface.css"),
      read("../atlas/TerminalSurface.css"),
      read("../atlas/ComputeSurface.css"),
      read("../atlas/HostStrip.css"),
      read("../atlas/SessionTraceSurface.css"),
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
    expect(rule(trace, ".session-trace__intro")).not.toContain("border-bottom")

    for (const selector of [".session-trace__metrics", ".session-trace__counts", ".session-trace__route"]) {
      expect(rule(trace, selector)).toContain("background: var(--color-bg-subtle)")
      expect(rule(trace, selector)).not.toContain("border-bottom")
    }
  })

  test("keeps controls deliberate, quick, and touch-safe", async () => {
    const [chat, terminal, compute, host, trace] = await Promise.all([
      read("../components/chat-surface.css"),
      read("../atlas/TerminalSurface.css"),
      read("../atlas/ComputeSurface.css"),
      read("../atlas/HostStrip.css"),
      read("../atlas/SessionTraceSurface.css"),
    ])
    const css = [chat, terminal, compute, host, trace].join("\n")

    expect(css).not.toContain("transition: all")
    expect(chat).toContain("min-width: 32px")
    expect(trace).toMatch(/\.session-trace__refresh\s*\{[^}]*width:\s*32px[^}]*height:\s*32px/s)
    expect(css).toContain("@media (pointer: coarse)")
    expect(css).toContain("44px")
    expect(terminal).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.terminal-surface__search\s*\{[^}]*animation:\s*none/,
    )
    expect(trace).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.session-trace__refresh:active\s*\{[^}]*transform:\s*none/,
    )
  })
})
