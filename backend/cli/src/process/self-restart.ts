import z from "zod"

export const SELF_RESTART_ARG = "--openscience-self-restart"

const Payload = z.object({
  command: z.string().array().min(1).max(64),
  cwd: z.string().min(1),
  parent: z.number().int().positive(),
})

type Payload = z.infer<typeof Payload>

const state: { scheduled?: boolean } = {}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function command(argv = process.argv, executable = process.execPath) {
  const entry = argv[1]
  const prefix = entry && entry !== executable ? [executable, entry] : [executable]
  return [...prefix, ...argv.slice(2)]
}

function encode(payload: Payload) {
  return Buffer.from(JSON.stringify(Payload.parse(payload))).toString("base64url")
}

function decode(value: string) {
  return Payload.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")))
}

async function wait(pid: number, attempt = 0): Promise<void> {
  if (!alive(pid)) return
  if (attempt >= 300) throw new Error(`OpenScience ${pid} did not stop before restart`)
  await Bun.sleep(100)
  return wait(pid, attempt + 1)
}

export namespace SelfRestart {
  export function payload(argv = process.argv, executable = process.execPath, cwd = process.cwd()): Payload {
    return { command: command(argv, executable), cwd, parent: process.pid }
  }

  export function schedule(delay = 350) {
    if (state.scheduled) return true
    state.scheduled = true
    const value = payload()
    const timer = setTimeout(() => {
      const prefix = value.command.slice(0, value.command.length - process.argv.slice(2).length)
      const helper = Bun.spawn([...prefix, SELF_RESTART_ARG, encode(value)], {
        cwd: value.cwd,
        env: process.env,
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      })
      helper.unref()
      const stop = setTimeout(() => process.kill(process.pid, "SIGTERM"), 100)
      stop.unref?.()
    }, delay)
    timer.unref?.()
    return true
  }

  export async function run(value: string) {
    const payload = decode(value)
    await wait(payload.parent)
    const child = Bun.spawn(payload.command, {
      cwd: payload.cwd,
      env: { ...process.env, OPENSCIENCE_RESTARTED: "1" },
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    child.unref()
    return 0
  }
}
