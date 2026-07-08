import path from "path"
import os from "os"
import fs from "fs"
import { spawn, spawnSync } from "child_process"
import { lazy } from "@/util/lazy"
import { Log } from "@/util/log"
import { Shell } from "@/shell/shell"

const log = Log.create({ service: "sandbox" })

/**
 * OS-level execution sandbox for the agent's shell commands.
 *
 * The permission system decides *whether* a command runs; it is an approval
 * layer, not an isolation boundary — an approved (or auto-approved) command
 * otherwise executes with the full authority of the user running OpenScience.
 * This module adds the missing boundary: it wraps the command in a real OS
 * sandbox so that, regardless of what the command tries to do, it cannot write
 * outside the workspace (plus temp dirs) and — optionally — cannot reach the
 * network.
 *
 *   - macOS  → Seatbelt via `sandbox-exec` (an SBPL profile).
 *   - Linux  → `bubblewrap` (bwrap) mount namespaces.
 *   - other  → no backend; the caller decides whether to warn, error, or run.
 *
 * The model is deliberately *write-containment* (allow-by-default, deny writes
 * outside an allowlist, optionally deny network) rather than a deny-by-default
 * syscall jail: research workflows run arbitrary compilers, package managers and
 * interpreters, and a strict jail would break far more than it protects. Reads
 * stay open; the threat this stops is tampering with files outside the workspace
 * (`~/.ssh`, `~/.bashrc`, other projects) and, in network-deny mode, silent
 * exfiltration.
 */
export namespace Sandbox {
  export type Backend = "seatbelt" | "bubblewrap" | "none"

  export interface Policy {
    /** Absolute paths the sandboxed process may write to. */
    writable: string[]
    /** Whether the sandboxed process may reach the network. */
    network: boolean
  }

  /** A ready-to-spawn argv: `spawn(file, args)` with no shell wrapping. */
  export interface Spec {
    file: string
    args: string[]
  }

  /** User-facing config knobs (mirrors Config.Sandbox, kept dependency-free). */
  export interface Options {
    enabled?: boolean
    network?: "allow" | "deny"
    allowWrite?: string[]
    onUnavailable?: "warn" | "error" | "allow"
  }

  export interface Plan {
    /** Program to spawn. */
    file: string
    /** Args when running sandboxed; undefined when running the raw command. */
    args?: string[]
    /** `shell` option to pass to spawn (a shell path for the raw command, else false). */
    useShell: string | false
    /** True when the command is wrapped in an OS sandbox. */
    sandboxed: boolean
    backend: Backend
    /** One-time human-readable note (e.g. sandbox requested but unavailable). */
    warning?: string
  }

  /** Result of wrapping a raw argv (used by the notebook/R kernels). */
  export interface Wrapped {
    /** Program to spawn — the backend wrapper when sandboxed, else the original file. */
    file: string
    /** Args to spawn — the original argv is preserved at the tail when sandboxed. */
    args: string[]
    sandboxed: boolean
    backend: Backend
    warning?: string
  }

  export class UnavailableError extends Error {
    constructor(message: string) {
      super(message)
      this.name = "SandboxUnavailableError"
    }
  }

  // ── backend detection ───────────────────────────────────────────────────────

  function probeBubblewrap(bin: string): boolean {
    // bwrap can exist yet fail at runtime when unprivileged user namespaces are
    // disabled (kernel.unprivileged_userns_clone=0, some hardened distros), and
    // --unshare-pid needs a usable PID namespace. Probe with the same namespace
    // ops the real sandbox uses so detection matches enforcement.
    try {
      const res = spawnSync(
        bin,
        ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-pid", "--", "true"],
        { stdio: "ignore", timeout: 5000 },
      )
      return res.status === 0
    } catch {
      return false
    }
  }

  const detected = lazy<Backend>(() => {
    if (process.platform === "darwin") {
      return Bun.which("sandbox-exec") ? "seatbelt" : "none"
    }
    if (process.platform === "linux") {
      const bin = Bun.which("bwrap")
      if (!bin) return "none"
      return probeBubblewrap(bin) ? "bubblewrap" : "none"
    }
    return "none"
  })

  /** The sandbox backend usable on this machine right now, or "none". */
  export function backend(): Backend {
    return detected()
  }

  export function available(): boolean {
    return backend() !== "none"
  }

  /** Backend + platform summary for status output (CLI `doctor`, GUI panel). */
  export function describe(): {
    platform: NodeJS.Platform
    backend: Backend
    available: boolean
    tool?: string
    reason?: string
  } {
    const b = backend()
    if (b === "seatbelt") return { platform: process.platform, backend: b, available: true, tool: "sandbox-exec" }
    if (b === "bubblewrap") return { platform: process.platform, backend: b, available: true, tool: "bwrap" }
    const reason =
      process.platform === "darwin"
        ? "sandbox-exec not found on PATH"
        : process.platform === "linux"
          ? "bubblewrap (bwrap) is not installed, or unprivileged user namespaces are disabled"
          : `no sandbox backend for platform "${process.platform}"`
    return { platform: process.platform, backend: "none", available: false, reason }
  }

  // ── writable-path assembly ──────────────────────────────────────────────────

  /** Temp dirs a sandboxed command legitimately needs to write to. */
  export function tempDirs(): string[] {
    const dirs = new Set<string>()
    const add = (d?: string | null) => {
      if (d) dirs.add(d)
    }
    add(process.env.TMPDIR)
    add(process.env.TMP)
    add(process.env.TEMP)
    add(os.tmpdir())
    add("/tmp")
    if (process.platform === "darwin") add("/private/tmp")
    return [...dirs]
  }

  function dedupe(paths: string[]): string[] {
    const out = new Set<string>()
    for (const p of paths) {
      if (p) out.add(path.resolve(p))
    }
    return [...out]
  }

  /**
   * A path too broad to ever be a sandbox writable root: granting write here
   * would hand back most of the filesystem and defeat containment. Guards
   * against a project/worktree opened at "/" and against `TMPDIR`/`allowWrite`
   * pointing at `$HOME`, `/etc`, etc. Subdirectories of these (e.g. a real
   * project under `$HOME/code/foo`) are fine — only the roots themselves are
   * refused.
   */
  function tooBroadToConfine(p: string): boolean {
    if (p === "/" || p === path.parse(p).root) return true
    const home = os.homedir()
    if (p === home) return true
    if (home.startsWith(p + path.sep)) return true // ancestor of home, e.g. "/home", "/Users"
    const roots = [
      "/etc",
      "/usr",
      "/bin",
      "/sbin",
      "/lib",
      "/lib64",
      "/boot",
      "/root",
      "/var",
      "/opt",
      "/dev",
      "/proc",
      "/sys",
    ]
    return roots.includes(p)
  }

  /** Assemble the writable allowlist for a policy, dropping over-broad roots. */
  function buildPolicy(input: { workspace: string[]; extraWritable?: string[]; options: Options }): Policy {
    const candidates = dedupe([
      ...input.workspace,
      ...tempDirs(),
      ...(input.options.allowWrite ?? []),
      ...(input.extraWritable ?? []),
    ])
    const writable = candidates.filter((p) => {
      if (tooBroadToConfine(p)) {
        log.warn("refusing to grant sandbox write access to an over-broad path", { path: p })
        return false
      }
      return true
    })
    return { writable, network: (input.options.network ?? "allow") !== "deny" }
  }

  // ── macOS: Seatbelt (sandbox-exec) ──────────────────────────────────────────

  /** Escape a path for an SBPL double-quoted string literal. */
  function sbpl(p: string): string {
    return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  }

  /** Add the macOS `/private/...` firmlink alias for /tmp,/var,/etc paths. */
  function withPrivateAliases(paths: string[]): string[] {
    const out = new Set<string>(paths)
    for (const p of paths) {
      for (const root of ["/tmp", "/var", "/etc"]) {
        if (p === root || p.startsWith(root + "/")) out.add("/private" + p)
      }
    }
    return [...out]
  }

  export function seatbeltProfile(policy: Policy): string {
    const lines = ["(version 1)", "(allow default)"]
    if (!policy.network) lines.push("(deny network*)")
    lines.push("(deny file-write*)")

    const writable = withPrivateAliases(dedupe(policy.writable))
    if (writable.length) {
      lines.push(`(allow file-write* ${writable.map((p) => `(subpath "${sbpl(p)}")`).join(" ")})`)
    }
    // Character devices tools legitimately write (null, tty, ptys, urandom, …).
    lines.push('(allow file-write* (subpath "/dev"))')
    return lines.join("\n")
  }

  // ── Linux: bubblewrap (bwrap) ───────────────────────────────────────────────

  export function bubblewrapArgs(policy: Policy): string[] {
    // Whole fs read-only, a fresh /dev and /proc, and a throwaway writable /tmp;
    // then re-mount the bits that must be writable on top.
    const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"]
    for (const p of dedupe(policy.writable)) {
      // Skip only the /tmp mount root itself — it is provided as a fresh tmpfs and
      // re-binding host /tmp would defeat it. A workspace that lives *under* /tmp
      // still needs binding on top of the tmpfs, or its writes vanish.
      if (p === "/tmp") continue
      // --bind-try: don't abort if the source path doesn't exist.
      args.push("--bind-try", p, p)
    }
    if (!policy.network) args.push("--unshare-net")
    // --unshare-pid: don't share the host PID namespace, so /proc/<pid>/root of a
    // same-uid host process can't be used to write through the read-only bind.
    args.push("--unshare-pid", "--die-with-parent")
    return args
  }

  /** Wrap an arbitrary argv under the active backend, or null when unavailable. */
  function specForArgv(argv: string[], policy: Policy): Spec | null {
    switch (backend()) {
      case "seatbelt":
        return { file: "sandbox-exec", args: ["-p", seatbeltProfile(policy), ...argv] }
      case "bubblewrap":
        return { file: "bwrap", args: [...bubblewrapArgs(policy), "--", ...argv] }
      default:
        return null
    }
  }

  // ── planning (consumed by the bash tool and the kernels) ────────────────────

  // Warn only once per process so every command doesn't repeat the same notice.
  const warned = { unavailable: false }

  function unavailableMessage(): string {
    return `Sandbox is enabled but unavailable on this machine (${describe().reason}). Running the command WITHOUT isolation. Install the backend, or set sandbox.onUnavailable to "error" to refuse instead.`
  }

  /**
   * Resolve which backend a command should use given the config. Returns
   * backend "none" (run unsandboxed) with an optional one-time warning, or the
   * active backend. Throws UnavailableError only when `onUnavailable: "error"`
   * and no backend exists.
   */
  function decide(options?: Options): { backend: Backend; warning?: string } {
    if (options?.enabled !== true) return { backend: "none" }
    const b = backend()
    if (b !== "none") return { backend: b }
    const mode = options.onUnavailable ?? "warn"
    if (mode === "error") throw new UnavailableError(unavailableMessage())
    const warning = mode === "warn" && !warned.unavailable ? unavailableMessage() : undefined
    if (warning) {
      warned.unavailable = true
      log.warn("sandbox enabled but unavailable", { platform: process.platform })
    }
    return { backend: "none", warning }
  }

  /**
   * Decide how to run a shell command given the sandbox config and the
   * workspace. Never throws unless `onUnavailable: "error"` and no backend
   * exists. The `cwd` is *not* granted write access unless it lies within the
   * workspace — an approved external working directory is a permission decision,
   * not a reason to widen the write boundary to the escape target.
   */
  export function plan(input: {
    command: string
    shell: string
    cwd: string
    /** Workspace roots (Instance.directory + worktree) that stay writable. */
    workspace: string[]
    options?: Options
  }): Plan {
    const { backend: b, warning } = decide(input.options)
    if (b === "none") {
      return { file: input.command, useShell: input.shell, sandboxed: false, backend: "none", warning }
    }
    const policy = buildPolicy({ workspace: input.workspace, options: input.options! })
    const s = specForArgv([input.shell, "-c", input.command], policy)!
    log.info("sandboxing command", { backend: b, network: policy.network, writable: policy.writable.length })
    return { file: s.file, args: s.args, useShell: false, sandboxed: true, backend: b, warning }
  }

  /**
   * Wrap a raw argv (program + args, no shell) — used by the notebook/R kernels
   * which spawn an interpreter directly. When the sandbox is off or unavailable
   * the original `file`/`args` are returned unchanged, so callers can spawn the
   * result verbatim.
   */
  export function wrapArgv(input: {
    file: string
    args: string[]
    /** Workspace roots that stay writable. */
    workspace: string[]
    /** Extra paths (e.g. a generated kernel script under /tmp) to keep writable/visible. */
    extraWritable?: string[]
    options?: Options
  }): Wrapped {
    const { backend: b, warning } = decide(input.options)
    if (b === "none") {
      return { file: input.file, args: input.args, sandboxed: false, backend: "none", warning }
    }
    const policy = buildPolicy({
      workspace: input.workspace,
      extraWritable: input.extraWritable,
      options: input.options!,
    })
    const s = specForArgv([input.file, ...input.args], policy)!
    log.info("sandboxing process", { backend: b, network: policy.network, writable: policy.writable.length })
    return { file: s.file, args: s.args, sandboxed: true, backend: b, warning }
  }

  // ── self-test (proves the boundary actually holds on this machine) ──────────

  export interface Check {
    name: string
    pass: boolean
    skipped?: boolean
    detail?: string
  }

  export interface SelfTest {
    backend: Backend
    available: boolean
    checks: Check[]
    ok: boolean
  }

  function firstLine(s?: string): string | undefined {
    const line = s?.trim().split("\n")[0]
    return line || undefined
  }

  function runAsync(file: string, args: string[], cwd: string): Promise<{ status: number; stderr: string }> {
    return new Promise((resolve) => {
      const proc = spawn(file, args, { cwd, stdio: ["ignore", "ignore", "pipe"] })
      let stderr = ""
      proc.stderr?.on("data", (d) => {
        stderr += d.toString()
      })
      const timer = setTimeout(() => proc.kill("SIGKILL"), 15000)
      proc.once("exit", (code) => {
        clearTimeout(timer)
        resolve({ status: code ?? 1, stderr })
      })
      proc.once("error", (err) => {
        clearTimeout(timer)
        resolve({ status: 1, stderr: String(err) })
      })
    })
  }

  /**
   * Empirically verify the sandbox on this machine: write inside a scratch
   * workspace (must succeed), write outside it (must be attempted-and-blocked),
   * and — when connectivity allows — confirm network-deny mode blocks egress.
   * Spawns real sandboxed commands; safe to run anytime. Async so it never
   * blocks the server event loop.
   */
  export async function selfTest(): Promise<SelfTest> {
    const b = backend()
    if (b === "none") return { backend: b, available: false, checks: [], ok: false }

    const shell = Shell.acceptable()
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "openscience-sbx-"))
    const outside = path.join(os.homedir(), `.openscience-sbx-escape-${process.pid}`)
    const checks: Check[] = []

    const run = (command: string, network: "allow" | "deny") => {
      const p = plan({ command, shell, cwd: work, workspace: [work], options: { enabled: true, network } })
      return runAsync(p.file, p.args ?? [], work)
    }

    try {
      const inside = await run(`printf hi > "${work}/probe" && cat "${work}/probe"`, "allow")
      const insideOk = inside.status === 0
      checks.push({
        name: "write inside the workspace succeeds",
        pass: insideOk,
        detail: insideOk ? undefined : firstLine(inside.stderr),
      })
      if (!insideOk) {
        // The sandbox isn't running commands correctly here; the remaining checks
        // would false-pass (an escape file simply never gets created), so don't
        // assert containment we can't stand behind.
        checks.push({
          name: "write outside the workspace is blocked",
          pass: false,
          skipped: true,
          detail: "inconclusive — inside-write failed, sandbox not functioning here",
        })
        return { backend: b, available: true, checks, ok: false }
      }

      fs.rmSync(outside, { force: true })
      const escape = await run(`printf x > "${outside}"`, "allow")
      const escaped = fs.existsSync(outside)
      checks.push({
        name: "write outside the workspace is blocked",
        // Require both: no file escaped AND the write was actually refused (not
        // silently succeeding). A missing file with exit 0 means the write went
        // somewhere unexpected, not that it was denied.
        pass: !escaped && escape.status !== 0,
        detail: escaped
          ? `a file escaped to ${outside}`
          : escape.status === 0
            ? "write outside reported success — not denied"
            : undefined,
      })

      const curlCmd = `curl -m 5 -s -o /dev/null https://example.com`
      if (Bun.which("curl")) {
        // Distinguish "sandbox blocked it" from "machine is offline" by checking
        // that egress works in allow-mode before asserting deny-mode blocks it.
        const allow = await run(curlCmd, "allow")
        if (allow.status !== 0) {
          checks.push({
            name: "network egress blocked in deny mode",
            pass: true,
            skipped: true,
            detail: "no outbound connectivity — inconclusive",
          })
        } else {
          const deny = await run(curlCmd, "deny")
          checks.push({
            name: "network egress blocked in deny mode",
            pass: deny.status !== 0,
            detail: deny.status === 0 ? "egress succeeded despite deny" : undefined,
          })
        }
      } else {
        checks.push({
          name: "network egress blocked in deny mode",
          pass: true,
          skipped: true,
          detail: "curl not available — skipped",
        })
      }
    } finally {
      try {
        fs.rmSync(outside, { force: true })
      } catch {}
      try {
        fs.rmSync(work, { recursive: true, force: true })
      } catch {}
    }

    return { backend: b, available: true, checks, ok: checks.filter((c) => !c.skipped).every((c) => c.pass) }
  }
}
