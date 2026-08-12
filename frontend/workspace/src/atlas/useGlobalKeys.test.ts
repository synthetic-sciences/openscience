import { expect, test } from "bun:test"

const source = await Bun.file(new URL("./useGlobalKeys.ts", import.meta.url)).text()

test("Cmd-K opens project search even while the composer is focused", () => {
  const shortcut = source.indexOf('if (mod && key === "k")')
  const typing = source.indexOf("if (isTypingTarget(event.target)) return", shortcut)

  expect(shortcut).toBeGreaterThan(0)
  expect(typing).toBeGreaterThan(shortcut)
  expect(source.slice(shortcut, typing)).toContain("uiStore.setPaletteOpen(true)")
})

test("global launch shortcuts stay inert behind an open palette or help modal", () => {
  const modalGuard = source.indexOf("uiStore.paletteOpen() || uiStore.helpOpen()")
  const shortcut = source.indexOf('if (mod && key === "k")')

  expect(modalGuard).toBeGreaterThan(0)
  expect(shortcut).toBeGreaterThan(modalGuard)
})
