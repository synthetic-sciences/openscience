import { describe, expect, test } from "bun:test"
import {
  basenameLocalPath,
  displayLocalPath,
  isLocalPathRoot,
  isLocalPathWithin,
  joinLocalPath,
  localPathBreadcrumbs,
  localPathRoot,
  normalizeLocalPath,
  parentLocalPath,
  relativeLocalPath,
  resolveTypedLocalPath,
} from "./local-path"

describe("local path operations", () => {
  test("normalizes POSIX, drive-letter, UNC, and mixed separators", () => {
    expect(normalizeLocalPath("/Users/aayam//research/")).toBe("/Users/aayam/research")
    expect(normalizeLocalPath("C:\\Users/aayam\\\\research\\")).toBe("C:/Users/aayam/research")
    expect(normalizeLocalPath("\\\\server\\share\\\\folder/")).toBe("//server/share/folder")
    expect(normalizeLocalPath("///var//tmp")).toBe("/var/tmp")
  })

  test("joins without replacing or resolving traversal-like input", () => {
    expect(joinLocalPath("/", "var/log")).toBe("/var/log")
    expect(joinLocalPath("C:\\Users\\aayam", "research/data")).toBe("C:/Users/aayam/research/data")
    expect(joinLocalPath("\\\\server\\share", "team\\paper")).toBe("//server/share/team/paper")
    expect(resolveTypedLocalPath("../outside", "/home/aayam/work", "/home/aayam")).toBe(
      "/home/aayam/work/../outside",
    )
  })

  test("finds roots and never navigates above them", () => {
    expect(localPathRoot("/var/tmp")).toBe("/")
    expect(localPathRoot("C:\\Users\\aayam")).toBe("C:/")
    expect(localPathRoot("\\\\server\\share\\folder")).toBe("//server/share")
    expect(isLocalPathRoot("/")).toBe(true)
    expect(isLocalPathRoot("C:\\")).toBe(true)
    expect(isLocalPathRoot("\\\\server\\share\\")).toBe(true)
    expect(parentLocalPath("/")).toBe("/")
    expect(parentLocalPath("C:\\")).toBe("C:/")
    expect(parentLocalPath("\\\\server\\share\\")).toBe("//server/share")
    expect(parentLocalPath("\\\\server\\share\\folder")).toBe("//server/share")
  })

  test("returns cross-platform basenames and file parents", () => {
    expect(basenameLocalPath("/home/aayam/paper.tex")).toBe("paper.tex")
    expect(basenameLocalPath("C:\\Research\\paper.tex")).toBe("paper.tex")
    expect(parentLocalPath("C:\\Research\\paper.tex")).toBe("C:/Research")
    expect(parentLocalPath("\\\\server\\share\\papers\\paper.tex")).toBe("//server/share/papers")
  })

  test("compares containment at boundaries with Windows casing rules", () => {
    expect(isLocalPathWithin("/work/paper", "/work")).toBe(true)
    expect(isLocalPathWithin("/workspace/paper", "/work")).toBe(false)
    expect(isLocalPathWithin("c:\\USERS\\Aayam\\paper", "C:\\Users\\aayam")).toBe(true)
    expect(isLocalPathWithin("\\\\SERVER\\Share\\team", "\\\\server\\share")).toBe(true)
    expect(isLocalPathWithin("\\\\server\\shared\\team", "\\\\server\\share")).toBe(false)
  })

  test("builds drive and UNC breadcrumbs without crossing roots", () => {
    expect(localPathBreadcrumbs("/home/aayam/research", "/home/aayam")).toEqual([
      { label: "~", path: "/home/aayam" },
      { label: "research", path: "/home/aayam/research" },
    ])
    expect(localPathBreadcrumbs("C:\\Users\\aayam\\research", "C:\\Users\\aayam")).toEqual([
      { label: "~", path: "C:/Users/aayam" },
      { label: "research", path: "C:/Users/aayam/research" },
    ])
    expect(localPathBreadcrumbs("\\\\server\\share\\team\\paper", "C:\\Users\\aayam")).toEqual([
      { label: "//server/share", path: "//server/share" },
      { label: "team", path: "//server/share/team" },
      { label: "paper", path: "//server/share/team/paper" },
    ])
  })

  test("expands tilde and relative input while leaving validation-relevant segments intact", () => {
    expect(resolveTypedLocalPath("~/paper", "C:\\Users\\aayam\\work", "C:\\Users\\aayam")).toBe(
      "C:/Users/aayam/paper",
    )
    expect(resolveTypedLocalPath("notes", "\\\\server\\share\\team", "C:\\Users\\aayam")).toBe(
      "//server/share/team/notes",
    )
    expect(resolveTypedLocalPath("..\\private", "C:\\Users\\aayam\\work", "C:\\Users\\aayam")).toBe(
      "C:/Users/aayam/work/../private",
    )
    expect(displayLocalPath("c:\\users\\AAYAM\\work", "C:\\Users\\aayam")).toBe("~/work")
  })
})

describe("relativeLocalPath", () => {
  test("strips only the selected project boundary", () => {
    expect(relativeLocalPath("/work/CERBench/paper/main.tex", "/work/CERBench")).toBe("paper/main.tex")
    expect(relativeLocalPath("/work/CERBench", "/work/CERBench/")).toBe("")
    expect(relativeLocalPath("/work/CERBench-old/paper.tex", "/work/CERBench")).toBe("/work/CERBench-old/paper.tex")
  })

  test("normalizes Windows separators and compares drive paths case-insensitively", () => {
    expect(relativeLocalPath("c:\\Research\\CERBench\\paper.tex", "C:\\Research\\CERBench")).toBe("paper.tex")
    expect(relativeLocalPath("C:\\Research\\CERBench2\\paper.tex", "C:\\Research\\CERBench")).toBe(
      "C:/Research/CERBench2/paper.tex",
    )
  })
})
