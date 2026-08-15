import path from "path"
import os from "os"
import fs from "fs"
import { createHash, randomBytes } from "crypto"
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
 * Both backends are deny-by-default and expose only system/runtime roots plus
 * explicit session grants. Linux bubblewrap starts from its native empty tmpfs
 * root; mounting the host root, even read-only, would defeat read isolation.
 */
export namespace Sandbox {
  export type Backend = "seatbelt" | "bubblewrap" | "appcontainer" | "none"

  export interface Policy {
    /** Absolute paths the sandboxed process may write to. */
    writable: string[]
    /** Absolute grant/runtime roots the process may read. */
    readable?: string[]
    /** Exact ancestor directories that a resolver may enumerate while walking
     * toward an allowed subtree. Children are not made readable. */
    readableExact?: string[]
    /** Exact host files the sandboxed process must not be able to read. */
    unreadable?: string[]
    /** Canonical host sources that must also appear at stable lexical paths
     * inside a Linux mount namespace (for example the managed data-root
     * symlink). The source is resolved before spawn; bubblewrap never follows
     * the caller-provided lexical spelling on the host. */
    readableAliases?: MountAlias[]
    writableAliases?: MountAlias[]
    unreadableAliases?: MountAlias[]
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
     * The `Proxy-Authorization` secret the loopback proxy requires on macOS
     * — a TCP port, unlike `egress`'s unix socket, carries no filesystem
     * permissions of its own, so `plan`/`wrapArgv` embed this in the proxy
     * URL (`http://os:<secret>@127.0.0.1:<port>`) rather than pointing the
     * sandboxed process at an unauthenticated one. Not consumed by
     * `seatbeltProfile` itself — the profile only narrows the network layer
     * to `port`; the secret is enforced by `Egress.serveProxy` on the other
     * end. Set together with `port` or not at all (see `buildPolicy`).
     */
    secret?: string
    /**
     * AppContainer profile name on Windows. Containment there is anchored to a
     * package SID rather than a namespace or a profile document: the SID is
     * derived from this name, filesystem ACEs are granted to it, and the broker
     * pipe's DACL names it. Required when the backend is "appcontainer".
     *
     * Derived from the workspace rather than passed in, so the same project
     * gets the same SID across runs — ACLs granted once stay meaningful, and
     * `CreateAppContainerProfile` is idempotent given a stable name.
     */
    profile?: string
    /**
     * Read-only paths to bind into the namespace after `--tmpfs /tmp`, so
     * they stay reachable regardless of where they happen to live on the
     * host — including under `/tmp`, which `--tmpfs /tmp` otherwise masks
     * unconditionally, `--ro-bind / /` notwithstanding. Used for the egress
     * shim's executable — in dev, the generated launcher and the bundle it
     * runs — and the interpreter that launcher execs.
     */
    readBind?: string[]
    /** Argv that starts the egress shim INSIDE an AppContainer, when one is
     *  needed. A release re-enters its own binary; from source it is bun plus
     *  the bundled shim entry, which is why it cannot be re-derived launcher-side
     *  from `process.execPath` alone. Its paths are added to `readable`. */
    shim?: string[]
  }

  export interface MountAlias {
    source: string
    destination: string
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
     * backend needs: a bind-mountable unix socket path for bubblewrap, or
     * `"<port>:<secret>"` for seatbelt (`EgressRuntime.egressFor` is the one
     * producer, and it returns one string either way). `buildPolicy` is what
     * interprets this per backend, into `Policy.egress` or
     * `Policy.port`/`Policy.secret` respectively.
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
    /** Unique owner-only host temp directory granted only to this process. */
    temporary?: string
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
    /** Unique owner-only host temp directory granted only to this process. */
    temporary?: string
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
      const res = spawnSync(bin, [...bubblewrapArgs({ writable: [], network: "deny" }), "--", "/usr/bin/true"], {
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
    if (process.platform === "win32") {
      // Probed, never assumed. `AppContainer.usable()` loads the DLLs and
      // derives a SID — side-effect free, and it catches the failure that
      // matters: FFI bindings that do not resolve, which would mean composing a
      // sandbox that is never actually applied. Anything it cannot prove falls
      // back to "none", which is the behaviour Windows had before this existed.
      const { AppContainer } = require("./appcontainer") as typeof import("./appcontainer")
      return AppContainer.usable() ? "appcontainer" : "none"
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
    // An INJECTED win32 resolves to "appcontainer" so the Windows composition
    // can be built and tested from a machine that is not Windows, exactly as
    // the seatbelt paths were built from Linux.
    //
    // `detected()` above deliberately still answers "none" on a real Windows
    // machine, and must keep doing so until the launcher exists. Flipping the
    // live probe first would make `available()` true and have the product claim
    // a sandbox it cannot actually apply — strictly worse than today's honest
    // refusal to run kernels there.
    if (platform === "win32") return "appcontainer"
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
    readIsolation: "grant_only" | "unavailable"
    networkIsolation: "deny_all" | "unavailable"
    tool?: string
    reason?: string
  } {
    const b = backend()
    if (b === "seatbelt") {
      return {
        platform: process.platform,
        backend: b,
        available: true,
        readIsolation: "grant_only",
        networkIsolation: "deny_all",
        tool: "sandbox-exec",
      }
    }
    if (b === "bubblewrap") {
      return {
        platform: process.platform,
        backend: b,
        available: true,
        readIsolation: "grant_only",
        networkIsolation: "deny_all",
        tool: "bwrap",
      }
    }
    // Widening `Backend` without widening this left `sandbox status` reporting
    // "unavailable - no sandbox backend for platform win32" on a machine where
    // `backend()` had already resolved to "appcontainer" and `sandbox test` was
    // happily printing it. Two commands, same function, opposite answers.
    if (b === "appcontainer") {
      return {
        platform: process.platform,
        backend: b,
        available: true,
        // ACL-based rather than namespace-based, but the same contract: nothing
        // is reachable unless the package SID was granted it, and zero
        // capabilities means no network at all.
        readIsolation: "grant_only",
        networkIsolation: "deny_all",
        tool: "AppContainer",
      }
    }
    const reason =
      process.platform === "darwin"
        ? "sandbox-exec not found on PATH"
        : process.platform === "linux"
          ? "bubblewrap (bwrap) is not installed, or unprivileged user namespaces are disabled"
          : `no sandbox backend for platform "${process.platform}"`
    return {
      platform: process.platform,
      backend: "none",
      available: false,
      readIsolation: "unavailable",
      networkIsolation: "unavailable",
      reason,
    }
  }

  // ── writable-path assembly ──────────────────────────────────────────────────

  const temporaryRoots = new Set<string>()

  /** Allocate a temp root for one spawned sandbox. Sharing one per server lets
   * mutually untrusted projects/sessions read and overwrite each other's temp
   * files, even when the main workspace grants are disjoint. */
  function privateTemp(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `openscience-sandbox-${process.pid}-`))
    fs.chmodSync(directory, 0o700)
    const canonical = fs.realpathSync.native(directory)
    temporaryRoots.add(canonical)
    return canonical
  }

  /** Release the per-spawn temp root. Only roots allocated by this module can
   * be removed, so a forged Plan cannot turn this helper into a deletion API. */
  export function cleanup(input: Pick<Plan, "temporary"> | Pick<Wrapped, "temporary">): void {
    const temporary = input.temporary
    if (!temporary || !temporaryRoots.delete(temporary)) return
    try {
      fs.rmSync(temporary, { recursive: true, force: true })
    } catch (error) {
      // A killed/malicious child may leave restrictive modes behind. The
      // unique 0700 root remains isolated even if best-effort reclamation
      // cannot remove it immediately.
      log.warn("failed to clean sandbox temp directory", { temporary, error })
    }
  }

  process.once("exit", () => {
    for (const temporary of [...temporaryRoots]) cleanup({ temporary })
  })

  function withTempEnvironment(argv: string[], temporary: string) {
    return ["/usr/bin/env", `TMPDIR=${temporary}`, `TMP=${temporary}`, `TEMP=${temporary}`, ...argv]
  }

  /** Canonicalize an existing path or a nonexistent tail below its nearest
   * existing ancestor. Relative paths and broken symlink ancestors are
   * ambiguous policy inputs and are dropped fail-closed. */
  function canonicalPolicyPath(input: string): string | undefined {
    if (!path.isAbsolute(input)) {
      log.warn("refusing a relative sandbox path", { path: input })
      return
    }
    let cursor = path.normalize(input)
    const tail: string[] = []
    while (true) {
      try {
        fs.lstatSync(cursor)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          log.warn("refusing an unreadable sandbox path", { path: input, error })
          return
        }
        const parent = path.dirname(cursor)
        if (parent === cursor) return
        tail.unshift(path.basename(cursor))
        cursor = parent
      }
    }
    try {
      const real = fs.realpathSync.native(cursor)
      return path.join(real, ...tail)
    } catch (error) {
      log.warn("refusing an ambiguous sandbox path", { path: input, error })
      return
    }
  }

  /** Preserve an approved stable spelling when canonicalization crosses a
   * symlink. Linux starts from an empty root, so mounting only the physical
   * path would make commands that use the stable spelling fail with ENOENT.
   * The canonical source remains the sole host authority; destination is only
   * a normalized name created inside the private mount namespace. */
  function mountAliases(paths: string[]): MountAlias[] {
    const out = new Map<string, MountAlias>()
    for (const input of paths) {
      if (!input || !path.isAbsolute(input)) continue
      const destination = path.normalize(input)
      const source = canonicalPolicyPath(destination)
      if (!source || source === destination) continue
      if (tooBroadToConfine(destination)) {
        log.warn("refusing an over-broad sandbox alias destination", { path: destination })
        continue
      }
      out.set(destination, { source, destination })
    }
    return [...out.values()]
  }

  function safeMountAliases(aliases: MountAlias[] | undefined, allowBroadSource = false): MountAlias[] {
    const out = new Map<string, MountAlias>()
    for (const alias of aliases ?? []) {
      if (!path.isAbsolute(alias.source) || !path.isAbsolute(alias.destination)) continue
      const source = canonicalPolicyPath(alias.source)
      const destination = path.normalize(alias.destination)
      if (!source || source === destination || tooBroadToConfine(destination)) continue
      if (!allowBroadSource && tooBroadToConfine(source)) continue
      out.set(destination, { source, destination })
    }
    return [...out.values()]
  }

  function dedupe(paths: string[]): string[] {
    const out = new Set<string>()
    for (const p of paths)
      if (p) {
        const canonical = canonicalPolicyPath(p)
        if (canonical) out.add(canonical)
      }
    return [...out]
  }

  function traversalRoots(paths: string[]): string[] {
    const result = new Set<string>()
    for (const value of dedupe(paths)) {
      let cursor = path.dirname(value)
      while (true) {
        result.add(cursor)
        const parent = path.dirname(cursor)
        if (parent === cursor) break
        cursor = parent
      }
    }
    return [...result]
  }

  /** Read-only system MIME databases consulted by Python's stdlib
   * `mimetypes.init()` and, transitively, common scientific packages such as
   * openpyxl. Keep this an exact file allowlist: exposing `/etc` would reveal
   * unrelated host configuration and credentials. */
  function runtimeMimeTypeFiles(): string[] {
    return [
      "/etc/mime.types",
      "/etc/httpd/mime.types",
      "/etc/httpd/conf/mime.types",
      "/etc/apache/mime.types",
      "/etc/apache2/mime.types",
    ].filter((value) => fs.existsSync(value))
  }

  /** Read-only roots needed to launch common local research runtimes. These
   * are installation/code roots, never the user's home directory as a whole. */
  function runtimeReadRoots(entrypoints: string[]): string[] {
    const roots = new Set<string>()
    const add = (value?: string | null) => {
      if (!value || !path.isAbsolute(value)) return
      const home = os.homedir()
      if (
        value === path.parse(value).root ||
        value === home ||
        home.startsWith(value + path.sep) ||
        ["/etc", "/var", "/tmp", "/home", "/root", "/opt"].includes(value)
      ) {
        return
      }
      roots.add(value)
    }
    const installation = (value: string) => {
      const versioned = [
        { marker: "/.pyenv/versions/", depth: 1 },
        { marker: "/.asdf/installs/", depth: 2 },
        { marker: "/.local/share/uv/python/", depth: 1 },
        { marker: "/miniconda3/envs/", depth: 1 },
        { marker: "/.nvm/versions/node/", depth: 1 },
      ].find((item) => value.includes(item.marker))
      if (versioned) {
        const start = value.indexOf(versioned.marker) + versioned.marker.length
        const parts = value.slice(start).split(path.sep).slice(0, versioned.depth)
        add(value.slice(0, start) + parts.join(path.sep))
        return
      }
      for (const marker of ["/.bun/", "/.pyenv/", "/.asdf/", "/.volta/"]) {
        const index = value.indexOf(marker)
        if (index >= 0) {
          add(value.slice(0, index + marker.length - 1))
          return
        }
      }
      for (const root of ["/opt/conda", "/opt/rocm", "/opt/cuda", "/opt/nvidia"]) {
        if (value === root || value.startsWith(root + path.sep)) {
          add(root)
          return
        }
      }
    }
    for (const value of (process.env.PATH ?? "").split(path.delimiter)) {
      add(value)
      if (path.isAbsolute(value)) installation(value)
    }
    for (const value of [
      "/opt/homebrew",
      "/usr/local",
      "/Library/Developer/CommandLineTools",
      "/Library/Frameworks",
      "/private/etc/ssl",
      ...runtimeMimeTypeFiles(),
    ]) {
      if (fs.existsSync(value)) add(value)
    }
    for (const entrypoint of entrypoints) {
      const located = path.isAbsolute(entrypoint) ? entrypoint : Bun.which(entrypoint)
      if (!located) continue
      add(path.dirname(located))
      try {
        const real = fs.realpathSync.native(located)
        add(path.dirname(real))
        installation(real)
      } catch {
        // A missing/broken entrypoint is not made readable. Spawn will fail
        // normally rather than widening the policy around an ambiguous path.
      }
    }
    return [...roots]
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

  /** Canonicalize one user-configured writable root. Invalid, ambiguous, or
   * over-broad roots are rejected by settings/CLI callers before persistence;
   * buildPolicy repeats the same check so hand-edited config still fails closed. */
  export function writableGrant(input: string): string | undefined {
    const canonical = canonicalPolicyPath(input)
    if (!canonical || tooBroadToConfine(canonical)) return
    return canonical
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
    temporary: string
    readable?: string[]
    extraWritable?: string[]
    unreadable?: string[]
    entrypoints?: string[]
    options: Options
    backend: Backend
    /** Defaults to the real platform; passed explicitly so the Windows policy
     *  is reachable from a Linux test, the way `plan`/`wrapArgv` already are. */
    platform?: NodeJS.Platform
  }): Policy {
    const writableInputs = [
      ...input.workspace,
      input.temporary,
      ...(input.options.allowWrite ?? []),
      ...(input.extraWritable ?? []),
    ]
    const writable = dedupe(writableInputs).filter((p) => {
      if (tooBroadToConfine(p)) {
        log.warn("refusing to grant sandbox write access to an over-broad path", { path: p })
        return false
      }
      return true
    })
    const readableInputs = [
      ...runtimeReadRoots(input.entrypoints ?? []),
      ...input.workspace,
      ...(input.readable ?? []),
      ...(input.extraWritable ?? []),
      ...writable,
    ]
    const readable = dedupe(readableInputs).filter((value) => !tooBroadToConfine(value))
    const unreadableInputs = input.unreadable ?? []
    // Three-state, not main's boolean: "allowlist" is the whole point of this
    // branch and it is neither "no network" nor "the host's network".
    const network = resolved(input.options).network
    const base = {
      writable,
      readable,
      readableExact: traversalRoots(readable),
      unreadable: dedupe(unreadableInputs).filter((value) => !tooBroadToConfine(value)),
      readableAliases: mountAliases(readableInputs),
      writableAliases: mountAliases(writableInputs),
      unreadableAliases: mountAliases(unreadableInputs),
      network,
    }

    // Seatbelt's egress route is a bare TCP loopback port plus the
    // `Proxy-Authorization` secret that port requires (see seatbeltProfile
    // and Options.egress's doc comment), not a filesystem path —
    // options.egress here is "<port>:<secret>", and none of the path
    // machinery below (dedupe's path.resolve, tooBroadToConfine) applies to
    // it: resolving "52341:abc" against cwd would silently turn it into an
    // absolute path and corrupt it. Port and secret are validated and
    // dropped together — a port with no secret would compose a proxy URL
    // seatbelt's own proxy always rejects, which is a confusing way to fail
    // compared to the same "allowlist requires an egress port" throw a wholly
    // missing value already produces (seatbeltProfile is the fail-closed
    // enforcement point, the same division of labour bubblewrapArgs already
    // has with the path branch immediately below).
    if (input.backend === "seatbelt") {
      const raw = input.options.egress
      const at = raw?.indexOf(":") ?? -1
      const port = at > 0 ? Number(raw!.slice(0, at)) : undefined
      const secret = at > 0 ? raw!.slice(at + 1) : undefined
      const valid = port !== undefined && Number.isInteger(port) && port > 0 && !!secret
      if (raw !== undefined && !valid) {
        // Only the port half, never the secret: this is a warning, not an
        // error path guarded by anything that stops it reaching a log
        // sink — logging the credential half here would defeat the whole
        // point of requiring one.
        log.warn("refusing to grant sandbox egress access to an invalid port/secret pair", {
          port: at > 0 ? raw!.slice(0, at) : raw,
        })
      }
      return { ...base, ...(valid ? { port, secret } : {}) }
    }

    // dedupe() applies the same path.resolve() normalization used for
    // writable/unreadable above, so a trailing slash, a double slash, or an
    // unresolved ".." can't slip an over-broad path past tooBroadToConfine's
    // AppContainer's egress is a named pipe, identified by a NAME rather than a
    // filesystem path (`\\.\pipe\<name>` is a namespace of its own, not a
    // directory). It must skip the path machinery below for exactly the reason
    // seatbelt's port:secret does: `dedupe`'s `path.resolve` would silently
    // rewrite `openscience-broker-abc` into an absolute path under the current
    // directory, and the launcher would then ask for a pipe nobody serves.
    if (input.backend === "appcontainer") {
      // `egress` arrives as "port:secret", the same shape seatbelt gets, because
      // the host-side proxy IS the same one: a TCP listener on loopback, which
      // the host may reach freely. What differs is only how the CONTAINER
      // reaches it, and that is the broker's pipe rather than a policy value.
      const raw = input.options.egress?.trim()
      const at = raw ? raw.lastIndexOf(":") : -1
      const port = at > 0 ? Number(raw!.slice(0, at)) : undefined
      const secret = at > 0 ? raw!.slice(at + 1) : undefined
      const proxyOk = !!port && Number.isInteger(port) && port > 0 && !!secret
      if (raw && !proxyOk) {
        log.warn("refusing to grant sandbox egress access to an invalid port/secret pair", {
          port: at > 0 ? raw.slice(0, at) : raw,
        })
      }
      // A pipe name per run, unguessable, and never a path: `\\.\pipe\` is its
      // own namespace, so `dedupe`'s path.resolve would rewrite it into a
      // directory under the cwd and the launcher would serve a pipe nobody dials.
      const pipe = proxyOk ? `openscience-broker-${randomBytes(16).toString("hex")}` : undefined
      // `readable` matters HERE and nowhere else, which is why it was missed.
      //
      // bubblewrap mounts the whole filesystem read-only (`--ro-bind / /`) and
      // seatbelt allows reads unless denied, so on both of those a path the
      // process only needs to READ is already reachable and `readable` is a
      // no-op. An AppContainer is the opposite: it reaches nothing whose ACL
      // does not name its package SID. Dropping `readable` there left the
      // kernel unable to read its own interpreter — measured as `dir` returning
      // "Access is denied" and a venv redirector reporting `No Python at ...`
      // for a base interpreter that was present the whole time.
      // The binary itself joins the read set when a shim is needed: the shim IS
      // this binary, re-entered inside the container, and an AppContainer can
      // execute nothing whose ACL does not name its package SID. Without this
      // the shim cannot start and the payload's proxy is a dead port.
      const shim = pipe ? shimArgv() : undefined
      const granted = dedupe([...(input.readable ?? []), ...(shim?.paths ?? [])]).filter(
        (value) => !tooBroadToConfine(value),
      )
      return {
        ...base,
        profile: appContainerProfile(input.workspace),
        // Overrides base.readable deliberately: on Windows this is a GRANT list
        // (every path gets an ACE naming the package SID), not the "what may be
        // read" set the POSIX backends derive from the workspace. Granting the
        // latter would hand the container an ACE on every workspace path.
        ...(granted.length ? { readable: granted } : {}),
        ...(shim ? { shim: shim.argv } : {}),
        ...(pipe && proxyOk ? { egress: pipe, port, secret } : {}),
      }
    }

    // string checks — the two normalization paths cannot drift apart because
    // this is the exact same helper, not a parallel implementation of it.
    const [egress] = dedupe(input.options.egress ? [input.options.egress] : [])
    const egressOk = egress !== undefined && !tooBroadToConfine(egress)
    if (egress !== undefined && !egressOk) {
      log.warn("refusing to grant sandbox egress access to an over-broad path", { path: egress })
    }
    // `readable` means "make sure the sandbox can read this", and each backend
    // decides what that costs it. bubblewrap already binds the whole filesystem
    // read-only, so the ONLY paths it must re-bind are the ones its own
    // `--tmpfs /tmp` overlay hides. Binding anything else is not merely
    // redundant: bwrap then has to create the mountpoint under a read-only
    // root and fails — measured as
    // `bwrap: Can't mkdir .../uv/python/cpython-3.12-linux-x86_64-gnu/bin`
    // when the base interpreter was passed as readable, which broke three green
    // Linux installs.
    //
    // Deciding that HERE rather than in the caller is what lets callers stay
    // platform-agnostic: `Installer` and the kernels say what must be readable
    // and never which backend needs telling.
    const readBind = dedupe(input.readable ?? [])
      .filter((value) => !tooBroadToConfine(value))
      .filter((value) => value === "/tmp" || value.startsWith("/tmp/"))
    return { ...base, ...(readBind.length ? { readBind } : {}), ...(egressOk ? { egress } : {}) }
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
   * `(deny network*)` then, for "allowlist" only, a narrow re-allow scoped
   * to exactly one loopback port — the host-side proxy `EgressRuntime`
   * starts for seatbelt (see egress-runtime.ts). Seatbelt has no network
   * namespace to sever the way bubblewrap's `--unshare-net` does, so there
   * is no unix socket to bind-mount either: the profile itself is the only
   * boundary, which is why the deny must always precede the allow (an
   * allow with no prior deny is the unfiltered, unrestricted-egress shape
   * this function must never produce) and why a missing, non-positive, or
   * out-of-range port throws rather than silently falling back to a bare
   * deny — the same fail-closed rule `bubblewrapArgs` applies to a missing
   * egress socket. Falling back to a plain deny instead of throwing would
   * look identical to a user asking for `network: "deny"`, which is not
   * what "allowlist" means and is exactly the kind of silent downgrade this
   * branch exists to avoid.
   *
   * Three allow lines, not one: `docs/adr/0002-sandbox-network-policy.md`
   * records the reference implementation
   * (`anthropic-experimental/sandbox-runtime`) as permitting
   * `network-bind`/`network-inbound`/`network-outbound`, all narrowed to the
   * proxy's loopback port, filter spelled `tcp` — not the single
   * `network-outbound` with `(remote ip ...)` this function emitted before
   * Task 7's fix round 1. That original, narrower shape was never measured;
   * it was this function's author's own guess at what a TCP `connect()`
   * needs, and a Task 7 review flagged the failure mode a wrong guess
   * produces here: if seatbelt classifies the implicit local port a
   * `connect()` allocates under `network-bind` (this sandboxed process is
   * never a listener, so `network-inbound` is included for the same
   * uncertainty, not because a genuine inbound connection is expected), a
   * profile missing that allow would make "allowlist" unreachable on every
   * real Mac — silently, indistinguishable from the network simply being
   * down, which is the one direction this task must not ship in. Matching a
   * documented, cited-as-working reference is the safer default than an
   * independently-derived narrower profile that has never been measured
   * against a real `sandbox-exec`. `local`/`remote` for `network-bind`+
   * `network-inbound` vs `network-outbound` follows ordinary SBPL
   * convention (bind/inbound describe the local endpoint, outbound the
   * remote one) — the ADR does not itself quote a filter spelling for the
   * first two, only for `network-outbound`, so that pairing is this
   * function's own inference, not a documented fact. See the Task 7
   * report's unverified section: whether seatbelt needs `network-bind`/
   * `network-inbound` at all, and whether `local`/`remote` is the right
   * pairing for them, are both open questions only a Mac can answer.
   *
   * A narrow, accepted consequence of matching that reference shape (Task 7
   * fix round 2): if the host proxy dies while the sandboxed child is still
   * alive, `network-bind`+`network-inbound` on that same ephemeral port
   * would let the child itself bind or listen there. That is still confined
   * to the one port this profile names — not a broader network grant, and
   * not a route to any host the child couldn't already reach through the
   * (now-dead) proxy — so it is not treated as a defect. It is a real
   * property of this design, not a hypothetical one, and belongs next to
   * the other open questions above rather than being silently true.
   *
   * Never asserts enforcement — that a real `sandbox-exec` actually honours
   * this text — only the text itself, its ordering, and this function's own
   * refusal to emit an unfiltered allow. No Mac exists on this project to
   * verify the former; see the Task 7 report for exactly what a Mac owner
   * still needs to run.
   */
  export function seatbeltProfile(policy: Policy): string {
    const lines = [
      "(version 1)",
      "(deny default)",
      '(import "system.sb")',
      "(allow process-fork)",
      "(allow process-exec)",
      "(allow signal (target self) (target children))",
      "(allow process-info* (target self))",
      "(allow file-read-metadata file-test-existence)",
    ]
    // SBPL's `remote ip` filter accepts only `*` and `localhost`, not literal
    // addresses or CIDR ranges. An allow-with-private-denies profile would
    // therefore expose LAN, link-local, and cloud-metadata endpoints. Keep the
    // default deny in force for every socket operation in every policy mode —
    // including "allow", which this branch does NOT reopen. The three lines
    // below are the only sockets any mode gets, and they reach one loopback
    // port that the host proxy answers.
    if (policy.network === "allowlist") {
      const port = policy.port
      if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error("sandbox network 'allowlist' requires an egress port")
      }
      lines.push(`(allow network-bind (local tcp "localhost:${port}"))`)
      lines.push(`(allow network-inbound (local tcp "localhost:${port}"))`)
      lines.push(`(allow network-outbound (remote tcp "localhost:${port}"))`)
    }
    const readable = withPrivateAliases(dedupe(policy.readable ?? []))
    if (readable.length) {
      lines.push(
        `(allow file-read* file-test-existence ${readable.map((value) => `(subpath "${sbpl(value)}")`).join(" ")})`,
      )
    }
    const readableExact = withPrivateAliases(dedupe(policy.readableExact ?? []))
    if (readableExact.length) {
      lines.push(
        `(allow file-read* file-test-existence ${readableExact.map((value) => `(literal "${sbpl(value)}")`).join(" ")})`,
      )
    }
    const unreadable = withPrivateAliases(dedupe(policy.unreadable ?? []))
    const unreadableRules = unreadable
      .map((value) => {
        try {
          return fs.statSync(value).isDirectory() ? `(subpath "${sbpl(value)}")` : `(literal "${sbpl(value)}")`
        } catch {
          return `(literal "${sbpl(value)}")`
        }
      })
      .join(" ")
    if (unreadableRules) lines.push(`(deny file-read* ${unreadableRules})`)
    const writable = withPrivateAliases(dedupe(policy.writable))
    if (writable.length) {
      lines.push(`(allow file-write* ${writable.map((p) => `(subpath "${sbpl(p)}")`).join(" ")})`)
    }
    // Character devices tools legitimately write (null, tty, ptys, urandom, …).
    lines.push('(allow file-write* (subpath "/dev"))')
    // Seatbelt uses the last matching rule, so the sensitive write deny must
    // follow every broad writable-parent allow. These are host-managed
    // enclaves, not merely secrets to hide. Bubblewrap's later tmpfs/dev-null
    // masks enforce the same read/write property on Linux.
    if (unreadableRules) lines.push(`(deny file-write* ${unreadableRules})`)
    return lines.join("\n")
  }

  // ── Linux: bubblewrap (bwrap) ───────────────────────────────────────────────

  /** Host-controlled Linux roots required to start normal dynamically-linked
   * research tools. User data roots (/home, /root, /var) are intentionally not
   * included: projects, installations, and other data enter only through the
   * explicit readable/writable policy below. */
  function linuxRuntimeMounts(): string[] {
    return [
      "/usr",
      "/nix",
      "/etc/ld.so.cache",
      "/etc/ld.so.conf",
      "/etc/ld.so.conf.d",
      "/etc/alternatives",
      "/etc/nsswitch.conf",
      "/etc/passwd",
      "/etc/group",
      "/etc/hosts",
      "/etc/resolv.conf",
      "/etc/gai.conf",
      "/etc/host.conf",
      "/etc/protocols",
      "/etc/services",
      "/etc/localtime",
      "/etc/timezone",
      "/etc/ssl/certs",
      "/etc/ssl/cert.pem",
      "/etc/ssl/openssl.cnf",
      "/etc/pki/tls/certs",
      "/etc/pki/ca-trust",
      "/etc/ca-certificates",
      "/etc/fonts",
      ...runtimeMimeTypeFiles(),
    ].filter((value) => fs.existsSync(value))
  }

  /** Preserve conventional merged-/usr aliases without exposing anything
   * beyond the corresponding host runtime directory. */
  function linuxRuntimeAliases(): string[] {
    const args: string[] = []
    for (const value of ["/bin", "/sbin", "/lib", "/lib32", "/lib64"]) {
      if (!fs.existsSync(value)) continue
      const stat = fs.lstatSync(value)
      if (stat.isSymbolicLink()) {
        args.push("--symlink", fs.readlinkSync(value), value)
        continue
      }
      args.push("--ro-bind", value, value)
    }
    return args
  }

  export function bubblewrapArgs(policy: Policy): string[] {
    // Bubblewrap creates an empty tmpfs root. Populate only runtime and policy
    // grants; never bind the host root, even read-only, because doing so exposes
    // every same-user secret to arbitrary project code.
    const args = ["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"]
    for (const value of linuxRuntimeMounts()) args.push("--ro-bind", value, value)
    args.push(...linuxRuntimeAliases())
    for (const value of dedupe(policy.readable ?? [])) args.push("--ro-bind-try", value, value)
    for (const alias of safeMountAliases(policy.readableAliases)) {
      args.push("--ro-bind-try", alias.source, alias.destination)
    }
    const tmpRoots = new Set(dedupe(["/tmp"]))
    for (const p of dedupe(policy.writable)) {
      // Skip only the /tmp mount root itself — it is provided as a fresh tmpfs and
      // re-binding host /tmp would defeat it. A workspace that lives *under* /tmp
      // still needs binding on top of the tmpfs, or its writes vanish.
      if (tmpRoots.has(p)) continue
      // --bind-try: don't abort if the source path doesn't exist.
      args.push("--bind-try", p, p)
    }
    // Writable aliases deliberately follow readable aliases so an identical
    // destination is upgraded rather than accidentally left read-only.
    for (const alias of safeMountAliases(policy.writableAliases)) {
      args.push("--bind-try", alias.source, alias.destination)
    }
    const unreadable = new Map<string, string>()
    for (const value of dedupe(policy.unreadable ?? [])) unreadable.set(value, value)
    // A mask may safely name a broad source because only its file type is
    // consulted; the source is never mounted into the namespace.
    for (const alias of safeMountAliases(policy.unreadableAliases, true)) {
      unreadable.set(alias.destination, alias.source)
    }
    for (const [destination, source] of unreadable) {
      // bwrap's *-try only tolerates a missing source. With /dev/null as the
      // source it still attempts to create a missing destination, which fails
      // beneath our read-only root before the command can start. An absent
      // credential cannot be read and the sandbox cannot create it, so only
      // mount masks for files that exist when the namespace is assembled.
      if (!fs.existsSync(source)) continue
      if (fs.statSync(source).isDirectory()) args.push("--tmpfs", destination)
      else args.push("--ro-bind-try", "/dev/null", destination)
    }
    // Bubblewrap creates missing destination ancestors in the empty root while
    // assembling nested mounts. Those directories are scaffolding, not policy
    // grants: for example, mounting /home/user/.bun read-only must not leave
    // /home/user writable inside the namespace. Freeze only the root tmpfs
    // after every mount is in place. --remount-ro is non-recursive, so explicit
    // writable binds, the private /tmp tmpfs, /dev, and /proc keep their own
    // intended mount permissions.
    if (policy.network === "allowlist") {
      if (!policy.egress) throw new Error("sandbox network 'allowlist' requires an egress socket path")
      // --unshare-net below is what makes this the ONLY route out: there is no
      // other network device in the namespace. The bind merely makes the socket
      // path reachable, and it is read-only on purpose — the bind shares the
      // host inode, so a read-write one would let a sandboxed process find the
      // path in /proc/self/mountinfo and `chmod 000` it, disabling egress for
      // every other kernel, terminal and job sharing this socket. Verified:
      // chmod fails EROFS while connect() still succeeds.
      args.push("--ro-bind", policy.egress, policy.egress)
    }
    args.push("--remount-ro", "/")
    // bubblewrap cannot express "internet but never host loopback" without a
    // separately configured network namespace. Sharing the host namespace in
    // allow mode would expose 127.0.0.1 services, so fail closed and deny all
    // sockets on this backend in both modes. Host-brokered connectors enforce
    // the curated domain policy outside arbitrary project processes.
    args.push("--unshare-net")
    // The PID namespace's bwrap-owned PID 1 remains alive until every descendant
    // exits. A setsid()+double-fork daemon is reparented to that PID 1 rather than
    // host init, and --die-with-parent kills the namespace if the wrapper/server
    // disappears. This is the kernel-backed lifecycle boundary process groups
    // alone cannot provide.
    // Detach from any controlling terminal inherited from a shared PTY. This
    // closes TIOCSTI-style input injection back into the host session; older
    // bubblewrap builds without this flag fail the backend probe closed.
    args.push("--unshare-pid", "--die-with-parent", "--new-session")
    return args
  }

  /**
   * Wrap an arbitrary argv under `b`, or null when unavailable. `b` is
   * passed in rather than read from `backend()` here — the caller already
   * resolved it (via a possibly-injected `platform`), and re-deriving it
   * from ambient state would silently disagree with that resolution.
   */
  /**
   * A stable AppContainer profile name for a workspace.
   *
   * Windows anchors containment to a package SID derived from this name, and
   * the SID is what filesystem ACEs and the broker pipe's DACL refer to. So the
   * name has to be stable across runs — a fresh name per launch would strand
   * every ACE granted by the previous one — and distinct per project, so two
   * projects cannot read each other's granted paths.
   *
   * Derived from the first workspace root rather than passed in, because the
   * project id is not available this deep and the workspace already identifies
   * the project uniquely. Hashed rather than embedded: a profile name is
   * limited in length and character set, and a path contains separators, drive
   * letters and spaces that are not valid in one.
   */
  export function appContainerProfile(workspace: string[]): string {
    const root = dedupe(workspace)[0] ?? "default"
    return `openscience-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`
  }

  /**
   * Argv that launches `argv` inside an AppContainer.
   *
   * Unlike bubblewrap and seatbelt there is no wrapper executable to exec:
   * AppContainer confinement is applied AT process creation, through
   * `SECURITY_CAPABILITIES` attributes passed to `CreateProcess`. That cannot be
   * expressed as an argv, so the binary becomes its own launcher — exactly the
   * pattern `__egress-shim` already uses at `index.ts:54`, and for the same
   * reason: it needs no additional shipped artifact per architecture.
   *
   * The policy travels as one base64 blob rather than as flags. Windows command
   * lines are re-parsed by `CommandLineToArgvW` with quoting rules that differ
   * from every shell, and paths with spaces, quotes and backslashes are the norm
   * there; a blob with no shell-significant characters cannot be mangled by
   * them. The real argv still follows a `--` so the tail stays readable and
   * matches the contract the other two backends keep.
   */
  export function appContainerArgs(policy: Policy, argv: string[]): string[] {
    if (!policy.profile) throw new Error("sandbox backend 'appcontainer' requires a profile name")
    const spec = {
      profile: policy.profile,
      writable: policy.writable,
      readable: policy.readable ?? [],
      unreadable: policy.unreadable ?? [],
      network: policy.network,
      // Carried explicitly rather than re-derived in the launcher, so what a
      // container was granted is readable straight off the spec blob when
      // auditing a run.
      capabilities: capabilitiesFor(policy.network),
      // The host proxy the broker relays into. Carried so the launcher, which
      // is the only process that knows the container's package SID, can build
      // the pipe's DACL and dial the proxy on the container's behalf.
      ...(policy.port && policy.secret ? { proxy: { port: policy.port, secret: policy.secret } } : {}),
      ...(policy.egress ? { pipe: policy.egress } : {}),
      // The launcher cannot work this out for itself: inside a source checkout
      // `process.execPath` is bun, and bun needs an entry script before a
      // subcommand. Composed where `Installation.isLocal()` is already known.
      ...(policy.shim ? { shim: policy.shim } : {}),
      // The same prefix `wrapArgv` uses to re-enter us as the launcher, carried
      // so the launcher can re-enter us again for the detached shim helper.
      self: [self() ?? process.execPath, ...launcherEntry()],
    }
    return ["__appcontainer-launch", Buffer.from(JSON.stringify(spec), "utf8").toString("base64"), "--", ...argv]
  }

  /**
   * What has to precede `__appcontainer-launch` for the binary to re-enter
   * itself, which differs between a release and a source checkout.
   *
   * In a compiled release `process.execPath` IS the openscience binary, so
   * `openscience __appcontainer-launch ...` runs directly. Under
   * `bun run src/index.ts` — development, and every `bun test` — `process.execPath`
   * is `bun`, and `bun __appcontainer-launch ...` is not a valid invocation: bun
   * needs an entry script first. It exits 1 having printed nothing, which the
   * self-test then reports as a child that produced no output, indistinguishable
   * from a launcher that crashed.
   *
   * Found by CI on a real Windows runner, not by hand: every manual test ran the
   * compiled binary, where this path is correct, so the dev-mode break was
   * invisible from outside. `sandbox test` on a developer's checkout would have
   * reported the sandbox as broken on a machine where it works.
   *
   * The egress shim has the same hazard and solves it by BUNDLING a separate
   * entry, because `shimScript` interpolates its binary as one shell word and a
   * two-word "bun <entry>" cannot be smuggled through. This launcher is a plain
   * argv, so the two-word form is simply expressible and no artifact is needed.
   */
  const launcherEntry = () =>
    self() ? [] : Installation.isLocal() ? [path.resolve(import.meta.dir, "..", "index.ts")] : []

  /**
   * A compiled binary to re-enter INSTEAD of this process, for testing the
   * shipped path from a source checkout.
   *
   * Only honoured when `Installation.isLocal()`, so a release ignores it
   * entirely and no environment variable can redirect what a shipped sandbox
   * executes.
   *
   * It exists because the dev and release re-entry paths are different code and
   * only one of them ships. Under `bun test` the shim is `bun <bundle>`, which
   * on Windows dies inside the container with `error loading current directory`
   * — while `bun --version` in the same container, with the same working
   * directory, exits 0. Two CI rounds went into that difference before the
   * point registered: it is a property of an artifact users never run.
   */
  const self = () => (Installation.isLocal() ? process.env["OPENSCIENCE_SELF_BINARY"] : undefined)

  function specForArgv(argv: string[], policy: Policy, b: Backend): Spec | null {
    switch (b) {
      case "seatbelt":
        return { file: "sandbox-exec", args: ["-p", seatbeltProfile(policy), ...argv] }
      case "bubblewrap":
        return { file: "bwrap", args: [...bubblewrapArgs(policy), "--", ...argv] }
      case "appcontainer":
        // The binary launches itself into the container; see appContainerArgs.
        return { file: self() ?? process.execPath, args: [...launcherEntry(), ...appContainerArgs(policy, argv)] }
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
   * *Why there is a wall-clock deadline and not just an iteration count.* The
   * count alone (150 * 0.02, 3 * 1) only equals 3s where forking `sleep` is
   * nearly free. It isn't everywhere: a macOS CI runner measured 17.1s for
   * the 150-iteration loop — ~114ms per iteration, of which ~94ms is
   * fork/exec of `/bin/sleep`, a 5.7x overshoot of the documented cap. Any
   * machine with expensive process creation (a CPU-throttled container, a
   * loaded box) drifts the same way, so the loop carries an explicit deadline
   * as well. `date +%s` is probed exactly like fractional `sleep` — a build
   * without it leaves the deadline unset and the count is the only cap, which
   * is the behaviour that shipped before — and `+ 4` rather than `+ 3`
   * because `%s` truncates to whole seconds, which would otherwise cut a
   * nominal 3s wait as short as 2.0s.
   *
   * The cap is therefore ~3s in both modes, and 3–4s when the deadline is the
   * one that fires. If the shim never signals, the loop still exits at the cap
   * and the real command runs anyway — against a closed proxy port, which
   * fails fast and visibly (connection refused) rather than hanging forever.
   */
  export function shimScript(input: { binary: string; port: number; socket: string; file: string; args: string[] }) {
    const shim = [quote(input.binary), "__egress-shim", String(input.port), quote(input.socket)].join(" ")
    const real = [quote(input.file), ...input.args.map(quote)].join(" ")
    const marker = quote(SHIM_READY_MARKER)
    // `s`/`n`/`i`/`d`/`t` are plain shell variables, never exported, and
    // `exec` replaces this shell — so none of them reach the real command.
    // `${t:-0}` keeps a `date` that starts failing mid-loop from breaking out
    // early or printing to the real command's stderr: it degrades to the
    // count-only cap, the same direction the probe failing does.
    const wait = [
      `s=0.02; n=150`,
      `sleep "$s" 2>/dev/null || { s=1; n=3; }`,
      `d=$(date +%s 2>/dev/null); case "$d" in ''|*[!0-9]*) d= ;; *) d=$((d + 4)) ;; esac`,
      `i=0; while [ ! -f ${marker} ] && [ "$i" -lt "$n" ] && { [ -z "$d" ] || { t=$(date +%s 2>/dev/null); [ "\${t:-0}" -lt "$d" ]; }; }; do sleep "$s"; i=$((i + 1)); done`,
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
  const stamp = (value: Buffer) => createHash("sha256").update(value).digest("hex").slice(0, 16)

  /**
   * The dev shim as one self-contained module, built once per process.
   *
   * Shared by both backends that need it. bubblewrap wraps it in an `sh`
   * launcher because `shimScript` interpolates a single shell word; the
   * AppContainer launcher spawns an argv and needs only the bundle itself.
   * Neither may fall back to `src/index.ts` — see `egress-shim-entry.ts` for
   * why that graph cannot survive inside the sandbox.
   */
  const devBundle = lazy(() => {
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
    // .mjs, not .js: nothing should make bun's module-type detection for this
    // file depend on a package.json above Global.Path.bin.
    const bundle = path.join(Global.Path.bin, `egress-shim-dev-${stamp(built.stdout)}.mjs`)
    place(bundle, built.stdout, 0o644)
    return bundle
  })

  const shimPlan = lazy((): { binary: string; bind: string[] } => {
    if (!Installation.isLocal()) return { binary: process.execPath, bind: [process.execPath] }
    const bundle = devBundle()
    const script = Buffer.from(`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(bundle)} "$@"\n`)
    const launcher = path.join(Global.Path.bin, `egress-shim-dev-${stamp(script)}.sh`)
    place(launcher, script, 0o755)
    return { binary: launcher, bind: [launcher, bundle, process.execPath] }
  })

  /**
   * The shim as an ARGV plus the paths that must be reachable for it to run —
   * for the AppContainer launcher, which spawns a process rather than
   * interpolating one shell word into a script.
   *
   * A release re-enters its own binary, so both are just `process.execPath`.
   * From source, `bun __egress-shim ...` is not a valid invocation — bun needs
   * an entry script — and CI caught exactly that:
   *
   *     error: Script not found "__egress-shim"
   *     WARNING: Retrying ... 127.0.0.1:52939 ... actively refused it
   *
   * The shim never started and the payload's proxy port was dead. Handing bun
   * `src/index.ts` would fix the invocation and break the containment: an ESM
   * graph is linked before it is evaluated, so the container would need read
   * access to the whole source tree and `node_modules` before the first argv
   * check could run. The bundle keeps the reachable set to two files.
   */
  const shimArgv = (): { argv: string[]; paths: string[] } => {
    const binary = self() ?? (Installation.isLocal() ? undefined : process.execPath)
    if (binary) return { argv: [binary, "__egress-shim"], paths: [binary] }
    const bundle = devBundle()
    return { argv: [process.execPath, bundle], paths: [process.execPath, bundle] }
  }

  // ── planning (consumed by the bash tool and the kernels) ────────────────────

  /**
   * The `HTTP_PROXY`-shaped URL the sandboxed process should use, or
   * `undefined` when nothing composed a route to the proxy at all.
   * Bubblewrap: the shim's fixed `SHIM_PORT`, unauthenticated — the
   * bind-mounted unix socket underneath it is already the sandboxed
   * process's only route out, so the loopback hop inside the namespace
   * needs no credential of its own. Seatbelt: no shim, so the sandboxed
   * process dials `policy.port` directly, and — because that loopback port,
   * unlike a unix socket, carries no filesystem permissions of its own —
   * the URL embeds `policy.secret` as userinfo
   * (`http://os:<secret>@127.0.0.1:<port>`), which pip, curl and requests
   * all parse into a `Proxy-Authorization` header. Both must be present, not
   * just `port`: `buildPolicy` only ever sets them together, so a `port`
   * with no `secret` means something upstream broke that invariant, and
   * this fails closed to "no proxy configured" rather than emitting a URL
   * seatbelt's own proxy would just reject with 407 anyway.
   */
  function proxyUrl(shim: string | undefined, b: Backend, policy: Policy): string | undefined {
    if (shim) return `http://127.0.0.1:${SHIM_PORT}`
    if (b !== "seatbelt" || policy.network !== "allowlist" || !policy.port || !policy.secret) return undefined
    return `http://os:${policy.secret}@127.0.0.1:${policy.port}`
  }

  // Warn only once per process so every command doesn't repeat the same notice.
  const warned = { unavailable: false, loopback: false }

  /**
   * Forget which one-time warnings have been issued.
   *
   * A test seam, and the reason it exists is worth stating: warnings that fire
   * once per process are, by construction, observable only by whichever test
   * runs first. Without this, asserting on one means silently depending on
   * source order — and the assertion stops holding the moment anything above it
   * touches the same path, without failing in a way that says so.
   */
  export function forgetWarnings() {
    warned.unavailable = false
    warned.loopback = false
  }

  /**
   * Well-known capability SIDs. Constants, not derived: these are fixed by
   * Windows and `DeriveCapabilitySidsFromName` would be a second FFI surface to
   * get the same two values.
   */
  const CAPABILITY = {
    /** internetClient — outbound to the internet, any protocol. */
    internet: "S-1-15-3-1",
    /** privateNetworkClientServer — the local subnet. */
    privateNetwork: "S-1-15-3-3",
  }

  /**
   * What an AppContainer is allowed to reach, by policy.
   *
   * `allow` means unrestricted egress on the other two platforms, so it must
   * mean that here too rather than quietly meaning less. Withholding these
   * would make the knob claim more than it delivers, for no security anyone
   * asked for.
   *
   * `allowlist` and `deny` keep ZERO capabilities, and that is load-bearing
   * rather than incidental: under `allowlist` the broker is the enforcement
   * point, so a container that could reach the internet directly would route
   * around the allowlist while still reporting that a policy was applied.
   */
  function capabilitiesFor(network: Policy["network"]): string[] {
    return network === "allow" ? [CAPABILITY.internet, CAPABILITY.privateNetwork] : []
  }

  /**
   * The one thing Windows cannot deliver, said once, with the remedy.
   *
   * AppContainer loopback is blocked at the firewall layer regardless of
   * capability; the only exemption is `CheckNetIsolation LoopbackExempt`, which
   * needs admin — out of scope for this product. So under `allow` a sandboxed
   * process cannot reach a local Ollama, Jupyter, database or model server.
   *
   * `allowlist` CAN reach them, which inverts the usual intuition and is why
   * this message carries a fix rather than an apology: the broker runs on the
   * HOST, and a host process has no loopback restriction, so it dials 127.0.0.1
   * on the container's behalf.
   *
   * That inversion is a wart, and the design records the fix: once `allow` runs
   * the broker too (a superset, matching bubblewrap and seatbelt where `allow`
   * applies no restriction at all), THIS WORDING MUST NARROW to "non-HTTP
   * connections to 127.0.0.1 are unavailable". A warning that overstates a
   * limitation is the same defect as one that understates it, and right now it
   * is accurate only because no broker exists yet.
   *
   * Note what is NOT affected: the probe measured loopback WITHIN the container
   * working, so anything the sandboxed process starts itself is fine —
   * torch.distributed rendezvous, multiprocessing, a Ray or Dask cluster it
   * launches. Only a pre-existing service on the host is out of reach.
   *
   * Routed through the same one-time `warning` channel as "sandbox requested
   * but unavailable" — same species of problem, and a second mechanism for it
   * is how two commands end up disagreeing about the same state.
   */
  function loopbackMessage() {
    return (
      "Windows sandbox: network 'allow' cannot reach 127.0.0.1 - AppContainer loopback is blocked " +
      "and the exemption requires admin. For a local service, use network 'allowlist' and add its " +
      "host: the broker runs outside the container and dials it for you."
    )
  }

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
    if (b === "appcontainer" && resolved(options).network === "allow" && !warned.loopback) {
      warned.loopback = true
      return { backend: b, warning: loopbackMessage() }
    }
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
    /** Additional explicit read-only grant roots for this process. */
    readable?: string[]
    /** Exact host credential files to mask from the process. */
    unreadable?: string[]
    options?: Options
    platform?: NodeJS.Platform
  }): Plan {
    const platform = input.platform ?? process.platform
    const { backend: b, warning } = decide(input.options, platform)
    if (b === "none") {
      return { file: input.command, useShell: input.shell, sandboxed: false, backend: "none", warning }
    }
    const temporary = privateTemp()
    try {
      const policy = buildPolicy({
        workspace: input.workspace,
        temporary,
        readable: input.readable,
        unreadable: input.unreadable,
        entrypoints: [input.shell],
        options: input.options!,
        backend: b,
        platform,
      })
      // withTempEnvironment prefixes `/usr/bin/env TMPDIR=...`, which does not
      // exist on Windows. The AppContainer path already carries variables to the
      // child through `env`, so the private temp rides that instead — same
      // guarantee, expressed the way the platform can express it.
      const posix = b !== "appcontainer"
      const tempEnv = posix ? undefined : { TMPDIR: temporary, TMP: temporary, TEMP: temporary }
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
            args: Shell.invocation(input.shell, input.command),
          })
        : undefined
      // Shell.invocation, not a hardcoded "-c": on Windows the shell is usually
      // cmd.exe, which takes /c and reads -c as "start interactive". Given -c it
      // printed its banner and a prompt, ran nothing, and exited 0 — so every
      // sandboxed command silently did nothing, and the self-test read the banner
      // as a process token. The shim branch is bubblewrap-only and so always
      // POSIX, but it goes through the same helper rather than keeping a second
      // copy of this knowledge, which is how the bug survived in the first place.
      const argv = shim ? ["/bin/sh", "-c", shim] : [input.shell, ...Shell.invocation(input.shell, input.command)]
      const s = specForArgv(
        posix ? withTempEnvironment(argv, temporary) : argv,
        shimmed ? { ...policy, readBind: [...(policy.readBind ?? []), ...shimmed.bind] } : policy,
        b,
      )!
      log.info("sandboxing command", { backend: b, network: policy.network, writable: policy.writable.length })
      const proxy = proxyUrl(shim, b, policy)
      const env = {
        ...(proxy ? { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy } : {}),
        ...(tempEnv ?? {}),
      }
      return {
        file: s.file,
        args: s.args,
        useShell: false,
        sandboxed: true,
        backend: b,
        temporary,
        warning,
        ...(Object.keys(env).length ? { env } : {}),
      }
    } catch (error) {
      cleanup({ temporary })
      throw error
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
    /** Explicit read-only grant roots for this process. */
    readable?: string[]
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
    const temporary = privateTemp()
    try {
      const policy = buildPolicy({
        workspace: input.workspace,
        temporary,
        readable: input.readable,
        extraWritable: input.extraWritable,
        unreadable: input.unreadable,
        entrypoints: [input.file],
        options: input.options!,
        backend: b,
        platform,
      })
      // See plan(): POSIX gets the temp through `/usr/bin/env`, Windows through
      // the same `env` channel that carries the proxy variables.
      const posix = b !== "appcontainer"
      const argv = [input.file, ...input.args]
      const s = specForArgv(posix ? withTempEnvironment(argv, temporary) : argv, policy, b)!
      log.info("sandboxing process", { backend: b, network: policy.network, writable: policy.writable.length })
      const proxy = proxyUrl(undefined, b, policy)
      const env = {
        ...(proxy ? { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy } : {}),
        ...(posix ? {} : { TMPDIR: temporary, TMP: temporary, TEMP: temporary }),
      }
      return {
        file: s.file,
        args: s.args,
        sandboxed: true,
        backend: b,
        temporary,
        warning,
        ...(Object.keys(env).length ? { env } : {}),
      }
    } catch (error) {
      cleanup({ temporary })
      throw error
    }
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

  /**
   * Lines this process wrote, which are never the child's error.
   *
   * The launcher's debug dump was the first offender; the structured logger is
   * the second, and it took a red CI job to notice because the check reported
   * `INFO ... service=openscience api_base=...` as the reason a sandboxed curl
   * failed. Anything on the same stderr that came from us has to be skipped, not
   * just the one prefix that was noticed first.
   */
  const ours = (line: string) =>
    line.startsWith("openscience[") || line.includes("service=openscience") || /^(INFO|WARN|ERROR|DEBUG)\s/.test(line)

  function firstLine(s?: string): string | undefined {
    // Skip our OWN diagnostic lines. The launcher's debug dump goes to the same
    // stderr the checks read for the child's error, so with the dump on, every
    // failure reported the first line of the dump instead of what went wrong —
    // a diagnostic destroying the evidence it exists to surface, for the fourth
    // time in this feature.
    const line = s
      ?.trim()
      .split("\n")
      .map((value) => value.trim())
      .find((value) => value && !ours(value))
    return line || undefined
  }

  /** stdout is captured as well as stderr: the AppContainer check reads the
   *  child's own token from `whoami /groups`, and a check that can only see
   *  exit codes cannot tell "not confined" from "confined but permissive". */
  function runAsync(
    file: string,
    args: string[],
    cwd: string,
    env?: Record<string, string>,
  ): Promise<{ status: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const proc = spawn(file, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        ...(env ? { env: { ...process.env, ...env } } : {}),
      })
      let stdout = ""
      let stderr = ""
      proc.stdout?.on("data", (d) => {
        stdout += d.toString()
      })
      proc.stderr?.on("data", (d) => {
        stderr += d.toString()
      })
      const timer = setTimeout(() => proc.kill("SIGKILL"), 15000)
      proc.once("exit", (code) => {
        clearTimeout(timer)
        resolve({ status: code ?? 1, stdout, stderr })
      })
      proc.once("error", (err) => {
        clearTimeout(timer)
        resolve({ status: 1, stdout, stderr: String(err) })
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
    const outsideRead = path.join(os.tmpdir(), `.openscience-sbx-sibling-${process.pid}`)
    const checks: Check[] = []

    const run = async (command: string, network: "allow" | "deny", env?: Record<string, string>) => {
      const p = plan({ command, shell, cwd: work, workspace: [work], options: { enabled: true, network } })
      try {
        return await runAsync(p.file, p.args ?? [], work, env)
      } finally {
        cleanup(p)
      }
    }

    try {
      // Windows first, because every other check below is meaningless if this
      // one fails. A child that never entered the container looks EXACTLY like
      // a container with no policy applied: writes escape and the network works.
      // Separating "the launcher did not confine it" from "it is confined and
      // the policy is wrong" is the difference between debugging CreateProcess
      // and debugging the spec, and they are indistinguishable from outside.
      if (b === "appcontainer") {
        // `exit 0`, not `whoami /groups`. The check used to run whoami and
        // pattern-match its output, which made containment depend on a command
        // succeeding INSIDE the container. On a CI runner it does not: whoami
        // resolves SIDs to display names through LSA, which an AppContainer with
        // zero capabilities cannot reach, so it exits 66 having printed nothing —
        // while `exit 7` through the identical plan returns 7, proving the
        // container hosts processes fine. Two rounds were spent reading that as a
        // containment failure, after four spent on other diagnostics that
        // reported conclusions rather than observations.
        //
        // The launcher holds the child's process handle, so it asks the kernel
        // TokenIsAppContainer directly and reports the answer. Nothing here
        // depends on what the child can do.
        const query = await run("exit 0", "allow", { OPENSCIENCE_APPCONTAINER_REPORT: "1" })
        const reported = query.stderr.match(/openscience\[appcontainer\] token appcontainer=(\d|\?)/)?.[1]
        const confined = reported === "1"
        checks.push({
          name: "the child actually runs inside the AppContainer",
          pass: confined,
          detail: confined
            ? "the kernel reports TokenIsAppContainer=1 for the child"
            : [
                reported === undefined
                  ? `the launcher never reported a token (child exit ${query.status})`
                  : reported === "?"
                    ? "the child's token could not be read"
                    : "the kernel reports TokenIsAppContainer=0: SECURITY_CAPABILITIES did not take effect",
                firstLine(query.stderr),
                process.env["OPENSCIENCE_SANDBOX_DEBUG"] === "1" ? `\n${query.stderr.trim()}` : undefined,
              ]
                .filter(Boolean)
                .join(": "),
        })
        if (!confined) {
          checks.push({
            name: "write outside the workspace is blocked",
            pass: false,
            skipped: true,
            detail: "inconclusive - the child is not in a container",
          })
          return { backend: b, available: true, checks, ok: false }
        }
      }

      // `printf` and `cat` do not exist in cmd.exe. The probe was POSIX-only, so
      // on Windows this check could never pass and reported the sandbox as
      // unable to write inside its own workspace — when the real fault was that
      // the command did not exist. Compose per shell family instead.
      const probe = path.join(work, "probe")
      const write = (target: string, text: string) => {
        switch (Shell.family(shell)) {
          case "cmd":
            // No space before ">", or cmd writes the space into the file.
            return `echo ${text}>"${target}"`
          case "powershell":
            return `$ErrorActionPreference='Stop'; Set-Content -LiteralPath "${target}" -Value '${text}'`
          default:
            return `printf ${text} > "${target}"`
        }
      }
      const read = (target: string) => {
        switch (Shell.family(shell)) {
          case "cmd":
            return `type "${target}"`
          case "powershell":
            return `Get-Content -LiteralPath "${target}"`
          default:
            return `cat "${target}"`
        }
      }
      // `;` for PowerShell because `&&` is PowerShell 7 only, and 5.1 is still
      // what a default Windows box has; $ErrorActionPreference makes the first
      // statement failing terminate the pipeline anyway.
      const join = Shell.family(shell) === "powershell" ? "; " : " && "
      const inside = await run(`${write(probe, "hi")}${join}${read(probe)}`, "allow")
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

      fs.writeFileSync(outsideRead, "sibling-secret", { mode: 0o600 })
      const ungrantedRead = await run(`cat "${outsideRead}"`, "deny")
      checks.push({
        name: "read outside explicit grants is blocked",
        pass: ungrantedRead.status !== 0,
        detail: ungrantedRead.status === 0 ? `read succeeded for ungranted ${outsideRead}` : undefined,
      })

      fs.rmSync(outside, { force: true })
      const escape = await run(write(outside, "x"), "allow")
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

      if (Bun.which("curl")) {
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("sandbox probe") })
        try {
          const target = `http://127.0.0.1:${server.port}`
          const control = await fetch(target).then((response) => response.text())
          const denied = await run(`curl -m 2 -s -o /dev/null ${target}`, "allow")
          checks.push({
            name: "network sockets are denied by the backend",
            pass: control === "sandbox probe" && denied.status !== 0,
            detail: denied.status === 0 ? "loopback access succeeded despite backend deny-all" : undefined,
          })
        } finally {
          server.stop(true)
        }
      } else {
        checks.push({
          name: "network sockets are denied by the backend",
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
        fs.rmSync(outsideRead, { force: true })
      } catch {}
      try {
        fs.rmSync(work, { recursive: true, force: true })
      } catch {}
      // The workspace was a mkdtemp, so the profile derived from it is
      // throwaway too. Without this every self-test run orphaned a profile and
      // an AppData\Local\Packages folder — visible as a different package SID
      // on each run. A real project reuses one profile forever and must not be
      // cleaned up this way.
      if (b === "appcontainer") {
        try {
          const { AppContainer } = await import("./appcontainer")
          AppContainer.removeProfile(appContainerProfile([work]))
        } catch {}
      }
    }

    return { backend: b, available: true, checks, ok: checks.filter((c) => !c.skipped).every((c) => c.pass) }
  }
}
