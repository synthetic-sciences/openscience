import { describe, expect, test } from "bun:test"
import path from "node:path"

const source = await Bun.file(path.join(import.meta.dir, "../../src/cli/cmd/run.ts")).text()

describe("openscience run research contract", () => {
  test("exposes Normal and Ultra and forwards the selected effort", () => {
    expect(source).toContain('.option("effort", {')
    expect(source).toContain('choices: ["normal", "ultra"] as const')
    expect(source).toContain('default: "normal" as const')
    expect(source).toContain("effort: args.effort")
  })

  test("offers every approval scope in the terminal", () => {
    expect(source).toContain('{ value: "once", label: "Allow once" }')
    expect(source).toContain('{ value: "session", label: "This conversation" }')
    expect(source).toContain('{ value: "project", label: "This project" }')
    expect(source).toContain('{ value: "always", label: "Global" }')
  })
})
