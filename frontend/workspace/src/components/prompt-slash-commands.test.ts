import { expect, test } from "bun:test"
import {
  SLASH_NATIVE,
  SLASH_CONTEXTUAL,
  SLASH_CORE,
  SLASH_SESSION,
  SLASH_ACTION_SKILLS,
  SLASH_QUERY_LIMIT,
  SLASH_GROUP_CORE,
  SLASH_GROUP_PINNED,
  SLASH_GROUP_SESSION,
  slashActionSkill,
  slashBlurb,
  slashCatalog,
  slashGroup,
  slashIcon,
  slashEdit,
  slashMode,
  slashMatches,
  slashOptionId,
  slashSubject,
  slashTokenAt,
  sortSlashGroups,
  type SlashCommand,
} from "./prompt-slash"

const command = (
  trigger: string,
  source: SlashCommand["source"] = "builtin",
  extra: Partial<SlashCommand> = {},
): SlashCommand => ({
  id: `${source}.${trigger}`,
  trigger,
  title: trigger,
  source,
  category: source === "skill" ? "skill" : "session",
  type: source === "skill" ? "skill" : "action",
  ...extra,
})

const menu = () => [
  command("unsloth-fine-tuning", "skill", { skillCategory: "ml-training" }),
  command("scanpy", "skill", { skillCategory: "biology" }),
  command("alphafold", "skill", { skillCategory: "biology", skillState: "pinned" }),
  command("figures", "skill", { skillCategory: "core" }),
  command("plan", "builtin", { type: "mode" }),
  command("goal", "builtin", { type: "mode" }),
  command("compact"),
  command("research-lookup", "skill", { skillCategory: "core" }),
  command("checkpoint"),
  command("init"),
  command("stop"),
  command("deploy-docs", "project"),
]

test("a bare slash lists core in workflow order, then pinned, session and the library by subject", () => {
  const rows = slashCatalog(menu())
  expect(rows.map((row) => row.trigger)).toEqual([
    "plan",
    "goal",
    "research-lookup",
    "figures",
    "compact",
    "alphafold",
    "stop",
    "init",
    "checkpoint",
    "deploy-docs",
    "scanpy",
    "unsloth-fine-tuning",
  ])
  expect(rows.slice(0, 5).every((row) => slashGroup(row) === SLASH_GROUP_CORE)).toBe(true)
  expect(slashGroup(rows[5]!)).toBe(SLASH_GROUP_PINNED)
  expect(rows.slice(6, 10).every((row) => slashGroup(row) === SLASH_GROUP_SESSION)).toBe(true)
  expect(slashGroup(rows[10]!)).toBe("Biology")
  expect(slashGroup(rows[11]!)).toBe("ML training")
  expect(rows.map((row) => row.resultRank)).toEqual(rows.map((_, index) => index))
  expect(rows.every((row) => row.meta === undefined)).toBe(true)

  const groups = [
    { category: "Biology", items: [rows[10]!] },
    { category: SLASH_GROUP_CORE, items: rows.slice(0, 5) },
  ].sort(sortSlashGroups)
  expect(groups.map((group) => group.category)).toEqual([SLASH_GROUP_CORE, "Biology"])

  expect(SLASH_NATIVE).toEqual(["plan", "goal", "compact"])
  expect(SLASH_CONTEXTUAL).toEqual(["stop"])
  expect(SLASH_SESSION).toEqual(["stop", "init", "handoff", "checkpoint", "resume"])
  expect(SLASH_CORE.slice(0, 2)).toEqual(["plan", "goal"])
  expect(SLASH_CORE.at(-1)).toBe("compact")
  expect(SLASH_CORE).not.toContain("status")
  expect(SLASH_CORE).not.toContain("context")
  expect(SLASH_CORE).not.toContain("undo")
})

test("a query is one flat ranked list with the library subject as meta and core ahead on ties", () => {
  const results = slashMatches(menu(), "s")
  // Prefix matches first, then substring matches with core skills ahead.
  expect(results.map((row) => row.trigger)).toEqual([
    "stop",
    "scanpy",
    "research-lookup",
    "figures",
    "unsloth-fine-tuning",
    "deploy-docs",
  ])
  expect(results.every((row) => slashGroup(row) === "")).toBe(true)
  expect(results.find((row) => row.trigger === "scanpy")?.meta).toBe("Biology")
  expect(results.find((row) => row.trigger === "unsloth-fine-tuning")?.meta).toBe("ML training")
  expect(results.find((row) => row.trigger === "figures")?.meta).toBeUndefined()
  expect(results.find((row) => row.trigger === "stop")?.meta).toBeUndefined()

  const tie = slashMatches(
    [command("figures", "skill", { skillCategory: "core" }), command("figures-extra", "skill")],
    "fig",
  )
  expect(tie.map((row) => row.trigger)).toEqual(["figures", "figures-extra"])
  expect(tie[0]!.meta).toBeUndefined()

  const many: SlashCommand[] = Array.from({ length: 60 }, (_, index) =>
    command(`analysis-${index}`, "skill", { description: "general workflow" }),
  )
  expect(slashMatches(many, "analysis", SLASH_QUERY_LIMIT)).toHaveLength(SLASH_QUERY_LIMIT)
  expect(slashOptionId(many[0]!)).toBe("composer-slash-option-skill-analysis-0")

  const described = slashMatches(
    [command("cells", "skill", { searchText: "single cell rna sequencing" })],
    "single cell",
  )
  expect(described.map((row) => row.trigger)).toEqual(["cells"])
})

test("rows carry fixed icons for the core toolkit and subject icons for the library", () => {
  expect(slashIcon(command("plan", "builtin", { type: "mode" }))).toBe("branch")
  expect(slashIcon(command("goal", "builtin", { type: "mode" }))).toBe("task")
  expect(slashIcon(command("compact"))).toBe("collapse")
  expect(slashIcon(command("research-lookup", "skill"))).toBe("magnifying-glass")
  expect(slashIcon(command("peer-review", "skill"))).toBe("eye")
  expect(slashIcon(command("protein-folding", "skill", { skillCategory: "biology" }))).toBe("braces")
  expect(slashIcon(command("cell-culture", "skill", { skillCategory: "biology" }))).toBe("activity")
  expect(slashMode(command("plan"))).toBe("plan")
  expect(slashMode(command("goal"))).toBe("goal")
  expect(slashMode(command("compact"))).toBeUndefined()
  expect(SLASH_ACTION_SKILLS).toEqual(["init", "stop", "handoff", "checkpoint"])
  expect(SLASH_ACTION_SKILLS.every(slashActionSkill)).toBe(true)
  expect(slashActionSkill("review")).toBe(false)
})

test("blurbs are one sentence in sentence case and subjects are readable labels", () => {
  expect(slashBlurb("summarize the conversation so far to free up context")).toBe(
    "Summarize the conversation so far to free up context",
  )
  expect(slashBlurb("Find, rank and read the literature on a question; related work. Then more.")).toBe(
    "Find, rank and read the literature on a question; related work",
  )
  expect(slashBlurb("x".repeat(200), 20)).toHaveLength(20)
  expect(slashBlurb(undefined)).toBe("")
  expect(slashSubject("ml-training")).toBe("ML training")
  expect(slashSubject("cloud-compute")).toBe("Cloud compute")
  expect(slashSubject(undefined)).toBe("Other")
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
