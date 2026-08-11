import path from "path"
import os from "os"
import fs from "fs"
import { createHash } from "crypto"
import { spawn, spawnSync } from "child_process"
import { lazy } from "@/util/lazy"
import { Log } from "@/util/log"
import { Shell } from "@/shell/shell"
import { Global } from "@/global"
import { Installation } from "@/installation"
import { SHIM_READY_MARKER } from "./egress-shim-marker"

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
    /**
     * Unix socket that is the only egress route on Linux — bubblewrap's
     * `--unshare-net` severs everything else. Required when network is
     * "allowlist" and the backend is bubblewrap.
     */
    egress?: string
    /**
     * TCP loopback port that is the only egress route on macOS. Seatbelt has
     * no network namespace to sever, so there is no socket to bind-mount —
     * `seatbeltProfile` instead narrows `network-outbound` to this one port
     * (see its doc comment). Required when network is "allowlist" and the
     * backend is seatbelt; carried on `Policy` rather than read from ambient
     * state so profile generation stays a pure function of its input.
     */
    port?: number
    /**
     * Read-only paths to bind into the namespace after `--tmpfs /tmp`, so
     * they stay reachable regardless of where they happen to live on the
     * host — including under `/tmp`, which `--tmpfs /tmp` otherwise masks
     * unconditionally, `--ro-bind / /` notwithstanding. Used for the egress
     * shim's executable — in dev, the generated launcher and the bundle it
     * runs — and the interpreter that launcher execs.
     */
    readBind?: string[]
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
    /**
     * Address of the only egress route, in whatever shape the resolved
     * backend needs: a bind-mountable unix socket path for bubblewrap, or a
     * loopback TCP port (stringified — `EgressRuntime.egressFor` is the one
     * producer, and it returns one string either way) for seatbelt.
     * `buildPolicy` is what interprets this per backend, into `Policy.egress`
     * or `Policy.port` respectively.
     */
    egress?: string
    allowWrite?: string[]
    onUnavailable?: "warn" | "error" | "allow"
  }

  /**
   * The `enabled`/`network` an `Options` resolves to — the one place that
   * answers both questions, so `decide()` and `buildPolicy()` below and
   * `EgressRuntime.egressFor()` (which has to precompute the socket that will
   * become `options.egress` *before* either of them runs) can't quietly
   * disagree on what "unset" means. They did: a missing `enabled` used to
   * read as off in `decide()` and on in `egressFor()`, and a missing
   * `network` used to read as `"allowlist"` in `buildPolicy()` and not in
   * `egressFor()` — each divergence invisible from the five production
   * callers, all of which pass an already-fully-resolved policy, but real for
   * any caller that doesn't.
   *
   * A wholly missing `Options` stays off: `enabled` requires an explicit
   * `true`, matching `decide()`'s existing contract (see the "no options →
   * runs the raw command unchanged" test in sandbox.test.ts) — this module is
   * dependency-free and does not itself default a caller into being
   * sandboxed. `network` unset defaults to `"allowlist"`, matching
   * `buildPolicy()` and `Config.trustedSandbox()`.
   */
  export function resolved(options?: Options): { enabled: boolean; network: "deny" | "allowlist" | "allow" } {
    return {
      enabled: options?.enabled === true,
      network: options?.network ?? "allowlist",
    }
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
    /**
     * Proxy variables the caller must set on the child's env for the loopback
     * shim to be used. Present only when the command was actually wrapped
     * through the shim (bubblewrap, network "allowlist", a usable egress
     * socket) — same condition as `Wrapped.env`.
     */
    env?: Record<string, string>
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

  /**
   * The sandbox backend for `platform`, defaulting to this machine's real
   * one right now.
   *
   * For the default (or an explicitly-matching) `platform` this is exactly
   * `detected()` — cached, and probed for real (`Bun.which`,
   * `probeBubblewrap`) — so every existing zero-arg caller is unaffected.
   *
   * An explicitly *different* platform is the seam that lets the seatbelt
   * code paths in `plan`/`wrapArgv`/`EgressRuntime` be exercised from Linux,
   * where no Mac exists to install `sandbox-exec` on or probe for: probing a
   * binary that cannot be present on the machine actually running the test
   * would just report "none" and defeat the whole point. So a mismatched
   * platform skips probing and assumes the backend that platform normally
   * has — `sandbox-exec` ships with every macOS install, `bwrap` is what the
   * real Linux branch above already probes for — trading "verified installed
   * here" for "what plan()/wrapArgv() would compose for that platform",
   * which is the property these tests actually need.
   */
  export function backend(platform: NodeJS.Platform = process.platform): Backend {
    if (platform === process.platform) return detected()
    if (platform === "darwin") return "seatbelt"
    if (platform === "linux") return "bubblewrap"
    return "none"
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
   * True when `p` is exactly `root` or lies inside it. Both arguments must
   * already be `dedupe()`-normalized (`path.resolve()`d) — this does exact
   * string comparison, the same convention `tooBroadToConfine` uses for the
   * same reason.
   */
  function isWithin(p: string, root: string): boolean {
    return p === root || p.startsWith(root + path.sep)
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

  /**
   * Assemble the writable allowlist for a policy, dropping over-broad roots,
   * and route `options.egress` to whichever of `Policy.egress`/`Policy.port`
   * the resolved `backend` actually consumes.
   *
   * `backend` is required (not read from ambient state) for the same reason
   * `plan`/`wrapArgv` take a `platform` parameter: it is what makes the
   * seatbelt branch here exercisable from Linux, and it is also simply
   * correct — the caller already resolved it before deciding whether to
   * sandbox at all, and re-deriving it here from `process.platform` would
   * silently disagree with that decision on an injected platform.
   */
  function buildPolicy(input: {
    workspace: string[]
    extraWritable?: string[]
    unreadable?: string[]
    options: Options
    backend: Backend
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
    const unreadable = dedupe(input.unreadable ?? []).filter((value) => !tooBroadToConfine(value))
    const network = resolved(input.options).network

    // Seatbelt's egress route is a bare TCP loopback port (see
    // seatbeltProfile), not a filesystem path — options.egress here is a
    // stringified port number, and none of the path machinery below
    // (dedupe's path.resolve, tooBroadToConfine) applies to it: resolving
    // "52341" against cwd would silently turn it into an absolute path and
    // corrupt it. An invalid value (missing, non-numeric, non-positive,
    // non-integer) is dropped here exactly like an over-broad path is
    // dropped below — seatbeltProfile is the fail-closed enforcement point,
    // the same division of labour bubblewrapArgs already has with the path
    // branch immediately below.
    if (input.backend === "seatbelt") {
      const port = input.options.egress !== undefined ? Number(input.options.egress) : undefined
      const portOk = port !== undefined && Number.isInteger(port) && port > 0
      if (input.options.egress !== undefined && !portOk) {
        log.warn("refusing to grant sandbox egress access to an invalid port", { egress: input.options.egress })
      }
      return { writable, unreadable, network, ...(portOk ? { port } : {}) }
    }

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
    return { writable, unreadable, network, ...(egressOk ? { egress } : {}) }
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

  /**
   * `(deny network*)` then, for "allowlist" only, a narrow re-allow of
   * exactly one loopback port — the host-side proxy `EgressRuntime` starts
   * for seatbelt (see egress-runtime.ts). Seatbelt has no network namespace
   * to sever the way bubblewrap's `--unshare-net` does, so there is no
   * unix socket to bind-mount either: the profile itself is the only
   * boundary, which is why the deny must always precede the allow (an
   * allow with no prior deny is the unfiltered, unrestricted-egress shape
   * this function must never produce) and why a missing or invalid port
   * throws rather than silently falling back to a bare deny — the same
   * fail-closed rule `bubblewrapArgs` applies to a missing egress socket.
   * Falling back to a plain deny instead of throwing would look identical
   * to a user asking for `network: "deny"`, which is not what "allowlist"
   * means and is exactly the kind of silent downgrade this branch exists to
   * avoid.
   *
   * Never asserts enforcement — that a real `sandbox-exec` actually honours
   * this text — only the text itself, its ordering, and this function's own
   * refusal to emit an unfiltered allow. No Mac exists on this project to
   * verify the former; see the Task 7 report for exactly what a Mac owner
   * still needs to run.
   */
  export function seatbeltProfile(policy: Policy): string {
    const lines = ["(version 1)", "(allow default)"]
    // No namespace equivalent on macOS, so "allowlist" cannot be enforced by
    // severing the network device the way bubblewrapArgs does. Deny is the
    // safe reading of a request for bounded egress; the allow line below
    // narrows that back to exactly the loopback proxy port when one reached
    // the policy.
    if (policy.network !== "allow") lines.push("(deny network*)")
    if (policy.network === "allowlist") {
      const port = policy.port
      if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) {
        throw new Error("sandbox network 'allowlist' requires an egress port")
      }
      lines.push(`(allow network-outbound (remote ip "localhost:${port}"))`)
    }
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
    // "/tmp" itself is always in policy.writable (tempDirs() adds it unconditionally)
    // but is deliberately never actually bound here — the fresh tmpfs above already
    // provides it, and re-binding host /tmp would defeat that. So it's excluded from
    // this set up front and shared with the readBind exclusion below: a path under
    // "/tmp" is writable only where something *else* in policy.writable specifically
    // covers it (e.g. a workspace that lives under /tmp), never merely because "/tmp"
    // is nominally a writable root.
    const boundWritable = dedupe(policy.writable).filter((p) => p !== "/tmp")
    for (const p of boundWritable) {
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
      // there is no other network device inside the namespace. The --ro-bind here
      // only makes the socket path reachable at all, for when it lives under a
      // path the sandbox re-mounts (the /tmp tmpfs, a fresh /dev or /proc).
      // Read-only, not read-write: the bind shares the host inode, so a
      // sandboxed process could otherwise discover the path via
      // /proc/self/mountinfo and `chmod 000` it, which persists on the host
      // and disables egress for every other kernel/terminal/job sharing this
      // one process-lifetime socket. A read-only bind blocks chmod (EROFS)
      // while still permitting connect() — verified live: chmod fails with
      // "Read-only file system" and a plain client still receives a reply
      // over the same bind.
      args.push("--ro-bind", policy.egress, policy.egress)
    }
    // Explicit, not a location choice: --tmpfs /tmp (above) masks the whole
    // host /tmp subtree unconditionally, so anything under it — a generated
    // launcher or bundle, the interpreter of a portable install — would
    // otherwise silently not exist in here. Binding each path back in by its
    // own name, after the tmpfs, is what makes it reachable regardless of
    // where it actually lives on the host.
    //
    // Skip anything already inside a writable root — boundWritable specifically
    // (not the raw policy.writable list), since that's what's actually mounted
    // above; "/tmp" itself is nominally writable but was never bound, so it
    // must not short-circuit this check (a launcher living under /tmp — e.g.
    // Global.Path.bin redirected there by bun test's isolation — needs its
    // own explicit bind same as anywhere else). bwrap mounts are applied in
    // argument order and a later mount at (or inside) a path shadows whatever
    // an earlier one put there — so a read-only bind here, coming after the
    // --bind-try loop above, would silently turn part of an already-writable
    // workspace read-only again wherever the two overlap.
    //
    // Only that one containment direction is guarded (a readBind path inside
    // a writable root, not the reverse — a writable root nested inside a
    // readBind path). The reason is narrow and specific to today's bind set,
    // not a claim about what workspaces look like: writable roots are *not*
    // only project roots (SessionFilesystem.processWriteRoots returns
    // arbitrary user-granted paths, and options.allowWrite / extraWritable
    // are arbitrary too), but every readBind path shimPlan() produces is a
    // regular file — two generated artifacts under Global.Path.bin and the
    // interpreter — and nothing can be nested inside a file, so the reverse
    // direction has no trigger at all rather than an unlikely one. By the
    // same token the exclusion changes nothing observable for today's set —
    // re-binding a file the sandbox never writes read-only is a no-op — and
    // is kept because the moment a directory joins that set, the shadowing
    // above becomes reachable again.
    //
    // Order shadows the unreadable masks above too, which is the other reason
    // to keep this set to individual files: a readBind *directory* containing
    // an `unreadable` path re-exposes that path's real contents (measured:
    // when this list still held the package root, a /dev/null mask on a file
    // inside it was silently undone). Every entry here is a generated
    // artifact or the interpreter, none of which is ever an unreadable
    // candidate, so no mask can be defeated by name.
    for (const p of dedupe(policy.readBind ?? [])) {
      if (boundWritable.some((root) => isWithin(p, root))) continue
      args.push("--ro-bind-try", p, p)
    }
    // --unshare-pid: don't share the host PID namespace, so /proc/<pid>/root of a
    // same-uid host process can't be used to write through the read-only bind.
    args.push("--unshare-pid", "--die-with-parent")
    return args
  }

  /**
   * Wrap an arbitrary argv under `b`, or null when unavailable. `b` is
   * passed in rather than read from `backend()` here — the caller already
   * resolved it (via a possibly-injected `platform`), and re-deriving it
   * from ambient state would silently disagree with that resolution.
   */
  function specForArgv(argv: string[], policy: Policy, b: Backend): Spec | null {
    switch (b) {
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
   * present.
   *
   * *Why the granularity is chosen at run time.* Fractional `sleep` is a
   * GNU/BSD coreutils extension, not POSIX, and some busybox builds reject it
   * outright (`sleep: invalid interval`) — which, in a loop, would print an
   * error line per iteration to the real command's own stderr (this wait runs
   * in the foreground, unlike the backgrounded shim) and, worse, skip the
   * wait entirely, since a failing `sleep` doesn't slow a loop down at all.
   * So the interval is settled once, before the loop, by attempting a single
   * fractional `sleep` with its stderr discarded: it either works, and the
   * loop polls at 0.02s, or it fails instantly and everything falls back to
   * the whole seconds POSIX guarantees. That probe is the only place a
   * fractional interval is ever attempted, its diagnostic can't reach the
   * command's stderr, and its cost isn't waste — it is time the shim needs
   * anyway.
   *
   * *Why not whole seconds throughout, as this did before.* Measured shim
   * readiness (fork/exec, bundle load, listener bound) is ~12ms — the
   * 600ms–1.1s in Task 4's report predates bundling the shim entry. At
   * whole-second granularity the first check therefore always lost and every
   * spawn paid a flat second: n=8, `network: "allowlist"` 1006-1007ms against
   * `deny` 3-4ms, on `sh -c true`, i.e. 335x for a command that never touches
   * the network. Every `ls` and every `git status` the agent ran paid it. At
   * 0.02s the same measurement is 24-25ms.
   *
   * The 3s cap is unchanged in both modes (150 * 0.02, 3 * 1). If the shim
   * never signals, the loop still exits at the cap and the real command runs
   * anyway — against a closed proxy port, which fails fast and visibly
   * (connection refused) rather than hanging forever.
   */
  export function shimScript(input: { binary: string; port: number; socket: string; file: string; args: string[] }) {
    const shim = [quote(input.binary), "__egress-shim", String(input.port), quote(input.socket)].join(" ")
    const real = [quote(input.file), ...input.args.map(quote)].join(" ")
    const marker = quote(SHIM_READY_MARKER)
    // `s`/`n`/`i` are plain shell variables, never exported, and `exec`
    // replaces this shell — so none of them reach the real command.
    const wait = [
      `s=0.02; n=150`,
      `sleep "$s" 2>/dev/null || { s=1; n=3; }`,
      `i=0; while [ ! -f ${marker} ] && [ "$i" -lt "$n" ]; do sleep "$s"; i=$((i + 1)); done`,
    ].join("; ")
    return `${shim} >/dev/null 2>&1 & ${wait}; exec ${real}`
  }

  /**
   * Bubblewrap-only. Loopback port the shim binds inside the sandboxed
   * network namespace. Fixed rather than negotiated: `--unshare-net` gives
   * every sandboxed process its own private namespace, so this port can
   * never collide across sandboxed processes or with anything on the host.
   * Exported so `egress-runtime.ts` can hand it back to callers alongside
   * the proxy's socket — one source of truth, rather than a second
   * module-private 3128 that could drift from this one.
   *
   * Seatbelt has no such namespace — every process on the machine shares one
   * loopback, so a fixed well-known port would collide across concurrent
   * sandboxed processes the way it structurally cannot here. Its egress port
   * (`Policy.port`) is instead assigned by the OS per proxy instance; see
   * `egress-runtime.ts`.
   */
  export const SHIM_PORT = 3128

  /**
   * Write one of the dev shim's generated artifacts, idempotently. Callers
   * pass a content-addressed name, so a file already at that name already has
   * this content and there is nothing to do; comparing anyway costs a few KB
   * and repairs a truncated leftover. The write goes to a per-process
   * temporary name and is renamed into place, which is atomic within a
   * directory — two processes generating the same artifact concurrently write
   * byte-identical content, and no third process can observe a half-written
   * file at the real name.
   *
   * A missing file (first run, a fresh worktree, a test tmpdir) is the
   * expected case, not a failure, so read errors of any kind just mean "write
   * it" and are swallowed separately from the write's own errors. Those fail
   * loud with an actionable message rather than a raw EACCES/EROFS out of
   * `wrapArgv`: network "allowlist" without a working shim is a security-
   * relevant misconfiguration (the caller explicitly asked for bounded
   * egress), not something to silently downgrade.
   */
  function place(file: string, content: Buffer, mode: number) {
    const current = (() => {
      try {
        return fs.readFileSync(file)
      } catch {
        return undefined
      }
    })()
    if (current?.equals(content)) return
    const temp = `${file}.${process.pid}`
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(temp, content, { mode })
      fs.chmodSync(temp, mode)
      fs.renameSync(temp, file)
    } catch (e) {
      fs.rmSync(temp, { force: true })
      throw new Error(`Could not write the dev egress shim to ${file}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * The single executable `shimScript` execs as the loopback bridge, plus
   * every read-only path that must be explicitly bound into the namespace
   * (`Policy.readBind`, consumed by `bubblewrapArgs`) for that executable to
   * actually be reachable from inside, regardless of where it lives on the
   * host.
   *
   * In a compiled release `process.execPath` IS the openscience binary, so
   * `openscience __egress-shim ...` runs directly — one self-contained file,
   * no extra artifact ships.
   *
   * Under `bun run src/index.ts` in development no such file exists:
   * `process.execPath` is `bun`, and `bun __egress-shim ...` is not a valid
   * bun invocation (it needs an entry script too), while `shimScript`'s
   * `binary` is a single shell word once quoted, so a two-word "bun <entry>"
   * invocation cannot be smuggled through it. So dev *builds* the missing
   * file: `bun build` bundles `egress-shim-entry.ts` (a sibling of this file)
   * into one self-contained module, and a tiny `sh` launcher execs `bun`
   * against it — the same trick `ensureAtlasBinDir` in
   * `src/openscience/index.ts` uses to expose a package's JS entry as one
   * executable path. The entry is that file and never `src/index.ts`, whose
   * graph pulls in `Global` (an unguarded top-level file write) and a live
   * models.dev fetch, both of which run before any argv check could skip
   * them. A compiled binary has no separate entry to redirect to, so it
   * still goes through `index.ts`'s `__egress-shim` check and still
   * evaluates that graph — see the Task 4 report for what that leaves
   * reachable there; restructuring `index.ts` so nothing runs before the
   * check, for both modes, is a materially bigger change than this fix.
   *
   * *Why bundle instead of running the source.* `--tmpfs /tmp` masks the
   * whole host `/tmp` subtree, `--ro-bind / /` notwithstanding, so every path
   * the shim touches has to be bound back by name — and the set of paths
   * *running a source file* touches is open-ended: the entry, its imports,
   * their imports, and for an npm import both the `node_modules` symlink and
   * its target, which in this bun workspace is the monorepo-root store, one
   * level *above* the package root. Successive revisions of this function
   * bound the paths their author thought of (the launcher, then this file's
   * directory, then the interpreter and the whole package root) and each
   * time missed one — the last of them that npm target, latent only because
   * nothing in the graph resolves a package today. A
   * bundle ends that class rather than extending the list: at run time bun
   * opens the bundle and nothing else, so the bound set is closed by
   * construction — launcher, bundle, interpreter — instead of having to keep
   * pace with an import graph.
   *
   * *What that does not cover*, stated precisely because "no future edit can
   * break this" is the claim that was false the last four times: `bun build`
   * inlines statically resolvable imports only, so a runtime
   * `import(expression)` reaching outside the bundle would still resolve
   * against an unbound path (a literal `import("./x")` is inlined and fine);
   * the bundle executes from `Global.Path.bin`, so anything resolving off its
   * own `import.meta.dir`/`url` no longer lands in the source tree; and an
   * import the bundler cannot inline fails the build here, loudly, at
   * `wrapArgv` time instead of silently inside the sandbox. Import-time side
   * effects stay forbidden for the separate reason in
   * `egress-shim-entry.ts`'s own comment — bundling relocates that code, it
   * does not stop it running.
   *
   * The fourth one escapes the framing rather than sitting inside it: a
   * dependency that loads a *native binding* bundles cleanly and still
   * resolves a path at run time. Measured with `bun-pty` as a probe — the
   * build succeeds, the JS is inlined, and the output then carries
   * `dlopen("….so")`, `import.meta.require` and `process.cwd`, with only
   * `bun:ffi` left external. A `dlopen` argument is not an import specifier,
   * so neither "bun opens the bundle and nothing else" nor the static test
   * that enforces it covers this; such a dependency would need its shared
   * library bound by name the way the artifacts are.
   *
   * *Where the artifacts live does not need to be "safe."* Earlier revisions
   * tried to pick a location `--tmpfs /tmp` couldn't mask — `Global.Path.state`,
   * then this file's own directory — and both were live-verified broken:
   * `Global.Path.*` resolves under `os.tmpdir()` during `bun test`
   * (`test/preload.ts` redirects every XDG dir there for isolation) and
   * possibly for a real user with `$HOME` under `/tmp`; the repo checkout
   * resolves under `/tmp` for a `git worktree add /tmp/...` (this repo's own
   * workflow), a CI `mktemp -d` clone, or a container build. There is no
   * location immune to both. The fix is the one `bubblewrapArgs` already uses
   * for the egress socket: bind the exact path back in, explicitly, after
   * `--tmpfs /tmp` — `--ro-bind-try`, not `--bind`, since these are executed
   * and read, never written to, from inside. `process.execPath` is bound for
   * the same reason and is a structurally separate input, not implied by
   * binding the artifacts: a portable bun install, or `$HOME` under `/tmp`,
   * puts the interpreter the launcher execs under the tmpfs too.
   *
   * Bubblewrap-only. Every one of the artifacts this produces exists to get
   * a launcher into a severed network namespace and bind it back in by name
   * — problems seatbelt does not have, since it has no namespace and the
   * sandboxed process dials the loopback proxy directly (see
   * `seatbeltProfile`). `plan()`/`wrapArgv()` only ever call this behind a
   * `backend === "bubblewrap"` guard, so on darwin — real or
   * platform-injected — this function, and everything it writes to
   * `Global.Path.bin`, is never reached at all.
   */
  const shimPlan = lazy((): { binary: string; bind: string[] } => {
    if (!Installation.isLocal()) return { binary: process.execPath, bind: [process.execPath] }
    const entry = path.resolve(import.meta.dir, "egress-shim-entry.ts")
    const built = Bun.spawnSync([process.execPath, "build", "--target=bun", entry])
    if (!built.success) {
      throw new Error(`Could not bundle the dev egress shim from ${entry}: ${built.stderr.toString().trim()}`)
    }
    // Content-addressed, not fixed names: a rebuilt bundle is a different
    // file rather than an overwrite of the one another process may be
    // executing, and a name that already exists already holds this exact
    // content, by construction. The launcher's own digest covers the bundle's
    // path, so a new bundle always produces a new launcher pointing at it —
    // a stale pair cannot form. What makes the bytes differ is (source, bun,
    // cwd): bun build writes cwd-relative module banners into the output, so
    // the same source built from `backend/cli` and from anywhere else are
    // different files. Only correctness is claimed here, not thrift — cwd is
    // the dimension that varies per invocation, so it is also the one that
    // drives how many of these accumulate.
    const stamp = (value: Buffer) => createHash("sha256").update(value).digest("hex").slice(0, 16)
    // .mjs, not .js: nothing should make bun's module-type detection for this
    // file depend on a package.json above Global.Path.bin.
    const bundle = path.join(Global.Path.bin, `egress-shim-dev-${stamp(built.stdout)}.mjs`)
    const script = Buffer.from(`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(bundle)} "$@"\n`)
    const launcher = path.join(Global.Path.bin, `egress-shim-dev-${stamp(script)}.sh`)
    place(bundle, built.stdout, 0o644)
    place(launcher, script, 0o755)
    return { binary: launcher, bind: [launcher, bundle, process.execPath] }
  })

  // ── planning (consumed by the bash tool and the kernels) ────────────────────

  // Warn only once per process so every command doesn't repeat the same notice.
  const warned = { unavailable: false }

  function unavailableMessage(): string {
    return `Sandbox is enabled but unavailable on this machine (${describe().reason}). Running the command WITHOUT isolation. Install the backend, or set sandbox.onUnavailable to "error" to refuse instead.`
  }

  /**
   * Resolve which backend a command should use given the config and
   * `platform` (default the real one — see `backend()`). Returns backend
   * "none" (run unsandboxed) with an optional one-time warning, or the
   * active backend. Throws UnavailableError only when `onUnavailable: "error"`
   * and no backend exists.
   */
  function decide(
    options: Options | undefined,
    platform: NodeJS.Platform = process.platform,
  ): { backend: Backend; warning?: string } {
    if (!resolved(options).enabled) return { backend: "none" }
    const b = backend(platform)
    if (b !== "none") return { backend: b }
    const mode = options?.onUnavailable ?? "warn"
    if (mode === "error") throw new UnavailableError(unavailableMessage())
    const warning = mode === "warn" && !warned.unavailable ? unavailableMessage() : undefined
    if (warning) {
      warned.unavailable = true
      log.warn("sandbox enabled but unavailable", { platform })
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
   *
   * Composes the same loopback shim `wrapArgv` does, under the same
   * condition (bubblewrap, network "allowlist", a usable egress socket) —
   * `pip`/`curl`/`uv` run through here, not `wrapArgv`, so this is the path
   * the feature's motivating case actually needs. `shimScript` already
   * treats its `file`/`args` as an arbitrary argv to `exec`, so a shell
   * invocation composes by feeding it `input.shell`/`["-c", input.command]`
   * exactly as the no-shim branch below already passes to `specForArgv` —
   * one shape, not a second implementation of "wrap a shell command".
   *
   * `platform` defaults to the real one — the only reason to pass a
   * different value is to exercise the seatbelt/darwin branch from a
   * machine that isn't one; see `backend()`.
   */
  export function plan(input: {
    command: string
    shell: string
    cwd: string
    /** Workspace roots (Instance.directory + worktree) that stay writable. */
    workspace: string[]
    options?: Options
    platform?: NodeJS.Platform
  }): Plan {
    const platform = input.platform ?? process.platform
    const { backend: b, warning } = decide(input.options, platform)
    if (b === "none") {
      return { file: input.command, useShell: input.shell, sandboxed: false, backend: "none", warning }
    }
    const policy = buildPolicy({ workspace: input.workspace, options: input.options!, backend: b })
    // Bubblewrap's loopback shim bridges a bind-mounted unix socket that only
    // exists inside its own network namespace. Seatbelt has no namespace, so
    // there is nothing to bridge and no shim to compose — the sandboxed
    // process instead dials the loopback proxy port seatbeltProfile allowed
    // directly, which is why this guard stays bubblewrap-only rather than
    // "any backend with allowlist + an egress value".
    const shimmed = b === "bubblewrap" && policy.network === "allowlist" && policy.egress ? shimPlan() : undefined
    const shim = shimmed
      ? shimScript({
          binary: shimmed.binary,
          port: SHIM_PORT,
          socket: policy.egress!,
          file: input.shell,
          args: ["-c", input.command],
        })
      : undefined
    const argv = shim ? ["/bin/sh", "-c", shim] : [input.shell, "-c", input.command]
    const s = specForArgv(argv, shimmed ? { ...policy, readBind: shimmed.bind } : policy, b)!
    log.info("sandboxing command", { backend: b, network: policy.network, writable: policy.writable.length })
    // The env points at whichever loopback port actually reaches the proxy:
    // the bwrap shim's fixed SHIM_PORT when a shim was composed, or
    // seatbelt's own policy.port (no shim, dialed directly) when the backend
    // is seatbelt and network is "allowlist" — specForArgv above already
    // threw if that port were missing or invalid, so reading it here is safe.
    const port = shim ? SHIM_PORT : b === "seatbelt" && policy.network === "allowlist" ? policy.port : undefined
    const proxy = port ? `http://127.0.0.1:${port}` : undefined
    const env = proxy ? { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy } : undefined
    return {
      file: s.file,
      args: s.args,
      useShell: false,
      sandboxed: true,
      backend: b,
      warning,
      ...(env ? { env } : {}),
    }
  }

  /**
   * Wrap a raw argv (program + args, no shell) — used by the notebook/R kernels
   * which spawn an interpreter directly. When the sandbox is off or unavailable
   * the original `file`/`args` are returned unchanged, so callers can spawn the
   * result verbatim.
   *
   * `platform` defaults to the real one — the only reason to pass a
   * different value is to exercise the seatbelt/darwin branch from a
   * machine that isn't one; see `backend()`.
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
    platform?: NodeJS.Platform
  }): Wrapped {
    const platform = input.platform ?? process.platform
    const { backend: b, warning } = decide(input.options, platform)
    if (b === "none") {
      return { file: input.file, args: input.args, sandboxed: false, backend: "none", warning }
    }
    const policy = buildPolicy({
      workspace: input.workspace,
      extraWritable: input.extraWritable,
      unreadable: input.unreadable,
      options: input.options!,
      backend: b,
    })
    // Only bubblewrap's --unshare-net + --bind gives the shim anything to
    // bridge: seatbelt has no namespace, so there is nothing to bridge and no
    // shim to compose — the sandboxed process instead dials the loopback
    // proxy port seatbeltProfile allowed directly (see plan()'s identical
    // guard for the shell-command path).
    const plan = b === "bubblewrap" && policy.network === "allowlist" && policy.egress ? shimPlan() : undefined
    const shim = plan
      ? shimScript({ binary: plan.binary, port: SHIM_PORT, socket: policy.egress!, file: input.file, args: input.args })
      : undefined
    const argv = shim ? ["/bin/sh", "-c", shim] : [input.file, ...input.args]
    const s = specForArgv(argv, plan ? { ...policy, readBind: plan.bind } : policy, b)!
    log.info("sandboxing process", { backend: b, network: policy.network, writable: policy.writable.length })
    // See plan()'s identical computation: SHIM_PORT for a composed bwrap
    // shim, or seatbelt's own dynamically-assigned policy.port when the
    // backend is seatbelt and network is "allowlist" (specForArgv above
    // already threw if that port were missing or invalid).
    const port = shim ? SHIM_PORT : b === "seatbelt" && policy.network === "allowlist" ? policy.port : undefined
    const proxy = port ? `http://127.0.0.1:${port}` : undefined
    const env = proxy ? { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy } : undefined
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
