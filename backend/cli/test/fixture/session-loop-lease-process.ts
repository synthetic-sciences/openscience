import fs from "node:fs/promises"
import { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { FileLease } from "../../src/util/file-lease"

const [mode, directory, sessionID, ready, start] = process.argv.slice(2)

if (!mode || !directory || !sessionID || !ready) throw new Error("Missing session-loop lease fixture arguments")

async function wait(filepath: string) {
  const deadline = Date.now() + 10_000
  while (!(await Bun.file(filepath).exists())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filepath}`)
    await Bun.sleep(10)
  }
}

await Instance.provide({
  directory,
  init: async () => {
    await Provider.invalidate()
  },
  fn: async () => {
    if (mode === "hold") {
      await using lease = await FileLease.acquire(SessionPrompt.loopLeasePath(Instance.project.id, sessionID), 60_000)
      await fs.writeFile(ready, String(process.pid))
      await new Promise(() => {})
      void lease
      return
    }

    if (mode !== "loop" || !start) throw new Error(`Unknown session-loop lease fixture mode: ${mode}`)
    await fs.writeFile(ready, String(process.pid))
    await wait(start)
    const result = await SessionPrompt.loop(sessionID)
    await Session.flushPendingParts(sessionID)
    const text = result.parts
      .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic && !part.ignored)
      .map((part) => part.text)
      .join("\n")
    console.log(JSON.stringify({ id: result.info.id, role: result.info.role, text }))
  },
})
