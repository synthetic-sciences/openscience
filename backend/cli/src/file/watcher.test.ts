import { describe, expect, test } from "bun:test"
import { normalizeWatchRoots, projectWatchRoots } from "./watcher"

describe("file watcher roots", () => {
  test("watches a managed non-git project instead of requiring VCS metadata", () => {
    const directory = "/Users/researcher/.openscience/projects/58e4a6d9-f9cb-4de0-83aa-a236cb718206"

    expect(projectWatchRoots({ directory, vcs: undefined })).toEqual([directory])
  })

  test("deduplicates explicit roots and refuses a recursive filesystem-root subscription", () => {
    expect(normalizeWatchRoots(["/", "/tmp/research", "/tmp/research/"])).toEqual(["/tmp/research"])
  })
})
