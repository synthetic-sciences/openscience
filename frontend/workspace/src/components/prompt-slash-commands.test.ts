import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { SLASH_CORE, slashGroup, slashIcon, slashSource, sortSlash, type SlashCommand } from "./prompt-slash"

test("slash menu keeps native research commands discoverable and compact", () => {
  const component = readFileSync(fileURLToPath(new URL("./prompt-input.tsx", import.meta.url)), "utf8")
  const hierarchy = readFileSync(fileURLToPath(new URL("./prompt-slash.ts", import.meta.url)), "utf8")
  const styles = readFileSync(fileURLToPath(new URL("./prompt-input.css", import.meta.url)), "utf8")

  expect(hierarchy).toContain('export const SLASH_CORE = ["goals", "compact", "review", "plan"]')
  expect(component).toContain("sync.data.command")
  expect(component).toContain("sync.data.skill")
  expect(component).toContain("!triggers.has(command.name)")
  expect(component).toContain('source: "builtin" as const')
  expect(component).toContain("groupBy: slashGroup")
  expect(component).toContain("grouped: slashGrouped")
  expect(component).toContain("aria-label={group.category}")
  expect(component).toContain('cmd.type === "command" || cmd.type === "skill"')
  expect(component).toContain('const native = command?.source === "builtin" && command.menu')
  expect(component.indexOf("if (native && active")).toBeLessThan(component.indexOf("const currentModel"))
  expect(component).toContain("workspace-composer__slash-icon")
  expect(component).toContain("workspace-composer__slash-meta")
  expect(component).toContain('when={group.category === "Skills"}')
  expect(component).not.toContain("workspace-composer__slash-badge")
  expect(styles).toMatch(/\.workspace-composer__slash-row\s*\{[^}]*display: grid/s)
  expect(styles).toMatch(/\.workspace-composer__slash-group\s*\{[^}]*display: grid/s)
  expect(styles).toMatch(/\.workspace-composer__slash-heading\s*\{[^}]*font-size: 12px/s)
  expect(styles).toMatch(/\.workspace-composer__suggestions\s*\{[^}]*border-radius: var\(--radius-xl\)/s)
})

test("slash hierarchy keeps core commands ahead of a stable skills catalog", () => {
  const command = (trigger: string, source: SlashCommand["source"] = "builtin"): SlashCommand => ({
    id: `${source}.${trigger}`,
    trigger,
    title: trigger,
    source,
    category: source === "skill" ? "skill" : "session",
    type: source === "skill" ? "skill" : "command",
  })
  const items = [
    command("biology", "skill"),
    command("plan"),
    command("status"),
    command("goals"),
    command("review"),
    command("compact"),
  ].toSorted(sortSlash)

  expect(SLASH_CORE).toEqual(["goals", "compact", "review", "plan"])
  expect(items.slice(0, 4).map((item) => item.trigger)).toEqual([...SLASH_CORE])
  expect(items.slice(0, 4).every((item) => slashGroup(item) === "Commands")).toBe(true)
  expect(items.slice(4).every((item) => slashGroup(item) === "Skills")).toBe(true)
  expect(items.slice(0, 4).map(slashSource)).toEqual(["", "", "", ""])
  expect(slashSource(items[4]!)).toBe("Built in")
  expect(slashSource(items[5]!)).toBe("Skill")
  expect(items.slice(0, 4).map(slashIcon)).toEqual(["task", "collapse", "eye", "branch"])
})
