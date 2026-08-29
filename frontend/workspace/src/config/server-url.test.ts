import { describe, expect, test } from "bun:test"
import {
  hasDesktopUpdateCapability,
  resolveDefaultServerUrl,
  resolveDesktopServerUrl,
  resolveServerRoute,
} from "./server-url"

const base = {
  hostname: "127.0.0.1",
  origin: "http://127.0.0.1:3010",
  hostedDomain: "syntheticsciences.ai",
  dev: false,
}

describe("resolveDefaultServerUrl", () => {
  test("uses a configured API server in production builds", () => {
    expect(resolveDefaultServerUrl({ ...base, configured: "http://127.0.0.1:4100" })).toBe("http://127.0.0.1:4100")
  })

  test("keeps an explicit user default ahead of the build default", () => {
    expect(
      resolveDefaultServerUrl({
        ...base,
        stored: "http://127.0.0.1:4200",
        configured: "http://127.0.0.1:4100",
      }),
    ).toBe("http://127.0.0.1:4200")
  })

  test("falls back to the static origin only when no server is configured", () => {
    expect(resolveDefaultServerUrl(base)).toBe("http://127.0.0.1:3010")
  })
})

describe("resolveDesktopServerUrl", () => {
  test("pins the native app to the random loopback origin", () => {
    expect(resolveDesktopServerUrl("?desktop=1", "http://127.0.0.1:43819")).toBe("http://127.0.0.1:43819")
    expect(resolveDesktopServerUrl("", "http://127.0.0.1:43819")).toBeUndefined()
  })

  test("enables native staging only when the host advertises its trusted updater", () => {
    expect(hasDesktopUpdateCapability("?desktop=1&desktop-update=1")).toBe(true)
    expect(hasDesktopUpdateCapability("?desktop=1")).toBe(false)
    expect(hasDesktopUpdateCapability("?desktop-update=1")).toBe(false)
    expect(hasDesktopUpdateCapability("")).toBe(false)
  })
})

describe("resolveServerRoute", () => {
  test("uses the selected server for a separately hosted production UI", () => {
    expect(resolveServerRoute("/api/atlas/graphs", "http://127.0.0.1:4100", base.origin)).toBe(
      "http://127.0.0.1:4100/api/atlas/graphs",
    )
  })

  test("keeps bundled single-origin routes relative", () => {
    expect(resolveServerRoute("/api/atlas/graphs", base.origin, base.origin)).toBe("/api/atlas/graphs")
  })

  test("preserves query parameters", () => {
    expect(
      resolveServerRoute("/api/atlas/project?directory=%2Ftmp%2Fresearch", "http://127.0.0.1:4100", base.origin),
    ).toBe("http://127.0.0.1:4100/api/atlas/project?directory=%2Ftmp%2Fresearch")
  })

  test("sends update checks to the selected OpenScience server", () => {
    expect(resolveServerRoute("/settings/updates?refresh=1", "http://127.0.0.1:4096", base.origin)).toBe(
      "http://127.0.0.1:4096/settings/updates?refresh=1",
    )
  })
})
