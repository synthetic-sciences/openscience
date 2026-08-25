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

  test("refuses launcher and high-churn global roots while keeping narrow managed projects", () => {
    const home = "/Users/researcher"
    const data = `${home}/.openscience`
    expect(
      normalizeWatchRoots([home, `${home}/Library`, data, `${data}/projects/prj_1`, `${data}/workspaces/ses_1`], {
        home,
        data,
      }),
    ).toEqual([`${data}/projects/prj_1`, `${data}/workspaces/ses_1`])
  })
})
