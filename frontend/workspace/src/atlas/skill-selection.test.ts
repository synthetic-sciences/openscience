import { expect, test } from "bun:test"
import { compareCore, selectedSkills, skillCatalogKey, skillSelection, skillSource } from "./skill-selection"
import { skillCatalogSnapshot, skillAction } from "./skill-permissions"

test("selection preserves unknown and unrelated disabled names without changing permission", () => {
  expect(skillSelection(["unknown", "biology"], ["biology"], true)).toEqual(["unknown"])
  expect(skillSelection(["unknown"], ["biology", "biology"], false)).toEqual(["unknown", "biology"])
})

test("disabled and policy-blocked skills cannot enter the active shortlist", () => {
  const snapshot = skillCatalogSnapshot(
    [
      { name: "off", enabled: false, permission_action: "allow", location: "/skills/biology/off/SKILL.md" },
      { name: "ask", enabled: true, permission_action: "ask", location: "/skills/core/ask/SKILL.md", category: "core" },
      {
        name: "denied",
        enabled: true,
        permission_action: "deny",
        location: "/home/me/.openscience/user-skills/denied/SKILL.md",
      },
      {
        name: "blocked",
        catalog_status: "blocked",
        enabled: true,
        permission_action: "allow",
        location: "/skills/biology/blocked/SKILL.md",
      },
    ],
    { pinned: ["off", "ask", "denied", "blocked"] },
  )
  expect(snapshot.allowed.map((skill) => skill.name)).toEqual(["ask"])
  expect(snapshot.shortlist.map((skill) => skill.name)).toEqual(["ask"])
  const active = new Set(["ask"])
  expect(selectedSkills(snapshot.library, { view: "off", active }).map((skill) => skill.name)).toEqual([
    "off",
    "denied",
    "blocked",
  ])
  expect(selectedSkills(snapshot.library, { view: "core", active }).map((skill) => skill.name)).toEqual(["ask"])
  expect(selectedSkills(snapshot.library, { view: "personal", active }).map((skill) => skill.name)).toEqual(["denied"])
  expect(selectedSkills(snapshot.library, { view: "library", active }).map((skill) => skill.name)).toEqual([
    "off",
    "blocked",
  ])
  expect(skillSource({ location: "/home/me/.openscience/user-skills/denied/SKILL.md" })).toBe("user")
  expect(skillSource({ location: "/data/installed-skills/x/skills/y/SKILL.md" })).toBe("installed")
})

test("core skills keep the workflow order ahead of the alphabet", () => {
  const names = ["sources", "figures", "zeta", "research-lookup", "alpha"].sort((a, b) =>
    compareCore({ name: a }, { name: b }),
  )
  expect(names).toEqual(["research-lookup", "figures", "sources", "alpha", "zeta"])
})

test("UI permission matching follows last matching backend wildcards and top-level rules", () => {
  expect(skillAction({ skill: { "bio*": "deny" } }, "biology")).toBe("deny")
  expect(skillAction({ skill: { biology: "allow", "bio*": "ask" } }, "biology")).toBe("ask")
  expect(skillAction({ skill: { "bio*": "ask", biology: "allow" } }, "biology")).toBe("allow")
  expect(skillAction({ skill: "allow", "*": "deny" }, "biology")).toBe("deny")
  expect(skillAction("ask", "biology")).toBe("ask")
  expect(skillAction({ skill: { "bio?": "deny" } }, "bio1")).toBe("deny")
})

test("skill catalogs never share server ports", () => {
  expect(skillCatalogKey("http://localhost:4096/")).toBe(skillCatalogKey("http://localhost:4096"))
  expect(skillCatalogKey("http://localhost:4096")).not.toBe(skillCatalogKey("http://localhost:4097"))
})
