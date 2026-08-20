import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

test("slash menu keeps native research commands discoverable and compact", () => {
  const component = readFileSync(fileURLToPath(new URL("./prompt-input.tsx", import.meta.url)), "utf8")
  const styles = readFileSync(fileURLToPath(new URL("./prompt-input.css", import.meta.url)), "utf8")

  for (const command of [
    "plan",
    "review",
    "verify",
    "status",
    "context",
    "stop",
    "compact",
    "handoff",
    "checkpoint",
    "reproduce",
    "compare",
    "sources",
    "export",
  ]) {
    expect(component).toContain(`"${command}"`)
  }
  expect(component).toContain('source: "builtin" as const')
  expect(component).toContain('cmd.type === "command" || cmd.type === "skill"')
  expect(component.indexOf("if (native && active")).toBeLessThan(component.indexOf("const currentModel"))
  expect(component).toContain("workspace-composer__slash-usage")
  expect(component).toContain("workspace-composer__slash-badge")
  expect(styles).toMatch(/\.workspace-composer__slash-copy\s*\{[^}]*display: grid/s)
  expect(styles).toMatch(/\.workspace-composer__slash-badge\s*\{[^}]*border-radius: 999px/s)
})
