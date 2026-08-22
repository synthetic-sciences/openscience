import { describe, expect, test } from "bun:test"
import {
  isCodexOAuthProvider,
  requiresWalletBalance,
  resolveCredentialSource,
  shouldReportUsage,
  type CredentialSource,
} from "../../src/session/billing-gate"
import { Auth } from "../../src/auth"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("billing-gate", () => {
  test("ChatGPT-plan Codex OAuth bypasses managed wallet gates even with stale managed-shaped config", async () => {
    await using tmp = await tmpdir({
      config: {
        billing: { llm: "managed" },
        provider: { "openai-codex": { options: { apiKey: "thk_stale-managed-value" } } },
      },
    })
    const previous = await Auth.get("openai-codex")
    try {
      await Auth.set("openai-codex", {
        type: "oauth",
        refresh: "refresh-chatgpt-plan",
        access: "access-chatgpt-plan",
        expires: Date.now() + 60_000,
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const source = await resolveCredentialSource("openai-codex", "gpt-5.6-sol")
          expect(source).toBe("oauth-free")
          expect(requiresWalletBalance(source)).toBe(false)
          expect(shouldReportUsage(source)).toBe(false)
        },
      })
    } finally {
      if (previous) await Auth.set("openai-codex", previous)
      else await Auth.remove("openai-codex")
    }
  })

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
