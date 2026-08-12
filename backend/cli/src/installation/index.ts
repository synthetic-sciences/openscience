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
    return methodFromPaths({ execPath: process.execPath, scriptPath: process.argv[1] })
  }

  export const UpgradeFailedError = NamedError.create(
    "UpgradeFailedError",
    z.object({
      stderr: z.string(),
    }),
  )

  async function getBrewFormula() {
    const tapFormula = await $`brew list --formula openscience/tap/openscience`.throws(false).quiet().text()
    if (tapFormula.includes("openscience")) return "openscience/tap/openscience"
    const coreFormula = await $`brew list --formula openscience`.throws(false).quiet().text()
    if (coreFormula.includes("openscience")) return "openscience"
    return "openscience"
  }

  export async function upgrade(method: Method, target: string) {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-upgrade-"))
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
    let cmd
    switch (method) {
      case "curl":
        // openscience.sh/install serves the repo install script. The app
        // subdomain serves the dashboard SPA, so piping it into bash fails.
        // Override via OPENSCIENCE_INSTALL_URL if hosting the script elsewhere.
        cmd = $`curl -fsSL ${process.env.OPENSCIENCE_INSTALL_URL || "https://openscience.sh/install"} | bash`
        break
      case "npm":
        cmd = $`npm install -g @synsci/openscience@${target}`
        break
      case "pnpm":
        cmd = $`pnpm install -g @synsci/openscience@${target}`
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
    try {
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
      await $`${process.execPath} --version`.cwd(cwd).env(env).nothrow().quiet().text()
    } finally {
      await fs.rm(cwd, { recursive: true, force: true })
    }
  }

  export const VERSION = typeof OPENSCIENCE_VERSION === "string" ? OPENSCIENCE_VERSION : "local"
  export const CHANNEL = typeof OPENSCIENCE_CHANNEL === "string" ? OPENSCIENCE_CHANNEL : "local"
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

  export async function latest(installMethod?: Method) {
    const detectedMethod = installMethod || (await method())

    if (detectedMethod === "brew") {
      return releaseFetch("https://formulae.brew.sh/api/formula/openscience.json")
        .then((res) => {
          if (!res.ok) throw new Error(res.statusText)
          return res.json()
        })
        .then((data: any) => data.versions.stable)
    }

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

    return releaseFetch("https://api.github.com/repos/synthetic-sciences/OpenScience/releases/latest")
      .then((res) => {
        if (!res.ok) throw new Error(res.statusText)
        return res.json()
      })
      .then((data: any) => data.tag_name.replace(/^v/, ""))
  }
}
