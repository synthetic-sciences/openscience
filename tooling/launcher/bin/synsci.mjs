#!/usr/bin/env node

// `npx synsci`: the OpenScience installer and launcher.
//
// The npm package (and this bin) keep the historical `synsci` name so the
// one-liner everyone knows keeps working; everything it installs is the
// OpenScience CLI (`@synsci/openscience`, binary `openscience`).

// Hard guard against recursive invocation. If a check ever resolves to the
// launcher itself, this prevents an infinite spawn chain that exhausts memory.
if (process.env.__SYNSCI_LAUNCHER_PID) {
  process.stderr.write(
    `synsci: launcher invoked recursively (parent pid ${process.env.__SYNSCI_LAUNCHER_PID}). Exiting.\n`,
  )
  process.exit(2)
}
process.env.__SYNSCI_LAUNCHER_PID = String(process.pid)

import { execFileSync, execSync, spawn } from "node:child_process"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { npmDistTag, opensciencePackageSpec } from "../lib/channel.mjs"

const SELF_PATH = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return ""
  }
})()
const LAUNCHER_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version || "0.0.0"
  } catch {
    return "0.0.0"
  }
})()
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(LAUNCHER_VERSION)
  process.exit(0)
}
const OPENSCIENCE_NPM_TAG = npmDistTag(LAUNCHER_VERSION)
const OPENSCIENCE_NPM_SPEC = opensciencePackageSpec(LAUNCHER_VERSION)

const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const CYAN = "\x1b[36m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const RED = "\x1b[31m"
const RESET = "\x1b[0m"
const HIDE_CURSOR = "\x1b[?25l"
const SHOW_CURSOR = "\x1b[?25h"
const CLEAR_LINE = "\x1b[2K\r"

const LOGO = [
  "███████╗██╗   ██╗███╗   ██╗████████╗██╗  ██╗███████╗████████╗██╗ ██████╗",
  "██╔════╝╚██╗ ██╔╝████╗  ██║╚══██╔══╝██║  ██║██╔════╝╚══██╔══╝██║██╔════╝",
  "███████╗ ╚████╔╝ ██╔██╗ ██║   ██║   ███████║█████╗     ██║   ██║██║     ",
  "╚════██║  ╚██╔╝  ██║╚██╗██║   ██║   ██╔══██║██╔══╝     ██║   ██║██║     ",
  "███████║   ██║   ██║ ╚████║   ██║   ██║  ██║███████╗   ██║   ██║╚██████╗",
  "╚══════╝   ╚═╝   ╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝╚══════╝   ╚═╝   ╚═╝ ╚═════╝",
  "███████╗ ██████╗██╗███████╗███╗   ██╗ ██████╗███████╗███████╗",
  "██╔════╝██╔════╝██║██╔════╝████╗  ██║██╔════╝██╔════╝██╔════╝",
  "███████╗██║     ██║█████╗  ██╔██╗ ██║██║     █████╗  ███████╗",
  "╚════██║██║     ██║██╔══╝  ██║╚██╗██║██║     ██╔══╝  ╚════██║",
  "███████║╚██████╗██║███████╗██║ ╚████║╚██████╗███████╗███████║",
  "╚══════╝ ╚═════╝╚═╝╚══════╝╚═╝  ╚═══╝ ╚═════╝╚══════╝╚══════╝",
]

function ok(msg) {
  console.log(`  ${GREEN}✓${RESET} ${msg}`)
}
function warn(msg) {
  console.log(`  ${YELLOW}⚠${RESET} ${msg}`)
}

function spinner(msg) {
  const frames = ["◒", "◐", "◓", "◑"]
  let i = 0
  process.stdout.write(HIDE_CURSOR)
  const id = setInterval(() => {
    process.stdout.write(`${CLEAR_LINE}  ${CYAN}${frames[i++ % frames.length]}${RESET} ${msg}`)
  }, 80)
  return {
    ok(result) {
      clearInterval(id)
      process.stdout.write(`${CLEAR_LINE}${SHOW_CURSOR}`)
      ok(result)
    },
    warn(result) {
      clearInterval(id)
      process.stdout.write(`${CLEAR_LINE}${SHOW_CURSOR}`)
      warn(result)
    },
    fail(result) {
      clearInterval(id)
      process.stdout.write(`${CLEAR_LINE}${SHOW_CURSOR}`)
      console.log(`  ${RED}✗${RESET} ${result}`)
    },
    update(m) {
      msg = m
    },
  }
}

function runQuiet(cmd) {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim()
  } catch {
    return null
  }
}

// Windows global installs expose a .cmd shim, which can't be exec'd
// directly — it needs a shell (and the path quoted for it).
const isCmdShim = (p) => process.platform === "win32" && p.toLowerCase().endsWith(".cmd")

function execCli(file, args = [], opts = {}) {
  if (isCmdShim(file)) return execSync(['"' + file + '"', ...args].join(" "), opts)
  return execFileSync(file, args, opts)
}

function runFileQuiet(file, args = []) {
  try {
    return execCli(file, args, { encoding: "utf-8", stdio: "pipe" }).trim()
  } catch {
    return null
  }
}

function isLauncherPath(p) {
  try {
    const real = realpathSync(p)
    if (SELF_PATH && real === SELF_PATH) return true
    if (real.includes("/_npx/")) return true
    return false
  } catch {
    return false
  }
}

// Returns the absolute path to the real @synsci/openscience binary (`openscience`).
// Only trusts canonical install locations (no `$PATH` walk) to avoid picking
// up dev shims or workspace symlinks. Each candidate is verified by invoking
// `--version` so half-broken installs are skipped instead of accepted.
function resolveCli() {
  const candidates = []
  // 1. Global npm prefix (where `npm i -g @synsci/openscience` puts it).
  // On Windows the global bin dir is the prefix itself and the entry is an
  // openscience.cmd shim; on POSIX it's <prefix>/bin/openscience.
  const prefix = runQuiet("npm prefix -g")
  if (prefix) {
    if (process.platform === "win32") candidates.push(join(prefix, "openscience.cmd"))
    else candidates.push(join(prefix, "bin", "openscience"))
  }
  // 2. ~/.openscience/bin/openscience (curl-installer location, POSIX only)
  if (process.platform !== "win32") candidates.push(join(homedir(), ".openscience", "bin", "openscience"))

  for (const cand of candidates) {
    if (!existsSync(cand) || isLauncherPath(cand)) continue
    try {
      const ver = execCli(cand, ["--version"], {
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 5000,
      }).trim()
      if (/^\d/.test(ver)) return cand
    } catch {
      /* unrunnable candidate, try next */
    }
  }
  return null
}

// The deprecated `@synsci/cli` package links the same `openscience` bin. npm
// refuses to overwrite a bin file owned by another package (EEXIST), so a
// stale global install dead-ends the upgrade — and its old binary shadows the
// real one on PATH. `npm ls` exits nonzero when the package is absent but
// still prints JSON, so read stdout either way.
function hasDeprecatedCli() {
  let out = ""
  try {
    out = execSync("npm ls -g @synsci/cli --depth=0 --json", { encoding: "utf-8", stdio: "pipe" })
  } catch (e) {
    out = e && typeof e.stdout === "string" ? e.stdout : ""
  }
  try {
    return Boolean(JSON.parse(out).dependencies["@synsci/cli"])
  } catch {
    return false
  }
}

function isConnected() {
  const explicit = process.env.OPENSCIENCE_DATA_DIR?.trim()
  const xdgData = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  const pointerPath = join(xdgConfig, "openscience", "data-location")
  const pointer = (() => {
    try {
      return readFileSync(pointerPath, "utf-8").trim()
    } catch {
      return ""
    }
  })()
  const roots = explicit
    ? [resolve(explicit)]
    : pointer
      ? [resolve(pointer)]
      : [join(homedir(), ".openscience"), join(xdgData, "openscience")]
  const sessionPath = roots.map((root) => join(root, "openscience-session.json")).find(existsSync)
  if (!sessionPath) return false
  try {
    const data = JSON.parse(readFileSync(sessionPath, "utf-8"))
    return typeof data.api_key === "string" && /^thk_[^.]+\.[A-Za-z0-9_-]+$/.test(data.api_key)
  } catch {
    return false
  }
}
async function main() {
  process.on("exit", () => process.stdout.write(SHOW_CURSOR))
  process.on("SIGINT", () => {
    process.stdout.write(SHOW_CURSOR)
    process.exit(130)
  })

  // --- Logo ---
  console.log()
  for (const line of LOGO) console.log(`   ${CYAN}${line}${RESET}`)
  console.log()
  console.log(`   ${BOLD}Synthetic Sciences${RESET} ${DIM}OpenScience, the open-source AI research workspace${RESET}`)
  console.log()

  // --- Step 1: Install or upgrade the OpenScience CLI ---
  if (hasDeprecatedCli()) {
    const s = spinner("Removing the deprecated @synsci/cli so it can't shadow the openscience command...")
    if (runQuiet("npm rm -g @synsci/cli") !== null) {
      s.ok("Removed the deprecated @synsci/cli")
    } else {
      s.warn(`Couldn't remove the deprecated @synsci/cli — if install fails, run: ${CYAN}npm rm -g @synsci/cli${RESET}`)
    }
  }

  let cliPath = resolveCli()
  if (cliPath) {
    const raw = runFileQuiet(cliPath, ["--version"]) || "unknown"
    const isDev = raw === "local" || raw.includes("-")
    if (isDev) {
      ok(`openscience ${DIM}(dev build)${RESET}`)
    } else {
      const s = spinner("Checking for updates...")
      const current = raw.replace(/[^0-9.]/g, "")
      const latest = runQuiet(`npm view @synsci/openscience@${OPENSCIENCE_NPM_TAG} version`)
      if (!latest || current === latest) {
        s.ok(`openscience ${current} ${DIM}(up to date)${RESET}`)
      } else {
        s.update(`Upgrading ${current} → ${latest}...`)
        try {
          execCli(cliPath, ["upgrade", latest], { stdio: "pipe" })
          s.ok(`Upgraded to ${latest}`)
        } catch {
          s.warn(`Upgrade failed, continuing with ${current}`)
        }
      }
    }
  } else {
    const s = spinner("Installing OpenScience...")
    try {
      try {
        execSync(`npm i -g ${OPENSCIENCE_NPM_SPEC}`, { stdio: "pipe" })
      } catch (e) {
        // npm refuses to overwrite a bin file owned by another package
        // (EEXIST). If the conflict is the deprecated @synsci/cli, remove it
        // and retry once before falling back to the standalone installer.
        const stderr = e && e.stderr ? String(e.stderr) : ""
        const conflict = stderr.includes("EEXIST") && (stderr.includes("@synsci/cli") || hasDeprecatedCli())
        if (!conflict) throw e
        s.update("Removing the deprecated @synsci/cli so it can't shadow the openscience command...")
        runQuiet("npm rm -g @synsci/cli")
        s.update("Retrying the OpenScience install...")
        execSync(`npm i -g ${OPENSCIENCE_NPM_SPEC}`, { stdio: "pipe" })
      }
      cliPath = resolveCli()
      if (!cliPath) throw new Error("openscience not on PATH after install")
      s.ok("Installed OpenScience")
    } catch {
      // The standalone installer is a bash script; on native Windows there's
      // no bash to pipe it into, so don't suggest a fallback that can't run.
      if (process.platform === "win32") {
        s.fail("Install failed")
        console.log(`\n  Try manually: ${CYAN}npm i -g ${OPENSCIENCE_NPM_SPEC}${RESET}\n`)
        process.exit(1)
      }
      // Global npm installs commonly fail on permissions. Fall back to the
      // standalone installer, which lands in ~/.openscience/bin without sudo
      // (resolveCli already checks that location).
      s.update("npm -g failed, trying the standalone installer...")
      try {
        execSync("curl -fsSL https://openscience.sh/install | bash", { stdio: "pipe" })
        cliPath = resolveCli()
        if (!cliPath) throw new Error("openscience not found after install")
        s.ok("Installed OpenScience")
      } catch (e2) {
        s.fail(`Install failed${e2 && e2.message ? ": " + e2.message : ""}`)
        console.log(`\n  Try manually: ${CYAN}npm i -g ${OPENSCIENCE_NPM_SPEC}${RESET}`)
        console.log(`  or:           ${CYAN}curl -fsSL https://openscience.sh/install | bash${RESET}\n`)
        process.exit(1)
      }
    }
  }

  // --- Step 2: Connect this device ---
  if (isConnected()) {
    ok("Connected to Synthetic Sciences")
  } else {
    console.log()
    try {
      execCli(cliPath, ["login"], { stdio: "inherit" })
    } catch {
      warn("Synthetic Sciences sign-in did not finish")
      process.exit(1)
    }
    if (!isConnected()) {
      warn("A Synthetic Sciences account is required before the workspace can open")
      process.exit(1)
    }
    ok("Connected to Synthetic Sciences")
  }
  console.log()

  // --- Step 3: Launch the workspace ---
  console.log(`  ${DIM}Opening the workspace in your browser…${RESET}`)
  console.log()

  const webArgs = ["web", ...process.argv.slice(2)]
  const child = isCmdShim(cliPath)
    ? spawn(['"' + cliPath + '"', ...webArgs].join(" "), { stdio: "inherit", shell: true })
    : spawn(cliPath, webArgs, { stdio: "inherit" })
  child.on("close", (code) => process.exit(code ?? 0))
}

main().catch((err) => {
  process.stdout.write(SHOW_CURSOR)
  console.error(err)
  process.exit(1)
})
