import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CredentialProcessLedger } from "../../src/credentials/process-ledger"
import { Instance } from "../../src/project/instance"
import { WindowsJobLauncher } from "../../src/process/windows-job-launcher"
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
  const wrapped = WindowsJobLauncher.wrap({
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

posixTest("command completion reaps a same-group background descendant", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-command-descendant-"))
  const marker = path.join(root, "descendant.pid")
  const release = path.join(root, "release")
  const wrapped = WindowsJobLauncher.wrap({
    file: "/bin/sh",
    args: [
      "-c",
      'sleep 600 & printf "%s" "$!" > "$1"; while [ ! -f "$2" ]; do sleep 0.02; done; exit 0',
      "command-runtime",
      marker,
      release,
    ],
  })
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
  const wrapped = WindowsJobLauncher.wrap({ file: python, args: ["-c", script, marker] })
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
