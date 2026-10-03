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

  // A config file that is not an object at all fails on the root of the parse,
  // so its Zod issue has an empty path. The file is already named above, and a
  // root issue must not leave a bare trailing space where the others read a path.
  test("locates a nested config issue, and says nothing for one at the config root", () => {
    const rows = formatError(
      {
        name: "ConfigInvalidError",
        data: {
          path: "C:\\config\\openscience.json",
          issues: [
            { message: "Invalid input: expected object, received string", path: [] },
            { message: "Invalid input: expected string, received number", path: ["model"] },
          ],
        },
      },
      t,
    )
      .split("\n")
      .filter((line) => line.startsWith("↳ "))

    expect(rows).toEqual([
      "↳ Invalid input: expected object, received string",
      "↳ Invalid input: expected string, received number model",
    ])
  })
})
