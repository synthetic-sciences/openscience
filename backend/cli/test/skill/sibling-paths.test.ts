import { expect, test } from "bun:test"
import path from "node:path"
import { Skill } from "../../src/skill"
import { SkillTool } from "../../src/tool/skill"
import type { Tool } from "../../src/tool/tool"
import { Instance } from "../../src/project/instance"
import { ProjectTrust } from "../../src/project/trust"
import { tmpdir } from "../fixture/fixture"

const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} fixture\n---\n\n${body}\n`

const body = [
  "Generate the figure first:",
  "",
  "```bash",
  "python skills/visualization/scientific-schematics/scripts/generate_schematic.py --out figure.png",
  "python skills/generate-image/scripts/generate_image.py --prompt 'poster'",
  "cp skills/venue-templates/assets/template.tex .",
  "```",
  "",
  "Unknown skills stay put: skills/not-a-skill/scripts/run.py and ~/.claude/skills/generate-image/scripts/x.py.",
  "See https://huggingface.co/datasets/mcp-tools/skills/raw/main/inspect.py for the upstream copy.",
].join("\n")

async function trust() {
  const status = await ProjectTrust.status(Instance.project)
  await ProjectTrust.update(Instance.project, { trusted: true, root: status.root })
}

const context: Tool.Context = {
  sessionID: "session_skill_sibling_paths",
  messageID: "message_skill_sibling_paths",
  agent: "research",
  abort: new AbortController().signal,
  messages: [],
  metadata() {},
  async ask() {},
}

test("loaded instructions point source-tree skill paths at the sibling's real directory", async () => {
  await using library = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "writing/venue-templates/SKILL.md"), skill("venue-templates", body))
      await Bun.write(
        path.join(dir, "visualization/scientific-schematics/SKILL.md"),
        skill("scientific-schematics", "Draw schematics."),
      )
      await Bun.write(path.join(dir, "llm-tools/generate-image/SKILL.md"), skill("generate-image", "Render images."))
    },
  })
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "openscience.json"), JSON.stringify({ skills: { paths: [library.path] } }))
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      const tool = await SkillTool.init()
      const result = await tool.execute({ name: "venue-templates" }, context)
      const output = result.output
      expect(output).toContain(
        `python ${path.join(library.path, "visualization/scientific-schematics/scripts/generate_schematic.py")} --out`,
      )
      expect(output).toContain(
        `python ${path.join(library.path, "llm-tools/generate-image/scripts/generate_image.py")}`,
      )
      expect(output).toContain(`cp ${path.join(library.path, "writing/venue-templates/assets/template.tex")} .`)
      expect(output).not.toContain("skills/visualization/")
      expect(output).not.toContain("python skills/")
      expect(output).toContain("skills/not-a-skill/scripts/run.py")
      expect(output).toContain("~/.claude/skills/generate-image/scripts/x.py")
      expect(output).toContain("https://huggingface.co/datasets/mcp-tools/skills/raw/main/inspect.py")
    },
  })
})

test("a skill from another origin cannot capture a reference", async () => {
  const reference = "python skills/generate-image/scripts/generate_image.py"
  await using home = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".claude/skills/generate-image/SKILL.md"),
        skill("generate-image", "Installed for the whole account."),
      )
    },
  })
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, ".openscience/skills/venue-templates/SKILL.md"),
        skill("venue-templates", reference),
      )
    },
  })
  const originalHome = process.env.OPENSCIENCE_TEST_HOME
  process.env.OPENSCIENCE_TEST_HOME = home.path
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trust()
        expect((await Skill.get("generate-image"))?.origin).toBe("installed")
        const tool = await SkillTool.init()
        const result = await tool.execute({ name: "venue-templates" }, context)
        expect(result.output).toContain(reference)
        expect(result.output).not.toContain(home.path)
      },
    })
  } finally {
    if (originalHome === undefined) delete process.env.OPENSCIENCE_TEST_HOME
    else process.env.OPENSCIENCE_TEST_HOME = originalHome
  }
})
