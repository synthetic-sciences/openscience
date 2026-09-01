import { expect, test } from "bun:test"

test("lists existing macOS windows before the New Window Dock action", async () => {
  const source = await Bun.file(new URL("../../../../frontend/desktop/src/main.mjs", import.meta.url)).text()
  const dock = source.slice(source.indexOf("function dock()"), source.indexOf("function stop()"))
  expect(dock.indexOf("...entries")).toBeLessThan(dock.indexOf('label: "New Window"'))
})

test("declares UTF-8 for every inline desktop document", async () => {
  const source = await Bun.file(new URL("../../../../frontend/desktop/src/main.mjs", import.meta.url)).text()

  expect(source).not.toContain("data:text/html,")
  expect(source.match(/data:text\/html;charset=utf-8,/g)).toHaveLength(3)
})

test("desktop sidecar inherits the terminal's OpenScience root selectors unchanged", async () => {
  const source = await Bun.file(new URL("../../../../frontend/desktop/src/main.mjs", import.meta.url)).text()
  const begin = source.indexOf("async function start()")
  const end = source.indexOf("function stop()")

  expect(begin).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(begin)
  const start = source.slice(begin, end)

  expect(start).toContain("...process.env")
  expect(start).toContain("cwd: workspace")
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "OPENSCIENCE_DATA_DIR", "OPENSCIENCE_CONFIG_DIR"]) {
    expect(start).not.toContain(`${key}:`)
  }
})

test("wires the packaged macOS shell to the authenticated desktop updater", async () => {
  const source = await Bun.file(new URL("../../../../frontend/desktop/src/main.mjs", import.meta.url)).text()
  const updater = await Bun.file(new URL("../../../../frontend/desktop/src/updater.mjs", import.meta.url)).text()
  const helper = await Bun.file(new URL("../../../../frontend/desktop/src/update-helper.mjs", import.meta.url)).text()
  const workspace = await Bun.file(new URL("../../../../frontend/workspace/src/app.tsx", import.meta.url)).text()
  const config = await Bun.file(new URL("../../../../frontend/desktop/electron-builder.mjs", import.meta.url)).text()
  const install = await Bun.file(new URL("../../src/installation/index.ts", import.meta.url)).text()

  expect(config).toContain('target: ["dmg", "zip"]')
  expect(source).toContain("OPENSCIENCE_DESKTOP_UPDATE_URL")
  expect(source).toContain("OPENSCIENCE_DESKTOP_UPDATE_TOKEN")
  expect(source).toContain("stageUpdate(version")
  expect(source).toContain('input.action === "stage"')
  expect(source).toContain('input.action !== "apply"')
  expect(source).toContain("await applyUpdate(update")
  expect(source).toContain("await acknowledgeUpdateHealth()")
  expect(source).toContain("await acknowledgeUpdateFailure(error, safeBeforeRuntime)")
  expect(source).toContain("new URL(value).origin === new URL(state.address).origin")
  expect(source).not.toContain("url.startsWith(state.address)")
  expect(source.indexOf("await acknowledgeUpdatePending()")).toBeLessThan(source.indexOf("await updates()"))
  expect(source.indexOf("await createWindow()")).toBeLessThan(source.indexOf("await acknowledgeUpdateHealth()"))
  expect(workspace.indexOf("<DesktopReadySignal />")).toBeLessThan(workspace.indexOf("<DesktopOnboarding>"))
  expect(source).toContain("if (updateFailure)")
  expect(source).toContain("await state.updateTask?.catch")
  expect(source).toContain("await discardUpdate(recovered)")
  expect(updater).toContain("source=Notarized Developer ID")
  expect(helper).toContain("source=Notarized Developer ID")
  expect(updater).not.toContain('"/usr/bin/xcrun"')
  expect(helper).not.toContain('"/usr/bin/xcrun"')
  expect(helper).toContain("await stopUnhealthy(payload, health.process_identity)")
  expect(helper).toContain("health.safe_to_terminate === true")
  expect(helper).toContain('process.env.NODE_ENV === "test" && process.env.OPENSCIENCE_UPDATE_SKIP_LAUNCH')
  expect(helper).toContain("await atomicSwap(payload, swapper, oldIdentity, newIdentity)")
  expect(install).toContain('return "desktop" as const')
  expect(install).toContain("Authorization: `Bearer ${token}`")
  expect(install).toContain("stageDesktopUpdate(target)")
  expect(install).toContain('{ action: "apply", version: target }')
})

test("publishes terminal update health only after supervised startup reconciliation", async () => {
  const source = await Bun.file(new URL("../../../../frontend/desktop/src/main.mjs", import.meta.url)).text()
  const acknowledge = source.slice(
    source.indexOf("async function acknowledgeUpdateHealth()"),
    source.indexOf("async function acknowledgeUpdatePending()"),
  )
  const startup = source.slice(source.indexOf("      await start()"), source.indexOf("      splash.destroy()"))

  expect(acknowledge.indexOf("await proveServiceHealth()")).toBeLessThan(
    acknowledge.indexOf("await reconcileCurrentUpdate(true)"),
  )
  expect(acknowledge.indexOf("await reconcileCurrentUpdate(true)")).toBeLessThan(
    acknowledge.indexOf("await writeUpdateHealth("),
  )
  expect(startup).toContain("await acknowledgeUpdateHealth()")
  expect(startup).not.toContain("await reconcileCurrentUpdate(true)")
})
