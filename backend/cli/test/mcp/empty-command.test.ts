import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { spawn } from "../fixture/spawn"

test("a local MCP server with an empty command fails alone and the rest of the config loads", async () => {
  await using tmp = await tmpdir()
  const runner = `${tmp.path}/empty-command.ts`
  const server = new URL("../fixture/mcp-capabilities.mjs", import.meta.url).pathname

  await Bun.write(
    `${tmp.path}/openscience.json`,
    JSON.stringify({
      mcp: {
        good: { type: "local", command: [process.execPath, server] },
        empty: { type: "local", command: [] },
        blank: { type: "local", command: [""] },
        spaces: { type: "local", command: ["  ", process.execPath, server] },
      },
    }),
  )

  await Bun.write(
    runner,
    `
import { Config } from ${JSON.stringify(new URL("../../src/config/config.ts", import.meta.url).href)}
import { MCP } from ${JSON.stringify(new URL("../../src/mcp/index.ts", import.meta.url).href)}
import { Instance } from ${JSON.stringify(new URL("../../src/project/instance.ts", import.meta.url).href)}
import { ProjectTrust } from ${JSON.stringify(new URL("../../src/project/trust.ts", import.meta.url).href)}

const result = await Instance.provide({
  directory: process.argv[2],
  fn: async () => {
    const trust = await ProjectTrust.status(Instance.project)
    await ProjectTrust.update(Instance.project, { trusted: true, root: trust.root })
    const config = await Config.get()
    return { keys: Object.keys(config.mcp ?? {}).sort(), status: await MCP.status() }
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
  const result = JSON.parse(output)

  expect(result.keys).toEqual(["blank", "empty", "good", "spaces"])
  expect(result.status.good, `${output}\n${error}`).toEqual({ status: "connected" })
  for (const name of ["empty", "blank", "spaces"]) {
    // The guard's own message, not a launch error, shows nothing was spawned.
    expect(result.status[name]).toEqual({
      status: "failed",
      error: `Local MCP server "${name}" has an empty \`command\`. Set it to the program and its arguments, for example ["npx", "-y", "my-mcp-server"].`,
    })
  }
})
