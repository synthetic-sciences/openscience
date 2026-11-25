import { describe, expect, test } from "bun:test"
import { importFlagUrl, projectCreateBody, takeImportFlag } from "./project-import"

describe("project import glue", () => {
  test("the create body never carries importConversations (the route is strict)", () => {
    const body = projectCreateBody({
      name: "Atlas",
      sources: [{ path: "/w", access: "write" }],
      importConversations: true,
    })
    expect(body).toEqual({ name: "Atlas", sources: [{ path: "/w", access: "write" }] })
    expect("importConversations" in body).toBe(false)
  })

  test("the project URL carries the one-shot import flag", () => {
    expect(importFlagUrl("/prj_1/session")).toBe("/prj_1/session?import=conversations")
    expect(importFlagUrl("/prj_1/session?x=1")).toBe("/prj_1/session?x=1&import=conversations")
  })

  test("the flag is taken at most once per project", () => {
    expect(takeImportFlag("prj_a", "?import=conversations")).toBe(true)
    expect(takeImportFlag("prj_a", "?import=conversations")).toBe(false)
    expect(takeImportFlag("prj_b", "")).toBe(false)
    expect(takeImportFlag("prj_b", "?import=conversations")).toBe(true)
  })
})
