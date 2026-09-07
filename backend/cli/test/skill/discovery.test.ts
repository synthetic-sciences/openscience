import { expect, test } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"
import { Skill } from "../../src/skill"
import { SkillTool } from "../../src/tool/skill"
import type { Tool } from "../../src/tool/tool"
import { Instance } from "../../src/project/instance"
import { ProjectTrust } from "../../src/project/trust"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { tmpdir } from "../fixture/fixture"

const content = (name: string, category = "biology", body = "Read references/protocol.md before analysis.") =>
  `---\nname: ${name}\ndescription: ${name} analysis\ncategory: ${category}\ntags: [RNA, QC]\nallowed-tools: [Read]\n---\n\n${body}\n`

async function trust() {
  const status = await ProjectTrust.status(Instance.project)
  await ProjectTrust.update(Instance.project, { trusted: true, root: status.root })
}

function context(sessionID = "session_skill_discovery"): Tool.Context {
  return {
    sessionID,
    messageID: "message_skill_discovery",
    agent: "research",
    abort: new AbortController().signal,
    messages: [],
    metadata() {},
    async ask() {},
  }
}

test("duplicate resolution is stable within a root and the closest project root wins", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      // Write in reverse order so filesystem enumeration cannot define precedence.
      await Bun.write(path.join(dir, ".openscience/skills/z-copy/SKILL.md"), content("shared", "biology", "Z copy"))
      await Bun.write(path.join(dir, ".openscience/skills/a-copy/SKILL.md"), content("shared", "biology", "A copy"))
      await Bun.write(
        path.join(dir, "nested/.openscience/skills/near/SKILL.md"),
        content("shared", "biology", "Nearest copy"),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      for (let index = 0; index < 2; index++) {
        expect((await Skill.get("shared"))?.location).toEndWith("z-copy/SKILL.md")
        await Skill.invalidate()
      }
    },
  })
  await Instance.provide({
    directory: path.join(tmp.path, "nested"),
    fn: async () => {
      await trust()
      expect((await Skill.get("shared"))?.location).toEndWith("near/SKILL.md")
    },
  })
})

test("search respects category and browsing remains bounded with explicit pagination", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      for (let index = 0; index < 43; index++) {
        const name = `biology-${String(index).padStart(2, "0")}`
        await Bun.write(path.join(dir, ".openscience/skills", name, "SKILL.md"), content(name))
      }
      await Bun.write(path.join(dir, ".openscience/skills/chemistry/SKILL.md"), content("chemistry", "chemistry"))
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      const tool = await SkillTool.init()
      const result = await tool.execute({ query: "RNA QC", category: "chemistry" }, context())
      expect(result.metadata.matches).toEqual(["chemistry"])
      expect(result.output).not.toContain("references/protocol.md")
      const first = await tool.execute({ category: "Biology" }, context())
      const next = await tool.execute({ category: "biology", offset: 40 }, context())
      expect(first.metadata.matches).toHaveLength(40)
      expect(next.metadata.matches).toHaveLength(3)
      expect(new Set([...first.metadata.matches, ...next.metadata.matches]).size).toBe(43)
    },
  })
})

test("an unknown name with a query discovers real bundled skills without loading instructions or asking permission", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({ skills: { paths: [path.join(import.meta.dir, "../../skills")] } }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      const tool = await SkillTool.init()
      const requests: string[] = []
      const ctx = {
        ...context(),
        async ask(request) {
          requests.push(...request.patterns)
        },
      } satisfies Tool.Context
      const result = await tool.execute(
        {
          name: "data-visualization",
          query: "exploratory data analysis and publication-quality statistical plots for tabular Titanic dataset",
          category: "visualization",
          offset: 0,
        },
        ctx,
      )
      expect(result.title).toStartWith("Skill matches:")
      expect(result.metadata.matches.slice(0, 3)).toContain("seaborn")
      expect(result.metadata.matches).not.toContain("ray-data")
      expect(result.metadata.dir).toBe("")
      expect(result.metadata).not.toHaveProperty("contentHash")
      expect(result.output).toContain("No skill instructions have been loaded")
      expect(requests).toEqual([])

      const loaded = await tool.execute({ name: "seaborn" }, ctx)
      expect(loaded.title).toBe("Loaded skill: seaborn")
      expect(loaded.metadata).toHaveProperty("contentHash", expect.stringMatching(/^[a-f0-9]{64}$/))
      expect(requests).toEqual(["seaborn"])
      await expect(tool.execute({ name: "data-visualization" }, ctx)).rejects.toThrow(
        'Skill "data-visualization" not found',
      )
      expect(requests).toEqual(["seaborn"])
    },
  })
})

test("an existing exact name wins over conflicting query, category and offset fields", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, ".openscience/skills/exact/SKILL.md"), content("exact-protocol"))
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      const tool = await SkillTool.init()
      const requests: string[] = []
      const result = await tool.execute(
        { name: "exact-protocol", query: "unrelated work", category: "nonexistent", offset: 400 },
        {
          ...context(),
          async ask(request) {
            requests.push(...request.patterns)
          },
        },
      )
      expect(result.title).toBe("Loaded skill: exact-protocol")
      expect(result.metadata.matches).toEqual([])
      expect(requests).toEqual(["exact-protocol"])
    },
  })
})

test("loads current instructions and grants only the selected bundle read access", async () => {
  await using library = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "bundle/SKILL.md"), content("external-protocol"))
      await Bun.write(path.join(dir, "bundle/references/protocol.md"), "Measured procedure")
      await Bun.write(path.join(dir, "sibling/private.txt"), "Unrelated")
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
      const session = await Session.create({})
      const ref = path.join(library.path, "bundle/references/protocol.md")
      expect(await SessionFilesystem.allows({ sessionID: session.id, path: ref, access: "read" })).toBe(false)
      const tool = await SkillTool.init()
      const body = "Updated procedure; read references/protocol.md."
      await Bun.write(path.join(library.path, "bundle/SKILL.md"), content("external-protocol", "biology", body))
      const result = await tool.execute({ name: "external-protocol" }, context(session.id))
      expect(result.output).toContain(body)
      expect(result.metadata).toMatchObject({
        contentHash: createHash("sha256").update(body).digest("hex"),
        allowedTools: ["read"],
      })
      expect(await SessionFilesystem.allows({ sessionID: session.id, path: ref, access: "read" })).toBe(true)
      expect(await SessionFilesystem.allows({ sessionID: session.id, path: ref, access: "write" })).toBe(false)
      expect(
        await SessionFilesystem.allows({
          sessionID: session.id,
          path: path.join(library.path, "sibling/private.txt"),
          access: "read",
        }),
      ).toBe(false)
    },
  })
})

test("rejects a replaced selection during approval and disabled content after discovery", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, ".openscience/skills/a-copy/SKILL.md"), content("mutable-protocol"))
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trust()
      const tool = await SkillTool.init()
      const replacement = path.join(tmp.path, ".openscience/skills/z-copy/SKILL.md")
      await expect(
        tool.execute(
          { name: "mutable-protocol" },
          {
            ...context(),
            ask: async () => {
              await Bun.write(replacement, content("mutable-protocol", "chemistry", "Replacement"))
              await Skill.invalidate()
            },
          },
        ),
      ).rejects.toThrow("changed while awaiting permission")
      await Bun.write(replacement, content("mutable-protocol").replace("category:", "disabled: true\ncategory:"))
      await expect(tool.execute({ name: "mutable-protocol" }, context())).rejects.toThrow("no longer valid")
    },
  })
})
