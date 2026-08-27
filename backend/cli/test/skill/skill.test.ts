import { test, expect } from "bun:test"
import { Skill } from "../../src/skill"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import fs from "fs/promises"
import { ConfigMarkdown } from "../../src/config/markdown"
import { ProjectTrust } from "../../src/project/trust"
import { SkillTool } from "../../src/tool/skill"
import type { Tool } from "../../src/tool/tool"

async function trust() {
  const status = await ProjectTrust.status(Instance.project)
  await ProjectTrust.update(Instance.project, {
    trusted: true,
    root: status.root,
  })
}

async function createGlobalSkill(homeDir: string) {
  const skillDir = path.join(homeDir, ".claude", "skills", "global-test-skill")
  await fs.mkdir(skillDir, { recursive: true })
  await Bun.write(
    path.join(skillDir, "SKILL.md"),
    `---
name: global-test-skill
description: A global skill from ~/.claude/skills for testing.
---

# Global Test Skill

This skill is loaded from the global home directory.
`,
  )
}

test("discovers skills from .openscience/skill/ directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".openscience", "skill", "test-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: test-skill
description: A test skill for verification.
---

# Test Skill

Instructions here.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      const skills = await Skill.all()
      expect(skills.length).toBe(1)
      const testSkill = skills.find((s) => s.name === "test-skill")
      expect(testSkill).toBeDefined()
      expect(testSkill!.description).toBe("A test skill for verification.")
      expect(testSkill!.location).toContain("skill/test-skill/SKILL.md")
    },
  })
})

test("normalizes allowed-tools without granting execution authority", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".openscience", "skill", "figure-skill", "SKILL.md"),
        `---
name: figure-skill
description: Create a requested technical figure.
allowed-tools: [Read, generate-image, generate_image, Bash]
---

# Figure skill
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      expect((await Skill.get("figure-skill"))?.allowed_tools).toEqual(["read", "generate_image", "bash"])
      const tool = await SkillTool.init()
      const result = await tool.execute({ name: "figure-skill" }, {
        sessionID: "session_skill_allowed_tools",
        messageID: "message_skill_allowed_tools",
        callID: "call_skill_allowed_tools",
        agent: "research",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => {},
        ask: async () => {},
      } satisfies Tool.Context)
      expect((result.metadata as { allowedTools?: string[] }).allowedTools).toEqual(["read", "generate_image", "bash"])
    },
  })
})

test("discovers multiple skills from .openscience/skill/ directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir1 = path.join(dir, ".openscience", "skill", "skill-one")
      const skillDir2 = path.join(dir, ".openscience", "skill", "skill-two")
      await Bun.write(
        path.join(skillDir1, "SKILL.md"),
        `---
name: skill-one
description: First test skill.
---

# Skill One
`,
      )
      await Bun.write(
        path.join(skillDir2, "SKILL.md"),
        `---
name: skill-two
description: Second test skill.
---

# Skill Two
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      const skills = await Skill.all()
      expect(skills.length).toBe(2)
      expect(skills.find((s) => s.name === "skill-one")).toBeDefined()
      expect(skills.find((s) => s.name === "skill-two")).toBeDefined()
    },
  })
})

test("skips skills with missing frontmatter", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".openscience", "skill", "no-frontmatter")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `# No Frontmatter

Just some content without YAML frontmatter.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      const skills = await Skill.all()
      expect(skills).toEqual([])
    },
  })
})

test("discovers skills from .claude/skills/ directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".claude", "skills", "claude-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      const skills = await Skill.all()
      expect(skills.length).toBe(1)
      const claudeSkill = skills.find((s) => s.name === "claude-skill")
      expect(claudeSkill).toBeDefined()
      expect(claudeSkill!.location).toContain(".claude/skills/claude-skill/SKILL.md")
    },
  })
})

test("discovers global skills from ~/.claude/skills/ directory", async () => {
  await using tmp = await tmpdir({ git: true })

  const originalHome = process.env.OPENSCIENCE_TEST_HOME
  process.env.OPENSCIENCE_TEST_HOME = tmp.path

  try {
    await createGlobalSkill(tmp.path)
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        expect(skills.length).toBe(1)
        expect(skills[0].name).toBe("global-test-skill")
        expect(skills[0].description).toBe("A global skill from ~/.claude/skills for testing.")
        expect(skills[0].location).toContain(".claude/skills/global-test-skill/SKILL.md")
      },
    })
  } finally {
    if (originalHome === undefined) delete process.env.OPENSCIENCE_TEST_HOME
    else process.env.OPENSCIENCE_TEST_HOME = originalHome
  }
})

test("returns empty array when no skills exist", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills).toEqual([])
    },
  })
})

test("retired Atlas and graph skills cannot re-enter through project skill directories", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      for (const name of [
        "atlas",
        "atlas-lab",
        "atlas-survey-cli",
        "initialize-atlas-graph",
        "initialize-research-graph",
        "initialize-research-graphs",
        "atlas-labs",
      ]) {
        await Bun.write(
          path.join(dir, ".openscience", "skill", name, "SKILL.md"),
          `---\nname: ${name}\ndescription: Local ${name} test skill.\n---\n\n# ${name}\n`,
        )
      }
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      expect((await Skill.all()).map((skill) => skill.name).toSorted()).toEqual([
        "atlas-labs",
        "initialize-research-graphs",
      ])
      expect(await Skill.get("atlas")).toBeUndefined()
      expect(await Skill.get("ATLAS-LAB")).toBeUndefined()
      expect(await Skill.get("initialize-atlas-graph")).toBeUndefined()
      expect(await Skill.get("INITIALIZE-RESEARCH-GRAPH")).toBeUndefined()
    },
  })
})

test("removes only global Claude symlinks created by the retired Atlas package", async () => {
  await using tmp = await tmpdir({ git: true })
  const originalHome = process.env.OPENSCIENCE_TEST_HOME
  process.env.OPENSCIENCE_TEST_HOME = tmp.path

  try {
    const packageSkills = path.join(tmp.path, "node_modules", "@synsci", "atlas", "skills")
    for (const name of ["atlas", "atlas-lab"]) {
      const target = path.join(packageSkills, name)
      await Bun.write(path.join(target, "SKILL.md"), `---\nname: ${name}\ndescription: Retired package skill.\n---\n`)
      await fs.mkdir(path.join(tmp.path, ".claude", "skills"), { recursive: true })
      await fs.symlink(target, path.join(tmp.path, ".claude", "skills", name))
    }
    await Bun.write(
      path.join(tmp.path, ".claude", "skills", "atlas-map", "SKILL.md"),
      `---\nname: atlas-map\ndescription: User-owned same-name directory.\n---\n`,
    )
    await Bun.write(
      path.join(tmp.path, ".claude", "skills", "atlas-labs", "SKILL.md"),
      `---\nname: atlas-labs\ndescription: Similar third-party skill.\n---\n`,
    )

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await Skill.all()).map((skill) => skill.name)).toEqual(["atlas-labs"])
      },
    })

    expect(await fs.lstat(path.join(tmp.path, ".claude", "skills", "atlas")).catch(() => undefined)).toBeUndefined()
    expect(await fs.lstat(path.join(tmp.path, ".claude", "skills", "atlas-lab")).catch(() => undefined)).toBeUndefined()
    expect(await Bun.file(path.join(tmp.path, ".claude", "skills", "atlas-map", "SKILL.md")).exists()).toBe(true)
  } finally {
    if (originalHome === undefined) delete process.env.OPENSCIENCE_TEST_HOME
    else process.env.OPENSCIENCE_TEST_HOME = originalHome
  }
})

test("disabled frontmatter keeps a skill out of the catalog without shadowing enabled skills", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".openscience", "skill", "disabled-copy", "SKILL.md"),
        `---
name: shared-skill
description: This higher-priority copy is disabled.
disabled: true
---

# Disabled copy
`,
      )
      await Bun.write(
        path.join(dir, ".claude", "skills", "enabled-copy", "SKILL.md"),
        `---
name: shared-skill
description: This enabled copy remains available.
---

# Enabled copy
`,
      )
      await Bun.write(
        path.join(dir, ".openscience", "skill", "disabled-only", "SKILL.md"),
        `---
name: disabled-only
description: This skill must not be visible.
disabled: true
---

# Disabled only
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      expect(await Skill.get("disabled-only")).toBeUndefined()
      expect(await Skill.all()).toEqual([
        expect.objectContaining({
          name: "shared-skill",
          description: "This enabled copy remains available.",
          origin: "project",
        }),
      ])
    },
  })
})

test("OPENSCIENCE_DISABLED_SKILLS matches trimmed frontmatter and directory names", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skills = [
        ["different-directory", "blocked-by-name"],
        ["blocked-by-directory", "different-name"],
        ["still-enabled", "still-enabled"],
      ]
      await Promise.all(
        skills.map(([directory, name]) =>
          Bun.write(
            path.join(dir, ".openscience", "skill", directory, "SKILL.md"),
            `---
name: ${name}
description: Environment filtering fixture.
---

# ${name}
`,
          ),
        ),
      )
    },
  })

  const original = process.env.OPENSCIENCE_DISABLED_SKILLS
  process.env.OPENSCIENCE_DISABLED_SKILLS = " blocked-by-name, blocked-by-directory, ,"
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trust()
        expect((await Skill.all()).map((skill) => skill.name)).toEqual(["still-enabled"])
        expect(await Skill.get("blocked-by-name")).toBeUndefined()
        expect(await Skill.get("different-name")).toBeUndefined()
      },
    })
  } finally {
    if (original === undefined) delete process.env.OPENSCIENCE_DISABLED_SKILLS
    if (original !== undefined) process.env.OPENSCIENCE_DISABLED_SKILLS = original
  }
})

test("every bundled skill with frontmatter parses into a loadable skill", async () => {
  const root = path.resolve(import.meta.dir, "../../skills")
  const failures: string[] = []

  for await (const relative of new Bun.Glob("**/SKILL.md").scan({ cwd: root })) {
    const file = path.join(root, relative)
    const source = await Bun.file(file).text()
    // Category README files intentionally use the SKILL.md name without
    // declaring a loadable skill.
    if (!source.startsWith("---")) continue

    try {
      const markdown = await ConfigMarkdown.parse(file)
      const parsed = Skill.Info.pick({
        name: true,
        description: true,
        category: true,
        tags: true,
        entry: true,
      }).safeParse(markdown.data)
      if (!parsed.success) failures.push(`${relative}: ${parsed.error.message}`)
    } catch (error) {
      failures.push(`${relative}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  expect(failures).toEqual([])
})
