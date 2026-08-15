import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CredentialProcessLedger } from "../../src/credentials/process-ledger"

const posixTest = process.platform === "win32" ? test.skip : test
const cwd = path.resolve(import.meta.dir, "../..")
type PipedProcess = Omit<ReturnType<typeof Bun.spawn>, "stdout" | "stderr"> & {
  stdout: ReadableStream<Uint8Array<ArrayBuffer>>
  stderr: ReadableStream<Uint8Array<ArrayBuffer>>
}

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

async function readJsonLine<T>(process: PipedProcess, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let buffered = ""
    const timeout = setTimeout(() => reject(new Error(`${label} did not report durable ownership`)), 20_000)
    const reader = process.stdout.getReader()
    void (async () => {
      const decoder = new TextDecoder()
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error(`${label} stdout closed before durable ownership was reported`)
        buffered += decoder.decode(chunk.value, { stream: true })
        const line = buffered.split("\n").find((value) => value.trim().startsWith("{"))
        if (!line) continue
        clearTimeout(timeout)
        resolve(JSON.parse(line) as T)
        return
      }
    })().catch((error) => {
      clearTimeout(timeout)
      reject(error)
    })
    process.exited.then(async (code) => {
      if (code === 0) return
      const stderr = await new Response(process.stderr).text()
      clearTimeout(timeout)
      reject(new Error(`${label} exited ${code}: ${stderr}`))
    })
  })
}

async function run(process: PipedProcess, label: string) {
  const [code, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()])
  if (code !== 0) throw new Error(`${label} exited ${code}: ${stderr}`)
}

async function processGroup(pid: number): Promise<number> {
  const process = Bun.spawn(["/bin/ps", "-o", "pgid=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, output, error] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  if (code !== 0) throw new Error(`Could not inspect process group for ${pid}: ${error}`)
  return Number(output.trim())
}

posixTest(
  "fresh-process trust revocation reaps an orphaned LSP and its direct setsid descendant",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-lsp-orphan-"))
    const workspace = path.join(root, "workspace")
    const runner = path.join(root, "runner.ts")
    const wrapper = path.join(workspace, "orphan-lsp")
    const server = path.join(workspace, "fake-lsp-server.js")
    const source = path.join(workspace, "probe.orphan")
    const descendantFile = path.join(workspace, "descendant.pid")
    const instance = new URL("../../src/project/instance.ts", import.meta.url).href
    const bootstrap = new URL("../../src/project/bootstrap.ts", import.meta.url).href
    const trust = new URL("../../src/project/trust.ts", import.meta.url).href
    const lsp = new URL("../../src/lsp/index.ts", import.meta.url).href
    const ledger = new URL("../../src/credentials/process-ledger.ts", import.meta.url).href
    const config = new URL("../../src/config/config.ts", import.meta.url).href
    const sandbox = new URL("../../src/sandbox/sandbox.ts", import.meta.url).href
    const python = Bun.which("python3") ?? "/usr/bin/python3"
    await fs.mkdir(workspace, { recursive: true })
    const fake = await fs.readFile(path.join(import.meta.dir, "../fixture/lsp/fake-lsp-server.js"), "utf8")
    await Bun.write(server, `${fake}\nsetInterval(() => {}, 1000)\n`)
    await Bun.write(
      wrapper,
      [
        "#!/bin/sh",
        "trap '' HUP TERM INT",
        `${JSON.stringify(python)} -c ${JSON.stringify(
          [
            "import os, signal, time",
            "signal.signal(signal.SIGHUP, signal.SIG_IGN)",
            "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
            "os.setsid()",
            `open(${JSON.stringify(descendantFile)}, 'w').write(str(os.getpid()))`,
            "time.sleep(600)",
          ].join("; "),
        )} &`,
        `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(server)}`,
        "",
      ].join("\n"),
    )
    await fs.chmod(wrapper, 0o700)
    await Bun.write(source, "orphan\n")
    await Bun.write(
      path.join(workspace, "openscience.json"),
      JSON.stringify({
        lsp: {
          orphan: {
            command: [wrapper],
            extensions: [".orphan"],
          },
        },
      }),
    )
    await Bun.write(
      runner,
      `
import fs from "node:fs/promises"
import { Instance } from ${JSON.stringify(instance)}
import { InstanceBootstrap } from ${JSON.stringify(bootstrap)}
import { ProjectTrust } from ${JSON.stringify(trust)}
import { LSP } from ${JSON.stringify(lsp)}
import { CredentialProcessLedger } from ${JSON.stringify(ledger)}
import { Config } from ${JSON.stringify(config)}
import { Sandbox } from ${JSON.stringify(sandbox)}

const [mode, workspace, source, descendantFile] = process.argv.slice(2)
async function waitText(file, attempt = 0) {
  const value = await fs.readFile(file, "utf8").catch(() => undefined)
  if (value?.trim()) return value.trim()
  if (attempt >= 500) throw new Error("Timed out waiting for LSP descendant")
  await Bun.sleep(20)
  return waitText(file, attempt + 1)
}

await Config.setSandbox({ enabled: true, onUnavailable: "error" })

if (mode === "owner") {
  await Instance.provide({
    directory: workspace,
    fn: async () => {
      const status = await ProjectTrust.status(Instance.project)
      if (!status.canExecuteProjectCode) {
        await ProjectTrust.update(Instance.project, { trusted: true, root: status.root })
      }
    },
  })
  await Instance.disposeAll()
  await Instance.provide({
    directory: workspace,
    init: InstanceBootstrap,
    fn: async () => {
      const policy = await Config.trustedSandbox()
      const sandboxed = policy.enabled === true && Sandbox.available()
      await LSP.touchFile(source)
      const entries = await Bun.file(CredentialProcessLedger.pathForTests()).json()
      const entry = entries.find((item) => item.kind === "lsp" && item.project_id === Instance.project.id)
      if (!entry) throw new Error("Missing durable LSP process entry")
      const reportedPID = Number(await waitText(descendantFile))
      const descendantPID = process.platform === "linux"
        ? await CredentialProcessLedger.resolveLinuxNamespacePID({
            leaderPID: entry.pid,
            leaderIdentity: entry.identity,
            namespacePID: reportedPID,
          })
        : reportedPID
      if (!descendantPID) throw new Error("Could not resolve LSP sandbox descendant PID")
      const descendantIdentity = await CredentialProcessLedger.identity(descendantPID)
      if (!descendantIdentity) throw new Error("Missing LSP descendant identity")
      console.log(JSON.stringify({
        projectID: Instance.project.id,
        pid: entry.pid,
        identity: entry.identity,
        sandboxed,
        descendant: { pid: descendantPID, identity: descendantIdentity },
      }))
      await new Promise(() => {})
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
} else if (mode === "reap") {
  await Instance.provide({
    directory: workspace,
    fn: async () => {
      await CredentialProcessLedger.revoke({ kind: "lsp", projectID: Instance.project.id })
    },
  })
} else {
  throw new Error("Unknown LSP orphan fixture mode")
}
`,
    )

    const spawn = (mode: "owner" | "revoke" | "reap") =>
      Bun.spawn([process.execPath, runner, mode, workspace, source, descendantFile], {
        cwd,
        env: environment(root),
        stdout: "pipe",
        stderr: "pipe",
      }) as PipedProcess

    let owner: PipedProcess | undefined
    let entry:
      | {
          projectID: string
          pid: number
          identity: string
          sandboxed: boolean
          descendant: { pid: number; identity: string }
        }
      | undefined
    try {
      owner = spawn("owner")
      const registered = await readJsonLine<NonNullable<typeof entry>>(owner, "LSP owner")
      entry = registered
      // This fixture explicitly opts into containment; product defaults use
      // trusted host execution, while this test verifies sandbox teardown.
      expect(registered.sandboxed).toBe(true)
      expect(await CredentialProcessLedger.owns(registered.pid, registered.identity)).toBe(true)
      expect(await CredentialProcessLedger.owns(registered.descendant.pid, registered.descendant.identity)).toBe(true)
      expect(await processGroup(registered.descendant.pid)).toBe(registered.descendant.pid)
      expect(await processGroup(registered.descendant.pid)).not.toBe(registered.pid)

      owner.kill("SIGKILL")
      await owner.exited
      await Bun.sleep(100)
      // macOS responsibility supervision and Linux bubblewrap's parent-death
      // namespace reap immediately. A fresh server still verifies and clears
      // the durable ledger record below.
      const survivesOwner = process.platform !== "darwin" && !(process.platform === "linux" && registered.sandboxed)
      expect(await CredentialProcessLedger.owns(registered.pid, registered.identity)).toBe(survivesOwner)
      expect(await CredentialProcessLedger.owns(registered.descendant.pid, registered.descendant.identity)).toBe(
        survivesOwner,
      )

      await run(spawn("revoke"), "fresh LSP trust revoker")
      expect(await CredentialProcessLedger.owns(registered.pid, registered.identity)).toBe(false)
      expect(await CredentialProcessLedger.owns(registered.descendant.pid, registered.descendant.identity)).toBe(false)
      expect(await Bun.file(path.join(root, "data", "credential-processes.json")).json()).toEqual([])
    } finally {
      owner?.kill("SIGKILL")
      await run(spawn("reap"), "LSP orphan cleanup").catch(() => undefined)
      if (entry && (await CredentialProcessLedger.owns(entry.pid, entry.identity))) {
        process.kill(entry.pid, "SIGKILL")
      }
      if (entry && (await CredentialProcessLedger.owns(entry.descendant.pid, entry.descendant.identity))) {
        process.kill(entry.descendant.pid, "SIGKILL")
      }
      await fs.rm(root, { recursive: true, force: true })
    }
  },
  60_000,
)
