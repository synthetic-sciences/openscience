import { execFileSync } from "node:child_process"
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

type Options = {
  env?: NodeJS.ProcessEnv
  argv?: string[]
  parent?: () => number
  intervalMs?: number
  identity?: () => { pid: number; started: string; executable: string; command: string }
}

type Binding = {
  pid: number
  token: string
  exited: Promise<void>
  parent: () => number
  timer: ReturnType<typeof setInterval> | undefined
  settle: () => void
  adopted: boolean
}

let bootstrapped: Binding | undefined

const control = ["OPENSCIENCE_DESKTOP_PARENT_", "OPENSCIENCE_DESKTOP_UPDATE_"]

function configured(options: Options) {
  const env = options.env ?? process.env
  const rawPID = env.OPENSCIENCE_DESKTOP_PARENT_PID
  const token = env.OPENSCIENCE_DESKTOP_PARENT_TOKEN
  if (!rawPID && !token) return
  const pid = Number(rawPID)
  if (!Number.isSafeInteger(pid) || pid <= 1 || !/^[0-9a-f]{48}$/.test(token ?? "")) {
    throw new Error("The desktop parent binding is invalid")
  }
  return { env, pid, token: token!, parent: options.parent ?? (() => process.ppid) }
}

function processIdentity() {
  const started = execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "lstart="], {
    encoding: "utf8",
  }).trim()
  const command = execFileSync("/bin/ps", ["-ww", "-p", String(process.pid), "-o", "command="], {
    encoding: "utf8",
  }).trim()
  const executable = path.resolve(process.execPath)
  if (!started || (command !== executable && !command.startsWith(`${executable} `))) {
    throw new Error("OpenScience could not bind its desktop runtime process identity")
  }
  return { pid: process.pid, started, executable, command }
}

function runtimeReceipt(
  env: NodeJS.ProcessEnv,
  pid: number,
  token: string,
  identity: () => { pid: number; started: string; executable: string; command: string },
) {
  const file = env.OPENSCIENCE_DESKTOP_PARENT_RUNTIME_RECEIPT
  const updateToken = env.OPENSCIENCE_DESKTOP_PARENT_UPDATE_TOKEN
  const version = env.OPENSCIENCE_DESKTOP_PARENT_UPDATE_VERSION
  if (!file && !updateToken && !version) return
  if (
    !file ||
    !path.isAbsolute(file) ||
    path.normalize(file) !== file ||
    !/^[0-9a-f]{48}$/.test(updateToken ?? "") ||
    !/^\d+\.\d+\.\d+$/.test(version ?? "") ||
    path.basename(file) !== `runtime-${updateToken}.json`
  ) {
    throw new Error("The desktop update runtime receipt is invalid")
  }
  const temporary = `${file}.tmp-${process.pid}`
  writeFileSync(
    temporary,
    `${JSON.stringify({
      schema: 1,
      token: updateToken,
      version,
      parent: pid,
      service_identity: identity(),
      started_at: new Date().toISOString(),
    })}\n`,
    { mode: 0o600 },
  )
  const handle = openSync(temporary, "r")
  try {
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  renameSync(temporary, file)
  const directory = openSync(path.dirname(file), "r")
  try {
    fsyncSync(directory)
  } finally {
    closeSync(directory)
  }
}

function binding(options: Options): Binding | undefined {
  const value = configured(options)
  if (!value) return
  if (value.parent() !== value.pid) throw new Error("The desktop sidecar was not launched by its bound parent")
  let settle: () => void = () => {}
  const exited = new Promise<void>((resolve) => {
    settle = resolve
  })
  const result: Binding = {
    pid: value.pid,
    token: value.token,
    exited,
    parent: value.parent,
    timer: undefined,
    settle,
    adopted: false,
  }
  runtimeReceipt(value.env, value.pid, value.token, options.identity ?? processIdentity)
  result.timer = setInterval(() => {
    if (result.parent() === result.pid) return
    if (result.timer) clearInterval(result.timer)
    result.timer = undefined
    if (result.adopted) result.settle()
    else process.exit(1)
  }, options.intervalMs ?? 100)
  result.timer.unref?.()
  return result
}

/** Bind the packaged desktop sidecar to the Electron process that launched it.
 * On POSIX a direct child is re-parented as soon as its exact parent exits, so
 * `process.ppid` avoids PID-reuse ambiguity without polling an unrelated path
 * or trusting model-visible environment state. */
export namespace DesktopParent {
  /** Consume desktop authority only for the Electron-owned server. Internal
   * Darwin launchers re-enter the compiled executable to supervise terminals
   * and kernels, and native PTY implementations may retain variables omitted
   * from their requested child environment. Those descendants are not desktop
   * sidecars: remove inherited control-plane authority before loading the CLI
   * graph instead of comparing their immediate parent with Electron. */
  export function launch(options: Options = {}) {
    const env = options.env ?? process.env
    const argv = options.argv ?? process.argv
    if (argv[2] === "serve") return bootstrap(options)
    for (const key of Object.keys(env)) {
      if (control.some((prefix) => key.startsWith(prefix))) delete env[key]
    }
  }

  /** Start the parent-death guard before importing the full CLI graph. A
   * parent that disappears during configuration/provider initialization must
   * not leave an unowned sidecar behind. */
  export function bootstrap(options: Options = {}) {
    if (bootstrapped) return bootstrapped
    bootstrapped = binding(options)
    return bootstrapped
  }

  export function watch(options: Options = {}) {
    const current = bootstrapped ?? binding(options)
    if (!current) return
    if (current.parent() !== current.pid) throw new Error("The desktop sidecar parent exited before startup completed")
    current.adopted = true
    return {
      pid: current.pid,
      token: current.token,
      exited: current.exited,
      [Symbol.dispose]() {
        if (current.timer) clearInterval(current.timer)
        current.timer = undefined
        current.settle()
        if (bootstrapped === current) bootstrapped = undefined
      },
    }
  }
}
