import { expect, test } from "bun:test"
import path from "path"
import { SystemPrompt } from "../../src/session/system"
import { Instance } from "../../src/project/instance"
import { ProjectTrust } from "../../src/project/trust"
import { Skill } from "../../src/skill"
import { tmpdir } from "../fixture/fixture"

async function trust() {
  const status = await ProjectTrust.status(Instance.project)
  await ProjectTrust.update(Instance.project, {
    trusted: true,
    root: status.root,
  })
}

async function writeSkill(dir: string, name: string, category: string, description = `${name} test skill.`) {
  await Bun.write(
    path.join(dir, ".openscience", "skill", name, "SKILL.md"),
    `---
name: ${name}
description: ${description}
category: ${category}
---

# ${name}
`,
  )
}

test("availableSkills summarizes callable categories without injecting every name", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await writeSkill(dir, "scanpy", "biology")
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      const section = await SystemPrompt.availableSkills([])
      expect(section).toContain("<available-skills>")
      expect(section).toContain("1 skill is callable")
      expect(section).toContain("biology (1)")
      expect(section).not.toContain("- scanpy")
      expect(section).not.toContain("peft")
    },
  })
})

test("availableSkills excludes permission-denied skills", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await writeSkill(dir, "scanpy", "biology")
      await writeSkill(dir, "private-analysis", "biology")
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      const section = await SystemPrompt.availableSkills([
        {
          permission: "skill",
          pattern: "private-analysis",
          action: "deny",
        },
      ])
      expect(section).toContain("1 skill is callable")
      expect(section).toContain("biology (1)")
      expect(section).not.toContain("scanpy")
      expect(section).not.toContain("private-analysis")
    },
  })
})

test("availableSkills injects call-first routing only for a known slash skill", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await writeSkill(dir, "scanpy", "biology")
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      const known = await SystemPrompt.availableSkills([], "/scanpy run qc")
      const upper = await SystemPrompt.availableSkills([], "/SCANPY")
      const unknown = await SystemPrompt.availableSkills([], "/not-a-skill")
      expect(Buffer.byteLength(known)).toBeLessThanOrEqual(700)
      expect(known).toContain("<slash-skill-invocation>")
      expect(known).toContain('skill({name:"scanpy"})')
      expect(upper).toContain('skill({name:"scanpy"})')
      expect(unknown).not.toContain("slash-skill-invocation")
    },
  })
})

test("availableSkills offers a bounded request-relevant shortlist", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await writeSkill(dir, "scanpy", "biology", "Standard single-cell RNA-seq quality-control analysis.")
      await writeSkill(dir, "pysam", "biology", "Read and write sequence alignment files.")
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      const section = await SystemPrompt.availableSkills([], "analyze single-cell RNA-seq quality control")
      expect(section).toContain("Likely matches for this request")
      expect(section).toContain("- scanpy: Standard single-cell")
      expect(section).not.toContain("- pysam:")
      expect(Buffer.byteLength(section)).toBeLessThanOrEqual(1_500)
    },
  })
})

test("availableSkills blocks skill calls when the registry is empty", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const section = await SystemPrompt.availableSkills([])
      expect(section).toContain("No skills are currently available")
      expect(section).toContain("Do not call the skill tool")
    },
  })
})

test("availableSkills cache follows real skill catalog invalidation", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await writeSkill(dir, "scanpy", "biology")
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      const catalog = await Skill.all()
      expect(await Skill.all()).toBe(catalog)
      expect(await SystemPrompt.availableSkills([])).toContain("1 skill is callable")
      await writeSkill(tmp.path, "pysam", "biology")
      await Skill.invalidate()
      expect(await Skill.all()).not.toBe(catalog)
      expect(await SystemPrompt.availableSkills([])).toContain("2 skills are callable")
    },
  })
})

test("availableSkills gives explicit routes for venue and figure work", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await writeSkill(dir, "venue-templates", "writing")
      await writeSkill(dir, "ml-paper-writing", "writing")
      await writeSkill(dir, "scientific-schematics", "visualization")
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      const section = await SystemPrompt.availableSkills([])
      expect(section).toContain("<skill-routing>")
      expect(section).toContain(
        "Venue-specific paper formatting, submission checks, or page limits: venue-templates, ml-paper-writing",
      )
      expect(section).toContain(
        "Technical figures, architectures, workflows, or scientific diagrams: scientific-schematics",
      )
      expect(section).toContain("load the listed skill or skills before the first substantive edit")
    },
  })
})
