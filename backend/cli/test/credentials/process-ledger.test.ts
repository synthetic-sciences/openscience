import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CredentialProcessLedger } from "../../src/credentials/process-ledger"
import { WindowsJobLauncher } from "../../src/process/windows-job-launcher"

const linuxTest = process.platform === "linux" ? test : test.skip

async function waitText(file: string, attempt = 0): Promise<string> {
  const value = await fs.readFile(file, "utf8").catch(() => undefined)
  if (value?.trim()) return value.trim()
  if (attempt >= 500) throw new Error(`Timed out waiting for ${file}`)
  await Bun.sleep(10)
  return waitText(file, attempt + 1)
}

async function waitIdentity(pid: number, attempt = 0): Promise<string> {
  const identity = await CredentialProcessLedger.identity(pid)
  if (identity) return identity
  if (attempt >= 500) throw new Error(`Timed out capturing process identity for ${pid}`)
  await Bun.sleep(10)
  return waitIdentity(pid, attempt + 1)
}

linuxTest("legacy group revocation reaps a same-group descendant after its recorded leader exits", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-credential-descendant-"))
  const marker = path.join(root, "descendant.pid")
  const release = path.join(root, "release")
  const projectID = `project-descendant-${crypto.randomUUID()}`
  const id = `provider-descendant-${crypto.randomUUID()}`
  const leader = spawn(
    "/bin/sh",
    [
      "-c",
      'sleep 600 & printf "%s" "$!" > "$1"; while [ ! -e "$2" ]; do sleep 0.01; done; exit 0',
      "credential-ledger",
      marker,
      release,
    ],
    { detached: true, stdio: "ignore" },
  )
  const completion = new Promise<void>((resolve, reject) => {
    leader.once("exit", () => resolve())
    leader.once("error", reject)
  })
  const state: { pid?: number; identity?: string } = {}
  try {
    expect(
      await CredentialProcessLedger.register({
        id,
        kind: "provider",
        pid: leader.pid!,
        detached: true,
        projectID,
        sessionID: "session-descendant",
      }),
    ).toBe(true)
    state.pid = Number(await waitText(marker))
    state.identity = await waitIdentity(state.pid)
    expect(state.identity).toMatch(/^[a-f0-9]{64}$/)
    await Bun.write(release, "release")
    await completion
    expect(await CredentialProcessLedger.owns(state.pid, state.identity)).toBe(true)

    expect(await CredentialProcessLedger.revoke({ kind: "provider", projectID })).toBe(1)
    expect(await CredentialProcessLedger.owns(state.pid, state.identity)).toBe(false)
  } finally {
    await Bun.write(release, "release").catch(() => undefined)
    await CredentialProcessLedger.revoke({ kind: "provider", projectID }).catch(() => undefined)
    if (state.pid && (await CredentialProcessLedger.owns(state.pid, state.identity))) {
      process.kill(state.pid, "SIGKILL")
    }
    if (leader.exitCode === null && leader.signalCode === null) leader.kill("SIGKILL")
    await fs.rm(root, { recursive: true, force: true })
  }
})

linuxTest("command registration rejects a child that does not own a process group", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  try {
    await expect(
      CredentialProcessLedger.register({
        id: `command-non-group-${crypto.randomUUID()}`,
        kind: "command",
        pid: child.pid!,
        detached: false,
        projectID: "project-non-group",
        sessionID: "session-non-group",
      }),
    ).rejects.toThrow("was not spawned in an owned process group")
  } finally {
    child.kill("SIGKILL")
    await new Promise<void>((resolve) => child.once("exit", () => resolve()))
  }
})

linuxTest("command registration rejects an unverified child-subreaper claim", async () => {
  const id = `command-uncontained-${crypto.randomUUID()}`
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  })
  const completion = new Promise<void>((resolve) => {
    child.once("exit", () => resolve())
    child.once("error", () => resolve())
  })
  const identity = await waitIdentity(child.pid!)
  try {
    await expect(
      CredentialProcessLedger.register({
        id,
        kind: "command",
        pid: child.pid!,
        detached: true,
        projectID: "project-uncontained",
        sessionID: "session-uncontained",
        windowsRelease: path.join(os.tmpdir(), `openscience-forged-release-${crypto.randomUUID()}`),
        subreaper: child,
      }),
    ).rejects.toThrow("verified Linux child-subreaper registration gate")
  } finally {
    await CredentialProcessLedger.revoke({ id }).catch(() => undefined)
    if (await CredentialProcessLedger.owns(child.pid!, identity)) process.kill(-child.pid!, "SIGKILL")
    await completion
  }
})

linuxTest("legacy non-command release inference persists child-subreaper containment", async () => {
  const owner = await waitIdentity(process.pid)
  const wrapped = WindowsJobLauncher.wrap({
    file: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    linuxOwner: { pid: process.pid, identity: owner },
  })
  if (!wrapped.release) throw new Error("Linux launcher did not mint a release gate")
  const id = `provider-subreaper-${crypto.randomUUID()}`
  const child = spawn(wrapped.file, wrapped.args, { detached: true, stdio: "ignore" })
  const completion = new Promise<void>((resolve) => {
    child.once("exit", () => resolve())
    child.once("error", () => resolve())
  })
  const identity = await waitIdentity(child.pid!)
  try {
    expect(WindowsJobLauncher.bind(child, wrapped.release)).toBe(true)
    expect(
      await CredentialProcessLedger.register({
        id,
        kind: "provider",
        pid: child.pid!,
        detached: true,
        projectID: "project-provider-subreaper",
        windowsRelease: wrapped.release,
      }),
    ).toBe(true)
    const ledger = (await Bun.file(CredentialProcessLedger.pathForTests()).json()) as Array<{
      id?: string
      linux_subreaper?: boolean
    }>
    expect(ledger.find((item) => item.id === id)?.linux_subreaper).toBe(true)

    expect(await CredentialProcessLedger.revoke({ id, kind: "provider" })).toBe(1)
    await completion
    expect(await CredentialProcessLedger.owns(child.pid!, identity)).toBe(false)
  } finally {
    await CredentialProcessLedger.revoke({ id }).catch(() => undefined)
    if (await CredentialProcessLedger.owns(child.pid!, identity)) process.kill(-child.pid!, "SIGKILL")
    await completion
  }
})

test.skipIf(process.platform !== "darwin")("Darwin registration rejects an unwrapped durable runtime", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  })
  try {
    await expect(
      CredentialProcessLedger.register({
        id: `command-unwrapped-${crypto.randomUUID()}`,
        kind: "command",
        pid: child.pid!,
        detached: true,
        projectID: "project-unwrapped",
      }),
    ).rejects.toThrow("macOS responsibility registration gate")
  } finally {
    process.kill(-child.pid!, "SIGKILL")
  }
})

test.skipIf(process.platform !== "darwin")(
  "Darwin revocation reaps a fully reparented double-fork daemon by kernel responsibility",
  async () => {
    const python = Bun.which("python3")
    if (!python) return
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-credential-responsibility-"))
    const marker = path.join(root, "daemon.pid")
    const projectID = `project-responsibility-${crypto.randomUUID()}`
    const id = `command-responsibility-${crypto.randomUUID()}`
    const daemonScript = [
      "import os, signal, time",
      "signal.signal(signal.SIGHUP, signal.SIG_IGN)",
      "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
      "if os.fork(): os._exit(0)",
      "os.setsid()",
      "if os.fork(): os._exit(0)",
      `marker = open(${JSON.stringify(marker)}, 'w')`,
      "marker.write(str(os.getpid()))",
      "marker.close()",
      "time.sleep(600)",
    ].join("\n")
    const supervisorScript = [
      "import subprocess, sys, time",
      `subprocess.Popen([sys.executable, '-c', ${JSON.stringify(daemonScript)}])`,
      "time.sleep(600)",
    ].join("\n")
    const wrapped = WindowsJobLauncher.wrap({ file: python, args: ["-c", supervisorScript] })
    const leader = spawn(wrapped.file, wrapped.args, { detached: true, stdio: "ignore" })
    let daemon = 0
    let daemonIdentity: string | undefined
    try {
      expect(wrapped.release).toBeTruthy()
      await Bun.sleep(100)
      expect(await Bun.file(marker).exists()).toBe(false)
      expect(
        await CredentialProcessLedger.register({
          id,
          kind: "command",
          pid: leader.pid!,
          detached: true,
          projectID,
          windowsRelease: wrapped.release,
        }),
      ).toBe(true)
      daemon = Number(await waitText(marker))
      daemonIdentity = await CredentialProcessLedger.identity(daemon)
      expect(daemonIdentity).toMatch(/^[a-f0-9]{64}$/)
      const ppid = Bun.spawn(["/bin/ps", "-o", "ppid=", "-p", String(daemon)], { stdout: "pipe" })
      expect(Number((await new Response(ppid.stdout).text()).trim())).toBe(1)
      expect(await ppid.exited).toBe(0)

      expect(await CredentialProcessLedger.revoke({ id, kind: "command", projectID })).toBe(1)
      expect(await CredentialProcessLedger.owns(daemon, daemonIdentity)).toBe(false)
    } finally {
      await CredentialProcessLedger.revoke({ id }).catch(() => undefined)
      if (daemon && (await CredentialProcessLedger.owns(daemon, daemonIdentity))) process.kill(daemon, "SIGKILL")
      if (leader.exitCode === null && leader.signalCode === null) leader.kill("SIGKILL")
      await fs.rm(root, { recursive: true, force: true })
    }
  },
  15_000,
)
