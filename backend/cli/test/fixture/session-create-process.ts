import fs from "node:fs/promises"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"

const [directory, sessionID, title, ready, start] = process.argv.slice(2)

if (!directory || !sessionID || !title || !ready || !start) {
  throw new Error("Missing session-create fixture arguments")
}

async function wait(filepath: string) {
  const deadline = Date.now() + 10_000
  while (!(await Bun.file(filepath).exists())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filepath}`)
    await Bun.sleep(10)
  }
}

await Instance.provide({
  directory,
  fn: async () => {
    await fs.writeFile(ready, String(process.pid))
    await wait(start)
    console.log(JSON.stringify(await Session.create({ id: sessionID, title })))
  },
})
