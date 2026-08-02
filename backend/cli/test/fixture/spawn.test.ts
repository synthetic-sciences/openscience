import { expect, test } from "bun:test"
import os from "os"
import { spawn } from "./spawn"

// Bun.spawn defaults to the environment the process was started with, so the XDG
// overrides preload assigns at runtime never reached a child. Children that boot
// the CLI wrote projects and sessions into the developer's real
// ~/.local/share/openscience, which showed up as phantom entries on their home list.
test("gives a spawned child the sandboxed data directory", async () => {
  const proc = spawn([process.execPath, "-e", "process.stdout.write(process.env.XDG_DATA_HOME ?? '')"], {
    stdout: "pipe",
  })
  const output = await new Response(proc.stdout).text()
  await proc.exited

  expect(output).toBe(process.env["XDG_DATA_HOME"]!)
  expect(output).not.toStartWith(os.homedir())
})

test("keeps caller overrides on top of the sandboxed environment", async () => {
  const proc = spawn(
    [process.execPath, "-e", "process.stdout.write(`${process.env.HOME}|${process.env.XDG_DATA_HOME}`)"],
    {
      stdout: "pipe",
      env: { HOME: "/tmp/elsewhere" },
    },
  )
  const output = await new Response(proc.stdout).text()
  await proc.exited

  expect(output).toBe(`/tmp/elsewhere|${process.env["XDG_DATA_HOME"]}`)
})
