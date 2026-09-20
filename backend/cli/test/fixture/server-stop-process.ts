import fs from "node:fs"
import { Instance } from "../../src/project/instance"
import { KernelProcessIdentity } from "../../src/science/kernel/process"
import { stopServer } from "../../src/cli/server-stop"

/** A server process stopping for real, so the exit code and the output a
 *  supervisor sees are the ones under test. It has to be its own process:
 *  `stopServer` seals this process's update-admission gate on its way through
 *  the graceful disposer, and that seal is deliberately irreversible. */
const [mode, argument, marker] = process.argv.slice(2)

const server = { stop: async () => undefined }

if (mode === "dispose-failure") {
  if (!argument) throw new Error("Expected a project directory")
  const runtime = Instance.state(
    () => ({}),
    async () => {
      throw new Error("the kernel ledger is still busy")
    },
  )
  await Instance.provide({
    directory: argument,
    fn: async () => {
      runtime()
    },
  })
  await stopServer(server)
  process.stdout.write("stopped\n")
} else if (mode === "deadline") {
  // What the kernel tools register when they are imported. A stop cut short
  // at its deadline still has to reap the kernel children.
  if (marker) KernelProcessIdentity.onExit(() => fs.appendFileSync(marker, "kernels released\n"))
  await stopServer(server, { deadlineMs: Number(argument) })
  process.stdout.write("stopped\n")
  // Whatever runs once the command returns — the usage drain, the data-root
  // disposal, the log flush — is what the deadline still has to bound.
  await new Promise(() => setInterval(() => undefined, 1_000))
} else {
  throw new Error(`Unknown mode ${mode}`)
}
