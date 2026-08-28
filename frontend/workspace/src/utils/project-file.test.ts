import { describe, expect, test } from "bun:test"
import { projectContains, projectFileQuery, rawFileQuery } from "./project-file"

describe("project file requests", () => {
  test("builds collection and manuscript queries with the active session authority", () => {
    expect(
      projectFileQuery({
        directory: "/work/CERBench",
        sessionID: "ses_research",
      }),
    ).toEqual({ sessionID: "ses_research" })
    expect(
      projectFileQuery({
        directory: "/work/CERBench",
        path: "paper/report.md",
        sessionID: "ses_research",
      }),
    ).toEqual({ path: "/work/CERBench/paper/report.md", sessionID: "ses_research" })
  })

  test("anchors project-relative raw paths before adding session authorization", () => {
    expect(
      rawFileQuery({
        directory: "/work/CERBench",
        path: "figures/results.png",
        sessionID: "ses_research",
        inline: true,
      }),
    ).toEqual({
      path: "/work/CERBench/figures/results.png",
      sessionID: "ses_research",
      inline: "true",
    })
  })

  test("keeps session-workspace paths relative to the active session grant", () => {
    expect(
      rawFileQuery({
        directory: "/work/CERBench",
        path: "analysis/results.csv",
        sessionID: "ses_research",
        scope: "session",
        inline: true,
      }),
    ).toEqual({
      path: "analysis/results.csv",
      sessionID: "ses_research",
      inline: "true",
    })
  })

  test("preserves absolute granted paths and forwards an explicit byte cap", () => {
    expect(
      rawFileQuery({
        directory: "/work/CERBench",
        path: "/external/paper.pdf",
        sessionID: "ses_research",
        maxBytes: 64 * 1024 * 1024,
        inline: false,
      }),
    ).toEqual({
      path: "/external/paper.pdf",
      sessionID: "ses_research",
      maxBytes: 64 * 1024 * 1024,
      inline: "false",
    })
  })

  test("distinguishes project artifacts from other connected roots on POSIX and Windows", () => {
    expect(projectContains("/work/CERBench", "figures/result.png")).toBe(true)
    expect(projectContains("/work/CERBench", "figures/../result.png")).toBe(true)
    expect(projectContains("/work/CERBench", "../external/result.png")).toBe(false)
    expect(projectContains("/work/CERBench", "/work/CERBench-paper/result.png")).toBe(false)
    expect(projectContains("/work/CERBench", "/other/figures/result.png")).toBe(false)
    expect(projectContains("C:\\work\\CERBench", "figures\\result.png")).toBe(true)
    expect(projectContains("C:\\work\\CERBench", "..\\external\\result.png")).toBe(false)
    expect(projectContains("C:\\work\\CERBench", "D:\\figures\\result.png")).toBe(false)
  })
})
