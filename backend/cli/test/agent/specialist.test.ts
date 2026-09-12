import { describe, expect, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Specialist } from "../../src/agent/specialist"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { ToolRegistry } from "../../src/tool/registry"
import { tmpdir, trustProject } from "../fixture/fixture"

async function writeSkill(dir: string, name: string, category: string) {
  await Bun.write(
    path.join(dir, ".openscience", "skill", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} for ${category}. Second sentence.\ncategory: ${category}\n---\n\n# ${name}\n`,
  )
}

describe("specialists", () => {
  test("a specialist worker gets its domain contract, its category index, and its tools", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await writeSkill(dir, "scanpy", "biology")
        await writeSkill(dir, "uniprot-database", "databases")
        await writeSkill(dir, "pytorch-lightning", "ml-training")
        await writeSkill(dir, "modal-serverless-gpu", "cloud-compute")
        await writeSkill(dir, "rdkit", "chemistry")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const research = (await Agent.get("research"))!
        const biology = await Specialist.guidance("biology", research.permission)
        expect(biology).toContain("You are the Biology specialist")
        expect(biology).not.toContain("<system-reminder>")
        expect(biology).toContain("<domain-skills>")
        expect(biology).toContain("biology:")
        expect(biology).toContain("- scanpy: scanpy for biology.")
        expect(biology).not.toContain("Second sentence")
        expect(biology).toContain("databases:")
        expect(biology).toContain("- uniprot-database:")
        expect(biology).not.toContain("- pytorch-lightning:")
        expect(Specialist.tools("biology")).toMatchObject({ query_uniprot: true, query_pubmed: true })

        const ml = await Specialist.guidance("ml", research.permission)
        expect(ml).toContain("You are the ML specialist")
        expect(ml).toContain("ml-training:")
        expect(ml).toContain("cloud-compute:")
        expect(ml).not.toContain("- scanpy:")

        const chemistry = await Specialist.guidance("chemistry", research.permission)
        expect(chemistry).toContain("Chemistry specialist")
        expect(chemistry).toContain("- rdkit:")

        // The reviewer keeps the critique contract and loses every mutating tool.
        const critique = await Specialist.guidance("critique", research.permission)
        expect(critique).toContain("BLOCKING")
        expect(critique).not.toContain("<domain-skills>")
        expect(Specialist.tools("critique")).toMatchObject({
          write: false,
          edit: false,
          bash: false,
          compute_job: false,
        })
        expect((await Agent.get("chemistry"))?.mode).toBe("subagent")
      },
    })
  })

  test("biology database tools reach the lead only when a skill or setting unlocked them", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const research = (await Agent.get("research"))!
        const model = { providerID: "openai-codex", modelID: "gpt-5.6-codex" }
        const closed = (await ToolRegistry.tools(model, research)).map((tool) => tool.id)
        expect(closed).not.toContain("query_uniprot")
        const open = (
          await ToolRegistry.tools(model, research, () => true, undefined, new Set(["query_uniprot", "query_pdb"]))
        ).map((tool) => tool.id)
        expect(open).toContain("query_uniprot")
        expect(open).toContain("query_pdb")
        expect(open).not.toContain("query_kegg")
        const biology = (await Agent.get("biology"))!
        expect((await ToolRegistry.tools(model, biology)).map((tool) => tool.id)).toContain("query_kegg")
      },
    })
  })
})
