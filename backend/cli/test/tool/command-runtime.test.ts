import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CredentialProcessLedger } from "../../src/credentials/process-ledger"
import { Instance } from "../../src/project/instance"
import { CommandRuntime } from "../../src/science/command/registry"
import { Shell } from "../../src/shell/shell"
import { BashTool } from "../../src/tool/bash"
import { executionSession, tmpdir } from "../fixture/fixture"

const context = (sessionID: string) => ({
  sessionID,
  messageID: "msg_live_command",
  callID: "call_live_command",
  agent: "research",
  abort: new AbortController().signal,
  messages: [],
  metadata() {},
  async ask() {},
})

test("bash registers only its live process in the project compute ledger", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await executionSession()
      const tool = await BashTool.init()
      const running = tool.execute(
        { command: "sleep 10", description: "Waiting for analysis input" },
        context(session.id),
      )
      const find = async (attempt = 0): Promise<ReturnType<typeof CommandRuntime.list>[number]> => {
        const command = CommandRuntime.list(Instance.project.id, session.id)[0]
        if (command) return command
        if (attempt >= 100) throw new Error("Live command did not enter the compute ledger")
        await Bun.sleep(10)
        return find(attempt + 1)
      }
      const command = await find()

      expect(command).toMatchObject({
        sessionID: session.id,
        messageID: "msg_live_command",
        callID: "call_live_command",
        description: "Waiting for analysis input",
        command: "sleep 10",
        state: "running",
        process_id: expect.any(Number),
      })
      expect(await CommandRuntime.stopSession(Instance.project.id, "session_other")).toBe(0)
      expect(await CommandRuntime.stopProject("project_other")).toBe(0)
      expect(await CommandRuntime.stopProject(Instance.project.id)).toBe(1)
      expect((await running).output).toContain("User aborted the command")
      expect(CommandRuntime.list(Instance.project.id, session.id)).toEqual([])
    },
  })
}, 30_000)

test("credential revocation stops every real registered command", async () => {
  const wrapped = await CommandRuntime.wrap({
    file: process.execPath,
    args: ["-e", "console.log(process.env.LAB_ACCESS_TOKEN); setInterval(() => {}, 1000)"],
  })
  const child = spawn(wrapped.file, wrapped.args, {
    env: { ...process.env, LAB_ACCESS_TOKEN: "inherited-command-secret" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  })
  let exited = false
  const entry = await CommandRuntime.start(
    {
      projectID: "project_credentials",
      sessionID: "session_credentials",
      messageID: "message_credentials",
      callID: "call_credentials",
      description: "Credential-bearing command",
      command: "credential-child",
    },
    child,
    () => Shell.killTree(child, { exited: () => exited, detached: process.platform !== "win32" }),
    { windowsRelease: wrapped.release },
  )
  child.once("exit", () => {
    exited = true
    CommandRuntime.finish(entry.id)
  })

  const inherited = await new Promise<string>((resolve, reject) => {
    child.stdout!.once("data", (data) => resolve(String(data).trim()))
    child.once("error", reject)
  })
  expect(inherited).toBe("inherited-command-secret")
  expect(await CommandRuntime.stopAll()).toBe(1)
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  expect(CommandRuntime.list("project_credentials", "session_credentials")).toEqual([])
})

const posixTest = process.platform === "win32" ? test.skip : test
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

async function waitGone(pid: number, identity: string, attempt = 0): Promise<boolean> {
  if (!(await CredentialProcessLedger.owns(pid, identity))) return true
  if (attempt >= 500) return false
  await Bun.sleep(10)
  return waitGone(pid, identity, attempt + 1)
}

test("pre-exec ownership preserves immediate exit 0 and exit 127", async () => {
  for (const code of [0, 127]) {
    const projectID = `project-command-fast-${code}-${crypto.randomUUID()}`
    const sessionID = `session-command-fast-${code}`
    const wrapped = await CommandRuntime.wrap({
      file: process.execPath,
      args: ["-e", `process.exit(${code})`],
    })
    const child = spawn(wrapped.file, wrapped.args, {
      detached: process.platform !== "win32",
      stdio: "ignore",
    })
    const completion = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", resolve)
    })
    const entry = await CommandRuntime.start(
      {
        projectID,
        sessionID,
        messageID: `message-command-fast-${code}`,
        description: `Immediate exit ${code}`,
        command: `exit ${code}`,
      },
      child,
      () =>
        Shell.killTree(child, {
          exited: () => child.exitCode !== null || child.signalCode !== null,
          detached: process.platform !== "win32",
        }),
      { windowsRelease: wrapped.release },
    )

    expect(await completion).toBe(code)
    CommandRuntime.finish(entry.id)
    expect(CommandRuntime.list(projectID, sessionID)).toEqual([])
  }
})

linuxTest("the owner gate executes an unsandboxed shell only after registration", async () => {
  const projectID = `project-command-shell-${crypto.randomUUID()}`
  const wrapped = await CommandRuntime.wrap({
    file: "printf 'registered-shell'",
    shell: true,
  })
  const child = spawn(wrapped.file, wrapped.args, {
    detached: true,
    shell: wrapped.spawnShell,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  child.stdout!.on("data", (chunk) => {
    output += String(chunk)
  })
  const completion = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", resolve)
  })
  const entry = await CommandRuntime.start(
    {
      projectID,
      sessionID: "session-command-shell",
      messageID: "message-command-shell",
      description: "Registered unsandboxed shell",
      command: "printf registered-shell",
    },
    child,
    () => Shell.killTree(child, { exited: () => child.exitCode !== null, detached: true }),
    { windowsRelease: wrapped.release },
  )

  expect(await completion).toBe(0)
  expect(output).toBe("registered-shell")
  CommandRuntime.finish(entry.id)
})

linuxTest("registration failure never releases the command body", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-command-gate-"))
  const marker = path.join(root, "executed")
  const previous = process.env.OPENSCIENCE_COMMAND_TEST_REGISTRATION_FAILURE
  process.env.OPENSCIENCE_COMMAND_TEST_REGISTRATION_FAILURE = "1"
  const projectID = `project-command-gate-${crypto.randomUUID()}`
  let child: ReturnType<typeof spawn> | undefined
  try {
    const wrapped = await CommandRuntime.wrap({
      file: process.execPath,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`],
    })
    child = spawn(wrapped.file, wrapped.args, { detached: true, stdio: "ignore" })
    const completion = new Promise<void>((resolve) => {
      child!.once("exit", () => resolve())
      child!.once("error", () => resolve())
    })
    await expect(
      CommandRuntime.start(
        {
          projectID,
          sessionID: "session-command-gate",
          messageID: "message-command-gate",
          description: "Injected registration failure",
          command: "must not execute",
        },
        child,
        () => Shell.killTree(child!, { exited: () => child!.exitCode !== null, detached: true }),
        { windowsRelease: wrapped.release },
      ),
    ).rejects.toThrow("Injected command registration failure")
    await completion

    expect(await Bun.file(marker).exists()).toBe(false)
    expect(CommandRuntime.list(projectID, "session-command-gate")).toEqual([])
  } finally {
    if (previous === undefined) delete process.env.OPENSCIENCE_COMMAND_TEST_REGISTRATION_FAILURE
    else process.env.OPENSCIENCE_COMMAND_TEST_REGISTRATION_FAILURE = previous
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await fs.rm(root, { recursive: true, force: true })
  }
})

linuxTest("a forged launcher release is rejected before the command body runs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-command-forged-gate-"))
  const marker = path.join(root, "executed")
  const projectID = `project-command-forged-${crypto.randomUUID()}`
  const sessionID = "session-command-forged"
  const state: {
    child?: ReturnType<typeof spawn>
    identity?: string
    completion?: Promise<void>
  } = {}
  try {
    const wrapped = await CommandRuntime.wrap({
      file: process.execPath,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`],
    })
    if (!wrapped.release) throw new Error("Linux command wrapper did not mint a release gate")
    state.child = spawn(wrapped.file, wrapped.args, { detached: true, stdio: "ignore" })
    const child = state.child
    state.completion = new Promise<void>((resolve) => {
      child.once("exit", () => resolve())
      child.once("error", () => resolve())
    })
    state.identity = await waitIdentity(child.pid!)

    await expect(
      CommandRuntime.start(
        {
          projectID,
          sessionID,
          messageID: "message-command-forged",
          description: "Forged registration gate",
          command: "must not execute",
        },
        child,
        () =>
          Shell.killTree(child, {
            exited: () => child.exitCode !== null || child.signalCode !== null,
            detached: true,
          }),
        { windowsRelease: `${wrapped.release}-forged` },
      ),
    ).rejects.toThrow("verified child-subreaper registration gate")
    await state.completion

    expect(await Bun.file(marker).exists()).toBe(false)
    expect(await waitGone(child.pid!, state.identity)).toBe(true)
    expect(CommandRuntime.list(projectID, sessionID)).toEqual([])
    const text = await fs.readFile(CredentialProcessLedger.pathForTests(), "utf8").catch(() => "[]")
    const ledger = JSON.parse(text) as Array<{ project_id?: string }>
    expect(ledger.some((item) => item.project_id === projectID)).toBe(false)
  } finally {
    await CommandRuntime.stopProject(projectID).catch(() => undefined)
    if (state.child && state.identity && (await CredentialProcessLedger.owns(state.child.pid!, state.identity))) {
      process.kill(-state.child.pid!, "SIGKILL")
    }
    await state.completion?.catch(() => undefined)
    await fs.rm(root, { recursive: true, force: true })
  }
})

linuxTest(
  "normal completion reaps a setsid descendant after its shell leader exits",
  async () => {
    const setsid = Bun.which("setsid")
    if (!setsid) return
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-command-setsid-completion-"))
    const marker = path.join(root, "descendant.pid")
    const release = path.join(root, "release")
    const projectID = `project-command-setsid-completion-${crypto.randomUUID()}`
    const sessionID = "session-command-setsid-completion"
    const script =
      '"$1" sleep 600 </dev/null >/dev/null 2>&1 & printf "%s" "$!" > "$2"; while [ ! -e "$3" ]; do sleep 0.01; done; exit 0'
    const state: {
      child?: ReturnType<typeof spawn>
      completion?: Promise<number | null>
      entry?: Awaited<ReturnType<typeof CommandRuntime.start>>
      pid?: number
      identity?: string
    } = {}
    try {
      const wrapped = await CommandRuntime.wrap({
        file: "/bin/sh",
        args: ["-c", script, "command-runtime", setsid, marker, release],
      })
      state.child = spawn(wrapped.file, wrapped.args, { detached: true, stdio: "ignore" })
      const child = state.child
      state.completion = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject)
        child.once("exit", resolve)
      })
      state.entry = await CommandRuntime.start(
        {
          projectID,
          sessionID,
          messageID: "message-command-setsid-completion",
          description: "Normal setsid completion regression",
          command: script,
        },
        child,
        () =>
          Shell.killTree(child, {
            exited: () => child.exitCode !== null || child.signalCode !== null,
            detached: true,
          }),
        { windowsRelease: wrapped.release },
      )
      state.pid = Number(await waitText(marker))
      state.identity = await waitIdentity(state.pid)
      expect(state.identity).toMatch(/^[a-f0-9]{64}$/)
      expect(await CredentialProcessLedger.owns(state.pid, state.identity)).toBe(true)

      await Bun.write(release, "release")
      expect(await state.completion).toBe(0)
      await CommandRuntime.settle(state.entry.id)

      expect(await waitGone(state.pid, state.identity)).toBe(true)
      const ledger = (await Bun.file(CredentialProcessLedger.pathForTests()).json()) as Array<{ id?: string }>
      expect(ledger.some((item) => item.id === state.entry?.id)).toBe(false)
      expect(CommandRuntime.list(projectID, sessionID)).toEqual([])
    } finally {
      await Bun.write(release, "release").catch(() => undefined)
      if (state.entry) {
        await CredentialProcessLedger.revoke({ id: state.entry.id, kind: "command", projectID }).catch(() => undefined)
      }
      await CommandRuntime.stopProject(projectID).catch(() => undefined)
      if (state.child && state.child.exitCode === null && state.child.signalCode === null) {
        await Shell.killTree(state.child, {
          exited: () => state.child!.exitCode !== null || state.child!.signalCode !== null,
          detached: true,
        }).catch(() => undefined)
      }
      if (state.pid && state.identity && (await CredentialProcessLedger.owns(state.pid, state.identity))) {
        process.kill(state.pid, "SIGKILL")
      }
      await state.completion?.catch(() => undefined)
      await fs.rm(root, { recursive: true, force: true })
    }
  },
  15_000,
)

posixTest("command completion reaps a same-group background descendant", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-command-descendant-"))
  const marker = path.join(root, "descendant.pid")
  const release = path.join(root, "release")
  const script = [
    'const { spawn } = require("node:child_process")',
    'const fs = require("node:fs")',
    'const child = spawn("sleep", ["600"], { stdio: "ignore" })',
    "fs.writeFileSync(process.argv[1], String(child.pid))",
    "const timer = setInterval(() => {",
    "  if (!fs.existsSync(process.argv[2])) return",
    "  clearInterval(timer)",
    "  process.exit(0)",
    "}, 20)",
  ].join("\n")
  const wrapped = await CommandRuntime.wrap({ file: process.execPath, args: ["-e", script, marker, release] })
  const child = spawn(wrapped.file, wrapped.args, { detached: true, stdio: "ignore" })
  let descendantPID = 0
  let descendantIdentity: string | undefined
  const projectID = `project-command-${crypto.randomUUID()}`
  const sessionID = `session-command-${crypto.randomUUID()}`
  try {
    const entry = await CommandRuntime.start(
      {
        projectID,
        sessionID,
        messageID: "message-background",
        description: "Background descendant regression",
        command: "sleep 600 & exit",
      },
      child,
      () => Shell.killTree(child, { exited: () => child.exitCode !== null, detached: true }),
      { windowsRelease: wrapped.release },
    )
    for (let attempt = 0; attempt < 200 && !(await Bun.file(marker).exists()); attempt++) await Bun.sleep(10)
    descendantPID = Number((await Bun.file(marker).text()).trim())
    descendantIdentity = await CredentialProcessLedger.identity(descendantPID)
    expect(descendantIdentity).toMatch(/^[a-f0-9]{64}$/)
    await Bun.write(release, "release")
    await new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve())
      child.once("error", reject)
    })
    CommandRuntime.finish(entry.id)
    for (let attempt = 0; attempt < 200; attempt++) {
      if (!(await CredentialProcessLedger.owns(descendantPID, descendantIdentity))) break
      await Bun.sleep(10)
    }

    expect(await CredentialProcessLedger.owns(descendantPID, descendantIdentity)).toBe(false)
    expect(CommandRuntime.list(projectID, sessionID)).toEqual([])
  } finally {
    await CommandRuntime.stopProject(projectID).catch(() => undefined)
    if (descendantPID && (await CredentialProcessLedger.owns(descendantPID, descendantIdentity))) {
      process.kill(descendantPID, "SIGKILL")
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await fs.rm(root, { recursive: true, force: true })
  }
})

posixTest("command revocation reaps a direct child that starts a new session", async () => {
  const python = Bun.which("python3")
  if (!python) return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-command-setsid-"))
  const marker = path.join(root, "descendant.pid")
  const script = [
    "import subprocess, sys, time",
    "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(600)'], start_new_session=True)",
    "open(sys.argv[1], 'w').write(str(child.pid))",
    "time.sleep(600)",
  ].join("; ")
  const wrapped = await CommandRuntime.wrap({ file: python, args: ["-c", script, marker] })
  const child = spawn(wrapped.file, wrapped.args, { detached: true, stdio: "ignore" })
  let descendantPID = 0
  let descendantIdentity: string | undefined
  const projectID = `project-command-setsid-${crypto.randomUUID()}`
  try {
    const entry = await CommandRuntime.start(
      {
        projectID,
        sessionID: "session-command-setsid",
        messageID: "message-command-setsid",
        description: "New session descendant regression",
        command: "python start_new_session",
      },
      child,
      () => Shell.killTree(child, { exited: () => child.exitCode !== null, detached: true }),
      { windowsRelease: wrapped.release },
    )
    for (let attempt = 0; attempt < 200 && !(await Bun.file(marker).exists()); attempt++) await Bun.sleep(10)
    expect(await Bun.file(marker).exists()).toBe(true)
    descendantPID = Number((await Bun.file(marker).text()).trim())
    descendantIdentity = await CredentialProcessLedger.identity(descendantPID)
    expect(descendantIdentity).toMatch(/^[a-f0-9]{64}$/)

    expect(await CommandRuntime.stop(entry.id, projectID, "session-command-setsid")).toBe(true)
    expect(await CredentialProcessLedger.owns(descendantPID, descendantIdentity)).toBe(false)
  } finally {
    await CommandRuntime.stopProject(projectID).catch(() => undefined)
    if (descendantPID && (await CredentialProcessLedger.owns(descendantPID, descendantIdentity))) {
      process.kill(descendantPID, "SIGKILL")
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await fs.rm(root, { recursive: true, force: true })
  }
})
