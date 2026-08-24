import { expect, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { ToolRegistry } from "../../src/tool/registry"
import { tmpdir } from "../fixture/fixture"

const root = new URL("../../src/", import.meta.url)
const read = (file: string) => Bun.file(new URL(file, root)).text()

test("reviewer agents, writable tools, launch routes, and settings are absent", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      for (const name of ["review", "reviewer", "artifact-reviewer"]) {
        expect(await Agent.get(name)).toBeUndefined()
      }
      const tools = await ToolRegistry.ids()
      expect(tools).not.toContain("artifact_snapshot")
      expect(tools).not.toContain("provenance_review")
      expect(tools).not.toContain("provenance_resolve")
    },
  })

  const [sessionRoutes, server, provenanceTools, fileRoutes, reviewWorkflow] = await Promise.all([
    read("server/routes/session.ts"),
    read("server/server.ts"),
    read("tool/provenance.ts"),
    read("server/routes/file.ts"),
    read("../skills/research/research-workflows/references/review.md"),
  ])
  expect(sessionRoutes).not.toContain("/:sessionID/review")
  expect(server).not.toContain("/settings/review")
  expect(provenanceTools).not.toContain('Tool.define("provenance_review"')
  expect(provenanceTools).not.toContain('Tool.define("provenance_resolve"')
  expect(fileRoutes).toContain('"/file/reviews"')
  expect(reviewWorkflow).toContain("`provenance_record`")
  expect(reviewWorkflow).not.toContain("`provenance_review`")

  for (const file of [
    "agent/prompt/reviewer.txt",
    "server/routes/settings/review.ts",
    "session/review.ts",
    "settings/review.ts",
    "tool/artifact-snapshot.ts",
  ]) {
    expect(await Bun.file(new URL(file, root)).exists()).toBe(false)
  }
})
