import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProcessIdentity } from "../../src/process/process-identity"

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

async function waitForExit(pid: number, identity: string) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (!(await ProcessIdentity.owns(pid, identity))) return
    await Bun.sleep(20)
  }
  throw new Error(`command ${pid} remained alive`)
}

async function processParent(pid: number): Promise<number> {
  const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8")
  return Number(
    stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/)[1],
  )
}

test("owner supervision contains commands and a fresh server clears their durable records", async () => {
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
  const shell = new URL("../../src/shell/shell.ts", import.meta.url).href
  const config = new URL("../../src/config/config.ts", import.meta.url).href
  const identityModule = new URL("../../src/process/process-identity.ts", import.meta.url).href
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
import { Shell } from ${JSON.stringify(shell)}
import { Config } from ${JSON.stringify(config)}
import { ProcessIdentity } from ${JSON.stringify(identityModule)}
import { spawn } from "node:child_process"
import fs from "node:fs/promises"

const mode = process.argv[2]
const workspace = process.argv[3]
async function escapedCommand(marker) {
  if (process.platform !== "linux" || !marker) return "sleep 60"
  const python = Bun.which("python3")
  if (!python) return "sleep 60"
  const daemon = [
    "import os, sys, time",
    "os.setsid()",
    "os.fork() and os._exit(0)",
    "open(sys.argv[1], 'w').write(str(os.getpid()))",
    "time.sleep(600)",
  ].join("; ")
  const script = marker + ".sh"
  await fs.writeFile(script, [
    "#!/bin/sh",
    [JSON.stringify(python), "-c", JSON.stringify(daemon), JSON.stringify(marker)].join(" "),
    "while :; do sleep 1; done",
    "",
  ].join("\\n"))
  await fs.chmod(script, 0o700)
  return script
}
if (mode === "owner") {
  const surface = process.argv[4]
  if (process.platform === "linux") await Config.setSandbox({ enabled: false })
  await Instance.provide({
    directory: workspace,
    fn: async () => {
      const trust = await ProjectTrust.status(Instance.project)
      if (!trust.canExecuteProjectCode) await ProjectTrust.update(Instance.project, { trusted: true, root: trust.root })
      const session = await Session.create({ title: surface })
      if (surface === "host-setsid") {
        const marker = process.argv[5]
        const python = Bun.which("python3")
        if (!python || !marker) throw new Error("host-mode setsid fixture requires Python and a marker")
        const daemon = [
          "import os, signal, sys, time",
          "signal.signal(signal.SIGHUP, signal.SIG_IGN)",
          "os.setsid()",
          "os.fork() and os._exit(0)",
          "open(sys.argv[1], 'w').write(str(os.getpid()))",
          "time.sleep(600)",
        ].join("; ")
        const source = [
          "import subprocess, sys, time",
          "subprocess.run([sys.executable, '-c', " + JSON.stringify(daemon) + ", sys.argv[1]])",
          "time.sleep(600)",
        ].join("; ")
        const wrapped = await CommandRuntime.wrap({ file: python, args: ["-c", source, marker] })
        const child = spawn(wrapped.file, wrapped.args, { detached: true, stdio: "ignore" })
        const entry = await CommandRuntime.start({
          projectID: Instance.project.id,
          sessionID: session.id,
          messageID: "message_host_setsid",
          description: "Host-mode setsid owner recovery",
          command: "python start_new_session",
        }, child, () => Shell.killTree(child, {
          exited: () => child.exitCode !== null || child.signalCode !== null,
          detached: true,
        }), { windowsRelease: wrapped.release })
        for (let attempt = 0; attempt < 300 && !(await Bun.file(marker).exists()); attempt++) await Bun.sleep(10)
        if (!(await Bun.file(marker).exists())) throw new Error("host-mode setsid child did not start")
        console.log(JSON.stringify({
          pid: entry.process_id,
          descendantPID: Number((await fs.readFile(marker, "utf8")).trim()),
          projectID: Instance.project.id,
          sessionID: session.id,
        }))
        await new Promise(() => {})
      } else if (surface === "bash") {
        const marker = process.argv[5]
        const command = await escapedCommand(marker)
        const tool = await BashTool.init()
        void tool.execute({ command, description: "orphan regression" }, {
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
        const marker = process.argv[5]
        const command = await escapedCommand(marker)
        void SessionPrompt.shell({
          sessionID: session.id,
          agent: "research",
          model: { providerID: "test", modelID: "test" },
          command,
        }).catch(() => undefined)
      }
      for (let attempt = 0; attempt < 300; attempt++) {
        const command = CommandRuntime.list(Instance.project.id, session.id)[0]
        if (command) {
          const marker = process.argv[5]
          let descendantPID
          if (process.platform === "linux" && marker) {
            for (let attempt = 0; attempt < 500 && !(await Bun.file(marker).exists()); attempt++) await Bun.sleep(10)
            descendantPID = Number((await fs.readFile(marker, "utf8")).trim())
          }
          console.log(JSON.stringify({ pid: command.process_id, descendantPID, projectID: Instance.project.id, sessionID: session.id }))
          await new Promise(() => {})
        }
        await Bun.sleep(10)
      }
      throw new Error("command did not start")
    },
  })
} else if (mode === "surface-stop") {
  const surface = process.argv[4]
  const marker = process.argv[5]
  if (!marker) throw new Error("surface stop fixture requires a marker")
  await Config.setSandbox({ enabled: false })
  await Instance.provide({
    directory: workspace,
    fn: async () => {
      const trust = await ProjectTrust.status(Instance.project)
      if (!trust.canExecuteProjectCode) await ProjectTrust.update(Instance.project, { trusted: true, root: trust.root })
      const session = await Session.create({ title: surface })
      const command = await escapedCommand(marker)
      let operation
      if (surface === "bash-timeout") {
        const tool = await BashTool.init()
        operation = tool.execute({ command, description: "timeout containment", timeout: 1200 }, {
          sessionID: session.id,
          messageID: "message_timeout",
          callID: "call_timeout",
          agent: "research",
          abort: new AbortController().signal,
          messages: [],
          metadata() {},
          async ask() {},
        })
      } else {
        operation = SessionPrompt.shell({
          sessionID: session.id,
          agent: "research",
          model: { providerID: "test", modelID: "test" },
          command,
        })
      }
      for (let attempt = 0; attempt < 500 && !(await Bun.file(marker).exists()); attempt++) await Bun.sleep(10)
      const pid = Number((await fs.readFile(marker, "utf8")).trim())
      const identity = await ProcessIdentity.capture(pid)
      if (!identity) throw new Error("surface stop daemon identity was not captured")
      if (surface !== "bash-timeout") SessionPrompt.cancel(session.id)
      await operation
      console.log(JSON.stringify({ pid, identity }))
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

  const run = (
    mode: "owner" | "revoke" | "surface-stop",
    surface?: "bash" | "session-shell" | "host-setsid" | "bash-timeout" | "session-abort",
    marker?: string,
  ) =>
    Bun.spawn([process.execPath, runner, mode, workspace, ...(surface ? [surface] : []), ...(marker ? [marker] : [])], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: environment(root),
      stdout: "pipe",
      stderr: "pipe",
    })

  let hostOwner: ReturnType<typeof run> | undefined
  let host: { pid: number; identity: string; descendantPID: number; descendantIdentity: string } | undefined
  try {
    for (const surface of ["bash", "session-shell"] as const) {
      const marker = process.platform === "linux" ? path.join(root, `${surface}-daemon.pid`) : undefined
      const owner = run("owner", surface, marker)
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
      const registered = JSON.parse(line) as { pid: number; descendantPID?: number }
      const identity = await ProcessIdentity.capture(registered.pid)
      expect(identity).toMatch(/^[a-f0-9]{64}$/)
      expect(await ProcessIdentity.owns(registered.pid, identity)).toBe(true)
      const descendantIdentity = registered.descendantPID
        ? await ProcessIdentity.capture(registered.descendantPID)
        : undefined
      if (process.platform === "linux") {
        expect(descendantIdentity).toMatch(/^[a-f0-9]{64}$/)
        expect(await processParent(registered.descendantPID!)).toBe(registered.pid)
      }
      owner.kill("SIGKILL")
      await owner.exited
      await waitForExit(registered.pid, identity!)
      if (registered.descendantPID && descendantIdentity) {
        await waitForExit(registered.descendantPID, descendantIdentity)
      }

      const revoker = run("revoke")
      const [code, stderr] = await Promise.all([revoker.exited, new Response(revoker.stderr).text()])
      expect(code, stderr).toBe(0)
      const ledger = (await Bun.file(path.join(root, "data", "credential-processes.json")).json()) as Array<{
        kind?: string
      }>
      expect(ledger.filter((entry) => entry.kind === "command")).toHaveLength(0)
    }

    if (process.platform === "linux" && Bun.which("python3")) {
      const marker = path.join(root, "host-setsid.pid")
      hostOwner = run("owner", "host-setsid", marker)
      const registered = JSON.parse(
        await new Promise<string>((resolve, reject) => {
          let buffered = ""
          const timeout = setTimeout(() => reject(new Error("host-mode owner did not report its child")), 15_000)
          const reader = hostOwner!.stdout.getReader()
          void (async () => {
            const decoder = new TextDecoder()
            while (true) {
              const chunk = await reader.read()
              if (chunk.done) throw new Error("host-mode owner stdout closed before registration")
              buffered += decoder.decode(chunk.value, { stream: true })
              const complete = buffered.split("\n").find((item) => item.trim().startsWith("{"))
              if (!complete) continue
              clearTimeout(timeout)
              resolve(complete)
              return
            }
          })().catch(reject)
        }),
      ) as { pid: number; descendantPID: number }
      const identity = await ProcessIdentity.capture(registered.pid)
      const descendantIdentity = await ProcessIdentity.capture(registered.descendantPID)
      if (!identity || !descendantIdentity) throw new Error("host-mode command identities were not captured")
      host = { ...registered, identity, descendantIdentity }
      expect(await ProcessIdentity.owns(host.pid, host.identity)).toBe(true)
      expect(await ProcessIdentity.owns(host.descendantPID, host.descendantIdentity)).toBe(true)
      // The setsid + second-fork daemon has already escaped the payload's PPID
      // closure and been adopted directly by the verified subreaper.
      expect(await processParent(host.descendantPID)).toBe(host.pid)

      hostOwner.kill("SIGKILL")
      await hostOwner.exited
      // Linux host-mode launches are verified child subreapers. Owner loss
      // reaps the raw leader and an escaped start_new_session child before the
      // durable launcher exits; a fresh server then only clears the stale row.
      await waitForExit(host.pid, host.identity)
      await waitForExit(host.descendantPID, host.descendantIdentity)

      const revoker = run("revoke")
      const [code, stderr] = await Promise.all([revoker.exited, new Response(revoker.stderr).text()])
      expect(code, stderr).toBe(0)
      const ledger = (await Bun.file(path.join(root, "data", "credential-processes.json")).json()) as Array<{
        kind?: string
      }>
      expect(ledger.filter((entry) => entry.kind === "command")).toHaveLength(0)

      for (const surface of ["bash-timeout", "session-abort"] as const) {
        const surfaceMarker = path.join(root, `${surface}-daemon.pid`)
        const stopper = run("surface-stop", surface, surfaceMarker)
        const [stopCode, stdout, stopError] = await Promise.all([
          stopper.exited,
          new Response(stopper.stdout).text(),
          new Response(stopper.stderr).text(),
        ])
        expect(stopCode, stopError).toBe(0)
        const stopped = JSON.parse(stdout.trim()) as { pid: number; identity: string }
        expect(await ProcessIdentity.owns(stopped.pid, stopped.identity)).toBe(false)
        const cleanup = run("revoke")
        const [cleanupCode, cleanupError] = await Promise.all([cleanup.exited, new Response(cleanup.stderr).text()])
        expect(cleanupCode, cleanupError).toBe(0)
      }
    }
  } finally {
    hostOwner?.kill("SIGKILL")
    await run("revoke").exited.catch(() => undefined)
    if (host && (await ProcessIdentity.owns(host.pid, host.identity))) process.kill(host.pid, "SIGKILL")
    if (host && (await ProcessIdentity.owns(host.descendantPID, host.descendantIdentity))) {
      process.kill(host.descendantPID, "SIGKILL")
    }
    await fs.rm(root, { recursive: true, force: true })
  }
}, 60_000)
