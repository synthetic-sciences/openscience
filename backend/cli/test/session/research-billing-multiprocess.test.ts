import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

function isolatedEnv(root: string) {
  return {
    ...process.env,
    OPENSCIENCE_DATA_DIR: path.join(root, "data"),
    OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
    OPENSCIENCE_TEST_HOME: path.join(root, "home"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config-xdg"),
    XDG_DATA_HOME: path.join(root, "data-xdg"),
    XDG_STATE_HOME: path.join(root, "state-xdg"),
  }
}

async function waitFor(filepath: string, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (!(await Bun.file(filepath).exists())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filepath}`)
    await Bun.sleep(10)
  }
}

async function result(proc: {
  exited: Promise<number>
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
}) {
  const [exit, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (exit !== 0) throw new Error(`Research billing worker exited ${exit}: ${stderr}`)
  const line = stdout
    .trim()
    .split("\n")
    .findLast((item) => item.trim().startsWith("{"))
  if (!line) throw new Error(`Research billing worker returned no JSON: ${stdout}\n${stderr}`)
  return JSON.parse(line) as Record<string, unknown>
}

test("independent processes atomically reserve one Ace finalization call", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-research-billing-race-"))
  const runner = path.join(root, "research-billing-worker.ts")
  const research = new URL("../../src/session/research.ts", import.meta.url).href
  const sessionID = `session-${crypto.randomUUID()}`
  const start = path.join(root, "workers.start")
  const total = 6

  await Bun.write(
    runner,
    `
import fs from "node:fs/promises"
import { SessionResearch } from ${JSON.stringify(research)}

const [mode, sessionID, marker, ready] = process.argv.slice(2)
if (!mode || !sessionID) throw new Error("Missing research billing worker arguments")

async function wait(filepath) {
  const deadline = Date.now() + 10_000
  while (!(await Bun.file(filepath).exists())) {
    if (Date.now() >= deadline) throw new Error(\`Timed out waiting for \${filepath}\`)
    await Bun.sleep(10)
  }
}

if (mode === "seed") {
  const contract = await SessionResearch.define(sessionID, {
    objective: "Preserve one truthful result before Ace is exhausted",
    domain: "general",
    template: "minimal",
    reserveUsd: 1,
  })
  await SessionResearch.stage(sessionID, { id: contract.stages[0].id, status: "running" })
  console.log(JSON.stringify({ seeded: true }))
} else if (mode === "preflight") {
  if (!marker || !ready) throw new Error("Missing synchronization paths")
  await fs.writeFile(ready, String(process.pid))
  await wait(marker)
  console.log(JSON.stringify({ decision: await SessionResearch.preflight(sessionID, 0.5) }))
} else if (mode === "read") {
  console.log(JSON.stringify({ budget: (await SessionResearch.read(sessionID))?.budget }))
} else {
  throw new Error(\`Unknown mode: \${mode}\`)
}
`,
  )

  const spawn = (...args: string[]) =>
    Bun.spawn([process.execPath, runner, ...args], {
      env: isolatedEnv(root),
      stdout: "pipe",
      stderr: "pipe",
    })

  try {
    expect(await result(spawn("seed", sessionID))).toEqual({ seeded: true })

    const ready = Array.from({ length: total }, (_, index) => path.join(root, `worker-${index}.ready`))
    const workers = ready.map((filepath) => spawn("preflight", sessionID, start, filepath))
    await Promise.all(ready.map((filepath) => waitFor(filepath)))
    await fs.writeFile(start, "start")

    const decisions = (await Promise.all(workers.map(result))).map((item) => item.decision)
    expect(decisions.filter((decision) => decision === "finalize")).toHaveLength(1)
    expect(decisions.filter((decision) => decision === "block")).toHaveLength(total - 1)

    const stored = await result(spawn("read", sessionID))
    expect(stored.budget).toMatchObject({
      finalizationCalls: 1,
      finalizing: false,
      exhausted: true,
      lastBalanceUsd: 0.5,
    })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}, 20_000)
