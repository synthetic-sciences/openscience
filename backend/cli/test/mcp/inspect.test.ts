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

  expect(detail.status.status, `${JSON.stringify(detail)}\n${error}`).toBe("connected")
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

test("an in-flight MCP tool request blocks update until its response is settled", async () => {
  await using tmp = await tmpdir()
  const runner = `${tmp.path}/request-quiescence.ts`
  const ready = `${tmp.path}/request-ready`
  const release = `${tmp.path}/request-release`
  const server = new URL("../fixture/mcp-capabilities.mjs", import.meta.url).pathname

  await Bun.write(
    `${tmp.path}/openscience.json`,
    JSON.stringify({
      mcp: {
        blocking: {
          type: "local",
          command: [process.execPath, server],
          environment: {
            OPENSCIENCE_MCP_REQUEST_READY: ready,
            OPENSCIENCE_MCP_REQUEST_RELEASE: release,
          },
        },
      },
    }),
  )

  await Bun.write(
    runner,
    `
import fs from "node:fs/promises"
import { MCP } from ${JSON.stringify(new URL("../../src/mcp/index.ts", import.meta.url).href)}
import { Instance } from ${JSON.stringify(new URL("../../src/project/instance.ts", import.meta.url).href)}
import { ProjectTrust } from ${JSON.stringify(new URL("../../src/project/trust.ts", import.meta.url).href)}
import { UpdateQuiescence } from ${JSON.stringify(new URL("../../src/process/update-quiescence.ts", import.meta.url).href)}

async function waitFor(check, label) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error(label)
}

const result = await Instance.provide({
  directory: process.argv[2],
  fn: async () => {
    const trust = await ProjectTrust.status(Instance.project)
    await ProjectTrust.update(Instance.project, { trusted: true, root: trust.root })
    const tools = await MCP.tools()
    const execute = tools.blocking_echo?.execute
    if (!execute) throw new Error("Missing MCP echo tool")
    const pending = execute({}, { toolCallId: "request-quiescence", messages: [] })
    await waitFor(() => fs.stat(process.argv[3]).then(() => true, () => false), "MCP request did not start")
    const active = UpdateQuiescence.active("mcp")
    let blocked = false
    try { UpdateQuiescence.begin() } catch { blocked = true }
    await Bun.write(process.argv[4], "release")
    await pending
    await waitFor(() => UpdateQuiescence.active("mcp") === 0, "MCP request admission did not release")
    await MCP.disposeLocal()
    return { active, blocked, settled: UpdateQuiescence.active("mcp") }
  },
})
process.stdout.write(JSON.stringify(result))
process.exit(0)
`,
  )

  const proc = spawn([process.execPath, runner, tmp.path, ready, release], {
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
  expect(JSON.parse(output)).toEqual({ active: 1, blocked: true, settled: 0 })
})

const posixTest = process.platform === "win32" ? test.skip : test

posixTest("local MCP disposal reaps a direct child that starts a new session", async () => {
  await using tmp = await tmpdir()
  const runner = `${tmp.path}/dispose-descendant.ts`
  const marker = `${tmp.path}/mcp-descendant.pid`
  const server = new URL("../fixture/mcp-descendant.mjs", import.meta.url).pathname

  await Bun.write(
    `${tmp.path}/openscience.json`,
    JSON.stringify({
      mcp: {
        descendant: {
          type: "local",
          command: [process.execPath, server],
          environment: { OPENSCIENCE_MCP_DESCENDANT_MARKER: marker },
        },
      },
    }),
  )

  await Bun.write(
    runner,
    `
import fs from "node:fs/promises"
import { MCP } from ${JSON.stringify(new URL("../../src/mcp/index.ts", import.meta.url).href)}
import { CredentialProcessLedger } from ${JSON.stringify(new URL("../../src/credentials/process-ledger.ts", import.meta.url).href)}
import { Instance } from ${JSON.stringify(new URL("../../src/project/instance.ts", import.meta.url).href)}
import { ProjectTrust } from ${JSON.stringify(new URL("../../src/project/trust.ts", import.meta.url).href)}

const result = await Instance.provide({
  directory: process.argv[2],
  fn: async () => {
    const trust = await ProjectTrust.status(Instance.project)
    await ProjectTrust.update(Instance.project, { trusted: true, root: trust.root })
    const detail = await MCP.inspect("descendant")
    if (detail.status.status !== "connected") throw new Error(JSON.stringify(detail))
    let reportedPID = 0
    for (let attempt = 0; attempt < 200; attempt++) {
      reportedPID = Number((await fs.readFile(process.argv[3], "utf8").catch(() => "0")).trim())
      if (reportedPID) break
      await Bun.sleep(10)
    }
    if (!reportedPID) throw new Error("MCP descendant did not report its PID")
    const entries = await Bun.file(CredentialProcessLedger.pathForTests()).json()
    const entry = entries.find((item) => item.kind === "mcp" && item.project_id === Instance.project.id)
    if (!entry) throw new Error("Missing durable MCP process entry")
    const pid = process.platform === "linux"
      ? await CredentialProcessLedger.resolveLinuxNamespacePID({
          leaderPID: entry.pid,
          leaderIdentity: entry.identity,
          namespacePID: reportedPID,
        })
      : reportedPID
    if (!pid) throw new Error("Could not resolve MCP sandbox descendant PID")
    const identity = await CredentialProcessLedger.identity(pid)
    if (!identity) throw new Error("MCP descendant had no process identity")
    await MCP.disposeLocal()
    const survived = await CredentialProcessLedger.owns(pid, identity)
    if (survived) process.kill(pid, "SIGKILL")
    return { pid, survived }
  },
})
process.stdout.write(JSON.stringify(result))
process.exit(0)
`,
  )

  const proc = spawn([process.execPath, runner, tmp.path, marker], {
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
  expect(JSON.parse(output)).toMatchObject({ pid: expect.any(Number), survived: false })
})
