import { dlopen, FFIType } from "bun:ffi"
import fs from "node:fs/promises"
import path from "node:path"
import { DarwinResponsibilityLauncher } from "../process/darwin-responsibility-launcher"

export const GROUP_LAUNCHER_ARG = "__openscience_mcp_group_launcher__"

export function invocation(input: {
  execPath: string
  sourceEntry: string
  ready: string
  file: string
  args: string[]
}): { command: string; args: string[]; release?: string } {
  if (process.platform === "darwin") {
    const wrapped = DarwinResponsibilityLauncher.wrap({
      file: input.file,
      args: input.args,
      ready: input.ready,
      ownSession: true,
    })
    return { command: wrapped.file, args: wrapped.args, release: wrapped.release }
  }
  const executable = path.basename(input.execPath).toLowerCase()
  const sourceRuntime = executable === "bun" || executable === "bun.exe"
  return {
    command: input.execPath,
    // A compiled OpenScience executable re-enters its bundled index directly.
    // A source checkout must first tell Bun which entrypoint to execute.
    args: [...(sourceRuntime ? [input.sourceEntry] : []), GROUP_LAUNCHER_ARG, input.ready, input.file, ...input.args],
    ...(process.platform === "win32" ? { release: `${input.ready}.release` } : {}),
  }
}

function systemLibraries(): string[] {
  if (process.platform === "darwin") return ["/usr/lib/libSystem.B.dylib"]
  if (process.arch === "arm64") {
    return ["libc.so.6", "/lib/aarch64-linux-gnu/libc.so.6", "/lib/libc.musl-aarch64.so.1"]
  }
  return ["libc.so.6", "/lib/x86_64-linux-gnu/libc.so.6", "/lib64/libc.so.6", "/lib/libc.musl-x86_64.so.1"]
}

export async function run(args: string[]): Promise<number> {
  const [ready, file, ...commandArgs] = args
  if (!ready || !file) throw new Error("The MCP process-group launcher requires a ready marker and command")
  if (process.platform === "win32") {
    await fs.writeFile(ready, String(process.pid), { encoding: "utf8", flag: "wx", mode: 0o600 })
    const release = `${ready}.release`
    try {
      for (let attempt = 0; attempt < 3_000; attempt++) {
        const owner = await fs.readFile(release, "utf8").catch(() => undefined)
        if (owner?.trim() === String(process.pid)) break
        if (attempt === 2_999) throw new Error("Timed out waiting for Windows Job Object ownership")
        await Bun.sleep(10)
      }
      const child = Bun.spawn([file, ...commandArgs], {
        cwd: process.cwd(),
        env: process.env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        windowsHide: true,
      })
      return child.exited
    } finally {
      await fs.rm(release, { force: true }).catch(() => undefined)
    }
  }

  let libc: ReturnType<typeof dlopen> | undefined
  let lastError: unknown
  for (const library of systemLibraries()) {
    try {
      libc = dlopen(library, { setsid: { args: [], returns: FFIType.i32 } })
      break
    } catch (error) {
      lastError = error
    }
  }
  if (!libc) throw lastError ?? new Error("Could not load the host C library for setsid()")
  const setsid = libc.symbols.setsid as unknown as () => number
  const session = setsid()
  libc.close()
  if (session !== process.pid) {
    throw new Error(`Could not establish an owned MCP process group (setsid returned ${session})`)
  }
  await fs.writeFile(ready, String(process.pid), { encoding: "utf8", flag: "wx", mode: 0o600 })

  const child = Bun.spawn([file, ...commandArgs], {
    cwd: process.cwd(),
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })

  const forward = (signal: NodeJS.Signals) => {
    process.removeAllListeners(signal)
    try {
      process.kill(-process.pid, signal)
    } catch {
      child.kill(signal)
    }
  }
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => forward(signal))
  }

  return child.exited
}
