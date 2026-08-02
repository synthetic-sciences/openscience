import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { spawn } from "../fixture/spawn"

test("inspect reports capabilities from a real local MCP server", async () => {
  await using tmp = await tmpdir()
  const runner = `${tmp.path}/inspect.ts`
  const server = new URL("../fixture/mcp-capabilities.mjs", import.meta.url).pathname

  await Bun.write(
    `${tmp.path}/openscience.json`,
    JSON.stringify({
      mcp: {
        capabilities: {
          type: "local",
          command: [process.execPath, server],
        },
      },
    }),
  )

  await Bun.write(
    runner,
    `
import { MCP } from ${JSON.stringify(new URL("../../src/mcp/index.ts", import.meta.url).href)}
import { Instance } from ${JSON.stringify(new URL("../../src/project/instance.ts", import.meta.url).href)}
import { ProjectTrust } from ${JSON.stringify(new URL("../../src/project/trust.ts", import.meta.url).href)}

const detail = await Instance.provide({
  directory: process.argv[2],
  fn: async () => {
    const trust = await ProjectTrust.status(Instance.project)
    await ProjectTrust.update(Instance.project, { trusted: true, root: trust.root })
    return MCP.inspect("capabilities")
  },
})
process.stdout.write(JSON.stringify(detail))
process.exit(0)
`,
  )

  const proc = spawn([process.execPath, runner, tmp.path], {
    cwd: tmp.path,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [output, error, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(exit, error).toBe(0)
  const detail = JSON.parse(output)

  expect(detail.status.status).toBe("connected")
  expect(detail.auth).toBeUndefined()
  expect(detail.tools).toEqual([{ name: "echo", description: "Echo a value" }])
  expect(detail.resources).toEqual([
    {
      name: "guide",
      uri: "memory://guide",
      description: "Connector guide",
      mimeType: "text/plain",
    },
  ])
  expect(detail.prompts).toEqual([{ name: "review", description: "Review a result" }])
  expect(detail.errors).toEqual({})
})
