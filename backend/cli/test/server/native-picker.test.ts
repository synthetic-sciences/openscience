import { describe, expect, test } from "bun:test"
import { nativePickerPlan } from "../../src/server/routes/folder-resolve"

describe("native picker commands", () => {
  test("uses Finder through AppleScript on macOS", () => {
    const plan = nativePickerPlan({ kind: "folder", title: "Add source folders", multiple: true }, "darwin")

    expect(plan?.command).toBe("osascript")
    expect(plan?.format).toBe("lines")
    expect(plan?.args).toContain("Add source folders")
    expect(plan?.args.join("\n")).toContain("choose folder with prompt dialogTitle with multiple selections allowed")
  })

  test("uses the Windows system dialogs and safely quotes titles", () => {
    const plan = nativePickerPlan({ kind: "file", title: "Researcher's source", multiple: true }, "win32")
    const script = plan?.args.at(-1) ?? ""

    expect(plan?.command).toBe("powershell.exe")
    expect(plan?.format).toBe("json")
    expect(script).toContain("System.Windows.Forms.OpenFileDialog")
    expect(script).toContain("Researcher''s source")
    expect(script).toContain("$picker.Multiselect = $true")
  })

  test("lets unsupported hosts use the in-app fallback", () => {
    expect(nativePickerPlan({ kind: "folder", title: "Choose", multiple: false }, "linux")).toBeUndefined()
  })
})
