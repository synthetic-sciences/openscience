import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

function environment(root: string) {
  return {
    ...process.env,
    OPENSCIENCE_DATA_DIR: path.join(root, "data"),
    OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
    OPENSCIENCE_TEST_HOME: path.join(root, "home"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config-xdg"),
    XDG_DATA_HOME: path.join(root, "data-xdg"),
    XDG_STATE_HOME: path.join(root, "state-xdg"),
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function waitForExit(pid: number) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (!alive(pid)) return
    await Bun.sleep(20)
  }
  throw new Error(`orphan command ${pid} remained alive after project trust revocation`)
}

test("another server's trust revocation kills orphaned Bash and session-shell process groups", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-command-orphan-"))
  const workspace = path.join(root, "workspace")
  const runner = path.join(root, "runner.ts")
  const instance = new URL("../../src/project/instance.ts", import.meta.url).href
  const bootstrap = new URL("../../src/project/bootstrap.ts", import.meta.url).href
  const trust = new URL("../../src/project/trust.ts", import.meta.url).href
  const session = new URL("../../src/session/index.ts", import.meta.url).href
  const prompt = new URL("../../src/session/prompt.ts", import.meta.url).href
  const bash = new URL("../../src/tool/bash.ts", import.meta.url).href
  const commands = new URL("../../src/science/command/registry.ts", import.meta.url).href
  await fs.mkdir(workspace)
  await Bun.write(
    runner,
    `
import { Instance } from ${JSON.stringify(instance)}
import { InstanceBootstrap } from ${JSON.stringify(bootstrap)}
import { ProjectTrust } from ${JSON.stringify(trust)}
import { Session } from ${JSON.stringify(session)}
import { SessionPrompt } from ${JSON.stringify(prompt)}
import { BashTool } from ${JSON.stringify(bash)}
import { CommandRuntime } from ${JSON.stringify(commands)}

const mode = process.argv[2]
const workspace = process.argv[3]
if (mode === "owner") {
  const surface = process.argv[4]
  await Instance.provide({
    directory: workspace,
    fn: async () => {
      const trust = await ProjectTrust.status(Instance.project)
      if (!trust.canExecuteProjectCode) await ProjectTrust.update(Instance.project, { trusted: true, root: trust.root })
      const session = await Session.create({ title: surface })
      if (surface === "bash") {
        const tool = await BashTool.init()
        void tool.execute({ command: "sleep 60", description: "orphan regression" }, {
          sessionID: session.id,
          messageID: "message_orphan",
          callID: "call_orphan",
          agent: "research",
          abort: new AbortController().signal,
          messages: [],
          metadata() {},
          async ask() {},
        }).catch(() => undefined)
      } else {
        void SessionPrompt.shell({
          sessionID: session.id,
          agent: "research",
          model: { providerID: "test", modelID: "test" },
          command: "sleep 60",
        }).catch(() => undefined)
      }
      for (let attempt = 0; attempt < 300; attempt++) {
        const command = CommandRuntime.list(Instance.project.id, session.id)[0]
        if (command) {
          console.log(JSON.stringify({ pid: command.process_id, projectID: Instance.project.id, sessionID: session.id }))
          await new Promise(() => {})
        }
        await Bun.sleep(10)
      }
      throw new Error("command did not start")
    },
  })
} else if (mode === "revoke") {
  await Instance.provide({
    directory: workspace,
    init: InstanceBootstrap,
    fn: async () => {
      await ProjectTrust.update(Instance.project, { trusted: false })
    },
  })
} else {
  throw new Error("unknown runner mode")
}
`,
  )

  const run = (mode: "owner" | "revoke", surface?: "bash" | "session-shell") =>
    Bun.spawn([process.execPath, runner, mode, workspace, ...(surface ? [surface] : [])], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: environment(root),
      stdout: "pipe",
      stderr: "pipe",
    })

  try {
    for (const surface of ["bash", "session-shell"] as const) {
      const owner = run("owner", surface)
      const line = await new Promise<string>((resolve, reject) => {
        let buffered = ""
        const timeout = setTimeout(() => reject(new Error(`${surface} owner did not report a child`)), 15_000)
        const reader = owner.stdout.getReader()
        void (async () => {
          const decoder = new TextDecoder()
          while (true) {
            const chunk = await reader.read()
            if (chunk.done) return
            buffered += decoder.decode(chunk.value, { stream: true })
            const complete = buffered.split("\n").find((item) => item.trim().startsWith("{"))
            if (!complete) continue
            clearTimeout(timeout)
            resolve(complete)
            return
          }
        })().catch(reject)
        owner.exited.then(async (code) => {
          if (code !== 0) {
            const stderr = await new Response(owner.stderr).text()
            reject(new Error(`${surface} owner exited before registration: ${stderr}`))
          }
        })
      })
      const registered = JSON.parse(line) as { pid: number }
      expect(alive(registered.pid)).toBe(true)
      owner.kill("SIGKILL")
      await owner.exited
      expect(alive(registered.pid)).toBe(true)

      const revoker = run("revoke")
      const [code, stderr] = await Promise.all([revoker.exited, new Response(revoker.stderr).text()])
      expect(code, stderr).toBe(0)
      await waitForExit(registered.pid)
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}, 60_000)
