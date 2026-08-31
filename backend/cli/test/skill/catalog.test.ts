import { expect, test } from "bun:test"
import path from "path"
import { Skill } from "../../src/skill"
import { SkillTool } from "../../src/tool/skill"
import { Instance } from "../../src/project/instance"
import { ProjectTrust } from "../../src/project/trust"
import { tmpdir } from "../fixture/fixture"
import type { Agent } from "../../src/agent/agent"
import type { Tool } from "../../src/tool/tool"
import { ComputeCapabilities } from "../../src/compute/capabilities"
import { SkillCatalog } from "../../src/skill/catalog"
import { BioNemoWorkflow } from "../../src/skill/workflows/bionemo"
import { Config } from "../../src/config/config"
import { GlobalBus } from "../../src/bus/global"

async function trust() {
  const status = await ProjectTrust.status(Instance.project)
  await ProjectTrust.update(Instance.project, { trusted: true, root: status.root })
}

async function writeSkill(dir: string, name: string) {
  await Bun.write(
    path.join(dir, ".openscience", "skill", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} workflow\ncategory: research\n---\n\n# ${name}\n`,
  )
}

test("one permission snapshot governs discovery and exact Skill tool loads", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await writeSkill(dir, "public-analysis")
      await writeSkill(dir, "private-analysis")
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      const permission = [{ permission: "skill", pattern: "private-analysis", action: "deny" as const }]
      const snapshot = await Skill.catalog(permission)

      expect(await Skill.catalog(permission)).toBe(snapshot)
      expect(Object.fromEntries(snapshot.library.map((skill) => [skill.name, skill.permission_action]))).toEqual({
        "private-analysis": "deny",
        "public-analysis": "ask",
      })
      expect(snapshot.allowed.map((skill) => skill.name)).toEqual(["public-analysis"])

      const agent = {
        name: "research",
        mode: "primary",
        permission,
        options: {},
      } satisfies Agent.Info
      const tool = await SkillTool.init({ agent })
      const context = {
        sessionID: "session_skill_catalog",
        messageID: "message_skill_catalog",
        callID: "call_skill_catalog",
        agent: "research",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => {},
        ask: async () => {},
      } satisfies Tool.Context

      await expect(tool.execute({ name: "private-analysis" }, context)).rejects.toThrow(
        'Skill "private-analysis" not found',
      )
      const search = await tool.execute({ query: "private analysis" }, context)
      expect(JSON.stringify(search)).not.toContain("private-analysis")
      expect(JSON.stringify(search)).toContain("public-analysis")
      await expect(tool.execute({ name: "public-analysis" }, context)).resolves.toMatchObject({
        metadata: { name: "public-analysis" },
      })
    },
  })
})

test("curated catalog pins upstream sources without installing them", () => {
  const bionemo = SkillCatalog.get("protein-binder-design")
  expect(bionemo?.upstream?.sha).toBe("0e67a612e4045f007e38fa77adc8f3ebfc5616b6")
  expect(bionemo?.status).toBe("experimental")
  expect(SkillCatalog.resolve("bionemo-agent-toolkit")).toBe("protein-binder-design")
  expect(SkillCatalog.get("modal")?.replaced_by).toBe("compute_job")
})

test("active selection is enforced without replacing ask or deny permissions", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await writeSkill(dir, "selectable-analysis")
      await writeSkill(dir, "restricted-analysis")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      const permission = [
        { permission: "skill", pattern: "*", action: "ask" as const },
        { permission: "skill", pattern: "restricted-analysis", action: "deny" as const },
      ]
      const tool = await SkillTool.init({ agent: { name: "research", mode: "primary", options: {}, permission } })
      const requested: string[] = []
      const context = {
        sessionID: "session_skill_selection",
        messageID: "message_skill_selection",
        callID: "call_skill_selection",
        agent: "research",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => {},
        ask: async (request) => {
          requested.push(...request.patterns)
        },
      } satisfies Tool.Context
      await Config.update({ skills: { disabled: ["selectable-analysis"] } })
      const off = await Skill.catalog(permission)
      expect(off.library.find((skill) => skill.name === "selectable-analysis")).toMatchObject({
        enabled: false,
        permission_action: "ask",
      })
      expect(off.allowed).toEqual([])
      expect(await Skill.get("selectable-analysis")).toBeUndefined()
      expect((await Skill.get("selectable-analysis", { includeDisabled: true }))?.name).toBe("selectable-analysis")
      expect((await Skill.all({ includeDisabled: true })).map((skill) => skill.name)).toContain("selectable-analysis")
      expect((await Skill.all()).map((skill) => skill.name)).not.toContain("selectable-analysis")
      await expect(tool.execute({ name: "selectable-analysis" }, context)).rejects.toThrow("not found")
      await expect(tool.execute({ query: "selectable" }, context)).rejects.toThrow("No skills matched")
      expect(requested).toEqual([])

      await Config.update({ skills: { disabled: [] } })
      const active = await Skill.catalog(permission)
      expect(active.allowed.map((skill) => skill.name)).toEqual(["selectable-analysis"])
      expect(active.library.find((skill) => skill.name === "restricted-analysis")).toMatchObject({
        enabled: true,
        permission_action: "deny",
      })
      await tool.execute({ name: "selectable-analysis" }, context)
      expect(requested).toEqual(["selectable-analysis"])
      await expect(tool.execute({ name: "restricted-analysis" }, context)).rejects.toThrow("not found")
      const entered = Promise.withResolvers<void>()
      const approval = Promise.withResolvers<void>()
      const waiting = tool.execute(
        { name: "selectable-analysis" },
        {
          ...context,
          ask: async () => {
            entered.resolve()
            await approval.promise
          },
        },
      )
      await entered.promise
      await Config.update({ skills: { disabled: ["selectable-analysis"] } })
      approval.resolve()
      await expect(waiting).rejects.toThrow("no longer active")
      expect(
        await Bun.file(path.join(tmp.path, ".openscience", "skill", "selectable-analysis", "SKILL.md")).exists(),
      ).toBe(true)
    },
  })
})

test("catalog metadata describes capabilities without imposing a loading budget", () => {
  expect(SkillCatalog.entries.filter((entry) => entry.role === "workflow").map((entry) => entry.name)).toEqual([
    "protein-binder-design",
    "literature-review",
  ])
  expect(SkillCatalog.entries.filter((entry) => entry.role === "support").length).toBeGreaterThan(2)
  expect(SkillCatalog.get("protein-binder-design")?.requirements).toEqual({ all: [], any: [] })
  expect(SkillCatalog.get("modal")?.status).toBe("blocked")
})

test("project configuration cannot silently reactivate a server-wide disabled skill", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await writeSkill(dir, "server-selected-analysis")
      await Bun.write(path.join(dir, "openscience.json"), JSON.stringify({ skills: { disabled: [] } }))
    },
  })
  try {
    await Config.updateGlobal({ skills: { disabled: ["server-selected-analysis"] } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trust()
        expect((await Skill.catalog([])).library[0]).toMatchObject({
          name: "server-selected-analysis",
          enabled: false,
          disabled_by: "server",
        })
        expect(await Skill.get("server-selected-analysis")).toBeUndefined()
      },
    })
  } finally {
    await Config.unsetGlobal(["skills"])
  }
})

test("changing selection refreshes live catalogs without disposing active project state", async () => {
  await using tmp = await tmpdir({ git: true, init: async (dir) => writeSkill(dir, "live-selection-analysis") })
  const disposed: string[] = []
  const events: string[] = []
  const listener = (event: { payload: { type: string } }) => events.push(event.payload.type)
  GlobalBus.on("event", listener)
  const sentinel = Instance.state(
    () => ({ value: "active research and terminal" }),
    async () => {
      disposed.push("disposed")
    },
  )
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trust()
        const before = sentinel()
        expect((await Skill.catalog([])).allowed.map((skill) => skill.name)).toContain("live-selection-analysis")
        await Config.updateGlobal({ skills: { disabled: ["live-selection-analysis"] } })
        expect(sentinel()).toBe(before)
        expect(disposed).toEqual([])
        expect((await Skill.catalog([])).allowed).toEqual([])
        expect(events).toContain("skill.updated")
        await Config.updateGlobal({ skills: { paths: [] } })
        expect(disposed).toEqual(["disposed"])
      },
    })
  } finally {
    GlobalBus.off("event", listener)
    await Config.unsetGlobal(["skills"])
  }
})

test("BioNeMo planner chooses hosted NIM honestly and blocks unsupported NGC pulls", () => {
  const hosted = ComputeCapabilities.describe({ modal: true, hosts: [], secrets: ["nvidia_nim"] })
  expect(BioNemoWorkflow.plan({ targets: hosted, gpu_memory_gb: 80 }).route).toBe("hosted_nim")

  const ngc = ComputeCapabilities.describe({ modal: true, hosts: [], secrets: ["nvidia_ngc"] })
  const blocked = BioNemoWorkflow.plan({ targets: ngc, gpu_memory_gb: 80 })
  expect(blocked.route).toBe("blocked")
  expect(blocked.missing).toContain("reviewed private-registry image adapter")

  const absent = ComputeCapabilities.describe({ modal: true, hosts: [], secrets: [] })
  expect(BioNemoWorkflow.plan({ targets: absent }).missing).toContain("NVIDIA hosted API key or NGC registry key")
})
