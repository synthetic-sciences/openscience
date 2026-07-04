import { describe, expect, test } from "bun:test"
import {
  isCodexOAuthProvider,
  requiresWalletBalance,
  shouldReportUsage,
  type CredentialSource,
} from "../../src/session/billing-gate"

describe("billing-gate", () => {
  describe("isCodexOAuthProvider", () => {
    test("true for the synthesized openai-codex provider", () => {
      expect(isCodexOAuthProvider("openai-codex")).toBe(true)
    })
    test("false for the plain openai provider", () => {
      expect(isCodexOAuthProvider("openai")).toBe(false)
    })
    test("false for managed providers", () => {
      expect(isCodexOAuthProvider("anthropic")).toBe(false)
    })
  })

  describe("requiresWalletBalance (pre-flight gate)", () => {
    test("only managed credentials require a positive wallet balance", () => {
      expect(requiresWalletBalance("managed")).toBe(true)
    })
    test("BYOK and OAuth-free never touch the wallet", () => {
      const exempt: CredentialSource[] = ["byok", "oauth-free"]
      for (const source of exempt) expect(requiresWalletBalance(source)).toBe(false)
    })
  })

  describe("shouldReportUsage", () => {
    test("only managed credentials are reported for billing", () => {
      expect(shouldReportUsage("managed")).toBe(true)
    })
    test("BYOK and OAuth-free are billed to the user's own account, never reported", () => {
      const exempt: CredentialSource[] = ["byok", "oauth-free"]
      for (const source of exempt) expect(shouldReportUsage(source)).toBe(false)
    })
  })
})
