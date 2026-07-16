import { expect, test } from "bun:test"
import { spawn } from "child_process"
import { Shell } from "../../src/shell/shell"

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function gone(pid: number) {
  const end = Date.now() + 2_000
  while (Date.now() < end) {
    if (!alive(pid)) return
    await Bun.sleep(20)
  }
  expect(alive(pid)).toBe(false)
}

test("killTree reaps a detached leader and worker that ignore SIGTERM", async () => {
  if (process.platform === "win32") return

  const child = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
  const leader = [
    `const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(child)}], { stdout: "ignore", stderr: "ignore" })`,
    "console.log(child.pid)",
    "process.on('SIGTERM', () => {})",
    "setInterval(() => {}, 1000)",
  ].join(";")
  const proc = spawn(process.execPath, ["-e", leader], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  })
  const timer = setTimeout(() => {
    if (!proc.pid) return
    try {
      process.kill(-proc.pid, "SIGKILL")
    } catch {}
  }, 5_000)
  const pid = await new Promise<number>((resolve, reject) => {
    proc.once("error", reject)
    proc.stdout?.once("data", (data) => resolve(Number(data.toString().trim())))
  })

  await Shell.killTree(proc, { detached: true, exited: () => proc.exitCode !== null })
  await Promise.all([gone(proc.pid!), gone(pid)])
  clearTimeout(timer)
})
