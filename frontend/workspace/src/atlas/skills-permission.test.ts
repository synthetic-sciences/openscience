import { describe, expect, test } from "bun:test"
import {
  commitSkillPermission,
  enabledSkills,
  restoreExactSkillPermission,
  skillAction,
  skillPermissionChange,
  visibleSkills,
} from "./skill-permissions"

describe("skill Settings permission controls", () => {
  test("deduplicates skill names and can reserve command-owned entries", () => {
    const skills = [
      { name: "goal" },
      { name: "biology" },
      { name: "goal" },
      { name: "internal", entry: false },
      { name: "physics" },
    ]
    const commands = ["goal", "plan", "compact"]

    expect(visibleSkills(skills, []).map((skill) => skill.name)).toEqual(["goal", "biology", "physics"])
    expect(visibleSkills(skills, commands).map((skill) => skill.name)).toEqual(["biology", "physics"])
    expect(enabledSkills(skills, commands, { skill: { biology: "deny" } }).map((skill) => skill.name)).toEqual([
      "physics",
    ])
  })

  test("respects a wildcard skill denial and lets an exact override win", () => {
    expect(skillAction({ skill: "deny" }, "literature-review")).toBe("deny")
    expect(skillAction({ skill: { "*": "deny", biology: "allow" } }, "biology")).toBe("allow")
    expect(skillAction({ skill: { "*": "deny", biology: "allow" } }, "physics")).toBe("deny")
  })

  test("preserves an ask-by-default skill rule while adding an exact toggle", () => {
    const change = skillPermissionChange({ skill: "ask" }, "biology", false)

    expect(skillAction({ skill: "ask" }, "physics")).toBe("ask")
    expect(change.patch.skill).toEqual({ "*": "ask", biology: "deny" })
  })

  test("builds a persistence patch without dropping unrelated permissions", () => {
    const change = skillPermissionChange({ bash: "ask", skill: { "*": "deny" } }, "biology", true)

    expect(change.patch).toEqual({ skill: { "*": "deny", biology: "allow" } })
    expect(change.optimistic as Record<string, unknown>).toEqual({
      bash: "ask",
      skill: { "*": "deny", biology: "allow" },
    })
  })

  test("disabling one skill preserves every existing exact rule", () => {
    const change = skillPermissionChange({ skill: { biology: "allow", physics: "allow" } }, "biology", false)

    expect(change.patch.skill).toEqual({ biology: "deny", physics: "allow" })
  })

  test("serializes optimistic writes and rolls a failed write back", async () => {
    let permission: unknown = { skill: { biology: "allow" } }
    let busy = false
    let release!: () => void
    const pending = new Promise<void>((resolve) => (release = resolve))
    const hooks = {
      isBusy: () => busy,
      permission: () => permission,
      setPermission: (next: unknown) => (permission = next),
      setBusy: (next: boolean) => (busy = next),
      write: async () => pending,
    }

    const first = commitSkillPermission("biology", false, hooks)
    expect(await commitSkillPermission("physics", false, hooks)).toEqual({ ok: false, busy: true })
    expect(skillAction(permission, "biology")).toBe("deny")
    release()
    expect(await first).toEqual({ ok: true })

    hooks.write = async () => {
      throw new Error("config write failed")
    }
    expect(await commitSkillPermission("biology", true, hooks)).toEqual({ ok: false, error: "config write failed" })
    expect(skillAction(permission, "biology")).toBe("deny")
  })

  test("rolls back one failed skill without erasing a newer optimistic change", () => {
    const before: Record<string, unknown> = { bash: "ask", skill: { "*": "allow", biology: "allow" } }
    const current: Record<string, unknown> = {
      bash: "ask",
      skill: { "*": "allow", biology: "deny", physics: "deny" },
    }

    expect(restoreExactSkillPermission(current, before, "biology")).toEqual({
      bash: "ask",
      skill: { "*": "allow", biology: "allow", physics: "deny" },
    })
    expect(restoreExactSkillPermission(current, { skill: { "*": "allow" } }, "biology")).toEqual({
      bash: "ask",
      skill: { "*": "allow", physics: "deny" },
    })
  })
})
