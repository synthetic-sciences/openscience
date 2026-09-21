import path from "path"
import fs from "fs/promises"
import z from "zod"
import { Global } from "../global"
import { Installation } from "./index"
import { Log } from "../util/log"

/**
 * The `openscience` a terminal finds when the desktop app is the only install:
 * `~/.openscience/bin/openscience`, a symlink into the application bundle, plus
 * the PATH line the standalone installer writes, byte for byte, so
 * `openscience uninstall` recognises both. The app owns only what it can
 * recognise as its own: an empty slot, or a link that points into an
 * OpenScience bundle. A regular file or a link anywhere else is someone
 * else's install and is never touched.
 */
export namespace CliShim {
  const log = Log.create({ service: "cli-shim" })
  const MARKER = "# openscience"
  const INSTALLER = "curl -fsSL https://openscience.sh/install | bash"

  /** Every input the module reads from the process, overridable so the logic
   *  can run against a temporary home and a fixture bundle. */
  export type Options = {
    home?: string
    bin?: string
    execPath?: string
    env?: NodeJS.ProcessEnv
    platform?: NodeJS.Platform
  }

  /** This copy of OpenScience may not own the slot; the message is the reason
   *  `status()` reports. Anything else `install()` rejects with is a write
   *  the system refused, named by what it was for. */
  export class RefusedError extends Error {
    constructor(reason: string) {
      super(reason)
      this.name = "CliShimRefusedError"
    }
  }

  export const Status = z
    .object({
      home: z.string(),
      directory: z.string(),
      path: z.string(),
      exists: z.boolean(),
      target: z.string().optional(),
      current: z.boolean(),
      ours: z.boolean(),
      onPath: z.boolean(),
      shell: z.string(),
      line: z.string(),
      config: z.string().optional(),
      installable: z.boolean(),
      reason: z.string().optional(),
    })
    .meta({ ref: "CliShimStatus" })
  export type Status = z.infer<typeof Status>

  function resolve(options: Options) {
    const home = options.home ?? Global.Path.home
    // The installer's directory, spelled from the home directory the way its
    // PATH line is. Not `Global.Path.bin`: that is the tool cache under the
    // data root, which the stable data-root link spells as
    // ~/.config/openscience/data-root/bin and a relocated root moves off the
    // home volume, and `openscience uninstall` only strips a line that names
    // ~/.openscience/bin.
    const bin = options.bin ?? path.join(home, ".openscience", "bin")
    const env = options.env ?? process.env
    return {
      home,
      bin,
      env,
      link: path.join(bin, "openscience"),
      execPath: options.execPath ?? process.execPath,
      platform: options.platform ?? process.platform,
      shell: path.basename(env.SHELL ?? ""),
    }
  }
  type Resolved = ReturnType<typeof resolve>

  function bundled(file: string) {
    return Installation.methodFromPaths({ execPath: file }) === "desktop"
  }

  /** A bundle the OS mounts for one run has no path worth linking to. */
  function transient(file: string, env: NodeJS.ProcessEnv) {
    const normalized = file.replaceAll("\\", "/")
    if (env.APPIMAGE || normalized.includes("/.mount_")) {
      return `The Linux AppImage runs from a temporary mount, so a link into it would break when the app quits. Install the command-line app with \`${INSTALLER}\` instead.`
    }
    if (normalized.includes("/AppTranslocation/")) {
      return "macOS is running OpenScience from a quarantine copy. Move OpenScience to Applications and reopen it, then install the command-line tool."
    }
  }

  /** Why this process may not create the link, if it may not. Mirrors
   *  `Installation.method()` and then demands a lasting bundle to point at. */
  function refusal(o: Resolved) {
    if (o.platform === "win32") return "The command-line tool link is not available on Windows yet."
    const desktop =
      !!(o.env.OPENSCIENCE_DESKTOP_UPDATE_URL && o.env.OPENSCIENCE_DESKTOP_UPDATE_TOKEN) || bundled(o.execPath)
    if (!desktop) return "Only the OpenScience desktop app can install its command-line tool."
    if (!bundled(o.execPath)) {
      return "This copy of OpenScience is not inside an application bundle, so there is nothing lasting to link."
    }
    return transient(o.execPath, o.env)
  }

  function tilde(file: string, home: string) {
    return file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file
  }

  /** A write the module was entitled to make and the system refused: the
   *  sentence says what it was for, the system's reason follows. */
  function failed(step: string) {
    return (error: unknown): never => {
      const reason = error instanceof Error ? error.message : String(error)
      log.error("could not install the command-line tool", { step, reason })
      throw new Error(`${step}: ${reason}`, { cause: error })
    }
  }

  function pathLine(shell: string, bin: string) {
    return shell === "fish" ? `fish_add_path ${bin}` : `export PATH=${bin}:$PATH`
  }

  /** The startup files the installer consults for each shell, in its order.
   *  `/etc/profile` is left off the ash and sh lists: the installer would
   *  append there when it is writable, an app should not. An unknown shell
   *  gets the bash list for reading only; the installer prints the line for
   *  such shells instead of writing it, and so does `install()`. */
  function candidates(o: Resolved) {
    const xdg = o.env.XDG_CONFIG_HOME || path.join(o.home, ".config")
    const zdot = o.env.ZDOTDIR || o.home
    const lists: Record<string, string[]> = {
      fish: [path.join(o.home, ".config", "fish", "config.fish")],
      zsh: [
        path.join(zdot, ".zshrc"),
        path.join(zdot, ".zshenv"),
        path.join(xdg, "zsh", ".zshrc"),
        path.join(xdg, "zsh", ".zshenv"),
      ],
      bash: [
        path.join(o.home, ".bashrc"),
        path.join(o.home, ".bash_profile"),
        path.join(o.home, ".profile"),
        path.join(xdg, "bash", ".bashrc"),
        path.join(xdg, "bash", ".bash_profile"),
      ],
      ash: [path.join(o.home, ".ashrc"), path.join(o.home, ".profile")],
      sh: [path.join(o.home, ".ashrc"), path.join(o.home, ".profile")],
    }
    return lists[o.shell] ?? lists.bash
  }

  function writes(shell: string) {
    return ["fish", "zsh", "bash", "ash", "sh"].includes(shell)
  }

  /** The startup file to create when the shell has none, which is every fresh
   *  macOS account: the one a new terminal window reads. macOS terminals open
   *  login shells, and a login bash reads ~/.bash_profile and never ~/.bashrc;
   *  elsewhere a terminal's bash reads ~/.bashrc. It is only ever created when
   *  no candidate exists, because a new ~/.bash_profile would stop bash from
   *  reading an existing ~/.profile. Each is one of the shell's candidates, so
   *  the next status finds the line there and a second install adds nothing.
   *  ash and sh share ~/.profile with every other shell and have no file of
   *  their own, so they keep the printed line. */
  function fresh(o: Resolved) {
    if (o.shell === "zsh") return path.join(o.env.ZDOTDIR || o.home, ".zshrc")
    if (o.shell === "bash") return path.join(o.home, o.platform === "darwin" ? ".bash_profile" : ".bashrc")
    if (o.shell === "fish") return path.join(o.home, ".config", "fish", "config.fish")
  }

  async function existing(files: string[]) {
    const checks = await Promise.all(
      files.map((file) =>
        fs.stat(file).then(
          (stat) => stat.isFile(),
          () => false,
        ),
      ),
    )
    return files.filter((_, index) => checks[index])
  }

  /** Whether a startup file already puts the directory on PATH: the exact
   *  installer line, or the directory in any spelling a person would use.
   *  Anything broader than the installer's exact-line check only ever means
   *  writing less, never twice. */
  function mentions(content: string, o: Resolved) {
    if (content.split("\n").some((entry) => entry === pathLine(o.shell, o.bin))) return true
    const forms = [o.bin]
    if (o.bin.startsWith(o.home + path.sep)) {
      const relative = o.bin.slice(o.home.length + 1)
      forms.push(`~/${relative}`, `$HOME/${relative}`, `\${HOME}/${relative}`)
    }
    return forms.some((form) => content.includes(form))
  }

  function inPath(value: string | undefined, bin: string) {
    return (value ?? "")
      .split(path.delimiter)
      .some((entry) => entry.length > 0 && path.resolve(entry) === path.resolve(bin))
  }

  async function same(target: string, execPath: string) {
    if (path.resolve(target) === path.resolve(execPath)) return true
    const [a, b] = await Promise.all([
      fs.realpath(target).catch(() => undefined),
      fs.realpath(execPath).catch(() => undefined),
    ])
    return a !== undefined && a === b
  }

  /** What occupies the slot. `ours` is whether the app may write there: the
   *  slot is empty, or holds a link into an OpenScience bundle. */
  async function inspect(o: Resolved) {
    const stat = await fs.lstat(o.link).catch(() => undefined)
    if (!stat) return { exists: false, current: false, ours: true }
    if (!stat.isSymbolicLink()) return { exists: true, current: false, ours: false }
    const target = await fs.readlink(o.link).then(
      (value) => path.resolve(path.dirname(o.link), value),
      () => undefined,
    )
    if (target === undefined) return { exists: true, current: false, ours: false }
    return { exists: true, target, current: await same(target, o.execPath), ours: bundled(target) }
  }

  function foreign(found: Awaited<ReturnType<typeof inspect>>, o: Resolved) {
    if (!found.exists || found.ours) return
    const where = tilde(o.link, o.home)
    if (found.target) {
      return `${where} points at ${tilde(found.target, o.home)}, which OpenScience did not create. Remove it first if the app should own it.`
    }
    return `${where} is a file OpenScience did not create (a standalone install, perhaps). Remove it first if the app should own it.`
  }

  async function startupFiles(o: Resolved) {
    const files = await existing(candidates(o))
    const contents = await Promise.all(
      files.map((file) =>
        Bun.file(file)
          .text()
          .catch(() => ""),
      ),
    )
    const configured = contents.findIndex((content) => mentions(content, o))
    return { files, configured: configured >= 0 ? files[configured] : undefined }
  }

  export async function status(options: Options = {}): Promise<Status> {
    const o = resolve(options)
    const [found, startup] = await Promise.all([inspect(o), startupFiles(o)])
    const refused = refusal(o) ?? foreign(found, o)
    return Status.parse({
      home: o.home,
      directory: o.bin,
      path: o.link,
      exists: found.exists,
      target: found.target,
      current: found.current,
      ours: found.ours,
      onPath: inPath(o.env.PATH, o.bin) || startup.configured !== undefined,
      shell: o.shell,
      line: pathLine(o.shell, o.bin),
      config: startup.configured ?? startup.files[0],
      installable: refused === undefined,
      reason: refused,
    })
  }

  // The new link lands under a temporary name and is renamed over the slot,
  // so a link that is being replaced is never missing in between.
  async function link(o: Resolved) {
    await fs.mkdir(o.bin, { recursive: true })
    const temporary = `${o.link}.${process.pid}.tmp`
    await fs.symlink(o.execPath, temporary)
    await fs.rename(temporary, o.link).catch(async (error) => {
      await fs.rm(temporary, { force: true })
      throw error
    })
  }

  /** The installer's decision, in its order: nothing to do when the directory
   *  is already on PATH or the line is already there; otherwise append the
   *  marker and the line to the first startup file that exists, when it is
   *  writable. Where no startup file exists the installer prints the line for
   *  the person at the terminal; nobody is at a terminal here, so the app
   *  creates the shell's own file with the same marker and line. */
  async function configure(o: Resolved) {
    if (inPath(o.env.PATH, o.bin)) return
    const startup = await startupFiles(o)
    if (startup.configured || !writes(o.shell)) return
    const block = `${MARKER}\n${pathLine(o.shell, o.bin)}\n`
    const found = startup.files.at(0)
    if (found) {
      const writable = await fs.access(found, fs.constants.W_OK).then(
        () => true,
        () => false,
      )
      if (!writable) return
      await fs.appendFile(found, `\n${block}`).catch(failed(`Could not add the PATH line to ${tilde(found, o.home)}`))
      log.info("added the command-line directory to PATH", { file: found })
      return
    }
    const file = fresh(o)
    if (!file) return
    // Appending, not writing: a file that appeared since the check is added
    // to rather than replaced.
    await fs
      .mkdir(path.dirname(file), { recursive: true })
      .then(() => fs.appendFile(file, block))
      .catch(failed(`Could not create ${tilde(file, o.home)}`))
    log.info("created a startup file with the command-line directory on PATH", { file })
  }

  /** Create or re-point the link and add the PATH line. Rejects with
   *  `RefusedError` when this process may not own the slot, and with an error
   *  naming the write when the system refused one. */
  export async function install(options: Options = {}): Promise<Status> {
    const o = resolve(options)
    const before = await status(options)
    if (before.reason !== undefined) throw new RefusedError(before.reason)
    if (!before.current) {
      await link(o).catch(failed(`Could not create ${tilde(o.link, o.home)}`))
      log.info("linked the command-line tool", { link: o.link, target: o.execPath })
    }
    await configure(o)
    return status(options)
  }

  /** Re-point a link of ours that targets a missing or different bundle (a
   *  moved or reinstalled app). Never creates a link and never throws: it runs
   *  unattended on every desktop launch. */
  export async function repair(options: Options = {}): Promise<boolean> {
    const o = resolve(options)
    if (o.platform === "win32" || !bundled(o.execPath) || transient(o.execPath, o.env)) return false
    const found = await inspect(o)
    if (!found.target || !found.ours || found.current) return false
    return link(o).then(
      () => {
        log.info("repaired the command-line link", { from: found.target, to: o.execPath })
        return true
      },
      (error) => {
        log.warn("could not repair the command-line link", { error: String(error) })
        return false
      },
    )
  }

  /** Remove the link when it is ours; anything else stays. */
  export async function remove(options: Options = {}): Promise<boolean> {
    const o = resolve(options)
    const found = await inspect(o)
    if (!found.target || !found.ours) return false
    await fs.rm(o.link, { force: true })
    return true
  }
}
