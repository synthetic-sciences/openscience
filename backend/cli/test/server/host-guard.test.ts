import { describe, expect, test } from "bun:test"
import { isAllowedHost, isAllowedOrigin, isCrossOrigin } from "../../src/server/host-guard"

describe("isAllowedHost", () => {
  test("allows localhost with a port", () => {
    expect(isAllowedHost("localhost:4096")).toBe(true)
  })

  test("allows 127.0.0.1 with a port", () => {
    expect(isAllowedHost("127.0.0.1:4096")).toBe(true)
  })

  test("allows bare loopback host without a port", () => {
    expect(isAllowedHost("localhost")).toBe(true)
  })

  test("allows IPv6 loopback in brackets with a port", () => {
    expect(isAllowedHost("[::1]:4096")).toBe(true)
  })

  test("rejects the synthetic internal host (in-process calls use the nonce, not Host)", () => {
    expect(isAllowedHost("openscience.internal")).toBe(false)
  })

  test("rejects an arbitrary external host (DNS rebinding)", () => {
    expect(isAllowedHost("evil.com:4096")).toBe(false)
  })

  test("rejects a LAN IP", () => {
    expect(isAllowedHost("192.168.1.20:4096")).toBe(false)
  })

  test("rejects a missing Host header", () => {
    expect(isAllowedHost(undefined)).toBe(false)
  })

  test("rejects an empty Host header", () => {
    expect(isAllowedHost("")).toBe(false)
  })
})

describe("isAllowedOrigin", () => {
  test("allows the local UI origin (localhost with a port)", () => {
    expect(isAllowedOrigin("http://localhost:4096")).toBe(true)
  })

  test("allows a cross-port localhost origin (dev UI)", () => {
    expect(isAllowedOrigin("http://localhost:3000")).toBe(true)
  })

  test("allows 127.0.0.1 origins", () => {
    expect(isAllowedOrigin("http://127.0.0.1:4096")).toBe(true)
  })

  test("allows the tauri desktop origins", () => {
    expect(isAllowedOrigin("tauri://localhost")).toBe(true)
    expect(isAllowedOrigin("http://tauri.localhost")).toBe(true)
  })

  test("allows the hosted web UI on a syntheticsciences.ai subdomain", () => {
    expect(isAllowedOrigin("https://web.syntheticsciences.ai")).toBe(true)
    expect(isAllowedOrigin("https://app.syntheticsciences.ai")).toBe(true)
  })

  test("rejects the bare syntheticsciences.ai apex (subdomain required)", () => {
    expect(isAllowedOrigin("https://syntheticsciences.ai")).toBe(false)
  })

  test("rejects an arbitrary cross-origin page", () => {
    expect(isAllowedOrigin("https://evil.com")).toBe(false)
  })

  test("rejects a lookalike domain", () => {
    expect(isAllowedOrigin("https://syntheticsciences.ai.evil.com")).toBe(false)
    expect(isAllowedOrigin("https://evilsyntheticsciences.ai")).toBe(false)
  })

  test("rejects http (insecure) syntheticsciences.ai", () => {
    expect(isAllowedOrigin("http://web.syntheticsciences.ai")).toBe(false)
  })

  test("honors an explicit extra whitelist entry", () => {
    expect(isAllowedOrigin("https://my.tunnel.example", ["https://my.tunnel.example"])).toBe(true)
    expect(isAllowedOrigin("https://my.tunnel.example")).toBe(false)
  })
})

describe("isCrossOrigin", () => {
  test("rejects a request with a foreign Origin", () => {
    expect(isCrossOrigin("https://evil.com", undefined)).toBe(true)
  })

  test("rejects a foreign Origin even on a WebSocket-style upgrade", () => {
    expect(isCrossOrigin("https://evil.com", "cross-site")).toBe(true)
  })

  test("allows an allowed Origin (local UI)", () => {
    expect(isCrossOrigin("http://localhost:4096", undefined)).toBe(false)
  })

  test("allows a cross-port localhost Origin", () => {
    expect(isCrossOrigin("http://localhost:3000", "same-site")).toBe(false)
  })

  test("rejects a cross-site request that omits Origin (no-cors GET)", () => {
    expect(isCrossOrigin(undefined, "cross-site")).toBe(true)
  })

  test("allows a same-site navigation that omits Origin", () => {
    expect(isCrossOrigin(undefined, "same-site")).toBe(false)
  })

  test("allows same-origin and user-initiated (none) requests", () => {
    expect(isCrossOrigin(undefined, "same-origin")).toBe(false)
    expect(isCrossOrigin(undefined, "none")).toBe(false)
  })

  test("allows non-browser clients (neither Origin nor Sec-Fetch-Site)", () => {
    expect(isCrossOrigin(undefined, undefined)).toBe(false)
  })
})
