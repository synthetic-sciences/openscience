import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const COMPONENTS = [
  "CodexConnection.tsx",
  "Connectors.tsx",
  "CredentialServices.tsx",
  "General.tsx",
  "Network.tsx",
  "ProviderKeys.tsx",
] as const

const source = (name: (typeof COMPONENTS)[number]) =>
  readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8")

describe("settings destructive confirmations", () => {
  test.each([...COMPONENTS])("uses the themed alert dialog in %s", (name) => {
    const component = source(name)

    expect(component).toContain('import { useDialog } from "@synsci/ui/context/dialog"')
    expect(component).toContain('import { confirmDialog } from "@/atlas/dialogs"')
    expect(component).toContain("const dialog = useDialog()")
    expect(component).toContain("await confirmDialog(dialog, {")
    expect(component).toContain("danger: true")
    expect(component).not.toContain("window.confirm")
  })
})
