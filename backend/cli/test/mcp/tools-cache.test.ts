import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import { tmpdir } from "../fixture/fixture"
import { spawn } from "../fixture/spawn"

test("repeated tool resolution reuses a real MCP server tool list", async () => {
  await using tmp = await tmpdir()
  const runner = `${tmp.path}/tools-cache.ts`
  const marker = `${tmp.path}/list-calls.txt`
  const server = new URL("../fixture/mcp-tool-cache.mjs", import.meta.url).pathname

  await Bun.write(
    `${tmp.path}/openscience.json`,
    JSON.stringify({
      mcp: {
        cache: {
          type: "local",
          command: [process.execPath, server],
          environment: { OPENSCIENCE_MCP_LIST_MARKER: marker },
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

const result = await Instance.provide({
  directory: process.argv[2],
  fn: async () => {
    const trust = await ProjectTrust.status(Instance.project)
    await ProjectTrust.update(Instance.project, { trusted: true, root: trust.root })
    const first = Object.keys(await MCP.tools())
    const second = Object.keys(await MCP.tools())
    await MCP.disposeLocal()
    return { first, second }
  },
})
process.stdout.write(JSON.stringify(result))
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
  expect(JSON.parse(output)).toEqual({ first: ["cache_echo"], second: ["cache_echo"] })
  expect((await fs.readFile(marker, "utf8")).trim().split("\n")).toHaveLength(1)
})
