import { describe, expect, test } from "bun:test"
import { canonicalNetworkDomain } from "./network-domain"

describe("custom Network Settings domains", () => {
  test("canonicalizes case, one trailing dot, and internationalized DNS names", () => {
    expect(canonicalNetworkDomain("EXAMPLE.ORG.")).toEqual({ ok: true, domain: "example.org" })
    expect(canonicalNetworkDomain("münchen.example")).toEqual({ ok: true, domain: "xn--mnchen-3ya.example" })
  })

  test("rejects non-host URL material and local or IP destinations", () => {
    for (const value of [
      " https://example.org",
      "https://example.org",
      "example.org/path",
      "example.org:443",
      "user@example.org",
      "*.example.org",
      "127.0.0.1",
      "127.1",
      "::1",
      "localhost",
      "intranet",
      "research.local",
    ]) {
      expect(canonicalNetworkDomain(value).ok).toBe(false)
    }
  })
})
