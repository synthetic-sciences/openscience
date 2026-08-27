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
      await writeSkill(dir, "ML-Drawing", "visualization")
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      const known = await SystemPrompt.availableSkills([], "/scanpy run qc")
      const upper = await SystemPrompt.availableSkills([], "/SCANPY")
      const inline = await SystemPrompt.availableSkills([], "Please use /scanpy before plotting")
      const punctuated = await SystemPrompt.availableSkills([], "Please plot this (/scanpy when useful)")
      const closed = await SystemPrompt.availableSkills([], "Please plot this (/scanpy), then answer")
      const quoted = await SystemPrompt.availableSkills([], 'Please use "/scanpy", then answer')
      const canonical = await SystemPrompt.availableSkills([], "Explain this with /ml-drawing, please")
      const path = await SystemPrompt.availableSkills([], "Read /scanpy/reference without loading a skill")
      const unknown = await SystemPrompt.availableSkills([], "/not-a-skill")
      expect(Buffer.byteLength(known)).toBeLessThanOrEqual(700)
      expect(known).toContain("<slash-skill-invocation>")
      expect(known).toContain('skill({name:"scanpy"})')
      expect(known).toContain("complete requested workflow scope")
      expect(known).not.toContain("<skill-routing>")
      expect(known).not.toContain("Likely matches for this request")
      expect(upper).toContain('skill({name:"scanpy"})')
      expect(inline).toContain('skill({name:"scanpy"})')
      expect(punctuated).toContain('skill({name:"scanpy"})')
      expect(closed).toContain('skill({name:"scanpy"})')
      expect(quoted).toContain('skill({name:"scanpy"})')
      expect(canonical).toContain('skill({name:"ML-Drawing"})')
      expect(path).not.toContain("slash-skill-invocation")
      expect(unknown).not.toContain("slash-skill-invocation")
    },
  })
})

test("availableSkills never restores retired Atlas or graph slash commands from local copies", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await writeSkill(dir, "initialize-atlas-graph", "research")
      await writeSkill(dir, "initialize-research-graph", "research")
      await writeSkill(dir, "atlas", "research")
      await writeSkill(dir, "atlas-lab", "research")
      await writeSkill(dir, "initialize-research-graphs", "research")
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      const atlas = await SystemPrompt.availableSkills([], "/initialize-atlas-graph")
      const research = await SystemPrompt.availableSkills([], "/initialize-research-graph")
      const atlasLab = await SystemPrompt.availableSkills([], "/atlas-lab")
      const similar = await SystemPrompt.availableSkills([], "/initialize-research-graphs")
      expect(atlas).not.toContain("slash-skill-invocation")
      expect(research).not.toContain("slash-skill-invocation")
      expect(atlasLab).not.toContain("slash-skill-invocation")
      expect(similar).toContain('skill({name:"initialize-research-graphs"})')
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
