import fs from "node:fs/promises"
import { Agent } from "../../src/agent/agent"
import { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { TaskAttempt, TaskCapacity } from "../../src/tool/task-attempt"
import { TaskTool } from "../../src/tool/task"
import { LockCoordination } from "../../src/util/lock-coordination"

const [mode, directory, parentID, messageID, callID, ready] = process.argv.slice(2)
const attemptAge = Number(process.env.OPENSCIENCE_TEST_TASK_ATTEMPT_AGE_MS)

if (!mode || !ready) throw new Error("Missing durable Task fixture arguments")

async function wait(filepath: string) {
  while (!(await Bun.file(filepath).exists())) await Bun.sleep(10)
}

if (mode === "loop-parent") {
  if (!directory || !parentID || !messageID) throw new Error("Missing parent loop fixture arguments")
  await fs.writeFile(ready, String(process.pid))
  await wait(messageID)
  await Instance.provide({
    directory,
    init: async () => {
      await Provider.invalidate()
    },
    fn: async () => {
      const result = await SessionPrompt.loop(parentID)
      const output = result.parts
        .filter((part): part is MessageV2.TextPart => part.type === "text")
        .map((part) => part.text)
        .join("\n")
      console.log(
        JSON.stringify({ title: "Recovered parent", metadata: { sessionId: parentID, startedAt: 0 }, output }),
      )
    },
  })
} else if (mode === "active-block" || mode === "active-resume") {
  if (!directory || !parentID || !messageID || !callID) throw new Error("Missing Task accounting fixture arguments")
  await Instance.provide({
    directory,
    fn: async () => {
      const identity = {
        projectID: Instance.project.id,
        parentSessionID: parentID,
        parentMessageID: messageID,
        parentUserMessageID: messageID,
        callID,
      }
      const params = {
        description: "Durable active budget fixture",
        prompt: "Exercise active-only budget accounting.",
        subagent_type: "execute",
      }
      await TaskAttempt.reserve({
        ...identity,
        fingerprint: TaskAttempt.fingerprint(params),
        legacyFingerprint: TaskAttempt.legacyFingerprint(params),
      })
      const settled = await TaskAttempt.settle(identity)
      if (mode === "active-resume") {
        console.log(
          JSON.stringify({
            title: "Recovered active budget",
            metadata: {
              sessionId: settled.childSessionID,
              startedAt: settled.createdAt,
              activeMs: settled.activeMs ?? 0,
              remainingMs: TaskAttempt.remaining(settled, 300),
            },
            output: "ACTIVE_BUDGET_RECOVERED",
          }),
        )
        return
      }
      const token = crypto.randomUUID()
      await TaskAttempt.activate({ ...identity, token })
      setInterval(() => void TaskAttempt.pulse({ ...identity, token }), 50)
      await fs.writeFile(ready, String(process.pid))
      await new Promise(() => {})
    },
  })
} else if (mode === "hold-cap-claim") {
  await using claim = await LockCoordination.claim(TaskCapacity.slotPath("child", 0), 5_000)
  await fs.writeFile(ready, String(process.pid))
  await new Promise(() => {})
  void claim
} else if (mode === "hold-cap-intent") {
  await using intent = await LockCoordination.intent(TaskCapacity.slotPath("child", 0), 5_000)
  await fs.writeFile(ready, String(process.pid))
  await new Promise(() => {})
  void intent
} else if (mode === "replace-cap") {
  const slot = TaskCapacity.slotPath("child", 0)
  const aside = `${slot}.${crypto.randomUUID()}.dead`
  await fs.rename(slot, aside)
  await fs.rm(aside, { force: true })
  const handle = await fs.open(slot, "wx", 0o600)
  await handle.writeFile(JSON.stringify({ pid: process.pid, token: crypto.randomUUID(), created: Date.now() }))
  await handle.sync()
  await fs.writeFile(ready, String(process.pid))
  await new Promise(() => {})
  void handle
} else if (mode === "hold-cap" || mode === "take-cap") {
  await using slot = await TaskCapacity.acquire("child", 1)
  await fs.writeFile(ready, String(process.pid))
  if (mode === "hold-cap") await new Promise(() => {})
  console.log(JSON.stringify({ acquired: true }))
  void slot
} else {
  if (!directory || !parentID || !messageID || !callID) throw new Error("Missing Task execution fixture arguments")

  await Instance.provide({
    directory,
    init: async () => {
      await Provider.invalidate()
    },
    fn: async () => {
      const agent = await Agent.get("research")
      if (!agent) throw new Error("Research agent is unavailable")
      const task = await TaskTool.init({ agent })
      const messages = await Session.messages({ sessionID: parentID })
      const blocked = { value: false }
      const now = Date.now.bind(Date)
      if (Number.isSafeInteger(attemptAge) && attemptAge > 0) Date.now = () => now() - attemptAge
      const result = await task.execute(
        {
          description: "Durable restart fixture",
          prompt: "Return the deterministic child result.",
          subagent_type: "execute",
        },
        {
          sessionID: parentID,
          messageID,
          callID,
          agent: "research",
          abort: new AbortController().signal,
          messages,
          extra: { bypassAgentCheck: true, effort: "normal" },
          async metadata(input) {
            if (!blocked.value) {
              blocked.value = true
              // Only the durable reservation is aged. Restore the real clock
              // before active provider work so activeMs stays authoritative.
              Date.now = now
              await fs.writeFile(ready, JSON.stringify(input.metadata ?? {}))
              if (mode === "bind-block") await new Promise(() => {})
            }
          },
          async ask() {},
        },
      )
      console.log(JSON.stringify(result))
    },
  })
}
