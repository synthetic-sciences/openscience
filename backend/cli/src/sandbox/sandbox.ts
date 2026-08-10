import path from "path"
import os from "os"
import fs from "fs"
import { createHash } from "crypto"
import { spawn, spawnSync } from "child_process"
import { lazy } from "@/util/lazy"
import { Log } from "@/util/log"
import { Shell } from "@/shell/shell"
import { Installation } from "@/installation"

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
    /** Exact host files the sandboxed process must not be able to read. */
    unreadable?: string[]
    /** How the sandboxed process may reach the network. */
    network: "deny" | "allowlist" | "allow"
    /** Unix socket that is the only egress route. Required when network is "allowlist". */
    egress?: string
  }

  /** A ready-to-spawn argv: `spawn(file, args)` with no shell wrapping. */
  export interface Spec {
    file: string
    args: string[]
  }

  /** User-facing config knobs (mirrors Config.Sandbox, kept dependency-free). */
  export interface Options {
    enabled?: boolean
    network?: "deny" | "allowlist" | "allow"
    egress?: string
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
    /**
     * Proxy variables the caller must set on the child's env for the loopback
     * shim to be used. Present only when the argv was actually wrapped through
     * the shim (bubblewrap, network "allowlist", a usable egress socket).
     */
    env?: Record<string, string>
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
  function buildPolicy(input: {
    workspace: string[]
    extraWritable?: string[]
    unreadable?: string[]
    options: Options
  }): Policy {
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
    // dedupe() applies the same path.resolve() normalization used for
    // writable/unreadable above, so a trailing slash, a double slash, or an
    // unresolved ".." can't slip an over-broad path past tooBroadToConfine's
    // string checks — the two normalization paths cannot drift apart because
    // this is the exact same helper, not a parallel implementation of it.
    const [egress] = dedupe(input.options.egress ? [input.options.egress] : [])
    const egressOk = egress !== undefined && !tooBroadToConfine(egress)
    if (egress !== undefined && !egressOk) {
      log.warn("refusing to grant sandbox egress access to an over-broad path", { path: egress })
    }
    return {
      writable,
      unreadable: dedupe(input.unreadable ?? []).filter((value) => !tooBroadToConfine(value)),
      network: input.options.network ?? "allowlist",
      ...(egressOk ? { egress } : {}),
    }
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
    // No namespace equivalent on macOS, so "allowlist" cannot be enforced here.
    // Deny is the safe reading of a request for bounded egress.
    if (policy.network !== "allow") lines.push("(deny network*)")
    const unreadable = withPrivateAliases(dedupe(policy.unreadable ?? []))
    if (unreadable.length) {
      lines.push(`(deny file-read* ${unreadable.map((value) => `(literal "${sbpl(value)}")`).join(" ")})`)
    }
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
    for (const value of dedupe(policy.unreadable ?? [])) {
      // bwrap's *-try only tolerates a missing source. With /dev/null as the
      // source it still attempts to create a missing destination, which fails
      // beneath our read-only root before the command can start. An absent
      // credential cannot be read and the sandbox cannot create it, so only
      // mount masks for files that exist when the namespace is assembled.
      if (!fs.existsSync(value)) continue
      args.push("--ro-bind-try", "/dev/null", value)
    }
    if (policy.network !== "allow") args.push("--unshare-net")
    if (policy.network === "allowlist") {
      if (!policy.egress) throw new Error("sandbox network 'allowlist' requires an egress socket path")
      // --unshare-net (above) is what makes this the only route to the network —
      // there is no other network device inside the namespace. The --bind here
      // only makes the socket path reachable at all, for when it lives under a
      // path the sandbox re-mounts (the /tmp tmpfs, a fresh /dev or /proc).
      args.push("--bind", policy.egress, policy.egress)
    }
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

  // ── egress shim composition ─────────────────────────────────────────────────

  /** POSIX single-quote escaping: close, insert an escaped quote, reopen. */
  const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`

  /**
   * Marker the `__egress-shim` handler touches once its listener is bound
   * (see `index.ts`, which must use this exact literal). Lives under `/tmp`,
   * which `bubblewrapArgs` always mounts as a fresh, process-private tmpfs —
   * so a fixed name here cannot collide across sandboxed processes or with a
   * previous run, and — unlike the socket's own directory — is guaranteed
   * writable regardless of the write policy.
   */
  const SHIM_READY_MARKER = "/tmp/.openscience-egress-shim.ready"

  /**
   * The sandboxed process needs a proxy at a host:port, but the only route out
   * is a unix socket. This backgrounds a loopback bridge inside the namespace,
   * waits (bounded) for it to signal readiness, and then execs the real
   * command — so the sandbox still holds exactly one long-lived process, and
   * the real command doesn't get a proxy env pointing at a port nothing is
   * listening on yet.
   *
   * The wait is a marker-file poll, not a network probe: a POSIX `/bin/sh`
   * (dash/busybox, not bash) has no built-in way to test a TCP connection —
   * bash's `/dev/tcp` isn't portable here and `nc`/`curl` aren't guaranteed
   * present. Measured shim startup (process fork/exec + module load, before
   * the listener binds) is ~600ms; 30 * 100ms = 3s gives roughly 5x headroom.
   * If the shim never signals, the loop still exits at the cap and the real
   * command runs anyway — against a closed proxy port, which fails fast and
   * visibly (connection refused) rather than hanging forever.
   */
  export function shimScript(input: { binary: string; port: number; socket: string; file: string; args: string[] }) {
    const shim = [quote(input.binary), "__egress-shim", String(input.port), quote(input.socket)].join(" ")
    const real = [quote(input.file), ...input.args.map(quote)].join(" ")
    const marker = quote(SHIM_READY_MARKER)
    const wait = `i=0; while [ ! -f ${marker} ] && [ "$i" -lt 30 ]; do sleep 0.1; i=$((i + 1)); done`
    return `${shim} >/dev/null 2>&1 & ${wait}; exec ${real}`
  }

  /**
   * Loopback port the shim binds inside the sandboxed network namespace.
   * Fixed rather than negotiated: `--unshare-net` gives every sandboxed
   * process its own private namespace, so this port can never collide across
   * sandboxed processes or with anything on the host. The egress proxy side
   * agrees on the same value independently — this module does not import
   * `egress.ts` (the sandbox layer knows a socket path, not a proxy).
   */
  const SHIM_PORT = 3128

  /**
   * The single executable `shimScript` execs as the loopback bridge.
   *
   * In a compiled release `process.execPath` IS the openscience binary, so
   * `openscience __egress-shim ...` runs directly — no extra artifact ships.
   *
   * Under `bun run src/index.ts` in development, `process.execPath` is the
   * `bun` binary itself, and `bun __egress-shim ...` is not a valid bun
   * invocation (it needs the entry script too). `shimScript`'s `binary` is a
   * single shell word once quoted, so a two-word "bun <entry>" invocation
   * cannot be smuggled through it — instead a tiny on-disk launcher plays the
   * role of a single executable, the same trick `ensureAtlasBinDir` in
   * `src/openscience/index.ts` uses to expose a package's JS entry as one
   * executable path.
   *
   * The entry script is resolved from *this file's own location*
   * (`import.meta.dir`), not `Bun.main` — `Bun.main` is "whatever launched
   * the current process", which under `bun test` is the test file, not
   * `src/index.ts`. `sandbox.ts` and `index.ts` sit at a fixed relative
   * position within this package regardless of what invoked the process, so
   * that structural relationship is the reliable signal.
   *
   * The launcher's filename is content-addressed (a digest of the exact
   * script it will contain), not a single fixed name: two worktrees resolve
   * different entry paths, so they get different files instead of
   * overwriting each other's, and any process that finds a file already at
   * that name knows its content without reading it first (same content ⇒
   * same name, by construction) — so there is no read-modify-write race to
   * get wrong. Errors writing it are reported clearly rather than
   * propagating a raw EACCES/EROFS out of `wrapArgv`.
   *
   * It is written next to this file (`import.meta.dir`), *not* under
   * `Global.Path.state`/`.bin`/anything XDG-derived, and not under
   * `os.tmpdir()`. `bubblewrapArgs` unconditionally mounts a fresh, empty
   * tmpfs at `/tmp` (`--tmpfs /tmp`, after `--ro-bind / /`), which replaces
   * the *entire* host `/tmp` subtree inside the sandbox regardless of what's
   * really there on the host — so a launcher living anywhere under `/tmp`
   * would silently not exist from inside, and the shim would just never
   * start. This isn't a test-only edge case: `Global.Path.*` all derive from
   * the same XDG/home resolution, which `bun test` (`test/preload.ts`)
   * unconditionally redirects under `os.tmpdir()` for isolation, and a real
   * user can have `$HOME` under `/tmp` too. The repo checkout itself is
   * never redirected by either, so anchoring to this file's own location is
   * the one option that's actually safe here — live-verified: writing under
   * `Global.Path.state` measured "Connection refused" under `bun test`
   * (the launcher path resolved under the test's tmpdir and the shim never
   * started); this location doesn't.
   */
  const shimBinary = lazy((): string => {
    if (!Installation.isLocal()) return process.execPath
    const entry = path.resolve(import.meta.dir, "..", "index.ts")
    const script = `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(entry)} "$@"\n`
    const digest = createHash("sha256").update(script).digest("hex").slice(0, 16)
    const dir = path.join(import.meta.dir, ".egress-shim-dev")
    const launcher = path.join(dir, `egress-shim-dev-${digest}.sh`)
    try {
      if (fs.readFileSync(launcher, "utf8") === script) return launcher
    } catch {}
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(launcher, script, { mode: 0o755 })
      fs.chmodSync(launcher, 0o755)
    } catch (e) {
      throw new Error(
        `Could not write the dev egress-shim launcher to ${launcher}: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    return launcher
  })

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
   * workspace. Throws only in two cases: `onUnavailable: "error"` with no
   * backend available, or `network: "allowlist"` with no `egress` socket path
   * (directly, or because the supplied path was rejected as over-broad). The
   * `cwd` is *not* granted write access unless it lies within the workspace —
   * an approved external working directory is a permission decision, not a
   * reason to widen the write boundary to the escape target.
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
    /** Exact host credential files to mask from the process. */
    unreadable?: string[]
    options?: Options
  }): Wrapped {
    const { backend: b, warning } = decide(input.options)
    if (b === "none") {
      return { file: input.file, args: input.args, sandboxed: false, backend: "none", warning }
    }
    const policy = buildPolicy({
      workspace: input.workspace,
      extraWritable: input.extraWritable,
      unreadable: input.unreadable,
      options: input.options!,
    })
    // Only bubblewrap's --unshare-net + --bind gives the shim anything to
    // bridge: seatbelt has no namespace, so "allowlist" already reads as a
    // plain network deny there (see seatbeltProfile) and composing a shim
    // that dials a socket seatbelt never mounted would just fail or hang.
    const shim =
      b === "bubblewrap" && policy.network === "allowlist" && policy.egress
        ? shimScript({
            binary: shimBinary(),
            port: SHIM_PORT,
            socket: policy.egress,
            file: input.file,
            args: input.args,
          })
        : undefined
    const argv = shim ? ["/bin/sh", "-c", shim] : [input.file, ...input.args]
    const s = specForArgv(argv, policy)!
    log.info("sandboxing process", { backend: b, network: policy.network, writable: policy.writable.length })
    const proxy = `http://127.0.0.1:${SHIM_PORT}`
    const env = shim ? { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy } : undefined
    return { file: s.file, args: s.args, sandboxed: true, backend: b, warning, ...(env ? { env } : {}) }
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
