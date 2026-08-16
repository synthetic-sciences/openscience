import fs from "fs/promises"
import { realpathSync } from "fs"
import os from "os"
import path from "path"
import { Config } from "../config/config"
import { Global } from "../global"
import { EgressRuntime } from "../sandbox/egress-runtime"
import { Sandbox } from "../sandbox/sandbox"

/**
 * The installer ladder and the sandboxed run.
 *
 * The install runs in the SAME sandbox as the kernel, not a second more
 * permissive one. Earlier drafts specified a separate network-enabled install
 * sandbox because the kernel's was network-denied; the allowlist proxy removed
 * that asymmetry, so the only differences are what is writable — the
 * environment directory and a package cache inside it.
 *
 * uv is a fast path, never a requirement: `python3 -m venv` bootstraps pip
 * offline from the interpreter's bundled `ensurepip` wheel, verified inside
 * `--unshare-net` on a host whose `python3` has no pip at all. Never
 * auto-download uv — probe, use if present, throw a remedy if not. House
 * precedent: `compute/modal/volume.ts:112-116`.
 */
export namespace Installer {
  export type Tool = { kind: "existing" | "uv" | "venv"; binary: string; report?: Report }

  const bindir = process.platform === "win32" ? "Scripts" : "bin"
  const exe = process.platform === "win32" ? ".exe" : ""

  /** PEP 503 normalisation, matching `Requirement.parse`. Both sides of an
   *  additivity comparison have to agree or an upgrade looks like an addition. */
  const normalise = (value: string) => value.replace(/[-_.]+/g, "-").toLowerCase()

  /** The environment's own interpreter — what kernels bind to, and what every
   *  install and verification runs through. */
  export function interpreter(directory: string) {
    return path.join(directory, bindir, `python${exe}`)
  }

  /**
   * The environment's R library directory — R's equivalent of the interpreter
   * binding, since R has no per-environment binary to point at. Reached through
   * `R_LIBS_USER`, which is already in the kernel env allowlist.
   *
   * Kept beside `interpreter` rather than in the R installer so both language
   * backends derive their paths from one place; a kernel needs this before any
   * R install has ever run.
   */
  export function rlibrary(directory: string) {
    return path.join(directory, "rlibs")
  }

  /**
   * The base interpreter a managed environment delegates to, per its own
   * `pyvenv.cfg` — not a guess, the value venv itself wrote.
   *
   * A venv does not contain a complete Python. On Windows `Scripts\python.exe`
   * is a REDIRECTOR that starts the interpreter named by `home`; on POSIX the
   * binary is a symlink to it. Either way the base installation has to be
   * reachable, and inside an AppContainer nothing is reachable unless its ACL
   * says so. Without this the redirector reported `No Python at '...'` for an
   * interpreter that was present and working the whole time.
   */
  /**
   * Everything about the base installation that must be readable, not just the
   * directory `pyvenv.cfg` names.
   *
   * On POSIX `home` is `<prefix>/bin` — the directory holding the interpreter —
   * so granting it alone leaves `<prefix>/lib` unreachable, and with it the
   * entire standard library. A python-build-standalone interpreter then falls
   * back to its baked-in build prefix and dies before it can report why:
   *
   *     sys.path = ['/install/lib/python312.zip', '/install/lib/python3.12', ...]
   *     Fatal Python error: init_fs_encoding: failed to get the Python codec
   *     ModuleNotFoundError: No module named 'encodings'
   *
   * Invisible while bubblewrap mounted `--ro-bind / /`, because the whole tree
   * was there whether or not anyone asked. On Windows `home` IS the prefix, so
   * the parent is added only when the leaf is the POSIX `bin`.
   */
  export async function baseRoots(directory: string) {
    const home = await base(directory)
    if (!home) return []
    return path.basename(home) === "bin" ? [home, path.dirname(home)] : [home]
  }

  export async function base(directory: string) {
    const cfg = Bun.file(path.join(directory, "pyvenv.cfg"))
    if (!(await cfg.exists().catch(() => false))) return undefined
    const text = await cfg.text().catch(() => "")
    for (const line of text.split("\n")) {
      const home = line.match(/^\s*home\s*=\s*(.+?)\s*$/)?.[1]
      if (home) return home
    }
    return undefined
  }

  /**
   * A tool on PATH that actually runs.
   *
   * `Bun.which` alone is not enough, and Windows is where that bites. A default
   * install has `python3.exe` and `python.exe` in `WindowsApps` as App
   * Execution Aliases: zero-byte reparse points that open the Microsoft Store
   * instead of an interpreter. `which` finds them, `python3 -m venv <dir>`
   * appears to do something, and the environment is then created without an
   * interpreter inside it. Measured on a real Windows machine: every install
   * failed with `Executable not found in $PATH` naming
   * `...\envs\<project>\default\Scripts\python.exe`, with nothing
   * explaining why the environment was empty.
   *
   * `findPython` in the notebook tool has always verified with `--version`;
   * this path had drifted from it. Same check, same reason.
   */
  const which = (name: string) => {
    const found = Bun.which(name)
    if (!found) return undefined
    try {
      const proc = Bun.spawnSync([found, "--version"], { stdout: "ignore", stderr: "ignore" })
      return proc.exitCode === 0 ? found : undefined
    } catch {
      return undefined
    }
  }

  /**
   * EVERY match for a bare name on PATH, in PATH order — not just the first.
   *
   * `Bun.which` answers once, so a single unusable early hit hides every valid
   * interpreter behind it and the search ends there. Both Windows failures seen
   * so far have this shape: a `WindowsApps` alias early on PATH, and an MSYS2
   * build ahead of a real python.org install. Rejecting a candidate has to mean
   * "keep looking", not "give up".
   */
  async function onPath(name: string) {
    const out: string[] = []
    const seen = new Set<string>()
    for (const dir of (process.env["PATH"] ?? "").split(path.delimiter).filter(Boolean)) {
      const full = path.join(dir, name)
      const key = process.platform === "win32" ? full.toLowerCase() : full
      if (seen.has(key)) continue
      seen.add(key)
      if (await Bun.file(full).exists()) out.push(full)
    }
    return out
  }

  export type Report = { exe: string; version: number[]; platform: string; purelib: string; prefix: string }

  /** One round trip that answers everything worth knowing about a candidate.
   *  `sysconfig` is the authority on the layout it will produce, so we ask it
   *  rather than inferring the layout from `process.platform`. */
  const PROBE =
    "import sys,sysconfig,json;print(json.dumps({" +
    "'exe':sys.executable,'version':list(sys.version_info[:2])," +
    "'platform':sysconfig.get_platform(),'purelib':sysconfig.get_paths()['purelib'],'prefix':sys.prefix}))"

  export async function inspect(binary: string): Promise<Report | undefined> {
    // Every failure mode of a candidate must answer "not usable", never throw.
    // spawn throws outright on a file that exists but is not executable, and
    // PATH is full of those; JSON.parse throws on a candidate that runs but
    // prints something else. Either would abort the whole search at the first
    // bad entry rather than moving on to the next one.
    try {
      const proc = Bun.spawn([binary, "-c", PROBE], { stdout: "pipe", stderr: "ignore" })
      const out = await new Response(proc.stdout).text()
      await proc.exited
      if (proc.exitCode !== 0) return undefined
      return JSON.parse(out.trim())
    } catch {
      return undefined
    }
  }

  /**
   * Why this interpreter cannot build an environment the rest of the module can
   * use — or undefined if it can.
   *
   * The case this exists for, measured on a real Windows machine: PATH had no
   * `python3.exe` until `C:\msys64\mingw64\bin`, so MSYS2's MinGW Python won,
   * and MSYS2 is the one Windows-native build that patches `sysconfig` to the
   * POSIX scheme. It created a perfectly valid environment at
   * `<env>/lib/python3.9/site-packages` with `<env>/bin/python.exe`, while
   * every other path in this module looks under `Scripts\`. `python -m venv`
   * exited 0 and `ensurepip` genuinely ran, so nothing upstream could tell.
   *
   * Checking the scheme rather than only the vendor is what makes this general:
   * it disqualifies Cygwin and any future cross-built oddity by the property
   * that actually breaks us, before anything is written to disk. The vendor
   * check runs first only because it produces the clearer sentence.
   */
  /**
   * Can the sandbox be given read access to this path?
   *
   * `icacls` can only change an ACL the caller owns, so on Windows an all-users
   * install under `C:\` — owned by SYSTEM and Administrators — can never be made
   * readable to an AppContainer without elevation, which this product does not
   * ask for. A machine-wide Python is therefore unusable for a SANDBOXED run
   * however healthy the interpreter itself is, and choosing it produces a
   * grant failure several layers from the choice. Measured that way:
   * `icacls C:\Python312` denied, then `No Python at ...` and exit 103.
   *
   * Ownership is not directly readable here, so this uses the proxy that
   * actually decides it: paths under the user's profile are owned by the user.
   */
  export function grantable(candidate: string) {
    if (process.platform !== "win32") return true
    const home = process.env["USERPROFILE"] ?? os.homedir()
    return !!home && candidate.toLowerCase().startsWith(home.toLowerCase())
  }

  export function reject(report: Report): string | undefined {
    if (process.platform !== "win32") return undefined
    if (/[\\/](msys\d*|mingw\d*|clang\d*|cygwin\d*)[\\/]/i.test(report.exe))
      return `${report.exe} is an MSYS2/Cygwin build, which lays environments out with the POSIX scheme`
    if (!report.platform.startsWith("win-"))
      return `${report.exe} reports platform ${report.platform}, not a native win-* build`
    if (!/[\\/]Lib[\\/]site-packages$/i.test(report.purelib))
      return `${report.exe} uses the POSIX layout (${report.purelib}) rather than Lib\\site-packages`
    return undefined
  }

  /**
   * The first interpreter on PATH that passes `reject`, plus the reasons the
   * ones before it did not — so a failure can say what it looked at.
   *
   * `python` before `python3` on Windows is deliberate and is the fix for the
   * MSYS2 selection above. python.org ships `python.exe` and NO `python3.exe`,
   * so on Windows `python3` resolves to either the Store alias or a POSIX
   * flavoured distribution almost by definition. On every other platform the
   * usual order holds, where `python` may still be Python 2.
   *
   * The `py` launcher is consulted first where it exists, being the authoritative
   * registry of installed interpreters — but it is only a source of candidates,
   * never a requirement: it was absent on the very machine this bug came from.
   */
  export async function select() {
    const rejected: string[] = []
    const ungrantable: string[] = []
    const names = process.platform === "win32" ? ["python.exe", "python3.exe"] : ["python3", "python"]
    const candidates: string[] = []
    if (process.platform === "win32") candidates.push(...(await registered()))
    for (const name of names) candidates.push(...(await onPath(name)))
    const seen = new Set<string>()
    for (const candidate of candidates) {
      const key = process.platform === "win32" ? candidate.toLowerCase() : candidate
      if (seen.has(key)) continue
      seen.add(key)
      const report = await inspect(candidate)
      if (!report) {
        rejected.push(`${candidate} did not run (a Microsoft Store alias behaves this way)`)
        continue
      }
      const why = reject(report)
      if (why) {
        rejected.push(why)
        continue
      }
      // Prefer one the sandbox can actually be granted, but do not refuse the
      // other outright: an unsandboxed run works fine with a machine-wide
      // Python, and failing closed here would break users who never enable the
      // sandbox at all.
      if (!grantable(candidate)) {
        ungrantable.push(candidate)
        continue
      }
      return { binary: candidate, report, rejected }
    }
    // Nothing the sandbox could be granted. Fall back to one it cannot, so an
    // unsandboxed run still works, and record why the sandbox will complain.
    for (const candidate of ungrantable) {
      const report = await inspect(candidate)
      if (report)
        return {
          binary: candidate,
          report,
          rejected: [
            ...rejected,
            `${candidate} is outside your user profile, so the sandbox cannot be granted read access to it`,
          ],
        }
    }
    return { binary: undefined, report: undefined, rejected }
  }

  /** Interpreters the `py` launcher knows about. Absent launcher is normal. */
  async function registered() {
    const py = Bun.which("py")
    if (!py) return []
    const proc = Bun.spawn([py, "-0p"], { stdout: "pipe", stderr: "ignore" })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    if (proc.exitCode !== 0) return []
    return out
      .split("\n")
      .map((line) => line.match(/(\S:\\.*python(?:w)?\.exe)/i)?.[1])
      .filter((found): found is string => Boolean(found))
  }

  /**
   * Why Python environments cannot be provisioned here, or undefined if they can.
   *
   * Deliberately NOT called from `decide()` or `plan()`. Answering it means
   * running candidate interpreters, which is far too expensive for a path every
   * sandboxed command goes through. It is for the surfaces where a human is
   * asking: `sandbox status`, the settings panel, and the agent's guidance.
   *
   * The case it exists for is Windows-specific and not obvious from any error
   * the user would otherwise see. An AppContainer can only be granted access to
   * paths its user OWNS, so a machine-wide Python -- `C:\Python312`,
   * `C:\Program Files\Python` -- can never be read by a sandboxed process, no
   * matter how healthy the interpreter is. Measured on a real machine:
   *
   *   C:\Python312  SYSTEM:(F)  Administrators:(F)  Users:(RX)
   *
   * with no ALL APPLICATION PACKAGES entry to read it by, and only `RX` for the
   * user, so no way to add one. `icacls` answers "Access is denied" and the run
   * fails several layers later as `No Python at '...'`.
   *
   * Containment itself is unaffected, and saying otherwise would be worse than
   * saying nothing: shell commands stay confined, writes stay blocked, egress
   * stays bounded. Only Python environments and kernels are unavailable.
   */
  /** Does uv have an interpreter under the user's profile? `uv python list`
   *  prints every interpreter it knows, managed and system alike, so the test is
   *  whether any line names a path we could actually be granted. */
  /** First line of a uv subcommand's stdout, or undefined if it failed. */
  async function ask(uv: string, ...argv: string[]) {
    const proc = Bun.spawn([uv, ...argv], { stdout: "pipe", stderr: "ignore" })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    if (proc.exitCode !== 0) return undefined
    return out
  }

  /**
   * uv reports paths under the home directory RELATIVE to it — in `--output-format
   * json` exactly as in the human table, which is the part that was assumed and
   * is now measured. From a real Windows machine, uv 0.12.4:
   *
   *     "path":"AppData\\Roaming\\uv\\python\\cpython-3.12.13-...\\python.exe"
   *     "path":"C:\\Python312\\python.exe"
   *
   * Absolute and home-relative in the same array. Resolving the relative ones
   * against the process cwd is what made `grantable()` pass on a path that does
   * not exist; rejecting them outright is what then hid every uv interpreter on
   * the machine and told a user with working uv to go install uv.
   */
  const absolute = (candidate: string) =>
    path.isAbsolute(candidate) ? candidate : path.resolve(process.env["USERPROFILE"] ?? os.homedir(), candidate)

  const under = (root: string, candidate: string) => {
    const rel = path.relative(root, candidate)
    return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel)
  }

  /**
   * An interpreter uv MANAGES that we could actually be granted, as an absolute
   * path — or undefined.
   *
   * Two filters, and both earned their place from a failed run.
   *
   * `uv python dir` gives the root uv installs into, and only candidates beneath
   * it are accepted. `uv python list` reports discovered system interpreters and
   * uv's own shims alongside the real installs, and both are traps here: a
   * system Python is the ungrantable case this whole path exists to route
   * around, and `~/.local/bin/python3.12.exe` is a uv TRAMPOLINE — a stub that
   * re-execs the interpreter it points at. Pinning `--python` to the trampoline
   * produced exactly "uv trampoline failed to spawn Python child process:
   * permission denied (os error 5)". Nothing in the JSON marks either kind
   * (`symlink` is null for the trampoline), so the install root is the only
   * discriminator available.
   *
   * Then `grantable()`, which is the actual requirement: the sandbox can only be
   * granted paths the user owns.
   */
  export async function managed(): Promise<string | undefined> {
    const uv = which("uv")
    if (!uv) return undefined
    try {
      const dir = await ask(uv, "python", "dir")
      const root = dir?.split("\n")[0]?.trim()
      if (!root) return undefined
      const out = await ask(uv, "python", "list", "--only-installed", "--output-format", "json")
      if (!out) return undefined
      const entries = JSON.parse(out) as Array<{ path?: string; key?: string; symlink?: string | null }>
      const candidates = entries
        .map((entry) => entry.path)
        .filter((candidate): candidate is string => !!candidate)
        .map(absolute)
        .filter((candidate) => under(absolute(root), candidate) && grantable(candidate))
      for (const candidate of candidates) if (await fs.stat(candidate).catch(() => undefined)) return candidate
      return undefined
    } catch {
      return undefined
    }
  }

  export async function blocked(): Promise<string | undefined> {
    if (process.platform !== "win32") return undefined
    if (!Sandbox.available()) return undefined
    // uv being installed is not the same as uv having an interpreter we can
    // use: `uv venv` builds from whatever uv DISCOVERS, which on a machine like
    // this one can be the same machine-wide Python. Only a managed interpreter
    // under the user's profile actually helps, so ask for one rather than
    // treating uv's presence as an all-clear — which is precisely the false
    // reassurance this check gave when uv was installed and nothing improved.
    if (which("uv") && (await managed())) return undefined
    const chosen = await select()
    if (chosen.binary && grantable(chosen.binary)) return undefined
    return [
      chosen.binary
        ? `Python environments are unavailable: the sandbox cannot be granted access to ${chosen.binary}.`
        : "Python environments are unavailable: no interpreter was found.",
      "Windows only lets you grant access to paths you own, so a machine-wide Python cannot be used by a",
      "sandboxed process. Containment is unaffected - shell commands are still confined.",
      "",
      "Fix either way:",
      "  winget install --id=astral-sh.uv   then   uv python install 3.12",
      "  or reinstall Python from python.org with 'Install for all users' left OFF",
    ].join("\n")
  }

  /**
   * The ladder, in order: an existing environment wins over any tool, then uv,
   * then venv, then a remedy.
   *
   * `available` exists so the uv/venv branches are testable on a machine that
   * has only one of them; real callers omit it and get a live probe.
   */
  export async function probe(directory: string, available?: { uv?: string; python?: string }): Promise<Tool> {
    const existing = await Bun.file(interpreter(directory))
      .exists()
      .catch(() => false)
    if (existing) {
      // An environment pins its base interpreter in pyvenv.cfg at creation, and
      // nothing re-selects afterwards. So one built when the only candidate was
      // a machine-wide Python stays bound to it forever — and under the sandbox
      // that is fatal, because the base has to be granted and an all-users
      // install can never be. Installing uv afterwards changes nothing: the
      // environment still names the old base.
      //
      // Measured exactly that way. After uv and a user-owned 3.12.13 were
      // installed, every retry still failed with "could not grant sandbox
      // access to C:\Python312" — the path in the existing pyvenv.cfg, not
      // anything selection would choose now.
      //
      // Falling through rebuilds it: create() clears a directory that already
      // has a pyvenv.cfg, so the next tool builds a fresh environment on a base
      // that works.
      const home = await base(directory)
      if (!home || grantable(home) || !Sandbox.available()) return { kind: "existing", binary: interpreter(directory) }
    }

    const uv = available ? available.uv : (which("uv") ?? undefined)
    if (uv) return { kind: "uv", binary: uv }

    if (available?.python) return { kind: "venv", binary: available.python }
    const chosen = available ? { binary: undefined, report: undefined, rejected: [] } : await select()
    if (chosen.binary) return { kind: "venv", binary: chosen.binary, report: chosen.report }

    throw new Error(
      [
        "No way to create a Python environment on this machine.",
        // What was looked at and why each one lost. Without this the message is
        // indistinguishable on a machine with no Python at all and on one whose
        // only Python is disqualified — two problems with different remedies.
        ...(chosen.rejected.length
          ? [
              "Interpreters were found, but none can build a usable environment:",
              ...chosen.rejected.map((r) => `  - ${r}`),
            ]
          : []),
        "Install one of:",
        "  - the venv module: `apt install python3-venv` on Debian/Ubuntu (most other distributions ship it with python3)",
        "  - uv: https://docs.astral.sh/uv/getting-started/installation/",
        "OpenScience never downloads either automatically.",
      ].join("\n"),
    )
  }

  /**
   * Create the environment. A no-op when it already exists — rebuilding would
   * silently discard everything installed into it.
   *
   * `--seed` on the uv branch is load-bearing, not a nicety. `python3 -m venv`
   * bootstraps pip from `ensurepip`; `uv venv` deliberately does not, and
   * `install()` shells out to `python -m pip` regardless of who created the
   * environment. Without it the uv branch produces an environment the
   * installer cannot use at all — measured as `No module named pip` from a
   * venv that looked perfectly healthy from outside the sandbox.
   *
   * Seeding rather than adding a second `uv pip install` path keeps one
   * install code path to test and maintain, and leaves the environment usable
   * by hand. The cost is a few hundred milliseconds at creation only.
   */
  export async function create(directory: string, tool: Tool) {
    if (tool.kind === "existing") return
    // A tree left behind by a failed creation poisons every retry after it.
    // `probe` only calls an environment "existing" when the interpreter is where
    // this module expects it, so a half-built tree falls through to here — and
    // both `venv` and `uv` then short-circuit on the directory already being
    // there, report success, and replace nothing. Measured on Windows: after the
    // first bad creation, every retry printed "Requirement already satisfied"
    // for pip and setuptools and failed identically, with no way out but
    // deleting the directory by hand. Reaching this line at all means the tree
    // is unusable, so clear it.
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(path.dirname(directory), { recursive: true })
    // `--system-site-packages` is not a convenience, it repairs a cliff.
    //
    // A kernel binds to the managed environment as soon as one exists, and
    // falls back to the host interpreter while it does not. So without this,
    // the FIRST install of anything silently removed every host package from
    // every kernel in the project: install `tqdm`, lose `numpy`. Measured in
    // real use — the notebook tool advertises numpy/pandas/scipy/matplotlib as
    // pre-imported, and they vanished the moment an environment appeared.
    //
    // Inheriting is strictly a superset of the behaviour kernels had before
    // managed environments existed, when they simply WERE the host
    // interpreter, so it exposes nothing new: host site-packages was already
    // readable under `--ro-bind / /`. The environment's own packages still take
    // precedence, so installing a newer version shadows the host's.
    //
    // The cost is that the environment is not hermetic. A hermetic mode is a
    // reasonable future flag; it is the wrong default for a tool whose users
    // expect the scientific stack to be there.
    // Name the interpreter when the default would not do. `uv venv` builds from
    // whatever uv DISCOVERS, and on a machine whose PATH leads with a
    // machine-wide Python that is the one it picks — so a rebuild triggered
    // precisely BECAUSE the old base was ungrantable would land straight back on
    // it, fail identically, and rebuild again on the next attempt.
    // win32 ONLY. Grantability is a Windows question -- bubblewrap and seatbelt
    // read any path the user can read -- so pinning elsewhere would override
    // uv's own choice of interpreter for no reason. It did, briefly: four Linux
    // tests changed which Python they built against, because grantable() is
    // unconditionally true off Windows and every uv-listed path therefore
    // "qualified".
    const pinned =
      process.platform === "win32" && tool.kind === "uv" && Sandbox.available() ? await managed() : undefined
    const argv =
      tool.kind === "uv"
        ? [tool.binary, "venv", "--seed", "--system-site-packages", ...(pinned ? ["--python", pinned] : []), directory]
        : [tool.binary, "-m", "venv", "--system-site-packages", directory]
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" })
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited
    if (proc.exitCode !== 0) throw new Error(`Could not create the environment at ${directory}.\n${err || out}`)
    // Exit code 0 is not proof. A Windows App Execution Alias standing in for
    // python exits cleanly having created nothing, and the failure then
    // surfaced much later as "Executable not found in $PATH" from the install
    // step, naming a path with no hint as to why it was missing. Assert the
    // thing the rest of this module depends on, at the moment it should exist.
    //
    // Report what was MEASURED, never a guess at the cause. The previous
    // version of this message asserted that Windows failures "usually mean" a
    // Microsoft Store alias. On the machine that produced the next failure that
    // claim was false — a real CPython had run and `ensurepip` had completed —
    // and it cost a full debugging cycle, because the message read as a finding
    // rather than as a hypothesis. Everything below is something we looked at.
    const found = await locate(directory)
    const check = found ? await inspect(found) : undefined
    const rooted = check ? same(check.prefix, directory) : false
    if (!found || !same(found, interpreter(directory)) || !rooted) {
      const listing = await fs.readdir(directory).catch(() => [] as string[])
      // Leave nothing behind for the next run to short-circuit on.
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
      throw new Error(
        [
          `Creating the environment at ${directory} reported success, but it has no usable interpreter at ${interpreter(directory)}.`,
          `  created with: ${tool.binary} (exit code ${proc.exitCode})`,
          tool.report ? `  which reports: platform ${tool.report.platform}, purelib ${tool.report.purelib}` : undefined,
          found ? `  an interpreter was found instead at: ${found}` : "  no interpreter was found anywhere in the tree",
          found && check && !rooted ? `  and it reports sys.prefix ${check.prefix}, not ${directory}` : undefined,
          found && !check ? "  and it did not run" : undefined,
          listing.length ? `  the tree contains: ${listing.join(", ")}` : "  the tree is empty",
          (err || out).trim(),
        ]
          .filter(Boolean)
          .join("\n"),
      )
    }
  }

  /**
   * Compare two paths as the host filesystem would — following symlinks.
   *
   * `path.resolve` alone is not enough, and macOS is where that bites. The
   * system temp directory is `/var/folders/...`, and `/var` is a firmlink to
   * `/private/var`, so Python reports `sys.prefix` under `/private/var` while
   * the caller holds the `/var` spelling. The two are the same directory and
   * compared unequal, so EVERY environment creation on macOS was judged to have
   * produced no usable interpreter, deleted itself, and threw — taking the
   * merge-gate tests with it. The sandbox already carries `withPrivateAliases`
   * for this exact firmlink; this is the same hazard in a second place.
   */
  const same = (a: string, b: string) => {
    const real = (value: string) => {
      const resolved = path.resolve(value)
      try {
        return realpathSync(resolved)
      } catch {
        return resolved
      }
    }
    const [x, y] = [real(a), real(b)]
    return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y
  }

  /**
   * The interpreter a creation actually produced, searched across both layouts
   * rather than assumed at one path.
   *
   * `interpreter()` names where this module REQUIRES the interpreter to be;
   * this finds where it IS. The two differing is the whole diagnosis in the
   * POSIX-layout case, so the error can only say so if it looks in both places.
   */
  export async function locate(directory: string) {
    for (const dir of ["Scripts", "bin"])
      for (const name of ["python.exe", "python3.exe", "python", "python3"]) {
        const full = path.join(directory, dir, name)
        if (await Bun.file(full).exists()) return full
      }
    return undefined
  }

  /**
   * The wheel cache, shared by every environment on the machine.
   *
   * Deliberately NOT inside the environment directory, which is where it lived
   * first. A per-environment cache means every new environment re-downloads
   * everything: measured at 34 MB and a full download for scipy alone, in a
   * second environment that had just been populated in the first — and the
   * packages that make this hurt are the large ones, where it is hundreds of
   * megabytes per environment.
   *
   * It is our own cache directory rather than user data, so sharing it across
   * projects costs nothing in isolation terms. pip's cache is content-addressed
   * and safe for concurrent readers and writers, which matters because the
   * per-environment lock does not serialise installs into DIFFERENT
   * environments.
   */
  const shared = () => path.join(Global.Path.cache, "pip")

  /** Sandboxed argv for a command run against the environment: the same policy
   *  the kernel gets, plus write access to the environment directory and the
   *  shared wheel cache. */
  async function confined(directory: string, argv: string[], extraReadable: string[] = []) {
    const policy = await Config.trustedSandbox()
    const egress = await EgressRuntime.egressFor(policy)
    // The base interpreter is READ-only on purpose: the install must be able to
    // start Python, not to modify the Python installation it runs on. Stated
    // unconditionally — which backend needs telling is the sandbox's business,
    // not the installer's.
    const roots = [...(await baseRoots(directory)), ...extraReadable]
    return Sandbox.wrapArgv({
      file: argv[0]!,
      args: argv.slice(1),
      workspace: [directory, shared()],
      ...(roots.length ? { readable: roots } : {}),
      options: { ...policy, egress },
    })
  }

  /**
   * The most recent line of pip output worth showing a human.
   *
   * pip reports phase and size continuously — "Collecting torch", "Downloading
   * torch-…whl (906.4 MB)", "Installing collected packages: …" — and all of it
   * used to be buffered and discarded unless the install failed. A pytorch
   * install sat behind an unchanging ellipsis for 1m37s while that ran.
   *
   * Progress-bar redraws and continuation lines are skipped: they are noise at
   * one line of visible status, and a bar rendered to a pipe is mostly control
   * characters anyway.
   */
  const progressLine = (chunk: string) => {
    const lines = chunk
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !/^[━╸\-=|/\\ ]*$/.test(l) && !l.startsWith("|"))
    return lines.at(-1)
  }

  export async function install(input: {
    directory: string
    packages: string[]
    index: string
    source: boolean
    signal?: AbortSignal
    /** Called with a short status as pip reports it. */
    onProgress?: (status: string) => void
  }) {
    // Two different directories with two different lifetimes. The wheel cache is
    // shared across environments so a package is downloaded once per machine;
    // the scratch directory pip unpacks into stays environment-local, because it
    // is throwaway and sharing it would let concurrent installs collide.
    const cache = shared()

    await fs.mkdir(cache, { recursive: true })
    // Wheels-only is a speed and reliability default, NOT a security boundary:
    // if bwrap contains agent Python at import time it contains setup.py at
    // install time.
    const policy = input.source ? [] : ["--only-binary", ":all:"]
    /**
     * uv on Windows, pip everywhere else.
     *
     * Not a preference — a workaround for an upstream defect with a name.
     * CPython 3.12.4 changed `os.mkdir(mode=0o700)` so `tempfile.mkdtemp()`
     * creates a directory whose DACL does NOT inherit from its parent. Inside an
     * AppContainer, access comes from the package SID; a DACL naming only the
     * owner grants the process nothing. So pip downloads a wheel and then cannot
     * write into the `pip-unpack-*` directory it just made:
     *
     *     [Errno 13] Permission denied: '...\pip-unpack-xxxx\six-1.17.0-...whl.metadata'
     *
     * See python/cpython#134587. Two fixes are open upstream and unreleased.
     * uv is Rust and never calls CPython's tempfile, so it is unaffected.
     *
     * Windows ONLY, deliberately. Linux and macOS install correctly today and
     * are verified doing so on every push; switching their installer inside a
     * fix for someone else's Windows bug would change working, security-relevant
     * code for no reason. uv and pip can also resolve the same requirement to
     * different closures, and the environment manifest records what landed, so
     * the difference is captured rather than hidden.
     *
     * uv is not optional on Windows anyway: it is how a grantable interpreter
     * gets there at all, which `blocked()` already tells the user.
     */
    const uv = process.platform === "win32" ? which("uv") : undefined
    // The CANONICAL spelling, not the one the directory was built from.
    //
    // `os.tmpdir()` on Windows can return an 8.3 short path (`C:\Users\RUNNER~1`),
    // and every path that reaches `grant()` is canonicalised on the way — so the
    // ACE lands on `C:\Users\runneradmin\...` while uv is handed
    // `C:\Users\RUNNER~1\...`. Same file, different name, and Windows checks the
    // name presented rather than the file behind it. This branch has already
    // paid for that twice: uv's reparse-pointed interpreter directory, and the
    // shim's lexical path under the data-root symlink.
    const target = uv ? realpathSync.native(interpreter(input.directory)) : interpreter(input.directory)
    if (uv && process.env["OPENSCIENCE_SANDBOX_DEBUG"] === "1") {
      process.stderr.write(`openscience[install] interpreter as built: ${interpreter(input.directory)}\n`)
      process.stderr.write(`openscience[install] interpreter canonical: ${target}\n`)
    }
    const argv = uv
      ? [
          uv,
          "pip",
          "install",
          // Verbose under the sandbox debug flag only. uv reports a failure to
          // query an interpreter as a bare "Access is denied. (os error 5)",
          // which names neither the path it opened nor the operation - and
          // guessing at which of those it was has been the expensive mistake of
          // this whole feature.
          ...(process.env["OPENSCIENCE_SANDBOX_DEBUG"] === "1" ? ["-vv"] : []),
          "--python",
          target,
          ...policy,
          ...(input.index ? ["--index-url", input.index] : []),
          ...input.packages,
        ]
      : [
          interpreter(input.directory),
          "-m",
          "pip",
          "install",
          "--disable-pip-version-check",
          ...policy,
          ...(input.index ? ["--index-url", input.index] : []),
          ...input.packages,
        ]
    // The uv binary itself joins the read set when it is the installer: an
    // AppContainer can execute nothing whose ACL does not name its SID, and uv
    // lives under the user profile rather than in the environment.
    const spec = await confined(input.directory, argv, uv ? [uv] : [])
    const proc = Bun.spawn([spec.file, ...(spec.args ?? [])], {
      // No TMPDIR of our own. It used to be `<env>/.tmp`, pre-created here on the
      // host — and on Windows the sandbox cannot make a pre-existing
      // SUBDIRECTORY writable: `icacls /setintegritylevel (OI)(CI)L` labels the
      // granted root and does not propagate to children that already exist, and
      // Mandatory Integrity Control is evaluated before the DACL. Measured
      // directly: a directory created before the launch is unwritable inside the
      // container while one created inside it is fine. pip then failed unpacking
      // a wheel it had already downloaded, which read as a transport fault.
      //
      // `spec.env` carries TMPDIR/TMP/TEMP for the sandbox's own per-spawn temp
      // root, which IS granted and labelled as a root. Letting that through is
      // both the fix and the reason the mechanism exists.
      env: {
        ...process.env,
        ...spec.env,
        PIP_CACHE_DIR: cache,
        // uv's default cache is under %LOCALAPPDATA%, which the sandbox does not
        // grant. Point it at the same writable wheel cache pip uses, and refuse
        // interpreter downloads: the interpreter is chosen before this runs and
        // silently fetching another would defeat that.
        ...(uv ? { UV_CACHE_DIR: cache, UV_PYTHON_DOWNLOADS: "never" } : {}),
        // uv is Rust and honours RUST_LOG. `-vv` names the operation but not the
        // resource: its error attaches the interpreter path as CONTEXT for which
        // interpreter was being queried, while the Io error underneath may be
        // about something else entirely — a temp file, a handle. Four hypotheses
        // about which have now been wrong, so this asks rather than guesses.
        ...(uv && process.env["OPENSCIENCE_SANDBOX_DEBUG"] === "1" ? { RUST_LOG: "trace", RUST_BACKTRACE: "1" } : {}),
      },
      // The environment, not wherever the server happens to be running. A
      // sandboxed child inherits this working directory, and the sandbox is not
      // granted the server's cwd — the same latent fault that killed the egress
      // shim outright, where the process was created and then died on its first
      // syscall. pip needs no particular cwd (its arguments are package names),
      // so the only requirement is that the child can reach it.
      cwd: input.directory,
      stdout: "pipe",
      stderr: "pipe",
      signal: input.signal,
    })
    // Drained as it arrives rather than awaited whole, so a caller can report
    // progress. The full text is still accumulated: `explain()` needs the
    // entire log to find the `fatal error:` line, which is rarely last.
    const drain = async (stream: ReadableStream<Uint8Array>, report: boolean, into: { out: string; err: string }) => {
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const piece = decoder.decode(value, { stream: true })
        // Accumulated where the caller can still read it if the race below
        // gives up: a partial log explains a hang, a discarded one does not.
        if (report) into.out += piece
        else into.err += piece
        if (!report || !input.onProgress) continue
        const status = progressLine(piece)
        if (status) input.onProgress(status)
      }
    }
    // pip writes its progress to stdout and its diagnostics to stderr; only the
    // former is worth surfacing as status.
    const collected = { out: "", err: "" }
    const finished = Promise.all([drain(proc.stdout, true, collected), drain(proc.stderr, false, collected)])
    // Wait on the PROCESS, then give the drains a bounded moment to flush.
    //
    // Awaiting the drains alone hangs forever on an abort. `signal` kills the
    // launcher, but the sandboxed child inherits its stdio handles and is not a
    // child of this process at all — on Windows it is created by CreateProcessW
    // inside the container — so it keeps the write end of both pipes open and
    // `reader.read()` never reports done. Measured: a 150s AbortSignal produced
    // no return at all and the caller sat until its own 300s timeout, twice,
    // each time discarding the output that would have explained the failure.
    await proc.exited
    await Promise.race([finished, Bun.sleep(2_000)])
    return { ok: proc.exitCode === 0, log: [collected.out, collected.err].filter(Boolean).join("\n") }
  }

  /** name → version for everything resolved into the environment, names PEP 503
   *  normalised so they compare against parsed requirements. */
  export async function freeze(directory: string) {
    // `--local` matters now that environments inherit system site-packages:
    // without it this reports every host package too, which would make `total`
    // meaningless, bury the requested names in the agent's inventory, and turn
    // `additive()` into a comparison against the machine rather than against
    // the environment. What this environment OWNS is the question being asked.
    const proc = Bun.spawn([interpreter(directory), "-m", "pip", "list", "--local", "--format=json"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    const parsed = (() => {
      try {
        return JSON.parse(text) as { name: string; version: string }[]
      } catch {
        return []
      }
    })()
    return Object.fromEntries(parsed.map((p) => [normalise(p.name), p.version]))
  }

  /**
   * Every package the environment's interpreter can import, inherited ones
   * included — what a KERNEL bound to this environment actually sees.
   *
   * Distinct from `freeze()` on purpose, and the distinction is load-bearing.
   * `freeze()` answers "what does this environment own", which is the right
   * question for the manifest. The restart decision asks something else: has
   * what the kernel can import changed underneath it? Comparing owned-sets got
   * that wrong the moment environments began inheriting system site-packages —
   * requesting the version the host already provides installs nothing locally,
   * so the package is absent from the "before" snapshot, and the next version
   * then reads as an ADDITION rather than a change. Measured on CI:
   * `six==1.16.0` then `six==1.17.0` reported additive, so kernels holding a
   * stale `six` in memory were never restarted — exactly the silent staleness
   * the rule exists to prevent.
   */
  export async function resolved(directory: string) {
    const proc = Bun.spawn([interpreter(directory), "-m", "pip", "list", "--format=json"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    const parsed = (() => {
      try {
        return JSON.parse(text) as { name: string; version: string }[]
      } catch {
        return []
      }
    })()
    return Object.fromEntries(parsed.map((p) => [normalise(p.name), p.version]))
  }

  /**
   * Report the version of each requested name **as the environment's own
   * interpreter resolves it**, whether it lives in the environment or is
   * inherited from the host.
   *
   * Asked of the interpreter rather than of `freeze()`, which lists only what
   * the environment owns. Since environments inherit system site-packages, pip
   * treats a host-provided package as already satisfied and installs nothing —
   * so a `freeze`-based answer reported "(nothing reported)" for a request that
   * is, from the user's seat, perfectly satisfied. The question worth answering
   * is "can the kernel use it, and at what version", and only the interpreter
   * can answer that.
   *
   * `importlib.metadata` rather than a real import: it reads distribution
   * metadata, so it needs no heavy import, triggers no import side effects, and
   * handles name normalisation itself. It still catches an installer that
   * exited 0 without producing anything usable, which is the point.
   */
  export async function verify(directory: string, packages: string[]) {
    const script = [
      "import json, sys",
      "from importlib.metadata import version, PackageNotFoundError",
      "out = {}",
      "for name in json.loads(sys.argv[1]):",
      "    try:",
      "        out[name] = version(name)",
      "    except PackageNotFoundError:",
      "        pass",
      "print(json.dumps(out))",
    ].join("\n")
    const proc = Bun.spawn([interpreter(directory), "-c", script, JSON.stringify(packages)], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    try {
      return JSON.parse(text) as Record<string, string>
    } catch {
      return {}
    }
  }

  /**
   * Turn a pip log into something a reader can act on.
   *
   * Two surfaces matter. The wheels-only rejection reads as "no such package"
   * and means "no wheel under this policy". A build failure's summary line
   * names the package, but the `fatal error:` line above it names the missing
   * system header — which usually means the install is unachievable in a
   * sandbox and a pure-Python alternative is the real answer.
   *
   * An unrecognised log passes through untouched. Inventing a diagnosis for a
   * failure mode nobody anticipated is worse than showing the log.
   */
  export function explain(log: string) {
    const wheels = log.match(/Could not find a version that satisfies the requirement (\S+)[^\n]*from versions: none/)
    if (wheels) {
      return [
        `No wheel is published for ${wheels[1]} under the current wheels-only policy.`,
        `This is not "no such package" — it may exist only as a source distribution.`,
        `Retry with source builds enabled if a compiler and headers are available.`,
      ].join(" ")
    }
    const fatal = log.match(/^\s*fatal error:\s*(.+)$/m)
    const failed = log.match(/Failed building wheel for (\S+)/)
    if (fatal) {
      return [
        failed ? `Building ${failed[1]} failed.` : "A wheel build failed.",
        `The cause is a missing system dependency: ${fatal[1]!.trim()}`,
        `A sandboxed install cannot add system packages — prefer a pure-Python alternative, or a package that publishes wheels.`,
      ].join(" ")
    }
    return log.trim()
  }
}
