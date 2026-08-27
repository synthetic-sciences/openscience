import { expect, test } from "bun:test"

test("lists existing macOS windows before the New Window Dock action", async () => {
  const source = await Bun.file(new URL("../../../../frontend/desktop/src/main.mjs", import.meta.url)).text()
  const dock = source.slice(source.indexOf("function dock()"), source.indexOf("function stop()"))
  expect(dock.indexOf("...entries")).toBeLessThan(dock.indexOf('label: "New Window"'))
})
