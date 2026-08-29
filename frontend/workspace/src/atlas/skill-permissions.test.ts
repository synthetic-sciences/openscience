import { expect, test } from "bun:test"
import {
  loadedSkillNamesThisTurn,
  recordRecentSkill,
  setSkillPinned,
  skillCatalogSnapshot,
  skillPreferences,
} from "./skill-permissions"

const skills = [
  { name: "recommended", recommended: true, permission_action: "allow" as const },
  { name: "recent", permission_action: "ask" as const },
  { name: "pinned", permission_action: "allow" as const },
  { name: "denied", recommended: true, permission_action: "deny" as const },
  { name: "helper", entry: false, permission_action: "allow" as const },
]

test("catalog snapshot keeps Library separate from Allowed and a bounded compact shortlist", () => {
  const snapshot = skillCatalogSnapshot(skills, {
    pinned: ["pinned", "denied"],
    recent: ["recent", "pinned"],
    loadedThisTurn: ["recent"],
    shortlistLimit: 3,
  })

  expect(snapshot.library.map((skill) => skill.name)).toEqual(["recommended", "recent", "pinned", "denied"])
  expect(snapshot.allowed.map((skill) => skill.name)).toEqual(["recommended", "recent", "pinned"])
  expect(snapshot.shortlist.map((skill) => skill.name)).toEqual(["pinned", "recent", "recommended"])
  expect(snapshot.loadedThisTurn.map((skill) => skill.name)).toEqual(["recent"])
  expect(snapshot.action("denied")).toBe("deny")
})

test("local permission edits override the server snapshot without exposing denied rows", () => {
  const snapshot = skillCatalogSnapshot(skills, {
    permission: { skill: { denied: "allow", recent: "deny" } },
  })
  expect(snapshot.allowed.map((skill) => skill.name)).toEqual(["recommended", "pinned", "denied"])
  expect(snapshot.action("recent")).toBe("deny")
  expect(snapshot.action("denied")).toBe("allow")
})

test("recent and pinned preferences are deduplicated and bounded", () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  }

  recordRecentSkill("one", storage, 2)
  recordRecentSkill("two", storage, 2)
  recordRecentSkill("one", storage, 2)
  setSkillPinned("one", true, storage)
  setSkillPinned("two", true, storage)
  setSkillPinned("one", false, storage)

  expect(skillPreferences(storage)).toEqual({ pinned: ["two"], recent: ["one", "two"] })
})

test("loaded-this-turn state starts at the latest user turn and requires a completed Skill call", () => {
  const messages = [
    { id: "usr_old", role: "user" },
    { id: "asst_old", role: "assistant" },
    { id: "usr_new", role: "user" },
    { id: "asst_new", role: "assistant" },
  ]
  const parts = {
    asst_old: [
      { type: "tool", tool: "skill", state: { status: "completed", input: { name: "old-skill" }, metadata: {} } },
    ],
    asst_new: [
      { type: "tool", tool: "skill", state: { status: "running", input: { name: "not-loaded" } } },
      {
        type: "tool",
        tool: "skill",
        state: { status: "completed", input: { name: "fallback" }, metadata: { name: "loaded-skill" } },
      },
    ],
  }

  expect(loadedSkillNamesThisTurn(messages, parts)).toEqual(["loaded-skill"])
})
