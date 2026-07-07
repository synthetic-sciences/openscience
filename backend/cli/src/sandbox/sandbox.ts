import path from "path"
import os from "os"
import { spawnSync } from "child_process"
import { lazy } from "@/util/lazy"
import { Log } from "@/util/log"

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

  export class UnavailableError extends Error {
    constructor(message: string) {
      super(message)
      this.name = "SandboxUnavailableError"
    }
  }

  // ── backend detection ───────────────────────────────────────────────────────

  function probeBubblewrap(bin: string): boolean {
    // bwrap can exist yet fail at runtime when unprivileged user namespaces are
    // disabled (kernel.unprivileged_userns_clone=0, some hardened distros). A
    // quick functional check is the only reliable signal.
    try {
      const res = spawnSync(bin, ["--ro-bind", "/", "/", "--dev", "/dev", "--", "true"], {
        stdio: "ignore",
        timeout: 5000,
      })
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

  function seatbeltSpec(command: string, shell: string, policy: Policy): Spec {
    return { file: "sandbox-exec", args: ["-p", seatbeltProfile(policy), shell, "-c", command] }
  }

  // ── Linux: bubblewrap (bwrap) ───────────────────────────────────────────────

  export function bubblewrapArgs(policy: Policy): string[] {
    // Whole fs read-only, then re-mount the bits that must be writable.
    const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"]
    for (const p of dedupe(policy.writable)) {
      // /tmp is already a writable tmpfs; re-binding host /tmp would defeat it.
      if (p === "/tmp" || p.startsWith("/tmp/")) continue
      // --bind-try: don't abort if the source path doesn't exist.
      args.push("--bind-try", p, p)
    }
    if (!policy.network) args.push("--unshare-net")
    args.push("--die-with-parent")
    return args
  }

  function bubblewrapSpec(command: string, shell: string, policy: Policy): Spec {
    return { file: "bwrap", args: [...bubblewrapArgs(policy), "--", shell, "-c", command] }
  }

  /** Build a spawnable spec for the active backend, or null when unavailable. */
  export function spec(input: { command: string; shell: string; policy: Policy }): Spec | null {
    switch (backend()) {
      case "seatbelt":
        return seatbeltSpec(input.command, input.shell, input.policy)
      case "bubblewrap":
        return bubblewrapSpec(input.command, input.shell, input.policy)
      default:
        return null
    }
  }

  // ── planning (consumed by the bash tool) ────────────────────────────────────

  // Warn only once per process so every command doesn't repeat the same notice.
  const warned = { unavailable: false }

  function unavailableMessage(): string {
    return `Sandbox is enabled but unavailable on this machine (${describe().reason}). Running the command WITHOUT isolation. Install the backend, or set sandbox.onUnavailable to "error" to refuse instead.`
  }

  /**
   * Decide how to run a command given the sandbox config and the workspace.
   * Never throws unless `onUnavailable: "error"` and no backend exists.
   */
  export function plan(input: {
    command: string
    shell: string
    cwd: string
    /** Workspace roots (Instance.directory + worktree) that stay writable. */
    workspace: string[]
    options?: Options
  }): Plan {
    const raw = (): Plan => ({
      file: input.command,
      useShell: input.shell,
      sandboxed: false,
      backend: "none",
    })

    if (input.options?.enabled !== true) return raw()

    const b = backend()
    if (b === "none") {
      const mode = input.options.onUnavailable ?? "warn"
      if (mode === "error") throw new UnavailableError(unavailableMessage())
      const warning = mode === "warn" && !warned.unavailable ? unavailableMessage() : undefined
      if (warning) {
        warned.unavailable = true
        log.warn("sandbox enabled but unavailable", { platform: process.platform })
      }
      return { ...raw(), warning }
    }

    const policy: Policy = {
      writable: dedupe([...input.workspace, input.cwd, ...tempDirs(), ...(input.options.allowWrite ?? [])]),
      network: (input.options.network ?? "allow") !== "deny",
    }
    const s = spec({ command: input.command, shell: input.shell, policy })!
    log.info("sandboxing command", { backend: b, network: policy.network, writable: policy.writable.length })
    return { file: s.file, args: s.args, useShell: false, sandboxed: true, backend: b }
  }
}
