import { describe, expect, test } from "bun:test"
import { packageStep } from "../../src/cli/cmd/uninstall"

describe("uninstall package step", () => {
  test("a desktop copy runs nothing and says the app stays, per platform", () => {
    const mac = packageStep("desktop", "darwin")
    expect(mac?.command).toBeUndefined()
    expect(mac?.summary).toBe("○ App: OpenScience.app is left in place — move it to the Trash to finish uninstalling")
    expect(mac?.outro).toContain("OpenScience.app is still installed")
    expect(mac?.outro).toContain("move it to the Trash")

    const windows = packageStep("desktop", "win32")
    expect(windows?.command).toBeUndefined()
    expect(windows?.summary).toStartWith("○ App: OpenScience is left in place")
    expect(windows?.summary).toContain("Add or remove programs")
    expect(windows?.outro).toContain("Add or remove programs")

    const linux = packageStep("desktop", "linux")
    expect(linux?.command).toBeUndefined()
    expect(linux?.summary).toStartWith("○ App: OpenScience is left in place")
    expect(linux?.summary).toContain("AppImage")
    expect(linux?.outro).toContain("AppImage")
  })

  test("a desktop copy is never listed as a package to remove", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      expect(packageStep("desktop", platform)?.summary).not.toContain("✓")
      expect(packageStep("desktop", platform)?.summary).not.toContain("Package")
    }
  })

  test("a package manager install lists and runs the same command", () => {
    expect(packageStep("npm")).toEqual({
      summary: "✓ Package: npm uninstall -g @synsci/openscience",
      command: ["npm", "uninstall", "-g", "@synsci/openscience"],
    })
    for (const method of ["pnpm", "bun", "yarn", "choco", "scoop"] as const) {
      const step = packageStep(method)
      expect(step?.command?.at(0)).toBe(method)
      expect(step?.summary).toBe(`✓ Package: ${step?.command?.join(" ")}`)
      expect(step?.outro).toBeUndefined()
    }
  })

  test("a standalone or unrecognised install has no package step", () => {
    expect(packageStep("curl")).toBeUndefined()
    expect(packageStep("unknown")).toBeUndefined()
  })
})
