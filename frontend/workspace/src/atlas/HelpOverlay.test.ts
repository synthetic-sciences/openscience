import { expect, test } from "bun:test"

const source = await Bun.file(new URL("./HelpOverlay.tsx", import.meta.url)).text()

test("uses the shared modal foundation with focus containment and restoration", () => {
  expect(source).toContain('import { Dialog as Kobalte } from "@kobalte/core/dialog"')
  expect(source).toContain("<Kobalte.Overlay")
  expect(source).toContain("<Kobalte.Content")
  expect(source).toContain("<Kobalte.Title")
  expect(source).toContain("<Kobalte.CloseButton")
  expect(source).toContain("onOpenAutoFocus")
  expect(source).toContain("onCloseAutoFocus")
  expect(source).toContain("closeRef?.focus()")
  expect(source).toContain("if (restoreFocus?.isConnected) restoreFocus.focus()")
  expect(source).toContain("command.keybinds(false)")
  expect(source).toContain("command.keybinds(true)")
  expect(source).not.toContain('window.addEventListener("keydown"')
  expect(source).not.toContain('from "solid-js/web"')
})

test("exposes a named dialog and a useful close target", () => {
  expect(source).toContain("Keyboard shortcuts")
  expect(source).toContain('aria-label="Close keyboard shortcuts"')
  expect(source).toContain('width: "40px"')
  expect(source).toContain('height: "40px"')
})

test("uses sentence case and reserves monospace for shortcut syntax", () => {
  expect(source).toContain('label: "Open the command palette"')
  expect(source).toContain('label: "Create a project or session"')
  expect(source).toContain('label: "Insert a new line"')
  expect(source).toContain('"font-family": FONT_SANS')
  expect(source).toContain('"font-family": FONT_MONO')
})
