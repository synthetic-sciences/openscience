import { expect, test } from "bun:test"
import path from "node:path"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../fixture/fixture"
import { spawn } from "../fixture/spawn"

test("stats evidence uses an isolated data root even when earlier tests leave sessions", async () => {
  await using tmp = await tmpdir()
  const project = `prj_stats_unrelated_${crypto.randomUUID()}`
  const session = `ses_stats_unrelated_${crypto.randomUUID()}`
  const key = ["session", project, session]
  const record = { id: session, projectID: project, time: { created: Date.now(), updated: Date.now() } }
  await Storage.write(["project", project], { id: project })
  await Storage.write(key, record)

  // Storage chooses its data root at import time. A child gives the global
  // aggregation tests an empty database regardless of earlier suite fixtures.
  const child = spawn([process.execPath, "test", "--timeout", "12000", "./test/fixture/stats-evidence.ts"], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: { OPENSCIENCE_DATA_DIR: path.join(tmp.path, "data") },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 13_000,
    killSignal: "SIGKILL",
  })
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, output: code === 0 ? undefined : stdout + stderr }).toEqual({ code: 0, output: undefined })
    expect(stderr).toContain("4 pass")
    expect(await Storage.read(key)).toEqual(record)
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
    await Storage.remove(key)
    await Storage.remove(["project", project])
  }
})
