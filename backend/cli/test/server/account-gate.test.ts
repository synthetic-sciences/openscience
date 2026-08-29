import { describe, expect, test } from "bun:test"
import { requiresAccountForRequest } from "../../src/server/account-gate"

describe("local API account gate", () => {
  test("leaves sign-in, health, docs, preflight, and static SPA recovery reachable", () => {
    expect(requiresAccountForRequest({ method: "GET", path: "/account/session" })).toBe(false)
    expect(requiresAccountForRequest({ method: "POST", path: "/account/login-key" })).toBe(false)
    expect(requiresAccountForRequest({ method: "GET", path: "/global/health" })).toBe(false)
    expect(requiresAccountForRequest({ method: "GET", path: "/doc" })).toBe(false)
    expect(requiresAccountForRequest({ method: "POST", path: "/settings/updates/dispose" })).toBe(false)
    expect(requiresAccountForRequest({ method: "GET", path: "/settings/updates" })).toBe(false)
    expect(requiresAccountForRequest({ method: "GET", path: "/settings/updates/state" })).toBe(false)
    expect(requiresAccountForRequest({ method: "POST", path: "/settings/updates/stage" })).toBe(false)
    expect(requiresAccountForRequest({ method: "POST", path: "/settings/updates/apply" })).toBe(false)
    expect(requiresAccountForRequest({ method: "DELETE", path: "/settings/updates/stage" })).toBe(false)
    expect(requiresAccountForRequest({ method: "OPTIONS", path: "/session" })).toBe(false)
    expect(requiresAccountForRequest({ method: "GET", path: "/projects/example", accept: "text/html" })).toBe(false)
    expect(requiresAccountForRequest({ method: "GET", path: "/assets/app.js" })).toBe(false)
  })

  test("protects reads, mutations, execution streams, and websockets", () => {
    expect(requiresAccountForRequest({ method: "GET", path: "/provider", accept: "application/json" })).toBe(true)
    expect(requiresAccountForRequest({ method: "GET", path: "/session/deep-link", accept: "text/html" })).toBe(true)
    expect(requiresAccountForRequest({ method: "GET", path: "/file", accept: "text/html" })).toBe(true)
    expect(requiresAccountForRequest({ method: "POST", path: "/session" })).toBe(true)
    expect(requiresAccountForRequest({ method: "GET", path: "/runtime/events" })).toBe(true)
    expect(requiresAccountForRequest({ method: "GET", path: "/pty/1/connect", upgrade: "websocket" })).toBe(true)
    expect(requiresAccountForRequest({ method: "PUT", path: "/settings/credentials" })).toBe(true)
    expect(requiresAccountForRequest({ method: "POST", path: "/settings/updates" })).toBe(true)
  })
})
