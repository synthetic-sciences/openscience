import { describe, expect, test } from "bun:test"
import { formatError, projectRecovery } from "./error"

const t = ((key: string) => key) as Parameters<typeof formatError>[1]

describe("workspace error page", () => {
  test("explains a project the server refuses instead of printing its JSON payload", () => {
    const detail = formatError(
      { name: "ProjectMismatchError", data: { projectID: "prj_1", directory: "C:\\Users\\93888" } },
      t,
    )
    expect(detail).toContain("does not match the folder the server resolved (C:\\Users\\93888)")
    expect(detail).toContain("Projects list")
    expect(detail).not.toContain('"projectID"')
    expect(projectRecovery(detail)).toBe(true)
  })

  test("prefers the server's own explanation for a refused session folder", () => {
    const detail = formatError(
      {
        name: "SessionFilesystemInvalidPathError",
        data: { path: "/Users/me", message: "This folder is reserved for OpenScience's managed tool outputs." },
      },
      t,
    )
    expect(detail).toContain("reserved for OpenScience's managed tool outputs")
    expect(projectRecovery(detail)).toBe(true)
  })

  test("other failures keep the reload-first recovery", () => {
    const detail = formatError({ name: "APIError", data: { message: "Provider is overloaded" } }, t)
    expect(detail).toContain("Provider is overloaded")
    expect(projectRecovery(detail)).toBe(false)
  })
})
