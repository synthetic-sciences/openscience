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

test("catalog metadata describes capabilities without imposing a loading budget", () => {
  expect(SkillCatalog.entries.filter((entry) => entry.role === "workflow").map((entry) => entry.name)).toEqual([
    "protein-binder-design",
    "literature-review",
  ])
  expect(SkillCatalog.entries.filter((entry) => entry.role === "support").length).toBeGreaterThan(2)
  expect(SkillCatalog.get("protein-binder-design")?.requirements).toEqual({ all: [], any: [] })
  expect(SkillCatalog.get("modal")?.status).toBe("blocked")
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
