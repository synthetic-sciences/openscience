import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Agent } from "../../src/agent/agent"
import { Command } from "../../src/command"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { Instance } from "../../src/project/instance"
import { ProjectTrust } from "../../src/project/trust"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Skill } from "../../src/skill"
import { ToolRegistry } from "../../src/tool/registry"
import { tmpdir } from "../fixture/fixture"

const context = (sessionID: string) => ({
  sessionID,
  messageID: "msg_revocation_cache",
  callID: "call_revocation_cache",
  agent: "research" as const,
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
})

async function waitForFile(file: string, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await Bun.file(file).exists()) return
    await Bun.sleep(25)
  }
  throw new Error(`Timed out waiting for ${file}`)
}

test("trust revocation acknowledges eviction of loaded project commands and tools", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (directory) => {
      const commandMarker = path.join(directory, "command-ran")
      const toolMarker = path.join(directory, "tool-ran")
      const importMarker = path.join(directory, "tool-imported")
      const commandRoot = path.join(directory, ".openscience", "command")
      const toolRoot = path.join(directory, ".openscience", "tool")
      const skillRoot = path.join(directory, ".openscience", "skill", "revocable-skill")
      await fs.mkdir(commandRoot, { recursive: true })
      await fs.mkdir(toolRoot, { recursive: true })
      await fs.mkdir(skillRoot, { recursive: true })
      await Bun.write(
        path.join(directory, "openscience.json"),
        JSON.stringify({
          agent: {
            "revocable-agent": { mode: "subagent", description: "Revocable agent" },
          },
        }),
      )
      await Bun.write(
        path.join(skillRoot, "SKILL.md"),
        ["---", "name: revocable-skill", "description: Revocable skill", "---", "Project instructions"].join("\n"),
      )
      await Bun.write(
        path.join(commandRoot, "revocable.md"),
        ["---", "description: Revocable command", "---", `!\`printf command > ${JSON.stringify(commandMarker)}\``].join(
          "\n",
        ),
      )
      await Bun.write(
        path.join(toolRoot, "revocable.ts"),
        [
          `await Bun.write(${JSON.stringify(importMarker)}, "imported")`,
          "export default {",
          "  description: 'Revocable tool',",
          "  args: {},",
          "  execute: async () => {",
          `    const file = Bun.file(${JSON.stringify(toolMarker)})`,
          `    await Bun.write(${JSON.stringify(toolMarker)}, await file.text().catch(() => "") + "x")`,
          "    return 'ran'",
          "  },",
          "}",
          "",
        ].join("\n"),
      )
      return { commandMarker, toolMarker, importMarker }
    },
  })

  await Instance.provide({
    directory: tmp.path,
    init: InstanceBootstrap,
    fn: async () => {
      try {
        const initial = await ProjectTrust.status(Instance.project)
        await ProjectTrust.update(Instance.project, { trusted: true, root: initial.root })
        const session = await Session.create({
          permission: [{ permission: "bash", pattern: "*", action: "allow" }],
        })

        expect((await Command.get("revocable"))?.description).toBe("Revocable command")
        expect((await Agent.get("revocable-agent"))?.description).toBe("Revocable agent")
        expect((await Skill.get("revocable-skill"))?.origin).toBe("project")
        const loaded = await ToolRegistry.tools({ providerID: "test", modelID: "test" })
        const held = loaded.find((tool) => tool.id === "revocable")
        expect(held).toBeDefined()
        await held!.execute({}, context(session.id))
        expect(await Bun.file(tmp.extra.toolMarker).text()).toBe("x")
        expect(await Bun.file(tmp.extra.importMarker).text()).toBe("imported")

        // ProjectTrust.update awaits the local Bus handler. The first reads
        // after this response must already reflect revoked authority.
        const revoked = await ProjectTrust.update(Instance.project, { trusted: false })
        expect(revoked.state).toBe("revoked")
        expect(await Command.get("revocable")).toBeUndefined()
        expect(await Agent.get("revocable-agent")).toBeUndefined()
        expect(await Skill.get("revocable-skill")).toBeUndefined()
        expect(await ToolRegistry.ids()).not.toContain("revocable")

        await expect(held!.execute({}, context(session.id))).rejects.toBeInstanceOf(ProjectTrust.DeniedError)
        expect(await Bun.file(tmp.extra.toolMarker).text()).toBe("x")
        await expect(
          SessionPrompt.command({
            sessionID: session.id,
            command: "revocable",
            arguments: "",
            model: "test/model",
          }),
        ).rejects.toBeDefined()
        expect(await Bun.file(tmp.extra.commandMarker).exists()).toBe(false)
      } finally {
        await Instance.dispose()
      }
    },
  })
}, 30_000)

test("filesystem authority changes do not re-enter a tool module during initialization", async () => {
  await using external = await tmpdir()
  await using tmp = await tmpdir({ git: true })
  const modules = {
    bootstrap: new URL("../../src/project/bootstrap.ts", import.meta.url).href,
    instance: new URL("../../src/project/instance.ts", import.meta.url).href,
    session: new URL("../../src/session/index.ts", import.meta.url).href,
    filesystem: new URL("../../src/session/filesystem.ts", import.meta.url).href,
    biology: new URL("../../src/tool/biology/notebook.ts", import.meta.url).href,
  }
  const script = [
    `import { InstanceBootstrap } from ${JSON.stringify(modules.bootstrap)}`,
    `import { Instance } from ${JSON.stringify(modules.instance)}`,
    `import { Session } from ${JSON.stringify(modules.session)}`,
    `import { SessionFilesystem } from ${JSON.stringify(modules.filesystem)}`,
    "const [directory, external] = process.argv.slice(1)",
    "await Instance.provide({ directory, init: InstanceBootstrap, fn: async () => {",
    "  const session = await Session.create({})",
    "  try {",
    `    const [biology, grant] = await Promise.all([import(${JSON.stringify(modules.biology)}), SessionFilesystem.grant({ sessionID: session.id, path: external, access: 'read', scope: 'session' })])`,
    "    if (!biology.NotebookTool || grant.path !== external) throw new Error('concurrent initialization result mismatch')",
    "  } finally {",
    "    await Session.remove(session.id)",
    "    await Instance.dispose()",
    "  }",
    "} })",
  ].join("\n")
  const child = Bun.spawn([process.execPath, "-e", script, tmp.path, external.path], {
    cwd: tmp.path,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const code = await Promise.race([child.exited, Bun.sleep(10_000).then(() => -1)])
  if (code === -1) child.kill("SIGKILL")
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(code, `${stdout}\n${stderr}`).toBe(0)
}, 15_000)

test("the durable authority watcher evicts project execution caches in another process", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (directory) => {
      const commandRoot = path.join(directory, ".openscience", "command")
      const toolRoot = path.join(directory, ".openscience", "tool")
      const ready = path.join(directory, "watcher-ready")
      const result = path.join(directory, "watcher-result")
      await fs.mkdir(commandRoot, { recursive: true })
      await fs.mkdir(toolRoot, { recursive: true })
      await Bun.write(
        path.join(commandRoot, "remote-revocable.md"),
        ["---", "description: Remote revocable command", "---", "Never execute"].join("\n"),
      )
      await Bun.write(
        path.join(toolRoot, "remote-revocable.ts"),
        [
          "export default {",
          "  description: 'Remote revocable tool',",
          "  args: {},",
          "  execute: async () => 'ran',",
          "}",
          "",
        ].join("\n"),
      )
      return { ready, result }
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const status = await ProjectTrust.status(Instance.project)
      await ProjectTrust.update(Instance.project, { trusted: true, root: status.root })
    },
  })

  const modules = {
    bootstrap: new URL("../../src/project/bootstrap.ts", import.meta.url).href,
    command: new URL("../../src/command/index.ts", import.meta.url).href,
    instance: new URL("../../src/project/instance.ts", import.meta.url).href,
    session: new URL("../../src/session/index.ts", import.meta.url).href,
    tool: new URL("../../src/tool/registry.ts", import.meta.url).href,
    trust: new URL("../../src/project/trust.ts", import.meta.url).href,
  }
  const childScript = [
    `import { InstanceBootstrap } from ${JSON.stringify(modules.bootstrap)}`,
    `import { Command } from ${JSON.stringify(modules.command)}`,
    `import { Instance } from ${JSON.stringify(modules.instance)}`,
    `import { Session } from ${JSON.stringify(modules.session)}`,
    `import { ToolRegistry } from ${JSON.stringify(modules.tool)}`,
    `import { ProjectTrust } from ${JSON.stringify(modules.trust)}`,
    "const [directory, ready, result] = process.argv.slice(1)",
    "await Instance.provide({ directory, init: InstanceBootstrap, fn: async () => {",
    "  try {",
    "    const session = await Session.create({})",
    "    const commandLoaded = (await Command.get('remote-revocable'))?.description === 'Remote revocable command'",
    "    const tools = await ToolRegistry.tools({ providerID: 'test', modelID: 'test' })",
    "    const held = tools.find((tool) => tool.id === 'remote-revocable')",
    "    await Bun.write(ready, JSON.stringify({ commandLoaded, toolLoaded: !!held }))",
    "    let evicted = false",
    "    for (let attempt = 0; attempt < 200; attempt++) {",
    "      const commandMissing = (await Command.get('remote-revocable')) === undefined",
    "      const toolMissing = !(await ToolRegistry.ids()).includes('remote-revocable')",
    "      if (commandMissing && toolMissing) { evicted = true; break }",
    "      await Bun.sleep(25)",
    "    }",
    "    let heldDenied = false",
    "    try {",
    "      await held.execute({}, { sessionID: session.id, messageID: 'msg_remote', callID: 'call_remote', agent: 'research', abort: AbortSignal.any([]), messages: [], metadata() {}, async ask() {} })",
    "    } catch (error) { heldDenied = ProjectTrust.DeniedError.isInstance(error) }",
    "    await Bun.write(result, JSON.stringify({ commandLoaded, toolLoaded: !!held, evicted, heldDenied }))",
    "  } catch (error) {",
    "    await Bun.write(result, JSON.stringify({ error: error instanceof Error ? error.stack : String(error) }))",
    "  } finally { await Instance.dispose() }",
    "} })",
  ].join("\n")
  const child = Bun.spawn([process.execPath, "-e", childScript, tmp.path, tmp.extra.ready, tmp.extra.result], {
    cwd: tmp.path,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  })

  try {
    await waitForFile(tmp.extra.ready)
    const ready = await Bun.file(tmp.extra.ready).json()
    expect(ready, JSON.stringify(ready)).toMatchObject({ commandLoaded: true, toolLoaded: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () => ProjectTrust.update(Instance.project, { trusted: false }),
    })
    await waitForFile(tmp.extra.result, 400)
    const code = await Promise.race([child.exited, Bun.sleep(10_000).then(() => -1)])
    if (code === -1) throw new Error("Durable watcher fixture did not exit")
    const stderr = await new Response(child.stderr).text()
    expect(code, stderr).toBe(0)
    expect(await Bun.file(tmp.extra.result).json()).toEqual({
      commandLoaded: true,
      toolLoaded: true,
      evicted: true,
      heldDenied: true,
    })
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited.catch(() => {})
  }
}, 30_000)
