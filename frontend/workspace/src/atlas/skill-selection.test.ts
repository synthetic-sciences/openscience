import { expect, test } from "bun:test"
import { selectedSkills, skillCatalogKey, skillDensity, skillSelection } from "./skill-selection"
import { skillCatalogSnapshot, skillAction } from "./skill-permissions"

test("selection preserves unknown and unrelated disabled names without changing permission", () => {
  expect(skillSelection(["unknown", "biology"], ["biology"], true)).toEqual(["unknown"])
  expect(skillSelection(["unknown"], ["biology", "biology"], false)).toEqual(["unknown", "biology"])
})

test("disabled and policy-blocked skills cannot enter the active shortlist", () => {
  const snapshot = skillCatalogSnapshot(
    [
      { name: "off", enabled: false, permission_action: "allow" },
      { name: "ask", enabled: true, permission_action: "ask" },
      { name: "denied", enabled: true, permission_action: "deny" },
      { name: "blocked", catalog_status: "blocked", enabled: true, permission_action: "allow" },
    ],
    { pinned: ["off", "ask", "denied", "blocked"] },
  )
  expect(snapshot.allowed.map((skill) => skill.name)).toEqual(["ask"])
  expect(snapshot.shortlist.map((skill) => skill.name)).toEqual(["ask"])
  expect(
    selectedSkills(snapshot.library, { view: "off", pinned: new Set(), active: new Set(["ask"]) }).map(
      (skill) => skill.name,
    ),
  ).toEqual(["off", "denied", "blocked"])
  expect(
    selectedSkills(snapshot.library, { view: "pinned", pinned: new Set(["off"]), active: new Set(["ask"]) }).map(
      (skill) => skill.name,
    ),
  ).toEqual(["off"])
})

test("UI permission matching follows last matching backend wildcards and top-level rules", () => {
  expect(skillAction({ skill: { "bio*": "deny" } }, "biology")).toBe("deny")
  expect(skillAction({ skill: { biology: "allow", "bio*": "ask" } }, "biology")).toBe("ask")
  expect(skillAction({ skill: { "bio*": "ask", biology: "allow" } }, "biology")).toBe("allow")
  expect(skillAction({ skill: "allow", "*": "deny" }, "biology")).toBe("deny")
  expect(skillAction("ask", "biology")).toBe("ask")
  expect(skillAction({ skill: { "bio?": "deny" } }, "bio1")).toBe("deny")
})

test("skill catalogs never share server ports and density safely falls back", () => {
  expect(skillCatalogKey("http://localhost:4096/")).toBe(skillCatalogKey("http://localhost:4096"))
  expect(skillCatalogKey("http://localhost:4096")).not.toBe(skillCatalogKey("http://localhost:4097"))
  expect(skillDensity({ getItem: () => "compact" })).toBe("compact")
  expect(
    skillDensity({
      getItem: () => {
        throw new Error("Unavailable")
      },
    }),
  ).toBe("comfortable")
})
