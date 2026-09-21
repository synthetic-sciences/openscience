import { readFile, writeFile } from "node:fs/promises"
import net from "node:net"

/** Listen on `candidate` (0 asks the system for any free port) and hand the
 * port back, or undefined when it cannot be bound.
 * @param {number} candidate
 * @returns {Promise<number | undefined>} */
function bind(candidate) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.on("error", () => resolve(undefined))
    server.listen(candidate, "127.0.0.1", () => {
      const address = server.address()
      const selected = typeof address === "object" && address ? address.port : undefined
      server.close(() => resolve(selected))
    })
  })
}

/** The port the local runtime serves the workspace on.
 *
 * The workspace keeps what a person set up in the window (the selected model,
 * recent and pinned models, open tabs, panel layout) in browser storage, and
 * browser storage belongs to the origin. A fresh port on every launch was a
 * fresh origin, so the app reopened with none of it, and a composer that had
 * been on the person's own key fell back to the default model. The last port
 * is remembered in `file` and reused while it is free; only when something
 * else holds it does the runtime move, and the new port is remembered.
 * @param {string} file
 * @returns {Promise<number>} */
export async function servicePort(file) {
  const remembered = await readFile(file, "utf8")
    .then((text) => JSON.parse(text).port)
    .catch(() => undefined)
  if (Number.isInteger(remembered) && remembered > 1023 && remembered < 65536) {
    const held = await bind(remembered)
    if (held) return held
  }
  const selected = await bind(0)
  if (!selected) throw new Error("No local port is available for the OpenScience runtime")
  await writeFile(file, JSON.stringify({ port: selected }) + "\n").catch(() => undefined)
  return selected
}
