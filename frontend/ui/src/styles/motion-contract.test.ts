import { describe, expect, test } from "bun:test"

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text()

describe("shared motion contract", () => {
  test("uses tokenized, property-specific pressed feedback", async () => {
    const [button, iconButton, toast] = await Promise.all([
      read("../components/button.css"),
      read("../components/icon-button.css"),
      read("../components/toast.css"),
    ])

    for (const css of [button, iconButton, toast]) expect(css).not.toContain("transition: all")
    expect(button).toContain("transform: scale(0.98)")
    expect(iconButton).toContain("transform: scale(0.98)")
    expect(button).toContain("transform var(--duration-fast) var(--ease-standard)")
    expect(toast).toContain("transition: transform var(--duration-slow) var(--ease-out-expo)")
  })

  test("mounts menus immediately and gives dismissals a short ease-in exit", async () => {
    const [dropdown, select, popover, hoverCard, toast] = await Promise.all([
      read("../components/dropdown-menu.css"),
      read("../components/select.css"),
      read("../components/popover.css"),
      read("../components/hover-card.css"),
      read("../components/toast.css"),
    ])

    expect(dropdown).not.toContain("dropdown-menu-open")
    expect(select).not.toContain("select-open")
    expect(select).not.toContain("background-color 0.2s ease-in-out")
    expect(dropdown).toContain("dropdown-menu-close var(--duration-fast) ease-in forwards")
    expect(select).toContain("select-close var(--duration-fast) ease-in forwards")
    expect(popover).toContain("popover-close var(--duration-fast) ease-in forwards")
    expect(hoverCard).toContain("hover-card-close var(--duration-fast) ease-in forwards")
    expect(toast).toContain("toastPopOut var(--duration-fast) ease-in forwards")
  })

  test("targets the portal roots when motion is reduced", async () => {
    const animations = await read("./animations.css")

    expect(animations).toContain('[data-component="dialog-overlay"]')
    expect(animations).toContain('[data-component="select-content"]')
    expect(animations).toContain('[data-component="popover-content"]')
    expect(animations).toContain('[data-component="dropdown-menu-sub-content"]')
    expect(animations).not.toContain('[data-component="select"] [data-slot="select-content"]')
    expect(animations).not.toContain('[data-component="popover"],')
    expect(animations).not.toContain("&:nth-child")
  })

  test("removes icon-button press motion when reduced motion is requested", async () => {
    const iconButton = await read("../components/icon-button.css")

    expect(iconButton).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\[data-component="icon-button"\][\s\S]*transition:\s*none[\s\S]*transform:\s*none/,
    )
  })

  test("keeps native text selection restrained and legible", async () => {
    const utilities = await read("./utilities.css")

    expect(utilities).toContain("::selection")
    expect(utilities).toContain("color-mix(in srgb, var(--color-primary) 24%, transparent)")
    expect(utilities).toContain("color: inherit")
  })
})
