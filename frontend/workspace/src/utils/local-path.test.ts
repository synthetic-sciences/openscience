import { describe, expect, test } from "bun:test"
import { relativeLocalPath } from "./local-path"

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
