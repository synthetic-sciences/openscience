import { describe, expect, test } from "bun:test"
import {
  DEFAULT_RESEARCH_ACCESS_MODE,
  researchAccessContract,
  researchAccessLabel,
  researchAccessMode,
} from "./research-access"

describe("research access modes", () => {
  test("uses the backend's atomic project-scoped mode", () => {
    expect(researchAccessMode({ mode: "ask" })).toBe("ask")
    expect(researchAccessMode({ mode: "approve" })).toBe("approve")
    expect(researchAccessMode({ mode: "full" })).toBe("full")
  })

  test("reports the confirmed mode instead of the stale previous label", () => {
    expect(DEFAULT_RESEARCH_ACCESS_MODE).toBe("approve")
    expect(researchAccessLabel("ask")).toBe("Ask for approval")
    expect(researchAccessLabel("approve")).toBe("Approve for me")
    expect(researchAccessLabel("full")).toBe("Full access")
  })

  test("a fresh project defaults to Approve", () => {
    expect(DEFAULT_RESEARCH_ACCESS_MODE).toBe("approve")
    expect(researchAccessMode({ mode: DEFAULT_RESEARCH_ACCESS_MODE })).toBe("approve")
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
})
