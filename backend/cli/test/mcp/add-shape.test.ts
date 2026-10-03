import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { spawn } from "../fixture/spawn"

test("MCP.add returns the status map keyed by server name on every path", async () => {
  await using tmp = await tmpdir()
  const runner = `${tmp.path}/add-shape.ts`

  await Bun.write(`${tmp.path}/openscience.json`, JSON.stringify({ mcp: {} }))

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
    const empty = await MCP.add("empty", { type: "local", command: [] })
    const disabled = await MCP.add("off", { type: "local", command: ["x"], enabled: false })
    return { empty: empty.status, disabled: disabled.status }
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

  for (const [label, status] of Object.entries(result) as Array<[string, Record<string, unknown>]>) {
    // A single Status returned here would put the status under `status.status`.
    expect(status.status, `${label}: ${output}\n${error}`).toBeUndefined()
  }

  expect(result.empty.empty).toEqual({
    status: "failed",
    error:
      'Local MCP server "empty" has an empty `command`. Set it to the program and its arguments, for example ["npx", "-y", "my-mcp-server"].',
  })
  expect(result.disabled.off).toEqual({ status: "disabled" })
})
