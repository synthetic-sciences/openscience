import { describe, expect, test } from "bun:test"
import {
  DEFAULT_RESEARCH_ACCESS_MODE,
  researchAccessContract,
  researchAccessLabel,
  researchAccessMode,
  researchAccessMutations,
} from "./research-access"

describe("research access modes", () => {
  test("derives the visible mode from effective trust and sandbox state", () => {
    expect(researchAccessMode({ trusted: false, sandboxEnabled: true })).toBe("ask")
    expect(researchAccessMode({ trusted: false, sandboxEnabled: false })).toBe("ask")
    expect(researchAccessMode({ trusted: true, sandboxEnabled: true })).toBe("approve")
    expect(researchAccessMode({ trusted: true, sandboxEnabled: false })).toBe("full")
  })

  test("reports the confirmed mode instead of the stale previous label", () => {
    expect(DEFAULT_RESEARCH_ACCESS_MODE).toBe("approve")
    expect(researchAccessLabel("ask")).toBe("Ask for approval")
    expect(researchAccessLabel("approve")).toBe("Approve for me")
    expect(researchAccessLabel("full")).toBe("Full access")
  })

  test("a fresh trusted and contained project resolves to Approve while explicit sandbox false stays Full", () => {
    expect(DEFAULT_RESEARCH_ACCESS_MODE).toBe("approve")
    expect(researchAccessMode({ trusted: true, sandboxEnabled: true })).toBe("approve")
    expect(researchAccessMode({ trusted: true, sandboxEnabled: false })).toBe("full")
  })

  test("maps each label to the requested sandbox and approval contract", () => {
    expect(researchAccessContract("ask")).toEqual({
      sandbox: "workspace-write",
      approval: "on-request",
      review: "user",
    })
    expect(researchAccessContract("approve")).toEqual({
      sandbox: "workspace-write",
      approval: "on-request",
      review: "auto_review",
    })
    expect(researchAccessContract("full")).toEqual({
      sandbox: "danger-full-access",
      approval: "never",
      review: "none",
    })
  })

  test("orders mutations so a transition never opens an unintended gap", () => {
    expect(researchAccessMutations("ask")).toEqual([
      { kind: "sandbox", enabled: true },
      { kind: "trust", trusted: false },
    ])
    expect(researchAccessMutations("approve")).toEqual([
      { kind: "sandbox", enabled: true },
      { kind: "trust", trusted: true },
    ])
    expect(researchAccessMutations("full")).toEqual([
      { kind: "trust", trusted: true },
      { kind: "sandbox", enabled: false },
    ])
  })
})
