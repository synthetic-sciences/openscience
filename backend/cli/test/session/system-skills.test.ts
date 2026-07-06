import { test, expect } from "bun:test"
import { SystemPrompt } from "../../src/session/system"
import { Instance } from "../../src/project/instance"
import { PermissionNext } from "../../src/permission/next"
import { tmpdir } from "../fixture/fixture"
import path from "path"

async function writeSkill(dir: string, name: string, description: string, category?: string) {
  const skillDir = path.join(dir, ".openscience", "skill", name)
  await Bun.write(
    path.join(skillDir, "SKILL.md"),
    `---
name: ${name}
description: ${description}
${category ? `category: ${category}\n` : ""}---

# ${name}
`,
  )
}

test("skills() lists only loaded skills, not desynced routing-table entries", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      // A skill that is actually installed...
      await writeSkill(dir, "scanpy", "Single-cell RNA-seq analysis with scanpy.", "biology")
      // ...but NOT `peft`, which the static ml Skill Routing Table advertises.
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const [section] = await SystemPrompt.skills({ permission: [] })
      expect(section).toContain("scanpy")
      // The old routing table references `peft`; it is not loaded, so it must
      // not appear in the runtime availability list.
      expect(section).not.toContain("peft")
      expect(section).toContain("<available-skills>")
      expect(section).toContain("### biology")
    },
  })
})

test("skills() excludes skills denied by the agent permission", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await writeSkill(dir, "scanpy", "Single-cell RNA-seq analysis.", "biology")
      await writeSkill(dir, "secret-skill", "Should be hidden by permission.", "biology")
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const permission: PermissionNext.Ruleset = [{ permission: "skill", pattern: "secret-skill", action: "deny" }]
      const [section] = await SystemPrompt.skills({ permission })
      expect(section).toContain("scanpy")
      expect(section).not.toContain("secret-skill")
    },
  })
})

test("skills() tells the model not to route when no skills are loaded", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const [section] = await SystemPrompt.skills({ permission: [] })
      expect(section).toContain("No skills are currently loaded")
      expect(section).toContain("do NOT call the skill")
    },
  })
})
