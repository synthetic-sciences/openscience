import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = () => readFileSync(fileURLToPath(new URL("./FolderPicker.tsx", import.meta.url)), "utf8")
const styles = () => readFileSync(fileURLToPath(new URL("./FolderPicker.css", import.meta.url)), "utf8")

describe("folder picker design contract", () => {
  test("uses a scoped, responsive browser surface without inline visual state", () => {
    const code = source()
    const css = styles()

    expect(code).toContain('class="folder-picker-dialog"')
    expect(code).toContain('class="folder-picker"')
    expect(code).toContain('import "./FolderPicker.css"')
    expect(code).not.toContain("style={{")
    expect(code).not.toContain("onMouseEnter=")
    expect(code).not.toContain("onMouseLeave=")
    expect(css).toContain("grid-template-columns: 188px minmax(0, 1fr)")
    expect(css).toContain("@media (max-width: 620px)")
    expect(css).toContain("grid-template-rows: auto minmax(0, 1fr)")
    expect(css).not.toContain("text-transform")
  })

  test("keeps breadcrumb navigation aligned and built from canonical icons", () => {
    const code = source()
    const css = styles()

    expect(code).toContain('import { Icon, type IconProps } from "@synsci/ui/icon"')
    expect(code).toContain('<nav class="folder-picker__location" aria-label="Current folder">')
    expect(code).toContain('name="arrow-up"')
    expect(code).toContain('name="chevron-right"')
    expect(code).toContain('name="home"')
    expect(code).toContain('name="refresh"')
    expect(code).toContain('label: "Desktop", path: h + "/Desktop", icon: "layout-grid"')
    expect(code).toContain('label: "Documents", path: h + "/Documents", icon: "file"')
    expect(code).toContain('label: "Downloads", path: h + "/Downloads", icon: "download"')
    expect(code).not.toContain('from "@/atlas/shared/Icon"')
    expect(css).toMatch(/\.folder-picker__location\s*\{[^}]*align-items: center/s)
    expect(css).toMatch(/\.folder-picker__breadcrumbs\s*\{[^}]*overflow-x: auto/s)
    expect(css).toMatch(/\.folder-picker__icon-button\s*\{[^}]*width: 32px;[^}]*height: 32px/s)
    expect(css).not.toContain("linear-gradient")
  })

  test("preserves path validation and the macOS explicit-path fallback", () => {
    const code = source()

    expect(code).toContain('if (trimmed === "~") return home()')
    expect(code).toContain('if (trimmed.startsWith("~/")) return home() + trimmed.slice(1)')
    expect(code).toContain("const valid = await validateDirectoryPath(sdk.url, abs)")
    expect(code).toContain("if (!valid) return")
    expect(code).toContain("setCwd(valid)")
    expect(code).toContain("const valid = await validateDirectoryPath(sdk.url, cwd())")
    expect(code).toContain("if (valid) pick(valid)")
    expect(code).toContain('aria-label="Go to path"')
    expect(code).toContain("macOS can hide Desktop")
    expect(code).not.toContain("bs-local")
  })

  test("keeps explicit selection actions and accessible touch geometry", () => {
    const code = source()
    const css = styles()

    expect(code).toContain('class="folder-picker__row-open"')
    expect(code).toContain('class="folder-picker__choose"')
    expect(code).toContain('title="Choose this folder"')
    expect(code).toContain('size="normal" variant="ghost" onClick={cancel}')
    expect(code).toContain('size="normal"\n                  variant="primary"')
    expect(code).not.toContain('role="button"')
    expect(css).toContain("@media (pointer: coarse)")
    expect(css).toMatch(/@media \(pointer: coarse\)[\s\S]*min-height: 44px/)
  })

  test("uses the shared radius ladder and solid structural boundaries", () => {
    const css = styles()

    expect(css).toMatch(
      /\.folder-picker-dialog\s*\{[^}]*border: 1px solid var\(--border-base\);[^}]*border-radius: var\(--atlas-radius-md\)/s,
    )
    expect(css).toMatch(
      /\.folder-picker__list\s*\{[^}]*border: 1px solid var\(--border-weak-base\);[^}]*border-radius: var\(--atlas-radius-sm\)/s,
    )
    expect(css).toContain("border-radius: var(--atlas-radius-xs)")
    expect(css).not.toMatch(/border-radius:\s*\d+(?:\.\d+)?px/)
    expect(css).not.toMatch(/border(?:-(?:top|right|bottom|left))?:\s*[^;\n]*color-mix/)
  })
})
