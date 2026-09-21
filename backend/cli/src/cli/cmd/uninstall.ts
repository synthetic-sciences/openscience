import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Installation } from "../../installation"
import { CliShim } from "../../installation/cli-shim"
import { Global } from "../../global"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { cmd } from "./cmd"

interface UninstallArgs {
  keepConfig?: boolean
  keepData?: boolean
  purge: boolean
  dryRun: boolean
  force: boolean
}

interface RemovalTargets {
  directories: Array<{ path: string; label: string; keep: boolean }>
  shellConfig: string | null
  binary: string | null
  link: string | null
}

export const UninstallCommand = cmd({
  command: "uninstall",
  describe: "uninstall openscience while keeping your work and settings by default",
  builder: (yargs: Argv) =>
    yargs
      .option("keep-config", {
        alias: "c",
        type: "boolean",
        describe: "keep configuration files when using --purge (kept by default)",
      })
      .option("keep-data", {
        alias: "d",
        type: "boolean",
        describe: "keep sessions, artifacts, credentials, and snapshots when using --purge (kept by default)",
      })
      .option("purge", {
        type: "boolean",
        describe: "also permanently delete OpenScience configuration and user data",
        default: false,
      })
      .option("dry-run", {
        type: "boolean",
        describe: "show what would be removed without removing",
        default: false,
      })
      .option("force", {
        alias: "f",
        type: "boolean",
        describe: "skip confirmation prompts",
        default: false,
      }),

  handler: async (args: UninstallArgs) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Uninstall OpenScience")

    const method = await Installation.method()
    prompts.log.info(`Installation method: ${method}`)

    const targets = await collectRemovalTargets(args, method)

    await showRemovalSummary(targets, method)

    if (!args.force && !args.dryRun) {
      const confirm = await prompts.confirm({
        message: "Are you sure you want to uninstall?",
        initialValue: false,
      })
      if (!confirm || prompts.isCancel(confirm)) {
        prompts.outro("Cancelled")
        return
      }
    }

    if (args.dryRun) {
      prompts.log.warn("Dry run - no changes made")
      prompts.outro("Done")
      return
    }

    await executeUninstall(method, targets)

    prompts.outro(packageStep(method)?.outro ?? "Done")
  },
})

async function collectRemovalTargets(args: UninstallArgs, method: Installation.Method): Promise<RemovalTargets> {
  const directories = uninstallDirectories(args)

  // The desktop app writes the installer's PATH line and links the sidecar
  // from ~/.openscience/bin; both go the way the curl install's do.
  const shellConfig = method === "curl" || method === "desktop" ? await getShellConfigFile() : null
  const binary = method === "curl" ? process.execPath : null
  const link =
    method === "desktop"
      ? await CliShim.status().then(
          (status) => (status.exists && status.ours && status.target ? status.path : null),
          () => null,
        )
      : null

  return { directories, shellConfig, binary, link }
}

export function uninstallDirectories(args: Pick<UninstallArgs, "keepConfig" | "keepData" | "purge">) {
  return [
    { path: Global.Path.data, label: "Data", keep: !args.purge || args.keepData === true },
    { path: Global.Path.cache, label: "Cache", keep: false },
    { path: Global.Path.config, label: "Config", keep: !args.purge || args.keepConfig === true },
    { path: Global.Path.state, label: "State", keep: false },
  ]
}

async function showRemovalSummary(targets: RemovalTargets, method: Installation.Method) {
  prompts.log.message("The following will be removed:")
  if (targets.directories.some((dir) => dir.keep)) {
    prompts.log.info("  Your configuration and user data will be kept. Use --purge to delete them.")
  }

  for (const dir of targets.directories) {
    const exists = await fs
      .access(dir.path)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue

    const size = await getDirectorySize(dir.path)
    const sizeStr = formatSize(size)
    const status = dir.keep ? UI.Style.TEXT_DIM + "(keeping)" : ""
    const prefix = dir.keep ? "○" : "✓"

    prompts.log.info(`  ${prefix} ${dir.label}: ${shortenPath(dir.path)} ${UI.Style.TEXT_DIM}(${sizeStr})${status}`)
  }

  if (targets.binary) {
    prompts.log.info(`  ✓ Binary: ${shortenPath(targets.binary)}`)
  }

  if (targets.link) {
    prompts.log.info(`  ✓ Command-line link: ${shortenPath(targets.link)}`)
  }

  if (targets.shellConfig) {
    prompts.log.info(`  ✓ Shell PATH in ${shortenPath(targets.shellConfig)}`)
  }

  const step = packageStep(method)
  if (step) prompts.log.info(`  ${step.summary}`)
}

const PACKAGE_COMMANDS: Partial<Record<Installation.Method, string[]>> = {
  npm: ["npm", "uninstall", "-g", "@synsci/openscience"],
  pnpm: ["pnpm", "uninstall", "-g", "@synsci/openscience"],
  bun: ["bun", "remove", "-g", "@synsci/openscience"],
  yarn: ["yarn", "global", "remove", "@synsci/openscience"],
  choco: ["choco", "uninstall", "openscience"],
  scoop: ["scoop", "uninstall", "openscience"],
}

/**
 * What uninstalling does about the program itself: the package manager command
 * it runs, or, for the desktop app, nothing. A desktop copy is the app's own
 * sidecar and cannot remove the bundle it is running from, so the summary and
 * the outro say the app stays and how the person removes it. A curl or
 * unrecognised install has no step here; its binary has a line of its own.
 */
export function packageStep(
  method: Installation.Method,
  platform: NodeJS.Platform = process.platform,
): { summary: string; command?: string[]; outro?: string } | undefined {
  if (method === "desktop") {
    const app = platform === "darwin" ? "OpenScience.app" : "OpenScience"
    const how =
      platform === "darwin"
        ? "move it to the Trash"
        : platform === "win32"
          ? 'remove it from "Add or remove programs" in Windows Settings'
          : "delete the AppImage (or remove its package)"
    return {
      summary: `○ App: ${app} is left in place — ${how} to finish uninstalling`,
      outro: `Done. ${app} is still installed: ${how} to finish uninstalling.`,
    }
  }
  const command = PACKAGE_COMMANDS[method]
  if (!command) return
  return { summary: `✓ Package: ${command.join(" ")}`, command }
}

async function executeUninstall(method: Installation.Method, targets: RemovalTargets) {
  const spinner = prompts.spinner()
  const errors: string[] = []

  for (const dir of targets.directories) {
    if (dir.keep) {
      prompts.log.step(`Skipping ${dir.label} (--keep-${dir.label.toLowerCase()})`)
      continue
    }

    const exists = await fs
      .access(dir.path)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue

    spinner.start(`Removing ${dir.label}...`)
    const err = await fs.rm(dir.path, { recursive: true, force: true }).catch((e) => e)
    if (err) {
      spinner.stop(`Failed to remove ${dir.label}`, 1)
      errors.push(`${dir.label}: ${err.message}`)
      continue
    }
    spinner.stop(`Removed ${dir.label}`)
  }

  if (targets.shellConfig) {
    spinner.start("Cleaning shell config...")
    const err = await cleanShellConfig(targets.shellConfig).catch((e) => e)
    if (err) {
      spinner.stop("Failed to clean shell config", 1)
      errors.push(`Shell config: ${err.message}`)
    } else {
      spinner.stop("Cleaned shell config")
    }
  }

  if (targets.link) {
    spinner.start("Removing the command-line link...")
    const err = await CliShim.remove().catch((e) => e)
    if (err instanceof Error) {
      spinner.stop("Failed to remove the command-line link", 1)
      errors.push(`Command-line link: ${err.message}`)
    } else {
      spinner.stop("Removed the command-line link")
    }
  }

  const cmd = packageStep(method)?.command
  if (cmd) {
    spinner.start(`Running ${cmd.join(" ")}...`)
    const result =
      method === "choco"
        ? await $`echo Y | choco uninstall openscience -y -r`.quiet().nothrow()
        : await $`${cmd}`.quiet().nothrow()
    if (result.exitCode !== 0) {
      spinner.stop(`Package manager uninstall failed: exit code ${result.exitCode}`, 1)
      if (method === "choco" && result.stdout.toString("utf8").includes("not running from an elevated command shell")) {
        prompts.log.warn(`You may need to run '${cmd.join(" ")}' from an elevated command shell`)
      } else {
        prompts.log.warn(`You may need to run manually: ${cmd.join(" ")}`)
      }
    } else {
      spinner.stop("Package removed")
    }
  }

  if (method === "curl" && targets.binary) {
    UI.empty()
    prompts.log.message("To finish removing the binary, run:")
    prompts.log.info(`  rm "${targets.binary}"`)

    const binDir = path.dirname(targets.binary)
    if (binDir.includes(".openscience")) {
      prompts.log.info(`  rmdir "${binDir}" 2>/dev/null`)
    }
  }

  if (errors.length > 0) {
    UI.empty()
    prompts.log.warn("Some operations failed:")
    for (const err of errors) {
      prompts.log.error(`  ${err}`)
    }
  }

  UI.empty()
  prompts.log.success("Thank you for using OpenScience!")
}

/**
 * The startup file that holds the PATH line. The lists have to cover every
 * file the standalone installer and the desktop app write to, or uninstalling
 * leaves the line behind: both follow ZDOTDIR for zsh, and both spell fish's
 * file from the home directory whatever XDG_CONFIG_HOME says.
 */
export async function getShellConfigFile(
  input: { env?: NodeJS.ProcessEnv; home?: string } = {},
): Promise<string | null> {
  const env = input.env ?? process.env
  // The home the command-line link resolves from, so a sandboxed home never
  // has the real startup files cleaned on its behalf.
  const home = input.home ?? Global.Path.home
  const shell = path.basename(env.SHELL || "bash")
  const xdgConfig = env.XDG_CONFIG_HOME || path.join(home, ".config")
  const zdot = env.ZDOTDIR || home

  const configFiles: Record<string, string[]> = {
    fish: [path.join(xdgConfig, "fish", "config.fish"), path.join(home, ".config", "fish", "config.fish")],
    zsh: [
      path.join(zdot, ".zshrc"),
      path.join(zdot, ".zshenv"),
      path.join(home, ".zshrc"),
      path.join(home, ".zshenv"),
      path.join(xdgConfig, "zsh", ".zshrc"),
      path.join(xdgConfig, "zsh", ".zshenv"),
    ],
    bash: [
      path.join(home, ".bashrc"),
      path.join(home, ".bash_profile"),
      path.join(home, ".profile"),
      path.join(xdgConfig, "bash", ".bashrc"),
      path.join(xdgConfig, "bash", ".bash_profile"),
    ],
    ash: [path.join(home, ".ashrc"), path.join(home, ".profile")],
    sh: [path.join(home, ".profile")],
  }

  const candidates = configFiles[shell] || configFiles.bash

  for (const file of candidates) {
    const exists = await fs
      .access(file)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue

    const content = await Bun.file(file)
      .text()
      .catch(() => "")
    if (content.includes("# openscience") || content.includes(".openscience/bin")) {
      return file
    }
  }

  return null
}

export async function cleanShellConfig(file: string) {
  const content = await Bun.file(file).text()
  const lines = content.split("\n")

  const filtered: string[] = []
  let skip = false

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed === "# openscience") {
      skip = true
      continue
    }

    if (skip) {
      skip = false
      if (trimmed.includes(".openscience/bin") || trimmed.includes("fish_add_path")) {
        continue
      }
    }

    if (
      (trimmed.startsWith("export PATH=") && trimmed.includes(".openscience/bin")) ||
      (trimmed.startsWith("fish_add_path") && trimmed.includes(".openscience"))
    ) {
      continue
    }

    filtered.push(line)
  }

  while (filtered.length > 0 && filtered[filtered.length - 1].trim() === "") {
    filtered.pop()
  }

  // A file that held nothing but the block stays, empty. It is the person's
  // startup file even when the desktop app created it, and not ours to delete.
  const output = filtered.length === 0 ? "" : filtered.join("\n") + "\n"
  await Bun.write(file, output)
}

async function getDirectorySize(dir: string): Promise<number> {
  let total = 0

  const walk = async (current: string) => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])

    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (entry.isFile()) {
        const stat = await fs.stat(full).catch(() => null)
        if (stat) total += stat.size
      }
    }
  }

  await walk(dir)
  return total
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function shortenPath(p: string): string {
  const home = os.homedir()
  if (p.startsWith(home)) {
    return p.replace(home, "~")
  }
  return p
}
