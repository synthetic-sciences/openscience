import { expect, test } from "bun:test"
import { networkEndpoint } from "./network-endpoint"

const source = Bun.file(new URL("./Network.tsx", import.meta.url)).text()
const styles = Bun.file(new URL("./preference-panels.css", import.meta.url)).text()

test("global network settings do not select a filesystem project", () => {
  const endpoint = new URL(networkEndpoint("http://127.0.0.1:4096/"))

  expect(endpoint.pathname).toBe("/settings/network")
  expect([...endpoint.searchParams]).toEqual([])
})

test("network settings stay responsive while whole-state writes remain ordered", async () => {
  const component = await source

  expect(component).toContain("queuedState = next")
  expect(component).toContain("while (queuedState)")
  expect(component).toContain("commitNetworkState(pending")
  expect(component).toContain('aria-busy={saving() ? "true" : undefined}')
  expect(component).not.toContain("disabled={saving()}")
})

test("network rows use one disclosure icon instead of repeated decorative icons", async () => {
  const component = await source

  expect(component).toContain('class="settings-network-disclosure"')
  expect(component).toContain("settings-network-domain-row group")
  expect(component).not.toContain('name="shield"')
  expect(component).not.toContain('name="server"')
  expect(component).not.toContain('name="link"')
  expect(component).not.toContain('name="plus"')
})

test("network loading keeps the section structure stable and saving stays non-blocking", async () => {
  const component = await source

  expect(component).toContain('class="settings-panel-loading__rows settings-network-loading-rows"')
  expect(component).toContain('aria-label="Loading service groups"')
  expect(component).toContain('aria-label="Loading allowed domains"')
  expect(component).toContain('class="settings-network-save-state"')
  expect(component).toContain('{saving() ? "Saving…" : ""}')
  expect(component).not.toContain("Loading network settings…")
})

test("network rows stay compact without a nested disclosure surface", async () => {
  const component = await source
  const css = await styles
  const icon = component.indexOf('class="settings-network-disclosure__icon"')
  const copy = component.indexOf('<span class="settings-row-copy">', icon)

  expect(icon).toBeGreaterThan(-1)
  expect(copy).toBeGreaterThan(icon)
  expect(css).toContain(".settings-preferences-panel--network .settings-network-group-row")
  expect(css).toContain("min-height: 56px")
  expect(css).toContain(".settings-preferences-panel--network .settings-network-disclosure")
  expect(css).toContain("align-self: stretch")
  expect(css).toContain("border-radius: 0")
  expect(css).not.toContain("margin-left: calc(var(--settings-space-2) * -1)")
})
