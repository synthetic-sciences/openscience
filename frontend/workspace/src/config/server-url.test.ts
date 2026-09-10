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

  test("a page served by a loopback server ignores a stale loopback default from another port", () => {
    // A desktop sidecar or an earlier dev server picked a new port since the
    // default was stored; the server that just served this page is the one to use.
    expect(resolveDefaultServerUrl({ ...base, stored: "http://127.0.0.1:57536" })).toBe("http://127.0.0.1:3010")
    expect(resolveDefaultServerUrl({ ...base, stored: "http://localhost:4096" })).toBe("http://127.0.0.1:3010")
    // The same server under another spelling is not stale.
    expect(resolveDefaultServerUrl({ ...base, stored: "http://127.0.0.1:3010/" })).toBe("http://127.0.0.1:3010/")
    // A remote default is a deliberate choice and still wins.
    expect(resolveDefaultServerUrl({ ...base, stored: "https://lab.example.org" })).toBe("https://lab.example.org")
    // The Vite dev origin serves no API, so its stored default stays authoritative.
    expect(
      resolveDefaultServerUrl({ ...base, dev: true, origin: "http://localhost:5173", stored: "http://localhost:4096" }),
    ).toBe("http://localhost:4096")
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
