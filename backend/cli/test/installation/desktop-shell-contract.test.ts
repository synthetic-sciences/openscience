import { expect, test } from "bun:test"

test("lists existing macOS windows before the New Window Dock action", async () => {
  const source = await Bun.file(new URL("../../../../frontend/desktop/src/main.mjs", import.meta.url)).text()
  const dock = source.slice(source.indexOf("function dock()"), source.indexOf("function stop()"))
  expect(dock.indexOf("...entries")).toBeLessThan(dock.indexOf('label: "New Window"'))
})

test("wires the packaged macOS shell to the authenticated desktop updater", async () => {
  const source = await Bun.file(new URL("../../../../frontend/desktop/src/main.mjs", import.meta.url)).text()
  const config = await Bun.file(new URL("../../../../frontend/desktop/electron-builder.mjs", import.meta.url)).text()
  const install = await Bun.file(new URL("../../src/installation/index.ts", import.meta.url)).text()

  expect(config).toContain('target: ["dmg", "zip"]')
  expect(source).toContain("OPENSCIENCE_DESKTOP_UPDATE_URL")
  expect(source).toContain("OPENSCIENCE_DESKTOP_UPDATE_TOKEN")
  expect(source).toContain("stageUpdate(input.version")
  expect(source).toContain("await applyUpdate(update)")
  expect(install).toContain('return "desktop" as const')
  expect(install).toContain("Authorization: `Bearer ${token}`")
})
