import { expect, test } from "bun:test"
import { scopeLabel } from "./command-palette-scope"

const managed = {
  time: { created: 1 },
  id: "prj_1",
  name: "Gemini smoke test",
  worktree: "/data/projects/ce748a33-30e8-4e6f-9d7e-1b6e2ede3ae9",
}

test("the palette names a project created in the app by its name, not by the id its folder carries", () => {
  const active = { projectID: managed.id, project: { worktree: managed.worktree } }
  expect(scopeLabel(active, [managed])).toBe("Gemini smoke test")
})

test("a project the catalog does not hold is named by its folder, and no project means every project", () => {
  const direct = { projectID: "prj_cli", project: { worktree: "/Users/ada/research/RINR" } }
  expect(scopeLabel(direct, [managed])).toBe("RINR")
  expect(scopeLabel(undefined, [managed])).toBe("All projects")
})
