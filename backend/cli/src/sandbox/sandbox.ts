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
 * Both backends are deny-by-default and expose only system/runtime roots plus
 * explicit session grants. Linux bubblewrap starts from its native empty tmpfs
 * root; mounting the host root, even read-only, would defeat read isolation.
 */
export namespace Sandbox {
  export type Backend = "seatbelt" | "bubblewrap" | "none"

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
    /** Whether the sandboxed process may reach the network. */
    network: boolean
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
    /** Unique owner-only host temp directory granted only to this process. */
    temporary?: string
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
    /** Unique owner-only host temp directory granted only to this process. */
    temporary?: string
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
      const res = spawnSync(bin, [...bubblewrapArgs({ writable: [], network: false }), "--", "/usr/bin/true"], {
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

  function withTempEnvironment(argv: string[], temporary: string, runtime?: { python?: string; path?: string }) {
    const bin = (() => {
      if (!runtime?.python) return
      const value = path.join(temporary, "runtime", "bin")
      fs.mkdirSync(value, { recursive: true })
      for (const name of process.platform === "win32" ? ["python.exe", "python3.exe"] : ["python", "python3"]) {
        const link = path.join(value, name)
        try {
          fs.symlinkSync(runtime.python, link, process.platform === "win32" ? "file" : undefined)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        }
      }
      return value
    })()
    const inherited = runtime?.path ?? process.env.PATH
    return [
      "/usr/bin/env",
      `TMPDIR=${temporary}`,
      `TMP=${temporary}`,
      `TEMP=${temporary}`,
      // zsh does not use TMPDIR for here-documents or process substitutions.
      // Its independent TMPPREFIX defaults to /tmp/zsh, which is deliberately
      // read-only inside the sandbox. Keep those files in the same private,
      // owner-only temp root as every other runtime.
      `TMPPREFIX=${path.join(temporary, "zsh")}`,
      ...(bin ? [`PATH=${[bin, inherited].filter(Boolean).join(path.delimiter)}`] : []),
      ...argv,
    ]
  }

  /** Stable writable config/cache roots for tools launched through the shell.
   * The OS sandbox intentionally leaves the user's home read-only; without
   * these overrides Git and scientific runtimes either warn, rebuild caches
   * for every command, or fail before useful work starts. */
  export function cacheEnvironment(workspace: string) {
    const cache = path.join(workspace, ".openscience", "cache")
    return {
      MPLCONFIGDIR: path.join(cache, "matplotlib"),
      XDG_CONFIG_HOME: path.join(workspace, ".openscience", "config"),
      XDG_CACHE_HOME: path.join(cache, "xdg"),
      NUMBA_CACHE_DIR: path.join(cache, "numba"),
      JOBLIB_TEMP_FOLDER: path.join(cache, "joblib"),
      PIP_CACHE_DIR: path.join(cache, "pip"),
      UV_CACHE_DIR: path.join(cache, "uv"),
      PYTHONPYCACHEPREFIX: path.join(cache, "pycache"),
    }
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
        // OpenScience's managed starters and task environments live below
        // <data>/conda/envs/<name>. Grant the selected environment, not the
        // surrounding data root, so its stdlib and shared libraries remain
        // readable after the interpreter itself starts.
        { marker: "/conda/envs/", depth: 1 },
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
      for (const root of ["/opt/conda", "/opt/anaconda3", "/opt/miniconda3", "/opt/rocm", "/opt/cuda", "/opt/nvidia"]) {
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
      path.join(os.homedir(), ".local", "share", "uv", "python"),
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

  /** Assemble the writable allowlist for a policy, dropping over-broad roots. */
  function buildPolicy(input: {
    workspace: string[]
    temporary: string
    readable?: string[]
    extraWritable?: string[]
    unreadable?: string[]
    entrypoints?: string[]
    options: Options
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
    return {
      writable,
      readable,
      readableExact: traversalRoots(readable),
      unreadable: dedupe(unreadableInputs).filter((value) => !tooBroadToConfine(value)),
      readableAliases: mountAliases(readableInputs),
      writableAliases: mountAliases(writableInputs),
      unreadableAliases: mountAliases(unreadableInputs),
      network: (input.options.network ?? "allow") !== "deny",
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
    // default deny in force for every socket operation in both policy modes.
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
    /** Additional explicit read-only grant roots for this process. */
    readable?: string[]
    /** Exact host credential files to mask from the process. */
    unreadable?: string[]
    /** Canonical local runtime used by both persistent kernels and shell reruns. */
    runtime?: { python?: string; path?: string }
    options?: Options
  }): Plan {
    const { backend: b, warning } = decide(input.options)
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
        entrypoints: [input.shell, input.runtime?.python].filter((value): value is string => !!value),
        options: input.options!,
      })
      const s = specForArgv(withTempEnvironment([input.shell, "-c", input.command], temporary, input.runtime), policy)!
      log.info("sandboxing command", { backend: b, network: policy.network, writable: policy.writable.length })
      return { file: s.file, args: s.args, useShell: false, sandboxed: true, backend: b, temporary, warning }
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
  }): Wrapped {
    const { backend: b, warning } = decide(input.options)
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
      })
      const s = specForArgv(withTempEnvironment([input.file, ...input.args], temporary), policy)!
      log.info("sandboxing process", { backend: b, network: policy.network, writable: policy.writable.length })
      return { file: s.file, args: s.args, sandboxed: true, backend: b, temporary, warning }
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
    const outsideRead = path.join(os.tmpdir(), `.openscience-sbx-sibling-${process.pid}`)
    const checks: Check[] = []

    const run = async (command: string, network: "allow" | "deny") => {
      const p = plan({ command, shell, cwd: work, workspace: [work], options: { enabled: true, network } })
      try {
        return await runAsync(p.file, p.args ?? [], work)
      } finally {
        cleanup(p)
      }
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

      fs.writeFileSync(outsideRead, "sibling-secret", { mode: 0o600 })
      const ungrantedRead = await run(`cat "${outsideRead}"`, "deny")
      checks.push({
        name: "read outside explicit grants is blocked",
        pass: ungrantedRead.status !== 0,
        detail: ungrantedRead.status === 0 ? `read succeeded for ungranted ${outsideRead}` : undefined,
      })

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
    }

    return { backend: b, available: true, checks, ok: checks.filter((c) => !c.skipped).every((c) => c.pass) }
  }
}
