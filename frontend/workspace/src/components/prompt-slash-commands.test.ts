import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  SLASH_NATIVE,
  slashGroup,
  slashIcon,
  slashMode,
  slashSource,
  sortSlash,
  type SlashCommand,
} from "./prompt-slash"

test("slash menu keeps a small native action surface above toggleable skills", () => {
  const component = readFileSync(fileURLToPath(new URL("./prompt-input.tsx", import.meta.url)), "utf8")
  const hierarchy = readFileSync(fileURLToPath(new URL("./prompt-slash.ts", import.meta.url)), "utf8")
  const styles = readFileSync(fileURLToPath(new URL("./prompt-input.css", import.meta.url)), "utf8")

  expect(hierarchy).toContain('export const SLASH_NATIVE = ["compact", "context", "plan", "goal", "status"]')
  expect(component).toContain("sync.data.command")
  expect(component).toContain("sync.data.skill")
  expect(component).toContain("const catalog = new Map(sync.data.command")
  expect(component).toContain("const builtin = SLASH_NATIVE.map")
  expect(component).toContain("enabledSkills(sync.data.skill ?? [], reserved, sync.data.config.permission)")
  expect(component).toContain('source: "builtin" as const')
  expect(component).toContain("groupBy: slashGroup")
  expect(component).toContain("grouped: slashGrouped")
  expect(component).toContain("aria-label={group.category}")
  expect(component).toContain('if (cmd.type === "skill")')
  expect(component).toContain('void handleSubmit(new Event("submit"), cmd.trigger)')
  expect(component).toContain("const intent = slashMode(cmd)")
  expect(component).toContain("data-composer-intent={intent()}")
  expect(component).toContain('if (store.intent === "plan")')
  expect(component).toContain('if (store.intent === "goal")')
  expect(component).toContain("requestAnimationFrame(scrollSlashActive)")
  expect(component).toContain("editorRef.focus({ preventScroll: true })")
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
  expect(styles).toMatch(/\.workspace-composer__suggestions\s*\{[^}]*max-height: min\(360px, 48vh\)/s)
  expect(styles).toContain(".workspace-composer__intent")
})

test("slash hierarchy keeps frequent native actions ahead of a stable skills catalog", () => {
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
    command("goal"),
    command("review", "skill"),
    command("context"),
    command("status"),
    command("compact"),
  ].toSorted(sortSlash)

  expect(SLASH_NATIVE).toEqual(["compact", "context", "plan", "goal", "status"])
  expect(items.slice(0, 5).map((item) => item.trigger)).toEqual([...SLASH_NATIVE])
  expect(items.slice(0, 5).every((item) => slashGroup(item) === "Commands")).toBe(true)
  expect(slashGroup(items.find((item) => item.trigger === "review")!)).toBe("Skills")
  expect(slashGroup(items.find((item) => item.trigger === "biology")!)).toBe("Skills")
  expect(items.slice(0, 5).map(slashSource)).toEqual(["Built in", "Built in", "Built in", "Built in", "Built in"])
  expect(slashSource(items.find((item) => item.trigger === "biology")!)).toBe("")
  expect(items.slice(0, 5).map(slashIcon)).toEqual(["collapse", "book-open", "branch", "task", "activity"])
  expect(slashMode(items.find((item) => item.trigger === "plan")!)).toBe("plan")
  expect(slashMode(items.find((item) => item.trigger === "goal")!)).toBe("goal")
  expect(slashMode(items.find((item) => item.trigger === "compact")!)).toBeUndefined()
})
