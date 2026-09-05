import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  SLASH_NATIVE,
  SLASH_CONTEXTUAL,
  SLASH_ACTION_SKILLS,
  SLASH_QUERY_LIMIT,
  compactSlashItems,
  slashActionSkill,
  slashGroup,
  slashIcon,
  slashEdit,
  slashMode,
  slashMatches,
  slashOptionId,
  slashSource,
  slashState,
  slashTokenAt,
  sortSlash,
  type SlashCommand,
} from "./prompt-slash"

test("empty slash stays bounded to native commands plus the selected skill shortlist", () => {
  const command = (trigger: string, source: SlashCommand["source"] = "builtin"): SlashCommand => ({
    id: `${source}.${trigger}`,
    trigger,
    title: trigger,
    source,
    category: source === "skill" ? "skill" : "session",
    type: source === "skill" ? "skill" : "command",
  })
  const commands = [
    ...SLASH_NATIVE.map((name) => command(name)),
    command("undo"),
    command("redo"),
    command("stop"),
    command("recommended", "skill"),
    command("hidden-library-skill", "skill"),
  ]

  expect(compactSlashItems(commands, new Set(["recommended"])).map((item) => item.trigger)).toEqual([
    ...SLASH_NATIVE,
    ...SLASH_CONTEXTUAL,
    "recommended",
  ])
})

test("slash skills use the same subject-aware icon resolver as the skills catalog", () => {
  expect(
    slashIcon({
      id: "skill.protein-folding",
      trigger: "protein-folding",
      title: "Protein folding",
      description: "Analyze protein sequences",
      source: "skill",
      category: "skill",
      type: "skill",
      skillCategory: "biology",
    }),
  ).toBe("braces")
})

test("query ranking returns at most ten best matches with stable accessible IDs", () => {
  const commands: SlashCommand[] = Array.from({ length: 20 }, (_, index) => ({
    id: `skill.analysis-${index}`,
    trigger: `analysis-${index}`,
    title: `Analysis ${index}`,
    description: index === 17 ? "single cell exact workflow" : "general workflow",
    source: "skill",
    category: "skill",
    type: "skill",
  }))
  commands.push({
    id: "skill.single-cell",
    trigger: "single-cell",
    title: "Single cell",
    source: "skill",
    category: "skill",
    type: "skill",
    skillState: "loaded",
  })

  const result = slashMatches(commands, "single cell", SLASH_QUERY_LIMIT)
  expect(result).toHaveLength(2)
  expect(result.map((item) => item.trigger)).toEqual(["single-cell", "analysis-17"])
  expect(slashOptionId(result[0])).toBe("composer-slash-option-skill-single-cell")
  expect(slashState(result[0])).toBe("Loaded this turn")
  expect(slashMatches(commands, "analysis", SLASH_QUERY_LIMIT)).toHaveLength(10)
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
  expect(SLASH_CONTEXTUAL).toEqual(["undo", "redo", "stop"])
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

test("slash modes preserve the draft and caret at the start, middle, and end", () => {
  expect(slashEdit("/goal Finish the paper", 5, "")).toEqual({
    content: "Finish the paper",
    cursor: 0,
    start: 0,
    end: 6,
    value: "",
  })
  expect(slashEdit("Please /plan revise the paper", 12, "")).toEqual({
    content: "Please revise the paper",
    cursor: 7,
    start: 7,
    end: 13,
    value: "",
  })
  expect(slashEdit("Finish the paper /goal", 22, "")).toEqual({
    content: "Finish the paper",
    cursor: 16,
    start: 16,
    end: 22,
    value: "",
  })
})

test("slash skill insertion preserves text on both sides without duplicate spacing", () => {
  expect(slashEdit("Please use /rev before finalizing", 15, "/review ")).toEqual({
    content: "Please use /review before finalizing",
    cursor: 19,
    start: 11,
    end: 16,
    value: "/review ",
  })
  expect(slashEdit("Inspect results with /rev", 25, "/review ")).toEqual({
    content: "Inspect results with /review ",
    cursor: 29,
    start: 21,
    end: 25,
    value: "/review ",
  })
  expect(slashEdit("path/to/file", 12, "/review ")).toBeUndefined()
})
