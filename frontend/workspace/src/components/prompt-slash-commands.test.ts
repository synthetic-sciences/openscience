import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  SLASH_NATIVE,
  SLASH_ACTION_SKILLS,
  slashActionSkill,
  slashGroup,
  slashIcon,
  slashMode,
  slashSource,
  slashTokenAt,
  sortSlash,
  type SlashCommand,
} from "./prompt-slash"

test("slash menu keeps a small toggleable action surface above other skills", () => {
  const component = readFileSync(fileURLToPath(new URL("./prompt-input.tsx", import.meta.url)), "utf8")
  const hierarchy = readFileSync(fileURLToPath(new URL("./prompt-slash.ts", import.meta.url)), "utf8")
  const styles = readFileSync(fileURLToPath(new URL("./prompt-input.css", import.meta.url)), "utf8")

  expect(hierarchy).toContain('export const SLASH_NATIVE = ["compact", "context", "plan", "goal", "status"]')
  expect(component).toContain("sync.data.command")
  expect(component).toContain("sync.data.skill")
  expect(component).toContain("const catalog = new Map(sync.data.command")
  expect(component).toContain("const builtin = SLASH_NATIVE.filter(")
  expect(component).toContain('skillAction(sync.data.config.permission, name) !== "deny"')
  expect(component).not.toContain("available.has(name)")
  expect(component).toContain("const slashItems = (query: string) =>")
  expect(component).toContain("if (!query.trim()) return items")
  expect(component).toContain('item.source === "builtin" &&')
  expect(component).toContain("!SLASH_NATIVE.some((name) => name === item.name)")
  expect(component).toContain('skillAction(sync.data.config.permission, item.name) !== "deny"')
  expect(component).toContain("const exact = all.filter((item) => trigger(item) === needle)")
  expect(component).toContain("if (exact.length) return exact")
  expect(component).toContain("if (prefix.length) return prefix")
  expect(component).toContain("if (contained.length) return contained")
  expect(component).toContain("items: slashItems")
  expect(component).toContain("const enabled = enabledSkills(sync.data.skill ?? [], [], sync.data.config.permission)")
  expect(component).toContain("const skills = enabled")
  expect(component).toContain(".filter((skill) => !reserved.has(skill.name))")
  expect(component).toContain('source: "builtin" as const')
  expect(component).toContain('type: slashActionSkill(s.name) ? ("action" as const) : ("skill" as const)')
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
  expect(slashGroup({ ...command("init", "skill"), type: "action" })).toBe("Skills")
  expect(SLASH_ACTION_SKILLS).toEqual(["init", "stop", "handoff", "checkpoint"])
  expect(SLASH_ACTION_SKILLS.every(slashActionSkill)).toBe(true)
  expect(slashActionSkill("review")).toBe(false)
  expect(items.slice(0, 5).map(slashSource)).toEqual(["Built in", "Built in", "Built in", "Built in", "Built in"])
  expect(slashSource(items.find((item) => item.trigger === "biology")!)).toBe("")
  expect(items.slice(0, 5).map(slashIcon)).toEqual(["collapse", "book-open", "branch", "task", "activity"])
  expect(slashMode(items.find((item) => item.trigger === "plan")!)).toBe("plan")
  expect(slashMode(items.find((item) => item.trigger === "goal")!)).toBe("goal")
  expect(slashMode(items.find((item) => item.trigger === "compact")!)).toBeUndefined()
})

test("slash skills can be selected at the start, middle, or end of a draft", () => {
  expect(slashTokenAt("/scan", 5)).toEqual({ query: "scan", start: 0, end: 5, inline: false })
  expect(slashTokenAt("Please use /scan before plotting", 16)).toEqual({
    query: "scan",
    start: 11,
    end: 16,
    inline: true,
  })
  expect(slashTokenAt("Inspect results, then /venue", 28)).toEqual({
    query: "venue",
    start: 22,
    end: 28,
    inline: true,
  })
  expect(slashTokenAt("path/to/file", 12)).toBeUndefined()
})
