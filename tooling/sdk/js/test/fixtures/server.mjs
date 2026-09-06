import { createServer } from "node:http"
import { writeFileSync } from "node:fs"

const mode = process.env.SDK_FIXTURE_MODE
if (process.env.SDK_FIXTURE_PID) writeFileSync(process.env.SDK_FIXTURE_PID, String(process.pid))
if (mode === "exit") {
  process.stderr.write("fixture refused startup\n")
  process.exit(42)
}
const server = createServer((request, response) => {
  if (mode === "hang-health") return
  if (
    process.env.OPENSCIENCE_AUTH_TOKEN &&
    request.headers.authorization !== `Bearer ${process.env.OPENSCIENCE_AUTH_TOKEN}`
  ) {
    response.writeHead(401).end()
    return
  }
  response.setHeader("content-type", "application/json")
  response.end(
    JSON.stringify({
      healthy: mode !== "unhealthy",
      version: "test",
      cwd: process.cwd(),
      directory: request.headers["x-openscience-directory"],
      marker: process.env.SDK_FIXTURE_MARKER,
      config: JSON.parse(process.env.OPENSCIENCE_CONFIG_CONTENT ?? "{}"),
      arguments: process.argv.slice(2),
    }),
  )
})
server.listen(0, "127.0.0.1", () => {
  if (mode === "timeout") return
  const url = `http://127.0.0.1:${server.address().port}`
  if (mode === "legacy") {
    process.stdout.write(`openscience server listening on ${url}\n`)
    return
  }
  const ready =
    JSON.stringify({
      type: "server.ready",
      schemaVersion: 1,
      pid: mode === "wrong-pid" ? process.pid + 1 : process.pid,
      url: mode === "remote-url" ? "http://example.org" : url,
    }) + "\n"
  process.stdout.write('{"type":"other.log"}\n')
  process.stdout.write(ready.slice(0, 15))
  setTimeout(() => process.stdout.write(ready.slice(15)), 20)
})
process.on("SIGTERM", () => {
  if (mode === "ignore-term") return
  server.closeAllConnections()
  setTimeout(() => {
    if (process.env.SDK_FIXTURE_STOP) writeFileSync(process.env.SDK_FIXTURE_STOP, "closed")
    server.close(() => process.exit(0))
  }, 25)
})
