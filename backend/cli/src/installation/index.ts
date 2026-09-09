import { BusEvent } from "@/bus/bus-event"
import path from "path"
import { $ } from "bun"
import z from "zod"
import { NamedError } from "@synsci/util/error"
import { Log } from "../util/log"
import { Flag } from "../flag/flag"
import fs from "node:fs/promises"
import os from "node:os"

declare global {
  const OPENSCIENCE_VERSION: string
  const OPENSCIENCE_CHANNEL: string
  const OPENSCIENCE_LIBC: string
  const OPENSCIENCE_PLATFORM_PACKAGE: string
  const OPENSCIENCE_ARTIFACT_SOURCE: string
}

export namespace Installation {
  const log = Log.create({ service: "installation" })
  const RELEASE_TIMEOUT_MS = 10_000

  function releaseFetch(input: string | URL | Request, init: RequestInit = {}) {
    return fetch(input, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(RELEASE_TIMEOUT_MS),
    })
  }

  export type Method = Awaited<ReturnType<typeof method>>

  export const Event = {
    Updated: BusEvent.define(
      "installation.updated",
      z.object({
        version: z.string(),
      }),
    ),
    UpdateAvailable: BusEvent.define(
      "installation.update-available",
      z.object({
        version: z.string(),
      }),
    ),
  }

  export const Info = z
    .object({
      version: z.string(),
      latest: z.string(),
    })
    .meta({
      ref: "InstallationInfo",
    })
  export type Info = z.infer<typeof Info>

  export async function info() {
    return {
      version: VERSION,
      latest: await latest(),
    }
  }

  export function isPreview() {
    return CHANNEL !== "latest"
  }

  export function isLocal() {
    return CHANNEL === "local"
  }

  export function methodFromPaths(input: { execPath: string; scriptPath?: string }) {
    const exec = input.execPath.replaceAll("\\", "/").toLowerCase()
    const script = (input.scriptPath ?? "").replaceAll("\\", "/").toLowerCase()
    const installed = `${exec}\n${script}`

    if (exec.includes("/.openscience/bin/") || exec.includes("/.synsc/bin/")) return "curl" as const
    // legacy pre-rename curl installs lived under ~/.synsc/bin
    // ~/.local/bin is ALSO npm's target with `--prefix ~/.local`, pipx, and many
    // package managers. Prefer the wrapper's own immutable location over
    // running package-manager discovery inside a user project: yarnPath,
    // npmrc, PATH, or similar project configuration must never execute during
    // a background update check.
    if (installed.includes("/.bun/install/global/")) return "bun" as const
    if (installed.includes("/.config/yarn/global/") || installed.includes("/yarn/global/")) return "yarn" as const
    if (installed.includes("/.pnpm/") || installed.includes("/pnpm/global/")) return "pnpm" as const
    if (installed.includes("/scoop/apps/openscience/")) return "scoop" as const
    if (installed.includes("/chocolatey/")) return "choco" as const
    if (installed.includes("/cellar/openscience/")) return "brew" as const
    if (installed.includes("/node_modules/@synsci/openscience-")) return "npm" as const
    if (script.includes("/node_modules/@synsci/openscience/")) return "npm" as const
    if (exec.includes("/.local/bin/")) return "curl" as const
    return "unknown" as const
  }

  export async function method() {
    if (process.env.OPENSCIENCE_DESKTOP_UPDATE_URL && process.env.OPENSCIENCE_DESKTOP_UPDATE_TOKEN)
      return "desktop" as const
    return methodFromPaths({ execPath: process.execPath, scriptPath: process.argv[1] })
  }

  export const UpgradeFailedError = NamedError.create(
    "UpgradeFailedError",
    z.object({
      stderr: z.string(),
    }),
  )

  export const DesktopUpdateState = z.object({
    phase: z.enum([
      "idle",
      "downloading",
      "extracting",
      "verifying",
      "ready",
      "restarting",
      "restart_blocked",
      "succeeded",
      "failed",
    ]),
    version: z.string().optional(),
    transferred: z.number().nonnegative().optional(),
    total: z.number().positive().optional(),
    progress: z.number().min(0).max(1).optional(),
    completed_at: z.string().optional(),
    error: z.string().optional(),
    migration_required: z.boolean().optional(),
  })
  export type DesktopUpdateState = z.infer<typeof DesktopUpdateState>

  async function desktopRequest(method: "GET" | "POST" | "DELETE", body?: unknown) {
    const url = process.env.OPENSCIENCE_DESKTOP_UPDATE_URL
    const token = process.env.OPENSCIENCE_DESKTOP_UPDATE_TOKEN
    if (!url || !token) throw new Error("The desktop update service is unavailable")
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      const message = await response
        .json()
        .then((value) => value.error)
        .catch(() => undefined)
      throw new UpgradeFailedError({ stderr: message ?? `Desktop update failed (${response.status})` })
    }
    return DesktopUpdateState.parse(await response.json())
  }

  export function desktopUpdateState() {
    return desktopRequest("GET")
  }

  export function stageDesktopUpdate(target: string) {
    return desktopRequest("POST", { action: "stage", version: target })
  }

  export function applyDesktopUpdate(target: string) {
    return desktopRequest("POST", { action: "apply", version: target })
  }

  export function cancelDesktopUpdate() {
    return desktopRequest("DELETE")
  }

  // The formula is published to this tap by script/homebrew.ts; it has never
  // been in homebrew-core, so the unqualified name only resolves once tapped.
  export const BREW_FORMULA = "synthetic-sciences/tap/openscience"

  async function getBrewFormula() {
    const tapFormula = await $`brew list --formula ${BREW_FORMULA}`.throws(false).quiet().text()
    if (tapFormula.includes("openscience")) return BREW_FORMULA
    return "openscience"
  }

  // `curl … | bash` cannot report a failed download: Bun's `$` has no pipefail,
  // so bash reads EOF and exits 0. Fetch the script to disk first.
  async function downloadInstaller(url: string, cwd: string, env: Record<string, string>) {
    const script = path.join(cwd, "install.sh")
    const download = await $`curl -fsSL -o ${script} ${url}`.cwd(cwd).env(env).quiet().throws(false)
    const size = await fs.stat(script).then(
      (stat) => stat.size,
      () => 0,
    )
    if (download.exitCode === 0 && size > 0) return script
    const detail = download.stderr.toString("utf8").trim()
    throw new UpgradeFailedError({
      stderr: `Could not download the installer from ${url}${detail ? `: ${detail}` : " (empty response)"}. Check your network or proxy settings and try again.`,
    })
  }

  // A package manager may replace the executable's versioned directory
  // (Homebrew Cellar, pnpm store), so the command on PATH is the fallback probe.
  async function installedVersion(target: string, cwd: string, env: Record<string, string>) {
    const candidates = [process.execPath, Bun.which("openscience", { PATH: env.PATH ?? "" })]
    let observed: string | undefined
    for (const file of candidates) {
      if (!file || !(await Bun.file(file).exists())) continue
      const result = await $`${file} --version`.cwd(cwd).env(env).quiet().throws(false)
      if (result.exitCode !== 0) continue
      const version = result.stdout.toString("utf8").trim()
      if (version === target) return version
      if (version) observed ??= version
    }
    return observed
  }

  async function verifyUpgrade(method: Method, target: string, cwd: string, env: Record<string, string>) {
    const observed = await installedVersion(target, cwd, env)
    if (observed === target) return
    const hint =
      method === "curl"
        ? "Re-run `curl -fsSL https://openscience.sh/install | bash` and read its output."
        : `Re-run the ${method} upgrade and read its output.`
    if (observed === undefined) {
      throw new UpgradeFailedError({
        stderr: `The ${method} upgrade command finished, but the installed openscience could not be run to confirm its version. ${hint}`,
      })
    }
    if (observed === VERSION) {
      throw new UpgradeFailedError({
        stderr: `The ${method} upgrade command finished, but openscience still reports ${VERSION}. ${hint}`,
      })
    }
    throw new UpgradeFailedError({
      stderr: `The ${method} upgrade command finished, but openscience now reports ${observed} instead of ${target}. ${hint}`,
    })
  }

  export async function upgrade(method: Method, target: string) {
    if (method === "desktop") {
      await stageDesktopUpdate(target)
      log.info("desktop update staged", { target })
      return
    }
    const allowed = [
      "PATH",
      "HOME",
      "USERPROFILE",
      "TMPDIR",
      "TMP",
      "TEMP",
      "SystemRoot",
      "COMSPEC",
      "PATHEXT",
      "APPDATA",
      "LOCALAPPDATA",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "NO_PROXY",
      "https_proxy",
      "http_proxy",
      "no_proxy",
    ]
    const env = Object.fromEntries(allowed.flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])))
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-upgrade-"))
    try {
      let cmd
      switch (method) {
        case "curl": {
          // openscience.sh/install serves the repo install script. The app
          // subdomain serves the dashboard SPA, so piping it into bash fails.
          // Override via OPENSCIENCE_INSTALL_URL if hosting the script elsewhere.
          const url = process.env.OPENSCIENCE_INSTALL_URL || "https://openscience.sh/install"
          const script = await downloadInstaller(url, cwd, env)
          cmd = $`bash ${script}`
          break
        }
        case "npm":
          cmd = $`npm install -g @synsci/openscience@${target}`
          break
        case "pnpm":
          cmd = $`pnpm install -g @synsci/openscience@${target}`
          break
        case "yarn":
          cmd = $`yarn global add @synsci/openscience@${target}`
          break
        case "bun":
          cmd = $`bun install -g @synsci/openscience@${target}`
          break
        case "brew": {
          const formula = await getBrewFormula()
          cmd = $`brew upgrade ${formula}`
          break
        }
        case "choco":
          cmd = $`echo Y | choco upgrade openscience --version=${target}`
          break
        case "scoop":
          cmd = $`scoop install openscience@${target}`
          break
        default:
          throw new Error(`Unknown method: ${method}`)
      }
      const commandEnv =
        method === "curl"
          ? { ...env, VERSION: target }
          : method === "brew"
            ? { ...env, HOMEBREW_NO_AUTO_UPDATE: "1" }
            : env
      const result = await cmd.cwd(cwd).env(commandEnv).quiet().throws(false)
      if (result.exitCode !== 0) {
        const stderr =
          method === "choco" ? "not running from an elevated command shell" : result.stderr.toString("utf8")
        throw new UpgradeFailedError({
          stderr: stderr,
        })
      }
      log.info("upgraded", {
        method,
        target,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      })
      await verifyUpgrade(method, target, cwd, env)
    } finally {
      await fs.rm(cwd, { recursive: true, force: true })
    }
  }

  export const VERSION = typeof OPENSCIENCE_VERSION === "string" ? OPENSCIENCE_VERSION : "local"
  export const CHANNEL = typeof OPENSCIENCE_CHANNEL === "string" ? OPENSCIENCE_CHANNEL : "local"
  export const ARTIFACT_SOURCE =
    typeof OPENSCIENCE_ARTIFACT_SOURCE === "string" && /^[a-f0-9]{40}$/.test(OPENSCIENCE_ARTIFACT_SOURCE)
      ? OPENSCIENCE_ARTIFACT_SOURCE
      : undefined
  export const USER_AGENT = `openscience/${CHANNEL}/${VERSION}/${Flag.OPENSCIENCE_CLIENT}`
  export const PLATFORM_PACKAGE =
    typeof OPENSCIENCE_PLATFORM_PACKAGE === "string"
      ? OPENSCIENCE_PLATFORM_PACKAGE
      : `@synsci/openscience-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}${
          process.platform === "linux" && typeof OPENSCIENCE_LIBC === "string" && OPENSCIENCE_LIBC === "musl"
            ? "-musl"
            : ""
        }`

  /** OData query for the latest published version of a Chocolatey package.
   *  The id must match what the CLI actually publishes to Chocolatey
   *  (`openscience`) — everywhere else in this file already uses it (`choco
   *  list --limit-output openscience`, `choco upgrade openscience`). A leftover
   *  pre-rename `synsc` id here queried a non-existent package, so choco users
   *  could never resolve an upgrade target (`data.d.results[0]` was undefined). */
  export function chocoLatestVersionUrl(pkg: string = "openscience"): string {
    const filter = encodeURIComponent(`Id eq '${pkg}' and IsLatestVersion`)
    return `https://community.chocolatey.org/api/v2/Packages?$filter=${filter}&$select=Version`
  }

  export function npmReleaseChannel(channel: string = CHANNEL) {
    const knownTags = new Set(["latest", "ci", "dev", "beta", "test"])
    return knownTags.has(channel) ? channel : "latest"
  }

  function githubLatest() {
    return releaseFetch("https://api.github.com/repos/synthetic-sciences/OpenScience/releases/latest")
      .then((res) => {
        if (!res.ok) throw new Error(res.statusText)
        return res.json()
      })
      .then((data: any) => data.tag_name.replace(/^v/, ""))
  }

  export async function latest(installMethod?: Method) {
    const detectedMethod = installMethod || (await method())

    // formulae.brew.sh only indexes homebrew-core (404 for this formula); the
    // tap formula is generated from the GitHub release, so that is its source.
    if (detectedMethod === "brew") return githubLatest()

    if (
      detectedMethod === "npm" ||
      detectedMethod === "bun" ||
      detectedMethod === "pnpm" ||
      detectedMethod === "unknown"
    ) {
      const channel = npmReleaseChannel()
      return releaseFetch(`https://registry.npmjs.org/@synsci/openscience/${channel}`)
        .then((res) => {
          if (!res.ok) throw new Error(res.statusText)
          return res.json()
        })
        .then((data: any) => data.version)
    }

    if (detectedMethod === "choco") {
      return releaseFetch(chocoLatestVersionUrl(), { headers: { Accept: "application/json;odata=verbose" } })
        .then((res) => {
          if (!res.ok) throw new Error(res.statusText)
          return res.json()
        })
        .then((data: any) => data.d.results[0].Version)
    }

    if (detectedMethod === "scoop") {
      return releaseFetch("https://raw.githubusercontent.com/ScoopInstaller/Main/master/bucket/openscience.json", {
        headers: { Accept: "application/json" },
      })
        .then((res) => {
          if (!res.ok) throw new Error(res.statusText)
          return res.json()
        })
        .then((data: any) => data.version)
    }

    return githubLatest()
  }
}
