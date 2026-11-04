import { expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"

test("a new runtime recalls automatically saved project context without a remember request", async () => {
  await using tmp = await tmpdir()
  for (const phase of ["record", "recall", "queued"]) {
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "../fixture/project-memory-prompt.ts"), tmp.path, phase],
      {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const timeout = setTimeout(() => child.kill(), 90_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ code, error: code ? stderr : "" }).toEqual({ code: 0, error: "" })
      expect(stdout).toContain(`project-memory:${phase}:ok`)
    } finally {
      clearTimeout(timeout)
      if (child.exitCode === null) child.kill()
    }
  }
}, 200_000)
