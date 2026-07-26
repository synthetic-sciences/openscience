import { describe, expect, test } from "bun:test"
import { resolveDefaultServerUrl, resolveServerRoute } from "./server-url"

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
})
