import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { AuthorityProcessLedger } from "../../src/project/authority-process"
import { Session } from "../../src/session"
import {
  NotebookTool,
  biologyKernelScriptForTests,
  releaseBiologySession,
  shutdownBiologyKernels,
} from "../../src/tool/biology/notebook"
import { tmpdir, trustProject } from "../fixture/fixture"

const context = (sessionID: string) => ({
  sessionID,
  messageID: "message_biology_concurrency",
  callID: `call_${crypto.randomUUID()}`,
  agent: "biology",
  abort: new AbortController().signal,
  messages: [],
  metadata() {},
  async ask() {},
})

async function entries(sessionID: string) {
  return Bun.file(AuthorityProcessLedger.pathForTests())
    .json()
    .then(
      (value) =>
        (value as Array<{ kind: string; owner_pid: number; project_id: string; session_id: string }>).filter(
          (entry) =>
            entry.kind === "biology" &&
            entry.owner_pid === process.pid &&
            entry.project_id === Instance.project.id &&
            entry.session_id === sessionID,
        ),
      () => [],
    )
}

test("legacy biology worker exits cleanly when its parent closes stdin", async () => {
  const python = Bun.which("python3") ?? Bun.which("python")
  if (!python) return
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-biology-eof-"))
  const script = path.join(directory, "worker.py")
  await Bun.write(script, biologyKernelScriptForTests())
  const proc = spawn(python, ["-u", script], { stdio: ["pipe", "pipe", "pipe"] })
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("biology worker did not become ready")), 5_000)
      const onData = (chunk: Buffer) => {
        if (!chunk.toString().includes("__OPENSCIENCE_KERNEL_READY__")) return
        clearTimeout(timeout)
        proc.stdout.off("data", onData)
        resolve()
      }
      proc.stdout.on("data", onData)
      proc.once("error", reject)
    })
    proc.stdin.end()
    const code = await Promise.race([
      new Promise<number | null>((resolve) => proc.once("exit", resolve)),
      Bun.sleep(2_000).then(() => "timeout" as const),
    ])
    expect(code).toBe(0)
  } finally {
    if (proc.exitCode === null) proc.kill("SIGKILL")
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("legacy biology serializes first-kernel creation and cell results per session", async () => {
  if (process.platform === "win32") return
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const session = await Session.create({})
      const tool = await NotebookTool.init()
      try {
        const [bootOne, bootTwo] = await Promise.all([
          tool.execute({ code: "print('boot-one')", timeout: 30_000 }, context(session.id)),
          tool.execute({ code: "print('boot-two')", timeout: 30_000 }, context(session.id)),
        ])
        expect(bootOne.output.trim()).toBe("boot-one")
        expect(bootTwo.output.trim()).toBe("boot-two")
        expect(await entries(session.id)).toHaveLength(1)

        const [slow, fast] = await Promise.all([
          tool.execute(
            { code: "import time\ntime.sleep(0.2)\nprint('slow-result')", timeout: 30_000 },
            context(session.id),
          ),
          tool.execute({ code: "print('fast-result')", timeout: 30_000 }, context(session.id)),
        ])
        expect(slow.output.trim()).toBe("slow-result")
        expect(fast.output.trim()).toBe("fast-result")
        expect(await entries(session.id)).toHaveLength(1)
      } finally {
        await releaseBiologySession(Instance.project.id, session.id)
        await Session.remove(session.id)
      }
      expect(await entries(session.id)).toHaveLength(0)
    },
  })
  shutdownBiologyKernels()
}, 60_000)
